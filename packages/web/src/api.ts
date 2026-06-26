import type { EventFilter, EventRow, Facets } from "@clogdy/shared";

export function qs(filter: EventFilter): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(filter)) {
    if (v === undefined || v === null || v === "") continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

export async function getEvents(
  filter: EventFilter,
): Promise<{ events: EventRow[]; nextAfterId: number | null }> {
  const r = await fetch(`/api/events${qs(filter)}`);
  if (!r.ok) throw new Error(`getEvents ${r.status}`);
  return r.json();
}

export async function getFacets(filter: EventFilter): Promise<Facets> {
  const r = await fetch(`/api/facets${qs(filter)}`);
  if (!r.ok) throw new Error(`getFacets ${r.status}`);
  return r.json();
}

// `data` is the untyped per-metric JSON from the analytics CLI; the render site
// casts it to the concrete shape for the requested metric.
export interface Stats {
  metric: string;
  data: unknown;
}

export async function getStats(metric: string, filter: EventFilter): Promise<Stats> {
  const params = new URLSearchParams();
  params.set("metric", metric);
  for (const [k, v] of Object.entries(filter)) {
    if (v === undefined || v === null || v === "") continue;
    params.set(k, String(v));
  }
  const r = await fetch(`/api/stats?${params.toString()}`);
  if (!r.ok) throw new Error(`getStats ${metric} ${r.status}`);
  return (await r.json()) as Stats;
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
}

export async function postQuery(body: {
  sql: string;
  filter?: EventFilter;
  limit?: number;
}): Promise<QueryResult> {
  const r = await fetch("/api/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let msg = `POST /api/query ${r.status}`;
    try {
      const j = (await r.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return r.json() as Promise<QueryResult>;
}
