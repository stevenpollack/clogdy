import React, { useRef, useEffect } from "react";
import type { EventFilter } from "@clogdy/shared";

function shortSession(s: string): string {
  return s.length > 8 ? s.slice(0, 8) : s;
}

interface FilterBarProps {
  filter: EventFilter;
  liveOn: boolean;
  qValue: string;
  onQChange: (v: string) => void;
  onRemoveFilter: (key: string) => void;
  onToggleLive: () => void;
  sqlActive: boolean;
  onToggleSql: () => void;
}

export function FilterBar({
  filter,
  liveOn,
  qValue,
  onQChange,
  onRemoveFilter,
  onToggleLive,
  sqlActive,
  onToggleSql,
}: FilterBarProps): React.ReactElement {
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Debounce q input
  function handleInput(e: React.ChangeEvent<HTMLInputElement>): void {
    const v = e.target.value;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      onQChange(v.trim());
    }, 250);
  }

  useEffect(() => {
    return () => clearTimeout(timerRef.current);
  }, []);

  const chips = Object.entries(filter).filter(([k, v]) => k !== "q" && v !== undefined);

  return (
    <div id="bar">
      <input
        id="q"
        type="text"
        placeholder="search command / text / result…"
        defaultValue={qValue}
        onChange={handleInput}
      />
      <span id="chips">
        {chips.map(([k, v]) => (
          <span key={k} className="chip" onClick={() => onRemoveFilter(k)}>
            {k}: {k === "session" ? shortSession(String(v)) : String(v)} ✕
          </span>
        ))}
      </span>
      <button
        id="sql-btn"
        className={sqlActive ? "active" : ""}
        onClick={onToggleSql}
      >
        ƒx SQL
      </button>
      <button
        id="live-btn"
        className={liveOn ? "active" : ""}
        onClick={onToggleLive}
      >
        {liveOn ? "Live ●" : "Live"}
      </button>
    </div>
  );
}
