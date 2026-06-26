#!/usr/bin/env bun
import type { EventFilter } from "@clogdy/shared";
import { assertSelectOnly } from "@clogdy/shared";
import { buildQuery, isMetricName, runMetric, runQuery, withDuck } from "./duck";

interface MetricArgs {
  mode: "metric";
  db: string;
  metric: string;
  filters: EventFilter;
}

interface QueryArgs {
  mode: "query";
  db: string;
  sql: string;
  filters: EventFilter;
  limit?: number;
}

type Args = MetricArgs | QueryArgs;

function parseArgs(argv: string[]): Args {
  let db: string | undefined;
  let metric: string | undefined;
  let queryMode = false;
  let sql: string | undefined;
  let filters: EventFilter = {};
  let limit: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") {
      db = argv[++i];
    } else if (a === "--metric") {
      metric = argv[++i];
    } else if (a === "--query") {
      queryMode = true;
    } else if (a === "--sql") {
      sql = argv[++i];
    } else if (a === "--filters") {
      const raw = argv[++i] ?? "{}";
      filters = JSON.parse(raw) as EventFilter;
    } else if (a === "--limit") {
      const raw = argv[++i];
      limit = parseInt(raw ?? "", 10);
      if (isNaN(limit)) throw new Error(`--limit must be a number, got '${raw}'`);
    } else {
      throw new Error(`unknown arg ${a}`);
    }
  }

  if (!db) throw new Error("--db <sqlite-path> is required");

  if (queryMode) {
    if (!sql) throw new Error("--query mode requires --sql '<SELECT…>'");
    return { mode: "query", db, sql, filters, limit };
  } else {
    if (!metric) {
      throw new Error(
        "--metric must be one of toolCounts, errorRate, latency, projectRollup, timeBuckets (got none)",
      );
    }
    return { mode: "metric", db, metric, filters };
  }
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`v2:analytics: ${(e as Error).message}\n`);
    process.exit(1);
  }

  if (args.mode === "query") {
    // Clamp to [1, 5000]: a negative/zero cap would emit `LIMIT <=0` and make
    // runQuery's `slice(0, cap)` drop rows; a float would reach DuckDB as-is.
    const cap = Math.max(1, Math.min(Math.trunc(args.limit ?? 1000), 5000));

    // Guard before spawning DuckDB (instant feedback on obviously bad SQL).
    try {
      assertSelectOnly(args.sql);
    } catch (e) {
      process.stderr.write(`v2:analytics: ${(e as Error).message}\n`);
      process.exit(1);
    }

    try {
      const result = await withDuck(args.db, (conn) =>
        runQuery(conn, args.sql, args.filters, cap),
      );
      process.stdout.write(JSON.stringify(result));
      process.exit(0);
    } catch (e) {
      process.stderr.write(`v2:analytics: ${(e as Error).message}\n`);
      process.exit(1);
    }
  } else {
    // --metric mode (unchanged)
    if (!isMetricName(args.metric)) {
      process.stderr.write(
        `v2:analytics: --metric must be one of toolCounts, errorRate, latency, projectRollup, timeBuckets (got ${args.metric})\n`,
      );
      process.exit(1);
    }

    const metric = args.metric;
    try {
      const data = await withDuck(args.db, (conn) =>
        runMetric(conn, metric, args.filters),
      );
      process.stdout.write(JSON.stringify({ metric, data }));
      process.exit(0);
    } catch (e) {
      process.stderr.write(`v2:analytics: ${(e as Error).message}\n`);
      process.exit(1);
    }
  }
}

// Re-export buildQuery for potential external use; the guard is re-exported from @clogdy/shared.
export { buildQuery };

if (import.meta.main) {
  void main();
}
