// Shared column-resize UI for the (otherwise independent) events and SQL-result
// grids. Both render an identical sizing <colgroup> and per-header drag handle;
// keeping that markup in one place (DRY) prevents the two from drifting (they
// already had divergent aria-labels). Sizing *state* stays per-grid (the events
// grid persists widths, the result grid does not), so only the presentation is
// shared here.
import React from "react";
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
      // Don't let the drag handle's click bubble to the header (sort/select, etc.).
      onClick={(e) => e.stopPropagation()}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${String(header.column.columnDef.header)} column`}
    />
  );
}
