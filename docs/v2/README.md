# clogdy v2 — build plan

Next iteration: a local tool to **investigate past** and **monitor current** Claude Code tool usage,
replacing the Logdy proof of concept. Architecture: JSONL (source of truth) → one ingester → **SQLite
(WAL)** live store → **DuckDB (read-only, separate process)** analytics → a small local web UI.

**To build it:** open **[`00-ORCHESTRATION.md`](./00-ORCHESTRATION.md)** — it's the entry point for an
Opus orchestrator driving Sonnet implementation agents. It links the frozen contracts
([`01-CONTRACTS.md`](./01-CONTRACTS.md)) and the per-phase task specs (`02-PHASE0.md` … `06-PHASE4.md`).
Background/rationale is in [`REFERENCE-design.md`](./REFERENCE-design.md).

Hand `00-ORCHESTRATION.md` to a fresh Opus instance and tell it to execute the plan — no extra prompting
needed.
