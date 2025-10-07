import dotenv from "dotenv";
import fs from "fs-extra";
import path from "node:path";
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
  APPWRITE_DATABASE_ID,
  INPUT_DIR = "./appwrite-export",
} = process.env;

const PAGE_LIMIT = 100;

/** ---- Helpers ---- */
function assertEnv() {
  const missing = [
    "APPWRITE_ENDPOINT",
    "APPWRITE_PROJECT_ID",
    "APPWRITE_API_KEY",
    "APPWRITE_DATABASE_ID",
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

function stripMeta(doc) {
  // Return data without Appwrite meta keys ($id, $collectionId, etc.)
  const out = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k.startsWith("$")) continue;
    out[k] = v;
  }
  return out;
}

async function readJSON(filePath, fallback = []) {
  if (!(await fs.pathExists(filePath))) return fallback;
  return fs.readJson(filePath);
}

async function importUsers(client) {
  const usersSDK = new Users(client);

  const usersPath = path.join(INPUT_DIR, "users.json");
  const users = await readJSON(usersPath, []);
  if (!users.length) {
    console.log("No users.json found or file empty, skipping users…");
    return {};
  }

  console.log(`👥 Importing ${users.length} users…`);

  const idMap = {}; // oldUserId -> newUserId (we preserve IDs, but map anyway)

  for (const u of users) {
    const userId = u.$id;              // from export
    const email = u.email || undefined;
    const name = u.name || undefined;

    // We do NOT know original passwords (and shouldn’t); create temp passwords.
    const tempPassword = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

    try {
      // Plain-text create (Users.create). node-appwrite supports this signature.
      // Example from npm docs: users.create(ID.unique(), "email", "+123", "password", "Name")
      // We keep the original userId for referential integrity.
      await usersSDK.create(userId, email ?? "", null, tempPassword, name);
      idMap[userId] = userId;

      // Restore email verification flag if present
      if (typeof u.emailVerification === "boolean") {
        await usersSDK.updateEmailVerification(userId, u.emailVerification); // API exists in server SDK
      }

      // Restore name if needed (some exports may include empty name)
      if (name && name !== u.name) {
        await usersSDK.updateName(userId, name);
      }
    } catch (err) {
      if (err?.code === 409) {
        console.warn(`  ↳ user ${userId} already exists, skipping`);
        idMap[userId] = userId;
      } else {
        console.error(`  ✖ failed user ${userId}:`, err?.message ?? err);
      }
    }
  }

  console.log("✅ Users import finished.");
  return idMap;
}

async function importTeamsAndMemberships(client, userIdMap) {
  const teamsSDK = new Teams(client);

  const teamsPath = path.join(INPUT_DIR, "teams.json");
  const teams = await readJSON(teamsPath, []);
  if (!teams.length) {
    console.log("No teams.json found or file empty, skipping teams…");
    return;
  }

  console.log(`👤‍👤 Importing ${teams.length} teams…`);

  // 1) Create teams with same IDs
  for (const t of teams) {
    const teamId = t.$id;
    const name = t.name || "Team";
    try {
      await teamsSDK.create(teamId, name);
    } catch (err) {
      if (err?.code === 409) {
        console.warn(`  ↳ team ${teamId} already exists, skipping create`);
      } else {
        console.error(`  ✖ failed team ${teamId}:`, err?.message ?? err);
      }
    }
  }

  // 2) Recreate memberships
  const memberPath = path.join(INPUT_DIR, "team_memberships.json");
  const teamMemberships = await readJSON(memberPath, []);
  if (!teamMemberships.length) {
    console.log("No team_memberships.json found, skipping memberships…");
    return;
  }

  console.log(`🔐 Recreating team memberships…`);
  for (const entry of teamMemberships) {
    const teamId = entry.teamId;
    for (const m of entry.memberships || []) {
      const roles = m.roles || [];
      const oldUserId = m.userId;
      const newUserId = userIdMap[oldUserId] || oldUserId;
      const memberName = m.userName || m.name || undefined;

      try {
        // Server SDK: providing userId adds immediately without email invite.
        // (If email-only is provided, server still adds automatically; userId takes priority.) :contentReference[oaicite:1]{index=1}
        await teamsSDK.createMembership(teamId, roles, undefined, newUserId, undefined, undefined, memberName);
      } catch (err) {
        if (err?.code === 409) {
          console.warn(`  ↳ membership already exists team=${teamId} user=${newUserId}, skipping`);
        } else if (err?.code === 404) {
          console.warn(`  ↳ user ${newUserId} not found for team ${teamId}, skipping membership`);
        } else {
          console.error(`  ✖ failed membership team=${teamId} user=${newUserId}:`, err?.message ?? err);
        }
      }
    }
  }

  console.log("✅ Teams & memberships import finished.");
}

async function importDatabaseDocuments(client) {
  const db = new Databases(client);

  // Scan INPUT_DIR for *.jsonl (each file name is <collectionId>.jsonl)
  const files = (await fs.pathExists(INPUT_DIR)) ? await fs.readdir(INPUT_DIR) : [];
  const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
  if (!jsonlFiles.length) {
    console.log("No .jsonl collection dumps found, skipping DB docs import…");
    return;
  }

  console.log(`🗄️ Importing documents into database ${APPWRITE_DATABASE_ID} from ${jsonlFiles.length} collections…`);
  for (const file of jsonlFiles) {
    const collectionId = path.basename(file, ".jsonl");
    const fullPath = path.join(INPUT_DIR, file);
    console.log(`↳ Importing ${collectionId} from ${file}`);

    // stream line-by-line to handle large files
    const rl = require("readline").createInterface({
      input: fs.createReadStream(fullPath),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      let doc;
      try {
        doc = JSON.parse(line);
      } catch (e) {
        console.warn(`  ⚠️ bad JSON line, skipping: ${line.slice(0, 120)}…`);
        continue;
      }

      const documentId = doc.$id;
      const data = stripMeta(doc);
      const perms = Array.isArray(doc.$permissions) ? doc.$permissions : undefined;

      try {
        // createDocument(databaseId, collectionId, documentId, data, permissions?)
        await db.createDocument(APPWRITE_DATABASE_ID, collectionId, documentId, data, perms);
      } catch (err) {
        if (err?.code === 409) {
          // Already exists? choose one: skip or update. We’ll update to keep latest.
          try {
            await db.updateDocument(APPWRITE_DATABASE_ID, collectionId, documentId, data, perms);
            console.log(`  ↺ updated ${collectionId}/${documentId}`);
          } catch (e2) {
            console.warn(`  ↳ couldn’t update ${collectionId}/${documentId}: ${e2?.message ?? e2}`);
          }
        } else if (err?.code === 404) {
          console.error(`  ✖ collection ${collectionId} not found in target DB. Create it first then rerun.`);
        } else {
          console.error(`  ✖ create ${collectionId}/${documentId} failed:`, err?.message ?? err);
        }
      }
    }
  }

  console.log("✅ Database documents import finished.");
}

/** ---- main ---- */
(async function main() {
  try {
    assertEnv();
    const client = buildClient();

    // 1) Users (returns a map of old->new IDs; we preserve IDs, but mapping kept)
    const userIdMap = await importUsers(client);

    // 2) Teams & memberships (requires users present)
    await importTeamsAndMemberships(client, userIdMap);

    // 3) DB documents
    await importDatabaseDocuments(client);

    console.log("\n🎉 Import complete.");
  } catch (err) {
    console.error("❌ Import failed:", err?.message ?? err);
    if (err?.response) {
      console.error("Response:", JSON.stringify(err.response, null, 2));
    }
    process.exit(1);
  }
})();
