/**
 * Run migration 023: Add B2B chat sessions table
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

console.log("Running migration 023_b2b_chat_sessions...");

try {
  const sqlPath = resolve(__dirname, "..", "migrations", "023_b2b_chat_sessions.sql");
  const migrationSql = readFileSync(sqlPath, "utf8");
  await client.query(migrationSql);
  console.log("Done: created b2b chat sessions table");
} catch (err: any) {
  console.error("Migration 023 failed:", err?.message || err);
  process.exit(1);
} finally {
  await client.end();
}

process.exit(0);
