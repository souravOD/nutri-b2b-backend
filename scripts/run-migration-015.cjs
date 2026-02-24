const { drizzle } = require('drizzle-orm/neon-http');
const { neon } = require('@neondatabase/serverless');

// Same DATABASE_URL from the container env
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
    console.error('Missing DATABASE_URL');
    process.exit(1);
}

const queryFn = neon(DATABASE_URL);
const db = drizzle(queryFn);

(async () => {
    console.log('Running migration 015_add_invited_status...');

    await db.execute(`
    ALTER TABLE gold.b2b_user_links
      DROP CONSTRAINT IF EXISTS b2b_user_links_status_check
  `);

    await db.execute(`
    ALTER TABLE gold.b2b_user_links
      ADD CONSTRAINT b2b_user_links_status_check
      CHECK (status IN ('active', 'inactive', 'suspended', 'invited'))
  `);

    console.log('Done: added "invited" to b2b_user_links status check');
    process.exit(0);
})().catch(err => {
    console.error('Migration failed:', err.message);
    process.exit(1);
});
