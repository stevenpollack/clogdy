import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collapseSelection,
  matchesLine,
  projectFromCwd,
  projectFromSlug,
  scanSessions,
  type SessionMeta,
} from "./sessions";

const jsonl = (...lines: object[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

describe("projectFromCwd / projectFromSlug", () => {
  test("cwd basename, trailing slash tolerant", () => {
    expect(projectFromCwd("/home/steven/repos/clogdy")).toBe("clogdy");
    expect(projectFromCwd("/home/steven/repos/clogdy/")).toBe("clogdy");
  });
  test("de-slug takes the last segment", () => {
    expect(projectFromSlug("-home-steven-repos-clogdy")).toBe("clogdy");
  });
});

describe("matchesLine", () => {
  const line = { sessionId: "630f4af6-08f1-48ec", cwd: "/home/steven/repos/clogdy", message: {} };

  test("empty selection matches everything", () => {
    expect(matchesLine(line, {})).toBe(true);
  });
  test("session prefix match (short id ok)", () => {
    expect(matchesLine(line, { sessions: ["630f4af6"] })).toBe(true);
    expect(matchesLine(line, { sessions: ["deadbeef"] })).toBe(false);
  });
  test("project substring match", () => {
    expect(matchesLine(line, { projects: ["clog"] })).toBe(true);
    expect(matchesLine(line, { projects: ["other"] })).toBe(false);
  });
  test("both axes are ANDed", () => {
    expect(matchesLine(line, { sessions: ["630f4af6"], projects: ["clogdy"] })).toBe(true);
    expect(matchesLine(line, { sessions: ["630f4af6"], projects: ["other"] })).toBe(false);
  });
  test("missing fields fail an active filter", () => {
    expect(matchesLine({ message: {} }, { sessions: ["x"] })).toBe(false);
    expect(matchesLine({ message: {} }, { projects: ["x"] })).toBe(false);
  });
});

describe("collapseSelection", () => {
  const metas: SessionMeta[] = [
    { sessionId: "a1", project: "clogdy", path: "", lastTs: 0, sizeBytes: 0 },
    { sessionId: "a2", project: "clogdy", path: "", lastTs: 0, sizeBytes: 0 },
    { sessionId: "b1", project: "other", path: "", lastTs: 0, sizeBytes: 0 },
    { sessionId: "b2", project: "other", path: "", lastTs: 0, sizeBytes: 0 },
  ];

  test("fully-selected project collapses to its name", () => {
    const sel = collapseSelection(metas, new Set(["a1", "a2"]));
    expect(sel.projects).toEqual(["clogdy"]);
    expect(sel.sessions).toBeUndefined();
  });
  test("partially-selected project lists ids", () => {
    const sel = collapseSelection(metas, new Set(["a1"]));
    expect(sel.projects).toBeUndefined();
    expect(sel.sessions).toEqual(["a1"]);
  });
  test("mixed: one whole project collapses, one partial lists ids", () => {
    const sel = collapseSelection(metas, new Set(["a1", "a2", "b1"]));
    expect(sel.projects).toEqual(["clogdy"]); // whole
    expect(sel.sessions).toEqual(["b1"]); // 'other' partial (b2 unselected)
  });
  test("substring-colliding project names never collapse (would over-match)", () => {
    // 'app' is a substring of 'myapp', so `--projects app` would also catch myapp.
    const ms: SessionMeta[] = [
      { sessionId: "x", project: "app", path: "", lastTs: 0, sizeBytes: 0 },
      { sessionId: "y", project: "myapp", path: "", lastTs: 0, sizeBytes: 0 },
    ];
    const sel = collapseSelection(ms, new Set(["x"]));
    expect(sel.projects).toBeUndefined();
    expect(sel.sessions).toEqual(["x"]);
  });
});

describe("scanSessions", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "clogdy-scan-"));
    // Project derived from a NON-first line carrying cwd; last line is timestamp-less.
    const projDir = join(root, "-home-steven-repos-demo");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, "11111111-aaaa.jsonl"),
      jsonl(
        { type: "summary", summary: "no cwd here" },
        { type: "user", cwd: "/home/steven/repos/demo", sessionId: "11111111-aaaa", timestamp: "2026-06-20T10:00:00.000Z", message: {} },
        { type: "assistant", timestamp: "2026-06-20T10:05:00.000Z", message: {} },
        { type: "bridge-session" }, // last line, no timestamp — mtime/last-line would be wrong
      ),
    );
    // A file with no cwd anywhere → de-slug fallback to the dir's last segment.
    const slugDir = join(root, "-home-steven-repos-noproj");
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(join(slugDir, "22222222-bbbb.jsonl"), jsonl({ type: "summary" }));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("derives project, sessionId, and max-tail timestamp", async () => {
    const metas = await scanSessions(root);
    const demo = metas.find((m) => m.sessionId === "11111111-aaaa")!;
    expect(demo.project).toBe("demo");
    expect(demo.lastTs).toBe(Date.parse("2026-06-20T10:05:00.000Z")); // not the bridge line
  });
  test("falls back to de-slugged dir name when no cwd present", async () => {
    const metas = await scanSessions(root);
    const noproj = metas.find((m) => m.sessionId === "22222222-bbbb")!;
    expect(noproj.project).toBe("noproj");
    expect(noproj.lastTs).toBe(0);
  });
});
