# clogdy

A [Logdy](https://logdy.dev) configuration for **auditing Claude Code transcripts** — what tools and
commands Claude ran, their results, and the turn-by-turn flow — in a filterable web UI.

Logdy stores its column/middleware logic as JavaScript strings inside a JSON config, with no type
checking. This repo instead authors that logic as **type-checked, unit-tested TypeScript** and
generates `logdy.config.json` from it. The `.ts` files are the source of truth; the JSON is a build
artifact.

## What you get

A table view of a Claude transcript with these columns:

| column    | what it shows                                                                    |
| --------- | -------------------------------------------------------------------------------- |
| `time`    | `HH:MM:SS` of the event                                                          |
| `kind`    | `prompt` / `text` / `thinking` / `tool_use` / `tool_result` *(filterable)*       |
| `tool`    | tool name — `Bash`, `Edit`, `Read`, … *(filterable)*                             |
| `corr`    | link id shared by a tool call and its result; correlated cells are color-matched |
| `command` | the command / file / url / query the tool was invoked with                       |
| `error`   | `ERROR` (red) when a tool result failed *(filterable)*                            |
| `result`  | tool result output (truncated; full value in the row drawer)                     |
| `text`    | prompt / assistant text                                                          |
| `raw`     | the full raw JSONL line (parsed JSON in the drawer)                              |

Highlights:

- **Noise dropped** — non-conversational events (snapshots, mode changes, etc.) are filtered out.
- **Filter to tool calls** — facet on `tool` or `kind` to see exactly what Claude executed.
- **Call ↔ result linking** — `corr` cells for a `tool_use` and its `tool_result` share a color.
- **Composite commands** — Bash commands joined by `;` or newlines render as a table, one row per
  sub-command (`&&` / `||` / `|` stay on one line).

## Prerequisites

- [Logdy](https://logdy.dev/docs) (the `logdy` binary) — `brew install logdy` or see the docs.
- [Bun](https://bun.sh) — used as the package manager / test runner (not npm).

## Setup

```bash
bun install        # installs deps and activates the lefthook pre-commit hook
bun run build      # type-check + (re)generate logdy.config.json
```

`logdy.config.json` is committed, so if you only want to *use* it you can skip the build.

## Usage

Point Logdy at a Claude transcript with this config. Transcripts live under
`~/.claude/projects/<project-slug>/<session-id>.jsonl`.

```bash
logdy follow --full-read --config logdy.config.json \
  ~/.claude/projects/<slug>/<session-id>.jsonl
```

Then open the UI (default http://localhost:8080).

- `--full-read` is needed to load an existing/static file (plain `follow` only tails new lines).
- Logdy also auto-loads `logdy.config.json` from the current directory, so from this repo you can drop
  `--config`.
- To follow a **live** session, omit `--full-read`.

### Querying with the search bar

The search bar at the top of the UI ("powered by breser") filters rows with a small expression
language. It evaluates against the underlying message JSON exposed as `data` — the parsed transcript
line **plus the `_`-prefixed fields this config adds in the middleware**. So each column is reachable
through its backing field (the column *names* themselves are not addressable — only `data.<field>`):

| column    | query field             | example                          |
| --------- | ----------------------- | -------------------------------- |
| `kind`    | `data._kind`            | `data._kind == "tool_use"`       |
| `tool`    | `data._tool`            | `data._tool == "Bash"`           |
| `command` | `data._command`         | `data._command == "ls -la"`      |
| `error`   | `data._isError` (bool)  | `data._isError == true`          |
| `corr`    | `data._corr`            |                                  |
| `result`  | `data._result`          |                                  |
| `text`    | `data._text`            |                                  |
| `time`    | `data.timestamp`        |                                  |
| —         | `data._input`           | full tool input as JSON          |

Raw transcript fields are reachable too: `data.type`, `data.sessionId`, `data.cwd`, `data.gitBranch`,
`data.message`, etc. Combine conditions with `and` / `or`:

```text
data._tool == "Bash" and data._isError == true      # failed Bash commands
data._tool == "Edit" or data._tool == "Write"        # file writes
data._kind == "tool_use"                              # every tool call
```

Verified against Logdy **v0.17.1** — quirks to know:

- Boolean operators are the words `and` / `or`, **not** `&&` / `||`.
- Strings go in double quotes; booleans (`data._isError`) are unquoted `true` / `false`.
- This breser build matches **exact values only** — `contains`, `matches`, regex (`=~`), and bare
  substrings all return zero rows. You can pin an exact `tool` / `kind` / `error`, but you can't
  substring-search command text from the bar. For the common values, the **facet panel** on the left
  (click a `kind` / `tool` / `error` value) is the easier filter.

### ⚠️ Gotcha: duplicate rows after restarting Logdy

Logdy persists messages to the browser's `localStorage`, keyed by a **per-process** id. If you restart
Logdy (or switch transcripts) with the tab still open, the old rows linger alongside the new ones and
**every row appears twice**. This is a Logdy behavior, not the config. Fix: clear Logdy's logs (the
trash button in the UI) or run `localStorage.clear()` in the browser console, then reload.

## Development

| command         | what it does                                            |
| --------------- | ------------------------------------------------------ |
| `bun run check` | `tsc --noEmit` — type-check                            |
| `bun test`      | unit tests for the handler logic                       |
| `bun run build` | type-check, then regenerate `logdy.config.json`        |

A **lefthook** pre-commit hook runs `bun run check` and `bun test`, blocking commits that don't
type-check or pass tests.

### Adding columns or middlewares

1. Edit/add a handler in `src/columns/` or `src/middlewares/`. Handlers must be **self-contained** —
   Logdy serializes each one and evals it in isolation, so no imported runtime values (type-only
   imports are fine).
2. Register it in `src/index.ts` (order matters for columns).
3. `bun run build`, then commit both the `.ts` source and the regenerated `logdy.config.json`.

## How it works

- `src/logdy.ts` — Logdy's types (copied from the docs) plus this repo's authoring/config types.
- `src/transcript.ts` — types for a Claude transcript JSONL line.
- `src/middlewares/flatten.ts` — drops noise and flattens each line into `_`-prefixed fields.
- `src/columns/audit.ts` — the columns above; thin readers of those fields.
- `src/index.ts` / `src/config.ts` — the registry and envelope defaults.
- `scripts/build-config.ts` — serializes the handlers (via `Function.toString()`) into
  `logdy.config.json`.

See [CLAUDE.md](./CLAUDE.md) for the detailed architecture and design constraints.
