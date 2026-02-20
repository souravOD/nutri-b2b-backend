import { Router, Request, Response } from "express";
import {
  Client as AppwriteClient,
  Account,
  Databases,
  Query,
  Teams,
} from "node-appwrite";
import { db } from "../lib/database.js";
import { sql } from "drizzle-orm";

const router = Router();

router.use((_req, res, next) => {
  res.setHeader("X-Onboard-Impl", "v6-gold-b2b-strict-resolve");
  next();
});

const isProd = process.env.NODE_ENV === "production";
const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env var: ${k}`);
  return v;
};

type ProfileDoc = {
  user_id?: string;
  appwrite_user_id?: string;
  vendor_id?: string;
  vendor_slug?: string;
  vendorSlug?: string;
  full_name?: string;
  role?: string;
  team_id?: string;
  teamId?: string;
};

type VendorRow = {
  id: string;
  slug: string | null;
  name: string | null;
  team_id: string | null;
  domains: string[] | null;
  status: string;
};

type DbUserRow = {
  id: string;
  email: string;
  display_name: string;
  appwrite_user_id: string | null;
  vendor_id: string | null;
};

type DbUserLinkRow = {
  user_id: string;
  vendor_id: string;
  role: "superadmin" | "vendor_admin" | "vendor_operator" | "vendor_viewer";
  status: "active" | "inactive" | "suspended";
};

type TeamMembershipHit = {
  teamId: string;
  role: "superadmin" | "vendor_admin" | "vendor_operator" | "vendor_viewer";
};

const normalizeText = (value?: string | null): string | null => {
  const v = String(value || "").trim();
  return v.length ? v : null;
};

const normalizeLower = (value?: string | null): string | null => {
  const v = normalizeText(value);
  return v ? v.toLowerCase() : null;
};

const emailDomain = (email?: string | null): string | null => {
  const at = String(email || "").indexOf("@");
  if (at < 0) return null;
  const d = String(email).slice(at + 1).trim().toLowerCase();
  return d || null;
};

function normalizeRole(input?: string | null): DbUserLinkRow["role"] {
  const role = String(input || "viewer").toLowerCase();
  if (role === "superadmin") return "superadmin";
  if (role === "admin" || role === "vendor_admin") return "vendor_admin";
  if (role === "operator" || role === "vendor_operator") return "vendor_operator";
  return "vendor_viewer";
}

function extractJwt(req: Request): string | null {
  const auth = req.headers.authorization;
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim();
  const x = req.headers["x-appwrite-jwt"];
  if (typeof x === "string" && x.trim().length > 0) return x.trim();
  return null;
}

function jsonError(
  res: Response,
  status: number,
  code: "invalid_token" | "vendor_not_provisioned" | "vendor_team_mismatch" | "identity_conflict" | "onboarding_failed",
  message: string,
  debug?: any
) {
  if (!isProd && debug) {
    return res.status(status).json({ ok: false, code, message, debug });
  }
  return res.status(status).json({ ok: false, code, message });
}

const buildUserClient = (jwt: string) =>
  new AppwriteClient()
    .setEndpoint(env("APPWRITE_ENDPOINT"))
    .setProject(env("APPWRITE_PROJECT_ID"))
    .setJWT(jwt);

const buildAdminClient = () =>
  new AppwriteClient()
    .setEndpoint(env("APPWRITE_ENDPOINT"))
    .setProject(env("APPWRITE_PROJECT_ID"))
    .setKey(env("APPWRITE_API_KEY"));

async function loadProfileByUserId(adb: Databases, userId: string): Promise<ProfileDoc | null> {
  const dbId = env("APPWRITE_DB_ID");
  const colId = env("APPWRITE_USERPROFILES_COL");

  try {
    return (await adb.getDocument(dbId, colId, userId)) as unknown as ProfileDoc;
  } catch {
    // fall through to lookup queries
  }

  const byUserId = await adb.listDocuments(dbId, colId, [
    Query.equal("user_id", userId),
    Query.limit(1),
  ]);
  if (byUserId.total > 0) return byUserId.documents[0] as unknown as ProfileDoc;

  const byAppwriteId = await adb.listDocuments(dbId, colId, [
    Query.equal("appwrite_user_id", userId),
    Query.limit(1),
  ]);
  if (byAppwriteId.total > 0) return byAppwriteId.documents[0] as unknown as ProfileDoc;

  return null;
}

async function loadActiveVendors(): Promise<VendorRow[]> {
  const out = await db.execute(sql`
    SELECT id, slug, name, team_id, domains, status
    FROM gold.vendors
    WHERE status = 'active'
    ORDER BY slug NULLS LAST, name NULLS LAST
  `);
  return (out.rows || []) as unknown as VendorRow[];
}

async function findMembershipVendor(
  teams: Teams,
  vendors: VendorRow[],
  appwriteUserId: string,
  preferredTeamId?: string | null
): Promise<TeamMembershipHit | null> {
  const teamIds = Array.from(
    new Set(
      vendors
        .map((v) => normalizeText(v.team_id))
        .filter((v): v is string => !!v)
    )
  );

  if (!teamIds.length) return null;

  if (preferredTeamId && teamIds.includes(preferredTeamId)) {
    const idx = teamIds.indexOf(preferredTeamId);
    teamIds.splice(idx, 1);
    teamIds.unshift(preferredTeamId);
  }

  for (const teamId of teamIds) {
    try {
      const page = await teams.listMemberships(teamId, [
        Query.equal("userId", appwriteUserId),
        Query.limit(1),
      ]);
      const m: any = page.memberships?.[0];
      if (m) {
        const role = normalizeRole(Array.isArray(m.roles) ? m.roles[0] : "viewer");
        return { teamId, role };
      }
    } catch {
      // Ignore one-off team read failures and continue with remaining teams.
    }
  }

  return null;
}

function resolveVendor(vendors: VendorRow[], opts: {
  membershipTeamId?: string | null;
  profileVendorSlug?: string | null;
  domain?: string | null;
}) {
  const profileSlug = normalizeLower(opts.profileVendorSlug);
  const domain = normalizeLower(opts.domain);
  const membershipTeamId = normalizeText(opts.membershipTeamId);

  const teamVendor = membershipTeamId
    ? vendors.find((v) => normalizeText(v.team_id) === membershipTeamId) || null
    : null;

  const slugVendor = profileSlug
    ? vendors.find((v) => normalizeLower(v.slug) === profileSlug) || null
    : null;

  const domainMatches = domain
    ? vendors.filter((v) => (v.domains || []).map((d) => d.toLowerCase()).includes(domain))
    : [];
  const domainVendor = domainMatches.length === 1 ? domainMatches[0] : null;

  if (domainMatches.length > 1 && !teamVendor && !slugVendor) {
    return {
      vendor: null,
      source: null,
      mismatch: `Multiple active vendors match domain '${domain}'.`,
    };
  }

  if (teamVendor && slugVendor && teamVendor.id !== slugVendor.id) {
    return {
      vendor: null,
      source: null,
      mismatch: `Team vendor '${teamVendor.slug || teamVendor.id}' does not match profile vendor '${slugVendor.slug || slugVendor.id}'.`,
    };
  }

  if (teamVendor && domainVendor && teamVendor.id !== domainVendor.id) {
    return {
      vendor: null,
      source: null,
      mismatch: `Team vendor '${teamVendor.slug || teamVendor.id}' does not match domain vendor '${domainVendor.slug || domainVendor.id}'.`,
    };
  }

  if (!teamVendor && slugVendor && domainVendor && slugVendor.id !== domainVendor.id) {
    return {
      vendor: null,
      source: null,
      mismatch: `Profile vendor '${slugVendor.slug || slugVendor.id}' does not match domain vendor '${domainVendor.slug || domainVendor.id}'.`,
    };
  }

  if (teamVendor) return { vendor: teamVendor, source: "team_id", mismatch: null };
  if (slugVendor) return { vendor: slugVendor, source: "slug", mismatch: null };
  if (domainVendor) return { vendor: domainVendor, source: "domain", mismatch: null };

  return { vendor: null, source: null, mismatch: null };
}

async function getOrCreateUser(params: {
  appwriteUserId: string;
  email: string;
  displayName?: string | null;
  vendorId: string;
}): Promise<DbUserRow> {
  const email = params.email.trim().toLowerCase();
  const displayName = normalizeText(params.displayName) || email.split("@")[0] || "user";

  const byAppwrite = await db.execute(sql`
    SELECT id, email, display_name, appwrite_user_id, vendor_id
    FROM gold.b2b_users
    WHERE appwrite_user_id = ${params.appwriteUserId}
    LIMIT 1
  `);
  const hitByAppwrite = byAppwrite.rows?.[0] as DbUserRow | undefined;

  if (hitByAppwrite) {
    const upd = await db.execute(sql`
      UPDATE gold.b2b_users
      SET
        email = ${email},
        display_name = COALESCE(NULLIF(display_name, ''), ${displayName}),
        vendor_id = ${params.vendorId}::uuid,
        source = 'appwrite',
        status = 'active',
        updated_at = now()
      WHERE id = ${hitByAppwrite.id}::uuid
      RETURNING id, email, display_name, appwrite_user_id, vendor_id
    `);
    return upd.rows?.[0] as DbUserRow;
  }

  const byEmail = await db.execute(sql`
    SELECT id, email, display_name, appwrite_user_id, vendor_id
    FROM gold.b2b_users
    WHERE lower(email) = lower(${email})
    LIMIT 1
  `);
  const hitByEmail = byEmail.rows?.[0] as DbUserRow | undefined;

  if (hitByEmail) {
    if (hitByEmail.appwrite_user_id && hitByEmail.appwrite_user_id !== params.appwriteUserId) {
      throw Object.assign(new Error("Email is already linked to a different Appwrite user."), {
        code: "identity_conflict",
      });
    }

    const upd = await db.execute(sql`
      UPDATE gold.b2b_users
      SET
        appwrite_user_id = ${params.appwriteUserId},
        display_name = COALESCE(NULLIF(display_name, ''), ${displayName}),
        vendor_id = ${params.vendorId}::uuid,
        source = 'appwrite',
        status = 'active',
        updated_at = now()
      WHERE id = ${hitByEmail.id}::uuid
      RETURNING id, email, display_name, appwrite_user_id, vendor_id
    `);
    return upd.rows?.[0] as DbUserRow;
  }

  const ins = await db.execute(sql`
    INSERT INTO gold.b2b_users (
      email,
      display_name,
      appwrite_user_id,
      source,
      vendor_id,
      status
    )
    VALUES (
      ${email},
      ${displayName},
      ${params.appwriteUserId},
      'appwrite',
      ${params.vendorId}::uuid,
      'active'
    )
    RETURNING id, email, display_name, appwrite_user_id, vendor_id
  `);

  return ins.rows?.[0] as DbUserRow;
}

async function ensureUserLink(params: {
  userId: string;
  vendorId: string;
  role: DbUserLinkRow["role"];
}): Promise<DbUserLinkRow> {
  const existing = await db.execute(sql`
    SELECT user_id, vendor_id, role, status
    FROM gold.b2b_user_links
    WHERE user_id = ${params.userId}::uuid
    LIMIT 1
  `);

  const hit = existing.rows?.[0] as DbUserLinkRow | undefined;

  if (!hit) {
    const ins = await db.execute(sql`
      INSERT INTO gold.b2b_user_links (user_id, vendor_id, role, status)
      VALUES (
        ${params.userId}::uuid,
        ${params.vendorId}::uuid,
        ${params.role},
        'active'
      )
      RETURNING user_id, vendor_id, role, status
    `);
    return ins.rows?.[0] as DbUserLinkRow;
  }

  if (
    hit.vendor_id !== params.vendorId ||
    hit.role !== params.role ||
    hit.status !== "active"
  ) {
    const upd = await db.execute(sql`
      UPDATE gold.b2b_user_links
      SET
        vendor_id = ${params.vendorId}::uuid,
        role = ${params.role},
        status = 'active',
        updated_at = now()
      WHERE user_id = ${params.userId}::uuid
      RETURNING user_id, vendor_id, role, status
    `);
    return upd.rows?.[0] as DbUserLinkRow;
  }

  return hit;
}

router.post("/self", async (req: Request, res: Response) => {
  const trace: string[] = [];

  try {
    const REQUIRED = [
      "APPWRITE_ENDPOINT",
      "APPWRITE_PROJECT_ID",
      "APPWRITE_API_KEY",
      "APPWRITE_DB_ID",
      "APPWRITE_USERPROFILES_COL",
    ];
    for (const k of REQUIRED) {
      if (!process.env[k]) {
        return jsonError(res, 500, "onboarding_failed", "Missing server configuration", { missing: k });
      }
    }

    const jwt = extractJwt(req);
    if (!jwt) {
      return jsonError(res, 401, "invalid_token", "Missing Appwrite JWT.");
    }

    trace.push("account.get");
    let me: any;
    try {
      me = await new Account(buildUserClient(jwt)).get();
    } catch (err: any) {
      return jsonError(res, 401, "invalid_token", "Invalid or expired Appwrite JWT.", {
        message: err?.message || String(err),
      });
    }

    const appwriteUserId = String(me.$id);
    const email = String(me.email || "").trim().toLowerCase();
    const displayName = normalizeText((me as any).name) || email.split("@")[0] || "user";

    if (!email) {
      return jsonError(res, 409, "vendor_not_provisioned", "User email is required for vendor resolution.");
    }

    const adminClient = buildAdminClient();
    const adb = new Databases(adminClient);
    const teams = new Teams(adminClient);

    trace.push("profile.lookup");
    const profile = await loadProfileByUserId(adb, appwriteUserId);
    const profileVendorSlug = normalizeLower(
      profile?.vendor_slug || profile?.vendorSlug || profile?.vendor_id || null
    );
    const profileRole = normalizeRole(profile?.role || "viewer");
    const profileTeamId = normalizeText(profile?.team_id || profile?.teamId || null);

    trace.push("vendors.fetch_active");
    const vendors = await loadActiveVendors();

    trace.push("vendor.resolve.team_membership");
    const membership = await findMembershipVendor(teams, vendors, appwriteUserId, profileTeamId);

    trace.push("vendor.resolve.order_team_slug_domain");
    const domain = emailDomain(email);
    const resolved = resolveVendor(vendors, {
      membershipTeamId: membership?.teamId || profileTeamId,
      profileVendorSlug,
      domain,
    });

    if (resolved.mismatch) {
      return jsonError(
        res,
        409,
        "vendor_team_mismatch",
        "Vendor mapping mismatch detected between team/profile/domain.",
        {
          trace,
          mismatch: resolved.mismatch,
          profileVendorSlug,
          membershipTeamId: membership?.teamId || profileTeamId,
          domain,
        }
      );
    }

    if (!resolved.vendor) {
      return jsonError(
        res,
        409,
        "vendor_not_provisioned",
        "Vendor is not provisioned for this user. Ask your admin to pre-provision the vendor and team mapping.",
        {
          trace,
          profileVendorSlug,
          membershipTeamId: membership?.teamId || profileTeamId,
          domain,
        }
      );
    }

    const role = membership?.role || profileRole;

    trace.push("users.upsert");
    const user = await getOrCreateUser({
      appwriteUserId,
      email,
      displayName,
      vendorId: resolved.vendor.id,
    });

    trace.push("user_links.upsert");
    const link = await ensureUserLink({
      userId: user.id,
      vendorId: resolved.vendor.id,
      role,
    });

    return res.status(200).json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        appwrite_user_id: user.appwrite_user_id,
      },
      vendor: {
        id: resolved.vendor.id,
        slug: resolved.vendor.slug,
        name: resolved.vendor.name,
        team_id: resolved.vendor.team_id,
        resolution: resolved.source,
      },
      link,
    });
  } catch (err: any) {
    const code = String(err?.code || "");

    if (code === "identity_conflict") {
      return jsonError(
        res,
        409,
        "identity_conflict",
        err?.message || "Identity conflict while linking user.",
        { trace }
      );
    }

    if (code === "42P01") {
      return jsonError(
        res,
        500,
        "onboarding_failed",
        "Backend database schema is missing required gold tables. Verify DATABASE_URL points to the unified Supabase project.",
        {
          message: err?.message || String(err),
          trace,
        }
      );
    }

    console.error("[/onboard/self] error:", err?.message || err, err?.cause || "");
    return jsonError(res, 500, "onboarding_failed", "Onboarding failed", {
      message: err?.message || String(err),
      cause: err?.cause || null,
      trace,
    });
  }
});

export default router;
