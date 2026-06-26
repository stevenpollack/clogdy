/**
 * Pure SQL guard functions. No I/O.
 *
 * Limit: the string-literal state machine handles only single-quoted strings.
 * It does NOT handle dollar-quoting, escape-string syntax (E'...'), or
 * Unicode-escape literals (U&'...'). A comment inside such a literal would be
 * incorrectly stripped. This is sufficient for the MVP guard.
 *
 * Belt-and-suspenders note — does DuckDB itself reject multi-statement SQL in a
 * single `conn.run()`/`conn.runAndReadAll()` call? Answer: NO. DuckDB's C API
 * (`duckdb_query`) executes multi-statement input (the node-api README
 * demonstrates this via `extractStatements`, which iterates over the parsed
 * statement list). Sending `SELECT 1; DROP TABLE t` as one string to `run()`
 * would execute both statements. `assertSelectOnly` is therefore the PRIMARY
 * and non-redundant protection layer — DuckDB provides no automatic guard.
 */

/**
 * Remove SQL comments from sql:
 * - block comments (non-nesting)
 * - line comments (-- through end-of-line)
 *
 * Single-quote string-literal aware: -- or /* that appears inside a single-quoted
 * string literal is NOT treated as a comment start. Apostrophe-doubling ('') inside
 * a string is handled correctly.
 */
export function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];

    // Single-quoted string: copy verbatim until closing quote (handle '' escapes).
    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'") {
          if (j + 1 < n && sql[j + 1] === "'") {
            // escaped apostrophe inside string
            j += 2;
          } else {
            // closing quote
            j++;
            break;
          }
        } else {
          j++;
        }
      }
      out += sql.slice(i, j);
      i = j;
      continue;
    }

    // Block comment: /* ... */
    if (ch === "/" && i + 1 < n && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) {
        // unterminated block comment — consume the rest
        i = n;
      } else {
        i = end + 2;
      }
      continue;
    }

    // Line comment: -- through end-of-line
    if (ch === "-" && i + 1 < n && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i + 2);
      if (nl === -1) {
        i = n;
      } else {
        // keep the newline so multi-line SQL keeps its structure
        i = nl;
      }
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * The blocked DDL/DML/admin tokens. Word-boundary, case-insensitive check.
 * DuckDB-specific: ATTACH/DETACH/INSTALL/LOAD/COPY/EXPORT/IMPORT let an attacker
 * read/write files or load extensions.
 */
const BLOCKED_TOKENS = [
  "ATTACH",
  "DETACH",
  "PRAGMA",
  "INSTALL",
  "LOAD",
  "COPY",
  "EXPORT",
  "IMPORT",
  "INSERT",
  "UPDATE",
  "UPSERT",
  "DELETE",
  "DROP",
  "CREATE",
  "ALTER",
  "REPLACE",
  "TRUNCATE",
  "CALL",
  "GRANT",
  "REVOKE",
  "VACUUM",
  "CHECKPOINT",
] as const;

const BLOCKED_RE = new RegExp(
  "\\b(" + BLOCKED_TOKENS.join("|") + ")\\b",
  "i",
);

/**
 * Return true if `sql` (already comment-stripped) contains a semicolon OUTSIDE
 * a single-quoted string literal.
 *
 * `stripSqlComments` preserves string literal contents verbatim (so `SELECT ';'`
 * still has a `;` in the returned string). A naïve `str.includes(";")` would
 * therefore falsely flag a `;` inside a string as a statement separator.
 * This scanner copies the same single-quote / apostrophe-doubling state machine
 * as `stripSqlComments` and only counts `;` found in non-string context.
 */
function hasSemicolonOutsideStrings(sql: string): boolean {
  let inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inStr) {
      if (ch === "'") {
        if (i + 1 < sql.length && sql[i + 1] === "'") {
          i++; // escaped apostrophe '' — skip both
        } else {
          inStr = false; // closing quote
        }
      }
    } else {
      if (ch === "'") {
        inStr = true;
      } else if (ch === ";") {
        return true;
      }
    }
  }
  return false;
}

/**
 * Throw if sql is not a safe, single, read-only SELECT/WITH statement.
 *
 * Rules (all checked after stripSqlComments + trimming one trailing semicolon):
 * 1. No remaining semicolon OUTSIDE a string literal — single statement only.
 *    (A `;` inside a string, e.g. `SELECT ';'`, is NOT treated as a separator.)
 * 2. Must start with SELECT or WITH.
 * 3. Must not contain any blocked token (word-boundary, case-insensitive).
 * 4. Must not define a CTE named events (would shadow the wrapper CTE).
 */
export function assertSelectOnly(sql: string): void {
  const stripped = stripSqlComments(sql).replace(/;\s*$/, "");

  if (hasSemicolonOutsideStrings(stripped)) {
    throw new Error(
      "SQL guard: multiple statements are not allowed (contains ';' after comment stripping)",
    );
  }

  if (!/^\s*(WITH|SELECT)\b/i.test(stripped)) {
    const first = stripped.trim().split(/\s+/)[0] ?? "(empty)";
    throw new Error(
      "SQL guard: only SELECT or WITH ... SELECT statements are allowed (got '" + first + "')",
    );
  }

  const blockedMatch = BLOCKED_RE.exec(stripped);
  if (blockedMatch) {
    throw new Error(
      "SQL guard: blocked token '" + blockedMatch[1].toUpperCase() + "' is not allowed in a read-only query",
    );
  }

  // Reject user-defined CTE named 'events' -- it would shadow the wrapper CTE.
  if (/\bWITH\s+events\b/i.test(stripped)) {
    throw new Error(
      "SQL guard: a CTE named 'events' is not allowed -- it would shadow the facet-scoped CTE wrapper",
    );
  }
}
