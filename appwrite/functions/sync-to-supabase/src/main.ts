import "dotenv/config";
import { Client, Users, Teams, Databases, Query } from "node-appwrite";
import { createClient } from "@supabase/supabase-js";

const {
  APPWRITE_ENDPOINT,
  APPWRITE_PROJECT_ID,
  APPWRITE_API_KEY,
  APPWRITE_DATABASE_ID = "b2b",
  APPWRITE_VENDORS_COLLECTION_ID = "vendors",
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_SCHEMA = "gold",
} = process.env;

const aw = new Client()
  .setEndpoint(APPWRITE_ENDPOINT!)
  .setProject(APPWRITE_PROJECT_ID!)
  .setKey(APPWRITE_API_KEY!);

const awUsers = new Users(aw);
const awTeams = new Teams(aw);
const awDb = new Databases(aw);

const sb = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

const sbTable = (table: string) => sb.schema(SUPABASE_SCHEMA!).from(table);

type VendorDoc = {
  $id: string;
  name?: string;
  slug?: string;
  billing_email?: string;
  owner_user_id?: string;
  status?: string;
  team_id?: string;
  domains?: string[];
};

function normalizeVendorStatus(status?: string | null): "active" | "inactive" | "suspended" {
  const s = String(status || "active").toLowerCase();
  if (["active", "enabled", "pending"].includes(s)) return "active";
  if (["suspended", "paused"].includes(s)) return "suspended";
  return "inactive";
}

function normalizeRole(input?: string | null): "vendor_viewer" | "vendor_operator" | "vendor_admin" {
  const role = String(input || "viewer").toLowerCase();
  if (role.includes("admin")) return "vendor_admin";
  if (role.includes("operator")) return "vendor_operator";
  return "vendor_viewer";
}

function emailDomain(email?: string) {
  if (!email) return null;
  const idx = email.indexOf("@");
  if (idx < 0) return null;
  return email.slice(idx + 1).toLowerCase();
}

async function upsertVendors(vendors: VendorDoc[]) {
  if (!vendors.length) return;

  for (const v of vendors) {
    const slug = (v.slug || v.$id || "").trim();
    if (!slug) continue;

    const payload = {
      name: v.name || slug,
      slug,
      billing_email: v.billing_email ?? null,
      owner_user_id: v.owner_user_id ?? null,
      status: normalizeVendorStatus(v.status),
      team_id: v.team_id ?? null,
      domains: (v.domains ?? []).map((d) => d.toLowerCase()),
    };

    const existing = await sbTable("vendors")
      .select("id, slug")
      .eq("slug", slug)
      .maybeSingle();

    if (existing.error) throw existing.error;

    if (existing.data) {
      const upd = await sbTable("vendors")
        .update(payload)
        .eq("slug", slug)
        .select("id, slug")
        .single();
      if (upd.error) throw upd.error;
    } else {
      const ins = await sbTable("vendors")
        .insert(payload)
        .select("id, slug")
        .single();
      if (ins.error) throw ins.error;
    }
  }
}

async function fetchAllAppwriteTeams() {
  const res = await awTeams.list();
  return res.teams;
}

async function fetchAllVendorsFromAppwrite(): Promise<VendorDoc[]> {
  const res = await awDb.listDocuments(APPWRITE_DATABASE_ID!, APPWRITE_VENDORS_COLLECTION_ID!, [Query.limit(1000)]);
  return res.documents as unknown as VendorDoc[];
}

async function resolveVendorBySlug(slug: string) {
  const row = await sbTable("vendors").select("id, slug").eq("slug", slug).maybeSingle();
  if (row.error) throw row.error;
  return row.data;
}

async function ensureUserAndLink(params: {
  appwriteUserId: string;
  email: string;
  fullName?: string | null;
  vendorId: string;
  role: "vendor_viewer" | "vendor_operator" | "vendor_admin";
}) {
  const email = params.email.toLowerCase();
  const displayName = (params.fullName && params.fullName.trim()) || email.split("@")[0];

  let userId: string;

  const byAppwrite = await sbTable("b2b_users")
    .select("id, email, display_name, appwrite_user_id")
    .eq("appwrite_user_id", params.appwriteUserId)
    .maybeSingle();

  if (byAppwrite.error) throw byAppwrite.error;

  if (byAppwrite.data) {
    userId = byAppwrite.data.id;
    const upd = await sbTable("b2b_users")
      .update({
        email,
        display_name: byAppwrite.data.display_name || displayName,
        vendor_id: params.vendorId,
      })
      .eq("id", userId);
    if (upd.error) throw upd.error;
  } else {
    const byEmail = await sbTable("b2b_users")
      .select("id, email, display_name, appwrite_user_id")
      .eq("email", email)
      .maybeSingle();

    if (byEmail.error) throw byEmail.error;

    if (byEmail.data) {
      userId = byEmail.data.id;
      const upd = await sbTable("b2b_users")
        .update({
          display_name: byEmail.data.display_name || displayName,
          appwrite_user_id: byEmail.data.appwrite_user_id || params.appwriteUserId,
          vendor_id: params.vendorId,
        })
        .eq("id", userId);
      if (upd.error) throw upd.error;
    } else {
      const ins = await sbTable("b2b_users")
        .insert({
          email,
          display_name: displayName,
          appwrite_user_id: params.appwriteUserId,
          source: "appwrite",
          vendor_id: params.vendorId,
          status: "active",
        })
        .select("id")
        .single();
      if (ins.error) throw ins.error;
      userId = ins.data.id;
    }
  }

  const link = await sbTable("b2b_user_links")
    .select("user_id, vendor_id, role")
    .eq("user_id", userId)
    .maybeSingle();

  if (link.error) throw link.error;

  if (!link.data) {
    const ins = await sbTable("b2b_user_links").insert({
      user_id: userId,
      vendor_id: params.vendorId,
      role: params.role,
      status: "active",
    });
    if (ins.error) throw ins.error;
  } else if (link.data.vendor_id !== params.vendorId || link.data.role !== params.role) {
    const upd = await sbTable("b2b_user_links")
      .update({
        vendor_id: params.vendorId,
        role: params.role,
        status: "active",
      })
      .eq("user_id", userId);
    if (upd.error) throw upd.error;
  }
}

async function main() {
  if (process.env.ALLOW_DIRECT_DB_SYNC !== "1") {
    console.log(
      "[sync-to-supabase] direct Supabase mutation is disabled. " +
      "Use backend /onboard/self for runtime user provisioning."
    );
    return;
  }

  const [vendors, teams] = await Promise.all([fetchAllVendorsFromAppwrite(), fetchAllAppwriteTeams()]);
  await upsertVendors(vendors);

  const teamToVendor = new Map<string, VendorDoc>();
  const domainToVendor = new Map<string, VendorDoc>();
  for (const v of vendors) {
    if (v.team_id) teamToVendor.set(v.team_id, v);
    for (const d of v.domains ?? []) domainToVendor.set(d.toLowerCase(), v);
  }

  // Preload memberships once per team to reduce API calls.
  const membershipsByTeam = new Map<string, Array<{ userId: string; roles?: string[] }>>();
  for (const t of teams) {
    try {
      const memberships = await awTeams.listMemberships(t.$id);
      membershipsByTeam.set(
        t.$id,
        memberships.memberships.map((m: any) => ({ userId: m.userId, roles: m.roles || [] }))
      );
    } catch {
      membershipsByTeam.set(t.$id, []);
    }
  }

  let cursor: string | undefined;
  for (;;) {
    const page: { users: any[]; total: number } = await awUsers.list(undefined, cursor);

    for (const u of page.users) {
      const appwriteUserId = String(u.$id);
      const email = String(u.email || "").toLowerCase();
      if (!email) continue;

      const domain = emailDomain(email);
      let vendor: VendorDoc | undefined;
      let role: "vendor_viewer" | "vendor_operator" | "vendor_admin" = "vendor_viewer";

      for (const t of teams) {
        const members = membershipsByTeam.get(t.$id) || [];
        const m = members.find((x) => x.userId === appwriteUserId);
        if (!m) continue;

        const v = teamToVendor.get(t.$id);
        if (v) {
          vendor = v;
          role = normalizeRole((m.roles || [])[0] || "viewer");
          break;
        }
      }

      if (!vendor && domain) vendor = domainToVendor.get(domain);
      if (!vendor) {
        console.warn(`No vendor resolved for user ${appwriteUserId} (${email}). Skipping.`);
        continue;
      }

      const slug = (vendor.slug || vendor.$id || "").trim();
      if (!slug) continue;

      const vendorRow = await resolveVendorBySlug(slug);
      if (!vendorRow) {
        console.warn(`Vendor '${slug}' not found in Supabase after upsert. Skipping user ${email}.`);
        continue;
      }

      await ensureUserAndLink({
        appwriteUserId,
        email,
        fullName: u.name || null,
        vendorId: vendorRow.id,
        role,
      });
    }

    if (!page.total || !page.users.length || page.users.length < 25) break;
    cursor = page.users[page.users.length - 1].$id;
  }

  console.log("Appwrite -> Supabase sync completed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
