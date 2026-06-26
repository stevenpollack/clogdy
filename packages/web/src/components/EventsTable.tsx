import React, { useEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import type { EventRow } from "@clogdy/shared";
import { splitBashCommand, resultLines } from "@clogdy/shared";

function trunc(s: string | null, n = 200): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function shortSession(s: string): string {
  return s.length > 8 ? s.slice(0, 8) : s;
}

// ---------------------------------------------------------------------------
// Cell renderers (JSX, never dangerouslySetInnerHTML)
// ---------------------------------------------------------------------------

function CommandCellContent({ e }: { e: EventRow }): React.ReactElement {
  if (e.tool === "Bash" && e.command) {
    const segments = splitBashCommand(e.command);
    if (segments.length > 1) {
      return (
        <table className="cmd-table">
          <tbody>
            {segments.map((seg, i) => (
              <tr key={i}>
                <td>{seg}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
  }
  return <>{e.command ?? ""}</>;
}

function ResultCellContent({ e }: { e: EventRow }): React.ReactElement {
  const lines = resultLines({
    resultHead: e.resultHead,
    diff: e.diff,
    result: e.result,
    stderr: e.stderr,
  });
  return (
    <>
      {lines.map((line, i) => (
        <div key={i} className={line.color ? `rline ${line.color}` : "rline"}>
          {line.text}
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

const colHelper = createColumnHelper<EventRow>();

const columns = [
  colHelper.accessor("project", {
    header: "PROJECT",
    cell: (info) => <>{info.getValue()}</>,
  }),
  colHelper.accessor("sessionId", {
    header: "SESSION",
    cell: (info) => <>{shortSession(info.getValue())}</>,
  }),
  colHelper.accessor("ts", {
    header: "TIME",
    cell: (info) => {
      const ts = info.getValue();
      return <>{ts ? new Date(ts).toLocaleString() : ""}</>;
    },
  }),
  colHelper.accessor("kind", {
    header: "KIND",
    cell: (info) => <>{info.getValue()}</>,
  }),
  colHelper.accessor("tool", {
    header: "TOOL",
    cell: (info) => <>{info.getValue() ?? ""}</>,
  }),
  colHelper.display({
    id: "command",
    header: "COMMAND",
    cell: (info) => <CommandCellContent e={info.row.original} />,
  }),
  colHelper.accessor("isError", {
    header: "ERROR",
    cell: (info) => {
      const v = info.getValue();
      return v === true ? <span className="error">ERROR</span> : <></>;
    },
  }),
  colHelper.display({
    id: "result",
    header: "RESULT",
    cell: (info) => <ResultCellContent e={info.row.original} />,
  }),
  colHelper.accessor("text", {
    header: "TEXT",
    cell: (info) => <>{trunc(info.getValue())}</>,
  }),
];

const COL_SPAN = columns.length;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface EventsTableProps {
  rows: EventRow[];
  nextAfterId: number | null;
  onNearEnd: () => void;
  onRowClick: (e: EventRow) => void;
  scrollRef: React.RefObject<HTMLElement | null>;
}

export function EventsTable({
  rows,
  nextAfterId,
  onNearEnd,
  onRowClick,
  scrollRef,
}: EventsTableProps): React.ReactElement {
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const tableRows = table.getRowModel().rows;

  // ---------------------------------------------------------------------------
  // Virtualizer — padding-rows approach keeps <colgroup> + table-layout: fixed
  // working correctly without requiring display:block on tbody.
  // ---------------------------------------------------------------------------
  const rowVirtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 28,
    overscan: 12,
  });

  const virtualItems = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  // Top/bottom padding rows simulate the full scroll height so the scrollbar
  // accurately represents the total row count. Only window+overscan <tr>s
  // with real data are in the DOM.
  const paddingTop = virtualItems.length > 0 ? (virtualItems[0]?.start ?? 0) : 0;
  const paddingBottom =
    virtualItems.length > 0
      ? totalSize - (virtualItems[virtualItems.length - 1]?.end ?? totalSize)
      : 0;

  // ---------------------------------------------------------------------------
  // Append-on-scroll: trigger when the last rendered index nears the buffer end.
  // The guard in App's handleLoadMore prevents concurrent fetches.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (virtualItems.length === 0 || nextAfterId === null) return;
    const lastVirtual = virtualItems[virtualItems.length - 1];
    if (lastVirtual !== undefined && lastVirtual.index >= tableRows.length - 50) {
      onNearEnd();
    }
  }, [virtualItems, tableRows.length, nextAfterId, onNearEnd]);

  return (
    <div id="events-view">
      <table id="events">
        <colgroup>
          <col className="c-project" />
          <col className="c-session" />
          <col className="c-time" />
          <col className="c-kind" />
          <col className="c-tool" />
          <col className="c-command" />
          <col className="c-error" />
          <col className="c-result" />
          <col className="c-text" />
        </colgroup>
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => (
                <th key={h.id}>
                  {flexRender(h.column.columnDef.header, h.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody id="rows">
          {/* Top spacer — fills the gap before the first visible row */}
          {paddingTop > 0 && (
            <tr aria-hidden="true">
              <td
                colSpan={COL_SPAN}
                style={{ height: paddingTop, padding: 0, border: 0 }}
              />
            </tr>
          )}

          {/* Only the virtualizer window + overscan rows are in the DOM */}
          {virtualItems.map((virtualRow) => {
            const row = tableRows[virtualRow.index]!;
            return (
              <tr
                key={row.id}
                data-id={String(row.original.id)}
                data-index={virtualRow.index}
                ref={rowVirtualizer.measureElement}
                onClick={(ev) => {
                  ev.stopPropagation();
                  onRowClick(row.original);
                }}
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id}>
                    <div>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </div>
                  </td>
                ))}
              </tr>
            );
          })}

          {/* Bottom spacer — fills the gap after the last visible row */}
          {paddingBottom > 0 && (
            <tr aria-hidden="true">
              <td
                colSpan={COL_SPAN}
                style={{ height: paddingBottom, padding: 0, border: 0 }}
              />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
