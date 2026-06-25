import type { EventFilter, EventRow, Facets } from "@clogdy/shared";
import { getEvents, getFacets, getStats } from "./api";
import { commandCell, resultCell } from "./cells";
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

/** Build a plain-text `<td>`; mark it as an error cell (red) when requested. */
function textTd(text: string, isError = false): HTMLTableCellElement {
  const td = document.createElement("td");
  td.textContent = text;
  if (isError && text) td.className = "error";
  return td;
}

function rowCells(e: EventRow): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.dataset["id"] = String(e.id);

  // Column order: PROJECT, SESSION, TIME, KIND, TOOL, COMMAND, ERROR, RESULT, TEXT.
  tr.appendChild(textTd(e.project));
  tr.appendChild(textTd(shortSession(e.sessionId)));
  tr.appendChild(textTd(e.ts ? new Date(e.ts).toLocaleString() : ""));
  tr.appendChild(textTd(e.kind));
  tr.appendChild(textTd(e.tool ?? ""));
  tr.appendChild(commandCell(e));
  tr.appendChild(textTd(e.isError === true ? "ERROR" : "", true));
  tr.appendChild(resultCell(e));
  tr.appendChild(textTd(trunc(e.text)));

  tr.onclick = (ev) => {
    // Stop the document-level "click outside → close" handler from firing for
    // this same click (it would otherwise close the drawer we just opened).
    ev.stopPropagation();
    openDrawer(e);
  };
  return tr;
}

// ---------------------------------------------------------------------------
// Row drawer
// ---------------------------------------------------------------------------

/** Append an <h4> label followed by a <pre> whose textContent is `body`. */
function drawerSection(parent: HTMLElement, label: string, body: string): void {
  const h = document.createElement("h4");
  h.textContent = label;
  parent.appendChild(h);
  const pre = document.createElement("pre");
  pre.textContent = body;
  parent.appendChild(pre);
}

function closeDrawer(): void {
  const drawer = $("drawer");
  drawer.style.display = "none";
  drawer.innerHTML = ""; // clearing only — no event data assigned to innerHTML
}

function openDrawer(e: EventRow): void {
  const drawer = $("drawer");
  drawer.innerHTML = ""; // clearing only — no event data assigned to innerHTML

  const close = document.createElement("span");
  close.className = "close";
  close.textContent = "✕";
  close.onclick = closeDrawer;
  drawer.appendChild(close);

  // Correlation id (clickable → filter to that corr).
  if (e.corr) {
    const corr = e.corr;
    const h = document.createElement("h4");
    h.textContent = "corr";
    drawer.appendChild(h);
    const link = document.createElement("span");
    link.className = "corr-link";
    link.textContent = corr;
    link.onclick = () => {
      state.filter.corr = corr;
      closeDrawer();
      void load();
    };
    drawer.appendChild(link);
  }

  // Pretty-printed raw JSON (fall back to the raw string on parse failure).
  let raw = e.raw;
  try {
    // JSON.parse is untyped; we only re-stringify it, so `unknown` is fine.
    const parsed: unknown = JSON.parse(e.raw);
    raw = JSON.stringify(parsed, null, 2);
  } catch {
    raw = e.raw;
  }
  drawerSection(drawer, "raw", raw);

  if (e.result) drawerSection(drawer, "result", e.result);
  if (e.text) drawerSection(drawer, "text", e.text);
  if (e.diff) drawerSection(drawer, "diff", e.diff);
  if (e.stderr) drawerSection(drawer, "stderr", e.stderr);

  drawer.style.display = "";
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

/** Seed `state.filter` from URL query params (the keys the server accepts). */
function applyUrlFilter(): void {
  const sp = new URLSearchParams(location.search);
  const f = state.filter as Record<string, string>;
  for (const k of ["project", "session", "tool", "kind", "error", "corr", "q"]) {
    const v = sp.get(k);
    if (v) f[k] = v;
  }
  // Reflect a `q` deep-link into the search box.
  if (state.filter.q) ($("q") as HTMLInputElement).value = state.filter.q;
}

function init(): void {
  applyUrlFilter();

  // Drawer dismissal: Esc, or click outside the drawer panel.
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeDrawer();
  });
  document.addEventListener("click", (ev) => {
    const drawer = $("drawer");
    if (drawer.style.display === "none") return;
    const target = ev.target as Node;
    if (!drawer.contains(target)) closeDrawer();
  });

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
