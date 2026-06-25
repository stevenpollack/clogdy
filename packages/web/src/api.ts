import type { EventFilter, EventRow, Facets } from "@clogdy/shared";

function qs(filter: EventFilter): string {
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
