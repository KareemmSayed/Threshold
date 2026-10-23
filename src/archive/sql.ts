/**
 * Read-only SQL over the archive.
 *
 * D1 has no read-only connection, so queries are checked before they run: one
 * statement, starting with SELECT or WITH, no write or schema keywords outside
 * string literals, and no access to internal tables. Results are capped.
 */

const FORBIDDEN = new Set([
  "insert",
  "update",
  "delete",
  "replace",
  "upsert",
  "create",
  "drop",
  "alter",
  "attach",
  "detach",
  "pragma",
  "vacuum",
  "reindex",
  "analyze",
  "begin",
  "commit",
  "rollback",
  "savepoint",
  "release",
  "transaction",
  "trigger",
  "load_extension",
]);

export class SqlRejected extends Error {
  override name = "SqlRejected";
}

/** Words of the query outside string literals, quoted identifiers and comments. */
function tokens(sql: string): { words: string[]; semicolons: number[] } {
  const words: string[] = [];
  const semicolons: number[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      const open = i;
      i++;
      while (i < sql.length) {
        if (sql[i] === close) {
          if (close !== "]" && sql[i + 1] === close) {
            i += 2; // escaped quote
            continue;
          }
          break;
        }
        i++;
      }
      if (i >= sql.length) throw new SqlRejected("Unterminated quote.");
      // A quoted identifier can still name an internal table.
      if (c !== "'") words.push(sql.slice(open + 1, i).toLowerCase());
      i++;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) throw new SqlRejected("Unterminated comment.");
      i = end + 2;
      continue;
    }
    if (c === ";") {
      semicolons.push(i);
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_$]/.test(sql[j])) j++;
      const word = sql.slice(i, j).toLowerCase();
      // replace(...) is a string function; REPLACE INTO is a write.
      if (word !== "replace" || !/^\s*\(/.test(sql.slice(j))) words.push(word);
      i = j;
      continue;
    }
    i++;
  }
  return { words, semicolons };
}

/** Throws SqlRejected unless the query is a single read-only SELECT. Returns it without a trailing semicolon. */
export function checkReadOnly(sql: string): string {
  let query = sql.trim();
  const { words, semicolons } = tokens(query);
  if (semicolons.length > 1 || (semicolons.length === 1 && query.slice(semicolons[0] + 1).trim() !== "")) {
    throw new SqlRejected("Send one statement at a time.");
  }
  if (semicolons.length === 1) query = query.slice(0, semicolons[0]).trim();
  if (!words.length || (words[0] !== "select" && words[0] !== "with")) throw new SqlRejected("The archive is read-only: send one SELECT query (WITH ... SELECT is fine).");
  for (const w of words) {
    if (FORBIDDEN.has(w)) throw new SqlRejected(`The archive is read-only; "${w.toUpperCase()}" is not allowed.`);
    if (w.startsWith("_cf_") || w === "d1_migrations") throw new SqlRejected("Internal tables are not available.");
  }
  if (words.includes("meta")) throw new SqlRejected("The meta table holds server state and is not available; use server_status instead.");
  return query;
}

export interface SqlResult {
  columns: string[];
  rows: unknown[][];
  row_count: number;
  truncated: boolean;
}

export async function runReadOnly(db: D1Database, sql: string, maxRows = 500): Promise<SqlResult> {
  const query = checkReadOnly(sql);
  // Wrapping caps the rows D1 returns, whatever LIMIT the query has.
  const wrapped = `SELECT * FROM (${query}) LIMIT ${maxRows + 1}`;
  const [columns, ...rows] = await db.prepare(wrapped).raw<unknown>({ columnNames: true });
  const truncated = rows.length > maxRows;
  const out = truncated ? rows.slice(0, maxRows) : rows;
  return { columns: (columns as string[]) ?? [], rows: out as unknown[][], row_count: out.length, truncated };
}
