/**
 * Check b2b_users and b2b_user_links schema constraints
 */
import { db } from '../server/lib/database.js';
import { sql } from 'drizzle-orm';

const cols = await db.execute(sql`
  SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_schema='gold' AND table_name='b2b_users'
  ORDER BY ordinal_position
`);
console.log('B2B_USERS COLUMNS:');
for (const c of cols.rows as any[]) {
    console.log(`  ${c.column_name} (${c.data_type}) nullable=${c.is_nullable} default=${c.column_default}`);
}

const con = await db.execute(sql`
  SELECT conname, contype, pg_get_constraintdef(oid) as def
  FROM pg_constraint
  WHERE conrelid = 'gold.b2b_users'::regclass
`);
console.log('\nB2B_USERS CONSTRAINTS:');
for (const c of con.rows as any[]) {
    console.log(`  ${c.conname} (${c.contype}): ${c.def}`);
}

const con2 = await db.execute(sql`
  SELECT conname, contype, pg_get_constraintdef(oid) as def
  FROM pg_constraint
  WHERE conrelid = 'gold.b2b_user_links'::regclass
`);
console.log('\nB2B_USER_LINKS CONSTRAINTS:');
for (const c of con2.rows as any[]) {
    console.log(`  ${c.conname} (${c.contype}): ${c.def}`);
}

process.exit(0);
