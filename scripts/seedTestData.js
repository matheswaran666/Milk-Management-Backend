/**
 * Seed sample business data for the test account.
 *
 * Populates providers, milk entries (last 30 days, AM+PM shifts),
 * expenses, and earnings — all scoped to the test user
 * (test@milkapp.local).
 *
 * Idempotent: re-running wipes previous test-user-scoped data and
 * re-creates a fresh, deterministic dataset.
 *
 * Usage:   node scripts/seedTestData.js
 *          npm run seed:test-data
 *
 * ⚠️  DEVELOPMENT ONLY — never run against production.
 */

require('dotenv').config();
const { pool } = require('../src/config/db');

const TEST_EMAIL = 'test@milkapp.local';

// ─────────────────────────────────────────────────────────────────────
//  Sample providers (farmers)
// ─────────────────────────────────────────────────────────────────────
const PROVIDERS = [
  { name: 'Ramesh Kumar',     phone: '9876543210', route: 'NORTH', address: 'Plot 12, Anna Nagar',         notes: 'High fat % regularly' },
  { name: 'Suresh Patel',     phone: '9876543211', route: 'NORTH', address: '45 Gandhi Street',            notes: 'Buffalo milk supplier' },
  { name: 'Lakshmi Devi',     phone: '9876543212', route: 'SOUTH', address: '8 Temple Road',               notes: '' },
  { name: 'Mohammed Ali',     phone: '9876543213', route: 'SOUTH', address: '23 Mosque Lane',              notes: 'Reliable, on-time' },
  { name: 'Priya Sharma',     phone: '9876543214', route: 'EAST',  address: '101 Lake View',               notes: 'Premium grade A2 milk' },
  { name: 'Karthik Raja',     phone: '9876543215', route: 'EAST',  address: '67 Market Road',              notes: '' },
  { name: 'Geetha Selvam',    phone: '9876543216', route: 'WEST',  address: '14 Coconut Grove',            notes: '' },
  { name: 'Vijay Balan',      phone: '9876543217', route: 'WEST',  address: '90 Highway Junction',         notes: 'Large herd, bulk supply' },
  { name: 'Anitha Reddy',     phone: '9876543218', route: 'LOCAL', address: '5 Backside Colony',           notes: '' },
  { name: 'Senthil Murugan',  phone: '9876543219', route: 'LOCAL', address: '32 Pillaiyar Koil Street',    notes: 'Occasional Sunday gap' },
];

// ─────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────
const rand = (min, max) => +(Math.random() * (max - min) + min).toFixed(2);
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const fmtDate = (d) => d.toISOString().slice(0, 10);

const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
};

// ─────────────────────────────────────────────────────────────────────
//  Main
// ─────────────────────────────────────────────────────────────────────
(async () => {
  let conn;
  try {
    // 1️⃣  Resolve test user id
    const [users] = await pool.query(
      'SELECT id FROM users WHERE email = ?',
      [TEST_EMAIL]
    );
    if (!users.length) {
      throw new Error(
        `Test user "${TEST_EMAIL}" not found. Run "npm run seed:test-user" first.`
      );
    }
    const userId = users[0].id;
    console.log(`👤  Test user id: ${userId} (${TEST_EMAIL})`);

    conn = await pool.getConnection();
    await conn.beginTransaction();

    // 2️⃣  Wipe previous test-user-scoped business data
    //     (only this user's rows — leaves global categories/plants alone)
    const wipeTables = ['milk_entries', 'expenses', 'earnings', 'providers'];
    for (const t of wipeTables) {
      const [r] = await conn.execute(
        `DELETE FROM \`${t}\` WHERE user_id = ?`,
        [userId]
      );
      console.log(`🧹  Cleared ${r.affectedRows} row(s) from ${t}`);
    }

    // 3️⃣  Seed providers
    const providerIds = [];
    for (const p of PROVIDERS) {
      const [r] = await conn.execute(
        `INSERT INTO providers (user_id, name, phone, route, address, notes, is_active)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
        [userId, p.name, p.phone, p.route, p.address, p.notes]
      );
      providerIds.push(r.insertId);
    }
    console.log(`✅  Inserted ${providerIds.length} providers`);

    // 4️⃣  Seed milk_entries — 30 days × 2 shifts × ~80% of providers
    const PLANTS = ['Main Plant', 'Aavin', 'Private Dairy'];
    let entryCount = 0;
    let entryRevenue = 0;

    for (let dayOffset = 29; dayOffset >= 0; dayOffset--) {
      const date = fmtDate(daysAgo(dayOffset));

      for (const shift of ['AM', 'PM']) {
        for (const pid of providerIds) {
          // 80% chance a provider supplies in a given shift
          if (Math.random() > 0.8) continue;

          const milkType = Math.random() > 0.65 ? 'BM' : 'CM'; // 35% buffalo
          const fat   = milkType === 'BM' ? rand(6.0, 8.5) : rand(3.5, 5.2);
          const snf   = milkType === 'BM' ? rand(8.8, 9.6) : rand(8.2, 8.8);
          const clr   = +(snf * 4 - fat * 0.25 + 0.5).toFixed(2);
          const water = rand(0, 1.5);
          const liters = rand(8, 35);
          const kgs    = +(liters * 1.03).toFixed(2);

          // Rate scales with fat: base 35, + ₹6 per fat point above 3.5
          const rate = +(35 + Math.max(0, fat - 3.5) * 6 + (milkType === 'BM' ? 12 : 0)).toFixed(2);
          const total = +(liters * rate).toFixed(2);

          await conn.execute(
            `INSERT INTO milk_entries
             (user_id, provider_id, date, shift, milk_type, milk_plant,
              quantity_kgs, quantity_liters, fat_percentage, snf_percentage,
              clr, water_percentage, rate_per_liter, total_amount)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [userId, pid, date, shift, milkType, pick(PLANTS),
             kgs, liters, fat, snf, clr, water, rate, total]
          );
          entryCount++;
          entryRevenue += total;
        }
      }
    }
    console.log(`✅  Inserted ${entryCount} milk entries (₹${entryRevenue.toFixed(2)} total)`);

    // 5️⃣  Seed expenses — pull global category ids
    const [expCats] = await conn.execute(
      `SELECT id, name FROM expense_categories WHERE user_id IS NULL OR user_id = ?`,
      [userId]
    );
    const expCatByName = Object.fromEntries(expCats.map(c => [c.name, c.id]));

    const EXPENSE_SAMPLES = [
      { cat: 'Feed & Fodder', title: 'Cattle feed - 50kg sack',         amount: 2400, pm: 'cash' },
      { cat: 'Feed & Fodder', title: 'Hay bales delivery',              amount: 1850, pm: 'upi' },
      { cat: 'Feed & Fodder', title: 'Mineral mixture - 20kg',          amount: 1100, pm: 'cash' },
      { cat: 'Veterinary',    title: 'Routine vet check-up',            amount: 800,  pm: 'cash' },
      { cat: 'Veterinary',    title: 'Vaccination - 5 cattle',          amount: 1500, pm: 'bank_transfer' },
      { cat: 'Veterinary',    title: 'Antibiotic injection',            amount: 450,  pm: 'cash' },
      { cat: 'Labour',        title: 'Helper salary - Ravi',            amount: 8000, pm: 'bank_transfer' },
      { cat: 'Labour',        title: 'Helper salary - Kumar',           amount: 7500, pm: 'bank_transfer' },
      { cat: 'Equipment',     title: 'Milking machine repair',          amount: 3200, pm: 'upi' },
      { cat: 'Equipment',     title: 'Storage can replacement',         amount: 1700, pm: 'cash' },
      { cat: 'Utilities',     title: 'Electricity bill - July',         amount: 2900, pm: 'upi' },
      { cat: 'Utilities',     title: 'Water tanker delivery',           amount: 600,  pm: 'cash' },
      { cat: 'Transport',     title: 'Diesel for tempo (route NORTH)',  amount: 1200, pm: 'cash' },
      { cat: 'Transport',     title: 'Vehicle servicing',               amount: 2500, pm: 'upi' },
      { cat: 'Miscellaneous', title: 'Stationery & receipt books',      amount: 350,  pm: 'cash' },
    ];

    let expCount = 0;
    for (const e of EXPENSE_SAMPLES) {
      const date = fmtDate(daysAgo(randInt(0, 29)));
      await conn.execute(
        `INSERT INTO expenses
         (user_id, category_id, title, amount, date, payment_method, reference_no)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [userId, expCatByName[e.cat] || null, e.title, e.amount, date, e.pm,
         e.pm === 'bank_transfer' ? `TXN${randInt(100000, 999999)}` : null]
      );
      expCount++;
    }
    console.log(`✅  Inserted ${expCount} expenses`);

    // 6️⃣  Seed earnings
    const [earnCats] = await conn.execute(
      `SELECT id, name FROM earning_categories WHERE user_id IS NULL OR user_id = ?`,
      [userId]
    );
    const earnCatByName = Object.fromEntries(earnCats.map(c => [c.name, c.id]));

    const EARNING_SAMPLES = [
      { cat: 'Milk Sales',         title: 'Aavin weekly settlement - W1', amount: 18500, pm: 'bank_transfer' },
      { cat: 'Milk Sales',         title: 'Aavin weekly settlement - W2', amount: 19200, pm: 'bank_transfer' },
      { cat: 'Milk Sales',         title: 'Aavin weekly settlement - W3', amount: 17800, pm: 'bank_transfer' },
      { cat: 'Milk Sales',         title: 'Aavin weekly settlement - W4', amount: 20100, pm: 'bank_transfer' },
      { cat: 'Milk Sales',         title: 'Local hotel supply',           amount: 4200,  pm: 'cash' },
      { cat: 'Milk Sales',         title: 'Direct customer sales',        amount: 3800,  pm: 'upi' },
      { cat: 'Curd / Products',    title: 'Curd sales - daily route',     amount: 2400,  pm: 'cash' },
      { cat: 'Curd / Products',    title: 'Ghee batch (2kg)',             amount: 2200,  pm: 'upi' },
      { cat: 'Government Subsidy', title: 'Dairy farming subsidy Q2',     amount: 12000, pm: 'bank_transfer' },
      { cat: 'Other Income',       title: 'Cow dung / manure sale',       amount: 800,   pm: 'cash' },
    ];

    let earnCount = 0;
    for (const e of EARNING_SAMPLES) {
      const date = fmtDate(daysAgo(randInt(0, 29)));
      await conn.execute(
        `INSERT INTO earnings
         (user_id, category_id, title, amount, date, payment_method, reference_no)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [userId, earnCatByName[e.cat] || null, e.title, e.amount, date, e.pm,
         e.pm === 'bank_transfer' ? `RCT${randInt(100000, 999999)}` : null]
      );
      earnCount++;
    }
    console.log(`✅  Inserted ${earnCount} earnings`);

    await conn.commit();

    console.log('\n──────── Sample data seeded ────────');
    console.log(`  Providers:     ${providerIds.length}`);
    console.log(`  Milk entries:  ${entryCount}  (≈ ₹${entryRevenue.toFixed(0)} payable)`);
    console.log(`  Expenses:      ${expCount}`);
    console.log(`  Earnings:      ${earnCount}`);
    console.log(`  User:          ${TEST_EMAIL} (id ${userId})`);
    console.log('────────────────────────────────────\n');

    process.exit(0);
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    console.error('❌  Seed failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    if (conn) conn.release();
  }
})();
