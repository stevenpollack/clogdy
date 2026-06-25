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

/**
 * Link id shared by a tool_use and its tool_result (short form). Set as the
 * config's `correlationIdField` so Logdy paints matching call/result cells the
 * same color (color = hash of this cell's text).
 */
export const corrColumn: ColumnDef = {
  name: "corr",
  width: 80,
  handler: (line) => {
    const j = (line.json_content ?? {}) as Flattened;
    const c = j._corr ?? "";
    return { text: c ? c.slice(-6) : "" };
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

/**
 * The headline: command / file / url / query Claude invoked the tool with.
 *
 * For Bash, composite commands separated at the top level by `;` or a newline
 * are rendered as separate lines (via HTML <br>). `&&`, `||` and `|` keep their
 * two sides together — including when the operator trails a line (continuation).
 * The split is quote/escape-aware so `find … -exec … \;`, `echo "a;b"`, and
 * heredoc/quoted newlines are not broken. HTML is escaped before rendering.
 */
export const commandColumn: ColumnDef = {
  name: "command",
  width: 520,
  handler: (line) => {
    const j = (line.json_content ?? {}) as Flattened;
    const cmd = j._command ?? "";
    if (!cmd || j._tool !== "Bash") return { text: cmd };

    const parts = [];
    let buf = "";
    let quote = "";
    for (let i = 0; i < cmd.length; i++) {
      const ch = cmd[i];
      if (quote) {
        if (ch === "\\" && quote === '"' && i + 1 < cmd.length) {
          buf += ch + cmd[++i];
          continue;
        }
        buf += ch;
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        buf += ch;
        continue;
      }
      // `#` at a word boundary starts a comment to end of line; consume it
      // verbatim so quotes/`;` inside it (e.g. an apostrophe) stay inert.
      if (ch === "#" && (i === 0 || /\s/.test(cmd[i - 1]))) {
        let k = i;
        while (k < cmd.length && cmd[k] !== "\n") k++;
        buf += cmd.slice(i, k);
        i = k - 1;
        continue;
      }
      if (ch === "\\" && i + 1 < cmd.length) {
        buf += ch + cmd[++i];
        continue;
      }
      if (ch === ";" || ch === "\n") {
        // A newline after a chaining operator continues the command — keep joined.
        if (ch === "\n" && /(?:&&|\|\||\|)\s*$/.test(buf)) {
          buf += " ";
          continue;
        }
        parts.push(buf);
        buf = "";
        continue;
      }
      buf += ch;
    }
    parts.push(buf);

    const esc = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const html = parts.map((p) => esc(p.trim())).filter(Boolean).join("<br>");
    return { text: html, allowHtmlInText: true };
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
