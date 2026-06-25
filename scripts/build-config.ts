/**
 * Bundle the typed handlers in src/ into a logdy.config.json file.
 *
 * Each handler is serialized with Function.prototype.toString(), which under Bun
 * yields transpiled, type-stripped JS. Logdy stores this as `handlerTsCode` (its
 * editor source) and computes the runtime handler itself — so we never emit a
 * `handler` field. JS is valid in that TS field; Logdy transpiles it on load.
 *
 * The envelope (top-level `name`, `settings`) comes from committed typed source
 * (src/config.ts); this script fills in the generated, type-checked `columns`
 * and `settings.middlewares`. Single deterministic source — no external file.
 *
 * The output is constructed and validated as a `LogdyConfig` before being
 * written, so a structural mistake fails the build instead of producing a bad
 * config on disk.
 *
 * Run: bun run build
 */
import { baseSettings, configName } from "../src/config";
import { columns, middlewares } from "../src/index";
import type {
  ColumnDef,
  LogdyColumn,
  LogdyConfig,
  LogdyMiddleware,
  MiddlewareDef,
} from "../src/logdy";

const OUT = new URL("../logdy.config.json", import.meta.url);

function slug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function assertUniqueIds(ids: string[], kind: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`Duplicate ${kind} id "${id}" — names must be unique.`);
    seen.add(id);
  }
}

function buildMiddleware(def: MiddlewareDef): LogdyMiddleware {
  // Logdy prefixes middleware ids with `m_` to keep them distinct from column ids.
  return { id: `m_${slug(def.name)}`, name: def.name, handlerTsCode: def.handler.toString() };
}

function buildColumn(def: ColumnDef, idx: number): LogdyColumn {
  return {
    id: slug(def.name),
    name: def.name,
    handlerTsCode: def.handler.toString(),
    idx,
    width: def.width,
    faceted: def.faceted,
  };
}

/** Runtime guard: confirm the object we're about to write really is a LogdyConfig. */
function assertLogdyConfig(c: unknown): asserts c is LogdyConfig {
  const bad = (msg: string): never => {
    throw new Error(`Generated config is not a valid LogdyConfig: ${msg}`);
  };
  if (typeof c !== "object" || c === null) bad("not an object");
  const o = c as Record<string, unknown>;
  if (typeof o.name !== "string") bad("`name` must be a string");
  if (!Array.isArray(o.columns)) bad("`columns` must be an array");
  for (const col of o.columns as LogdyColumn[]) {
    if (typeof col?.id !== "string" || typeof col?.name !== "string") bad("column missing id/name");
    if (typeof col?.handlerTsCode !== "string") bad(`column "${col?.name}" missing handlerTsCode`);
    if (typeof col?.idx !== "number") bad(`column "${col?.name}" missing numeric idx`);
  }
  const s = o.settings as Record<string, unknown> | undefined;
  if (typeof s !== "object" || s === null) bad("`settings` must be an object");
  if (!Array.isArray(s!.middlewares)) bad("`settings.middlewares` must be an array");
}

const mw = middlewares.map(buildMiddleware);
const cols = columns.map(buildColumn);
assertUniqueIds(mw.map((m) => m.id), "middleware");
assertUniqueIds(cols.map((c) => c.id), "column");

const config: LogdyConfig = {
  name: configName,
  columns: cols,
  settings: { ...baseSettings, middlewares: mw },
};

assertLogdyConfig(config);
await Bun.write(OUT, JSON.stringify(config, null, 2) + "\n");
console.log(`Wrote ${OUT.pathname} (${cols.length} columns, ${mw.length} middlewares).`);
