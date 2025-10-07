import dotenv from "dotenv";
import fs from "fs-extra";
import {
  Client,
  Databases,
  Users,
  Teams,
  Query,
} from "node-appwrite";

dotenv.config();

const {
  APPWRITE_ENDPOINT,
  APPWRITE_PROJECT_ID,
  APPWRITE_API_KEY,
  APPWRITE_DB_ID,
  OUTPUT_DIR = "./appwrite-export",
} = process.env;

const PAGE_LIMIT = 100;

// OPTIONAL: only export specific collections. Leave empty to export all.
const COLLECTION_ALLOWLIST = new Set([
  // "user_profiles",
  // "vendors",
  // "customers",
  // "vendor_sources",
  // "vendor_mappings",
  // "ingestion_jobs",
  // "products",
]);

function assertEnv() {
  const missing = [
    "APPWRITE_ENDPOINT",
    "APPWRITE_PROJECT_ID",
    "APPWRITE_API_KEY",
    "APPWRITE_DB_ID",
  ].filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing env vars: ${missing.join(", ")}`);
  }
}

function buildClient() {
  return new Client()
    .setEndpoint(APPWRITE_ENDPOINT)
    .setProject(APPWRITE_PROJECT_ID)
    .setKey(APPWRITE_API_KEY);
}

async function exportDatabase(client) {
  const db = new Databases(client);
  await fs.ensureDir(OUTPUT_DIR);

  // List all collections in the database
  const colResp = await db.listCollections(APPWRITE_DB_ID);
  const collections = colResp.collections.filter(
    (c) => COLLECTION_ALLOWLIST.size === 0 || COLLECTION_ALLOWLIST.has(c.$id)
  );

  if (!collections.length) {
    console.log("No collections to export (check DB id or allowlist).");
    return;
  }

  for (const col of collections) {
    const outPath = `${OUTPUT_DIR}/${col.$id}.jsonl`;
    console.log(`↳ Exporting collection ${col.$id} → ${outPath}`);
    const stream = fs.createWriteStream(outPath, { flags: "w" });

    let cursor = null;
    while (true) {
      const queries = [Query.limit(PAGE_LIMIT)];
      if (cursor) queries.push(Query.cursorAfter(cursor));

      const page = await db.listDocuments(
        APPWRITE_DB_ID,
        col.$id,
        queries
      );

      for (const doc of page.documents) {
        stream.write(JSON.stringify(doc) + "\n");
      }

      if (page.documents.length < PAGE_LIMIT) break;
      cursor = page.documents[page.documents.length - 1].$id;
    }

    stream.end();
  }

  console.log("✅ DB export complete.");
}

async function exportAuth(client) {
  await fs.ensureDir(OUTPUT_DIR);

  // Users
  const usersSDK = new Users(client);
  let users = [];
  {
    let cursor = null;
    while (true) {
      const queries = [Query.limit(PAGE_LIMIT)];
      if (cursor) queries.push(Query.cursorAfter(cursor));
      const page = await usersSDK.list(queries); // NOTE: pass the array, not {queries}
      users.push(...page.users);
      if (page.users.length < PAGE_LIMIT) break;
      cursor = page.users[page.users.length - 1].$id;
    }
  }
  await fs.writeJson(`${OUTPUT_DIR}/users.json`, users, { spaces: 2 });
  console.log(`👥 Users exported: ${users.length}`);

  // Teams + memberships
  const teamsSDK = new Teams(client);
  let teams = [];
  {
    let cursor = null;
    while (true) {
      const queries = [Query.limit(PAGE_LIMIT)];
      if (cursor) queries.push(Query.cursorAfter(cursor));
      const page = await teamsSDK.list(queries);
      teams.push(...page.teams);
      if (page.teams.length < PAGE_LIMIT) break;
      cursor = page.teams[page.teams.length - 1].$id;
    }
  }
  await fs.writeJson(`${OUTPUT_DIR}/teams.json`, teams, { spaces: 2 });
  console.log(`👤‍👤 Teams exported: ${teams.length}`);

  const membershipsAll = [];
  for (const t of teams) {
    let memberships = [];
    let cursor = null;
    while (true) {
      const queries = [Query.limit(PAGE_LIMIT)];
      if (cursor) queries.push(Query.cursorAfter(cursor));
      const page = await teamsSDK.listMemberships(t.$id, queries);
      memberships.push(...page.memberships);
      if (page.memberships.length < PAGE_LIMIT) break;
      cursor = page.memberships[page.memberships.length - 1].$id;
    }
    membershipsAll.push({
      teamId: t.$id,
      teamName: t.name,
      memberships,
    });
  }
  await fs.writeJson(
    `${OUTPUT_DIR}/team_memberships.json`,
    membershipsAll,
    { spaces: 2 }
  );
  console.log("🔐 Team memberships exported.");

  console.log("✅ Auth export complete.");
}

(async function main() {
  try {
    console.log(`[dotenv] env loaded → exporting to ${OUTPUT_DIR}`);
    assertEnv();
    const client = buildClient();

    console.log("=== Exporting Appwrite (DB + Auth) ===");
    await exportDatabase(client);
    await exportAuth(client);

    console.log(`\nAll done. Files under: ${OUTPUT_DIR}\n`);
  } catch (err) {
    // Show full error details to help when scopes/ids are wrong
    console.error("❌ Export failed:");
    console.error(err?.message || err);
    if (err?.response) {
      console.error("Response:", JSON.stringify(err.response, null, 2));
    }
    process.exit(1);
  }
})();
