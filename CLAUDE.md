# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

This repo stores **Logdy** middlewares and configuration — specifically, config that makes
[Logdy](https://logdy.dev) parse and view **Claude Code transcripts**. The deliverables are Logdy
config files (`logdy.config.json` and/or exported JSON) plus the TypeScript middleware/column snippets
they embed.

Logdy stores middleware and column code as JS strings inside JSON, with no type checking. This repo
instead authors them as **typed TypeScript functions** validated by `tsc`/LSP, then a generator
serializes them into `logdy.config.json`. The `.ts` files are the source of truth; `logdy.config.json`
is a generated build artifact — edit the `.ts`, never the JSON by hand.

## Toolchain

Use **bun**, not npm, on this machine.

- `bun install` — install deps; also runs `lefthook install` (via the `prepare` script) to activate hooks.
- `bun run check` — `tsc --noEmit`; validates all handler types.
- `bun run build` — typecheck, then run `scripts/build-config.ts` to (re)generate `logdy.config.json`.

A **lefthook pre-commit hook** (`lefthook.yml`) runs `bun run check` and blocks commits that don't
type-check. If hooks aren't firing on a fresh clone, run `bunx lefthook install` once.

## Layout

- `src/logdy.ts` — copied Logdy runtime types (`Message`, `CellHandler`, `Facet`, `RowHandlerFn`,
  `CellHandlerFn`), the repo's authoring types (`MiddlewareDef`, `ColumnDef`), and the serialized
  config envelope types (`LogdyConfig`, `LogdyColumn`, `LogdyMiddleware`, `LogdySettings`). Verify
  against https://logdy.dev/docs/reference/code if Logdy changes.
- `src/transcript.ts` — **types only**: `TranscriptLine`/`ContentBlock` (real transcript shapes) and
  `Flattened` (TranscriptLine + the `_`-prefixed derived fields the middleware adds). No runtime
  exports — see the constraint below.
- `src/middlewares/flatten.ts` — the core middleware (see Audit pipeline below).
- `src/columns/audit.ts` — the tool-audit columns, each a `ColumnDef` reading a `Flattened` field.
- `src/middlewares/*.ts` / `src/columns/*.ts` — a middleware exports a `MiddlewareDef` (`{ name,
  handler }`; return the `Message` to keep, void to **drop**); a column exports `ColumnDef`s
  (`{ name, handler, faceted?, width? }`) returning a `CellHandler` (`facets` makes it filterable).

## Audit pipeline (the point of this repo)

Goal: audit what tools/commands Claude runs, plus turn-by-turn flow. The flow is parse-once,
read-many:

- `flatten` middleware: drops non-conversational events (anything without `message` — snapshots, mode
  changes, etc.), then writes scalar fields onto `json_content`: `_kind` (prompt/text/thinking/
  tool_use/tool_result), `_tool`, `_command` (primary arg — `command`/`file_path`/`url`/`query`/…),
  `_input`, `_result`, `_isError`, `_text`, `_corr` (the tool id, shared by a `tool_use` and its
  `tool_result`). It also sets `correlation_id` and `order_key` (timestamp).
- `audit.ts` columns are thin readers of those fields: `time`, `kind` (faceted), `tool` (faceted),
  `corr`, `command`, `error` (faceted, reddened), `result`, `text`, `raw`. Filter `tool`/`kind` to
  isolate exactly the tool calls.
- `command` column: for Bash, composite commands are split on **top-level `;`** into separate lines
  (HTML `<br>`, via `allowHtmlInText`); `&&` and `|` stay on one line. The split is quote/escape-aware
  (`echo "a;b"`, `find … -exec … \;` are not broken) and HTML-escapes the text first (XSS-safe — Logdy
  sanitizes with DOMPurify). Any handler returning `allowHtmlInText: true` MUST escape `& < >` itself.

### Correlation painting (verified in the real UI)

Logdy paints a cell's background by **hashing that cell's text**, and only for the column whose name
equals `settings.correlationIdField`. So linking a `tool_use` to its `tool_result` requires a column
that renders the *same id text* on both rows — that's the `corr` column (`_corr` = the tool id), with
`correlationIdField: "corr"` + `paintCorrelationIdCell: true` in `src/config.ts`. Setting
`Message.correlation_id` alone does **not** drive painting (it only powers the "Display correlated
lines" filter). Verified with Playwright: 25 ids → perfect 1:1 id→color.

### Gotcha: duplicate rows across restarts (not a config bug)

Logdy persists each message to browser `localStorage` (`logdy_logs_<id>`), keyed by a **per-process**
id. Restarting Logdy on a file reassigns ids, so a stale browser tab loads the old keys *plus* the new
replay → every row appears twice. It is not the middleware. Fix: clear Logdy's logs (UI trash button)
or `localStorage.clear()` when restarting Logdy or switching transcripts. The dedup that would catch
this (`rowsIds[id]`) keys on the per-process id, so it can't.

Note: handlers are serialized independently, so columns can't share a runtime helper — each inlines its
own `(line.json_content ?? {}) as Flattened` cast. (`thinking` text is empty in current transcripts —
Claude Code persists only a signature, not the thinking body.)
- `src/index.ts` — the **registry**: ordered `middlewares[]` and `columns[]` arrays. Only entries listed
  here are bundled; column array order = on-screen order.
- `src/config.ts` — the envelope defaults (`configName`, `baseSettings`): everything in the config
  except the generated columns/middlewares. Edit layout prefs (`leftColWidth`, etc.) here.
- `scripts/build-config.ts` — the generator (details below).

## Handlers must be self-contained

Logdy serializes each handler with `Function.prototype.toString()` and **evals it in isolation**. A
handler body may use only its `line` argument and JS built-ins — **no imported runtime values, no
closure over module-level constants**. Type-only imports (e.g. `import type { TranscriptLine }`) are
fine because they're erased before serialization. Need a helper? Inline it inside the handler.

## Generator (`scripts/build-config.ts`)

`bun run build` serializes each registered handler (Bun's `.toString()` yields transpiled,
type-stripped JS, which Logdy accepts in its `handlerTsCode` field), assigns ids/idx, builds a
`LogdyConfig`, and **validates it (`assertLogdyConfig`) before writing** so a structural mistake fails
the build instead of landing on disk.

The serialized envelope types in `src/logdy.ts` are modeled from a real Logdy export and verified
against one: top-level `name` + `columns` + `settings`; each column/middleware carries only
`handlerTsCode` (Logdy computes the runtime handler on load); middlewares live under
`settings.middlewares`; middleware ids are `m_`-prefixed. The envelope (`name`, `settings`) comes from
`src/config.ts`; the build fills in the generated `columns` and `settings.middlewares`. There is no
external input file — the build is fully deterministic from `src/`.

> A raw Logdy UI export can be dropped at `config.base.json` for reference (it's gitignored), but the
> build does **not** read it — capture the shape in `src/` instead.

## Authoring workflow

1. Write/edit a handler in `src/middlewares/` or `src/columns/` (keep it self-contained).
2. Register it in `src/index.ts` (order matters for columns).
3. `bun run build` until clean; commit both the `.ts` source and the regenerated `logdy.config.json`.

## What we're parsing: Claude transcript format

Claude Code transcripts live as **JSONL** (one JSON object per line) under
`~/.claude/projects/<project-slug>/<session-id>.jsonl`. Each line is an event — typically with fields
like `type` (`user`/`assistant`/`summary`/etc.), `uuid`, `parentUuid`, `timestamp`, `sessionId`, and a
nested `message` object (role + `content` blocks, where content blocks may be text, `tool_use`, or
`tool_result`). Treat the exact schema as unstable across Claude Code versions — inspect a real
transcript before relying on a field, and make middleware defensive (guard for missing keys).

Feed a transcript into Logdy by piping it on stdin, e.g.:

```bash
cat ~/.claude/projects/<slug>/<session>.jsonl | logdy --config logdy.config.json
# or follow a live session:
tail -f ~/.claude/projects/<slug>/<session>.jsonl | logdy --config logdy.config.json
```

## How Logdy config works (essential model)

- **Config file** (`logdy.config.json`): JSON holding three things — **layout/settings**, **column
  definitions** (each backed by a parser function), and **middlewares** (functions run per log line).
  Embedded function code is stored as strings inside this JSON.
- Logdy **auto-loads** `logdy.config.json` from the working directory (v0.17.0+), or load explicitly
  with `--config <path>`. Config is applied to every UI client.
- In this repo that JSON is **generated** from the typed handlers (`bun run build`); don't author in
  Logdy's in-browser editor as the primary flow. Logdy's editor / `config.base.json` export is only
  used to capture a known-good envelope when needed (see the generator section above).

### Middleware vs. parser/column functions

Both receive the Logdy `Message` (see below). They differ in signature and role:

```typescript
// Middleware: runs on every line; transform/filter/enrich. Return void to DROP the line.
type RowHandlerFn = (line: Message) => Message | void

// Column parser: produces one cell's value for a defined column.
type CellHandlerFn = (line: Message) => CellHandler
// CellHandler: { text, isJson?, style?, facets?: Facet[], allowHtmlInText? }
```

`Message` fields worth knowing: `content` (raw line — for us, the raw JSONL string), `json_content`
(auto-populated parsed JSON when `is_json` is true), `is_json`, `log_type` (1=STDOUT, 2=STDERR),
`ts`, `order_key` (set this to sort across sources, e.g. by transcript `timestamp`), `style`
(row styling), `correlation_id`. For transcript parsing, rely on `json_content` (each JSONL line is
already JSON) and surface fields like message type/role, text content, and tool calls as columns;
use `facets` to make `type`/`role`/tool-name filterable.

## Running locally

Logdy is a single Go binary; install per https://logdy.dev/docs. `bun run check` validates handler
*types*; correct *rendering* is still verified manually — run Logdy with the config against a real
transcript and confirm columns/filters look right. Useful flags: `--port`, `--ui-ip`, `--ui-pass`,
`--append-to-file` (persist to JSONL). Logdy auto-loads `logdy.config.json` from the working directory
(v0.17.0+), or load explicitly with `--config <path>`. Env-var equivalents (e.g. `LOGDY_CONFIG`) exist
for container/headless use.

## Conventions for this repo

- `src/*.ts` is the only place to edit logic; `logdy.config.json` is generated — regenerate with
  `bun run build`, never hand-edit it.
- Handlers stay self-contained (no runtime imports) — Logdy evals them in isolation.
