# v2 build — orchestrator decisions log

Records architectural decisions the orchestrator made when a spec was ambiguous, plus validated-gap
notes for phases that weren't dry-run-validated in the plan.

## Phase 3 — DuckDB analytics

### D-3.a — server spawn cwd / repoRoot (T-3.2)
**Problem:** `/api/stats` must `Bun.spawn(["bun","run","v2:analytics", …], {cwd: repoRoot})`, but
`createApp` only receives `db`, `webDir`, `dbPath` — there is no `repoRoot` in `AppOptions`, and the
stats test drives the app via `app.request(...)` (no `serve.ts`), so it can't rely on process.cwd().
`serve.ts` derives `webDir = resolve(import.meta.dir, "../../web")`, i.e. repoRoot =
`resolve(import.meta.dir, "../../..")` from `packages/server/src/`.
**Decision:** add optional `repoRoot?: string` to `AppOptions`; `createApp` defaults it to
`resolve(import.meta.dir, "../../..")`. `serve.ts` may pass it explicitly (same value). The stats
handler spawns with `cwd: repoRoot`. This keeps the server DuckDB-free (it only spawns the CLI) and
makes the test deterministic.
**Spec fix:** PHASE3 T-3.2 / CONTRACTS §6 — note `AppOptions.repoRoot?: string` (default
`resolve(import.meta.dir,"../../..")`); stats spawns with `cwd: repoRoot`.

### D-3.b — analytics test fixtures built via spawned ingest CLI (T-3.1, T-3.2, T-3.4)
**Problem:** ground rule #3 — a process linking `bun:sqlite` must never also load DuckDB's sqlite
extension. The analytics duck.test.ts must open DuckDB; if it also imported `@clogdy/ingest`
(`openDb`/`runIngest`, which use `bun:sqlite`) in the same process, that's a double SQLite link.
**Decision:** all analytics/stats/e2e fixtures are built by **spawning** the ingest CLI in a separate
process: `Bun.spawnSync(["bun","run","v2:ingest","--backfill","--root",tmpTree,"--db",tmpDb],{cwd:repoRoot})`,
THEN open DuckDB in the test process. Never `import { openDb } from "@clogdy/ingest"` in a file that
also loads DuckDB. (The server stats.test.ts / e2e-stats.test.ts use the server's bun:sqlite + spawn
DuckDB as a child — compliant; they too build the fixture DB via the spawned ingest CLI.)
**Spec fix:** already in PHASE3 T-3.1 note; reaffirm for T-3.2/T-3.4 — fixture DB = spawned ingest CLI.

### D-3.c — latency self-join filter application
**Problem:** PHASE3 says "Apply filters to `u`" for the latency metric. The shared `buildWhere`
emits bare column names (`tool = ?`, `kind = ?`), but the self-join references `u.tool`, `r.kind`,
etc. A bare `WHERE kind = ?` would be ambiguous across the two aliases.
**Decision:** the latency query's WHERE applies the ported filter to the `u` (tool_use) side with an
alias prefix. Port `buildWhere` to accept an optional table alias (e.g. `buildWhere(f, "u")` →
`u.tool = ?`), and the join already pins `u.kind='tool_use' AND r.kind='tool_result'`, so the
filter's own `kind` (if any) is dropped for this metric (a kind filter is meaningless for a
use↔result pair). toolCounts/errorRate/projectRollup/timeBuckets query a single `live.event` and use
the unaliased buildWhere.
**Spec fix:** PHASE3 T-3.1 latency bullet — buildWhere takes an alias; drop any `kind` filter for the
latency metric (the join pins both kinds).

### D-3.d — timeBuckets must use DuckDB floor-division `//`, NOT `/` (T-3.1, verified-bug)
**Problem:** PHASE3 T-3.1 timeBuckets bullet specifies `(ts/3600000)*3600000` and the inline comment
claimed "DuckDB integer division floors for positive ints". **That is false.** DuckDB's `/` is TRUE
division → returns DOUBLE, so `* 3600000` round-trips back to ~ts and every row lands in its own
bucket (the metric returns one bucket per event instead of hour-floored buckets). Verified directly:
`SELECT 1700000001500 / 3600000 * 3600000` → `1700000001500` (no floor); `//` → `1699999200000`
(correct hour floor, returns BIGINT).
**Decision:** timeBuckets SQL uses `(CAST(ts AS BIGINT) // 3600000) * 3600000 AS bucket`. The T-3.1
agent found and fixed this independently; verified by the orchestrator.
**Spec fix:** PHASE3 T-3.1 timeBuckets bullet — replace `/` with `//` (DuckDB floor-division); delete
the "integer division floors" claim. Anyone re-deriving the bucket SQL in T-3.3/T-3.4 must use `//`.

### D-3.e — analytics/e2e test fixtures need a trailing newline (T-3.1/T-3.4, tailer behavior)
**Problem:** the ingest offset-tailer (`packages/ingest/src/tailer.ts`, `text.lastIndexOf("\n")`)
delivers only complete lines up to the last `\n`; a final line WITHOUT a trailing newline is buffered
as a remainder and never delivered during backfill. A fixture built with `lines.join("\n")` silently
drops its last line. Real transcripts are append-only JSONL where every line ends with `\n`, so this
only bites synthetic test fixtures.
**Decision:** all synthetic transcript fixtures for analytics/stats/e2e tests MUST end with a trailing
`\n` (`lines.join("\n") + "\n"`). Not a shippable code change — a fixture-authoring rule.
**Spec fix:** PHASE3 T-3.1/T-3.4 test notes — fixtures end with a trailing newline (tailer withholds
an unterminated final line).

### D-3.f — toolCounts tie order is non-deterministic; assert order-insensitively (T-3.2/T-3.4)
**Problem:** `toolCounts` is `ORDER BY count DESC` — equal-count tools come back in arbitrary order, so
comparing the server's spawn output to a direct CLI spawn with order-sensitive `toEqual([...])` FLAKES
(observed: pass/fail alternating across runs). Same risk for any metric with ties (projectRollup,
latency).
**Decision:** stats/e2e tests that compare against a fixture compare order-insensitively for tie-prone
metrics — map `data` to a `{key→value}` object (e.g. `{tool→count}`) and `toEqual` that, or sort both
sides by a stable key first. The orchestrator applied this to T-3.2's toolCounts assertion.
**Spec fix:** PHASE3 T-3.2/T-3.4 test notes — assert tie-prone metric arrays order-insensitively.

### D-3.g — the obsolete `/api/stats → 501 stub` test must flip to 400 (T-3.2)
**Problem:** Phase-1/2 left a regression test `app.test.ts: "/api/stats → 501 stub"` asserting 501.
T-3.2 replaces the stub, so the full `bun test` goes red on that stale assertion (the per-task test run
doesn't catch it). `/api/stats` with no/invalid `metric` now returns **400** (the handler validates the
metric first).
**Decision:** the orchestrator updated that test to expect 400 (no/invalid metric → bad-metric 400).
A T-3.2 subagent restricted to "edit app.ts + add stats.test.ts" won't touch app.test.ts, so the
orchestrator owns this cross-cutting fixup.
**Spec fix:** PHASE3 T-3.2 — note that the pre-existing `app.test.ts` 501-stub assertion must be
updated to 400 as part of the task (or call it out as an orchestrator fixup).

### D-3.h — web Analytics view: no spec gaps; verified in a real browser (T-3.3)
**Problem/Note:** PHASE3 T-3.3 left the exact DOM/tab arrangement to the agent. No ambiguity bit. The
agent chose: a `#tabs` bar (`#tab-events`/`#tab-analytics`), the existing events table wrapped in
`#events-view`, and a sibling `<section id="analytics">`; the facet sidebar + filter chips stay across
tabs; `refreshAnalytics()` fetches all five metrics in parallel via `getStats(name, state.filter)` and
`load()` calls it on every filter change. All charts are dependency-free (divs + SVG, textContent only —
no XSS).
**Verification (orchestrator, Playwright over a live server on a known 6-event fixture):** tab toggle
works (analytics shown / events-view hidden); toolCounts barList Bash 2 / Read 1; errorRate gauge
"1 / 3 (33.3%)"; latency table Read 10/10/1, Bash 1000/1000/1; projectRollup myproj 6/3/1; timeBuckets
one spark bar. Clicking a `tool=Bash` facet correctly re-filtered the analytics (toolCounts → Bash 2
only; projectRollup → 6→2 events; errorRate → "no data", total=0). Only console error is a benign
`/favicon.ico` 404 (no favicon shipped) — not in the analytics path.
**Spec fix:** none needed; T-3.3 spec was sufficient. (Optional: ship a favicon to silence the 404.)

### D-3.i — e2e-stats latency expectation uses SINGLE pairs (crisp p50) (T-3.4)
**Problem:** PHASE3 T-3.4 floated a two-pair Bash case (gaps 1000+3000 → interpolated p50=2000), which
risks reconciling DuckDB's quantile_cont interpolation. The agent (correctly) chose the SINGLE-pair
form per metric: one Bash pair (gap 1000 → p50=p95=1000, n=1) and one Read pair (gap 10), plus a
second unmatched Bash tool_use and an orphan tool_result — so toolCounts has DISTINCT counts (Bash 2,
Read 1; no tie), errorRate is 3 results / 1 error = 1/3, projectRollup is 6/3/1, timeBuckets is one
bucket of 6. A filtered case (`project=other` → empty) proves the filter param flows
server→CLI→DuckDB. Ran 3× non-flaky.
**Spec fix:** PHASE3 T-3.4 — prefer single tool_use↔tool_result pairs for exact p50 (avoid two-point
quantile interpolation); use distinct tool counts so toolCounts ordering is deterministic.

## Phase 4 — Polish

### D-4.a — `resultLines` returns the structured array unconditionally (no v1 single-line collapse) (T-4.1)
**Problem:** v1's `resultColumn` had two HTML-render special cases — `total === 0` returned `{text:""}`
and a lone uncolored line returned plain text (no `<table>`). The T-4.1 port returns STRUCTURED data
(`Array<{text,color?}>`), so those collapses are presentation concerns that belong to the web caller,
not the data helper.
**Decision:** `resultLines({})` → `[]`; a single plain line → `[{text}]` (one entry, no `color` key).
The web's `resultCell` renders 0 lines as an empty `<td>` and 1+ lines as `.rline` divs — equivalent
output, cleaner contract. Recorded by the T-4.1 subagent; orchestrator confirms it's correct.

### D-4.b — web needs URL-param → filter parsing on init (added under T-4.2 to serve T-4.3) (T-4.2/T-4.3)
**Problem:** T-4.3's TUI handoff deep-links the v2 UI with `?project=…`/`?session=…`, but the web's
`state.filter` started `{}` and never read `location.search`, so a deep link rendered the full corpus.
The spec for T-4.3 assumed the web honored these params; nothing in Phases 1–3 implemented it.
**Decision:** T-4.2 adds `applyUrlFilter()` (parses `project/session/tool/kind/error/corr/q` from
`location.search` into `state.filter`, reflects `q` into the search box) called first in `init()`.
Verified live (Playwright): `?tool=Edit` scopes to the 2 Edit rows with a removable chip. This is the
minimal change that makes the documented T-4.3 deep-link work end-to-end.

### D-4.c — multi-select → single-filter limitation (NOT extending the API) (T-4.3)
**Problem:** the picker multi-selects sessions/projects, but `/api/events` accepts a SINGLE `project`
and a SINGLE `session` (not repeated/OR-combined). PHASE4 T-4.3's note flags this and permits, as a
follow-up, extending the API to accept repeated `session=` — but only if recorded here first.
**Decision:** do NOT extend the API in Phase 4. The `--v2` branch maps a collapsed selection to one
scope: single project/session maps directly; a multi/mixed selection opens scoped by the first project
(else first session). The limitation is accepted and documented; no repeated-param OR support added.
If multi-session scoping becomes important, it's a separate task (extend `EventFilter`/server/query
+ web URL parsing) — explicitly deferred, not done here.

### D-4.d — `bun build tui/picker.tsx` smoke fails pre-existingly (Ink devtools); tsc is the gate (T-4.3)
**Problem:** the suggested `bun build tui/picker.tsx --target=bun` smoke exits 1 because Ink optionally
imports `react-devtools-core`, which Bun's bundler can't resolve. This reproduces with the `--v2` edit
stashed, so it is NOT caused by T-4.3.
**Decision:** the authoritative parse/typecheck for the TUI is `bun run --filter '@clogdy/tui' check`
(tsc with the JSX tsconfig), which is green. The bundler smoke is not a valid gate for this package.
