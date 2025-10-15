import express, { type Request, type Response, type NextFunction } from "express";
import "dotenv/config";
import http from "http";

import { registerRoutes } from "./routes.js";
import { setupVite, serveStatic, log } from "./vite.js";

// DB + schema used by onboarding (unchanged behavior)
import { db } from "./lib/database.js";
import { users, vendors, userLinks } from "../shared/schema.js";
import { eq, and } from "drizzle-orm";
import onboardRouter from "./routes/onboard.js";
import { queueProcessor } from "./workers/queue-processor.js";

// Appwrite SDK for onboarding (unchanged behavior)
import {
  Client as AppwriteClient,
  Account,
  Databases,
  Query as AppwriteQuery,
} from "appwrite";

const PORT = Number(process.env.PORT || 5000);
const HOST = process.env.HOST || "127.0.0.1";
const NODE_ENV = process.env.NODE_ENV || "development";
const isDev = NODE_ENV !== "production";

/**
 * Appwrite env — kept as-is to match your setup
 */
const APPWRITE_ENDPOINT = process.env.APPWRITE_ENDPOINT!;
const APPWRITE_PROJECT_ID = process.env.APPWRITE_PROJECT_ID!;
const APPWRITE_DB_ID =
  process.env.APPWRITE_DB_ID ||
  process.env.NEXT_PUBLIC_APPWRITE_DB_ID ||
  "b2b";
const APPWRITE_USERPROFILES_COL =
  process.env.APPWRITE_USERPROFILES_COL ||
  process.env.NEXT_PUBLIC_APPWRITE_USERPROFILES_COL ||
  "user_profiles";
const APPWRITE_VENDORS_COL =
  process.env.APPWRITE_VENDORS_COL ||
  process.env.NEXT_PUBLIC_APPWRITE_VENDORS_COL ||
  "vendors";

 
export const app = express();
export default app;
  
  
(async () => {
  // const app = express();
  
  // parsers
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  /**
   * Kill any legacy /api/* calls early (unchanged behavior)
   */
  app.all(/^\/api(\/|$)/, (req, res) => {
    return res.status(404).json({
      ok: false,
      message:
        "This backend does not use '/api'. Call unprefixed routes like /products, /customers, /jobs, /metrics, /health, /onboard.",
      path: req.path,
    });
  });

  /**
   * Lightweight logger (kept same style)
   */
  app.use((req: Request, res: Response, next: NextFunction) => {
    const path = req.path || "/";
    const start = Date.now();
    const originalJson = (res.json as unknown as (...a: any[]) => any).bind(res);

    (res as any).json = (body: any, ...rest: any[]) => {
      (res as any)._sentJson = body;
      (res as any)._sentStatus = res.statusCode;
      return originalJson(body, ...rest);
    };

    res.on("finish", () => {
      if (
        !path.startsWith("/products") &&
        !path.startsWith("/customers") &&
        !path.startsWith("/jobs") &&
        !path.startsWith("/onboard")
      ) {
        return;
      }
      const ms = Date.now() - start;
      let line = `${req.method} ${path} ${res.statusCode} in ${ms}ms`;
      try {
        const captured = (res as any)._sentJson;
        if (captured) {
          const s = JSON.stringify(captured);
          if (s.length <= 200) line += ` :: ${s}`;
        }
      } catch {}
      log(line);
    });

    next();
  });

  /**
   * CORS (unchanged logic; tiny header addition for X-Appwrite-JWT)
   */
  const configuredOrigins = (process.env.CORS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const devOriginRegex = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

  app.use((req, res, next) => {
    const origin = (req.headers.origin as string) || "";

    const allow = (o: string) => {
      res.header("Access-Control-Allow-Origin", o || "*");
      res.header("Vary", "Origin");
      res.header("Access-Control-Allow-Credentials", "true");
      res.header(
        "Access-Control-Allow-Methods",
        "GET,POST,PUT,PATCH,DELETE,OPTIONS"
      );
      // 👇 added X-Appwrite-JWT; rest unchanged
      res.header(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, X-Requested-With, X-Appwrite-JWT"
      );
    };

    if (!origin) {
      if (req.method === "OPTIONS") return res.sendStatus(204);
      return next();
    }

    if (process.env.CORS_ALLOW_ALL === "1") {
      allow(origin);
      if (req.method === "OPTIONS") return res.sendStatus(204);
      return next();
    }

    if (isDev && devOriginRegex.test(origin)) {
      allow(origin);
      if (req.method === "OPTIONS") return res.sendStatus(204);
      return next();
    }

    if (!isDev && configuredOrigins.includes(origin)) {
      allow(origin);
      if (req.method === "OPTIONS") return res.sendStatus(204);
      return next();
    }

    if (req.method === "OPTIONS") {
      return res.status(403).json({ ok: false, message: "CORS blocked" });
    }
    console.warn("[CORS] blocked origin:", origin);
    return res.status(403).json({ ok: false, message: "CORS blocked" });
  });

  /**
   * Health endpoints (left open)
   */
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.get("/readyz", (_req, res) => res.json({ ok: true, env: NODE_ENV }));
  

  /**
   * Onboarding endpoint (idempotent)
   * Kept identical semantics: accepts Bearer <jwt> or X-Appwrite-JWT, reads Appwrite DB user_profiles and vendors,
   * ensures vendor/user/link rows in DB.
   */
  app.use("/onboard", onboardRouter);
  const onboardHandler = async (req: Request, res: Response) => {
    try {
      const jwt = (() => {
        const h = Array.isArray(req.headers.authorization)
          ? req.headers.authorization[0]
          : req.headers.authorization;
        if (h?.startsWith("Bearer ")) return h.slice(7);
        const x = req.headers["x-appwrite-jwt"];
        return typeof x === "string" ? x : null;
      })();

      if (!jwt) {
        return res.status(401).json({ ok: false, message: "Missing Appwrite JWT" });
      }

      const aw = new AppwriteClient()
        .setEndpoint(APPWRITE_ENDPOINT)
        .setProject(APPWRITE_PROJECT_ID)
        .setJWT(jwt);

      const account = new Account(aw);
      const me = await account.get(); // throws if invalid
      const email = (me as any).email as string;
      if (!email) {
        return res.status(400).json({ ok: false, message: "No email on Appwrite account" });
      }

      // Read profile + vendor from Appwrite DB (your current source of truth)
      const adb = new Databases(aw);

      // 1) try legacy: document $id == email
      let profileDoc: any = await adb
      .getDocument(APPWRITE_DB_ID, APPWRITE_USERPROFILES_COL, email)
      .catch(() => null);

      // 2) fallback: query by Appwrite user $id stored in user_profiles.user_id
      if (!profileDoc) {
        const list = await adb.listDocuments(
          APPWRITE_DB_ID,
          APPWRITE_USERPROFILES_COL,
          [ AppwriteQuery.equal("user_id", (me as any).$id), AppwriteQuery.limit(1) ]
        );
        profileDoc = list.documents?.[0] ?? null;
      }

      if (!profileDoc) {
        return res.status(403).json({ ok: false, message: "User profile not found in Appwrite DB" });
      }

      // Support different field names (kept from your existing behavior)
      const vendorSlug =
        (profileDoc as any).vendor_id ||
        (profileDoc as any).vendorSlug ||
        (profileDoc as any).vendor ||
        null;

      if (!vendorSlug) {
        return res.status(403).json({ ok: false, message: "No vendor mapping on profile" });
      }

      // Ensure vendor row exists (slug unique). Try enrich from Appwrite vendors doc.
      let vendorRow =
        (await db
          .select()
          .from(vendors)
          .where(eq((vendors as any).slug, vendorSlug))
          .limit(1))[0];

      if (!vendorRow) {
        // Try to fetch the vendor doc to enrich (name/domains/team_id)
        let vendorDoc: any = null;
        try {
          const vend = await adb.listDocuments(APPWRITE_DB_ID, APPWRITE_VENDORS_COL, [
            AppwriteQuery.equal("slug", vendorSlug),
            AppwriteQuery.limit(1),
          ]);
          vendorDoc = vend.documents?.[0] || null;
        } catch {
          // ignore
        }

        const insertValues: any = { slug: vendorSlug, status: "active" };
        if (vendorDoc?.domains) insertValues.domains = vendorDoc.domains;
        if (vendorDoc?.team_id) insertValues.team_id = vendorDoc.team_id;
        if (vendorDoc?.name) insertValues.name = vendorDoc.name;

        [vendorRow] = await db.insert(vendors).values(insertValues).returning();
      }

      // Ensure user exists by email
      let userRow =
        (await db
          .select()
          .from(users)
          .where(eq((users as any).email, email))
          .limit(1))[0];

      if (!userRow) {
        const displayName = ((me as any).name as string) || email.split("@")[0];
        [userRow] = await db
          .insert(users)
          .values({ email, display_name: displayName } as any) // snake_case column if your table uses it
          .returning();
      }

      // Ensure link exists (snake_case user_id/vendor_id)
      const existingLink =
        (await db
          .select()
          .from(userLinks)
          .where(
            and(
              eq((userLinks as any).user_id, userRow.id),
              eq((userLinks as any).vendor_id, vendorRow.id)
            )
          )
          .limit(1))[0];

      if (!existingLink) {
        const roleFromProfile =
          (profileDoc as any).role ||
          "vendor_viewer"; // map defaults; your DB enum may use vendor_viewer

        await db.insert(userLinks).values({
          user_id: userRow.id,
          vendor_id: vendorRow.id,
          role: roleFromProfile,
          status: "active",
        } as any);
      }

      return res.json({
        ok: true,
        user: { id: userRow.id, email },
        vendor: { id: vendorRow.id, slug: vendorSlug },
      });
    } catch (err: any) {
      console.error("[onboard/self] error", err?.message || err);
      return res.status(500).json({ ok: false, message: "Onboarding failed" });
    }
  };

  app.post("/onboard/", onboardRouter);
  app.post("/api/onboard/", onboardRouter); // alias kept for FE compatibility



  /**
   * Register the rest of the application routes (unchanged)
   */
  await registerRoutes(app);

  /**
   * Dev/Prod assets (unchanged), ESM-safe server creation
   */
  const server = http.createServer(app);

  if (NODE_ENV !== "production") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  server.listen(PORT, HOST, () => {
    console.log(`Listening on http://${HOST}:${PORT}`);
    if (isDev) {
      console.log("CORS (dev): allowing any http(s)://localhost:* and http(s)://127.0.0.1:*");
    } else {
      console.log(`CORS (prod): ${configuredOrigins.length ? configuredOrigins.join(", ") : "(none)"}`);
    }
  
    // 🔸 Start the queue processor in dev or when explicitly asked
    if (process.env.START_QUEUE === "1" || isDev) {
      queueProcessor.start().catch((err) => console.error("queue start error:", err));
    }
  });
  

})();
