import type { Database } from "bun:sqlite";
import { join, normalize } from "node:path";
import { Hono } from "hono";
import type { EventFilter, EventKind } from "@clogdy/shared";
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
}

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

export function createApp(opts: AppOptions): Hono {
  const { db, webDir, dbPath } = opts;
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

  // Phase 2.
  app.get("/api/events/stream", (c) => c.json({ error: "not implemented" }, 501));
  // Phase 3.
  app.get("/api/stats", (c) => c.json({ error: "not implemented" }, 501));

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
