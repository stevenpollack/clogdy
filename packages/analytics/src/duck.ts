import { DuckDBInstance } from "@duckdb/node-api";
import type { DuckDBConnection } from "@duckdb/node-api";
import type { EventFilter } from "@clogdy/shared";

/** Single-quote-escape a string for safe inlining into SQL ('… '' …'). */
function sq(v: string): string {
  return v.replace(/'/g, "''");
}

/**
 * Build a `WHERE …` clause from an EventFilter, column-mapped exactly like the
 * server's queries.ts buildConds. Values are single-quote-escaped and inlined
 * (the only string-valued fields are project/session/tool/kind/error/corr/q —
 * all escaped). Returns "" when no conditions apply.
 *
 * When `alias` is given (e.g. "u"), every column is prefixed: `u.tool = '…'`.
 * Ignores afterId/limit (irrelevant to analytics).
 */
export function buildWhere(f: EventFilter, alias?: string): { sql: string } {
  const p = alias ? `${alias}.` : "";
  const conds: string[] = [];

  if (f.project !== undefined) conds.push(`${p}project = '${sq(f.project)}'`);
  if (f.session !== undefined) conds.push(`${p}session_id = '${sq(f.session)}'`);
  if (f.tool !== undefined) conds.push(`${p}tool = '${sq(f.tool)}'`);
  if (f.kind !== undefined) conds.push(`${p}kind = '${sq(f.kind)}'`);
  if (f.error !== undefined) conds.push(`${p}is_error = ${f.error === "error" ? 1 : 0}`);
  if (f.corr !== undefined) conds.push(`${p}corr = '${sq(f.corr)}'`);
  if (f.since !== undefined) conds.push(`${p}ts >= ${Number(f.since)}`);
  if (f.until !== undefined) conds.push(`${p}ts < ${Number(f.until)}`);
  if (f.q !== undefined) {
    const like = `'%${sq(f.q)}%'`;
    conds.push(
      `(${p}command LIKE ${like} OR ${p}text LIKE ${like} OR ${p}result LIKE ${like})`,
    );
  }

  return { sql: conds.length === 0 ? "" : `WHERE ${conds.join(" AND ")}` };
}

/** Append an extra condition to a `WHERE …`/"" clause. */
function and(where: string, cond: string): string {
  return where === "" ? `WHERE ${cond}` : `${where} AND ${cond}`;
}

/** DuckDB COUNT/SUM come back as BigInt; coerce to a JS number. */
function num(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : Number(v ?? 0);
}

/**
 * Open an in-memory DuckDB, ATTACH the SQLite DB at `dbPath` READ_ONLY as `live`,
 * run `fn(conn)`, then always DETACH and close. READ_ONLY is non-negotiable.
 */
export async function withDuck<T>(
  dbPath: string,
  fn: (conn: DuckDBConnection) => Promise<T>,
): Promise<T> {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  let attached = false;
  try {
    await conn.run("INSTALL sqlite; LOAD sqlite;");
    await conn.run(`ATTACH '${sq(dbPath)}' AS live (TYPE sqlite, READ_ONLY);`);
    attached = true;
    return await fn(conn);
  } finally {
    if (attached) {
      try {
        await conn.run("DETACH live;");
      } catch {
        // best-effort detach
      }
    }
    conn.closeSync();
    instance.closeSync();
  }
}

/** Fetch result rows as plain objects (DuckDBValue values; cast at the call site). */
async function rows(
  conn: DuckDBConnection,
  sql: string,
): Promise<Record<string, unknown>[]> {
  const reader = await conn.runAndReadAll(sql);
  return reader.getRowObjects();
}

export async function toolCounts(
  conn: DuckDBConnection,
  filter: EventFilter,
): Promise<Array<{ tool: string; count: number }>> {
  const where = and(buildWhere(filter).sql, "tool IS NOT NULL");
  const sql = `SELECT tool, COUNT(*) c FROM live.event ${where} GROUP BY tool ORDER BY c DESC`;
  const data = await rows(conn, sql);
  return data.map((r) => ({ tool: String(r.tool), count: num(r.c) }));
}

export async function errorRate(
  conn: DuckDBConnection,
  filter: EventFilter,
): Promise<{ total: number; errors: number; rate: number }> {
  const where = and(buildWhere(filter).sql, "kind = 'tool_result'");
  const sql = `SELECT COUNT(*) total, COALESCE(SUM(is_error),0) errors FROM live.event ${where}`;
  const [r] = await rows(conn, sql);
  const total = num(r?.total);
  const errors = num(r?.errors);
  return { total, errors, rate: total === 0 ? 0 : errors / total };
}

export async function latency(
  conn: DuckDBConnection,
  filter: EventFilter,
): Promise<Array<{ tool: string; p50: number; p95: number; n: number }>> {
  // The join pins both kinds, so a `kind` filter is meaningless here — drop it
  // before building the u-side WHERE (D-3.c).
  const { kind: _kind, ...rest } = filter;
  const where = buildWhere(rest, "u").sql;
  const sql = `SELECT u.tool tool,
      quantile_cont(r.ts - u.ts, 0.5) p50,
      quantile_cont(r.ts - u.ts, 0.95) p95,
      COUNT(*) n
    FROM live.event u
    JOIN live.event r
      ON r.corr = u.corr AND u.kind = 'tool_use' AND r.kind = 'tool_result'
    ${where}
    GROUP BY u.tool
    ORDER BY n DESC`;
  const data = await rows(conn, sql);
  return data.map((r) => ({
    tool: String(r.tool),
    p50: Number(r.p50),
    p95: Number(r.p95),
    n: num(r.n),
  }));
}

export async function projectRollup(
  conn: DuckDBConnection,
  filter: EventFilter,
): Promise<Array<{ project: string; events: number; tool_calls: number; errors: number }>> {
  const where = buildWhere(filter).sql;
  const sql = `SELECT project,
      COUNT(*) events,
      SUM(CASE WHEN kind = 'tool_use' THEN 1 ELSE 0 END) tool_calls,
      COALESCE(SUM(is_error),0) errors
    FROM live.event ${where}
    GROUP BY project ORDER BY events DESC`;
  const data = await rows(conn, sql);
  return data.map((r) => ({
    project: String(r.project),
    events: num(r.events),
    tool_calls: num(r.tool_calls),
    errors: num(r.errors),
  }));
}

export async function timeBuckets(
  conn: DuckDBConnection,
  filter: EventFilter,
): Promise<Array<{ bucket: number; count: number }>> {
  const where = buildWhere(filter).sql;
  // Integer floor to the hour. NB: DuckDB's `/` is TRUE division (returns DOUBLE,
  // so `(ts/3600000)*3600000` round-trips back to ~ts and does NOT floor). The
  // floor-division operator is `//`, which on BIGINT floors and returns BIGINT.
  const sql = `SELECT (CAST(ts AS BIGINT) // 3600000) * 3600000 AS bucket, COUNT(*) count
    FROM live.event ${where}
    GROUP BY bucket ORDER BY bucket`;
  const data = await rows(conn, sql);
  return data.map((r) => ({ bucket: num(r.bucket), count: num(r.count) }));
}

/** The five metric names and their query functions. */
export const METRICS = {
  toolCounts,
  errorRate,
  latency,
  projectRollup,
  timeBuckets,
} as const;

export type MetricName = keyof typeof METRICS;

export function isMetricName(name: string): name is MetricName {
  return name in METRICS;
}

/** Dispatch a metric by name. */
export function runMetric(
  conn: DuckDBConnection,
  name: MetricName,
  filter: EventFilter,
): Promise<unknown> {
  return METRICS[name](conn, filter);
}
