/**
 * Run migration 026: Add events column to webhook_endpoints
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

console.log("Running migration 026_webhook_events...");

try {
  const sqlPath = resolve(__dirname, "..", "migrations", "026_webhook_events.sql");
  const migrationSql = readFileSync(sqlPath, "utf8");
  await client.query(migrationSql);
  console.log("Done: added events column to webhook_endpoints");
} catch (err: any) {
  console.error("Migration 026 failed:", err?.message || err);
  process.exit(1);
} finally {
  await client.end();
}

process.exit(0);
