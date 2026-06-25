/**
 * Logdy type definitions, copied from the Logdy docs so middleware and column
 * handlers can be type-checked with `tsc` / the TypeScript LSP before being
 * pasted into Logdy's in-browser editor or a `logdy.config.json` file.
 *
 * Source of truth (verify against these if Logdy changes):
 *   https://logdy.dev/docs/reference/code
 *   https://logdy.dev/docs/explanation/settings
 *
 * These are authoring aids only — Logdy does not import this file. The shapes
 * mirror what Logdy passes to / expects from handler functions.
 */

/** Logdy emits log_type 1 for STDOUT, 2 for STDERR. */
export type LogType = 1 | 2;

/** A single log line as Logdy hands it to middleware and column handlers. */
export type Message = {
  /** Random identifier. */
  id: string;
  /** 1 = STDOUT, 2 = STDERR. */
  log_type: LogType;
  /** Raw log line. For Claude transcripts this is one JSONL line. */
  content: string;
  /** Auto-populated parsed JSON when `is_json` is true. */
  json_content?: any;
  /** Whether `content` parsed as JSON. */
  is_json: boolean;
  /** UNIX timestamp in milliseconds when Logdy received the line. */
  ts: number;
  /** Set to control ordering across multiple sources (e.g. transcript timestamp). */
  order_key?: number;
  origin?: {
    port: string;
    file: string;
    api_source: string;
  };
  /** Row-level styling (CSS-like properties). */
  style?: Record<string, string>;
  correlation_id?: string;
  timing?: {
    start: number;
    end?: number;
    duration?: number;
    label?: string;
    style?: {
      backgroundColor?: string;
      border?: string;
      color?: string;
    };
  };
};

/** A filterable tag attached to a cell. `name` groups, `value` is the filter value. */
export type Facet = {
  name: string;
  value: string;
};

/** What a column handler returns for one cell. */
export type CellHandler = {
  /** Text shown in the cell. */
  text: string;
  /** Render the cell's expanded view as JSON. */
  isJson?: boolean;
  /** Cell-level styling (CSS-like properties). */
  style?: Record<string, string>;
  /** Tags that become UI filters. */
  facets?: Facet[];
  /** SECURITY: renders `text` as raw HTML when true. Avoid for untrusted content. */
  allowHtmlInText?: boolean;
};

/**
 * Middleware: runs on every line. Return the (possibly mutated) Message to keep
 * it, or return nothing (void) to DROP the line from the view.
 *
 * MUST be self-contained: Logdy serializes the function source and evals it in
 * isolation, so the body may only use its `line` argument and built-ins — no
 * imported runtime values, no closure over module-level constants. (Type-only
 * imports are fine; they're erased before serialization.)
 */
export type RowHandlerFn = (line: Message) => Message | void;

/** Column parser: produces one cell from a Message. Same self-contained rule as RowHandlerFn. */
export type CellHandlerFn = (line: Message) => CellHandler;

// ---------------------------------------------------------------------------
// Authoring registry types (this repo's own — not part of Logdy).
// build-config.ts turns these into the serialized config below.
// ---------------------------------------------------------------------------

export type MiddlewareDef = {
  /** Stable, human label; also seeds the config `id`. Keep unique. */
  name: string;
  handler: RowHandlerFn;
};

export type ColumnDef = {
  /** Column header; also seeds the config `id`. Keep unique. */
  name: string;
  handler: CellHandlerFn;
  width?: number;
  hidden?: boolean;
  /** Auto-generate facets/filters from cell values. */
  faceted?: boolean;
};

// ---------------------------------------------------------------------------
// Serialized config shapes written to logdy.config.json.
//
// Modeled from a real Logdy "Settings -> Export" (config.base.json). Note Logdy
// stores ONLY `handlerTsCode` (the source string shown in its editor) and
// computes the runtime `handler` itself on load — so we never emit `handler`.
// `handlerTsCode` is TypeScript source; plain JS is valid there too (Logdy
// transpiles it), which is what our generator emits via Function.toString().
// ---------------------------------------------------------------------------

export type LogdyMiddleware = {
  id: string;
  name: string;
  /** Source of the `(line: Message) => Message | void` handler. */
  handlerTsCode: string;
};

export type LogdyColumn = {
  id: string;
  name: string;
  /** Source of the `(line: Message) => CellHandler` handler. */
  handlerTsCode: string;
  idx: number;
  width?: number;
  faceted?: boolean;
};

export type LogdySettings = {
  maxMessages?: number;
  entriesOrder?: "asc" | "desc";
  leftColWidth?: number;
  drawerColWidth?: number;
  middlewares: LogdyMiddleware[];
  correlationIdField?: string;
  paintCorrelationIdCell?: boolean;
};

export type LogdyConfig = {
  /** Layout name (e.g. "main"). */
  name: string;
  columns: LogdyColumn[];
  settings: LogdySettings;
};
