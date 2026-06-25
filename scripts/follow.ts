#!/usr/bin/env bun
/**
 * Stream every Claude Code transcript under a root directory to stdout — one raw
 * JSON event per line — tailing growth and picking up newly-created session
 * files. This is the "follow everything" front end: `logdy follow <files>` takes
 * a fixed file list and never notices new sessions, so we do the watching here.
 *
 * Pipe it into Logdy's UI via the `stdin` subcommand, which runs a command and
 * treats its stdout as the log source (so the repo's logdy.config.json — with the
 * project/session columns — auto-loads from the repo root):
 *
 *   logdy stdin "bun run follow"            # tail all projects, live, from now on
 *   logdy stdin "bun run follow -- --full"  # also replay existing history first
 *   logdy stdin "bun run follow -- /some/other/dir"
 *
 * Each emitted line is an unmodified transcript event; the `flatten` middleware
 * derives `_project`/`_session` from it, so the project and session columns can
 * facet across every session at once.
 *
 * Bun-only (Bun.Glob / Bun.file). Polling-based on purpose: simple and
 * cross-platform, no recursive fs.watch quirks. Transcripts are append-only, so a
 * tick is just stat + read-the-delta per file; a shrunk file (truncate/rotate)
 * resets to offset 0.
 */
import { homedir } from "node:os";
import { existsSync } from "node:fs";

const argv = process.argv.slice(2);
const full = argv.includes("--full");
const root = argv.find((a) => !a.startsWith("--")) ?? `${homedir()}/.claude/projects`;
const INTERVAL_MS = 500;

// Per-file read cursor (byte offset) and any partial, newline-less trailing text.
const offsets = new Map<string, number>();
const remainders = new Map<string, string>();
const sink = Bun.stdout.writer();

async function emitDelta(path: string): Promise<void> {
  const file = Bun.file(path);
  let size: number;
  try {
    size = file.size;
  } catch {
    return; // vanished between scan and read
  }

  let from = offsets.get(path) ?? 0;
  if (size < from) {
    from = 0; // truncated / rotated — re-read from the top
    remainders.delete(path);
  }
  if (size <= from) return;

  const chunk = await file.slice(from, size).text();
  offsets.set(path, size);

  const text = (remainders.get(path) ?? "") + chunk;
  const nl = text.lastIndexOf("\n");
  if (nl === -1) {
    remainders.set(path, text); // still no complete line — keep buffering
    return;
  }
  remainders.set(path, text.slice(nl + 1));

  for (const line of text.slice(0, nl).split("\n")) {
    if (line.length) sink.write(line + "\n");
  }
  await sink.flush();
}

async function tick(initial: boolean): Promise<void> {
  const seen = new Set<string>();
  for await (const path of new Bun.Glob("**/*.jsonl").scan({ cwd: root, absolute: true })) {
    seen.add(path);
    if (!offsets.has(path)) {
      // Files already present at startup are "history": without --full, skip to
      // their EOF and stream only future appends. A file that appears *later* is
      // a new session — always read it from the top, even without --full.
      if (initial && !full) {
        try {
          offsets.set(path, Bun.file(path).size);
        } catch {
          offsets.set(path, 0);
        }
        continue;
      }
      offsets.set(path, 0);
    }
    await emitDelta(path);
  }
  // Forget files that disappeared, so a recreated path re-reads from the start.
  for (const path of [...offsets.keys()]) {
    if (!seen.has(path)) {
      offsets.delete(path);
      remainders.delete(path);
    }
  }
}

if (!existsSync(root)) {
  process.stderr.write(`follow: root directory not found: ${root}\n`);
  process.exit(1);
}
process.stderr.write(`follow: ${full ? "replaying history + " : ""}tailing ${root}\n`);

let initial = true;
for (;;) {
  await tick(initial);
  initial = false;
  await Bun.sleep(INTERVAL_MS);
}
