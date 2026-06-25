import type { EventFilter, EventRow, Facets } from "@clogdy/shared";
import { getEvents, getFacets, getStats } from "./api";
import { subscribe, mergeAppend, computeTiles } from "./live";
import { barList, sparkBars, gauge, table } from "./charts";

type FacetDim = keyof Facets; // project | session | tool | kind | error

const FACET_DIMS: FacetDim[] = ["project", "session", "tool", "kind", "error"];

const state: {
  filter: EventFilter;
  rows: EventRow[];
  nextAfterId: number | null;
  liveOn: boolean;
  unsub: (() => void) | null;
  tileThrottle: ReturnType<typeof setTimeout> | null;
  view: "events" | "analytics";
} = {
  filter: {},
  rows: [],
  nextAfterId: null,
  liveOn: false,
  unsub: null,
  tileThrottle: null,
  view: "events",
};

const $ = (id: string) => document.getElementById(id)!;

function trunc(s: string | null, n = 200): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function shortSession(s: string): string {
  return s.length > 8 ? s.slice(0, 8) : s;
}

/** Map a facet dimension to the EventFilter key it sets. */
function filterKey(dim: FacetDim): keyof EventFilter {
  return dim === "session" ? "session" : (dim as keyof EventFilter);
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

/** Schedule a tile refresh, throttled to at most once per ~1s. */
function scheduleTileRefresh(): void {
  if (state.tileThrottle !== null) return; // already scheduled
  state.tileThrottle = setTimeout(() => {
    state.tileThrottle = null;
    void refreshTiles();
  }, 1000);
}

async function refreshTiles(): Promise<void> {
  const [facets, windowFacets] = await Promise.all([
    getFacets(state.filter),
    getFacets({ ...state.filter, since: Date.now() - 5 * 60 * 1000 }),
  ]);
  const windowCount = windowFacets.kind.reduce((s, b) => s + b.count, 0);
  const [total, last5, errorRate, topTool] = computeTiles(
    facets.kind,
    facets.error,
    facets.tool,
    windowCount,
  );
  const tiles = $("tiles");
  (tiles.querySelector("[data-tile='total']") as HTMLElement).textContent = total;
  (tiles.querySelector("[data-tile='last5']") as HTMLElement).textContent = last5;
  (tiles.querySelector("[data-tile='errors']") as HTMLElement).textContent = errorRate;
  (tiles.querySelector("[data-tile='toptool']") as HTMLElement).textContent = topTool;
}

// ---------------------------------------------------------------------------
// Live subscription
// ---------------------------------------------------------------------------

function currentMaxId(): number {
  if (state.rows.length === 0) return 0;
  return Math.max(...state.rows.map((r) => r.id));
}

function startLive(): void {
  stopLive();
  const maxId = currentMaxId();
  state.unsub = subscribe(state.filter, maxId, onAppend);
}

function stopLive(): void {
  if (state.unsub) {
    state.unsub();
    state.unsub = null;
  }
}

function onAppend(rows: EventRow[]): void {
  state.rows = mergeAppend(state.rows, rows);

  // Check if the table container is pinned to the bottom BEFORE appending new rows.
  const main = document.querySelector("main") as HTMLElement;
  const atBottom = main.scrollHeight - main.scrollTop - main.clientHeight < 40;

  // Append the new TR elements to the table body.
  const body = $("rows");
  for (const e of rows) {
    const existing = body.querySelector(`[data-id="${e.id}"]`);
    if (!existing) body.appendChild(rowCells(e));
  }

  if (atBottom) main.scrollTop = main.scrollHeight;

  scheduleTileRefresh();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderFacets(facets: Facets): void {
  const el = $("facets");
  el.innerHTML = "";
  for (const dim of FACET_DIMS) {
    const h = document.createElement("h3");
    h.textContent = dim;
    el.appendChild(h);
    const key = filterKey(dim);
    const active = state.filter[key];
    for (const b of facets[dim]) {
      const row = document.createElement("div");
      row.className = "facet" + (active === b.value ? " active" : "");
      const label = dim === "session" ? shortSession(b.value) : b.value;
      const name = document.createElement("span");
      name.textContent = label || "(none)";
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = String(b.count);
      row.append(name, count);
      row.onclick = () => {
        if (active === b.value) delete (state.filter as Record<string, unknown>)[key];
        else (state.filter as Record<string, unknown>)[key] = b.value;
        load();
      };
      el.appendChild(row);
    }
  }
}

function renderChips(): void {
  const chips = $("chips");
  chips.innerHTML = "";
  for (const [k, v] of Object.entries(state.filter)) {
    if (k === "q" || v === undefined) continue;
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = `${k}: ${k === "session" ? shortSession(String(v)) : v} ✕`;
    chip.onclick = () => {
      delete (state.filter as Record<string, unknown>)[k];
      load();
    };
    chips.appendChild(chip);
  }
}

function rowCells(e: EventRow): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.dataset["id"] = String(e.id);
  const cells: Array<[string, boolean]> = [
    [e.project, false],
    [shortSession(e.sessionId), false],
    [e.ts ? new Date(e.ts).toLocaleString() : "", false],
    [e.kind, false],
    [e.tool ?? "", false],
    [trunc(e.command), false],
    [e.isError === true ? "ERROR" : "", true],
    [trunc(e.result), false],
    [trunc(e.text), false],
  ];
  for (const [text, isErrorCell] of cells) {
    const td = document.createElement("td");
    td.textContent = text;
    if (isErrorCell && text) td.className = "error";
    tr.appendChild(td);
  }
  return tr;
}

function renderRows(append: boolean): void {
  const body = $("rows");
  if (!append) body.innerHTML = "";
  for (const e of state.rows) body.appendChild(rowCells(e));
  const more = $("more") as HTMLButtonElement;
  more.style.display = state.nextAfterId === null ? "none" : "";
}

// ---------------------------------------------------------------------------
// Analytics view
// ---------------------------------------------------------------------------

// Per-metric data shapes (the analytics CLI's untyped JSON, cast at the read site).
interface ToolCount {
  tool: string;
  count: number;
}
interface ErrorRate {
  total: number;
  errors: number;
  rate: number;
}
interface Latency {
  tool: string;
  p50: number;
  p95: number;
  n: number;
}
interface ProjectRollup {
  project: string;
  events: number;
  tool_calls: number;
  errors: number;
}
interface TimeBucket {
  bucket: number;
  count: number;
}

/** Append an <h3> section header followed by a body node (or a "no data" note). */
function section(parent: HTMLElement, title: string, body: Element | null): void {
  const h = document.createElement("h3");
  h.textContent = title;
  parent.appendChild(h);
  if (body) {
    parent.appendChild(body);
  } else {
    const none = document.createElement("div");
    none.className = "no-data";
    none.textContent = "no data";
    parent.appendChild(none);
  }
}

async function refreshAnalytics(): Promise<void> {
  if (state.view !== "analytics") return;
  const [toolCounts, errorRate, latency, projectRollup, timeBuckets] = await Promise.all([
    getStats("toolCounts", state.filter),
    getStats("errorRate", state.filter),
    getStats("latency", state.filter),
    getStats("projectRollup", state.filter),
    getStats("timeBuckets", state.filter),
  ]);

  const root = $("analytics");
  root.innerHTML = "";

  // toolCounts → bar list
  const tc = toolCounts.data as ToolCount[];
  section(
    root,
    "Tool counts",
    tc.length > 0 ? barList(tc.map((t) => ({ label: t.tool, value: t.count }))) : null,
  );

  // errorRate → gauge + the errors/total (rate%) number
  const er = errorRate.data as ErrorRate;
  if (er && er.total > 0) {
    const wrap = document.createElement("div");
    wrap.appendChild(gauge(er.rate));
    const num = document.createElement("div");
    num.className = "gauge-number";
    num.textContent = `${er.errors} / ${er.total} (${(er.rate * 100).toFixed(1)}%)`;
    wrap.appendChild(num);
    section(root, "Error rate", wrap);
  } else {
    section(root, "Error rate", null);
  }

  // latency → table
  const lat = latency.data as Latency[];
  section(
    root,
    "Latency",
    lat.length > 0
      ? table(
          ["TOOL", "p50 ms", "p95 ms", "n"],
          lat.map((l) => [l.tool, String(l.p50), String(l.p95), String(l.n)]),
        )
      : null,
  );

  // projectRollup → table
  const pr = projectRollup.data as ProjectRollup[];
  section(
    root,
    "Project rollup",
    pr.length > 0
      ? table(
          ["PROJECT", "EVENTS", "TOOL_CALLS", "ERRORS"],
          pr.map((p) => [p.project, String(p.events), String(p.tool_calls), String(p.errors)]),
        )
      : null,
  );

  // timeBuckets → spark bars
  const tb = timeBuckets.data as TimeBucket[];
  section(
    root,
    "Events over time",
    tb.length > 0 ? sparkBars(tb.map((b) => ({ x: b.bucket, y: b.count }))) : null,
  );
}

/** Toggle which view region is visible and which tab button is active. */
function applyView(): void {
  const isAnalytics = state.view === "analytics";
  $("events-view").style.display = isAnalytics ? "none" : "";
  $("analytics").style.display = isAnalytics ? "" : "none";
  $("tab-events").classList.toggle("active", !isAnalytics);
  $("tab-analytics").classList.toggle("active", isAnalytics);
}

// ---------------------------------------------------------------------------
// Load / loadMore
// ---------------------------------------------------------------------------

async function load(): Promise<void> {
  renderChips();
  const [ev, facets] = await Promise.all([getEvents(state.filter), getFacets(state.filter)]);
  state.rows = ev.events;
  state.nextAfterId = ev.nextAfterId;
  renderFacets(facets);
  renderRows(false);

  // Resubscribe if live is on (new filter + new max id).
  if (state.liveOn) startLive();

  scheduleTileRefresh();

  // Keep the analytics view in sync with the active filter.
  if (state.view === "analytics") void refreshAnalytics();
}

async function loadMore(): Promise<void> {
  if (state.nextAfterId === null) return;
  const ev = await getEvents({ ...state.filter, afterId: state.nextAfterId });
  state.rows = ev.events; // replace buffer with the new page
  state.nextAfterId = ev.nextAfterId;
  renderRows(true);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init(): void {
  const q = $("q") as HTMLInputElement;
  let t: ReturnType<typeof setTimeout> | undefined;
  q.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => {
      const v = q.value.trim();
      if (v) state.filter.q = v;
      else delete state.filter.q;
      load();
    }, 250);
  });

  ($("more") as HTMLButtonElement).onclick = () => void loadMore();

  // Tab switching: toggle the visible region; analytics fetches on activation.
  ($("tab-events") as HTMLButtonElement).onclick = () => {
    state.view = "events";
    applyView();
  };
  ($("tab-analytics") as HTMLButtonElement).onclick = () => {
    state.view = "analytics";
    applyView();
    void refreshAnalytics();
  };

  // Live toggle button.
  const liveBtn = $("live-btn") as HTMLButtonElement;
  liveBtn.addEventListener("click", () => {
    state.liveOn = !state.liveOn;
    liveBtn.textContent = state.liveOn ? "Live ●" : "Live";
    liveBtn.classList.toggle("active", state.liveOn);
    if (state.liveOn) {
      startLive();
    } else {
      stopLive();
    }
  });

  void load();
}

init();
