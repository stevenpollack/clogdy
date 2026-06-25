import type { EventFilter, EventRow, Facets } from "@clogdy/shared";
import { getEvents, getFacets } from "./api";

type FacetDim = keyof Facets; // project | session | tool | kind | error

const FACET_DIMS: FacetDim[] = ["project", "session", "tool", "kind", "error"];

const state: { filter: EventFilter; rows: EventRow[]; nextAfterId: number | null } = {
  filter: {},
  rows: [],
  nextAfterId: null,
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

async function load(): Promise<void> {
  renderChips();
  const [ev, facets] = await Promise.all([getEvents(state.filter), getFacets(state.filter)]);
  state.rows = ev.events;
  state.nextAfterId = ev.nextAfterId;
  renderFacets(facets);
  renderRows(false);
}

async function loadMore(): Promise<void> {
  if (state.nextAfterId === null) return;
  const ev = await getEvents({ ...state.filter, afterId: state.nextAfterId });
  state.rows = ev.events; // replace buffer with the new page
  state.nextAfterId = ev.nextAfterId;
  renderRows(true);
}

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
  void load();
}

init();
