/**
 * Run migration 016: B2B feature tables
 * Creates b2b_alerts, b2b_compliance_rules, b2b_compliance_checks,
 * b2b_role_permissions, b2b_webhooks, b2b_ip_allowlist + seed data.
 *
 * Uses pg directly to connect to Supabase.
 */
import pg from 'pg';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

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

console.log('Running migration 016_b2b_features...');

try {
    const sqlPath = resolve(__dirname, '..', 'migrations', '016_b2b_features.sql');
    const migrationSql = readFileSync(sqlPath, 'utf8');
    await client.query(migrationSql);
    console.log('Done: created B2B feature tables + seed data');
} catch (err: any) {
    console.error('Migration 016 failed:', err?.message || err);
    process.exit(1);
} finally {
    await client.end();
}

process.exit(0);
