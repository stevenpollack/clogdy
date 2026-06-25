#!/usr/bin/env bun
/**
 * Stream a BOUNDED, time-sorted slice of Claude transcripts to stdout, for a
 * point-in-time view in Logdy. This is the historical counterpart to follow.ts.
 *
 * Why bounded: Logdy replays only the last ~100 rows to a connecting client and
 * computes the facet panel over loaded rows only — it "doesn't handle big files
 * well" (logdy.dev). Dumping all of ~/.claude/projects (tens of thousands of
 * rows) leaves the browser showing a sliver. So pick a slice small enough that
 * the browser can hold/scroll all of it, and the project/session facets are then
 * complete. Feed it through Logdy's stdin (which DOES render, unlike the REST
 * /api/log buffer):
 *
 *   logdy stdin "bun run snapshot -- --project clogdy"
 *   logdy stdin "bun run snapshot -- --since 24h"
 *   logdy stdin "bun run snapshot -- --session 630f4af6 --all"
 *   logdy stdin "bun run snapshot -- --last 3000 /some/other/dir"
 *
 * Only conversational lines (those with a `message`, i.e. what the flatten
 * middleware keeps) are emitted, so --last N ≈ N visible rows. Original raw lines
 * are passed through unchanged for the middleware to flatten identically.
 *
 * Flags (all optional):
 *   --project, -p <substr>   keep rows whose project (basename of cwd) contains substr
 *   --session, -s <prefix>   keep rows whose sessionId starts with prefix (short id ok)
 *   --since        <when>    keep rows at/after a duration ago (30m/6h/7d/2w) or an ISO date
 *   --last, -n     <N>       keep only the most recent N rows after filtering (default 10000)
 *   --all                    no row cap (use with a filter; can be heavy)
 *   --delay        <ms>      wait this long before streaming, so you can open the
 *                            browser first (rows then arrive live → full facets)
 *   --pace         <ms>      sleep between bursts while streaming (default 0 = dump
 *                            instantly); paced rows arrive live and accumulate
 *   --burst        <N>       rows per burst when pacing (default 500)
 *   <dir>                    root to scan (default ~/.claude/projects)
 *
 * Live-delivery note: Logdy replays only ~100 backlog rows to a connecting client,
 * but pushes every row that arrives WHILE connected. So `--delay 3000 --pace 100`
 * + opening the browser during the delay makes the whole slice arrive live, and
 * the facet panel ends up complete without any scrolling.
 *
 * Bun-only (Bun.Glob / Bun.file). A normal CLI script — Date is available here
 * (unlike serialized handlers / workflow scripts).
 */
import { homedir } from "node:os";
import { existsSync } from "node:fs";

type Args = {
  root: string;
  project?: string;
  session?: string;
  since?: number;
  last: number;
  all: boolean;
  delay: number;
  pace: number;
  burst: number;
};

const die = (msg: string): never => {
  process.stderr.write(`snapshot: ${msg}\n`);
  process.exit(1);
};

/** Parse `--since`: a duration ago (e.g. 30m/6h/7d/2w) or an absolute date string. */
function parseSince(v: string): number {
  const m = v.match(/^(\d+)([smhdw])$/);
  if (m) {
    const unit = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 }[m[2]]!;
    return Date.now() - Number(m[1]) * unit;
  }
  const t = Date.parse(v);
  if (Number.isNaN(t)) die(`cannot parse --since "${v}" (use 30m/6h/7d/2w or an ISO date)`);
  return t;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    root: `${homedir()}/.claude/projects`,
    last: 10000,
    all: false,
    delay: 0,
    pace: 0,
    burst: 500,
  };
  let i = 0;
  const value = () => argv[++i] ?? die(`${argv[i - 1]} needs a value`);
  const num = (label: string) => {
    const n = Number.parseInt(value(), 10);
    if (Number.isNaN(n)) die(`${label} needs a number`);
    return n;
  };
  for (; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--project": case "-p": a.project = value().toLowerCase(); break;
      case "--session": case "-s": a.session = value().toLowerCase(); break;
      case "--since": a.since = parseSince(value()); break;
      case "--last": case "-n": a.last = num("--last"); break;
      case "--delay": a.delay = num("--delay"); break;
      case "--pace": a.pace = num("--pace"); break;
      case "--burst": a.burst = Math.max(1, num("--burst")); break;
      case "--all": a.all = true; break;
      default:
        if (arg.startsWith("-")) die(`unknown flag ${arg}`);
        a.root = arg;
    }
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (!existsSync(args.root)) die(`root directory not found: ${args.root}`);

type Row = { ts: number; raw: string };
const rows: Row[] = [];

for await (const path of new Bun.Glob("**/*.jsonl").scan({ cwd: args.root, absolute: true })) {
  const text = await Bun.file(path).text();
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    let j: any;
    try {
      j = JSON.parse(raw);
    } catch {
      continue;
    }
    if (j == null || j.message == null) continue; // conversational only (mirrors flatten's keep rule)

    if (args.project) {
      const proj =
        typeof j.cwd === "string" ? (j.cwd.replace(/\/+$/, "").split("/").pop() ?? "").toLowerCase() : "";
      if (!proj.includes(args.project)) continue;
    }
    if (args.session) {
      const sid = typeof j.sessionId === "string" ? j.sessionId.toLowerCase() : "";
      if (!sid.startsWith(args.session)) continue;
    }

    const ts = typeof j.timestamp === "string" ? Date.parse(j.timestamp) : Number.NaN;
    if (args.since !== undefined && (Number.isNaN(ts) || ts < args.since)) continue;

    rows.push({ ts: Number.isNaN(ts) ? 0 : ts, raw });
  }
}

rows.sort((a, b) => a.ts - b.ts); // chronological, so Logdy's order_key ordering matches
const uncapped = args.all || args.last <= 0;
const out = uncapped ? rows : rows.slice(-args.last);

const dropped = rows.length - out.length;
process.stderr.write(
  `snapshot: ${out.length} rows from ${args.root}` +
    (dropped > 0 ? ` (capped from ${rows.length}; ${dropped} older dropped — raise with --last N or --all)` : "") +
    (args.pace > 0 ? ` — streaming in bursts of ${args.burst} every ${args.pace}ms` : "") +
    (args.delay > 0 ? ` (after a ${args.delay}ms head start to open the browser)` : "") +
    "\n",
);

const sink = Bun.stdout.writer();
if (args.delay > 0) await Bun.sleep(args.delay); // let the browser connect first
for (let i = 0; i < out.length; i++) {
  sink.write(out[i].raw + "\n");
  // Pace bursts so rows arrive live (Logdy pushes them to a connected client),
  // instead of as one backlog dump it would only replay the tail of.
  if (args.pace > 0 && (i + 1) % args.burst === 0) {
    await sink.flush();
    await Bun.sleep(args.pace);
  }
}
await sink.flush();
