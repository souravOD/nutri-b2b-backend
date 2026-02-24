import { Router, type Request, type Response } from "express";
import { requireAuth, type AuthContext } from "../lib/auth.js";

const router = Router();

/**
 * GET /api/auth/context
 *
 * Returns the authenticated user's role, permissions, and vendor context.
 * The frontend calls this after login to populate useAuth() state so that
 * role-gating, permission checks, and vendor-scoped features work client-side.
 *
 * Requires a valid Appwrite JWT in the Authorization header.
 */
router.get(
    "/context",
    requireAuth as any,
    (req: Request, res: Response) => {
        const auth: AuthContext = (req as any).auth;
        return res.json({
            userId: auth.userId,
            email: auth.email,
            role: auth.role,
            permissions: auth.permissions,
            vendorId: auth.vendorId,
        });
    }
);

export default router;
