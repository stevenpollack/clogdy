import React, { useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ColumnDef,
  CellContext,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";

interface QueryResultGridProps {
  columns: string[];
  rows: unknown[][];
  onRowClick?: (row: Record<string, unknown>) => void;
  scrollRef: React.RefObject<HTMLElement | null>;
}

export default function QueryResultGrid({
  columns,
  rows,
  onRowClick,
  scrollRef,
}: QueryResultGridProps): React.ReactElement {
  const data = useMemo<Record<string, unknown>[]>(
    () => rows.map((r) => Object.fromEntries(columns.map((col, i) => [col, r[i]]))),
    [rows, columns]
  );

  const colDefs = useMemo(
    (): ColumnDef<Record<string, unknown>>[] =>
      columns.map((col) => ({
        id: col,
        header: col.toUpperCase(),
        accessorFn: (row: Record<string, unknown>) => row[col],
        cell: (info: CellContext<Record<string, unknown>, unknown>) => {
          const v = info.getValue();
          return <>{v === null || v === undefined ? "" : String(v)}</>;
        },
      })),
    [columns]
  );

  const table = useReactTable({
    data,
    columns: colDefs,
    getCoreRowModel: getCoreRowModel(),
  });

  const tableRows = table.getRowModel().rows;
  const colSpan = Math.max(columns.length, 1);

  const rowVirtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 28,
    overscan: 12,
  });

  const virtualItems = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  const paddingTop = virtualItems.length > 0 ? (virtualItems[0]?.start ?? 0) : 0;
  const paddingBottom =
    virtualItems.length > 0
      ? totalSize - (virtualItems[virtualItems.length - 1]?.end ?? totalSize)
      : 0;

  return (
    <div id="query-result-view">
      <table id="query-result">
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
        <tbody id="sql-rows">
          {paddingTop > 0 && (
            <tr aria-hidden="true">
              <td
                colSpan={colSpan}
                style={{ height: paddingTop, padding: 0, border: 0 }}
              />
            </tr>
          )}

          {virtualItems.map((vr) => {
            const row = tableRows[vr.index]!;
            return (
              <tr
                key={row.id}
                data-sql-row={vr.index}
                ref={rowVirtualizer.measureElement}
                onClick={
                  onRowClick
                    ? (ev) => {
                        ev.stopPropagation();
                        onRowClick(row.original);
                      }
                    : undefined
                }
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

          {paddingBottom > 0 && (
            <tr aria-hidden="true">
              <td
                colSpan={colSpan}
                style={{ height: paddingBottom, padding: 0, border: 0 }}
              />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
