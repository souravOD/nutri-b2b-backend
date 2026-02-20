import express, { type Request, type Response, type NextFunction } from "express";
import "dotenv/config";
import http from "http";

import { registerRoutes } from "./routes.js";
import { setupVite, serveStatic, log } from "./vite.js";
import onboardRouter from "./routes/onboard.js";
import { queueProcessor } from "./workers/queue-processor.js";

const PORT = Number(process.env.PORT || 5000);
const HOST = process.env.HOST || "127.0.0.1";
const NODE_ENV = process.env.NODE_ENV || "development";
const isDev = NODE_ENV !== "production";

export const app = express();
export default app;

(async () => {
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  app.all(/^\/api(\/|$)/, (req, res, next) => {
    if (req.path.startsWith("/api/onboard")) return next();
    return res.status(404).json({
      ok: false,
      message:
        "This backend does not use '/api'. Call unprefixed routes like /products, /customers, /jobs, /metrics, /health, /onboard.",
      path: req.path,
    });
  });

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
      } catch {
        // no-op
      }
      log(line);
    });

    next();
  });

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
      res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
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

  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.get("/readyz", (_req, res) => res.json({ ok: true, env: NODE_ENV }));

  // Single onboarding implementation source.
  app.use("/onboard", onboardRouter);
  app.use("/api/onboard", onboardRouter);

  await registerRoutes(app);

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

    const jobsEnabled = process.env.B2B_ENABLE_JOBS === "1";
    const queueEnabled = process.env.START_QUEUE === "1";
    if (jobsEnabled && queueEnabled) {
      queueProcessor.start().catch((err) => console.error("queue start error:", err));
    } else {
      console.log("Queue processor is disabled (set B2B_ENABLE_JOBS=1 and START_QUEUE=1 to enable).");
    }
  });
})();
