import type { MiddlewareDef } from "../logdy";
import type { ContentBlock, Flattened, PatchHunk, ToolResultBlock, ToolUseBlock } from "../transcript";

/**
 * Flatten a Claude transcript line into scalar `_`-prefixed fields that columns
 * read directly, and drop non-conversational events (snapshots, mode changes,
 * etc. — anything without a `message`).
 *
 * Also links each tool call to its result via correlation_id (the tool_use id /
 * tool_result tool_use_id), and orders lines by timestamp.
 *
 * Self-contained: only uses `line` and built-ins (no imported runtime values).
 */
export const flatten: MiddlewareDef = {
  name: "flatten",
  handler: (line) => {
    if (!line.is_json) return line; // pass malformed/raw lines through untouched

    const j = line.json_content as Flattened;
    if (j == null || j.message == null) return; // drop events that aren't turns

    const content = j.message.content;
    const blocks: ContentBlock[] = Array.isArray(content) ? content : [];
    const primary =
      blocks.find((b) => b.type === "tool_use") ??
      blocks.find((b) => b.type === "tool_result") ??
      blocks[0];

    j._event = j.type;

    if (typeof content === "string") {
      j._kind = "prompt";
      j._text = content;
    } else {
      j._kind = primary?.type ?? "";
      if (primary?.type === "text") j._text = (primary as { text: string }).text;
      else if (primary?.type === "thinking") j._text = (primary as { thinking: string }).thinking;
    }

    if (primary?.type === "tool_use") {
      const b = primary as ToolUseBlock;
      const inp = (b.input ?? {}) as Record<string, any>;
      const inputJson = JSON.stringify(inp);
      j._tool = b.name;
      j._command =
        inp.command ??
        inp.file_path ??
        inp.url ??
        inp.query ??
        inp.path ??
        inp.pattern ??
        (Object.keys(inp).length ? inputJson : "");
      j._input = inputJson;
      j._corr = b.id;
      line.correlation_id = b.id;
    }

    if (primary?.type === "tool_result") {
      const b = primary as ToolResultBlock;
      j._isError = b.is_error === true;
      j._result = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
      j._corr = b.tool_use_id;
      line.correlation_id = b.tool_use_id;

      // Tool-aware enrichment from the structured result.
      const tur = j.toolUseResult as Record<string, any> | undefined;
      if (tur && typeof tur === "object") {
        if (Array.isArray(tur.structuredPatch)) {
          // Edit/Write: flatten the structured patch to unified-diff text.
          const diff = (tur.structuredPatch as PatchHunk[]).flatMap((h) => h?.lines ?? []);
          if (diff.length) j._diff = diff.join("\n");
        } else if (typeof tur.stdout === "string" || typeof tur.stderr === "string") {
          // Bash: prefer the structured stdout/stderr split.
          if (typeof tur.stdout === "string") j._result = tur.stdout;
          if (typeof tur.stderr === "string" && tur.stderr.length > 0) j._stderr = tur.stderr;
          if (tur.interrupted === true) j._resultHead = "⚠ interrupted";
        } else if (typeof tur.url === "string" && typeof tur.bytes === "number") {
          // WebFetch: status · size · duration.
          const size = tur.bytes < 1024 ? `${tur.bytes}B` : `${(tur.bytes / 1024).toFixed(1)}KB`;
          const dur =
            typeof tur.durationMs === "number"
              ? tur.durationMs >= 1000
                ? `${(tur.durationMs / 1000).toFixed(1)}s`
                : `${tur.durationMs}ms`
              : "";
          j._resultHead = [tur.code, size, dur].filter(Boolean).join(" · ");
        } else if (Array.isArray(tur.results) || typeof tur.searchCount === "number") {
          // WebSearch: result count + query.
          const n = Array.isArray(tur.results) ? tur.results.length : tur.searchCount;
          const q = typeof tur.query === "string" ? ` · "${tur.query.slice(0, 60)}"` : "";
          j._resultHead = `${n} results${q}`;
        }
      }
    }

    // Identity for the multi-session "follow everything" view: project (basename
    // of cwd) and session id, both filterable via their columns' facets.
    if (typeof j.cwd === "string" && j.cwd.length) {
      j._project = j.cwd.replace(/\/+$/, "").split("/").pop() || j.cwd;
    }
    if (typeof j.sessionId === "string" && j.sessionId.length) j._session = j.sessionId;

    if (j.timestamp) {
      const ms = Date.parse(j.timestamp);
      if (!Number.isNaN(ms)) line.order_key = ms;
    }

    return line;
  },
};
