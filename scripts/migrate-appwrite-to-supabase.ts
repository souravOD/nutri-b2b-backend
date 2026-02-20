import "dotenv/config";
import { Client as AWClient, Users, Databases, Query } from "node-appwrite";
import { createClient as createSupabase } from "@supabase/supabase-js";

const {
  APPWRITE_ENDPOINT,
  APPWRITE_PROJECT_ID,
  APPWRITE_API_KEY,
  APPWRITE_DB_ID,
  APPWRITE_VENDORS_COL = "vendors",
  APPWRITE_USERPROFILES_COL = "user_profiles",

  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,

  SUPA_SCHEMA = "gold",
  SUPA_TABLE_USERS = "b2b_users",
  SUPA_TABLE_USER_LINKS = "b2b_user_links",
  SUPA_TABLE_VENDORS = "vendors",
} = process.env as Record<string, string | undefined>;

function req(name: string, v?: string) {
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

const aw = new AWClient()
  .setEndpoint(req("APPWRITE_ENDPOINT", APPWRITE_ENDPOINT))
  .setProject(req("APPWRITE_PROJECT_ID", APPWRITE_PROJECT_ID))
  .setKey(req("APPWRITE_API_KEY", APPWRITE_API_KEY));

const awUsers = new Users(aw);
const awDb = new Databases(aw);

const sb = createSupabase(
  req("SUPABASE_URL", SUPABASE_URL),
  req("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY),
  { auth: { persistSession: false } }
);

const sbTable = (table: string) => sb.schema(SUPA_SCHEMA).from(table);

type VendorDoc = {
  $id: string;
  name?: string;
  slug?: string;
  team_id?: string;
  domains?: string[];
  billing_email?: string;
  owner_user_id?: string;
};

type UserProfileDoc = {
  $id: string;
  user_id: string;
  vendor_id: string;
  full_name?: string;
  role?: string;
};

type DbUser = {
  id: string;
  email: string;
  display_name: string;
  appwrite_user_id: string | null;
  vendor_id: string | null;
};

function normalizeRole(input?: string | null): "vendor_viewer" | "vendor_operator" | "vendor_admin" {
  const role = String(input || "viewer").toLowerCase();
  if (role === "admin" || role === "vendor_admin") return "vendor_admin";
  if (role === "operator" || role === "vendor_operator") return "vendor_operator";
  return "vendor_viewer";
}

async function ensureVendor(v: {
  slug: string;
  name?: string;
  team_id?: string | null;
  domains?: string[] | null;
  billing_email?: string | null;
  owner_user_id?: string | null;
}) {
  const normalizedSlug = v.slug.trim().toLowerCase();
  const payload = {
    slug: normalizedSlug,
    name: v.name ?? normalizedSlug,
    team_id: v.team_id ?? null,
    domains: (v.domains ?? []).map((d) => d.toLowerCase()),
    billing_email: v.billing_email ?? null,
    owner_user_id: v.owner_user_id ?? null,
    status: "active",
  };

  const existing = await sbTable(SUPA_TABLE_VENDORS)
    .select("id, slug")
    .eq("slug", normalizedSlug)
    .maybeSingle();

  if (existing.error) throw existing.error;

  if (existing.data) {
    const upd = await sbTable(SUPA_TABLE_VENDORS)
      .update(payload)
      .eq("slug", normalizedSlug)
      .select("id, slug")
      .single();
    if (upd.error) throw upd.error;
    return upd.data;
  }

  const ins = await sbTable(SUPA_TABLE_VENDORS)
    .insert(payload)
    .select("id, slug")
    .single();

  if (ins.error) throw ins.error;
  return ins.data;
}

async function ensureUserByIdentity(params: {
  email: string;
  displayName?: string | null;
  appwriteUserId: string;
  vendorId: string;
}): Promise<DbUser> {
  const email = params.email.trim().toLowerCase();
  const displayName = (params.displayName && params.displayName.trim()) || email.split("@")[0];

  const byAppwrite = await sbTable(SUPA_TABLE_USERS)
    .select("id, email, display_name, appwrite_user_id, vendor_id")
    .eq("appwrite_user_id", params.appwriteUserId)
    .maybeSingle();

  if (byAppwrite.error) throw byAppwrite.error;
  if (byAppwrite.data) {
    const upd = await sbTable(SUPA_TABLE_USERS)
      .update({
        email,
        display_name: byAppwrite.data.display_name || displayName,
        vendor_id: params.vendorId,
        source: "appwrite",
        status: "active",
      })
      .eq("id", byAppwrite.data.id)
      .select("id, email, display_name, appwrite_user_id, vendor_id")
      .single();

    if (upd.error) throw upd.error;
    return upd.data as DbUser;
  }

  const byEmail = await sbTable(SUPA_TABLE_USERS)
    .select("id, email, display_name, appwrite_user_id, vendor_id")
    .eq("email", email)
    .maybeSingle();

  if (byEmail.error) throw byEmail.error;
  if (byEmail.data) {
    const upd = await sbTable(SUPA_TABLE_USERS)
      .update({
        display_name: byEmail.data.display_name || displayName,
        appwrite_user_id: byEmail.data.appwrite_user_id || params.appwriteUserId,
        vendor_id: params.vendorId,
        source: "appwrite",
        status: "active",
      })
      .eq("id", byEmail.data.id)
      .select("id, email, display_name, appwrite_user_id, vendor_id")
      .single();

    if (upd.error) throw upd.error;
    return upd.data as DbUser;
  }

  const ins = await sbTable(SUPA_TABLE_USERS)
    .insert({
      email,
      display_name: displayName,
      appwrite_user_id: params.appwriteUserId,
      source: "appwrite",
      vendor_id: params.vendorId,
      status: "active",
    })
    .select("id, email, display_name, appwrite_user_id, vendor_id")
    .single();

  if (ins.error) throw ins.error;
  return ins.data as DbUser;
}

async function ensureUserLink(userId: string, vendorId: string, role: "vendor_viewer" | "vendor_operator" | "vendor_admin") {
  const existing = await sbTable(SUPA_TABLE_USER_LINKS)
    .select("user_id, vendor_id, role")
    .eq("user_id", userId)
    .maybeSingle();

  if (existing.error) throw existing.error;

  if (!existing.data) {
    const ins = await sbTable(SUPA_TABLE_USER_LINKS).insert({
      user_id: userId,
      vendor_id: vendorId,
      role,
      status: "active",
    });
    if (ins.error) throw ins.error;
    return;
  }

  if (existing.data.vendor_id !== vendorId || existing.data.role !== role) {
    const upd = await sbTable(SUPA_TABLE_USER_LINKS)
      .update({ vendor_id: vendorId, role, status: "active" })
      .eq("user_id", userId);
    if (upd.error) throw upd.error;
  }
}

async function paginateDocuments<T = any>(dbId: string, colId: string, pageSize = 100): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const queries = [Query.limit(pageSize)];
    if (cursor) queries.push(Query.cursorAfter(cursor));
    const res = await awDb.listDocuments(dbId, colId, queries);
    const docs = (res.documents ?? []) as any[];
    out.push(...(docs as T[]));
    if (docs.length < pageSize) break;
    cursor = docs[docs.length - 1].$id;
  }
  return out;
}

async function migrateVendors(dbId: string, colId: string) {
  console.log("> Migrating vendors from Appwrite DB ...");
  const vendorsAw = await paginateDocuments<VendorDoc>(dbId, colId, 100);

  for (const doc of vendorsAw) {
    const slug = (doc.slug || doc.$id || "").trim();
    if (!slug) {
      console.warn("  - skipped vendor with no slug/id", doc);
      continue;
    }

    await ensureVendor({
      slug,
      name: doc.name ?? slug,
      team_id: doc.team_id ?? null,
      domains: Array.isArray(doc.domains) ? doc.domains : [],
      billing_email: doc.billing_email ?? null,
      owner_user_id: doc.owner_user_id ?? null,
    });

    console.log(`  - upserted vendor '${slug}'`);
  }
}

async function migrateUserProfiles(dbId: string, colId: string) {
  console.log("> Migrating user profiles from Appwrite DB ...");
  const profiles = await paginateDocuments<UserProfileDoc>(dbId, colId, 100);

  for (const p of profiles) {
    const appwriteUserId = p.user_id?.trim();
    const vendorSlug = p.vendor_id?.trim();

    if (!appwriteUserId || !vendorSlug) {
      console.warn(`  - skipped profile ${p.$id} (missing user_id/vendor_id)`);
      continue;
    }

    let email = "";
    let name: string | null = null;
    try {
      const u = await awUsers.get(appwriteUserId);
      email = String((u as any).email || "").trim().toLowerCase();
      name = ((u as any).name as string) || null;
    } catch {
      console.warn(`  - could not load Appwrite user ${appwriteUserId}; skipping profile`);
      continue;
    }

    if (!email) {
      console.warn(`  - Appwrite user ${appwriteUserId} has no email; skipping`);
      continue;
    }

    const vendor = await ensureVendor({ slug: vendorSlug });
    const user = await ensureUserByIdentity({
      email,
      displayName: name ?? p.full_name ?? null,
      appwriteUserId,
      vendorId: vendor.id,
    });

    const role = normalizeRole(p.role || "viewer");
    await ensureUserLink(user.id, vendor.id, role);

    console.log(`  - linked ${email} -> ${vendorSlug} (${role})`);
  }
}

async function main() {
  const dbId = req("APPWRITE_DB_ID", APPWRITE_DB_ID);
  const vendorsCol = req("APPWRITE_VENDORS_COL", APPWRITE_VENDORS_COL);
  const profilesCol = req("APPWRITE_USERPROFILES_COL", APPWRITE_USERPROFILES_COL);

  await awDb.listCollections(dbId);

  await migrateVendors(dbId, vendorsCol);
  await migrateUserProfiles(dbId, profilesCol);

  console.log("Migration completed");
}

main().catch((e) => {
  console.error("Migration failed:", (e as any)?.response || e);
  process.exit(1);
});
