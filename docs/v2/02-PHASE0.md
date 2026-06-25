# Phase 0 — Scaffolding & contracts

Goal: stand up the five empty workspace packages with passing typecheck, and implement `@clogdy/shared`
(the types, the flatten port, the config util) that everything else depends on. Read
`00-ORCHESTRATION.md` (ground rules + layout) and `01-CONTRACTS.md` (§1, §3, §4, §9) before starting.

---

## T-0.1 — Monorepo scaffolding (PG0, solo — must finish before T-0.2/0.3)

**Goal:** create the five package dirs, wire workspaces + root scripts, every package typechecks empty.

**Files (create):**
- `packages/shared/package.json` — name `@clogdy/shared`, `private:true`, `"type":"module"`,
  `devDependencies: { "@types/bun":"^1.3.14" }`, scripts `{ "check":"tsc --noEmit" }`.
- `packages/shared/tsconfig.json` — `{ "extends":"../../tsconfig.json", "compilerOptions": { "noEmit": true }, "include": ["src"] }`.
- `packages/shared/src/index.ts` — re-exports (empty for now: `export {};`).
- `packages/ingest/package.json` — name `@clogdy/ingest`, deps `{ "@clogdy/shared":"file:../shared" }`, dev `@types/bun`, scripts `{ "check":"tsc --noEmit" }`, `"type":"module"`.
- `packages/ingest/tsconfig.json` — same shape as shared's.
- `packages/server/package.json` — name `@clogdy/server`, deps `{ "@clogdy/shared":"file:../shared", "hono":"^4.6.0" }`, dev `@types/bun`, scripts `{ "check":"tsc --noEmit" }`.
- `packages/server/tsconfig.json` — extends root; add `"lib":["ES2022","DOM"]` is NOT needed (server is Bun). Keep root lib.
- `packages/analytics/package.json` — name `@clogdy/analytics`, deps `{ "@clogdy/shared":"file:../shared", "@duckdb/node-api":"^1.2.0" }`, dev `@types/bun`, scripts `{ "check":"tsc --noEmit" }`.
- `packages/analytics/tsconfig.json` — extends root.
- `packages/web/package.json` — name `@clogdy/web`, deps `{ "@clogdy/shared":"file:../shared" }`, dev `@types/bun`, scripts `{ "check":"tsc --noEmit" }`.
- `packages/web/tsconfig.json` — extends root **plus** `"compilerOptions": { "lib":["ES2022","DOM","DOM.Iterable"] }` (browser code).
- Placeholder `src/index.ts` (`export {};`) in ingest/server/analytics; `packages/web/src/main.ts` (`export {};`).

**Wiring (edit root files):**
- Root `package.json`: set `"workspaces": ["tui", "packages/*"]`; add the `v2:*` scripts from
  CONTRACTS §9; change `"check"` to `"tsc --noEmit && bun run --filter '@clogdy/tui' check && bun run --filter '@clogdy/*' check"`.
- Run `bun install` so workspace symlinks resolve.
- **Do not** alter any v1 file, the existing `tui` package, or `logdy.config.json`.

**Tests:** none (scaffolding). 

**Acceptance (orchestrator runs):**
- `bun install` clean.
- `bun run check` → passes (root tsc + tui + all `@clogdy/*` packages, all empty/typecheck-clean).
- `bun test` → still 60 pass / 0 fail (v1 untouched).
- `git status` shows only new `packages/**` files + root `package.json`/`bun.lock` modified.

**Subagent prompt:** use the template in `00-ORCHESTRATION.md`, `<PHASE FILE>`=`02-PHASE0.md`,
`<T-ID>`=T-0.1, pasting this whole spec. Emphasize ground rule #8 (don't touch v1).

---

## T-0.2 — `@clogdy/shared`: types + flatten port + tests (PG1, needs 0.1)

**Goal:** the frozen types and the pure `flattenLine` port, fully unit-tested against real transcript
shapes.

**Files (create):**
- `packages/shared/src/types.ts` — paste CONTRACTS §1 verbatim (FlatEvent, EventKind, EventFilter,
  EventRow, FacetBucket, Facets).
- `packages/shared/src/flatten.ts` — implement `flattenLine`, `projectFromCwd`, `FlattenOptions` per
  CONTRACTS §3. Port the derivation from `src/middlewares/flatten.ts` (v1) **exactly**, changed to emit
  one event per content block. Pure; no imports except `./types`.
- `packages/shared/src/flatten.test.ts` — the tests below.
- Update `packages/shared/src/index.ts` to `export * from "./types"; export * from "./flatten"; export * from "./config";`
  (config added by T-0.3; if 0.3 not yet merged, omit that line and the orchestrator adds it when
  integrating — note this in your report).

**Spec details (must match v1 precedence exactly):**
- Drop rule: not valid JSON, or parsed value is null, or no `.message` → return `[]`.
- `command` primary-arg precedence: `input.command ?? input.file_path ?? input.url ?? input.query ?? input.path ?? input.pattern ?? (Object.keys(input).length ? JSON.stringify(input) : "")`.
- tool_result enrichment from line-level `toolUseResult` (object): structuredPatch→diff; stdout/stderr→result/stderr/(interrupted→resultHead "⚠ interrupted"); url+bytes→resultHead `[code,size,dur].filter(Boolean).join(" · ")` with size `<1024?`${b}B`:`${(b/1024).toFixed(1)}KB`` and dur `>=1000?`${(ms/1000).toFixed(1)}s`:`${ms}ms``; results[]/searchCount→`${n} results` + query clause.
- `isError`: for tool_result, `block.is_error === true` → true else false (never null for tool_result);
  null for all other kinds.
- `uuid` fallback when `line.uuid` absent: `` `${line.sessionId ?? "?"}:${lineIndex}` ``.
- Unknown block types (not tool_use/tool_result/text/thinking): skip + `opts.onSkip?.(block.type)`.
- `ts = Number.isNaN(Date.parse(timestamp)) ? 0 : Date.parse(timestamp)` (0 when missing/bad).

**Tests (`flatten.test.ts`, `bun:test`) — cover at minimum:**
1. Non-JSON line → `[]`. Line without `message` → `[]` (use a `file-history-snapshot` shape).
2. String content (`message.content:"hi"`) → one event `{kind:"prompt", text:"hi", blockIdx:0}`.
3. A line with `[{type:"text"},{type:"tool_use",...}]` → **two** events, kinds `["text","tool_use"]`,
   correct `blockIdx` 0 and 1, `tool`/`command`/`corr` set on the tool_use.
4. tool_use command precedence: input `{file_path:"/x"}`→command "/x"; `{foo:1}`→command `'{"foo":1}'`;
   `{}`→command "".
5. tool_result with `toolUseResult.structuredPatch` → `diff` joined with `\n`; with `{stdout,stderr}` →
   `result`=stdout, `stderr` set; with `{url,bytes:2048,code:200,durationMs:1500}` →
   `resultHead`="200 · 2.0KB · 1.5s"; with `{searchCount:3,query:"q"}` → resultHead `'3 results · "q"'`.
6. tool_result `is_error:true` → `isError:true`; a text block → `isError:null`.
7. `projectFromCwd("/home/u/repos/app/")` → "app"; `undefined` → "".
8. uuid fallback when `uuid` absent uses `sessionId:lineIndex`.
9. Unknown block type `{type:"image"}` → skipped, `onSkip` called with `"image"`.

**Acceptance:** `bun test packages/shared/src/flatten.test.ts` green (≥ the 9 cases); `bun run check` green.

**Subagent prompt:** template with this spec. Tell the agent to open `src/middlewares/flatten.ts` and
`src/transcript.ts` (v1) as the source of truth for derivation precedence, and to reproduce it exactly.

---

## T-0.3 — `@clogdy/shared`: config / data-dir util + tests (PG1, needs 0.1)

**Goal:** path resolution per CONTRACTS §4.

**Files (create):**
- `packages/shared/src/config.ts` — `resolvePaths`, `defaultDbPath`, `defaultRoot`, `Paths`.
  - `defaultDbPath()`: `process.env.CLOGDY_DB ?? join(process.env.XDG_DATA_HOME ?? join(homedir(),".local","share"), "clogdy", "clogdy.db")`.
  - `defaultRoot()`: `process.env.CLOGDY_ROOT ?? join(homedir(), ".claude", "projects")`.
  - `resolvePaths({db,root})`: prefer explicit arg → env → default; expand a leading `~` to `homedir()`.
    **Creates no directories** (callers mkdir).
- `packages/shared/src/config.test.ts`.

**Tests:** env override beats default; explicit arg beats env; `~/x` expands to `homedir()/x`; defaults
match the formulas above (set/unset env via a saved/restored `process.env`).

**Acceptance:** `bun test packages/shared/src/config.test.ts` green; `bun run check` green.

**Subagent prompt:** template with this spec.

**Integration note for orchestrator:** after 0.2 and 0.3 both merge, ensure
`packages/shared/src/index.ts` exports all three modules (`types`, `flatten`, `config`); fix if a
subagent left it partial. Commit Phase 0 as `feat(v2): scaffold workspaces + @clogdy/shared (types, flatten port, config)`.
