// scripts/seedShop.js
//
// A signup endpoint now exists (POST /api/shops/signup) - this script is
// still useful as an admin/CLI shortcut (e.g. bulk-onboarding a batch of
// shops without touching the UI), but it's no longer the only way to create
// a shop account.
//
// Usage: node scripts/seedShop.js "Shop Name" shop@example.com password123 ["Landmark Name"]
// Landmark name defaults to "Anurag University" (the only beta landmark).

const { randomUUID } = require('crypto');
const { pool, migrate } = require('../src/db');
const { hashPassword } = require('../src/auth');

async function main() {
  await migrate(); // safe to run every time - ensures tables exist even on a brand-new DB

  const [, , name, email, password, landmarkName = 'Anurag University'] = process.argv;

  if (!name || !email || !password) {
    console.error(
      'Usage: node scripts/seedShop.js "Shop Name" shop@example.com password123 ["Landmark Name"]'
    );
    process.exit(1);
  }

  const { rows: existingRows } = await pool.query('SELECT id FROM shops WHERE email = $1', [email]);
  if (existingRows[0]) {
    console.error(`A shop with email ${email} already exists (id: ${existingRows[0].id})`);
    process.exit(1);
  }

  const { rows: landmarkRows } = await pool.query('SELECT id FROM landmarks WHERE name = $1', [
    landmarkName,
  ]);
  if (!landmarkRows[0]) {
    const { rows: allLandmarks } = await pool.query('SELECT name FROM landmarks');
    console.error(
      `No landmark named "${landmarkName}" exists yet. Available landmarks:`,
      allLandmarks.map((l) => l.name)
    );
    process.exit(1);
  }

  const id = randomUUID();
  const passwordHash = await hashPassword(password);

  await pool.query(
    'INSERT INTO shops (id, name, email, password_hash, landmark_id, created_at) VALUES ($1, $2, $3, $4, $5, NOW())',
    [id, name, email, passwordHash, landmarkRows[0].id]
  );

  console.log('Shop created:');
  console.log({ id, name, email, landmark: landmarkName });
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
