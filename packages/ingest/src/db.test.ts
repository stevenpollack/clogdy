import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";

let dir: string;
let dbPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "clogdy-db-"));
  dbPath = join(dir, "nested", "clogdy.db");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("openDb creates the expected tables", () => {
  const db = openDb(dbPath);
  const names = new Set(
    (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string;
    }[]).map((r) => r.name),
  );
  expect(names.has("event")).toBe(true);
  expect(names.has("session")).toBe(true);
  expect(names.has("ingest_cursor")).toBe(true);
  expect(names.has("meta")).toBe(true);
  db.close();
});

test("openDb records schema_version=1", () => {
  const db = openDb(dbPath);
  const row = db
    .query("SELECT value FROM meta WHERE key='schema_version'")
    .get() as { value: string } | null;
  expect(row?.value).toBe("1");
  db.close();
});

test("journal_mode is wal", () => {
  const db = openDb(dbPath);
  const row = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
  expect(row.journal_mode).toBe("wal");
  db.close();
});

test("openDb is idempotent (second open does not throw)", () => {
  expect(() => {
    const db = openDb(dbPath);
    db.close();
  }).not.toThrow();
});
