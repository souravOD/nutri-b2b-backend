import 'dotenv/config'
import { Client as AWClient, Users, Databases, Query } from 'node-appwrite'
import { createClient as createSupabase } from '@supabase/supabase-js'

/**
 * ENV — matches your .env exactly (per screenshot)
 */
const {
  APPWRITE_ENDPOINT,
  APPWRITE_PROJECT_ID,
  APPWRITE_API_KEY,
  APPWRITE_DB_ID,
  APPWRITE_VENDORS_COL = 'vendors',
  APPWRITE_USERPROFILES_COL = 'user_profiles',

  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,

  // Optional table overrides (defaults match your DB)
  SUPA_TABLE_USERS = 'users',
  SUPA_TABLE_USER_LINKS = 'user_links',
  SUPA_TABLE_VENDORS = 'vendors',
} = process.env as Record<string, string | undefined>

function req(name: string, v?: string) {
  if (!v) throw new Error(`Missing required env: ${name}`)
  return v
}

const aw = new AWClient()
  .setEndpoint(req('APPWRITE_ENDPOINT', APPWRITE_ENDPOINT)!)
  .setProject(req('APPWRITE_PROJECT_ID', APPWRITE_PROJECT_ID)!)
  .setKey(req('APPWRITE_API_KEY', APPWRITE_API_KEY)!)
// If self-hosted + self-signed TLS, uncomment:
// .setSelfSigned(true)

const awUsers = new Users(aw)
const awDb = new Databases(aw)

const sb = createSupabase(
  req('SUPABASE_URL', SUPABASE_URL)!,
  req('SUPABASE_SERVICE_ROLE_KEY', SUPABASE_SERVICE_ROLE_KEY)!,
  { auth: { persistSession: false } }
)

type VendorDoc = {
  $id: string
  name?: string
  slug?: string
  team_id?: string
  domains?: string[]
  billing_email?: string
  owner_user_id?: string
}

type UserProfileDoc = {
  $id: string           // often equals user_id, but we use explicit field below
  user_id: string       // Appwrite user $id
  vendor_id: string     // vendor slug
  full_name?: string
  role?: string
}

/* --------------------------- Supabase helpers --------------------------- */

async function ensureVendor(v: { slug: string, name?: string, team_id?: string | null, domains?: string[] | null, billing_email?: string | null, owner_user_id?: string | null }) {
  const payload = {
    slug: v.slug,
    name: v.name ?? v.slug,
    team_id: v.team_id ?? null,
    domains: v.domains ?? [],
    billing_email: v.billing_email ?? null,
    owner_user_id: v.owner_user_id ?? null,
    status: 'active',
  }

  // Try select first to keep logs clean
  let { data: existing, error: selErr } = await sb
    .from(SUPA_TABLE_VENDORS)
    .select('id, slug')
    .eq('slug', v.slug)
    .maybeSingle()

  if (selErr) throw selErr

  if (!existing) {
    const { data, error } = await sb
      .from(SUPA_TABLE_VENDORS)
      .insert(payload)
      .select('id, slug')
      .single()
    if (error) throw error
    return data
  } else {
    // Update enrich fields if changed (idempotent)
    const { data, error } = await sb
      .from(SUPA_TABLE_VENDORS)
      .update(payload)
      .eq('slug', v.slug)
      .select('id, slug')
      .single()
    if (error) throw error
    return data
  }
}

async function ensureUserByEmail(email: string, appwriteName?: string | null) {
    // Your table uses snake_case + NOT NULL
    const dnCol = (process.env.SUPA_USERS_DISPLAYNAME_COL || "display_name").trim();
  
    // Friendly fallback if name isn't present
    const fallback = email.split("@")[0];
    const display = (appwriteName && appwriteName.trim()) || fallback;
  
    // Upsert by unique email; also stamp a source for lineage if you have that column
    const base: any = { email, [dnCol]: display };
    if ("source" in (await sb.from(SUPA_TABLE_USERS).select("*").limit(0))) {
      // optional: if you added a "source" column earlier, keep it consistent
      base.source = "appwrite";
    }
  
    const { data, error } = await sb
      .from(SUPA_TABLE_USERS)
      .upsert(base, { onConflict: "email" })   // requires UNIQUE(users.email) — you have this
      .select("id, email")
      .single();
  
    if (error) throw error;
    return data!;
  }

  async function ensureUserLink(userId: string, vendorId: string, role = 'viewer') {
    const table    = SUPA_TABLE_USER_LINKS;                           // default 'user_links'
    const userCol  = (process.env.SUPA_USERLINKS_USER_COL   || 'user_id').trim();
    const vendCol  = (process.env.SUPA_USERLINKS_VENDOR_COL || 'vendor_id').trim();
    const roleCol  = (process.env.SUPA_USERLINKS_ROLE_COL   || 'role').trim();   // 'none' to skip
    const statCol  = (process.env.SUPA_USERLINKS_STATUS_COL || 'status').trim(); // 'none' to skip
  
    // Map incoming roles (from Appwrite user_profiles.role) → your enum values.
    // Override or extend via SUPA_ROLE_MAP_JSON if your enum labels differ.
    const DEFAULT_ROLE = (process.env.SUPA_USER_ROLE_DEFAULT || 'vendor_viewer').trim();
    const MAP: Record<string, string> = {
      viewer: 'vendor_viewer',
      operator: 'vendor_operator',
      admin: 'vendor_admin',
      superadmin: 'super_admin',
      super_admin: 'super_admin',
      vendor_viewer: 'vendor_viewer',
      vendor_operator: 'vendor_operator',
      vendor_admin: 'vendor_admin',
    };
    let envMap: Record<string, string> = {};
    try {
      if (process.env.SUPA_ROLE_MAP_JSON) envMap = JSON.parse(process.env.SUPA_ROLE_MAP_JSON);
    } catch { /* ignore bad JSON */ }
    const roleKey = (role || '').toLowerCase().trim();
    const finalRole = (envMap[roleKey] || MAP[roleKey] || DEFAULT_ROLE);
  
    // exists?
    const { data: existing, error: selErr } = await sb
      .from(table)
      .select(`${userCol}, ${vendCol}`)
      .eq(userCol, userId)
      .eq(vendCol, vendorId)
      .maybeSingle();
    if (selErr) throw selErr;
    if (existing) return;
  
    const row: any = { [userCol]: userId, [vendCol]: vendorId };
    if (roleCol.toLowerCase() !== 'none')   row[roleCol]  = finalRole;
    if (statCol.toLowerCase() !== 'none')   row[statCol]  = 'active';
  
    const { error } = await sb.from(table).insert(row);
    if (error) {
      // Helpful log if enum mismatch still happens
      console.error('Failed to insert user_link row:', row, error);
      throw error;
    }
  }

/* --------------------------- Appwrite helpers --------------------------- */

async function paginateDocuments<T = any>(dbId: string, colId: string, pageSize = 100): Promise<T[]> {
  const out: T[] = []
  let cursor: string | undefined
  for (;;) {
    const queries = [ Query.limit(pageSize) ]
    if (cursor) queries.push(Query.cursorAfter(cursor))
    const res = await awDb.listDocuments(dbId, colId, queries)
    const docs = (res.documents ?? []) as any[]
    out.push(...docs as T[])
    if (docs.length < pageSize) break
    cursor = docs[docs.length - 1].$id
  }
  return out
}

/* ----------------------------- Migration ------------------------------- */

async function migrateVendors(dbId: string, colId: string) {
  console.log('> Migrating vendors from Appwrite DB ...')
  const vendorsAw = await paginateDocuments<VendorDoc>(dbId, colId, 100)

  for (const doc of vendorsAw) {
    const slug = (doc.slug || doc.$id || '').trim()
    if (!slug) {
      console.warn('  - skipped vendor with no slug or id:', doc)
      continue
    }
    await ensureVendor({
      slug,
      name: doc.name ?? slug,
      team_id: doc.team_id ?? null,
      domains: Array.isArray(doc.domains) ? doc.domains : [],
      billing_email: doc.billing_email ?? null,
      owner_user_id: doc.owner_user_id ?? null,
    })
    console.log(`  - upserted vendor '${slug}'`)
  }
}

async function migrateUserProfiles(dbId: string, colId: string) {
  console.log('> Migrating user profiles from Appwrite DB ...')
  const profiles = await paginateDocuments<UserProfileDoc>(dbId, colId, 100)

  for (const p of profiles) {
    const userId = p.user_id?.trim()
    const vendorSlug = p.vendor_id?.trim()

    if (!userId || !vendorSlug) {
      console.warn(`  - skipped profile ${p.$id} (missing user_id or vendor_id)`)
      continue
    }

    // fetch email/name from Appwrite Users (needs users.read)
    let email = ''
    let name: string | null = null
    try {
      const u = await awUsers.get(userId)
      // @ts-ignore
      email = (u.email || '').trim()
      // @ts-ignore
      name = (u.name || null)
    } catch (e) {
      console.warn(`  - could not load Appwrite user ${userId}; skipping profile`)
      continue
    }
    if (!email) {
      console.warn(`  - Appwrite user ${userId} has no email; skipping`)
      continue
    }

    // ensure vendor exists and obtain Supabase vendor id
    const vend = await ensureVendor({ slug: vendorSlug })
    // ensure user exists (by email) and obtain Supabase user id
    const user = await ensureUserByEmail(email, name ?? p.full_name ?? null)
    // ensure link exists
    await ensureUserLink(user.id, vend.id, p.role || 'viewer')

    console.log(`  - linked ${email} -> ${vendorSlug} (${p.role || 'viewer'})`)
  }
}

/* -------------------------------- Main --------------------------------- */

async function main() {
  const dbId = req('APPWRITE_DB_ID', APPWRITE_DB_ID)!
  const vendorsCol = req('APPWRITE_VENDORS_COL', APPWRITE_VENDORS_COL)!
  const profilesCol = req('APPWRITE_USERPROFILES_COL', APPWRITE_USERPROFILES_COL)!

  // sanity ping: list collections to confirm DB exists
  await awDb.listCollections(dbId)

  await migrateVendors(dbId, vendorsCol)
  await migrateUserProfiles(dbId, profilesCol)

  console.log('✓ Migration completed')
}

main().catch((e) => {
  console.error('Migration failed:', e?.response || e)
  process.exit(1)
})
