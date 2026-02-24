/**
 * Dual-Auth Middleware
 * -------------------
 * Supports three auth modes, auto-detected from the request:
 *   1. Bearer JWT   → Appwrite JWT (delegates to existing requireAuth)
 *   2. HMAC-SHA256  → HMAC-signed request (M2M production)
 *   3. X-API-Key    → Simple key lookup (dev/testing)
 *
 * All modes resolve to the same AuthContext shape so downstream
 * handlers don't care which path was taken.
 */

import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { db } from "../lib/database.js";
import { sql } from "drizzle-orm";
import { requireAuth, type AuthContext } from "../lib/auth.js";
import { getSecret } from "../lib/supabase.js";

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

interface ApiKeyRow {
    id: string;
    vendor_id: string;
    key_hash: string;
    hmac_secret_ref: string | null;
    scopes: string[];
    rate_limit_rpm: number;
    environment: string;
    expires_at: string | null;
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

function sha256(input: string): string {
    return crypto.createHash("sha256").update(input).digest("hex");
}

function timingSafeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Parse the HMAC Authorization header.
 * Format: HMAC-SHA256 Credential=<prefix>/<date>, SignedHeaders=<h1;h2>, Signature=<hex>
 */
function parseHmacHeader(header: string): {
    prefix: string;
    date: string;
    signedHeaders: string[];
    signature: string;
} | null {
    const match = header.match(
        /^HMAC-SHA256\s+Credential=([^/]+)\/(\d{8}),\s*SignedHeaders=([^,]+),\s*Signature=([a-f0-9]+)$/i
    );
    if (!match) return null;
    return {
        prefix: match[1],
        date: match[2],
        signedHeaders: match[3].split(";").map(h => h.trim().toLowerCase()),
        signature: match[4],
    };
}

/**
 * Recompute the expected HMAC signature for the given request.
 */
function computeHmacSignature(
    secret: string,
    method: string,
    path: string,
    date: string,
    signedHeaders: string[],
    headers: Record<string, string | string[] | undefined>,
    body: string
): string {
    // Build canonical headers string
    const canonicalHeaders = signedHeaders
        .map(h => {
            const val = headers[h];
            return `${h}:${typeof val === "string" ? val.trim() : ""}`;
        })
        .join("\n");

    // String-to-sign
    const bodyHash = sha256(body);
    const stringToSign = [
        method.toUpperCase(),
        path,
        date,
        canonicalHeaders,
        bodyHash,
    ].join("\n");

    return crypto
        .createHmac("sha256", secret)
        .update(stringToSign)
        .digest("hex");
}

// ────────────────────────────────────────────────────────────────
// Key lookup
// ────────────────────────────────────────────────────────────────

async function lookupApiKey(prefix: string): Promise<ApiKeyRow | null> {
    const result = await db.execute(sql`
    SELECT id, vendor_id, key_hash, hmac_secret_ref, scopes,
           rate_limit_rpm, environment, expires_at
    FROM gold.api_keys
    WHERE key_prefix = ${prefix}
      AND is_active = true
      AND revoked_at IS NULL
    LIMIT 1
  `);
    const row = (result.rows as unknown as ApiKeyRow[])?.[0];
    if (!row) return null;

    // Check expiry
    if (row.expires_at && new Date(row.expires_at) < new Date()) return null;

    return row;
}

async function touchLastUsed(keyId: string): Promise<void> {
    try {
        await db.execute(sql`
      UPDATE gold.api_keys SET last_used_at = now() WHERE id = ${keyId}
    `);
    } catch {
        // non-critical, log but don't fail
    }
}

function buildApiKeyAuthContext(vendorId: string, scopes: string[]): AuthContext {
    return {
        userId: "api-key",
        appwriteUserId: "api-key",
        email: "api@system",
        vendorId,
        role: "vendor_operator",     // API keys get operator-level access
        permissions: scopes,
    };
}

// ────────────────────────────────────────────────────────────────
// Main middleware
// ────────────────────────────────────────────────────────────────

/**
 * Universal auth middleware. Detects authentication mode from headers
 * and resolves to a standard AuthContext on `req.auth`.
 *
 * Priority order:
 *   1. HMAC-SHA256 Authorization header
 *   2. X-API-Key header
 *   3. Bearer JWT (Appwrite — fallback)
 */
export function universalAuth(requiredScopes?: string[]) {
    return async (req: Request & { auth?: AuthContext }, res: Response, next: NextFunction) => {
        const authHeader = (req.headers.authorization || "") as string;
        const apiKeyHeader = req.headers["x-api-key"] as string | undefined;

        try {
            // ── Path 0: Dev bypass (development only, requires secret) ──
            const bypassSecret = process.env.DEV_BYPASS_SECRET;
            if (
                process.env.NODE_ENV === "development" &&
                bypassSecret &&
                req.headers["x-dev-bypass"] === bypassSecret
            ) {
                req.auth = {
                    userId: "dev-user",
                    appwriteUserId: "dev-user",
                    email: "dev@localhost",
                    vendorId: req.headers["x-dev-vendor-id"] as string || "00000000-0000-0000-0000-000000000000",
                    role: "superadmin",
                    permissions: ["*"],
                };
                console.warn("[universalAuth] ⚠️  DEV BYPASS active — not for production!");
                return next();
            }

            // ── Path 1: HMAC-SHA256 ──────────────────────────────────
            if (authHeader.startsWith("HMAC-SHA256")) {
                const parsed = parseHmacHeader(authHeader);
                if (!parsed) {
                    return res.status(401).json({ code: "invalid_hmac", message: "Malformed HMAC Authorization header" });
                }

                // Timestamp check — dual mode:
                //  • New: x-timestamp header (ISO 8601) validated within ±15 min
                //  • Legacy: YYYYMMDD in HMAC Credential ±1 day (existing clients)
                const STRICT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
                const xTimestamp = req.headers["x-timestamp"] as string | undefined;

                if (xTimestamp) {
                    // Ensure x-timestamp is covered by the HMAC signature
                    if (!parsed.signedHeaders.includes("x-timestamp")) {
                        return res.status(401).json({
                            code: "unsigned_timestamp",
                            message: "x-timestamp header must be included in SignedHeaders",
                        });
                    }
                    // Strict mode: x-timestamp is an ISO date string
                    const delta = Math.abs(Date.now() - new Date(xTimestamp).getTime());
                    if (Number.isNaN(delta) || delta > STRICT_WINDOW_MS) {
                        return res.status(401).json({
                            code: "expired_signature",
                            message: "Request timestamp is outside the allowed ±15 minute window",
                        });
                    }
                } else {
                    // Legacy mode: YYYYMMDD format ±1 day
                    const now = new Date();
                    const reqDate = parsed.date; // YYYYMMDD format
                    const todayStr = now.toISOString().slice(0, 10).replace(/-/g, "");
                    if (reqDate !== todayStr) {
                        const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10).replace(/-/g, "");
                        const tomorrow = new Date(now.getTime() + 86400000).toISOString().slice(0, 10).replace(/-/g, "");
                        if (reqDate !== yesterday && reqDate !== tomorrow) {
                            return res.status(401).json({ code: "expired_signature", message: "Request signature date is too old" });
                        }
                    }
                }

                const keyRow = await lookupApiKey(parsed.prefix);
                if (!keyRow) {
                    return res.status(401).json({ code: "invalid_key", message: "API key not found or inactive" });
                }

                if (!keyRow.hmac_secret_ref) {
                    return res.status(401).json({ code: "hmac_not_configured", message: "HMAC secret not configured for this key" });
                }

                // Retrieve HMAC secret from Vault
                const hmacSecret = await getSecret(keyRow.hmac_secret_ref);

                // Recompute signature
                const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
                const expectedSig = computeHmacSignature(
                    hmacSecret,
                    req.method,
                    req.path,
                    parsed.date,
                    parsed.signedHeaders,
                    req.headers,
                    rawBody
                );

                if (!timingSafeEqual(expectedSig, parsed.signature)) {
                    return res.status(401).json({ code: "invalid_signature", message: "HMAC signature verification failed" });
                }

                // Check scopes
                if (requiredScopes?.length) {
                    const hasScope = requiredScopes.every(s => keyRow.scopes.includes(s) || keyRow.scopes.includes("*"));
                    if (!hasScope) {
                        return res.status(403).json({ code: "insufficient_scope", message: `Required scopes: ${requiredScopes.join(", ")}` });
                    }
                }

                req.auth = buildApiKeyAuthContext(keyRow.vendor_id, keyRow.scopes);
                void touchLastUsed(keyRow.id);
                return next();
            }

            // ── Path 2: Simple API Key ───────────────────────────────
            if (apiKeyHeader) {
                const prefix = apiKeyHeader.slice(0, 16);
                const keyRow = await lookupApiKey(prefix);
                if (!keyRow) {
                    return res.status(401).json({ code: "invalid_key", message: "API key not found or inactive" });
                }

                // Verify full key hash
                const fullHash = sha256(apiKeyHeader);
                if (!timingSafeEqual(fullHash, keyRow.key_hash)) {
                    return res.status(401).json({ code: "invalid_key", message: "API key verification failed" });
                }

                // Check scopes
                if (requiredScopes?.length) {
                    const hasScope = requiredScopes.every(s => keyRow.scopes.includes(s) || keyRow.scopes.includes("*"));
                    if (!hasScope) {
                        return res.status(403).json({ code: "insufficient_scope", message: `Required scopes: ${requiredScopes.join(", ")}` });
                    }
                }

                req.auth = buildApiKeyAuthContext(keyRow.vendor_id, keyRow.scopes);
                void touchLastUsed(keyRow.id);
                return next();
            }

            // ── Path 3: Bearer JWT (Appwrite) ────────────────────────
            return requireAuth(req, res, next);

        } catch (err: any) {
            console.error("[universalAuth] error:", err?.message || err);
            return res.status(500).json({ code: "auth_error", message: "Authentication failed" });
        }
    };
}
