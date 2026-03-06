/**
 * Run migration 019: Add compatibility columns to gold.products
 * Adds nutrition, dietary_tags, allergens, certifications, regulatory_codes,
 * ingredients, notes, search_tsv, soft_deleted_at, product_url.
 * Fixes: column "nutrition" does not exist
 */
import "dotenv/config";
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

console.log("Running migration 019_gold_products_compatibility_columns...");

try {
  const sqlPath = resolve(__dirname, "..", "migrations", "019_gold_products_compatibility_columns.sql");
  const migrationSql = readFileSync(sqlPath, "utf8");
  await client.query(migrationSql);
  console.log("Done: added nutrition, dietary_tags, allergens, etc. to gold.products");
} catch (err: any) {
  console.error("Migration 019 failed:", err?.message || err);
  process.exit(1);
} finally {
  await client.end();
}

process.exit(0);
