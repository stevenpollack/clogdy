import React, { useCallback, useEffect, useReducer, useRef } from "react";
import type { EventFilter, EventRow, Facets } from "@clogdy/shared";
import { getEvents, getFacets } from "../api";
import { subscribe, mergeAppend, computeTiles } from "../live";
import { Tiles } from "./Tiles";
import { FacetSidebar } from "./FacetSidebar";
import { FilterBar } from "./FilterBar";
import { EventsTable } from "./EventsTable";
import { Drawer } from "./Drawer";
import { AnalyticsView } from "./AnalyticsView";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type View = "events" | "analytics";

interface AppState {
  filter: EventFilter;
  rows: EventRow[];
  nextAfterId: number | null;
  liveOn: boolean;
  view: View;
  drawer: EventRow | null;
  facets: Facets;
  tiles: { total: string; last5: string; errorRate: string; topTool: string };
  // q is tracked separately so we can seed it from URL
  qValue: string;
}

type Action =
  | { type: "SET_FILTER"; filter: EventFilter }
  | { type: "SET_ROWS"; rows: EventRow[]; nextAfterId: number | null }
  | { type: "APPEND_ROWS"; rows: EventRow[] }
  | { type: "SET_FACETS"; facets: Facets }
  | { type: "SET_TILES"; tiles: AppState["tiles"] }
  | { type: "TOGGLE_LIVE" }
  | { type: "SET_VIEW"; view: View }
  | { type: "OPEN_DRAWER"; event: EventRow }
  | { type: "CLOSE_DRAWER" }
  | { type: "SET_Q"; q: string };

const EMPTY_FACETS: Facets = {
  project: [],
  session: [],
  tool: [],
  kind: [],
  error: [],
};

function initState(): AppState {
  const sp = new URLSearchParams(location.search);
  const filter: EventFilter = {};
  let qValue = "";
  for (const k of ["project", "session", "tool", "kind", "error", "corr"]) {
    const v = sp.get(k);
    if (v) (filter as Record<string, string>)[k] = v;
  }
  const qParam = sp.get("q");
  if (qParam) {
    filter.q = qParam;
    qValue = qParam;
  }
  return {
    filter,
    rows: [],
    nextAfterId: null,
    liveOn: false,
    view: "events",
    drawer: null,
    facets: EMPTY_FACETS,
    tiles: { total: "—", last5: "—", errorRate: "—", topTool: "—" },
    qValue,
  };
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "SET_FILTER":
      return { ...state, filter: action.filter };
    case "SET_ROWS":
      return { ...state, rows: action.rows, nextAfterId: action.nextAfterId };
    case "APPEND_ROWS":
      return { ...state, rows: mergeAppend(state.rows, action.rows) };
    case "SET_FACETS":
      return { ...state, facets: action.facets };
    case "SET_TILES":
      return { ...state, tiles: action.tiles };
    case "TOGGLE_LIVE":
      return { ...state, liveOn: !state.liveOn };
    case "SET_VIEW":
      return { ...state, view: action.view };
    case "OPEN_DRAWER":
      return { ...state, drawer: action.event };
    case "CLOSE_DRAWER":
      return { ...state, drawer: null };
    case "SET_Q":
      return {
        ...state,
        filter: action.q
          ? { ...state.filter, q: action.q }
          : (({ q: _q, ...rest }) => rest)(state.filter as Record<string, string> & { q?: string }) as EventFilter,
        qValue: action.q,
      };
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function App(): React.ReactElement {
  const [state, dispatch] = useReducer(reducer, undefined, initState);
  const unsubRef = useRef<(() => void) | null>(null);
  const tileThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mainRef = useRef<HTMLElement>(null);

  // ---------------------------------------------------------------------------
  // Load data
  // ---------------------------------------------------------------------------

  const load = useCallback(
    async (filter: EventFilter): Promise<void> => {
      const [ev, facets] = await Promise.all([getEvents(filter), getFacets(filter)]);
      dispatch({ type: "SET_ROWS", rows: ev.events, nextAfterId: ev.nextAfterId });
      dispatch({ type: "SET_FACETS", facets });
      scheduleTileRefresh(filter);
    },
    [],
  );

  function scheduleTileRefresh(filter: EventFilter): void {
    if (tileThrottleRef.current !== null) return;
    tileThrottleRef.current = setTimeout(() => {
      tileThrottleRef.current = null;
      void refreshTiles(filter);
    }, 1000);
  }

  async function refreshTiles(filter: EventFilter): Promise<void> {
    const [facets, windowFacets] = await Promise.all([
      getFacets(filter),
      getFacets({ ...filter, since: Date.now() - 5 * 60 * 1000 }),
    ]);
    const windowCount = windowFacets.kind.reduce((s, b) => s + b.count, 0);
    const [total, last5, errorRate, topTool] = computeTiles(
      facets.kind,
      facets.error,
      facets.tool,
      windowCount,
    );
    dispatch({ type: "SET_TILES", tiles: { total, last5, errorRate, topTool } });
  }

  // ---------------------------------------------------------------------------
  // Live subscription
  // ---------------------------------------------------------------------------

  function stopLive(): void {
    if (unsubRef.current) {
      unsubRef.current();
      unsubRef.current = null;
    }
  }

  function startLive(filter: EventFilter, rows: EventRow[]): void {
    stopLive();
    const maxId = rows.length > 0 ? Math.max(...rows.map((r) => r.id)) : 0;
    unsubRef.current = subscribe(filter, maxId, (newRows) => {
      // Check scroll position before React re-renders
      const main = mainRef.current;
      const atBottom = main
        ? main.scrollHeight - main.scrollTop - main.clientHeight < 40
        : false;

      dispatch({ type: "APPEND_ROWS", rows: newRows });
      scheduleTileRefresh(filter);

      // Scroll to bottom if pinned — use requestAnimationFrame to run after render
      if (atBottom && main) {
        requestAnimationFrame(() => {
          if (mainRef.current) mainRef.current.scrollTop = mainRef.current.scrollHeight;
        });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Effects
  // ---------------------------------------------------------------------------

  // Initial load
  useEffect(() => {
    void load(state.filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopLive();
      if (tileThrottleRef.current !== null) clearTimeout(tileThrottleRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Click-outside closes drawer
  useEffect(() => {
    if (!state.drawer) return;
    function onClick(ev: MouseEvent): void {
      const drawerEl = document.getElementById("drawer");
      if (drawerEl && !drawerEl.contains(ev.target as Node)) {
        dispatch({ type: "CLOSE_DRAWER" });
      }
    }
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [state.drawer]);

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  function handleToggleFacet(key: keyof EventFilter, value: string): void {
    let newFilter: EventFilter;
    if (state.filter[key] === value) {
      const { [key]: _removed, ...rest } = state.filter as Record<string, unknown>;
      newFilter = rest as EventFilter;
    } else {
      newFilter = { ...state.filter, [key]: value };
    }
    dispatch({ type: "SET_FILTER", filter: newFilter });
    if (state.liveOn) startLive(newFilter, []);
    void load(newFilter);
  }

  function handleRemoveFilter(k: string): void {
    const newFilter = { ...state.filter } as Record<string, unknown>;
    delete newFilter[k];
    const f = newFilter as EventFilter;
    dispatch({ type: "SET_FILTER", filter: f });
    if (state.liveOn) startLive(f, []);
    void load(f);
  }

  function handleQChange(v: string): void {
    dispatch({ type: "SET_Q", q: v });
    const newFilter = v
      ? { ...state.filter, q: v }
      : (({ q: _q, ...rest }) => rest)(state.filter as Record<string, string> & { q?: string }) as EventFilter;
    if (state.liveOn) startLive(newFilter, []);
    void load(newFilter);
  }

  async function handleLoadMore(): Promise<void> {
    if (state.nextAfterId === null) return;
    const ev = await getEvents({ ...state.filter, afterId: state.nextAfterId });
    // loadMore replaces (matches original behavior)
    dispatch({ type: "SET_ROWS", rows: ev.events, nextAfterId: ev.nextAfterId });
  }

  function handleToggleLive(): void {
    const willBeOn = !state.liveOn;
    dispatch({ type: "TOGGLE_LIVE" });
    if (willBeOn) {
      startLive(state.filter, state.rows);
    } else {
      stopLive();
    }
  }

  function handleTabEvents(): void {
    dispatch({ type: "SET_VIEW", view: "events" });
  }

  function handleTabAnalytics(): void {
    dispatch({ type: "SET_VIEW", view: "analytics" });
  }

  function handleCorrFilter(corr: string): void {
    const newFilter = { ...state.filter, corr };
    dispatch({ type: "SET_FILTER", filter: newFilter });
    void load(newFilter);
  }

  const isAnalytics = state.view === "analytics";

  return (
    <div id="layout">
      <Tiles
        total={state.tiles.total}
        last5={state.tiles.last5}
        errorRate={state.tiles.errorRate}
        topTool={state.tiles.topTool}
      />
      <div id="body-row">
        <FacetSidebar
          facets={state.facets}
          filter={state.filter}
          onToggle={handleToggleFacet}
        />
        <main ref={mainRef}>
          <div id="tabs">
            <button
              id="tab-events"
              className={isAnalytics ? "tab" : "tab active"}
              onClick={handleTabEvents}
            >
              Events
            </button>
            <button
              id="tab-analytics"
              className={isAnalytics ? "tab active" : "tab"}
              onClick={handleTabAnalytics}
            >
              Analytics
            </button>
          </div>

          <FilterBar
            filter={state.filter}
            liveOn={state.liveOn}
            qValue={state.qValue}
            onQChange={handleQChange}
            onRemoveFilter={handleRemoveFilter}
            onToggleLive={handleToggleLive}
          />

          <div style={{ display: isAnalytics ? "none" : "" }}>
            <EventsTable
              rows={state.rows}
              nextAfterId={state.nextAfterId}
              onLoadMore={() => void handleLoadMore()}
              onRowClick={(e) => dispatch({ type: "OPEN_DRAWER", event: e })}
            />
          </div>

          <AnalyticsView filter={state.filter} visible={isAnalytics} />
        </main>
      </div>

      {state.drawer && (
        <Drawer
          event={state.drawer}
          onClose={() => dispatch({ type: "CLOSE_DRAWER" })}
          onCorrFilter={handleCorrFilter}
        />
      )}
    </div>
  );
}
