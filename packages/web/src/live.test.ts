import { describe, expect, it } from "bun:test";
import { computeTiles, mergeAppend } from "./live";
import type { EventRow } from "@clogdy/shared";

// ---------------------------------------------------------------------------
// mergeAppend
// ---------------------------------------------------------------------------

function makeRow(id: number): EventRow {
  // Minimal EventRow: only id and the required non-nullable fields matter here.
  return {
    id,
    uuid: `uuid-${id}`,
    blockIdx: 0,
    parentUuid: null,
    sessionId: "sess",
    project: "proj",
    cwd: null,
    ts: id * 1000,
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
  };
}

describe("mergeAppend", () => {
  it("appends new rows in order", () => {
    const existing = [makeRow(1), makeRow(2)];
    const incoming = [makeRow(3), makeRow(4)];
    const merged = mergeAppend(existing, incoming);
    expect(merged.map((r) => r.id)).toEqual([1, 2, 3, 4]);
  });

  it("de-duplicates by id", () => {
    const existing = [makeRow(1), makeRow(2)];
    const incoming = [makeRow(2), makeRow(3)]; // 2 is a dupe
    const merged = mergeAppend(existing, incoming);
    expect(merged.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it("returns existing unchanged when incoming is empty", () => {
    const existing = [makeRow(1)];
    const merged = mergeAppend(existing, []);
    expect(merged).toBe(existing); // same reference
  });

  it("returns existing unchanged when all incoming are dupes", () => {
    const existing = [makeRow(1), makeRow(2)];
    const merged = mergeAppend(existing, [makeRow(1), makeRow(2)]);
    expect(merged).toBe(existing); // same reference
  });
});

// ---------------------------------------------------------------------------
// computeTiles
// ---------------------------------------------------------------------------

describe("computeTiles", () => {
  it("computes total from kind buckets", () => {
    const kind = [
      { value: "text", count: 10 },
      { value: "tool_use", count: 5 },
      { value: "tool_result", count: 5 },
    ];
    const [total] = computeTiles(kind, [], [], 0);
    expect(total).toBe("20");
  });

  it("computes error rate as percentage", () => {
    const error = [
      { value: "error", count: 1 },
      { value: "ok", count: 3 },
    ];
    const [, , rate] = computeTiles([], error, [], 0);
    expect(rate).toBe("25%");
  });

  it("returns — for error rate when denominator is 0", () => {
    const [, , rate] = computeTiles([], [], [], 0);
    expect(rate).toBe("—");
  });

  it("returns top tool as first tool bucket", () => {
    const tools = [
      { value: "Bash", count: 50 },
      { value: "Read", count: 20 },
    ];
    const [, , , top] = computeTiles([], [], tools, 0);
    expect(top).toBe("Bash");
  });

  it("returns — for top tool when no tool buckets", () => {
    const [, , , top] = computeTiles([], [], [], 0);
    expect(top).toBe("—");
  });

  it("reflects windowCount in last5min tile", () => {
    const [, last5] = computeTiles([], [], [], 42);
    expect(last5).toBe("42");
  });
});
