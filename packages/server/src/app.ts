import type { Database } from "bun:sqlite";
import { join, normalize, resolve } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { assertSelectOnly, type EventFilter, type EventKind, type EventRow } from "@clogdy/shared";
import {
  expandSession,
  maxEventId,
  queryEvents,
  queryFacets,
} from "./queries";

export interface AppOptions {
  db: Database;
  webDir: string;
  dbPath?: string;
  repoRoot?: string;
}

/** The five metric names the analytics CLI accepts (CONTRACTS §6 / PHASE3 T-3.2). */
const STATS_METRICS = new Set([
  "toolCounts",
  "errorRate",
  "latency",
  "projectRollup",
  "timeBuckets",
]);

const KINDS = new Set<EventKind>(["prompt", "text", "thinking", "tool_use", "tool_result"]);

/** Parse a numeric query param; undefined if absent or NaN. Throws on a present-but-bad value. */
function numParam(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (Number.isNaN(n)) throw new BadParam(`bad numeric param: ${name}`);
  return n;
}

class BadParam extends Error {}

/** Build an EventFilter from query params. May throw BadParam. `session` is NOT yet expanded. */
function parseFilter(q: (k: string) => string | undefined): EventFilter {
  const f: EventFilter = {};
  const project = q("project");
  if (project !== undefined) f.project = project;
  const session = q("session");
  if (session !== undefined) f.session = session;
  const tool = q("tool");
  if (tool !== undefined) f.tool = tool;
  const kind = q("kind");
  if (kind !== undefined) {
    if (!KINDS.has(kind as EventKind)) throw new BadParam(`bad kind: ${kind}`);
    f.kind = kind as EventKind;
  }
  const error = q("error");
  if (error !== undefined) {
    if (error !== "error" && error !== "ok") throw new BadParam(`bad error: ${error}`);
    f.error = error;
  }
  const corr = q("corr");
  if (corr !== undefined) f.corr = corr;
  const since = numParam(q("since"), "since");
  if (since !== undefined) f.since = since;
  const until = numParam(q("until"), "until");
  if (until !== undefined) f.until = until;
  const qq = q("q");
  if (qq !== undefined) f.q = qq;
  const afterId = numParam(q("afterId"), "afterId");
  if (afterId !== undefined) f.afterId = afterId;
  const limit = numParam(q("limit"), "limit");
  if (limit !== undefined) f.limit = limit;
  return f;
}

const POLL_MS = 1000;
const PING_MS = 15_000;
const PAGE_SIZE = 500;

/**
 * Pure, synchronous poll: fetch events after `cursor` that match `filter`.
 * Returns the new rows and the advanced lastId (unchanged if no rows).
 */
export function pollNewEvents(
  db: Database,
  cursor: number,
  filter: EventFilter,
): { events: EventRow[]; lastId: number } {
  const { rows } = queryEvents(db, { ...filter, afterId: cursor, limit: PAGE_SIZE });
  const lastId = rows.length > 0 ? rows[rows.length - 1]!.id : cursor;
  return { events: rows, lastId };
}

export function createApp(opts: AppOptions): Hono {
  const { db, webDir, dbPath } = opts;
  const repoRoot = opts.repoRoot ?? resolve(import.meta.dir, "../../..");
  const app = new Hono();

  app.get("/healthz", (c) => {
    const events = (db.query("SELECT COUNT(*) c FROM event").get() as { c: number }).c;
    return c.json({ ok: true, dbPath, events, maxId: maxEventId(db) });
  });

  app.get("/api/events", (c) => {
    try {
      const f = parseFilter((k) => c.req.query(k));
      if (f.session !== undefined && f.session.length < 32) {
        const full = expandSession(db, f.session);
        if (full === null) return c.json({ events: [], nextAfterId: null });
        f.session = full;
      }
      const { rows, nextAfterId } = queryEvents(db, f);
      return c.json({ events: rows, nextAfterId });
    } catch (err) {
      if (err instanceof BadParam) return c.json({ error: err.message }, 400);
      return c.json({ error: String(err) }, 500);
    }
  });

  app.get("/api/facets", (c) => {
    try {
      const f = parseFilter((k) => c.req.query(k));
      if (f.session !== undefined && f.session.length < 32) {
        const full = expandSession(db, f.session);
        if (full === null) {
          return c.json({ project: [], session: [], tool: [], kind: [], error: [] });
        }
        f.session = full;
      }
      return c.json(queryFacets(db, f));
    } catch (err) {
      if (err instanceof BadParam) return c.json({ error: err.message }, 400);
      return c.json({ error: String(err) }, 500);
    }
  });

  // Phase 2 — SSE live stream.
  app.get("/api/events/stream", (c) => {
    let filter: EventFilter;
    try {
      filter = parseFilter((k) => c.req.query(k));
      // Expand short session ids the same way as /api/events.
      if (filter.session !== undefined && filter.session.length < 32) {
        const full = expandSession(db, filter.session);
        // Keep connection open with pings even when session not found; just no rows will match.
        if (full !== null) filter.session = full;
        else filter.session = "\x00"; // force no-match sentinel (no real session_id contains NUL)
      }
    } catch (err) {
      if (err instanceof BadParam) return c.json({ error: (err as Error).message }, 400);
      return c.json({ error: String(err) }, 500);
    }

    const lastIdParam = c.req.query("lastId");
    const initCursor =
      lastIdParam !== undefined ? Number(lastIdParam) : maxEventId(db);

    return streamSSE(c, async (stream) => {
      let cursor = Number.isNaN(initCursor) ? maxEventId(db) : initCursor;
      let lastPing = Date.now();

      stream.onAbort(() => {
        // No-op: stream.aborted is set automatically; the while loop will exit.
      });

      while (!stream.closed && !stream.aborted) {
        // Drain: poll until < PAGE_SIZE rows or abort.
        let sentAppend = false;
        let full = true;
        while (full && !stream.closed && !stream.aborted) {
          const { events, lastId } = pollNewEvents(db, cursor, filter);
          full = events.length === PAGE_SIZE;
          if (events.length > 0) {
            cursor = lastId;
            sentAppend = true;
            await stream.writeSSE({
              event: "append",
              data: JSON.stringify({ events, lastId }),
            });
          } else {
            full = false; // break the drain loop
          }
        }

        // Send a ping if idle long enough and we didn't just send an append.
        const now = Date.now();
        if (!sentAppend && now - lastPing >= PING_MS) {
          await stream.writeSSE({ event: "ping", data: "{}" });
          lastPing = now;
        } else if (sentAppend) {
          lastPing = now;
        }

        if (!stream.closed && !stream.aborted) {
          await stream.sleep(POLL_MS);
        }
      }
    });
  });
  // Phase 3 — analytics proxy. Spawns the DuckDB CLI in a child process so the
  // server process never links DuckDB (ground rule #3).
  app.get("/api/stats", async (c) => {
    const metric = c.req.query("metric");
    if (metric === undefined || !STATS_METRICS.has(metric)) {
      return c.json({ error: "bad metric" }, 400);
    }

    let f: EventFilter;
    try {
      f = parseFilter((k) => c.req.query(k));
    } catch (err) {
      if (err instanceof BadParam) return c.json({ error: err.message }, 400);
      return c.json({ error: String(err) }, 500);
    }
    // Mirror /api/events session expansion: expand short ids; if not found leave
    // the short value as-is (it simply won't match → empty/zero metric). No 404.
    if (f.session !== undefined && f.session.length < 32) {
      const full = expandSession(db, f.session);
      if (full !== null) f.session = full;
    }

    if (dbPath === undefined) {
      return c.json({ error: "dbPath not configured" }, 500);
    }

    const proc = Bun.spawn(
      [
        "bun",
        "run",
        "v2:analytics",
        "--",
        "--db",
        dbPath,
        "--metric",
        metric,
        "--filters",
        JSON.stringify(f),
      ],
      { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
    );

    const TIMEOUT_MS = 20_000;
    const timed = await Promise.race([
      proc.exited.then(() => "done" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), TIMEOUT_MS)),
    ]);
    if (timed === "timeout") {
      proc.kill();
      return c.json({ error: "analytics timed out" }, 504);
    }

    const code = proc.exitCode;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    if (code !== 0) {
      return c.json({ error: stderr.trim() || "analytics failed" }, 500);
    }
    try {
      const json = JSON.parse(stdout);
      return c.json(json);
    } catch {
      return c.json({ error: "bad analytics output" }, 500);
    }
  });

  // Phase 5 — SQL query proxy. Wraps the user's SQL in a facet-scoped CTE and
  // spawns the analytics CLI in --query mode. No DuckDB in this process (ground rule #3).
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  app.post("/api/query", async (c) => {
    // Parse JSON body.
    let rawBody: Record<string, unknown>;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    const sql = rawBody.sql;
    if (typeof sql !== "string") {
      return c.json({ error: "sql must be a string" }, 400);
    }

    const rawLimit = rawBody.limit;
    const limitNum =
      typeof rawLimit === "number" && !Number.isNaN(rawLimit) ? rawLimit : undefined;

    // Parse filter from the body object using the same parseFilter machinery as
    // query params — convert each value to string for the shared validator.
    const rawFilter =
      rawBody.filter !== null && typeof rawBody.filter === "object"
        ? (rawBody.filter as Record<string, unknown>)
        : {};
    let f: EventFilter;
    try {
      f = parseFilter((k) => {
        const v = rawFilter[k];
        return v === undefined || v === null ? undefined : String(v);
      });
    } catch (err) {
      if (err instanceof BadParam) return c.json({ error: (err as Error).message }, 400);
      return c.json({ error: String(err) }, 500);
    }

    // Expand a short session id (mirrors /api/events and /api/stats).
    if (f.session !== undefined && f.session.length < 32) {
      const full = expandSession(db, f.session);
      if (full !== null) f.session = full;
    }

    // Guard sql before spawning — instant 400, no subprocess cost.
    try {
      assertSelectOnly(sql);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }

    if (dbPath === undefined) {
      return c.json({ error: "dbPath not configured" }, 500);
    }

    const proc = Bun.spawn(
      [
        "bun", "run", "v2:analytics", "--",
        "--db", dbPath,
        "--query",
        "--sql", sql,
        "--filters", JSON.stringify(f),
        "--limit", String(limitNum ?? 1000),
      ],
      { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
    );

    const QUERY_TIMEOUT_MS = 10_000;
    const timed = await Promise.race([
      proc.exited.then(() => "done" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), QUERY_TIMEOUT_MS)),
    ]);
    if (timed === "timeout") {
      proc.kill();
      return c.json({ error: "query timed out" }, 504);
    }

    const code = proc.exitCode;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    if (code !== 0) {
      return c.json({ error: stderr.trim() || "query failed" }, 500);
    }
    try {
      const result = JSON.parse(stdout);
      return c.json(result);
    } catch {
      return c.json({ error: "bad query output" }, 500);
    }
  });

  // Static assets: `/` → index.html, anything else → file under webDir. 404 if missing.
  app.get("/*", async (c) => {
    const url = new URL(c.req.url);
    let path = decodeURIComponent(url.pathname);
    if (path === "/") path = "/index.html";
    // Prevent path traversal: normalize and reject anything escaping webDir.
    const rel = normalize(path).replace(/^(\.\.(\/|\\|$))+/, "");
    const full = join(webDir, rel);
    if (!full.startsWith(webDir)) return c.json({ error: "forbidden" }, 403);
    const file = Bun.file(full);
    if (!(await file.exists())) return c.json({ error: "not found" }, 404);
    return new Response(file);
  });

  return app;
}
