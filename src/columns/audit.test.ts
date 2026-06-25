import { describe, expect, test } from "bun:test";
import type { CellHandler, CellHandlerFn, Message } from "../logdy";
import type { Flattened } from "../transcript";
import { columns } from "../index";
import {
  commandColumn,
  corrColumn,
  errorColumn,
  kindColumn,
  projectColumn,
  resultColumn,
  sessionColumn,
  timeColumn,
  toolColumn,
} from "./audit";

const render = (handler: CellHandlerFn, json_content: Partial<Flattened>) =>
  handler({ id: "x", log_type: 1, content: "", is_json: true, ts: 0, json_content } as Message);

const cmd = (j: Partial<Flattened>) => render(commandColumn.handler, j);
const BS = String.fromCharCode(92); // a literal backslash, unmangled by source escaping

/** The rows a cell renders (one per `<td>`), agnostic to its representation. */
function segments(r: CellHandler): string[] {
  if (!r.allowHtmlInText) return [r.text];
  // `<td>` may carry a style attribute (diff/stderr/header colors).
  return [...r.text.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((m) => m[1]);
}

describe("commandColumn", () => {
  test("splits Bash on top-level semicolons into <tr> rows", () => {
    const r = cmd({ _tool: "Bash", _command: "a; b; c" });
    expect(r.allowHtmlInText).toBe(true);
    expect(r.text.startsWith("<table>")).toBe(true);
    expect(segments(r)).toEqual(["a", "b", "c"]);
  });

  test("keeps && and | on one line (single segment, plain text)", () => {
    const amp = cmd({ _tool: "Bash", _command: "c1 && c2" });
    expect(amp.allowHtmlInText).toBeUndefined();
    expect(amp.text).toBe("c1 && c2");
    expect(cmd({ _tool: "Bash", _command: "c1 | c2" }).text).toBe("c1 | c2");
  });

  test("does not split ; inside quotes", () => {
    expect(segments(cmd({ _tool: "Bash", _command: 'echo "a;b"; c' }))).toEqual(['echo "a;b"', "c"]);
    expect(segments(cmd({ _tool: "Bash", _command: "echo 'a;b'; c" }))).toEqual(["echo 'a;b'", "c"]);
  });

  test("does not split an escaped \\; (e.g. find -exec)", () => {
    const command = `find . -exec rm {} ${BS}; ; echo done`;
    expect(segments(cmd({ _tool: "Bash", _command: command }))).toEqual([
      `find . -exec rm {} ${BS};`,
      "echo done",
    ]);
  });

  test("HTML-escapes segments to neutralise injection", () => {
    const r = cmd({ _tool: "Bash", _command: "echo '<script>x</script>'; pwd" });
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

  test("a single command stays plain text (no table wrapper)", () => {
    const r = cmd({ _tool: "Bash", _command: "ls -la" });
    expect(r.allowHtmlInText).toBeUndefined();
    expect(r.text).toBe("ls -la");
  });

  test("drops empty segments from trailing/duplicate semicolons", () => {
    expect(segments(cmd({ _tool: "Bash", _command: "a;; b ;" }))).toEqual(["a", "b"]);
  });

  test("splits newline-separated commands into rows", () => {
    const command = ["cd /repo", "pkill -x logdy 2>/dev/null", "# a comment", "git status"].join(
      "\n",
    );
    expect(segments(cmd({ _tool: "Bash", _command: command }))).toEqual([
      "cd /repo",
      "pkill -x logdy 2&gt;/dev/null",
      "# a comment",
      "git status",
    ]);
  });

  test("keeps a chain operator joined across a line break", () => {
    expect(cmd({ _tool: "Bash", _command: "git add . &&\ngit commit" }).text).toBe(
      "git add . && git commit",
    );
    expect(cmd({ _tool: "Bash", _command: "cat x |\nhead" }).text).toBe("cat x | head");
  });

  test("does not split newlines inside quotes (heredoc-style strings)", () => {
    expect(segments(cmd({ _tool: "Bash", _command: "echo 'a\nb'; c" }))).toEqual(["echo 'a\nb'", "c"]);
  });

  test("an apostrophe inside a # comment does not start a quote", () => {
    // regression: "aren't" must not swallow the following newline split
    const command = ["a", "# can't / won't break things", "b | c"].join("\n");
    expect(segments(cmd({ _tool: "Bash", _command: command }))).toEqual([
      "a",
      "# can't / won't break things",
      "b | c",
    ]);
  });
});

describe("resultColumn", () => {
  const res = (j: Partial<Flattened>) => render(resultColumn.handler, j);
  const cells = segments; // reuse the shared `<td>` extractor

  test("empty result yields empty text", () => {
    expect(res({}).text).toBe("");
  });

  test("single-line result stays plain text", () => {
    const r = res({ _result: "exit 0" });
    expect(r.allowHtmlInText).toBeUndefined();
    expect(r.text).toBe("exit 0");
  });

  test("multi-line result renders one row per line", () => {
    const r = res({ _result: "line1\nline2\nline3" });
    expect(r.allowHtmlInText).toBe(true);
    expect(cells(r)).toEqual(["line1", "line2", "line3"]);
  });

  test("caps long output and notes how many lines were hidden", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `L${i + 1}`);
    const r = res({ _result: lines.join("\n") });
    const out = cells(r);
    expect(out).toHaveLength(15); // 14 lines + footer
    expect(out[14]).toBe("… 6 more lines");
  });

  test("escapes HTML in output", () => {
    const r = res({ _result: "a\n<script>evil</script>" });
    expect(r.text).not.toContain("<script>");
    expect(r.text).toContain("&lt;script&gt;");
  });

  test("renders a diff with red/green lines when _diff is set", () => {
    const r = res({ _diff: " context\n-removed\n+added" });
    expect(r.allowHtmlInText).toBe(true);
    expect(cells(r)).toEqual([" context", "-removed", "+added"]);
    expect(r.text).toContain("color:#f87171"); // removed -> red
    expect(r.text).toContain("color:#4ade80"); // added -> green
  });

  test("_diff takes precedence over _result", () => {
    const r = res({ _result: "plain text result", _diff: "+only the diff" });
    expect(cells(r)).toEqual(["+only the diff"]);
  });

  test("renders a summary header above the body", () => {
    const r = res({ _resultHead: "200 · 60KB · 4.3s", _result: "the body" });
    expect(cells(r)).toEqual(["200 · 60KB · 4.3s", "the body"]);
    expect(r.text).toContain("color:#9ca3af"); // header is dim grey
  });

  test("renders stderr in red after stdout", () => {
    const r = res({ _result: "out line", _stderr: "boom" });
    expect(cells(r)).toEqual(["out line", "boom"]);
    expect(r.text).toContain("color:#f87171"); // stderr -> red
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

  test("project facet mirrors text; empty yields no facet", () => {
    expect(render(projectColumn.handler, { _project: "clogdy" })).toEqual({
      text: "clogdy",
      facets: [{ name: "project", value: "clogdy" }],
    });
    expect(render(projectColumn.handler, {}).facets).toEqual([]);
  });

  test("session column shows + facets the short id; empty yields no facet", () => {
    const r = render(sessionColumn.handler, { _session: "630f4af6-08f1-48ec-8542-54df9e9a276c" });
    expect(r.text).toBe("630f4af6");
    expect(r.facets).toEqual([{ name: "session", value: "630f4af6" }]);
    expect(render(sessionColumn.handler, {}).facets).toEqual([]);
  });

  // Regression: setting `faceted: true` AND emitting manual facets gives every row
  // two identical facets, and Logdy's filter predicate over-decrements its match
  // counter on the duplicate, so facet filtering returns 0 rows. We emit facets
  // manually, so no column may set `faceted`.
  test("no column sets `faceted: true` (it duplicates our manual facets)", () => {
    for (const col of columns) expect(col.faceted).toBeFalsy();
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
