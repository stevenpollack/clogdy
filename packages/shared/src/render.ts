/**
 * Shared render helpers — pure, dependency-free ports of v1's audit column
 * logic, returning STRUCTURED DATA (no HTML, no escaping). Callers build DOM
 * via `textContent`, so escaping is unnecessary here.
 */

/**
 * Split a Bash command into its top-level sub-commands.
 *
 * Splits on top-level `;` or newline. Keeps `&&` / `||` / `|` joined, including
 * when the operator trails a line (a `\n` right after a trailing chain operator
 * becomes a space, not a split). Respects single/double quotes (no split inside
 * quotes; `\` escapes inside double quotes), `\`-escaped chars at top level
 * (e.g. `find … -exec rm {} \;`), and `#` comments at a word boundary (consumed
 * verbatim to end of line). Returns trimmed, non-empty segments.
 */
export function splitBashCommand(cmd: string): string[] {
  const parts: string[] = [];
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

  return parts.map((p) => p.trim()).filter(Boolean);
}

export type ResultLineColor = "add" | "del" | "head" | "err";

export interface ResultLine {
  text: string;
  color?: ResultLineColor;
}

export interface ResultEntry {
  resultHead?: string | null;
  diff?: string | null;
  result?: string | null;
  stderr?: string | null;
}

/**
 * Build the structured result lines for a tool result:
 * - optional summary header (`resultHead`, color "head");
 * - a unified diff (`diff`, "+ " → "add", "- " → "del", else uncolored);
 * - otherwise the output (`result`, uncolored) followed by `stderr` ("err").
 *
 * Capped at 14 entries with a synthesized "… N more lines" footer; each entry's
 * text clipped to 200 chars.
 */
export function resultLines(e: ResultEntry): ResultLine[] {
  const MAX = 14;
  const clip = (s: string) => (s.length > 200 ? s.slice(0, 200) + "…" : s);

  const out: ResultLine[] = [];
  let total = 0;
  const push = (text: string, color?: ResultLineColor) => {
    if (total < MAX) out.push(color ? { text: clip(text), color } : { text: clip(text) });
    total++;
  };

  if (e.resultHead) push(e.resultHead, "head");
  if (e.diff) {
    for (const l of e.diff.split("\n")) {
      push(l, l[0] === "+" ? "add" : l[0] === "-" ? "del" : undefined);
    }
  } else {
    if (e.result) for (const l of e.result.split("\n")) push(l, undefined);
    if (e.stderr) for (const l of e.stderr.split("\n")) push(l, "err");
  }

  if (total > MAX) out.push({ text: `… ${total - MAX} more lines` });
  return out;
}
