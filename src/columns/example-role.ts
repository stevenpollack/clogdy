import type { ColumnDef } from "../logdy";
import type { ContentBlock, TranscriptLine } from "../transcript";

/** Message role as a faceted (filterable) column. */
export const roleColumn: ColumnDef = {
  name: "role",
  faceted: true,
  handler: (line) => {
    const t = (line.json_content ?? {}) as TranscriptLine;
    const role = t.message?.role ?? t.type ?? "unknown";
    return {
      text: role,
      facets: [{ name: "role", value: role }],
    };
  },
};

/**
 * Message text content. Content-flattening is inlined (not imported) because the
 * handler is eval'd in isolation by Logdy.
 */
export const contentColumn: ColumnDef = {
  name: "content",
  handler: (line) => {
    const t = (line.json_content ?? {}) as TranscriptLine;
    const content = t.message?.content;

    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = (content as ContentBlock[])
        .map((b) => {
          if (b.type === "text" && typeof (b as any).text === "string") return (b as any).text;
          if (b.type === "tool_use") return `[tool_use: ${(b as any).name ?? "?"}]`;
          if (b.type === "tool_result") return "[tool_result]";
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }

    return { text };
  },
};
