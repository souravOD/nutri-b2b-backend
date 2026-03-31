import type { Request, Response, NextFunction } from "express";
import { db } from "../lib/database.js";
import { sql } from "drizzle-orm";

/**
 * IP Allowlist middleware (PRD: Compliance & Security).
 *
 * If a vendor has entries in gold.b2b_ip_allowlist, only requests from those
 * CIDR ranges are permitted. If the table is empty for the vendor, all IPs
 * are allowed (allowlist disabled).
 *
 * Must be mounted AFTER withAuth so req.auth is populated.
 */
export async function ipAllowlistMiddleware(
  req: Request & { auth?: { vendorId?: string } },
  res: Response,
  next: NextFunction
): Promise<void> {
  const vendorId = req.auth?.vendorId;
  if (!vendorId) {
    // No vendor context — let auth middleware handle the rejection
    return next();
  }

  // Resolve the real client IP (respect X-Forwarded-For when behind a proxy)
  const forwarded = req.headers["x-forwarded-for"];
  const clientIp = (
    (typeof forwarded === "string" ? forwarded.split(",")[0] : undefined) ??
    req.socket?.remoteAddress ??
    ""
  ).trim();

  if (!clientIp) {
    return next();
  }

  try {
    // Check how many CIDR entries exist for this vendor
    const countResult = await db.execute(sql`
      SELECT COUNT(*)::int AS total
      FROM gold.b2b_ip_allowlist
      WHERE vendor_id = ${vendorId}::uuid
    `);
    const total: number = (countResult.rows ?? countResult as any[])[0]?.total ?? 0;

    // No entries → allowlist disabled for this vendor
    if (total === 0) {
      return next();
    }

    // Check whether clientIp falls within any configured CIDR
    const matchResult = await db.execute(sql`
      SELECT 1
      FROM gold.b2b_ip_allowlist
      WHERE vendor_id = ${vendorId}::uuid
        AND ${clientIp}::inet <<= cidr
      LIMIT 1
    `);
    const matched = ((matchResult.rows ?? matchResult as any[]).length ?? 0) > 0;

    if (!matched) {
      res.status(403).json({
        ok: false,
        error: "Access denied: your IP address is not on the allowlist for this account.",
      });
      return;
    }

    return next();
  } catch {
    // On DB error, fail open — don't block legitimate users due to infra issues
    return next();
  }
}
