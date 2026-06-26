import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema";

/**
 * Open (creating if needed) the SQLite DB at `path`, applying the schema
 * idempotently and recording the schema version. WAL/synchronous pragmas live in
 * SCHEMA_SQL and are applied by `exec`.
 */
export function openDb(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec(SCHEMA_SQL);
  db.query(
    "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO NOTHING",
  ).run(String(SCHEMA_VERSION));
  return db;
}
