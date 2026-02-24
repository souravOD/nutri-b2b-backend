/**
 * seed-superadmin.ts
 *
 * One-time CLI script to bootstrap a superadmin user.
 *
 * Usage:
 *   npx tsx scripts/seed-superadmin.ts <email>
 *
 * Environment:
 *   DATABASE_URL must be set (reads from .env automatically via dotenv).
 *
 * What it does:
 *   1. Looks up the user in gold.b2b_users by email
 *   2. If found, upserts gold.b2b_user_links with role='superadmin'
 *   3. If not found, creates the user row first, then the link
 */

import "dotenv/config";
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
    console.error("❌ DATABASE_URL is not set. Check your .env file.");
    process.exit(1);
}

const email = process.argv[2]?.trim().toLowerCase();
if (!email || !email.includes("@")) {
    console.error("Usage: npx tsx scripts/seed-superadmin.ts <email>");
    process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function main() {
    console.log(`\n🔧 Seeding superadmin for: ${email}\n`);

    // 1. Find or create the user
    let userResult = await pool.query(
        `SELECT id, email, display_name FROM gold.b2b_users WHERE lower(email) = lower($1) LIMIT 1`,
        [email]
    );

    let userId: string;

    if (userResult.rows.length > 0) {
        userId = userResult.rows[0].id;
        console.log(`✅ Found existing user: ${userId} (${userResult.rows[0].email})`);
    } else {
        // Create a minimal user row
        const insertResult = await pool.query(
            `INSERT INTO gold.b2b_users (email, display_name)
       VALUES ($1, $2)
       RETURNING id`,
            [email, email.split("@")[0]]
        );
        userId = insertResult.rows[0].id;
        console.log(`✅ Created user: ${userId}`);
    }

    // 2. Upsert the user link with superadmin role
    const linkResult = await pool.query(
        `SELECT user_id, role, status FROM gold.b2b_user_links WHERE user_id = $1::uuid LIMIT 1`,
        [userId]
    );

    if (linkResult.rows.length > 0) {
        const currentRole = linkResult.rows[0].role;
        if (currentRole === "superadmin") {
            console.log(`ℹ️  User is already superadmin. No changes needed.`);
        } else {
            await pool.query(
                `UPDATE gold.b2b_user_links
         SET role = 'superadmin', status = 'active', updated_at = now()
         WHERE user_id = $1::uuid`,
                [userId]
            );
            console.log(`✅ Upgraded role: ${currentRole} → superadmin`);
        }
    } else {
        // Need a vendor_id — use the first active vendor
        const vendorResult = await pool.query(
            `SELECT id, slug FROM gold.vendors WHERE status = 'active' ORDER BY created_at ASC LIMIT 1`
        );
        if (vendorResult.rows.length === 0) {
            console.error("❌ No active vendors found. Create a vendor first.");
            process.exit(1);
        }
        const vendorId = vendorResult.rows[0].id;
        console.log(`ℹ️  Using vendor: ${vendorResult.rows[0].slug} (${vendorId})`);

        await pool.query(
            `INSERT INTO gold.b2b_user_links (user_id, vendor_id, role, status)
       VALUES ($1::uuid, $2::uuid, 'superadmin', 'active')`,
            [userId, vendorId]
        );
        console.log(`✅ Created user link with superadmin role`);
    }

    console.log(`\n🎉 Done! ${email} is now a superadmin.\n`);
}

main()
    .catch((err) => {
        console.error("❌ Error:", err.message);
        process.exit(1);
    })
    .finally(() => pool.end());
