/**
 * Run migration 025: Gold 3 products alignment + 7 new compliance rules
 * Adds mpn, plu_code to gold.products and seeds 7 new compliance rules.
 *
 * Requires migrations 016, 018, 019, 020, 021, 024 to be applied first.
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

console.log("Running migration 025_gold3_products_and_compliance_rules...");

try {
    const sqlPath = resolve(__dirname, "..", "migrations", "025_gold3_products_and_compliance_rules.sql");
    const migrationSql = readFileSync(sqlPath, "utf8");
    await client.query(migrationSql);
    console.log("Done: added mpn, plu_code to products; seeded 7 new compliance rules");
} catch (err: any) {
    console.error("Migration 025 failed:", err?.message || err);
    process.exit(1);
} finally {
    await client.end();
}

process.exit(0);
