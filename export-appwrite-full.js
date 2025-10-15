// export-appwrite-full.js (ESM)
import dotenv from "dotenv";
import fs from "fs-extra";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Client,
  Databases,
  Users,
  Teams,
  Query,
} from "node-appwrite";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const {
  APPWRITE_ENDPOINT,
  APPWRITE_PROJECT_ID,
  APPWRITE_API_KEY,
  APPWRITE_DATABASE_ID,
  OUTPUT_DIR = path.join(__dirname, "appwrite-export"),
} = process.env;

const PAGE_LIMIT = 100;

function assertEnvExport() {
  const missing = [
    "APPWRITE_ENDPOINT",
    "APPWRITE_PROJECT_ID",
    "APPWRITE_API_KEY",
    "APPWRITE_DATABASE_ID",
  ].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Missing env vars: ${missing.join(", ")}`);
}

function buildClient() {
  return new Client()
    .setEndpoint(APPWRITE_ENDPOINT)
    .setProject(APPWRITE_PROJECT_ID)
    .setKey(APPWRITE_API_KEY);
}

async function listAllPaged(listFn, arrayKey) {
  const out = [];
  let cursor = null;
  while (true) {
    const queries = [Query.limit(PAGE_LIMIT)];
    if (cursor) queries.push(Query.cursorAfter(cursor));
    const page = await listFn(queries);
    const items = page[arrayKey] || [];
    out.push(...items);
    if (items.length < PAGE_LIMIT) break;
    cursor = items[items.length - 1].$id;
  }
  return out;
}

async function exportDatabaseMeta(client) {
  const db = new Databases(client);
  const outDir = path.join(OUTPUT_DIR, "meta");
  await fs.ensureDir(outDir);

  const database = await db.get(APPWRITE_DATABASE_ID);
  const databaseMeta = {
    $id: database.$id,
    name: database.name,
    enabled: database.enabled ?? true,
  };
  await fs.writeJson(path.join(outDir, "database.json"), databaseMeta, { spaces: 2 });

  const exportInfo = {
    exported_at: new Date().toISOString(),
    source_project_id: APPWRITE_PROJECT_ID,
    exporter_version: "v2",
  };
  await fs.writeJson(path.join(outDir, "export_info.json"), exportInfo, { spaces: 2 });

  console.log("🧭 Exported database meta.");
}

async function exportSchemasAndData(client) {
  const db = new Databases(client);
  const schemasDir = path.join(OUTPUT_DIR, "schemas");
  const dataDir = path.join(OUTPUT_DIR, "data");
  await fs.ensureDir(schemasDir);
  await fs.ensureDir(dataDir);

  // collections
  const collectionsResp = await db.listCollections(APPWRITE_DATABASE_ID);
  const collections = collectionsResp.collections;

  for (const col of collections) {
    // 1) Schema parts
    const attributesResp = await db.listAttributes(APPWRITE_DATABASE_ID, col.$id);
    const indexesResp = await db.listIndexes(APPWRITE_DATABASE_ID, col.$id);

    const schema = {
      collection: {
        $id: col.$id,
        name: col.name,
        enabled: col.enabled ?? true,
        documentSecurity: col.documentSecurity ?? false,
        permissions: col.$permissions ?? [], // collection-level perms (if any)
      },
      attributes: attributesResp.attributes ?? [],
      indexes: indexesResp.indexes ?? [],
    };

    await fs.writeJson(
      path.join(schemasDir, `${col.$id}.schema.json`),
      schema,
      { spaces: 2 }
    );
    console.log(`🧩 Schema saved: ${col.$id}`);

    // 2) Data (documents → JSONL)
    const outPath = path.join(dataDir, `${col.$id}.jsonl`);
    const stream = fs.createWriteStream(outPath, { flags: "w" });

    let cursor = null;
    while (true) {
      const queries = [Query.limit(PAGE_LIMIT)];
      if (cursor) queries.push(Query.cursorAfter(cursor));
      const page = await db.listDocuments(APPWRITE_DATABASE_ID, col.$id, queries);
      for (const doc of page.documents) {
        stream.write(JSON.stringify(doc) + "\n");
      }
      if (page.documents.length < PAGE_LIMIT) break;
      cursor = page.documents[page.documents.length - 1].$id;
    }
    stream.end();
    console.log(`📦 Data saved: ${col.$id} → data/${col.$id}.jsonl`);
  }

  console.log("✅ Schemas & data export complete.");
}

async function exportAuth(client) {
  const usersSDK = new Users(client);
  const teamsSDK = new Teams(client);
  const authDir = path.join(OUTPUT_DIR, "auth");
  await fs.ensureDir(authDir);

  const users = await listAllPaged((queries) => usersSDK.list(queries), "users");
  await fs.writeJson(path.join(authDir, "users.json"), users, { spaces: 2 });
  console.log(`👥 Users exported: ${users.length}`);

  const teams = await listAllPaged((queries) => teamsSDK.list(queries), "teams");
  await fs.writeJson(path.join(authDir, "teams.json"), teams, { spaces: 2 });
  console.log(`👥‍👥 Teams exported: ${teams.length}`);

  const membershipsAll = [];
  for (const t of teams) {
    const memberships = await listAllPaged(
      (queries) => teamsSDK.listMemberships(t.$id, queries),
      "memberships"
    );
    membershipsAll.push({ teamId: t.$id, teamName: t.name, memberships });
  }
  await fs.writeJson(path.join(authDir, "team_memberships.json"), membershipsAll, { spaces: 2 });
  console.log("🔐 Team memberships exported.");
}

(async function main() {
  try {
    assertEnvExport();
    await fs.ensureDir(OUTPUT_DIR);

    const client = buildClient();
    console.log(`➡️ Exporting from DB=${APPWRITE_DATABASE_ID} → ${OUTPUT_DIR}`);

    await exportDatabaseMeta(client);
    await exportSchemasAndData(client);
    await exportAuth(client);

    console.log("\n🎉 Export complete.");
  } catch (err) {
    console.error("❌ Export failed:", err?.message ?? err);
    if (err?.response) {
      console.error("Response:", JSON.stringify(err.response, null, 2));
    }
    process.exit(1);
  }
})();
