import React from "react";
import type { Facets, EventFilter } from "@clogdy/shared";

type FacetDim = keyof Facets;

const FACET_DIMS: FacetDim[] = ["project", "session", "tool", "kind", "error"];

function filterKey(dim: FacetDim): keyof EventFilter {
  return dim === "session" ? "session" : (dim as keyof EventFilter);
}

function shortSession(s: string): string {
  return s.length > 8 ? s.slice(0, 8) : s;
}

interface FacetSidebarProps {
  facets: Facets;
  filter: EventFilter;
  onToggle: (key: keyof EventFilter, value: string) => void;
}

export function FacetSidebar({ facets, filter, onToggle }: FacetSidebarProps): React.ReactElement {
  return (
    <aside id="facets">
      {FACET_DIMS.map((dim) => {
        const key = filterKey(dim);
        const active = filter[key];
        return (
          <React.Fragment key={dim}>
            <h3>{dim}</h3>
            {facets[dim].map((b) => {
              const label = dim === "session" ? shortSession(b.value) : b.value;
              const isActive = active === b.value;
              return (
                <div
                  key={b.value}
                  className={isActive ? "facet active" : "facet"}
                  onClick={() => onToggle(key, b.value)}
                >
                  <span>{label || "(none)"}</span>
                  <span className="count">{b.count}</span>
                </div>
              );
            })}
          </React.Fragment>
        );
      })}
    </aside>
  );
}
