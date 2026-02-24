/**
 * Run migration 015: Add 'invited' to b2b_user_links status check
 * Uses pg directly to connect to Supabase
 */
import pg from 'pg';

const DATABASE_URL = 'postgresql://postgres.wpgbagzljljnczmhbcdq:Pixel%401998@aws-1-us-east-1.pooler.supabase.com:6543/postgres';

const client = new pg.Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});
await client.connect();

console.log('Running migration 015_add_invited_status...');

await client.query(`
  ALTER TABLE gold.b2b_user_links
    DROP CONSTRAINT IF EXISTS b2b_user_links_status_check
`);

await client.query(`
  ALTER TABLE gold.b2b_user_links
    ADD CONSTRAINT b2b_user_links_status_check
    CHECK (status IN ('active', 'inactive', 'suspended', 'invited'))
`);

console.log('Done: added "invited" to b2b_user_links status check');
await client.end();
process.exit(0);
