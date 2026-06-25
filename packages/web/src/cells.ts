/**
 * Pure DOM cell builders for the events table. All event-derived content is set
 * via `textContent` / element construction — never `innerHTML` — so there is no
 * XSS surface even though Bash commands and tool output are untrusted.
 */

import type { EventRow } from "@clogdy/shared";
import { resultLines, splitBashCommand } from "@clogdy/shared";

/**
 * COMMAND cell. For a composite Bash command (more than one top-level segment),
 * renders a nested one-column table with one row per segment (full text). Any
 * other command renders as plain text.
 */
export function commandCell(e: EventRow): HTMLElement {
  const td = document.createElement("td");
  if (e.tool === "Bash" && e.command) {
    const segments = splitBashCommand(e.command);
    if (segments.length > 1) {
      const table = document.createElement("table");
      table.className = "cmd-table";
      for (const seg of segments) {
        const row = document.createElement("tr");
        const cell = document.createElement("td");
        cell.textContent = seg;
        row.appendChild(cell);
        table.appendChild(row);
      }
      td.appendChild(table);
      return td;
    }
  }
  td.textContent = e.command ?? "";
  return td;
}

/**
 * RESULT cell. Renders the structured result lines (header / diff / stdout /
 * stderr) as one colored `<div>` per line. Empty when there are no lines.
 */
export function resultCell(e: EventRow): HTMLElement {
  const td = document.createElement("td");
  const lines = resultLines({
    resultHead: e.resultHead,
    diff: e.diff,
    result: e.result,
    stderr: e.stderr,
  });
  for (const line of lines) {
    const div = document.createElement("div");
    div.className = line.color ? `rline ${line.color}` : "rline";
    div.textContent = line.text;
    td.appendChild(div);
  }
  return td;
}
