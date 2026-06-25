import { describe, expect, test } from "bun:test";
import { resultLines, splitBashCommand } from "./render";

const BS = String.fromCharCode(92); // a literal backslash, unmangled by source escaping

describe("splitBashCommand", () => {
  test("splits on top-level semicolons", () => {
    expect(splitBashCommand("a; b; c")).toEqual(["a", "b", "c"]);
  });

  test("keeps && and | joined (single segment)", () => {
    expect(splitBashCommand("c1 && c2")).toEqual(["c1 && c2"]);
    expect(splitBashCommand("c1 | c2")).toEqual(["c1 | c2"]);
  });

  test("does not split ; inside quotes", () => {
    expect(splitBashCommand('echo "a;b"; c')).toEqual(['echo "a;b"', "c"]);
    expect(splitBashCommand("echo 'a;b'; c")).toEqual(["echo 'a;b'", "c"]);
  });

  test("does not split an escaped \\; (e.g. find -exec)", () => {
    const command = `find . -exec rm {} ${BS}; ; echo done`;
    expect(splitBashCommand(command)).toEqual([`find . -exec rm {} ${BS};`, "echo done"]);
  });

  test("drops empty segments from trailing/duplicate semicolons", () => {
    expect(splitBashCommand("a;; b ;")).toEqual(["a", "b"]);
  });

  test("splits newline-separated commands verbatim (no html escaping)", () => {
    const command = ["cd /repo", "pkill -x logdy 2>/dev/null", "# a comment", "git status"].join(
      "\n",
    );
    expect(splitBashCommand(command)).toEqual([
      "cd /repo",
      "pkill -x logdy 2>/dev/null",
      "# a comment",
      "git status",
    ]);
  });

  test("keeps a chain operator joined across a line break", () => {
    expect(splitBashCommand("git add . &&\ngit commit")).toEqual(["git add . && git commit"]);
    expect(splitBashCommand("cat x |\nhead")).toEqual(["cat x | head"]);
  });

  test("does not split newlines inside quotes (heredoc-style strings)", () => {
    expect(splitBashCommand("echo 'a\nb'; c")).toEqual(["echo 'a\nb'", "c"]);
  });

  test("an apostrophe inside a # comment does not start a quote", () => {
    const command = ["a", "# can't / won't break things", "b | c"].join("\n");
    expect(splitBashCommand(command)).toEqual(["a", "# can't / won't break things", "b | c"]);
  });

  test("a single command stays a single segment", () => {
    expect(splitBashCommand("ls -la")).toEqual(["ls -la"]);
  });

  test("empty input yields no segments", () => {
    expect(splitBashCommand("")).toEqual([]);
  });
});

describe("resultLines", () => {
  test("empty input yields no lines", () => {
    expect(resultLines({})).toEqual([]);
  });

  test("single plain line has no color key", () => {
    expect(resultLines({ result: "exit 0" })).toEqual([{ text: "exit 0" }]);
  });

  test("multi-line result renders one entry per line, no colors", () => {
    expect(resultLines({ result: "line1\nline2\nline3" })).toEqual([
      { text: "line1" },
      { text: "line2" },
      { text: "line3" },
    ]);
  });

  test("caps at 14 entries and notes how many were hidden", () => {
    const result = Array.from({ length: 20 }, (_, i) => `L${i + 1}`).join("\n");
    const out = resultLines({ result });
    expect(out).toHaveLength(15); // 14 lines + footer
    expect(out[14]).toEqual({ text: "… 6 more lines" });
  });

  test("renders a diff with add/del colors", () => {
    expect(resultLines({ diff: " context\n-removed\n+added" })).toEqual([
      { text: " context" },
      { text: "-removed", color: "del" },
      { text: "+added", color: "add" },
    ]);
  });

  test("diff takes precedence over result", () => {
    expect(resultLines({ result: "plain", diff: "+only the diff" })).toEqual([
      { text: "+only the diff", color: "add" },
    ]);
  });

  test("renders a summary header above the body", () => {
    expect(resultLines({ resultHead: "200 · 60KB · 4.3s", result: "the body" })).toEqual([
      { text: "200 · 60KB · 4.3s", color: "head" },
      { text: "the body" },
    ]);
  });

  test("renders stderr in err color after stdout", () => {
    expect(resultLines({ result: "out line", stderr: "boom" })).toEqual([
      { text: "out line" },
      { text: "boom", color: "err" },
    ]);
  });

  test("clips a long line to 200 chars + ellipsis", () => {
    const out = resultLines({ result: "x".repeat(250) });
    expect(out).toHaveLength(1);
    expect(out[0].text.length).toBe(201);
    expect(out[0].text.endsWith("…")).toBe(true);
  });
});
