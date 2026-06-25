import { describe, expect, test } from "bun:test";
import type { CellHandlerFn, Message } from "../logdy";
import type { Flattened } from "../transcript";
import {
  commandColumn,
  corrColumn,
  errorColumn,
  kindColumn,
  timeColumn,
  toolColumn,
} from "./audit";

const render = (handler: CellHandlerFn, json_content: Partial<Flattened>) =>
  handler({ id: "x", log_type: 1, content: "", is_json: true, ts: 0, json_content } as Message);

const cmd = (j: Partial<Flattened>) => render(commandColumn.handler, j);
const BS = String.fromCharCode(92); // a literal backslash, unmangled by source escaping

describe("commandColumn", () => {
  test("splits Bash on top-level semicolons into separate lines", () => {
    const r = cmd({ _tool: "Bash", _command: "a; b; c" });
    expect(r.allowHtmlInText).toBe(true);
    expect(r.text.split("<br>")).toEqual(["a", "b", "c"]);
  });

  test("keeps && and | on one line", () => {
    expect(cmd({ _tool: "Bash", _command: "c1 && c2" }).text).toBe("c1 &amp;&amp; c2");
    expect(cmd({ _tool: "Bash", _command: "c1 | c2" }).text).toBe("c1 | c2");
  });

  test("does not split ; inside quotes", () => {
    expect(cmd({ _tool: "Bash", _command: 'echo "a;b"; c' }).text.split("<br>")).toEqual([
      'echo "a;b"',
      "c",
    ]);
    expect(cmd({ _tool: "Bash", _command: "echo 'a;b'; c" }).text.split("<br>")).toEqual([
      "echo 'a;b'",
      "c",
    ]);
  });

  test("does not split an escaped \\; (e.g. find -exec)", () => {
    const command = `find . -exec rm {} ${BS}; ; echo done`;
    const lines = cmd({ _tool: "Bash", _command: command }).text.split("<br>");
    expect(lines).toEqual([`find . -exec rm {} ${BS};`, "echo done"]);
  });

  test("HTML-escapes to neutralise injection", () => {
    const r = cmd({ _tool: "Bash", _command: "echo '<script>x</script>'" });
    expect(r.text).not.toContain("<script>");
    expect(r.text).toContain("&lt;script&gt;");
  });

  test("non-Bash tools render plain text with no HTML", () => {
    const r = cmd({ _tool: "Read", _command: "/a;b/c" });
    expect(r.allowHtmlInText).toBeUndefined();
    expect(r.text).toBe("/a;b/c");
  });

  test("empty command yields empty text", () => {
    expect(cmd({ _tool: "Bash" }).text).toBe("");
  });

  test("drops empty segments from trailing/duplicate semicolons", () => {
    expect(cmd({ _tool: "Bash", _command: "a;; b ;" }).text.split("<br>")).toEqual(["a", "b"]);
  });

  test("splits newline-separated commands into lines", () => {
    const command = ["cd /repo", "pkill -x logdy 2>/dev/null", "# a comment", "git status"].join(
      "\n",
    );
    expect(cmd({ _tool: "Bash", _command: command }).text.split("<br>")).toEqual([
      "cd /repo",
      "pkill -x logdy 2&gt;/dev/null",
      "# a comment",
      "git status",
    ]);
  });

  test("keeps a chain operator joined across a line break", () => {
    expect(cmd({ _tool: "Bash", _command: "git add . &&\ngit commit" }).text).toBe(
      "git add . &amp;&amp; git commit",
    );
    expect(cmd({ _tool: "Bash", _command: "cat x |\nhead" }).text).toBe("cat x | head");
  });

  test("does not split newlines inside quotes (heredoc-style strings)", () => {
    expect(cmd({ _tool: "Bash", _command: "echo 'a\nb'; c" }).text.split("<br>")).toEqual([
      "echo 'a\nb'",
      "c",
    ]);
  });

  test("an apostrophe inside a # comment does not start a quote", () => {
    // regression: "aren't" must not swallow the following newline split
    const command = ["a", "# can't / won't break things", "b | c"].join("\n");
    expect(cmd({ _tool: "Bash", _command: command }).text.split("<br>")).toEqual([
      "a",
      "# can't / won't break things",
      "b | c",
    ]);
  });
});

describe("corrColumn", () => {
  test("shows the last 6 chars of the link id", () => {
    expect(render(corrColumn.handler, { _corr: "toolu_01ABCDEF" }).text).toBe("ABCDEF");
  });
  test("blank when no correlation", () => {
    expect(render(corrColumn.handler, {}).text).toBe("");
  });
});

describe("errorColumn", () => {
  test("blank and unstyled when not a tool result", () => {
    const r = render(errorColumn.handler, {});
    expect(r.text).toBe("");
    expect(r.style).toBeUndefined();
  });
  test("reddened ERROR with error facet when is_error", () => {
    const r = render(errorColumn.handler, { _isError: true });
    expect(r.text).toBe("ERROR");
    expect(r.style?.color).toBeTruthy();
    expect(r.facets).toEqual([{ name: "error", value: "error" }]);
  });
  test("ok facet when result is not an error", () => {
    const r = render(errorColumn.handler, { _isError: false });
    expect(r.text).toBe("");
    expect(r.facets).toEqual([{ name: "error", value: "ok" }]);
  });
});

describe("faceted columns", () => {
  test("kind facet mirrors text", () => {
    expect(render(kindColumn.handler, { _kind: "tool_use" }).facets).toEqual([
      { name: "kind", value: "tool_use" },
    ]);
  });
  test("tool column has no facet when empty", () => {
    expect(render(toolColumn.handler, {}).facets).toEqual([]);
  });
});

describe("timeColumn", () => {
  test("extracts HH:MM:SS from an ISO timestamp", () => {
    expect(render(timeColumn.handler, { timestamp: "2026-06-25T01:23:45.000Z" }).text).toBe(
      "01:23:45",
    );
  });
  test("passes short/blank timestamps through", () => {
    expect(render(timeColumn.handler, {}).text).toBe("");
  });
});
