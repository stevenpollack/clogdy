import { describe, expect, test } from "bun:test";
import type { Message } from "../logdy";
import type { Flattened } from "../transcript";
import { flatten } from "./flatten";

function run(json_content: unknown, is_json = true) {
  const line = {
    id: "x",
    log_type: 1,
    content: "raw",
    is_json,
    ts: 0,
    json_content,
  } as Message;
  const ret = flatten.handler(line);
  return { ret, line, j: line.json_content as Flattened };
}

describe("flatten", () => {
  test("drops events without a message", () => {
    expect(run({ type: "file-history-snapshot" }).ret).toBeUndefined();
  });

  test("keeps conversational turns (returns the line)", () => {
    const { ret, line } = run({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
    expect(ret).toBe(line);
  });

  test("passes through non-JSON lines untouched", () => {
    const { ret, line } = run(undefined, false);
    expect(ret).toBe(line);
  });

  test("derives tool_use fields, correlation and order_key", () => {
    const { line, j } = run({
      type: "assistant",
      timestamp: "2026-06-25T01:00:00.000Z",
      message: { content: [{ type: "tool_use", id: "toolu_9", name: "Bash", input: { command: "ls" } }] },
    });
    expect(j._kind).toBe("tool_use");
    expect(j._tool).toBe("Bash");
    expect(j._command).toBe("ls");
    expect(j._corr).toBe("toolu_9");
    expect(line.correlation_id).toBe("toolu_9");
    expect(line.order_key).toBe(Date.parse("2026-06-25T01:00:00.000Z"));
  });

  test("primary command arg falls back across input keys", () => {
    const pick = (input: Record<string, unknown>, name = "X") =>
      run({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } }).j._command;
    expect(pick({ file_path: "/x" })).toBe("/x");
    expect(pick({ url: "http://x" })).toBe("http://x");
    expect(pick({ query: "q" })).toBe("q");
    // unknown-only input falls back to JSON
    expect(pick({ foo: 1 })).toBe(JSON.stringify({ foo: 1 }));
  });

  test("derives tool_result error, result text and correlation", () => {
    const { line, j } = run({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_9", content: "oops", is_error: true }] },
    });
    expect(j._kind).toBe("tool_result");
    expect(j._isError).toBe(true);
    expect(j._result).toBe("oops");
    expect(j._corr).toBe("toolu_9");
    expect(line.correlation_id).toBe("toolu_9");
  });

  test("string message content is a prompt", () => {
    const { j } = run({ type: "user", message: { content: "hello" } });
    expect(j._kind).toBe("prompt");
    expect(j._text).toBe("hello");
  });

  test("derives a unified diff from a structuredPatch (Edit/Write results)", () => {
    const { j } = run({
      type: "user",
      toolUseResult: {
        filePath: "/x.ts",
        structuredPatch: [
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [" ctx", "-old", "+new"] },
          { oldStart: 9, oldLines: 0, newStart: 9, newLines: 1, lines: ["+added"] },
        ],
      },
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "updated /x.ts" }] },
    });
    expect(j._diff).toBe(" ctx\n-old\n+new\n+added");
  });

  test("splits Bash stdout/stderr and flags interrupted", () => {
    const ok = run({
      type: "user",
      toolUseResult: { stdout: "hello", stderr: "warn!", interrupted: false },
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "hello\nwarn!" }] },
    }).j;
    expect(ok._result).toBe("hello");
    expect(ok._stderr).toBe("warn!");
    expect(ok._resultHead).toBeUndefined();

    const stopped = run({
      type: "user",
      toolUseResult: { stdout: "", stderr: "", interrupted: true },
      message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "" }] },
    }).j;
    expect(stopped._resultHead).toBe("⚠ interrupted");
  });

  test("summarizes WebFetch and WebSearch results", () => {
    const fetch = run({
      type: "user",
      toolUseResult: { url: "https://x", bytes: 61291, code: 200, durationMs: 4309 },
      message: { content: [{ type: "tool_result", tool_use_id: "t3", content: "page text" }] },
    }).j;
    expect(fetch._resultHead).toBe("200 · 59.9KB · 4.3s");

    const search = run({
      type: "user",
      toolUseResult: { query: "logdy", searchCount: 1, results: [{}, {}, {}] },
      message: { content: [{ type: "tool_result", tool_use_id: "t4", content: "results…" }] },
    }).j;
    expect(search._resultHead).toBe('3 results · "logdy"');
  });

  test("derives project (cwd basename) and session id", () => {
    const { j } = run({
      type: "user",
      cwd: "/home/steven/repos/clogdy/",
      sessionId: "630f4af6-08f1-48ec-8542-54df9e9a276c",
      message: { content: "hi" },
    });
    expect(j._project).toBe("clogdy");
    expect(j._session).toBe("630f4af6-08f1-48ec-8542-54df9e9a276c");
  });

  test("project/session are absent when cwd/sessionId are missing", () => {
    const { j } = run({ type: "user", message: { content: "hi" } });
    expect(j._project).toBeUndefined();
    expect(j._session).toBeUndefined();
  });

  test("thinking text is surfaced", () => {
    expect(run({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "hmm" }] },
    }).j._text).toBe("hmm");
  });
});
