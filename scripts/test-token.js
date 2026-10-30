const { neon } = require('@neondatabase/serverless');
const jwt = require('jsonwebtoken');

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
const sql = neon(dbUrl);

async function run() {
  const users = await sql`SELECT id, email, role, is_staff, eco_points FROM users ORDER BY is_staff DESC, created_at ASC LIMIT 5`;
  console.log('USERS:', JSON.stringify(users));
}

run().catch(console.error);
