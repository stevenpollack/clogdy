/**
 * Registry: the single place that declares which middlewares and columns go
 * into the generated logdy.config.json, and in what order.
 *
 * Column array order = on-screen column order (build-config.ts assigns idx).
 * Middleware array order = execution order.
 */
import type { ColumnDef, MiddlewareDef } from "./logdy";
import { flatten } from "./middlewares/flatten";
import {
  commandColumn,
  corrColumn,
  errorColumn,
  kindColumn,
  projectColumn,
  rawColumn,
  resultColumn,
  sessionColumn,
  textColumn,
  timeColumn,
  toolColumn,
} from "./columns/audit";

export const middlewares: MiddlewareDef[] = [flatten];

export const columns: ColumnDef[] = [
  projectColumn,
  sessionColumn,
  timeColumn,
  kindColumn,
  toolColumn,
  corrColumn,
  commandColumn,
  errorColumn,
  resultColumn,
  textColumn,
  rawColumn,
];
