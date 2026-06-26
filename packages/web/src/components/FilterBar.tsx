import React, { useRef, useEffect } from "react";
import type { EventFilter } from "@clogdy/shared";
import { asArray } from "@clogdy/shared";

function shortSession(s: string): string {
  return s.length > 8 ? s.slice(0, 8) : s;
}

interface FilterBarProps {
  filter: EventFilter;
  liveOn: boolean;
  qValue: string;
  onQChange: (v: string) => void;
  onRemoveFilter: (key: string, value?: string) => void;
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

  // One chip per selected value, so a multi-select dimension (e.g. kind =
  // tool_use + tool_result) shows two separately-removable chips.
  const chips = Object.entries(filter)
    .filter(([k]) => k !== "q")
    .flatMap(([k, v]) => asArray(v).map((val) => ({ key: k, value: String(val) })));

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
        {chips.map(({ key, value }) => (
          <span
            key={`${key}:${value}`}
            className="chip"
            onClick={() => onRemoveFilter(key, value)}
          >
            {key}: {key === "session" ? shortSession(value) : value} ✕
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
