/**
 * Run migration 029: Add recipient_count column to b2b_campaigns
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
  ssl: { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false" },
});
await client.connect();

console.log("Running migration 029_campaign_recipient_count...");

try {
  const sqlPath = resolve(__dirname, "..", "migrations", "029_campaign_recipient_count.sql");
  const migrationSql = readFileSync(sqlPath, "utf8");
  await client.query(migrationSql);
  console.log("Done: added recipient_count to gold.b2b_campaigns");
} catch (err: any) {
  console.error("Migration 029 failed:", err?.message || err);
  process.exit(1);
} finally {
  await client.end();
}

process.exit(0);
