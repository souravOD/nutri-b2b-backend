/**
 * Quality Score API Routes
 *
 * GET  /api/quality/products/:id       — Single product quality score
 * GET  /api/quality/vendor-summary     — Vendor-wide quality averages
 * POST /api/quality/products/:id/rescore — Re-score a single product
 */

import { Router, Request, Response } from "express";
import { requireAuth, requirePermissionMiddleware } from "../lib/auth.js";
import { productQualityScores } from "../../shared/schema.js";
import { db } from "../lib/database.js";
import { eq } from "drizzle-orm";
import {
    scoreAndUpsert,
    getVendorQualitySummary,
} from "../services/quality-scoring.js";

const router = Router();

/**
 * GET /api/quality/products/:id
 * Fetch the stored quality score for a single product.
 * Requires: read:products
 */
router.get(
    "/products/:id",
    requireAuth as any,
    requirePermissionMiddleware("read:products") as any,
    async (req: Request, res: Response) => {
        try {
            const productId = req.params.id;
            if (!productId) {
                return res.status(400).json({ code: "bad_request", detail: "Missing product ID" });
            }

            const [score] = await db
                .select()
                .from(productQualityScores)
                .where(eq(productQualityScores.productId, productId))
                .limit(1);

            if (!score) {
                return res.status(404).json({ code: "not_found", detail: "No quality score found for this product" });
            }

            return res.json({
                productId: score.productId,
                vendorId: score.vendorId,
                overallScore: score.overallScore,
                dimensions: {
                    completeness: score.completeness,
                    accuracy: score.accuracy,
                    nutrition: score.nutritionScore,
                    image: score.imageScore,
                    allergen: score.allergenScore,
                    taxonomy: score.taxonomyScore,
                },
                missingFields: score.missingFields,
                warnings: score.warnings,
                scoredAt: score.scoredAt,
                scoredBy: score.scoredBy,
                runId: score.runId,
                grade: scoreToGrade(score.overallScore),
            });
        } catch (err: any) {
            console.error("[quality] GET /products/:id error:", err?.message || err);
            return res.status(500).json({ code: "internal_error", detail: "Failed to fetch quality score" });
        }
    },
);

/**
 * GET /api/quality/vendor-summary
 * Aggregate quality scores across all of the authenticated user's vendor's products.
 * Requires: read:vendors
 */
router.get(
    "/vendor-summary",
    requireAuth as any,
    requirePermissionMiddleware("read:vendors") as any,
    async (req: Request, res: Response) => {
        try {
            const auth = (req as any).auth;
            const vendorId = auth?.vendorId;
            if (!vendorId) {
                return res.status(400).json({ code: "bad_request", detail: "Missing vendor context" });
            }

            const summary = await getVendorQualitySummary(vendorId);
            return res.json(summary);
        } catch (err: any) {
            console.error("[quality] GET /vendor-summary error:", err?.message || err);
            return res.status(500).json({ code: "internal_error", detail: "Failed to fetch vendor quality summary" });
        }
    },
);

/**
 * POST /api/quality/products/:id/rescore
 * Trigger a re-score for a single product. Fetches the product, computes scores,
 * and upserts the result.
 * Requires: write:products
 */
router.post(
    "/products/:id/rescore",
    requireAuth as any,
    requirePermissionMiddleware("write:products") as any,
    async (req: Request, res: Response) => {
        try {
            const productId = req.params.id;
            const auth = (req as any).auth;
            const vendorId = auth?.vendorId;

            if (!productId) {
                return res.status(400).json({ code: "bad_request", detail: "Missing product ID" });
            }
            if (!vendorId) {
                return res.status(400).json({ code: "bad_request", detail: "Missing vendor context" });
            }

            const result = await scoreAndUpsert(productId, vendorId, undefined, auth?.userId ?? "manual");

            return res.json({
                productId,
                vendorId,
                overallScore: result.overallScore,
                dimensions: {
                    completeness: result.completeness,
                    accuracy: result.accuracy,
                    nutrition: result.nutritionScore,
                    image: result.imageScore,
                    allergen: result.allergenScore,
                    taxonomy: result.taxonomyScore,
                },
                missingFields: result.missingFields,
                warnings: result.warnings,
                grade: scoreToGrade(result.overallScore),
            });
        } catch (err: any) {
            if (err?.message?.includes("not found")) {
                return res.status(404).json({ code: "not_found", detail: err.message });
            }
            console.error("[quality] POST /products/:id/rescore error:", err?.message || err);
            return res.status(500).json({ code: "internal_error", detail: "Failed to rescore product" });
        }
    },
);

/** Map overall score to letter grade */
function scoreToGrade(score: number): "A" | "B" | "C" | "D" | "F" {
    if (score >= 80) return "A";
    if (score >= 60) return "B";
    if (score >= 40) return "C";
    if (score >= 20) return "D";
    return "F";
}

export default router;
