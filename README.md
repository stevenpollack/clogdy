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
| `project` | project name — basename of the line's `cwd` *(filterable)*                       |
| `session` | session id (short) — the transcript the line came from *(filterable)*            |
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
- **Follow every session at once** — stream all transcripts under `~/.claude/projects` into one view
  and facet on `project` / `session` to scope down (see [Follow all sessions](#follow-all-sessions)).
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

### Follow all sessions

To watch **every** project/session at once (the usual mode), use the bundled `follow` script instead of
naming a file. `logdy follow` only tails a fixed file list and never notices new session files, so the
script does the watching: it streams every `*.jsonl` under the root, tails appends, and picks up
new sessions as they're created. Run it from the repo root (so `logdy.config.json` auto-loads) via
Logdy's `stdin` subcommand, which runs the command and treats its stdout as the log source:

```bash
logdy stdin "bun run follow"            # tail all of ~/.claude/projects, live, from now on
logdy stdin "bun run follow -- --full"  # also replay existing history first
logdy stdin "bun run follow -- /some/other/projects/dir"
```

Then facet on `project` and `session` in the left panel to scope down to one repo or one conversation.
Files present at startup are treated as history (skipped unless `--full`); a session that appears
*while* following streams from its first line. Default root is `~/.claude/projects`.

> **`--full` replays a lot.** All of `~/.claude/projects` can be tens of thousands of lines streamed as
> one burst. Logdy's UI buffer (`maxMessages`, set to 100000 in this config) evicts by **arrival order**,
> so a small buffer would keep only the last files to stream in and silently drop earlier sessions —
> including your live one. If your history exceeds that, also raise Logdy's server buffer
> (`--max-message-count`, default 100000). For day-to-day use, omit `--full` and just tail.

### Pick sessions interactively

Don't know which session id you want? Browse them. `bun run picker` (alias `bun run tui`) opens a
terminal table of every transcript under `~/.claude/projects`, sorted by **last-message time**, so you
can see at a glance which conversations are fresh or stale and what project each belongs to. Multi-select
sessions (and/or whole projects), hit **enter**, and it hands off to Logdy streaming exactly that
selection — history replayed, then kept live.

```bash
bun run picker                 # browse ~/.claude/projects
bun run picker -- /other/dir   # a different root
```

| key | action |
| --- | --- |
| `↑`/`↓` (or `k`/`j`) | move the cursor |
| `space` | toggle the cursor's **session** |
| `p` | toggle every session of the cursor's **project** |
| `a` | select / deselect all |
| `s` | cycle sort: time → project → session |
| `r` | reverse sort direction |
| `enter` | stream the selection into Logdy |
| `q` / `Ctrl-C` | quit without streaming |

On `enter` the picker runs `logdy stdin "bun run follow -- --full …"` for you (collapsing a
fully-selected project to one `--projects <name>` token, else listing `--sessions <ids>`). **Each run
grabs a free port** (`--port`), so launching the picker again never collides with a Logdy you already
have open, and the new instance starts with a clean log store (Logdy's `localStorage` is keyed by
`host:port`). The chosen URL is printed on start. If `logdy` isn't on your `PATH`, the picker prints the
exact `logdy stdin --port <n> "…"` command instead of failing, so you can run it yourself.

The table header marks the active sort column in cyan with a `↓`/`↑` arrow; `s` moves which column you
sort by, `r` flips ascending/descending.

### Snapshot a slice of history

`follow.ts` is for *live* sessions. To look at **past** activity, use the `snapshot` script: it streams a
**bounded, time-sorted slice** of your transcripts so the browser can hold all of it and the
`project`/`session` facets are complete.

```bash
logdy stdin "bun run snapshot -- --project clogdy"     # one repo's history
logdy stdin "bun run snapshot -- --since 24h"          # everything in the last day
logdy stdin "bun run snapshot -- --session 630f4af6"   # one conversation (short id ok)
logdy stdin "bun run snapshot -- --last 3000"          # most-recent 3000 rows, all projects
```

| flag | meaning |
| --- | --- |
| `--project`, `-p <substr>` | keep rows whose project (basename of `cwd`) contains the substring |
| `--session`, `-s <prefix>` | keep rows whose `sessionId` starts with the prefix |
| `--projects <a,b,…>` | comma list of project substrings |
| `--sessions <id,id,…>` | comma list of session-id prefixes (what the picker emits) |
| `--since <when>` | keep rows at/after a duration ago (`30m`/`6h`/`7d`/`2w`) or an ISO date |
| `--last`, `-n <N>` | keep only the most recent N rows after filtering (**default 10000**) |
| `--all` | no row cap (pair with a filter; can be heavy) |
| `--delay <ms>` | wait before streaming, so you can open the browser first |
| `--pace <ms>` | sleep between bursts while streaming (default 0 = dump at once) |
| `--burst <N>` | rows per burst when pacing (default 500) |
| `<dir>` | root to scan (default `~/.claude/projects`) |

For **complete facets without scrolling**, pace the stream and open the browser during the delay — rows
then arrive live (Logdy pushes every row received while you're connected) instead of as one backlog dump
it only replays the tail of:

```bash
logdy stdin "bun run snapshot -- --since 24h --delay 3000 --pace 100 --burst 50"
# open http://localhost:8080 within the 3s delay; the slice streams in live, facets fill completely
```

**Why bounded, and why `stdin` not the REST API:** Logdy replays only ~100 rows to a connecting client
and facets over loaded rows only — it ["doesn't handle big files well"](https://logdy.dev/blog/post/working-with-big-log-files).
So a snapshot must be small enough to fully load (the default `--last 10000` cap, and the per-row note on
stderr, keep it honest). It's piped through Logdy's **stdin**, which renders; the REST `/api/log` buffer
exists but the UI does **not** display it. Only conversational rows (those the middleware keeps) are
emitted, so `--last N` ≈ N visible rows.

### Querying with the search bar

The search bar at the top of the UI ("powered by breser") filters rows with a small expression
language. It evaluates against the underlying message JSON exposed as `data` — the parsed transcript
line **plus the `_`-prefixed fields this config adds in the middleware**. So each column is reachable
through its backing field (the column *names* themselves are not addressable — only `data.<field>`):

| column    | query field             | example                          |
| --------- | ----------------------- | -------------------------------- |
| `project` | `data._project`         | `data._project == "clogdy"`      |
| `session` | `data._session`         | `data._session includes "630f"`  |
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
data._command includes "git"                          # any command mentioning git
data._tool == "Bash" and data._command includes "rm"  # Bash commands that run rm
data._tool == "Bash" and data._isError == true        # failed Bash commands
data._tool == "Edit" or data._tool == "Write"         # file writes
data._kind == "tool_use"                              # every tool call
```

Verified against Logdy **v0.17.1** — operators that work:

- `==` exact match; `includes` for substring (`data._command includes "git"`).
- Boolean combinators are the words `and` / `or`, **not** `&&` / `||`.
- Strings go in double quotes; booleans (`data._isError`) are unquoted `true` / `false`.

What does **not** work in this build: `&&` / `||`, and the string operators `contains`, `matches`, and
regex (`=~`) — use `includes` for substring matching. Bare text (no `data.<field>`) isn't a search
either. For common values, the **facet panel** on the left (click a `kind` / `tool` / `error` value) is
the quickest filter.

### ⚠️ Gotcha: duplicate rows after restarting Logdy

Logdy persists messages to the browser's `localStorage`, keyed by a **per-process** id. If you restart
Logdy (or switch transcripts) with the tab still open, the old rows linger alongside the new ones and
**every row appears twice**. This is a Logdy behavior, not the config. Fix: clear Logdy's logs (the
trash button in the UI) or run `localStorage.clear()` in the browser console, then reload.

## Development

| command         | what it does                                            |
| --------------- | ------------------------------------------------------ |
| `bun run check`    | `tsc --noEmit` — type-check                         |
| `bun test`         | unit tests for the handler logic                    |
| `bun run build`    | type-check, then regenerate `logdy.config.json`     |
| `bun run picker`   | interactive session picker → Logdy (see [Pick sessions interactively](#pick-sessions-interactively)) |
| `bun run follow`   | stream all sessions live (see [Follow all sessions](#follow-all-sessions)) |
| `bun run snapshot` | stream a bounded history slice (see [Snapshot a slice of history](#snapshot-a-slice-of-history)) |

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
