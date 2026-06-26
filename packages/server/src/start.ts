#!/usr/bin/env bun
// Single entry point for clogdy v2: ensure the web bundle and SQLite DB exist,
// start the live ingester (the writer), then serve the app. Replaces the
// three-step `v2:web:build` + `v2:ingest --backfill` + `v2:serve` dance.
//
// Each stage runs as its own child process via Bun.spawn, so the ground rule
// "SQLite is linked once per process" holds: the ingester child writes via
// bun:sqlite, the server child reads via bun:sqlite, and neither loads DuckDB.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolvePaths } from "@clogdy/shared";

const argv = process.argv.slice(2);
const has = (flag: string): boolean => argv.includes(flag);
const noWatch = has("--no-watch");
const reset = has("--reset");
const forceBuild = has("--build");
if (has("--help") || has("-h")) {
  process.stdout.write(
    `clogdy — investigate & monitor Claude Code tool usage\n\n` +
      `Usage: bun start [options]   (alias: bun run v2)\n\n` +
      `  --reset      rebuild the DB from scratch before serving\n` +
      `  --no-watch   don't tail for new transcripts (serve a static snapshot)\n` +
      `  --build      force-rebuild the web bundle even if present\n` +
      `  --help       show this help\n\n` +
      `Env: CLOGDY_DB, CLOGDY_ROOT, CLOGDY_PORT (default 7331)\n`,
  );
  process.exit(0);
}

const repoRoot = resolve(import.meta.dir, "../../..");
const paths = resolvePaths({});
const port = Number(process.env.CLOGDY_PORT ?? 7331);
const webDistMain = resolve(import.meta.dir, "../../web/dist/main.js");
const log = (msg: string): void => {
  process.stdout.write(`clogdy ▸ ${msg}\n`);
};

/** Run a child to completion, inheriting stdio; exit the launcher on failure. */
function runToEnd(label: string, cmd: string[]): void {
  const { exitCode } = Bun.spawnSync(cmd, {
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (exitCode !== 0) {
    process.stderr.write(`clogdy ▸ ${label} failed (exit ${exitCode})\n`);
    process.exit(exitCode ?? 1);
  }
}

const ingestCli = "packages/ingest/src/cli.ts";

// 1. Build the web bundle if it's missing (or forced).
if (forceBuild || !existsSync(webDistMain)) {
  log("building web assets…");
  runToEnd("web build", ["bun", "run", "packages/web/build.ts"]);
}

// 2. Ensure the DB. With the watcher on, its catch-up pass populates the DB, so
//    we only need to gate the server on the file existing. With --no-watch there
//    is no writer, so backfill synchronously here.
const dbMissing = !existsSync(paths.db);
if (noWatch && (reset || dbMissing)) {
  log(`ingesting transcripts from ${paths.root}…`);
  const cmd = ["bun", "run", ingestCli, "--backfill"];
  if (reset) cmd.push("--reset");
  runToEnd("ingest", cmd);
}

// 3. Live ingester (writer) — catches up, then tails for new sessions.
let watcher: ReturnType<typeof Bun.spawn> | null = null;
if (!noWatch) {
  log("starting live ingester (watching for new transcripts)…");
  const cmd = ["bun", "run", ingestCli, "--watch"];
  if (reset) cmd.push("--reset");
  watcher = Bun.spawn(cmd, { cwd: repoRoot, stdout: "inherit", stderr: "inherit" });

  // The server opens the DB read-only at startup and throws if the file is
  // absent, so wait for the watcher to create it (openDb writes the schema
  // synchronously on start) before serving.
  const deadline = Date.now() + 30_000;
  while (!existsSync(paths.db)) {
    if (Date.now() > deadline) {
      process.stderr.write("clogdy ▸ timed out waiting for the DB to be created\n");
      watcher.kill();
      process.exit(1);
    }
    await Bun.sleep(50);
  }
}

// 4. Serve (reader). Inherit stdio so its "→ http://localhost:PORT" line shows.
const server = Bun.spawn(["bun", "run", "packages/server/src/serve.ts"], {
  cwd: repoRoot,
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
});

log(`open http://localhost:${port}`);

let shuttingDown = false;
const shutdown = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  watcher?.kill();
  server.kill();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Tie the three lifetimes together: if the server exits, stop the watcher; if the
// watcher dies unexpectedly, stop the server.
await Promise.race([server.exited, watcher ? watcher.exited : new Promise(() => {})]);
shutdown();
process.exit(0);
