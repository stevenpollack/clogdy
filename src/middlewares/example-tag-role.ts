import type { MiddlewareDef } from "../logdy";
import type { TranscriptLine } from "../transcript";

/**
 * Drop transcript lines that aren't user/assistant messages, and set order_key
 * from the message timestamp so multiple sessions interleave in time order.
 *
 * Self-contained: only uses `line` and built-ins (see RowHandlerFn docs).
 */
export const tagRole: MiddlewareDef = {
  name: "tag-role",
  handler: (line) => {
    if (!line.is_json) return; // not a transcript JSON line — drop it

    const t = line.json_content as TranscriptLine;
    if (t.type !== "user" && t.type !== "assistant") return; // drop summaries/system noise

    if (t.timestamp) {
      const ms = Date.parse(t.timestamp);
      if (!Number.isNaN(ms)) line.order_key = ms;
    }

    return line;
  },
};
