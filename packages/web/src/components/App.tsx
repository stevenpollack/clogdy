import React, { useCallback, useEffect, useReducer, useRef } from "react";
import type { EventFilter, EventRow, Facets } from "@clogdy/shared";
import { getEvents, getFacets, postQuery } from "../api";
import type { QueryResult } from "../api";
import { subscribe, mergeAppend, computeTiles } from "../live";
import { Tiles } from "./Tiles";
import { FacetSidebar } from "./FacetSidebar";
import { FilterBar } from "./FilterBar";
import { EventsTable } from "./EventsTable";
import { Drawer } from "./Drawer";
import { AnalyticsView } from "./AnalyticsView";
import SqlEditor from "./SqlEditor";
import QueryResultGrid from "./QueryResultGrid";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SQL_LIMIT = 1000;

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
  sqlActive: boolean;
  sqlText: string;
  sqlResult: QueryResult | null;
  sqlError: string | null;
}

type Action =
  | { type: "SET_FILTER"; filter: EventFilter }
  | { type: "SET_ROWS"; rows: EventRow[]; nextAfterId: number | null }
  | { type: "APPEND_ROWS"; rows: EventRow[]; nextAfterId?: number | null }
  | { type: "SET_FACETS"; facets: Facets }
  | { type: "SET_TILES"; tiles: AppState["tiles"] }
  | { type: "TOGGLE_LIVE" }
  | { type: "SET_VIEW"; view: View }
  | { type: "OPEN_DRAWER"; event: EventRow }
  | { type: "CLOSE_DRAWER" }
  | { type: "SET_Q"; q: string }
  | { type: "ENTER_SQL" }
  | { type: "EXIT_SQL" }
  | { type: "SET_SQL_TEXT"; sql: string }
  | { type: "SET_SQL_RESULT"; result: QueryResult }
  | { type: "SET_SQL_ERROR"; error: string };

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
  const sqlParam = sp.get("sql");
  const sqlText = sqlParam ? decodeURIComponent(sqlParam) : "";
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
    sqlActive: !!sqlText,
    sqlText,
    sqlResult: null,
    sqlError: null,
  };
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "SET_FILTER":
      return { ...state, filter: action.filter };
    case "SET_ROWS":
      return { ...state, rows: action.rows, nextAfterId: action.nextAfterId };
    case "APPEND_ROWS":
      return {
        ...state,
        rows: mergeAppend(state.rows, action.rows),
        // keyset paging: update cursor when provided (SSE appends omit it)
        ...(action.nextAfterId !== undefined
          ? { nextAfterId: action.nextAfterId }
          : {}),
      };
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
    case "ENTER_SQL":
      return { ...state, sqlActive: true };
    case "EXIT_SQL":
      return { ...state, sqlActive: false, sqlText: "", sqlResult: null, sqlError: null };
    case "SET_SQL_TEXT":
      return { ...state, sqlText: action.sql };
    case "SET_SQL_RESULT":
      return { ...state, sqlResult: action.result, sqlError: null };
    case "SET_SQL_ERROR":
      return { ...state, sqlError: action.error };
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// SqlBanner
// ---------------------------------------------------------------------------

function SqlBanner({ count, truncated }: { count: number; truncated: boolean }): React.ReactElement {
  return (
    <div id="sql-banner">
      {`Querying ${count} faceted events · live paused · rows capped at ${SQL_LIMIT}`}
      {truncated && " · truncated"}
    </div>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function App(): React.ReactElement {
  const [state, dispatch] = useReducer(reducer, undefined, initState);
  const unsubRef = useRef<(() => void) | null>(null);
  const tileThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  // Guard to prevent concurrent keyset-paging fetches
  const fetchingMoreRef = useRef(false);

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

  async function loadFacets(filter: EventFilter): Promise<void> {
    const facets = await getFacets(filter);
    dispatch({ type: "SET_FACETS", facets });
    scheduleTileRefresh(filter);
  }

  // ---------------------------------------------------------------------------
  // SQL query
  // ---------------------------------------------------------------------------

  async function runSqlQuery(sqlText: string, filter: EventFilter): Promise<void> {
    if (!sqlText.trim()) return;
    if (!/^\s*(WITH|SELECT)\b/i.test(sqlText)) {
      dispatch({ type: "SET_SQL_ERROR", error: "Only SELECT or WITH queries are allowed" });
      return;
    }
    try {
      const result = await postQuery({ sql: sqlText, filter, limit: SQL_LIMIT });
      dispatch({ type: "SET_SQL_RESULT", result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      dispatch({ type: "SET_SQL_ERROR", error: msg });
    }
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
    if (state.sqlActive && state.sqlText) {
      void getFacets(state.filter).then((facets) => {
        dispatch({ type: "SET_FACETS", facets });
      });
      void runSqlQuery(state.sqlText, state.filter);
      scheduleTileRefresh(state.filter);
    } else {
      void load(state.filter);
    }
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

  // URL sync
  useEffect(() => {
    const sp = new URLSearchParams(location.search);
    if (state.sqlActive && state.sqlText) {
      sp.set("sql", encodeURIComponent(state.sqlText));
    } else {
      sp.delete("sql");
    }
    const search = sp.toString();
    history.replaceState(null, "", `${location.pathname}${search ? `?${search}` : ""}`);
  }, [state.sqlActive, state.sqlText]);

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
    if (state.sqlActive && state.sqlText) {
      void runSqlQuery(state.sqlText, newFilter);
      void loadFacets(newFilter);
    } else {
      if (state.liveOn) startLive(newFilter, []);
      void load(newFilter);
    }
  }

  function handleRemoveFilter(k: string): void {
    const newFilter = { ...state.filter } as Record<string, unknown>;
    delete newFilter[k];
    const f = newFilter as EventFilter;
    dispatch({ type: "SET_FILTER", filter: f });
    if (state.sqlActive && state.sqlText) {
      void runSqlQuery(state.sqlText, f);
      void loadFacets(f);
    } else {
      if (state.liveOn) startLive(f, []);
      void load(f);
    }
  }

  function handleQChange(v: string): void {
    dispatch({ type: "SET_Q", q: v });
    const newFilter = v
      ? { ...state.filter, q: v }
      : (({ q: _q, ...rest }) => rest)(state.filter as Record<string, string> & { q?: string }) as EventFilter;
    if (state.sqlActive && state.sqlText) {
      void runSqlQuery(state.sqlText, newFilter);
      void loadFacets(newFilter);
    } else {
      if (state.liveOn) startLive(newFilter, []);
      void load(newFilter);
    }
  }

  // Scroll-driven keyset paging: APPENDS to the row buffer so the virtualizer
  // can render a continuous window across all loaded pages. fetchingMoreRef
  // prevents concurrent fetches (the near-end effect fires on every render).
  const handleLoadMore = useCallback(async (): Promise<void> => {
    if (state.nextAfterId === null || fetchingMoreRef.current) return;
    fetchingMoreRef.current = true;
    try {
      const ev = await getEvents({ ...state.filter, afterId: state.nextAfterId });
      dispatch({
        type: "APPEND_ROWS",
        rows: ev.events,
        nextAfterId: ev.nextAfterId,
      });
    } finally {
      fetchingMoreRef.current = false;
    }
  }, [state.nextAfterId, state.filter]);

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

  function handleToggleSql(): void {
    if (state.sqlActive) {
      dispatch({ type: "EXIT_SQL" });
      void load(state.filter);
    } else {
      stopLive();
      dispatch({ type: "ENTER_SQL" });
      void loadFacets(state.filter);
    }
  }

  function handleSqlChange(sql: string): void {
    dispatch({ type: "SET_SQL_TEXT", sql });
    if (!sql.trim()) {
      dispatch({ type: "EXIT_SQL" });
      void load(state.filter);
    }
  }

  function handleSqlRowClick(row: Record<string, unknown>): void {
    const fakeEvent = {
      id: Number(row["id"] ?? row["uuid"] ?? 0),
      raw: JSON.stringify(row, null, 2),
      sessionId: String(row["sessionId"] ?? ""),
      project: String(row["project"] ?? ""),
      ts: row["ts"] ? Number(row["ts"]) : undefined,
      kind: String(row["kind"] ?? ""),
      tool: row["tool"] ? String(row["tool"]) : undefined,
      command: row["command"] ? String(row["command"]) : undefined,
      isError: Boolean(row["isError"]),
      result: row["result"] ? String(row["result"]) : undefined,
      text: row["text"] ? String(row["text"]) : undefined,
      diff: row["diff"] ? String(row["diff"]) : undefined,
      stderr: row["stderr"] ? String(row["stderr"]) : undefined,
      corr: row["corr"] ? String(row["corr"]) : undefined,
      resultHead: row["resultHead"] ? String(row["resultHead"]) : undefined,
    } as EventRow;
    dispatch({ type: "OPEN_DRAWER", event: fakeEvent });
  }

  const isAnalytics = state.view === "analytics";

  const facetedCount = state.facets.kind.reduce((s, b) => s + b.count, 0);
  const sqlHasIdCol = state.sqlResult
    ? state.sqlResult.columns.some((c) => c === "id" || c === "uuid")
    : false;

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
            sqlActive={state.sqlActive}
            onToggleSql={handleToggleSql}
          />

          {state.sqlActive && (
            <SqlEditor
              value={state.sqlText}
              onChange={handleSqlChange}
              onRun={() => void runSqlQuery(state.sqlText, state.filter)}
              error={state.sqlError}
            />
          )}

          <div style={{ display: isAnalytics || state.sqlActive ? "none" : "" }}>
            <EventsTable
              rows={state.rows}
              nextAfterId={state.nextAfterId}
              onNearEnd={() => void handleLoadMore()}
              onRowClick={(e) => dispatch({ type: "OPEN_DRAWER", event: e })}
              scrollRef={mainRef}
            />
          </div>

          {state.sqlActive && state.sqlResult && (
            <>
              <SqlBanner
                count={facetedCount}
                truncated={state.sqlResult.truncated}
              />
              <QueryResultGrid
                columns={state.sqlResult.columns}
                rows={state.sqlResult.rows}
                onRowClick={sqlHasIdCol ? handleSqlRowClick : undefined}
                scrollRef={mainRef}
              />
            </>
          )}

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
