import type { Request, Response, NextFunction } from "express";
import { Account, Client } from "appwrite";
import { db } from "./database.js";
import { users, userLinks } from "../../shared/schema.js";
import { eq } from "drizzle-orm";

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

const appwriteClient = new Client()
  .setEndpoint(process.env.APPWRITE_ENDPOINT!)
  .setProject(process.env.APPWRITE_PROJECT_ID!);

const account = new Account(appwriteClient);

function extractJWT(req: Request): string | null {
  const h = Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization;
  if (h?.startsWith("Bearer ")) return h.slice(7);
  const x = req.headers["x-appwrite-jwt"];
  return typeof x === "string" ? x : null;
}

function computePermissions(role: AuthContext["role"]): string[] {
  if (role === "superadmin") return ["*"];
  if (role === "vendor_admin")
    return ["read:vendors","write:vendors","read:products","write:products","read:customers","write:customers","read:ingest","write:ingest","read:matches","read:audit"];
  if (role === "vendor_operator")
    return ["read:products","write:products","read:customers","write:customers","read:ingest","write:ingest","read:matches"];
  return ["read:products","read:customers","read:matches"];
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const jwt = extractJWT(req);
    if (!jwt) return res.status(401).json({ type:"about:blank", title:"Unauthorized", status:401, detail:"Missing JWT" });

    // Validate with Appwrite
    appwriteClient.setJWT(jwt);
    const me = await account.get(); // throws if invalid
    const email = (me as any).email as string;

    // Resolve local user and vendor/role
    const userRow = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
    if (!userRow) return res.status(403).json({ type:"about:blank", title:"Forbidden", status:403, detail:"User not provisioned" });

    const link = (await db.select().from(userLinks).where(eq(userLinks.userId, userRow.id)).limit(1))[0];
    if (!link) return res.status(403).json({ type:"about:blank", title:"Forbidden", status:403, detail:"No vendor access" });

    (req as any).auth = {
      userId: userRow.id,
      email,
      vendorId: link.vendorId,
      role: link.role as any,
      permissions: computePermissions(link.role as any),
    };
    next();
  } catch (err) {
    console.error("[auth] verification error", err);
    return res.status(401).json({ type:"about:blank", title:"Unauthorized", status:401, detail:"Invalid JWT" });
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
