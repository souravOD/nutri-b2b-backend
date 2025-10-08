// import-appwrite-full.js (ESM)
import dotenv from "dotenv";
import fs from "fs-extra";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline";
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
  // If not provided, we read it from meta/database.json
  APPWRITE_DATABASE_ID,
  INPUT_DIR = path.join(__dirname, "appwrite-export"),
} = process.env;

const PAGE_LIMIT = 100;

function assertEnvImport() {
  const missing = [
    "APPWRITE_ENDPOINT",
    "APPWRITE_PROJECT_ID",
    "APPWRITE_API_KEY",
    "INPUT_DIR",
  ].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Missing env vars: ${missing.join(", ")}`);
}

function buildClient() {
  return new Client()
    .setEndpoint(APPWRITE_ENDPOINT)
    .setProject(APPWRITE_PROJECT_ID)
    .setKey(APPWRITE_API_KEY);
}

async function ensureDatabase(client) {
  const db = new Databases(client);
  const metaPath = path.join(INPUT_DIR, "meta", "database.json");
  const meta = await fs.readJson(metaPath);
  const databaseId = APPWRITE_DATABASE_ID || meta.$id;
  const name = meta.name || "Imported DB";
  const enabled = meta.enabled ?? true;

  try {
    await db.get(databaseId);
    console.log(`🗄️ Database exists: ${databaseId}`);
  } catch (err) {
    if (err?.code === 404) {
      console.log(`🆕 Creating database: ${databaseId} (${name})`);
      await db.create(databaseId, name, enabled);
    } else {
      throw err;
    }
  }

  return databaseId;
}

/** === Schema application ===
 * We support the common attribute/index types via SDK methods.
 * Relationship attributes are complex and may require manual steps.
 */
async function createCollectionFromSchema(db, databaseId, schema) {
  const { collection, attributes = [], indexes = [] } = schema;
  const colId = collection.$id;
  const name = collection.name || colId;
  const enabled = collection.enabled ?? true;
  const documentSecurity = collection.documentSecurity ?? false;
  const permissions = collection.permissions ?? [];

  // 1) Create collection if missing
  let exists = true;
  try {
    await db.getCollection(databaseId, colId);
  } catch (err) {
    if (err?.code === 404) exists = false;
    else throw err;
  }

  if (!exists) {
    console.log(`🆕 Creating collection: ${colId}`);
    await db.createCollection(
      databaseId,
      colId,
      name,
      permissions,
      documentSecurity,
      enabled
    );
  } else {
    console.log(`🧾 Collection exists: ${colId}`);
  }

  // 2) Ensure attributes
  // Build a set of existing attribute keys to avoid duplicates
  const existingAttr = await db.listAttributes(databaseId, colId);
  const existingKeys = new Set((existingAttr.attributes || []).map(a => a.key));

  for (const attr of attributes) {
    if (!attr?.key) continue;
    if (existingKeys.has(attr.key)) continue; // already there

    const key = attr.key;
    const required = !!attr.required;
    const isArray = !!attr.array;

    try {
      switch (attr.type) {
        case "string":
          await db.createStringAttribute(
            databaseId, colId, key, attr.size ?? 255, required,
            attr.default ?? undefined, isArray
          );
          break;
        case "integer":
          await db.createIntegerAttribute(
            databaseId, colId, key, required,
            attr.min ?? undefined, attr.max ?? undefined,
            attr.default ?? undefined, isArray
          );
          break;
        case "double":
        case "float":
          await db.createFloatAttribute(
            databaseId, colId, key, required,
            attr.min ?? undefined, attr.max ?? undefined,
            attr.default ?? undefined, isArray
          );
          break;
        case "boolean":
          await db.createBooleanAttribute(
            databaseId, colId, key, required,
            attr.default ?? undefined, isArray
          );
          break;
        case "email":
          await db.createEmailAttribute(
            databaseId, colId, key, required,
            attr.default ?? undefined, isArray
          );
          break;
        case "url":
          await db.createUrlAttribute(
            databaseId, colId, key, required,
            attr.default ?? undefined, isArray
          );
          break;
        case "ip":
          await db.createIpAttribute(
            databaseId, colId, key, required,
            attr.default ?? undefined, isArray
          );
          break;
        case "enum":
          await db.createEnumAttribute(
            databaseId, colId, key, attr.elements ?? [],
            required, attr.default ?? undefined, isArray
          );
          break;
        case "datetime":
          await db.createDatetimeAttribute(
            databaseId, colId, key, required,
            attr.default ?? undefined, isArray
          );
          break;
        // NOTE: Relationship attributes require special handling and may vary by SDK version.
        // If encountered, we skip with a warning so you can add manually if needed.
        case "relationship":
          console.warn(`⚠️ Skipping relationship attribute '${key}' on ${colId}. Please create it manually after import.`);
          break;
        default:
          console.warn(`⚠️ Unknown/unsupported attribute type '${attr.type}' for '${key}' on ${colId}; skipping.`);
      }
    } catch (e) {
      console.error(`  ✖ Failed to create attribute '${key}' on ${colId}: ${e?.message ?? e}`);
    }
  }

  // 2b) Wait for attributes to be ready
  await waitForAttributesReady(db, databaseId, colId);

  // 3) Ensure indexes
  const existingIdx = await db.listIndexes(databaseId, colId);
  const existingIndexKeys = new Set((existingIdx.indexes || []).map(i => i.key));

  for (const idx of indexes) {
    if (!idx?.key || existingIndexKeys.has(idx.key)) continue;

    try {
      await db.createIndex(
        databaseId,
        colId,
        idx.key,
        idx.type,                    // 'key', 'fulltext', 'unique', etc.
        idx.attributes || [],
        idx.orders || undefined,
      );
    } catch (e) {
      console.error(`  ✖ Failed to create index '${idx.key}' on ${colId}: ${e?.message ?? e}`);
    }
  }

  // 3b) Wait for indexes to be ready
  await waitForIndexesReady(db, databaseId, colId);
}

async function waitForAttributesReady(db, databaseId, collectionId, timeoutMs = 120000) {
  const start = Date.now();
  while (true) {
    const resp = await db.listAttributes(databaseId, collectionId);
    const pending = (resp.attributes || []).filter(a => a.status && a.status !== "available");
    if (pending.length === 0) return;
    if (Date.now() - start > timeoutMs) {
      console.warn(`⏱️ Attribute readiness timeout on ${collectionId}; continuing.`);
      return;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

async function waitForIndexesReady(db, databaseId, collectionId, timeoutMs = 120000) {
  const start = Date.now();
  while (true) {
    const resp = await db.listIndexes(databaseId, collectionId);
    const pending = (resp.indexes || []).filter(i => i.status && i.status !== "available");
    if (pending.length === 0) return;
    if (Date.now() - start > timeoutMs) {
      console.warn(`⏱️ Index readiness timeout on ${collectionId}; continuing.`);
      return;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

function stripMeta(doc) {
  const out = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k.startsWith("$")) continue;
    out[k] = v;
  }
  return out;
}

async function importSchemas(client, databaseId) {
  const db = new Databases(client);
  const schemasDir = path.join(INPUT_DIR, "schemas");
  const files = (await fs.pathExists(schemasDir)) ? await fs.readdir(schemasDir) : [];
  const schemaFiles = files.filter(f => f.endsWith(".schema.json"));

  if (!schemaFiles.length) {
    console.log("ℹ️ No schema files found; assuming DB/collections already exist.");
    return;
  }

  for (const f of schemaFiles) {
    const schema = await fs.readJson(path.join(schemasDir, f));
    await createCollectionFromSchema(db, databaseId, schema);
  }

  console.log("✅ Collections & schemas created.");
}

async function importData(client, databaseId) {
  const db = new Databases(client);
  const dataDir = path.join(INPUT_DIR, "data");
  const files = (await fs.pathExists(dataDir)) ? await fs.readdir(dataDir) : [];
  const jsonlFiles = files.filter(f => f.endsWith(".jsonl"));

  for (const f of jsonlFiles) {
    const collectionId = path.basename(f, ".jsonl");
    console.log(`📥 Importing data for ${collectionId}…`);
    const rl = readline.createInterface({
      input: fs.createReadStream(path.join(dataDir, f)),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let doc;
      try {
        doc = JSON.parse(trimmed);
      } catch (e) {
        console.warn(`  ⚠️ bad JSON line, skipping: ${trimmed.slice(0, 120)}…`);
        continue;
      }

      const documentId = doc.$id;
      const data = stripMeta(doc);
      const perms = Array.isArray(doc.$permissions) ? doc.$permissions : undefined;

      try {
        await db.createDocument(databaseId, collectionId, documentId, data, perms);
      } catch (e) {
        if (e?.code === 409) {
          try {
            await db.updateDocument(databaseId, collectionId, documentId, data, perms);
          } catch (e2) {
            console.warn(`  ↳ couldn’t update ${collectionId}/${documentId}: ${e2?.message ?? e2}`);
          }
        } else if (e?.code === 404) {
          console.error(`  ✖ collection ${collectionId} not found. Check schema import for this collection.`);
        } else {
          console.error(`  ✖ insert ${collectionId}/${documentId} failed: ${e?.message ?? e}`);
        }
      }
    }
  }

  console.log("✅ Documents import complete.");
}

async function importUsersTeams(client) {
  const usersSDK = new Users(client);
  const teamsSDK = new Teams(client);

  const usersPath = path.join(INPUT_DIR, "auth", "users.json");
  const teamsPath = path.join(INPUT_DIR, "auth", "teams.json");
  const membershipsPath = path.join(INPUT_DIR, "auth", "team_memberships.json");

  const users = (await fs.pathExists(usersPath)) ? await fs.readJson(usersPath) : [];
  const teams = (await fs.pathExists(teamsPath)) ? await fs.readJson(teamsPath) : [];
  const memberships = (await fs.pathExists(membershipsPath)) ? await fs.readJson(membershipsPath) : [];

  // Users
  for (const u of users) {
    const userId = u.$id;
    const email = u.email || "";
    const name = u.name || undefined;
    const tempPassword = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

    try {
      await usersSDK.create(userId, email, null, tempPassword, name);
      if (typeof u.emailVerification === "boolean") {
        await usersSDK.updateEmailVerification(userId, u.emailVerification);
      }
    } catch (e) {
      if (e?.code === 409) {
        // exists, ignore
      } else {
        console.error(`  ✖ user ${userId} failed: ${e?.message ?? e}`);
      }
    }
  }
  console.log(`✅ Users imported (${users.length})`);

  // Teams
  for (const t of teams) {
    try {
      await teamsSDK.create(t.$id, t.name || t.$id);
    } catch (e) {
      if (e?.code !== 409) {
        console.error(`  ✖ team ${t.$id} failed: ${e?.message ?? e}`);
      }
    }
  }
  console.log(`✅ Teams imported (${teams.length})`);

  // Memberships
  let count = 0;
  for (const entry of memberships) {
    const teamId = entry.teamId;
    for (const m of entry.memberships || []) {
      const roles = m.roles || [];
      const userId = m.userId;
      const memberName = m.userName || m.name || undefined;

      try {
        await teamsSDK.createMembership(teamId, roles, undefined, userId, undefined, undefined, memberName);
        count++;
      } catch (e) {
        if (e?.code === 409) continue; // duplicate
        if (e?.code === 404) {
          console.warn(`  ↳ user ${userId} or team ${teamId} missing; skip membership`);
          continue;
        }
        console.error(`  ✖ membership team=${teamId}, user=${userId}: ${e?.message ?? e}`);
      }
    }
  }
  console.log(`✅ Memberships imported (${count})`);
}

(async function main() {
  try {
    assertEnvImport();

    const client = buildClient();
    const databaseId = await ensureDatabase(client);

    // 1) Schemas (collections, attributes, indexes)
    await importSchemas(client, databaseId);

    // 2) Data
    await importData(client, databaseId);

    // 3) Users/Teams/Memberships
    await importUsersTeams(client);

    console.log("\n🎉 Import complete.");
  } catch (err) {
    console.error("❌ Import failed:", err?.message ?? err);
    if (err?.response) {
      console.error("Response:", JSON.stringify(err.response, null, 2));
    }
    process.exit(1);
  }
})();
