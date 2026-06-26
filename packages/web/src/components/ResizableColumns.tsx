// Shared column-header UI (sort toggle + resize handle + sizing <colgroup>) for
// the events and SQL-result grids. Keeping this markup in one place (DRY) stops
// the two grids from drifting. Sizing/sorting *state* stays per-grid (the events
// grid persists widths; both manage their own SortingState) — only presentation
// is shared here.
import React from "react";
import { flexRender } from "@tanstack/react-table";
import type { Header, Table } from "@tanstack/react-table";

/** <colgroup> whose widths track react-table's column sizing (table-layout:fixed). */
export function ResizableColgroup<T>({
  table,
}: {
  table: Table<T>;
}): React.ReactElement {
  return (
    <colgroup>
      {table.getVisibleLeafColumns().map((col) => (
        <col key={col.id} style={{ width: col.getSize() }} />
      ))}
    </colgroup>
  );
}

/** Drag handle on a header's right edge: drag to resize, double-click to reset. */
export function ColumnResizer<T>({
  header,
}: {
  header: Header<T, unknown>;
}): React.ReactElement | null {
  if (!header.column.getCanResize()) return null;
  return (
    <div
      className={`resizer${header.column.getIsResizing() ? " is-resizing" : ""}`}
      onMouseDown={header.getResizeHandler()}
      onTouchStart={header.getResizeHandler()}
      onDoubleClick={() => header.column.resetSize()}
      // Don't let the drag handle's click bubble to the header (which would sort).
      onClick={(e) => e.stopPropagation()}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${String(header.column.columnDef.header)} column`}
    />
  );
}

/** A header cell's contents: a click-to-sort label (when sortable) + resize handle. */
export function HeaderCell<T>({
  header,
}: {
  header: Header<T, unknown>;
}): React.ReactElement {
  const canSort = header.column.getCanSort();
  const sorted = header.column.getIsSorted(); // false | "asc" | "desc"
  return (
    <>
      <span
        className={canSort ? "th-label sortable" : "th-label"}
        onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
        title={canSort ? "Click to sort" : undefined}
      >
        {flexRender(header.column.columnDef.header, header.getContext())}
        {sorted === "asc" ? " ▲" : sorted === "desc" ? " ▼" : ""}
      </span>
      <ColumnResizer header={header} />
    </>
  );
}
