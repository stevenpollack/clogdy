import React, { useEffect } from "react";
import type { EventRow } from "@clogdy/shared";

interface DrawerProps {
  event: EventRow | null;
  onClose: () => void;
  onCorrFilter: (corr: string) => void;
}

function DrawerSection({ label, body }: { label: string; body: string }): React.ReactElement {
  return (
    <>
      <h4>{label}</h4>
      <pre>{body}</pre>
    </>
  );
}

export function Drawer({ event, onClose, onCorrFilter }: DrawerProps): React.ReactElement | null {
  // Escape key closes the drawer
  useEffect(() => {
    if (!event) return;
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [event, onClose]);

  if (!event) return null;

  const e = event;

  // Pretty-print raw JSON
  let raw = e.raw;
  try {
    const parsed: unknown = JSON.parse(e.raw);
    raw = JSON.stringify(parsed, null, 2);
  } catch {
    raw = e.raw;
  }

  return (
    <div
      id="drawer"
      onClick={(ev) => ev.stopPropagation()}
    >
      <span className="close" onClick={onClose}>✕</span>

      {e.corr && (
        <>
          <h4>corr</h4>
          <span
            className="corr-link"
            onClick={() => {
              onCorrFilter(e.corr!);
              onClose();
            }}
          >
            {e.corr}
          </span>
        </>
      )}

      <DrawerSection label="raw" body={raw} />
      {e.result && <DrawerSection label="result" body={e.result} />}
      {e.text && <DrawerSection label="text" body={e.text} />}
      {e.diff && <DrawerSection label="diff" body={e.diff} />}
      {e.stderr && <DrawerSection label="stderr" body={e.stderr} />}
    </div>
  );
}
