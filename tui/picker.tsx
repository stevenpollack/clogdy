#!/usr/bin/env bun
/**
 * Interactive session picker → Logdy. Browse every Claude Code transcript under
 * a root, sorted by last-message time, multi-select sessions (and/or whole
 * projects), then hand off to Logdy streaming exactly that selection — history
 * replayed (`--full`) and then kept live.
 *
 *   bun run picker                 # ~/.claude/projects
 *   bun run picker -- /other/dir
 *
 * Keys: ↑/↓ move · space select session · p select whole project · a all ·
 *       s sort (time/project/session) · r reverse · enter stream · q quit
 *
 * On `enter` the picker exec-hands-off to:
 *   logdy stdin "bun run follow -- --full [--projects …] [--sessions …]"
 * (or, if `logdy` isn't on PATH, prints that command instead of failing).
 *
 * Ink (React) renderer; a plain CLI script, so Date / spawn are available
 * (unlike serialized Logdy handlers).
 */
import { useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { collapseSelection, scanSessions, type SessionMeta } from "clogdy/sessions";

// The core (`clogdy`) package root, one level up from this TUI package. The
// handoff runs from here so `bun run follow` resolves the core script and Logdy
// auto-loads the core's logdy.config.json — regardless of the picker's own cwd.
const coreRoot = resolve(import.meta.dir, "..");

/**
 * An OS-assigned free port. Each picker run gets its own Logdy instance on its
 * own port — so a second run never collides with a running one, and (since
 * localStorage is keyed by origin) it also starts with a clean log store.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => resolve(typeof addr === "object" && addr ? addr.port : 0));
    });
  });
}

const root = process.argv.slice(2).find((a) => !a.startsWith("-")) ?? `${homedir()}/.claude/projects`;
if (!existsSync(root)) {
  process.stderr.write(`picker: root directory not found: ${root}\n`);
  process.exit(1);
}

type SortKey = "time" | "project" | "session";

function rel(ts: number, now: number): string {
  if (!ts) return "—";
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

const abs = (ts: number): string => (ts ? new Date(ts).toISOString().slice(0, 16).replace("T", " ") : "");
const pad = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));

function sortMetas(metas: SessionMeta[], key: SortKey, dir: number): SessionMeta[] {
  const cmp = (a: SessionMeta, b: SessionMeta): number => {
    if (key === "time") return a.lastTs - b.lastTs;
    if (key === "project") return a.project.localeCompare(b.project) || a.lastTs - b.lastTs;
    return a.sessionId.localeCompare(b.sessionId);
  };
  return [...metas].sort((a, b) => cmp(a, b) * dir);
}

/** Selection captured on `enter`; read after the Ink app unmounts. */
let chosen: Set<string> | null = null;

function App({ metas }: { metas: SessionMeta[] }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const now = useRef(Date.now()).current;

  const [sortKey, setSortKey] = useState<SortKey>("time");
  const [sortDir, setSortDir] = useState(-1); // newest first
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const rows = useMemo(() => sortMetas(metas, sortKey, sortDir), [metas, sortKey, sortDir]);
  // Each column's render width; min 9 leaves room for the "PROJECT ↓" sort marker.
  const projWidth = useMemo(() => Math.min(28, Math.max(9, ...metas.map((m) => m.project.length))), [metas]);
  const SESS_W = 9;
  const REL_W = 14;

  const viewport = Math.max(3, (stdout?.rows ?? 24) - 4);
  const start = Math.min(Math.max(0, cursor - Math.floor(viewport / 2)), Math.max(0, rows.length - viewport));
  const window = rows.slice(start, start + viewport);

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
    } else if (key.upArrow || input === "k") {
      setCursor((c) => (c > 0 ? c - 1 : rows.length - 1));
    } else if (key.downArrow || input === "j") {
      setCursor((c) => (c < rows.length - 1 ? c + 1 : 0));
    } else if (input === " ") {
      const id = rows[cursor]?.sessionId;
      if (id) setSelected((s) => toggle(s, [id]));
    } else if (input === "p") {
      const proj = rows[cursor]?.project;
      if (proj) setSelected((s) => toggle(s, rows.filter((r) => r.project === proj).map((r) => r.sessionId)));
    } else if (input === "a") {
      setSelected((s) => (s.size === rows.length ? new Set() : new Set(rows.map((r) => r.sessionId))));
    } else if (input === "s") {
      setSortKey((k) => (k === "time" ? "project" : k === "project" ? "session" : "time"));
    } else if (input === "r") {
      setSortDir((d) => -d);
    } else if (key.return) {
      if (selected.size > 0) chosen = new Set(selected);
      exit();
    }
  });

  const dirArrow = sortDir < 0 ? "↓" : "↑";
  const dirWord = sortDir < 0 ? "desc" : "asc";
  // A header cell: the active sort column is cyan and carries the direction arrow.
  const col = (label: string, key: SortKey, w: number) => (
    <Text bold color={sortKey === key ? "cyan" : undefined}>
      {pad(label + (sortKey === key ? " " + dirArrow : ""), w)}
    </Text>
  );
  return (
    <Box flexDirection="column">
      <Box>
        <Text>{"   "}</Text>
        {col("PROJECT", "project", projWidth)}
        <Text> </Text>
        {col("SESSION", "session", SESS_W)}
        <Text> </Text>
        {col("LAST MESSAGE", "time", REL_W)}
        <Text> </Text>
        <Text bold dimColor>
          WHEN
        </Text>
      </Box>
      {window.map((m) => {
        const i = rows.indexOf(m);
        const isCursor = i === cursor;
        const isSel = selected.has(m.sessionId);
        return (
          <Box key={m.path}>
            <Text inverse={isCursor} color={isSel ? "green" : undefined}>
              {isCursor ? "›" : " "}
              {isSel ? "◉" : "○"} {pad(m.project, projWidth)} {pad(m.sessionId.slice(0, 8), SESS_W)}{" "}
              {pad(rel(m.lastTs, now), REL_W)} <Text dimColor>{abs(m.lastTs)}</Text>
            </Text>
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text dimColor>
          {selected.size} selected · {rows.length} sessions · sort: {sortKey} {dirWord} {dirArrow} ·{" "}
          {start + 1}-{Math.min(start + viewport, rows.length)}/{rows.length}
        </Text>
      </Box>
      <Box>
        <Text dimColor>
          ↑/↓ move · space session · p project · a all · s sort col · r asc/desc · enter stream · q quit
        </Text>
      </Box>
    </Box>
  );
}

function toggle(set: Set<string>, ids: string[]): Set<string> {
  const next = new Set(set);
  const allOn = ids.every((id) => next.has(id));
  for (const id of ids) (allOn ? next.delete(id) : next.add(id));
  return next;
}

const metas = await scanSessions(root);
if (metas.length === 0) {
  process.stderr.write(`picker: no transcripts found under ${root}\n`);
  process.exit(1);
}

const { waitUntilExit } = render(<App metas={metas} />);
await waitUntilExit();

// `chosen` is mutated inside the Ink callback, invisible to control-flow analysis,
// so the assertion stops TS from narrowing it to the initial `null`.
const result = chosen as Set<string> | null;
if (!result || result.size === 0) process.exit(0);

const sel = collapseSelection(metas, result);
const parts = ["bun", "run", "follow", "--", "--full"];
if (sel.projects?.length) parts.push("--projects", sel.projects.join(","));
if (sel.sessions?.length) parts.push("--sessions", sel.sessions.join(","));
const cmd = parts.join(" ");

// A fresh port per run avoids colliding with an already-running Logdy and gives
// a clean localStorage (it's keyed by origin, i.e. host:port).
const port = await freePort();

const logdy = Bun.which("logdy");
if (!logdy) {
  process.stdout.write(
    `logdy not found on PATH. From ${coreRoot} run:\n  logdy stdin --port ${port} ${JSON.stringify(cmd)}\n`,
  );
  process.exit(0);
}

process.stderr.write(`picker: streaming ${result.size} session(s) → http://127.0.0.1:${port}\n`);
const proc = Bun.spawn([logdy, "stdin", "--port", String(port), cmd], {
  cwd: coreRoot,
  stdio: ["inherit", "inherit", "inherit"],
});
process.exit(await proc.exited);
