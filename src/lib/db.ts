import postgres from "postgres";

/**
 * Lazy singleton Postgres client (postgres.js). `prepare: false` keeps it
 * compatible with Supabase's transaction pooler (pgbouncer); a small pool
 * keeps serverless connection usage inside free-tier limits while letting the
 * dashboard's parallel queries actually run in parallel.
 */

type Sql = ReturnType<typeof postgres>;

let sql: Sql | null = null;

export function db(): Sql {
  if (!sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    sql = postgres(url, {
      ssl: "require",
      max: 5,
      prepare: false,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  }
  return sql;
}
