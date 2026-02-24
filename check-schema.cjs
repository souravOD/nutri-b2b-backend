const { db } = require('./dist/server/lib/database.js');
const { sql } = require('drizzle-orm');

(async () => {
    const cols = await db.execute(sql`
    SELECT column_name, data_type, is_nullable, column_default 
    FROM information_schema.columns 
    WHERE table_schema='gold' AND table_name='b2b_users' 
    ORDER BY ordinal_position
  `);
    console.log('COLUMNS:', JSON.stringify(cols.rows, null, 2));

    const idx = await db.execute(sql`
    SELECT indexname, indexdef FROM pg_indexes 
    WHERE schemaname='gold' AND tablename='b2b_users'
  `);
    console.log('INDEXES:', JSON.stringify(idx.rows, null, 2));

    const con = await db.execute(sql`
    SELECT conname, contype, pg_get_constraintdef(oid) as def 
    FROM pg_constraint 
    WHERE conrelid='gold.b2b_users'::regclass
  `);
    console.log('CONSTRAINTS:', JSON.stringify(con.rows, null, 2));

    const idx2 = await db.execute(sql`
    SELECT indexname, indexdef FROM pg_indexes 
    WHERE schemaname='gold' AND tablename='b2b_user_links'
  `);
    console.log('LINK_INDEXES:', JSON.stringify(idx2.rows, null, 2));

    const con2 = await db.execute(sql`
    SELECT conname, contype, pg_get_constraintdef(oid) as def 
    FROM pg_constraint 
    WHERE conrelid='gold.b2b_user_links'::regclass
  `);
    console.log('LINK_CONSTRAINTS:', JSON.stringify(con2.rows, null, 2));

    process.exit(0);
})();
