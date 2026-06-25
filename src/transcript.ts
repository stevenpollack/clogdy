/**
 * Loose shape of a Claude Code transcript JSONL line. TYPES ONLY — this file
 * must export no runtime values, because handlers that import from it are
 * eval'd in isolation inside Logdy (type imports are erased at build time;
 * value imports would throw at runtime).
 *
 * Transcripts live at ~/.claude/projects/<slug>/<session-id>.jsonl, one JSON
 * object per line. The schema is NOT stable across Claude Code versions — every
 * field here is optional on purpose. Inspect a real transcript before relying on
 * any field, and keep handlers defensive.
 */
export type TranscriptLine = {
  type?: "user" | "assistant" | "summary" | "system" | string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string; // ISO 8601
  sessionId?: string;
  isSidechain?: boolean;
  cwd?: string;
  message?: {
    role?: "user" | "assistant" | string;
    model?: string;
    content?: string | ContentBlock[];
  };
};

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id?: string; name?: string; input?: unknown }
  | { type: "tool_result"; tool_use_id?: string; content?: unknown; is_error?: boolean }
  | { type: string; [k: string]: unknown };
