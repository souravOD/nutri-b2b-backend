import { Router, Request, Response } from "express";
import {
  Client as AppwriteClient,
  Account,
  Databases,
  Query,
} from "node-appwrite";
import { createClient as createSupabaseClient, PostgrestError } from "@supabase/supabase-js";

const router = Router();

// prove this handler served the request
router.use((_req, res, next) => {
  res.setHeader("X-Onboard-Impl", "v4-users-user_links");
  next();
});

/* -------------------- helpers & setup -------------------- */

const isProd = process.env.NODE_ENV === "production";
const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env var: ${k}`);
  return v;
};

const slugFromEmail = (email: string) => {
  const domain = (email.split("@")[1] || "").toLowerCase();
  const root = domain.split(".")[0] || domain;
  return root.replace(/[^a-z0-9]+/gi, "-");
};

const titleFromSlug = (slug: string) =>
  slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");

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

type VendorRow = { id: string; slug: string; name?: string };
type DbUserRow = { id: string; email: string | null; display_name: string | null; appwrite_user_id: string | null };

const sb = createSupabaseClient(
  env("SUPABASE_URL"),
  env("SUPABASE_SERVICE_ROLE_KEY")
);

function supabaseErrInfo(e?: any) {
  const pe = e as PostgrestError;
  if (pe && (pe.message || pe.details || pe.hint || pe.code)) {
    return {
      type: "supabase",
      code: pe.code,
      message: pe.message,
      details: pe.details,
      hint: pe.hint,
    };
  }
  return { message: (e && (e.message || String(e))) || "Unknown error" };
}

function devError(res: Response, http = 500, msg = "Onboarding failed", extra?: any) {
  if (!isProd) return res.status(http).json({ ok: false, message: msg, debug: extra });
  return res.status(http).json({ ok: false, message: msg });
}

/** users: find by appwrite_user_id, then email; create if missing. */
async function getOrCreateUser(appwriteId: string, email: string, name: string | undefined, vendorId: string): Promise<DbUserRow> {
  // by appwrite_user_id
  const q1 = await sb
    .from("users")
    .select("id, email, display_name, appwrite_user_id")
    .eq("appwrite_user_id", appwriteId)
    .maybeSingle();

  if (q1.error) {
    throw Object.assign(new Error("Failed selecting users by appwrite_user_id"), { cause: supabaseErrInfo(q1.error) });
  }
  if (q1.data) return q1.data as DbUserRow;

  // by email
  const q2 = await sb
    .from("users")
    .select("id, email, display_name, appwrite_user_id")
    .eq("email", email)
    .maybeSingle();

  if (q2.error) {
    throw Object.assign(new Error("Failed selecting users by email"), { cause: supabaseErrInfo(q2.error) });
  }
  if (q2.data) {
    // backfill appwrite_user_id / display_name if missing
    const patch: Partial<DbUserRow> = {};
    if (!q2.data.appwrite_user_id) patch.appwrite_user_id = appwriteId;
    if (!q2.data.display_name) patch.display_name = name || email;
    if (!(q2.data as any).vendor_id) (patch as any).vendor_id = vendorId;
    if (Object.keys(patch).length) {
      const upd = await sb.from("users").update(patch).eq("id", q2.data.id).select("id, email, display_name, appwrite_user_id, vendor_id").single();
      if (upd.error) {
        throw Object.assign(new Error("Failed updating users"), { cause: supabaseErrInfo(upd.error) });
      }
      return upd.data as DbUserRow;
    }
    return q2.data as DbUserRow;
  }

  // create
  const ins = await sb
    .from("users")
    .insert([{ 
      email, 
      display_name: name || email, 
      appwrite_user_id: appwriteId,
      vendor_id: vendorId,               // ✅ satisfy NOT NULL
    }])
    .select("id, email, display_name, appwrite_user_id, vendor_id")
    .single();

  if (ins.error) {
    throw Object.assign(new Error("Failed inserting users"), { cause: supabaseErrInfo(ins.error) });
  }
  return ins.data as DbUserRow;
}

/** vendors: find by slug; create with valid name if missing. */
async function getOrCreateVendor(slug: string): Promise<VendorRow> {
  const q1 = await sb
    .from("vendors")
    .select("id, slug, name")
    .eq("slug", slug)
    .maybeSingle();

  if (q1.error) {
    throw Object.assign(new Error("Failed selecting vendor"), { cause: supabaseErrInfo(q1.error) });
  }
  if (q1.data) return q1.data as VendorRow;

  const ins = await sb
    .from("vendors")
    .insert([{ slug, name: titleFromSlug(slug) }]) // name is NOT NULL in your schema
    .select("id, slug, name")
    .single();

  if (ins.error) {
    throw Object.assign(new Error("Failed inserting vendor"), { cause: supabaseErrInfo(ins.error) });
  }
  return ins.data as VendorRow;
}

/** user_links: ensure link by user_id (uuid), not appwrite_user_id. */
async function ensureUserLink(userId: string, vendorId: string) {
  const sel = await sb
    .from("user_links")
    .select("user_id, vendor_id, role")
    .eq("user_id", userId)
    .maybeSingle();

  if (sel.error) {
    throw Object.assign(new Error("Failed selecting user_link"), { cause: supabaseErrInfo(sel.error) });
  }

  if (!sel.data) {
    // role column is NOT NULL (enum). Use a valid value per your project (e.g., vendor_viewer).
    const ins = await sb.from("user_links").insert([
      { user_id: userId, vendor_id: vendorId, role: "vendor_viewer" },
    ]);
    if (ins.error) {
      throw Object.assign(new Error("Failed inserting user_link"), { cause: supabaseErrInfo(ins.error) });
    }
  } else if (sel.data.vendor_id !== vendorId) {
    const upd = await sb.from("user_links").update({ vendor_id: vendorId }).eq("user_id", userId);
    if (upd.error) {
      throw Object.assign(new Error("Failed updating user_link"), { cause: supabaseErrInfo(upd.error) });
    }
  }
}

/* -------------------- route -------------------- */

/**
 * POST /onboard/self
 * Headers: Authorization: Bearer <APPWRITE_JWT>  (or X-Appwrite-JWT)
 */
router.post("/self", async (req: Request, res: Response) => {
  const trace: string[] = [];
  try {
    const REQUIRED = [
      "APPWRITE_ENDPOINT",
      "APPWRITE_PROJECT_ID",
      "APPWRITE_API_KEY",
      "APPWRITE_DB_ID",
      "APPWRITE_USERPROFILES_COL",
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
    ];
    for (const k of REQUIRED) {
      if (!process.env[k]) return devError(res, 500, "Missing server configuration", { missing: k });
    }

    const jwt =
      (req.headers.authorization || "").replace(/^bearer\s+/i, "") ||
      String(req.headers["x-appwrite-jwt"] || "");
    if (!jwt) return devError(res, 401, "Missing JWT");

    // 1) Appwrite: who is the caller?
    trace.push("account.get");
    const me = await new Account(buildUserClient(jwt)).get();
    const userInfo = {
      appwrite_id: me.$id,
      email: me.email,
      name: (me as any).name,
      emailVerified: !!(me as any).emailVerification,
    };

    // 2) (optional) Appwrite profile (admin client) — kept in case you store vendor hints there
    trace.push("profiles.lookup");
    const adb = new Databases(buildAdminClient());
    const DB_ID = env("APPWRITE_DB_ID");
    const COL_PROFILES = env("APPWRITE_USERPROFILES_COL");
    let profileDoc: any | null = null;
    try {
      // most setups use the Appwrite user $id as the document $id
      profileDoc = await adb.getDocument(DB_ID, COL_PROFILES, userInfo.appwrite_id);
    } catch {
      // be resilient to different field names in user_profiles
      // try both appwrite_user_id and user_id
      const list = await adb.listDocuments(DB_ID, COL_PROFILES, [
        Query.or([
          Query.equal("appwrite_user_id", userInfo.appwrite_id),
          Query.equal("user_id",           userInfo.appwrite_id),
        ]),
        Query.limit(1),
      ]);
      profileDoc = list.documents?.[0] ?? null;
    }

    // 3) Resolve/ensure vendor FIRST (needed for users.vendor_id on insert)
    trace.push("vendor.resolve");
    const vendorSlug =
      (profileDoc?.vendor_slug as string) ||
      (profileDoc?.vendorSlug as string) ||
      (profileDoc?.vendor_id as string)   || // some clients store the slug under vendor_id
      slugFromEmail(userInfo.email);

    trace.push("vendor.ensure");
    const vendorRow = await getOrCreateVendor(vendorSlug);

    // 4) Ensure users row (UUID) and attach vendor_id immediately
    trace.push("users.ensure");
    const dbUser = await getOrCreateUser(
      userInfo.appwrite_id,
      userInfo.email,
      userInfo.name,
      vendorRow.id
    );

    // 5) Ensure user_links(user_id, vendor_id, role)
    trace.push("user_link.ensure");
    await ensureUserLink(dbUser.id, vendorRow.id);
    // backfill vendor_id only if null (legacy rows)
    await sb
      .from("users")
      .update({ vendor_id: vendorRow.id })
      .eq("id", dbUser.id)
      .is("vendor_id", null);

    return res.status(200).json({
      ok: true,
      user: {
        id: dbUser.id,
        email: dbUser.email,
        display_name: dbUser.display_name,
        appwrite_user_id: dbUser.appwrite_user_id,
      },
      vendor: { id: vendorRow.id, slug: vendorRow.slug, name: vendorRow.name },
      role: "vendor_viewer",
    });
  } catch (err: any) {
    console.error("[/onboard/self] error:", err?.message || err, err?.cause || "");
    return devError(res, 500, "Onboarding failed", {
      message: err?.message || String(err),
      cause: err?.cause || null,
      trace,
    });
  }
});

export default router;
