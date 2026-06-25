#!/usr/bin/env bun
import type { EventFilter } from "@clogdy/shared";
import { isMetricName, runMetric, withDuck } from "./duck";

interface Args {
  db?: string;
  metric?: string;
  filters: EventFilter;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { filters: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") args.db = argv[++i];
    else if (a === "--metric") args.metric = argv[++i];
    else if (a === "--filters") {
      const raw = argv[++i] ?? "{}";
      args.filters = JSON.parse(raw) as EventFilter;
    } else {
      throw new Error(`unknown arg ${a}`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`v2:analytics: ${(e as Error).message}\n`);
    process.exit(1);
  }

  if (!args.db) {
    process.stderr.write("v2:analytics: --db <sqlite-path> is required\n");
    process.exit(1);
  }
  if (!args.metric || !isMetricName(args.metric)) {
    process.stderr.write(
      `v2:analytics: --metric must be one of toolCounts, errorRate, latency, projectRollup, timeBuckets (got ${args.metric ?? "none"})\n`,
    );
    process.exit(1);
  }

  const metric = args.metric;
  try {
    const data = await withDuck(args.db, (conn) => runMetric(conn, metric, args.filters));
    process.stdout.write(JSON.stringify({ metric, data }));
    process.exit(0);
  } catch (e) {
    process.stderr.write(`v2:analytics: ${(e as Error).message}\n`);
    process.exit(1);
  }
}

if (import.meta.main) {
  void main();
}
