/**
 * Seed / refresh a development test account.
 *
 * Idempotent: running it again will reset the password to the value below
 * (so you can always sign in even if you forget).
 *
 * Usage:   node scripts/seedTestUser.js
 *          npm run seed:test-user
 *
 * ⚠️  DEVELOPMENT ONLY — never run against production.
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('../src/config/db');

const TEST_USER = {
  name:     'Test User',
  email:    'test@milkapp.local',
  password: 'Test@1234',          // 9 chars, mixed case + digit + symbol
  role:     'admin',
};

(async () => {
  try {
    const hash = await bcrypt.hash(TEST_USER.password, 10);

    const [existing] = await pool.query(
      'SELECT id FROM users WHERE email = ?',
      [TEST_USER.email]
    );

    if (existing.length) {
      await pool.query(
        'UPDATE users SET name = ?, password_hash = ?, role = ? WHERE email = ?',
        [TEST_USER.name, hash, TEST_USER.role, TEST_USER.email]
      );
      console.log(`🔄  Reset password for existing user: ${TEST_USER.email}`);
    } else {
      await pool.query(
        'INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)',
        [TEST_USER.name, TEST_USER.email, hash, TEST_USER.role]
      );
      console.log(`✅  Created test user: ${TEST_USER.email}`);
    }

    console.log('\n──────── Test credentials ────────');
    console.log(`  Email:    ${TEST_USER.email}`);
    console.log(`  Password: ${TEST_USER.password}`);
    console.log(`  Role:     ${TEST_USER.role}`);
    console.log('───────────────────────────────────\n');

    process.exit(0);
  } catch (err) {
    console.error('❌  Seed failed:', err.message);
    process.exit(1);
  }
})();
