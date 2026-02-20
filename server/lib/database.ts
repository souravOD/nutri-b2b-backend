import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";


function sslFor(url: string | undefined) {
  // if you use Supabase/remote, keep this as 'require' or 'prefer'
  // for local dev you can return false
  return url?.includes(".supabase.co") ? { rejectUnauthorized: false } : false;
}

const PRIMARY_URL = process.env.DATABASE_URL!;
const READ_URL = process.env.READ_DATABASE_URL || PRIMARY_URL;
// Keep public first to avoid accidental unqualified writes into gold.
// Gold tables must always be referenced explicitly in raw SQL.
const SEARCH_PATH = "public";

function buildPool(url: string) {
  return new Pool({
    connectionString: url,
    ssl: sslFor(url),
    options: `-c search_path=${SEARCH_PATH}`,
  });
}

const primaryPool = buildPool(PRIMARY_URL);

// Try to create a read pool; if anything goes wrong, reuse primary
let replicaPool = primaryPool;
try {
  if (READ_URL && READ_URL !== PRIMARY_URL) {
    replicaPool = buildPool(READ_URL);
  }
} catch (e) {
  console.warn("[db] READ_DATABASE_URL invalid; falling back to primary.", e);
  replicaPool = primaryPool;
}

export const db = drizzle(primaryPool);
export const readDb = drizzle(replicaPool);

// Optional: log a one-time probe for clarity
primaryPool
  .query("select current_setting('search_path') as search_path")
  .then((r) => console.log(`[db] primary connected (search_path=${r.rows?.[0]?.search_path ?? "unknown"})`))
  .catch((e) => console.error("[db] primary failed", e));

if (replicaPool !== primaryPool) {
  replicaPool
    .query("select current_setting('search_path') as search_path")
    .then((r) => console.log(`[db] read-replica connected (search_path=${r.rows?.[0]?.search_path ?? "unknown"})`))
    .catch((e) => console.warn("[db] read-replica failed, using primary instead"));
}

// optional debug
// export async function query(text: string, values: any[]) {
//   if (process.env.DEBUG_SQL) {
//     console.log("[SQL]", text);
//     console.log("[SQL params]", values);
//   }
//   return pool.query(text, values);
// }
