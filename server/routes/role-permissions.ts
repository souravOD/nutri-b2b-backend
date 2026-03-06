// ─── Role Permissions Router ─────────────────────────────────────────────────
// GET/PUT gold.b2b_role_permissions for Settings > Role Permissions tab
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type Request, type Response } from "express";
import { requireAuth, requirePermissionMiddleware, type AuthContext } from "../lib/auth.js";
import { db } from "../lib/database.js";
import { sql } from "drizzle-orm";

const router = Router();

const EDITABLE_ROLES = ["vendor_admin", "vendor_viewer"] as const;
const VALID_PERMISSIONS = new Set([
  "read:products", "write:products", "read:customers", "write:customers",
  "read:ingest", "write:ingest", "read:matches", "read:audit",
  "manage:users", "manage:api_keys", "manage:settings",
  "read:vendors", "write:vendors",
]);

// ── GET /role-permissions ────────────────────────────────────────────────────
// Returns role-to-permissions mapping for the current vendor (or global for superadmin)
router.get(
  "/",
  requireAuth as any,
  requirePermissionMiddleware("manage:settings") as any,
  async (req: Request, res: Response) => {
    try {
      const auth: AuthContext = (req as any).auth;
      const vendorId = auth.vendorId;
      const queryVendorId = (req.query.vendor_id as string) || undefined;

      // Superadmin can query any vendor; others use their vendorId
      const targetVendorId = auth.role === "superadmin" && queryVendorId
        ? queryVendorId
        : vendorId;

      // Query vendor-specific + global defaults (vendor_id IS NULL)
      const result = targetVendorId
        ? await db.execute(sql`
            SELECT role, permission
            FROM gold.b2b_role_permissions
            WHERE (vendor_id = ${targetVendorId}::uuid OR vendor_id IS NULL)
              AND role IN ('vendor_admin', 'vendor_operator', 'vendor_viewer')
            ORDER BY vendor_id NULLS LAST, role, permission
          `)
        : await db.execute(sql`
            SELECT role, permission
            FROM gold.b2b_role_permissions
            WHERE vendor_id IS NULL
              AND role IN ('vendor_admin', 'vendor_operator', 'vendor_viewer')
            ORDER BY role, permission
          `);

      const byRole: Record<string, string[]> = {};
      const seen = new Set<string>();
      for (const row of result.rows as { role: string; permission: string }[]) {
        const key = `${row.role}:${row.permission}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!byRole[row.role]) byRole[row.role] = [];
        byRole[row.role].push(row.permission);
      }

      // Superadmin always has * — not stored in DB
      if (auth.role === "superadmin") {
        byRole["superadmin"] = ["*"];
      }

      return res.json({ roles: byRole });
    } catch (err: any) {
      console.error("[role-permissions] GET / error:", err?.message || err);
      return res.status(500).json({ code: "internal_error", detail: "Failed to fetch role permissions" });
    }
  }
);

// ── PUT /role-permissions ────────────────────────────────────────────────────
// Update permissions for a role. Body: { role: string, permissions: string[] }
router.put(
  "/",
  requireAuth as any,
  requirePermissionMiddleware("manage:settings") as any,
  async (req: Request, res: Response) => {
    try {
      const auth: AuthContext = (req as any).auth;
      const vendorId = auth.vendorId;
      const { role, permissions } = req.body;

      if (!role || !Array.isArray(permissions)) {
        return res.status(400).json({
          code: "bad_request",
          detail: "Request body must include 'role' (string) and 'permissions' (string[])",
        });
      }

      const roleStr = String(role).toLowerCase();
      if (!EDITABLE_ROLES.includes(roleStr as any)) {
        return res.status(400).json({
          code: "bad_request",
          detail: `Role must be one of: ${EDITABLE_ROLES.join(", ")}. Superadmin cannot be modified.`,
        });
      }

      const perms = permissions
        .map((p: any) => String(p).trim())
        .filter((p: string) => p && VALID_PERMISSIONS.has(p));

      if (!vendorId) {
        return res.status(400).json({
          code: "bad_request",
          detail: "Vendor context required to update role permissions",
        });
      }

      await db.execute(sql`BEGIN`);

      try {
        // Delete existing vendor-specific permissions for this role
        await db.execute(sql`
          DELETE FROM gold.b2b_role_permissions
          WHERE vendor_id = ${vendorId}::uuid AND role = ${roleStr}
        `);

        // Insert new permissions (no conflict: we deleted first)
        for (const perm of perms) {
          await db.execute(sql`
            INSERT INTO gold.b2b_role_permissions (vendor_id, role, permission)
            VALUES (${vendorId}::uuid, ${roleStr}, ${perm})
          `);
        }

        await db.execute(sql`COMMIT`);
      } catch (txErr: any) {
        await db.execute(sql`ROLLBACK`);
        throw txErr;
      }

      return res.json({ role: roleStr, permissions: perms });
    } catch (err: any) {
      console.error("[role-permissions] PUT / error:", err?.message || err);
      return res.status(500).json({ code: "internal_error", detail: "Failed to save role permissions" });
    }
  }
);

export default router;
