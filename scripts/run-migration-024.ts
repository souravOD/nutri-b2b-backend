/**
 * Run migration 024: Seed default compliance rules
 * Inserts global compliance rules so the Compliance feature works out-of-the-box.
 *
 * Requires migration 016 (b2b_compliance_rules table) to be applied first.
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
    ssl: { rejectUnauthorized: false },
});
await client.connect();

console.log("Running migration 024_compliance_rules_seed...");

try {
    const sqlPath = resolve(__dirname, "..", "migrations", "024_compliance_rules_seed.sql");
    const migrationSql = readFileSync(sqlPath, "utf8");
    await client.query(migrationSql);
    console.log("Done: seeded default compliance rules");
} catch (err: any) {
    console.error("Migration 024 failed:", err?.message || err);
    process.exit(1);
} finally {
    await client.end();
}

process.exit(0);
