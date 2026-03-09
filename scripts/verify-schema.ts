/**
 * Verify that required schemas and tables exist for B2B app.
 * Run after applying 03_gold.sql to ensure orchestration, diet_rules, bronze exist.
 *
 * Usage: npm run db:verify-schema
 * Or: tsx scripts/verify-schema.ts
 */
import "../server/env-loader.js";
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("Missing required env var: DATABASE_URL");
  process.exit(1);
}

const client = new pg.Client({
  connectionString: DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false },
});

interface CheckResult {
  name: string;
  exists: boolean;
  detail?: string;
}

async function checkTable(schema: string, table: string): Promise<CheckResult> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
    [schema, table]
  );
  return { name: `${schema}.${table}`, exists: (r.rows?.length ?? 0) > 0 };
}

async function checkSchema(schema: string): Promise<CheckResult> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`,
    [schema]
  );
  return { name: `schema: ${schema}`, exists: (r.rows?.length ?? 0) > 0 };
}

async function main() {
  await client.connect();

  const checks: CheckResult[] = [];

  // Gold schema (from 03_gold.sql)
  checks.push(await checkSchema("gold"));
  checks.push(await checkTable("gold", "vendors"));
  checks.push(await checkTable("gold", "b2b_users"));
  checks.push(await checkTable("gold", "products"));
  checks.push(await checkTable("gold", "b2b_customers"));

  // Orchestration (Jobs page, run detail) — not in 03_gold.sql; from Python orchestrator or separate setup
  checks.push(await checkSchema("orchestration"));
  checks.push(await checkTable("orchestration", "orchestration_runs"));
  checks.push(await checkTable("orchestration", "pipeline_runs"));
  checks.push(await checkTable("orchestration", "pipeline_step_logs"));

  // diet_rules (public) — Customer matching condition-based policy
  checks.push(await checkTable("public", "diet_rules"));

  // Bronze + ingestion (Ingest flow)
  checks.push(await checkSchema("bronze"));
  checks.push(await checkTable("bronze", "raw_products"));
  checks.push(await checkTable("bronze", "raw_customers"));
  checks.push(await checkTable("public", "ingestion_jobs"));
  checks.push(await checkTable("public", "ingestion_job_errors"));

  await client.end();

  // Report
  console.log("\n=== B2B Schema Verification ===\n");
  const missing: string[] = [];
  for (const c of checks) {
    const status = c.exists ? "OK" : "MISSING";
    console.log(`  ${status.padEnd(8)} ${c.name}`);
    if (!c.exists) missing.push(c.name);
  }

  if (missing.length > 0) {
    console.log("\n--- Missing (may cause errors) ---");
    missing.forEach((m) => console.log(`  - ${m}`));
    console.log("\nIf DB was built only from 03_gold.sql:");
    console.log("  - orchestration.* : Run Python orchestrator setup or create schema/tables");
    console.log("  - public.diet_rules: Run migration 001_initial_schema.sql (or equivalent)");
    console.log("  - bronze.*, ingestion_jobs: Run migration 011_bronze_ingest_tables.sql");
    console.log("");
    process.exit(1);
  }

  console.log("\nAll required schemas/tables present.\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("Verify failed:", err?.message || err);
  process.exit(1);
});
