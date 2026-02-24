// ─── Compliance Router ──────────────────────────────────────────────────────
// Phase 3: compliance rules, check engine, and audit trail
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type Request, type Response } from "express";
import { requireAuth, requirePermissionMiddleware } from "../lib/auth.js";
import { db } from "../lib/database.js";
import { sql } from "drizzle-orm";
import { insertAlert } from "./alerts.js";

const router = Router();

const MAX_PAGE_SIZE = 100;

// ── GET /compliance/rules ───────────────────────────────────────────────────
// List compliance rules (global + vendor-specific)
router.get(
    "/rules",
    requireAuth as any,
    requirePermissionMiddleware("read:vendors") as any,
    async (req: Request, res: Response) => {
        try {
            const auth = (req as any).auth;
            const vendorId = auth.vendorId;
            if (!vendorId) {
                return res.status(400).json({ code: "bad_request", detail: "Missing vendor context" });
            }

            const result = await db.execute(sql`
                SELECT id, vendor_id, title, description, regulation, check_type,
                       severity, check_config, is_active, created_at, updated_at
                FROM gold.b2b_compliance_rules
                WHERE (vendor_id = ${vendorId}::uuid OR vendor_id IS NULL)
                  AND is_active = true
                ORDER BY created_at DESC
            `);

            return res.json({ data: result.rows || [] });
        } catch (err: any) {
            console.error("[compliance] GET /rules error:", err?.message || err);
            return res.status(500).json({ code: "internal_error", detail: "Failed to fetch compliance rules" });
        }
    },
);

// ── GET /compliance/checks ──────────────────────────────────────────────────
// List compliance check results with pagination and filters
router.get(
    "/checks",
    requireAuth as any,
    requirePermissionMiddleware("read:vendors") as any,
    async (req: Request, res: Response) => {
        try {
            const auth = (req as any).auth;
            const vendorId = auth.vendorId;
            if (!vendorId) {
                return res.status(400).json({ code: "bad_request", detail: "Missing vendor context" });
            }

            const page = Math.max(1, parseInt((req.query.page as string) || "1", 10));
            const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt((req.query.limit as string) || "20", 10)));
            const offset = (page - 1) * limit;

            const statusFilter = (req.query.status as string) || null;
            const validStatuses = ["compliant", "warning", "non_compliant"];
            if (statusFilter && !validStatuses.includes(statusFilter)) {
                return res.status(400).json({
                    code: "bad_request",
                    detail: `Invalid status. Allowed: ${validStatuses.join(", ")}`,
                });
            }

            const conditions = [sql`c.vendor_id = ${vendorId}::uuid`];
            if (statusFilter) conditions.push(sql`c.status = ${statusFilter}`);
            const where = sql.join(conditions, sql` AND `);

            const countResult = await db.execute(sql`
                SELECT count(*)::int AS total FROM gold.b2b_compliance_checks c WHERE ${where}
            `);
            const total = (countResult.rows?.[0] as any)?.total ?? 0;

            const result = await db.execute(sql`
                SELECT c.id, c.vendor_id, c.rule_id, c.status, c.score,
                       c.products_checked, c.products_failed, c.details,
                       c.checked_by, c.checked_at, c.next_review,
                       r.title AS rule_title, r.regulation, r.severity
                FROM gold.b2b_compliance_checks c
                JOIN gold.b2b_compliance_rules r ON r.id = c.rule_id
                WHERE ${where}
                ORDER BY c.checked_at DESC
                LIMIT ${limit} OFFSET ${offset}
            `);

            return res.json({
                data: result.rows || [],
                page,
                pageSize: limit,
                total,
            });
        } catch (err: any) {
            console.error("[compliance] GET /checks error:", err?.message || err);
            return res.status(500).json({ code: "internal_error", detail: "Failed to fetch compliance checks" });
        }
    },
);

// ── GET /compliance/summary ─────────────────────────────────────────────────
// Aggregate: overall score, counts by status
router.get(
    "/summary",
    requireAuth as any,
    requirePermissionMiddleware("read:vendors") as any,
    async (req: Request, res: Response) => {
        try {
            const auth = (req as any).auth;
            const vendorId = auth.vendorId;
            if (!vendorId) {
                return res.status(400).json({ code: "bad_request", detail: "Missing vendor context" });
            }

            // Get counts and average score from the LATEST check per rule
            const result = await db.execute(sql`
                WITH latest_checks AS (
                    SELECT DISTINCT ON (rule_id)
                        rule_id, status, score
                    FROM gold.b2b_compliance_checks
                    WHERE vendor_id = ${vendorId}::uuid
                    ORDER BY rule_id, checked_at DESC
                )
                SELECT
                    count(*)::int AS total_rules_checked,
                    count(*) FILTER (WHERE status = 'compliant')::int AS compliant,
                    count(*) FILTER (WHERE status = 'warning')::int AS warning,
                    count(*) FILTER (WHERE status = 'non_compliant')::int AS non_compliant,
                    coalesce(round(avg(score))::int, 0) AS overall_score
                FROM latest_checks
            `);

            const row = result.rows?.[0] as any;
            return res.json({
                totalRulesChecked: row?.total_rules_checked ?? 0,
                compliant: row?.compliant ?? 0,
                warning: row?.warning ?? 0,
                nonCompliant: row?.non_compliant ?? 0,
                overallScore: row?.overall_score ?? 0,
            });
        } catch (err: any) {
            console.error("[compliance] GET /summary error:", err?.message || err);
            return res.status(500).json({ code: "internal_error", detail: "Failed to fetch compliance summary" });
        }
    },
);

// ── POST /compliance/run ────────────────────────────────────────────────────
// Trigger compliance checks against vendor products for all active rules
router.post(
    "/run",
    requireAuth as any,
    requirePermissionMiddleware("write:vendors") as any,
    async (req: Request, res: Response) => {
        try {
            const auth = (req as any).auth;
            const vendorId = auth.vendorId;
            const userId = auth.userId;
            if (!vendorId) {
                return res.status(400).json({ code: "bad_request", detail: "Missing vendor context" });
            }

            // 1. Fetch active rules for this vendor
            const rulesResult = await db.execute(sql`
                SELECT id, title, regulation, check_type, severity, check_config
                FROM gold.b2b_compliance_rules
                WHERE (vendor_id = ${vendorId}::uuid OR vendor_id IS NULL)
                  AND is_active = true
            `);
            const rules = (rulesResult.rows || []) as any[];
            if (rules.length === 0) {
                return res.json({ message: "No active compliance rules found", checks: [] });
            }

            // 2. Get vendor product stats for evaluation
            const productStats = await db.execute(sql`
                SELECT
                    count(*)::int AS total_products,
                    count(*) FILTER (WHERE nutrition IS NOT NULL AND nutrition::text != '{}')::int AS with_nutrition,
                    count(*) FILTER (WHERE allergens IS NOT NULL AND array_length(allergens, 1) > 0)::int AS with_allergens,
                    count(*) FILTER (WHERE ingredients IS NOT NULL AND array_length(ingredients, 1) > 0)::int AS with_ingredients,
                    count(*) FILTER (WHERE barcode IS NOT NULL)::int AS with_barcode,
                    count(*) FILTER (WHERE certifications IS NOT NULL AND array_length(certifications, 1) > 0)::int AS with_certifications
                FROM gold.products
                WHERE vendor_id = ${vendorId}::uuid AND status = 'active'
            `);
            const stats = (productStats.rows?.[0] || {}) as any;
            const totalProducts = stats.total_products || 0;

            // 3. Evaluate each rule and insert check results
            const checks: any[] = [];
            for (const rule of rules) {
                const { score, productsChecked, productsFailed, status } = evaluateRule(rule, stats, totalProducts);

                const insertResult = await db.execute(sql`
                    INSERT INTO gold.b2b_compliance_checks
                        (vendor_id, rule_id, status, score, products_checked, products_failed,
                         details, checked_by, next_review)
                    VALUES (
                        ${vendorId}::uuid,
                        ${rule.id}::uuid,
                        ${status},
                        ${score},
                        ${productsChecked},
                        ${productsFailed},
                        ${JSON.stringify({ rule_title: rule.title, regulation: rule.regulation })}::jsonb,
                        ${userId}::uuid,
                        current_date + interval '30 days'
                    )
                    RETURNING id, status, score, products_checked, products_failed
                `);

                const check = insertResult.rows?.[0] as any;
                checks.push({
                    ...check,
                    ruleId: rule.id,
                    ruleTitle: rule.title,
                    regulation: rule.regulation,
                });

                // Insert compliance alert for non-compliant results
                if (status === "non_compliant") {
                    await insertAlert({
                        vendorId,
                        type: "compliance",
                        priority: rule.severity === "critical" ? "high" : "medium",
                        title: `Non-compliant: ${rule.title}`,
                        description: `${productsFailed} of ${productsChecked} products failed ${rule.regulation} check.`,
                        sourceTable: "b2b_compliance_checks",
                        sourceId: check?.id,
                    });
                }
            }

            return res.json({
                message: `Compliance check complete: ${checks.length} rules evaluated`,
                checks,
            });
        } catch (err: any) {
            console.error("[compliance] POST /run error:", err?.message || err);
            return res.status(500).json({ code: "internal_error", detail: "Failed to run compliance checks" });
        }
    },
);

// ── PATCH /compliance/checks/:id ────────────────────────────────────────────
// Update a check (e.g., set next_review date)
router.patch(
    "/checks/:id",
    requireAuth as any,
    requirePermissionMiddleware("write:vendors") as any,
    async (req: Request, res: Response) => {
        try {
            const auth = (req as any).auth;
            const vendorId = auth.vendorId;
            const checkId = req.params.id;

            if (!vendorId || !checkId) {
                return res.status(400).json({ code: "bad_request", detail: "Missing vendor or check ID" });
            }

            const { next_review } = req.body || {};
            if (!next_review) {
                return res.status(400).json({
                    code: "bad_request",
                    detail: "Body must include 'next_review' (ISO date)",
                });
            }

            const result = await db.execute(sql`
                UPDATE gold.b2b_compliance_checks
                SET next_review = ${next_review}::date
                WHERE id = ${checkId}::uuid
                  AND vendor_id = ${vendorId}::uuid
                RETURNING id, next_review
            `);

            if (!result.rows?.length) {
                return res.status(404).json({
                    code: "not_found",
                    detail: "Check not found or not owned by your vendor",
                });
            }

            return res.json({ ok: true, check: result.rows[0] });
        } catch (err: any) {
            console.error("[compliance] PATCH /checks/:id error:", err?.message || err);
            return res.status(500).json({ code: "internal_error", detail: "Failed to update compliance check" });
        }
    },
);

// ── Rule evaluation engine ──────────────────────────────────────────────────
// Evaluates a compliance rule against aggregated product stats.
function evaluateRule(
    rule: any,
    stats: any,
    totalProducts: number,
): { score: number; productsChecked: number; productsFailed: number; status: string } {
    if (totalProducts === 0) {
        return { score: 100, productsChecked: 0, productsFailed: 0, status: "compliant" };
    }

    let withField = 0;
    switch (rule.check_type) {
        case "nutrition_completeness":
            withField = stats.with_nutrition || 0;
            break;
        case "allergen_declaration":
            withField = stats.with_allergens || 0;
            break;
        case "ingredient_listing":
            withField = stats.with_ingredients || 0;
            break;
        case "barcode_presence":
            withField = stats.with_barcode || 0;
            break;
        case "certification_check":
            withField = stats.with_certifications || 0;
            break;
        default:
            // Unknown check type — default to 100% compliant
            return { score: 100, productsChecked: totalProducts, productsFailed: 0, status: "compliant" };
    }

    const failed = totalProducts - withField;
    const score = Math.round((withField / totalProducts) * 100);

    let status: string;
    if (score >= 90) status = "compliant";
    else if (score >= 60) status = "warning";
    else status = "non_compliant";

    return { score, productsChecked: totalProducts, productsFailed: failed, status };
}

export default router;
