import type { Request, Response, NextFunction, RequestHandler } from "express";
import crypto from "crypto";
import { db } from "./database.js";
import { idempotencyKeys } from "../../shared/schema.js";
import { and, eq } from "drizzle-orm";

function hashRequest(req: Request) {
  const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
  return crypto.createHash("sha256").update(`${req.method}:${req.path}:${body}`).digest("hex");
}

export async function handleIdempotency(req: Request, res: Response): Promise<{ replayed: boolean }>{
  const key = (req.headers["idempotency-key"] as string) || null;
  if (!key) return { replayed: false };

  const reqHash = hashRequest(req);
  const existing = await db.select().from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.requestHash, reqHash)))
    .limit(1);
  const rec = existing[0];
  if (rec?.responseStatus && rec.responseBody) {
    res.status(rec.responseStatus).json(rec.responseBody);
    return { replayed: true };
  }
  if (!rec) {
    await db.insert(idempotencyKeys).values({
      key, requestHash: reqHash, responseStatus: null, responseBody: null, createdAt: new Date(),
    });
  }
  (res.locals as any).idemKey = key;
  (res.locals as any).idemReqHash = reqHash;
  return { replayed: false };
}

export async function storeIdempotencyResponse(req: Request, res: Response, status: number, body: any) {
  const key = (res.locals as any).idemKey as string | undefined;
  const reqHash = (res.locals as any).idemReqHash as string | undefined;
  if (!key || !reqHash) return;
  try {
    await db.update(idempotencyKeys)
      .set({ responseStatus: status, responseBody: body, updatedAt: new Date() })
      .where(and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.requestHash, reqHash)));
  } catch (e) {
    console.warn("[idempotency] store failed", e);
  }
}

export function withIdempotency(handler: RequestHandler): RequestHandler {
  return async (req, res, next) => {
    try {
      const { replayed } = await handleIdempotency(req, res);
      if (replayed) return;
      const result = await Promise.resolve(handler(req, res, next));
      // store what we sent
      if ((res as any)._sentJson) {
        await storeIdempotencyResponse(req, res, (res as any)._sentStatus || res.statusCode, (res as any)._sentJson);
      }
      return result;
    } catch (err) {
      return next(err);
    }
  };
}
