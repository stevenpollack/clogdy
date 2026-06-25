import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { flattenLine } from "@clogdy/shared";
import { tail } from "./tailer";
import { makeWriter } from "./writer";

export interface RunIngestOptions {
  db: Database;
  root: string;
  mode: "backfill" | "watch";
  onProgress?: (n: number) => void;
}

/**
 * Tail → flatten → write, idempotent and resumable.
 *
 * - Loads existing cursors from `ingest_cursor` to resume at EOF.
 * - For each complete line the tailer delivers, flatten it into FlatEvents and
 *   buffer them via the writer; derive + upsert the line's session.
 * - After the pass, persist each touched file's cursor (size + inode) so a later
 *   `--watch` resumes at EOF.
 */
export async function runIngest(opts: RunIngestOptions): Promise<void> {
  const { db, root, mode, onProgress } = opts;

  // Resume cursors (path → byte offset).
  const cursors = new Map<string, number>();
  for (const r of db.query("SELECT path, offset FROM ingest_cursor").all() as {
    path: string;
    offset: number;
  }[]) {
    cursors.set(r.path, r.offset);
  }

  const writer = makeWriter(db);

  // Per-path line index (for uuid fallback `${sessionId}:${lineIndex}`).
  const lineIndex = new Map<string, number>();
  // Files we delivered lines from this run (so we can persist their cursors).
  const touched = new Set<string>();
  // Schema-drift counter.
  const skipped = new Map<string, number>();
  const onSkip = (t: string) => skipped.set(t, (skipped.get(t) ?? 0) + 1);

  const sink = (path: string, line: string): void => {
    touched.add(path);
    const idx = lineIndex.get(path) ?? 0;
    lineIndex.set(path, idx + 1);

    const events = flattenLine(line, idx, { onSkip });
    if (events.length === 0) return;
    writer.add(events);

    // Derive the session from the first event of a line that has a sessionId.
    const first = events[0]!;
    if (first.sessionId) {
      writer.upsertSession({
        sessionId: first.sessionId,
        project: first.project,
        cwd: first.cwd,
        path,
        ts: first.ts,
        gitBranch: first.gitBranch,
      });
    }
  };

  const persistCursors = (): void => {
    for (const path of touched) {
      try {
        const st = statSync(path);
        writer.setCursor(path, st.size, st.ino);
      } catch {
        // file vanished — skip cursor persistence
      }
    }
  };

  if (mode === "backfill") {
    await tail({ root, full: true, cursors }, sink, true);
    const inserted = writer.flush();
    persistCursors();
    onProgress?.(inserted);
    if (skipped.size > 0) {
      const summary = [...skipped.entries()].map(([k, v]) => `${k}=${v}`).join(", ");
      process.stderr.write(`skipped block types: ${summary}\n`);
    }
    return;
  }

  // mode === "watch": catch up via a backfill pass, then tail forever.
  await tail({ root, full: true, cursors }, sink, true);
  writer.flush();
  persistCursors();

  // Periodic flush + cursor persistence while watching.
  const interval = setInterval(() => {
    writer.flush();
    persistCursors();
  }, 500);
  // Best-effort cleanup if the process is interrupted.
  const stop = () => {
    clearInterval(interval);
    writer.flush();
    persistCursors();
  };
  process.once("SIGINT", () => {
    stop();
    process.exit(0);
  });

  await tail({ root, full: false, cursors }, sink); // polls forever
  stop();
}
