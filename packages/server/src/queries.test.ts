import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FlatEvent } from "@clogdy/shared";
import { makeWriter, openDb } from "@clogdy/ingest";
import { expandSession, maxEventId, queryEvents, queryFacets } from "./queries";

let dir: string;
let db: Database;

function ev(over: Partial<FlatEvent>): FlatEvent {
  return {
    uuid: "u",
    blockIdx: 0,
    parentUuid: null,
    sessionId: "sess-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    project: "alpha",
    cwd: "/home/x/alpha",
    ts: 1000,
    kind: "text",
    tool: null,
    command: null,
    corr: null,
    isError: null,
    inputJson: null,
    result: null,
    stderr: null,
    diff: null,
    resultHead: null,
    text: null,
    durMs: null,
    gitBranch: null,
    raw: "{}",
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clogdy-q-"));
  db = openDb(join(dir, "q.db"));
  const w = makeWriter(db);
  // 5 events:
  //  proj alpha: Bash tool_use, Bash tool_result (error), text
  //  proj beta:  WebFetch tool_use, WebFetch tool_result (ok)
  w.add([
    ev({ uuid: "a", blockIdx: 0, kind: "tool_use", tool: "Bash", command: "ls", corr: "t1" }),
    ev({ uuid: "a", blockIdx: 1, kind: "tool_result", tool: null, isError: true, result: "err", corr: "t1" }),
    ev({ uuid: "b", blockIdx: 0, kind: "text", text: "hello" }),
    ev({
      uuid: "c",
      blockIdx: 0,
      kind: "tool_use",
      tool: "WebFetch",
      command: "http://x",
      corr: "t2",
      project: "beta",
      sessionId: "sess-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      cwd: "/home/x/beta",
    }),
    ev({
      uuid: "c",
      blockIdx: 1,
      kind: "tool_result",
      isError: false,
      result: "ok",
      corr: "t2",
      project: "beta",
      sessionId: "sess-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      cwd: "/home/x/beta",
    }),
  ]);
  w.flush();
  w.upsertSession({ sessionId: "sess-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", project: "alpha", cwd: "/home/x/alpha", path: "/p/a.jsonl", ts: 1000, gitBranch: null });
  w.upsertSession({ sessionId: "sess-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", project: "beta", cwd: "/home/x/beta", path: "/p/b.jsonl", ts: 1000, gitBranch: null });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("queryEvents filters by project", () => {
  const { rows } = queryEvents(db, { project: "beta" });
  expect(rows.length).toBe(2);
  expect(rows.every((r) => r.project === "beta")).toBe(true);
});

test("queryEvents filters by tool and kind", () => {
  expect(queryEvents(db, { tool: "Bash" }).rows.length).toBe(1);
  expect(queryEvents(db, { kind: "text" }).rows.length).toBe(1);
});

test("queryEvents filters by error", () => {
  const errRows = queryEvents(db, { error: "error" }).rows;
  expect(errRows.length).toBe(1);
  expect(errRows[0]!.isError).toBe(true);
  const okRows = queryEvents(db, { error: "ok" }).rows;
  expect(okRows.length).toBe(1);
  expect(okRows[0]!.isError).toBe(false);
});

test("queryEvents paginates by afterId / nextAfterId", () => {
  const all = queryEvents(db, {}).rows;
  expect(all.length).toBe(5);
  // walk with limit=1
  const collected: number[] = [];
  let afterId: number | undefined = undefined;
  for (let i = 0; i < 10; i++) {
    const page: { rows: typeof all; nextAfterId: number | null } = queryEvents(db, { limit: 1, afterId });
    if (page.rows.length === 0) break;
    collected.push(page.rows[0]!.id);
    if (page.nextAfterId === null) break;
    afterId = page.nextAfterId;
  }
  expect(collected).toEqual(all.map((r) => r.id));
});

test("queryFacets counts are exact and dimension is NOT narrowed by its own filter", () => {
  // No filter: tool buckets = Bash(1), WebFetch(1); kind buckets; error buckets ok(1),error(1)
  const base = queryFacets(db, {});
  expect(base.tool).toEqual(
    expect.arrayContaining([
      { value: "Bash", count: 1 },
      { value: "WebFetch", count: 1 },
    ]),
  );
  expect(base.error).toEqual(
    expect.arrayContaining([
      { value: "error", count: 1 },
      { value: "ok", count: 1 },
    ]),
  );
  // project buckets: alpha(3), beta(2)
  const pa = Object.fromEntries(base.project.map((b) => [b.value, b.count]));
  expect(pa).toEqual({ alpha: 3, beta: 2 });

  // With tool=Bash active: the `tool` dimension should NOT be narrowed by its own filter
  // (still shows Bash AND WebFetch), but `project`/`kind` ARE narrowed to Bash rows.
  const f = queryFacets(db, { tool: "Bash" });
  const toolNames = f.tool.map((b) => b.value).sort();
  expect(toolNames).toEqual(["Bash", "WebFetch"]); // own dimension unfiltered
  // project narrowed: only alpha has the Bash tool_use
  expect(f.project).toEqual([{ value: "alpha", count: 1 }]);
});

test("queryFacets: filtering by project narrows tool but not project", () => {
  const f = queryFacets(db, { project: "alpha" });
  // project dimension unfiltered: alpha(3), beta(2)
  const pa = Object.fromEntries(f.project.map((b) => [b.value, b.count]));
  expect(pa).toEqual({ alpha: 3, beta: 2 });
  // tool dimension narrowed to alpha: only Bash
  expect(f.tool).toEqual([{ value: "Bash", count: 1 }]);
});

test("expandSession resolves an 8-char prefix, null on ambiguity / no match", () => {
  expect(expandSession(db, "sess-aaa")).toBe("sess-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  // "sess-" prefixes both → ambiguous → null
  expect(expandSession(db, "sess-")).toBe(null);
  // no match
  expect(expandSession(db, "zzzzzzzz")).toBe(null);
  // full id present
  expect(expandSession(db, "sess-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toBe("sess-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
});

test("maxEventId returns the largest id", () => {
  expect(maxEventId(db)).toBe(5);
});
