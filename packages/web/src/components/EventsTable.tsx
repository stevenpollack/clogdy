import React from "react";
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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface EventsTableProps {
  rows: EventRow[];
  nextAfterId: number | null;
  onLoadMore: () => void;
  onRowClick: (e: EventRow) => void;
}

export function EventsTable({
  rows,
  nextAfterId,
  onLoadMore,
  onRowClick,
}: EventsTableProps): React.ReactElement {
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

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
          {table.getRowModel().rows.map((row) => (
            <tr
              key={row.id}
              data-id={String(row.original.id)}
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
          ))}
        </tbody>
      </table>
      <button
        id="more"
        style={{ display: nextAfterId === null ? "none" : undefined }}
        onClick={onLoadMore}
      >
        Load more
      </button>
    </div>
  );
}
