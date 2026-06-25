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

  test("thinking text is surfaced", () => {
    expect(run({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "hmm" }] },
    }).j._text).toBe("hmm");
  });
});
