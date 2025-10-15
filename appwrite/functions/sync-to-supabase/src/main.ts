// scripts/migrate-appwrite-to-supabase.ts
import 'dotenv/config'
import { Client, Users, Teams, Databases, Query } from 'node-appwrite'
import { createClient } from '@supabase/supabase-js'

const {
  APPWRITE_ENDPOINT,
  APPWRITE_PROJECT_ID,
  APPWRITE_API_KEY,
  APPWRITE_DATABASE_ID = 'b2b',
  APPWRITE_VENDORS_COLLECTION_ID = 'vendors',
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
} = process.env

// ---- Appwrite admin clients ----
const aw = new Client()
  .setEndpoint(APPWRITE_ENDPOINT!)
  .setProject(APPWRITE_PROJECT_ID!)
  .setKey(APPWRITE_API_KEY!)

const awUsers = new Users(aw)
const awTeams = new Teams(aw)
const awDb = new Databases(aw)

// ---- Supabase admin client ----
const sb = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

type VendorDoc = {
  $id: string            // e.g., 'walmart' (you use slugs as IDs in Appwrite; screenshots show this)
  name: string
  slug: string           // same as $id in your data
  billing_email?: string
  owner_user_id?: string
  created_at?: string
  status?: string
  team_id?: string
  domains?: string[]     // text[]
}

function emailDomain(email?: string) {
  if (!email) return null
  const idx = email.indexOf('@')
  if (idx < 0) return null
  return email.slice(idx + 1).toLowerCase()
}

async function upsertVendors(vendors: VendorDoc[]) {
  if (!vendors.length) return
  const payload = vendors.map(v => ({
    name: v.name,
    slug: v.slug,
    billing_email: v.billing_email ?? null,
    owner_user_id: v.owner_user_id ?? null,
    created_at: v.created_at ? new Date(v.created_at).toISOString() : new Date().toISOString(),
    status: v.status ?? 'active',
    team_id: v.team_id ?? null,
    domains: v.domains ?? [],
  }))

  const { error } = await sb.from('vendors')
    .upsert(payload, { onConflict: 'slug' })
  if (error) throw error
}

async function fetchAllAppwriteTeams() {
  const res = await awTeams.list()
  return res.teams // [{ $id, name, ... }]
}

async function fetchAllVendorsFromAppwrite(): Promise<VendorDoc[]> {
  // If the collection is small, single page is fine. Otherwise paginate.
  const res = await awDb.listDocuments(APPWRITE_DATABASE_ID!, APPWRITE_VENDORS_COLLECTION_ID!, [ Query.limit(1000) ])
  return res.documents as unknown as VendorDoc[]
}

async function buildTeamToVendorMap(vendors: VendorDoc[]) {
  const map = new Map<string, VendorDoc>()
  for (const v of vendors) if (v.team_id) map.set(v.team_id, v)
  return map
}

async function buildDomainToVendorMap(vendors: VendorDoc[]) {
  const map = new Map<string, VendorDoc>()
  for (const v of vendors) (v.domains ?? []).forEach(d => map.set(d.toLowerCase(), v))
  return map
}

async function upsertUserProfile(params: { user_id: string, vendor_slug: string, full_name?: string }) {
  const { user_id, vendor_slug, full_name } = params
  const { error } = await sb.from('user_profiles').upsert({
    user_id,
    vendor_id: vendor_slug,   // your supabase "vendors" table uses slug as PK/id in screenshots
    full_name: full_name ?? null,
    role: 'viewer',
    created_at: new Date().toISOString()
  }, { onConflict: 'user_id' })
  if (error) throw error
}

async function main() {
  // 1) Vendors
  const [vendors, teams] = await Promise.all([fetchAllVendorsFromAppwrite(), fetchAllAppwriteTeams()])
  const teamById = new Map(teams.map(t => [t.$id, t]))
  await upsertVendors(vendors)

  const teamToVendor = await buildTeamToVendorMap(vendors)
  const domainToVendor = await buildDomainToVendorMap(vendors)

  // 2) Users → user_profiles
  // Appwrite Users.list() is paginated; pull until done
  let cursor: string | undefined = undefined
  for (;;) {
    const page: { users: any[], total: number } = await awUsers.list(undefined, cursor)
    for (const u of page.users) {
      const user_id = u.$id
      const full_name = [u.name].filter(Boolean).join(' ')
      const domain = emailDomain(u.email)

      // Resolve vendor: prefer team membership if you maintain it
      let vendor: VendorDoc | undefined

      // Check teams → memberships (scan vendor teams to find membership)
      for (const t of teams) {
        // NOTE: Appwrite Users API doesn't list user memberships directly as admin.
        // We scan each team memberships and check for user id.
        try {
          const memberships = await awTeams.listMemberships(t.$id)
          if (memberships.memberships.some(m => m.userId === user_id)) {
            const v = teamToVendor.get(t.$id)
            if (v) { vendor = v; break }
          }
        } catch { /* team may have no memberships; ignore */ }
      }

      // Fallback by email domain
      if (!vendor && domain) vendor = domainToVendor.get(domain)

      if (!vendor) {
        console.warn(`No vendor resolved for user ${user_id} (${u.email}). Skipping profile upsert.`)
        continue
      }
      await upsertUserProfile({ user_id, vendor_slug: vendor.slug, full_name })
    }

    if (!page.total || !page.users.length || page.users.length < 25) break
    cursor = page.users[page.users.length - 1].$id
  }

  console.log('Migration completed.')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
