import type { ColumnDef } from "../logdy";
import type { Flattened } from "../transcript";

/**
 * Columns for auditing Claude's tool usage. They read the `_`-prefixed fields
 * the `flatten` middleware produces. Each handler inlines its own cast — handlers
 * are serialized independently, so a shared helper would not survive into Logdy.
 */

/** HH:MM:SS from the ISO timestamp. */
export const timeColumn: ColumnDef = {
  name: "time",
  width: 90,
  handler: (line) => {
    const j = (line.json_content ?? {}) as Flattened;
    const ts = j.timestamp ?? "";
    return { text: ts.length >= 19 ? ts.slice(11, 19) : ts };
  },
};

/** prompt | text | thinking | tool_use | tool_result — filter to isolate turns vs tools. */
export const kindColumn: ColumnDef = {
  name: "kind",
  width: 95,
  faceted: true,
  handler: (line) => {
    const j = (line.json_content ?? {}) as Flattened;
    const k = j._kind ?? "";
    return { text: k, facets: k ? [{ name: "kind", value: k }] : [] };
  },
};

/** Tool name (Bash, Edit, Read, ...) — the primary audit filter. */
export const toolColumn: ColumnDef = {
  name: "tool",
  width: 90,
  faceted: true,
  handler: (line) => {
    const j = (line.json_content ?? {}) as Flattened;
    const t = j._tool ?? "";
    return { text: t, facets: t ? [{ name: "tool", value: t }] : [] };
  },
};

/** The headline: command / file / url / query Claude invoked the tool with. */
export const commandColumn: ColumnDef = {
  name: "command",
  width: 520,
  handler: (line) => {
    const j = (line.json_content ?? {}) as Flattened;
    return { text: j._command ?? "" };
  },
};

/** Error flag for tool results, reddened and filterable. */
export const errorColumn: ColumnDef = {
  name: "error",
  width: 70,
  faceted: true,
  handler: (line) => {
    const j = (line.json_content ?? {}) as Flattened;
    if (j._isError === undefined) return { text: "" };
    return {
      text: j._isError ? "ERROR" : "",
      style: j._isError ? { color: "#f87171", fontWeight: "bold" } : undefined,
      facets: [{ name: "error", value: j._isError ? "error" : "ok" }],
    };
  },
};

/** Tool result payload (truncated; full value in the raw drawer). */
export const resultColumn: ColumnDef = {
  name: "result",
  width: 420,
  handler: (line) => {
    const j = (line.json_content ?? {}) as Flattened;
    const r = j._result ?? "";
    return { text: r.length > 600 ? r.slice(0, 600) + "…" : r };
  },
};

/** Narrative text for prompt / assistant text / thinking lines (truncated). */
export const textColumn: ColumnDef = {
  name: "text",
  width: 420,
  handler: (line) => {
    const j = (line.json_content ?? {}) as Flattened;
    const t = j._text ?? "";
    return { text: t.length > 600 ? t.slice(0, 600) + "…" : t };
  },
};

/** Full raw line; opens the parsed JSON in the drawer. */
export const rawColumn: ColumnDef = {
  name: "raw",
  width: 280,
  handler: (line) => ({ text: line.content || "-", isJson: line.is_json }),
};
