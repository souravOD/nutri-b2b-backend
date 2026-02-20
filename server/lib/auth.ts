import type { Request, Response, NextFunction } from "express";
import { Account, Client, Databases, Query, Teams } from "node-appwrite";
import { db } from "./database.js";
import { sql } from "drizzle-orm";

// Augment Express.Request with `auth`
declare global {
  namespace Express {
    interface Request {
      auth: AuthContext;
    }
  }
}

export interface AuthContext {
  userId: string;
  email: string;
  vendorId: string;
  role: "superadmin" | "vendor_admin" | "vendor_operator" | "vendor_viewer";
  permissions: string[];
}

type VendorHint = {
  code: "vendor_not_provisioned" | "vendor_team_mismatch" | "user_not_linked";
  detail: string;
};

type VendorRow = {
  id: string;
  slug: string | null;
  team_id: string | null;
  domains: string[] | null;
};

const appwriteClient = new Client()
  .setEndpoint(process.env.APPWRITE_ENDPOINT!)
  .setProject(process.env.APPWRITE_PROJECT_ID!);

const account = new Account(appwriteClient);

export function extractJWT(req: Request): string | null {
  const h = Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization;
  if (h?.startsWith("Bearer ")) return h.slice(7);
  const x = req.headers["x-appwrite-jwt"];
  return typeof x === "string" ? x : null;
}

function computePermissions(role: AuthContext["role"]): string[] {
  if (role === "superadmin") return ["*"];
  if (role === "vendor_admin") {
    return [
      "read:vendors",
      "write:vendors",
      "read:products",
      "write:products",
      "read:customers",
      "write:customers",
      "read:ingest",
      "write:ingest",
      "read:matches",
      "read:audit",
    ];
  }
  if (role === "vendor_operator") {
    return [
      "read:products",
      "write:products",
      "read:customers",
      "write:customers",
      "read:ingest",
      "write:ingest",
      "read:matches",
    ];
  }
  return ["read:products", "read:customers", "read:matches"];
}

const normalizeText = (v?: string | null) => {
  const t = String(v || "").trim();
  return t.length ? t : null;
};

const normalizeLower = (v?: string | null) => {
  const t = normalizeText(v);
  return t ? t.toLowerCase() : null;
};

const normalizeRole = (input?: string | null): AuthContext["role"] => {
  const role = String(input || "viewer").toLowerCase();
  if (role === "superadmin") return "superadmin";
  if (role === "admin" || role === "vendor_admin") return "vendor_admin";
  if (role === "operator" || role === "vendor_operator") return "vendor_operator";
  return "vendor_viewer";
};

const emailDomain = (email?: string | null): string | null => {
  const raw = String(email || "").trim().toLowerCase();
  const at = raw.indexOf("@");
  if (at < 0) return null;
  const d = raw.slice(at + 1);
  return d || null;
};

async function loadProfileHint(appwriteUserId: string) {
  const endpoint = process.env.APPWRITE_ENDPOINT;
  const project = process.env.APPWRITE_PROJECT_ID;
  const key = process.env.APPWRITE_API_KEY;
  const dbId = process.env.APPWRITE_DB_ID;
  const colId = process.env.APPWRITE_USERPROFILES_COL;

  if (!endpoint || !project || !key || !dbId || !colId) {
    return null;
  }

  const adminClient = new Client()
    .setEndpoint(endpoint)
    .setProject(project)
    .setKey(key);

  const adb = new Databases(adminClient);
  const teams = new Teams(adminClient);

  let profile: any = null;
  try {
    profile = await adb.getDocument(dbId, colId, appwriteUserId);
  } catch {
    // fall through
  }

  if (!profile) {
    try {
      const byUser = await adb.listDocuments(dbId, colId, [
        Query.equal("user_id", appwriteUserId),
        Query.limit(1),
      ]);
      profile = byUser.documents?.[0] || null;
    } catch {
      profile = null;
    }
  }

  if (!profile) {
    try {
      const byAppwrite = await adb.listDocuments(dbId, colId, [
        Query.equal("appwrite_user_id", appwriteUserId),
        Query.limit(1),
      ]);
      profile = byAppwrite.documents?.[0] || null;
    } catch {
      profile = null;
    }
  }

  return { profile, teams };
}

function resolveVendor(vendors: VendorRow[], opts: {
  teamId?: string | null;
  profileSlug?: string | null;
  domain?: string | null;
}) {
  const teamId = normalizeText(opts.teamId);
  const profileSlug = normalizeLower(opts.profileSlug);
  const domain = normalizeLower(opts.domain);

  const teamVendor = teamId
    ? vendors.find((v) => normalizeText(v.team_id) === teamId) || null
    : null;

  const slugVendor = profileSlug
    ? vendors.find((v) => normalizeLower(v.slug) === profileSlug) || null
    : null;

  const domainMatches = domain
    ? vendors.filter((v) => (v.domains || []).map((d) => d.toLowerCase()).includes(domain))
    : [];
  const domainVendor = domainMatches.length === 1 ? domainMatches[0] : null;

  if (domainMatches.length > 1 && !teamVendor && !slugVendor) {
    return { vendor: null, mismatch: "multiple_domain_matches" };
  }

  if (teamVendor && slugVendor && teamVendor.id !== slugVendor.id) {
    return { vendor: null, mismatch: "team_vs_slug" };
  }

  if (teamVendor && domainVendor && teamVendor.id !== domainVendor.id) {
    return { vendor: null, mismatch: "team_vs_domain" };
  }

  if (!teamVendor && slugVendor && domainVendor && slugVendor.id !== domainVendor.id) {
    return { vendor: null, mismatch: "slug_vs_domain" };
  }

  return { vendor: teamVendor || slugVendor || domainVendor || null, mismatch: null };
}

async function findTeamMembershipRole(
  teams: Teams,
  vendors: VendorRow[],
  appwriteUserId: string,
  preferredTeamId?: string | null
): Promise<{ teamId: string; role: AuthContext["role"] } | null> {
  const teamIds = Array.from(
    new Set(vendors.map((v) => normalizeText(v.team_id)).filter((v): v is string => !!v))
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
      // continue scanning
    }
  }

  return null;
}

async function buildVendorHint(appwriteUserId: string, email: string): Promise<VendorHint> {
  const vendorsRes = await db.execute(sql`
    SELECT id, slug, team_id, domains
    FROM gold.vendors
    WHERE status = 'active'
  `);
  const vendors = (vendorsRes.rows || []) as unknown as VendorRow[];

  const hintCtx = await loadProfileHint(appwriteUserId);
  const profile: any = hintCtx?.profile || null;

  const profileSlug = normalizeLower(profile?.vendor_slug || profile?.vendorSlug || profile?.vendor_id || null);
  const profileTeamId = normalizeText(profile?.team_id || profile?.teamId || null);

  let membership: { teamId: string; role: AuthContext["role"] } | null = null;
  if (hintCtx?.teams) {
    membership = await findTeamMembershipRole(hintCtx.teams, vendors, appwriteUserId, profileTeamId);
  }

  const resolved = resolveVendor(vendors, {
    teamId: membership?.teamId || profileTeamId,
    profileSlug,
    domain: emailDomain(email),
  });

  if (resolved.mismatch) {
    return {
      code: "vendor_team_mismatch",
      detail: "Vendor mapping mismatch between team/profile/domain.",
    };
  }

  if (!resolved.vendor) {
    return {
      code: "vendor_not_provisioned",
      detail: "Vendor is not provisioned for this account.",
    };
  }

  return {
    code: "user_not_linked",
    detail: "User exists in vendor context but is not linked in Supabase. Trigger /onboard/self first.",
  };
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const jwt = extractJWT(req);
    if (!jwt) {
      return res.status(401).json({
        type: "about:blank",
        title: "Unauthorized",
        status: 401,
        code: "invalid_token",
        detail: "Missing JWT",
      });
    }

    // Validate with Appwrite
    appwriteClient.setJWT(jwt);
    const me = await account.get(); // throws if invalid
    const email = (me as any).email as string;
    const appwriteUserId = (me as any).$id as string;

    // Resolve local user + vendor/role from gold shadow auth tables.
    const q = await db.execute(sql`
      SELECT
        u.id AS user_id,
        u.email AS email,
        l.vendor_id AS vendor_id,
        l.role AS role
      FROM gold.b2b_users u
      JOIN gold.b2b_user_links l
        ON l.user_id = u.id
       AND l.status = 'active'
      WHERE
        u.appwrite_user_id = ${appwriteUserId}
        OR lower(u.email) = lower(${email})
      ORDER BY
        CASE WHEN u.appwrite_user_id = ${appwriteUserId} THEN 0 ELSE 1 END,
        l.created_at ASC
      LIMIT 1
    `);

    const row: any = q.rows?.[0];
    if (!row) {
      const hint = await buildVendorHint(appwriteUserId, email);
      const status = hint.code === "user_not_linked" ? 403 : 409;
      return res.status(status).json({
        type: "about:blank",
        title: status === 403 ? "Forbidden" : "Conflict",
        status,
        code: hint.code,
        detail: hint.detail,
      });
    }

    (req as any).auth = {
      userId: row.user_id,
      email: row.email ?? email,
      vendorId: row.vendor_id,
      role: row.role as any,
      permissions: computePermissions(row.role as any),
    };

    next();
  } catch (err: any) {
    const message = err?.message || "Invalid JWT";
    console.error("[auth] verification error", message);
    return res.status(401).json({
      type: "about:blank",
      title: "Unauthorized",
      status: 401,
      code: "invalid_token",
      detail: message,
    });
  }
}

export function hasPermission(context: AuthContext, permission: string): boolean {
  return context.role === "superadmin" || context.permissions.includes("*") || context.permissions.includes(permission);
}

export function requirePermission(context: AuthContext, permission: string): void {
  if (!hasPermission(context, permission)) throw new Error(`Permission denied: ${permission}`);
}

export function requireRole(context: AuthContext, ...allowed: AuthContext["role"][]): void {
  if (context.role === "superadmin") return;
  if (!allowed.includes(context.role)) throw new Error(`Role not authorized: ${context.role}`);
}
