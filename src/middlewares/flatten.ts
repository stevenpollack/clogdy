import type { MiddlewareDef } from "../logdy";
import type { ContentBlock, Flattened, ToolResultBlock, ToolUseBlock } from "../transcript";

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
    j._kind = typeof content === "string" ? "prompt" : primary?.type ?? "";

    if (typeof content === "string") j._text = content;
    else if (primary?.type === "text") j._text = (primary as { text: string }).text;
    else if (primary?.type === "thinking") j._text = (primary as { thinking: string }).thinking;

    if (primary?.type === "tool_use") {
      const b = primary as ToolUseBlock;
      const inp = (b.input ?? {}) as Record<string, any>;
      j._tool = b.name;
      j._command =
        inp.command ??
        inp.file_path ??
        inp.url ??
        inp.query ??
        inp.path ??
        inp.pattern ??
        (Object.keys(inp).length ? JSON.stringify(inp) : "");
      j._input = JSON.stringify(inp);
      j._corr = b.id;
      line.correlation_id = b.id;
    }

    if (primary?.type === "tool_result") {
      const b = primary as ToolResultBlock;
      j._isError = b.is_error === true;
      j._result = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
      j._corr = b.tool_use_id;
      line.correlation_id = b.tool_use_id;
    }

    if (j.timestamp) {
      const ms = Date.parse(j.timestamp);
      if (!Number.isNaN(ms)) line.order_key = ms;
    }

    return line;
  },
};
