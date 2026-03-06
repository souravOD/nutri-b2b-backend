/**
 * Run migration 017: Add missing columns to gold.b2b_customers
 * Adds custom_tags, notes, product_notes, search_tsv, created_by, updated_by.
 */
import pg from "pg";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("Missing required env var: DATABASE_URL");
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const client = new pg.Client({
  connectionString: DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false },
});
await client.connect();

console.log("Running migration 017_b2b_customers_missing_columns...");

try {
  const sqlPath = resolve(__dirname, "..", "migrations", "017_b2b_customers_missing_columns.sql");
  const migrationSql = readFileSync(sqlPath, "utf8");
  await client.query(migrationSql);
  console.log("Done: added missing columns to gold.b2b_customers");
} catch (err: any) {
  console.error("Migration 017 failed:", err?.message || err);
  process.exit(1);
} finally {
  await client.end();
}

process.exit(0);
