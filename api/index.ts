import type { VercelRequest, VercelResponse } from "@vercel/node";
import express, { type Request, type Response, type NextFunction } from "express";
import "dotenv/config";
import onboardRouter from "../server/routes/onboard.js";
import { registerRoutes } from "../server/routes.js";

let appPromise: Promise<import("express").Express> | null = null;

function parseOrigins(): string[] {
  const fromEnv = process.env.CORS_ORIGINS || process.env.FRONTEND_ORIGIN || "";
  const list = fromEnv.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  return Array.from(new Set(list));
}

function devOriginOK(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\\d+)?$/i.test(origin || "");
}

async function buildApp() {
  const app = express();

  app.use(express.json({ limit: "25mb" }));
  app.use(express.urlencoded({ extended: false }));

  // CORS
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = (req.headers.origin as string) || "";
    const allow = (o: string) => {
      res.header("Access-Control-Allow-Origin", o || "*");
      res.header("Vary", "Origin");
      res.header("Access-Control-Allow-Credentials", "true");
      res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      res.header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Requested-With, X-Appwrite-JWT");
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

    const configuredOrigins = parseOrigins();
    if (configuredOrigins.length === 0) {
      if (devOriginOK(origin)) {
        allow(origin);
        if (req.method === "OPTIONS") return res.sendStatus(204);
        return next();
      }
      return res.status(403).json({ ok: false, message: "CORS blocked" });
    }

    if (configuredOrigins.includes(origin)) {
      allow(origin);
      if (req.method === "OPTIONS") return res.sendStatus(204);
      return next();
    }

    if (devOriginOK(origin)) {
      allow(origin);
      if (req.method === "OPTIONS") return res.sendStatus(204);
      return next();
    }

    return res.status(403).json({ ok: false, message: "CORS blocked" });
  });

  // /api/* is not used by the app; keep parity with local server
  app.all(/^\/api(\/|$)/, (req, res) => {
    return res.status(404).json({
      ok: false,
      message: "This backend does not use '/api'. Call unprefixed routes like /products, /customers, /jobs, /metrics, /health, /onboard.",
      path: req.path,
    });
  });

  // Onboarding routes (Router or handler)
  try {
    // If it's a Router:
    // @ts-ignore
    if (typeof (onboardRouter as any) === "function" && (onboardRouter as any).length !== 2) {
      app.use("/onboard", onboardRouter as any);
      app.use("/api/onboard", onboardRouter as any);
    } else {
      app.post("/onboard/", onboardRouter as any);
      app.post("/api/onboard/", onboardRouter as any);
    }
  } catch {
    // no-op if import fails; app will still boot
  }

  // App routes
  await registerRoutes(app);

  app.get("/healthz", (_req: Request, res: Response) => res.json({ status: "ok", env: "vercel" }));

  return app;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!appPromise) appPromise = buildApp();
  const app = await appPromise;
  return (app as any)(req, res);
}
