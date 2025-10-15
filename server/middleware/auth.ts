// server/lib/auth.ts
import type { Request, Response, NextFunction } from "express";
import { Client as AppwriteClient, Account } from "node-appwrite";

export type AuthedUser = {
  id: string;
  email: string;
  name?: string;
  emailVerified?: boolean;
  jwt: string;
};

declare global {
  // attach auth onto res.locals so handlers can read it
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      auth?: AuthedUser;
    }
  }
}

function problem(res: Response, status: number, detail: string) {
  return res
    .status(status)
    .type("application/problem+json")
    .json({
      type: "about:blank",
      title: status === 401 ? "Unauthorized" : "Forbidden",
      status,
      detail,
      instance: res.req.path,
    });
}

export function extractJwt(req: Request): string | null {
  const h = req.headers.authorization;
  if (h && /^bearer\s+/i.test(h)) return h.replace(/^bearer\s+/i, "").trim();
  const x = req.headers["x-appwrite-jwt"];
  if (typeof x === "string" && x.trim().length > 0) return x.trim();
  return null;
}

/** Proper Express middleware that verifies the Appwrite session and populates res.locals.auth */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const jwt = extractJwt(req);
    if (!jwt) return problem(res, 401, "Missing Appwrite JWT.");

    const client = new AppwriteClient()
      .setEndpoint(String(process.env.APPWRITE_ENDPOINT))
      .setProject(String(process.env.APPWRITE_PROJECT_ID))
      .setJWT(jwt);

    const account = new Account(client);
    const me = await account.get();

    res.locals.auth = {
      id: me.$id,
      email: me.email,
      name: (me as any).name,
      emailVerified: !!(me as any).emailVerification,
      jwt,
    };
    return next();
  } catch (err: any) {
    return problem(res, 401, err?.message || "Invalid or expired session.");
  }
}
