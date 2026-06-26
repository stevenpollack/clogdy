import { describe, expect, it } from "bun:test";
import { assertSelectOnly, stripSqlComments } from "./sqlguard";

describe("stripSqlComments", () => {
  it("strips block comments", () => {
    expect(stripSqlComments("SELECT /* foo */ 1")).toBe("SELECT  1");
  });

  it("strips line comments", () => {
    expect(stripSqlComments("SELECT 1 -- comment\n")).toBe("SELECT 1 \n");
  });

  it("does NOT strip -- inside a single-quoted string", () => {
    const sql = "SELECT '-- not a comment' AS x";
    expect(stripSqlComments(sql)).toBe(sql);
  });

  it("does NOT strip /* inside a single-quoted string", () => {
    const sql = "SELECT '/* not a comment */' AS x";
    expect(stripSqlComments(sql)).toBe(sql);
  });

  it("handles '' escaped apostrophe inside string", () => {
    const sql = "SELECT 'it''s fine -- still inside' AS x";
    expect(stripSqlComments(sql)).toBe(sql);
  });
});

describe("assertSelectOnly — accepted", () => {
  it("accepts a plain SELECT", () => {
    expect(() => assertSelectOnly("SELECT 1")).not.toThrow();
  });

  it("accepts SELECT with WHERE and ORDER BY", () => {
    expect(() =>
      assertSelectOnly("SELECT tool, COUNT(*) n FROM events WHERE kind='tool_use' GROUP BY tool"),
    ).not.toThrow();
  });

  it("accepts WITH x AS (…) SELECT …", () => {
    expect(() =>
      assertSelectOnly("WITH x AS (SELECT 1) SELECT * FROM x"),
    ).not.toThrow();
  });

  it("accepts trailing semicolon (trimmed before checks)", () => {
    expect(() => assertSelectOnly("SELECT 1;")).not.toThrow();
  });

  it("accepts SELECT with lowercase keywords", () => {
    expect(() => assertSelectOnly("select * from events")).not.toThrow();
  });
});

describe("assertSelectOnly — rejected", () => {
  it("rejects DROP TABLE", () => {
    expect(() => assertSelectOnly("DROP TABLE event")).toThrow(/DROP/i);
  });

  it("rejects multi-statement SELECT 1; DELETE", () => {
    const err = expect(() =>
      assertSelectOnly("SELECT 1; DELETE FROM event"),
    );
    err.toThrow();
    try {
      assertSelectOnly("SELECT 1; DELETE FROM event");
    } catch (e) {
      expect((e as Error).message).toMatch(/;|multiple statement/i);
    }
  });

  it("rejects comment-smuggled block: SELECT 1 /* */; DROP …", () => {
    expect(() =>
      assertSelectOnly("SELECT 1 /* */; DROP TABLE event"),
    ).toThrow();
  });

  it("rejects comment-smuggled line: SELECT 1 -- x\\n; DROP", () => {
    expect(() =>
      assertSelectOnly("SELECT 1 -- x\n; DROP TABLE event"),
    ).toThrow();
  });

  it("rejects COPY events TO 'f'", () => {
    expect(() => assertSelectOnly("COPY events TO 'f'")).toThrow(/COPY/i);
  });

  it("rejects INSTALL httpfs", () => {
    expect(() => assertSelectOnly("INSTALL httpfs")).toThrow(/INSTALL/i);
  });

  it("rejects PRAGMA …", () => {
    expect(() => assertSelectOnly("PRAGMA database_list")).toThrow(/PRAGMA/i);
  });

  it("rejects non-SELECT (VALUES (1))", () => {
    expect(() => assertSelectOnly("VALUES (1)")).toThrow(/only SELECT or WITH/i);
  });

  it("rejects shadowing CTE named 'events'", () => {
    expect(() =>
      assertSelectOnly("WITH events AS (SELECT 1) SELECT * FROM events"),
    ).toThrow(/events/i);
  });

  it("error message names the violation for DROP", () => {
    let msg = "";
    try {
      assertSelectOnly("DROP TABLE event");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/DROP/i);
  });

  it("error message names the violation for COPY", () => {
    let msg = "";
    try {
      assertSelectOnly("COPY events TO '/tmp/out.csv'");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/COPY/i);
  });

  it("error message mentions CTE shadow for WITH events", () => {
    let msg = "";
    try {
      assertSelectOnly("WITH events AS (SELECT 1) SELECT * FROM events");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/events/i);
  });
});
