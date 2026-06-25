/**
 * Registry: the single place that declares which middlewares and columns go
 * into the generated logdy.config.json, and in what order.
 *
 * Column array order = on-screen column order (build-config.ts assigns idx).
 * Middleware array order = execution order.
 */
import type { ColumnDef, MiddlewareDef } from "./logdy";
import { tagRole } from "./middlewares/example-tag-role";
import { contentColumn, roleColumn } from "./columns/example-role";

export const middlewares: MiddlewareDef[] = [tagRole];

export const columns: ColumnDef[] = [roleColumn, contentColumn];
