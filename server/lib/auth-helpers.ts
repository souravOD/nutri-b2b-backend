import type { Request } from "express";

// ────────────────────────────────────────────────────────────────
// Shared auth / string-normalisation helpers.
// Previously duplicated in  server/lib/auth.ts  and
//                            server/routes/onboard.ts
// ────────────────────────────────────────────────────────────────

export type UserRole =
    | "superadmin"
    | "vendor_admin"
    | "vendor_operator"
    | "vendor_viewer";

/** Trim whitespace; return null when empty. */
export const normalizeText = (v?: string | null): string | null => {
    const t = String(v || "").trim();
    return t.length ? t : null;
};

/** normalizeText + toLowerCase. */
export const normalizeLower = (v?: string | null): string | null => {
    const t = normalizeText(v);
    return t ? t.toLowerCase() : null;
};

/** Map free-form role input to a canonical UserRole. */
export const normalizeRole = (input?: string | null): UserRole => {
    const role = String(input || "viewer").toLowerCase();
    if (role === "superadmin") return "superadmin";
    if (role === "admin" || role === "vendor_admin") return "vendor_admin";
    if (role === "operator" || role === "vendor_operator") return "vendor_operator";
    return "vendor_viewer";
};

/** Extract the domain from an email address; null when invalid. */
export const emailDomain = (email?: string | null): string | null => {
    const raw = String(email || "").trim().toLowerCase();
    const at = raw.indexOf("@");
    if (at < 0) return null;
    const d = raw.slice(at + 1);
    return d || null;
};

/** Extract JWT from `Authorization: Bearer …` or `x-appwrite-jwt` header. */
export function extractJWT(req: Request): string | null {
    const h = Array.isArray(req.headers.authorization)
        ? req.headers.authorization[0]
        : req.headers.authorization;
    if (h?.startsWith("Bearer ")) return h.slice(7);
    const x = req.headers["x-appwrite-jwt"];
    return typeof x === "string" ? x : null;
}
