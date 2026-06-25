/**
 * Shapes of a Claude Code transcript JSONL line. TYPES ONLY — this file must
 * export no runtime values, because handlers that import from it are eval'd in
 * isolation inside Logdy (type imports are erased at build time; value imports
 * would throw at runtime).
 *
 * Transcripts live at ~/.claude/projects/<slug>/<session-id>.jsonl, one JSON
 * object per line. Shapes below were derived from real transcripts; treat them
 * as best-effort (the schema drifts across Claude Code versions) and keep
 * handlers defensive. Each conversational line has `message`; non-conversational
 * events (file-history-snapshot, mode, attachment, ...) do not.
 */

export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  caller?: unknown;
};

export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string | unknown[];
  is_error?: boolean;
};

export type TextBlock = { type: "text"; text: string };
export type ThinkingBlock = { type: "thinking"; thinking: string; signature?: string };

export type ContentBlock =
  | ToolUseBlock
  | ToolResultBlock
  | TextBlock
  | ThinkingBlock
  | { type: string; [k: string]: unknown };

export type TranscriptLine = {
  type?: string; // assistant | user | system | file-history-snapshot | ...
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string; // ISO 8601
  sessionId?: string;
  isSidechain?: boolean;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  /** Present on user lines that carry a tool result; structured per tool. */
  toolUseResult?: unknown;
  message?: {
    role?: string;
    model?: string;
    content?: string | ContentBlock[];
  };
};

/**
 * TranscriptLine plus the derived fields the `flatten` middleware writes onto
 * json_content. Columns cast json_content to this and read the `_`-prefixed
 * fields instead of re-walking the nested structure.
 */
export type Flattened = TranscriptLine & {
  /** Top-level event type (== `type`). */
  _event?: string;
  /** prompt | text | thinking | tool_use | tool_result. */
  _kind?: string;
  /** Tool name for tool_use lines (Bash, Edit, Read, ...). */
  _tool?: string;
  /** Primary argument of a tool call: command / file_path / url / query / ... */
  _command?: string;
  /** Full tool input as compact JSON. */
  _input?: string;
  /** Flattened text for prompt/text/thinking lines. */
  _text?: string;
  /** tool_result payload as text. */
  _result?: string;
  /** True when a tool_result is flagged is_error. */
  _isError?: boolean;
  /** Link id shared by a tool_use and its tool_result (the tool id). */
  _corr?: string;
  /** Unified-diff text (one line per entry, ` `/`-`/`+` prefixed) for Edit/Write results. */
  _diff?: string;
};

/** A `toolUseResult.structuredPatch` hunk (Edit/Write results). */
export type PatchHunk = {
  oldStart?: number;
  oldLines?: number;
  newStart?: number;
  newLines?: number;
  /** Unified-diff lines, each prefixed with ` ` (context), `-` (removed), or `+` (added). */
  lines?: string[];
};
