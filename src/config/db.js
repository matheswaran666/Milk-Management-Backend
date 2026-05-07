const mysql = require('mysql2/promise');
const { catalystPool, testCatalystConnection } = require('./catalyst');

const isCatalyst = process.env.DB_TYPE === 'catalyst';
const useAiven   = String(process.env.USE_AIVEN_DB || '').toLowerCase() === 'true';

let pool;

if (isCatalyst) {
  pool = catalystPool;
} else if (useAiven) {
  // Aiven managed MySQL requires SSL on the public endpoint.
  pool = mysql.createPool({
    host:     process.env.AIVEN_DB_HOST,
    port:     process.env.AIVEN_DB_PORT,
    user:     process.env.AIVEN_DB_USER,
    password: process.env.AIVEN_DB_PASSWORD,
    database: process.env.AIVEN_DB_NAME,
    ssl: { rejectUnauthorized: false },
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    timezone: 'local',
  });
} else {
  pool = mysql.createPool({
    host:     process.env.DB_HOST     || 'localhost',
    port:     process.env.DB_PORT     || 3306,
    user:     process.env.DB_USER     || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME     || 'milk_management',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    timezone: 'local',
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Connection probe.
// Returns true on success, false on failure. Never calls process.exit() —
// the caller decides whether a missing DB should kill the process. This
// lets the API keep serving health checks (and any non-DB routes) while
// the DB is temporarily unreachable (DNS hiccup, paused cloud instance,
// etc.). The pool will reconnect on the next real query automatically.
// ─────────────────────────────────────────────────────────────────────────
const testConnection = async () => {
  if (isCatalyst) {
    try {
      await testCatalystConnection();
      return true;
    } catch (err) {
      console.error('❌ Catalyst connection failed:', err.message);
      return false;
    }
  }
  try {
    const conn = await pool.getConnection();
    console.log(`✅ MySQL connected successfully (${useAiven ? 'Aiven' : 'local'})`);
    conn.release();
    return true;
  } catch (err) {
    console.error('❌ MySQL connection failed:', err.message);
    console.error('   → Server will start anyway; DB-backed routes will fail until the database is reachable.');
    return false;
  }
};

const ensureMilkPlantColumn = async () => {
  if (isCatalyst) return;
  try {
    const [rows] = await pool.execute(
      `SELECT COUNT(*) AS cnt
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'milk_entries'
         AND COLUMN_NAME = 'milk_plant'`
    );

    if (rows[0].cnt === 0) {
      await pool.execute(
        `ALTER TABLE milk_entries
         ADD COLUMN milk_plant VARCHAR(100) NOT NULL DEFAULT 'Main Plant' AFTER milk_type`
      );
      await pool.execute(
        `CREATE INDEX idx_milk_entries_milk_plant ON milk_entries (milk_plant)`
      );
      console.log('✅ Added milk_plant column to milk_entries');
    }

    await pool.execute(
      `CREATE TABLE IF NOT EXISTS milk_plants (
        id INT NOT NULL AUTO_INCREMENT,
        name VARCHAR(100) NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_milk_plants_name (name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );

    // Seed default (global) plants only if they don't already exist.
    // MySQL treats NULL != NULL in UNIQUE indexes, so INSERT IGNORE would
    // create duplicates on every restart. Guard with an existence check instead.
    const defaultPlants = ['Main Plant', 'Aavin', 'Private Dairy', 'Union Plant'];
    for (const pName of defaultPlants) {
      const [exists] = await pool.execute(
        `SELECT id FROM milk_plants WHERE user_id IS NULL AND name = ? LIMIT 1`,
        [pName]
      );
      if (!exists.length) {
        await pool.execute(
          `INSERT INTO milk_plants (user_id, name) VALUES (NULL, ?)`,
          [pName]
        );
      }
    }

    // Also seed from any milk_plant values already in entries
    const [entryPlants] = await pool.execute(
      `SELECT DISTINCT milk_plant FROM milk_entries
       WHERE milk_plant IS NOT NULL AND milk_plant <> ''`
    );
    for (const row of entryPlants) {
      const [exists] = await pool.execute(
        `SELECT id FROM milk_plants WHERE user_id IS NULL AND name = ? LIMIT 1`,
        [row.milk_plant]
      );
      if (!exists.length) {
        await pool.execute(
          `INSERT INTO milk_plants (user_id, name) VALUES (NULL, ?)`,
          [row.milk_plant]
        );
      }
    }
    console.log('✅ Ensured milk_plants master table (no duplicates)');

    // Per-plant bill structure templates (fields + sample image)
    await pool.execute(
      `CREATE TABLE IF NOT EXISTS milk_plant_bill_structures (
        id INT NOT NULL AUTO_INCREMENT,
        plant_id INT NOT NULL,
        fields JSON NOT NULL,
        sample_image LONGBLOB NULL,
        sample_image_mime VARCHAR(100) NULL,
        raw_ocr_text MEDIUMTEXT NULL,
        notes TEXT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_mpbs_plant (plant_id),
        CONSTRAINT fk_mpbs_plant FOREIGN KEY (plant_id)
          REFERENCES milk_plants(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );
    console.log('✅ Ensured milk_plant_bill_structures table');

    // Users table for authentication
    await pool.execute(
      `CREATE TABLE IF NOT EXISTS users (
        id INT NOT NULL AUTO_INCREMENT,
        name VARCHAR(80) NOT NULL,
        email VARCHAR(190) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(32) NOT NULL DEFAULT 'user',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_users_email (email)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );
    console.log('✅ Ensured users table');
  } catch (err) {
    console.error('❌ Failed to ensure milk_plant schema:', err.message);
    // Don't kill the process — let the server keep running so the operator
    // can investigate. Migrations will run again on the next successful boot.
  }
};

// ─────────────────────────────────────────────────────────────────────────
// Per-user data isolation (multi-tenancy) migration.
// Adds user_id to every domain table and backfills existing rows to the
// first admin (or first user) so historical data isn't orphaned. Idempotent.
// ─────────────────────────────────────────────────────────────────────────
const ensureUserScopingSchema = async () => {
  if (isCatalyst) return;

  const columnExists = async (table, column) => {
    const [r] = await pool.execute(
      `SELECT COUNT(*) AS cnt
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column]
    );
    return r[0].cnt > 0;
  };

  const indexExists = async (table, indexName) => {
    const [r] = await pool.execute(
      `SELECT COUNT(*) AS cnt
       FROM INFORMATION_SCHEMA.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
      [table, indexName]
    );
    return r[0].cnt > 0;
  };

  // 1️⃣  Pick a backfill user — prefer admin, then lowest user id.
  let backfillUserId = null;
  try {
    const [admins] = await pool.execute(
      `SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1`
    );
    if (admins.length) {
      backfillUserId = admins[0].id;
    } else {
      const [anyUser] = await pool.execute(`SELECT id FROM users ORDER BY id ASC LIMIT 1`);
      if (anyUser.length) backfillUserId = anyUser[0].id;
    }
  } catch (_) {}

  // 2️⃣  Tables that must be hard-scoped (NOT NULL user_id).
  const HARD_SCOPED = ['providers', 'milk_entries', 'expenses', 'earnings'];

  for (const table of HARD_SCOPED) {
    if (!(await columnExists(table, 'user_id'))) {
      // Add nullable first so we can backfill safely.
      await pool.execute(`ALTER TABLE \`${table}\` ADD COLUMN user_id INT NULL AFTER id`);

      if (backfillUserId) {
        await pool.execute(
          `UPDATE \`${table}\` SET user_id = ? WHERE user_id IS NULL`,
          [backfillUserId]
        );
      } else {
        // No users at all → safe to delete any orphaned rows (fresh install path).
        await pool.execute(`DELETE FROM \`${table}\``);
      }

      // Now enforce NOT NULL.
      await pool.execute(`ALTER TABLE \`${table}\` MODIFY user_id INT NOT NULL`);

      // Add an index for fast per-user lookups.
      const idxName = `idx_${table}_user_id`;
      if (!(await indexExists(table, idxName))) {
        await pool.execute(`CREATE INDEX \`${idxName}\` ON \`${table}\` (user_id)`);
      }

      console.log(`✅ Added user_id column + index to ${table}`);
    }
  }

  // 3️⃣  Tables that are soft-scoped (user_id NULLABLE: NULL = global default visible to all).
  const SOFT_SCOPED = ['expense_categories', 'earning_categories', 'milk_plants'];

  for (const table of SOFT_SCOPED) {
    if (!(await columnExists(table, 'user_id'))) {
      await pool.execute(`ALTER TABLE \`${table}\` ADD COLUMN user_id INT NULL AFTER id`);
      const idxName = `idx_${table}_user_id`;
      if (!(await indexExists(table, idxName))) {
        await pool.execute(`CREATE INDEX \`${idxName}\` ON \`${table}\` (user_id)`);
      }
      console.log(`✅ Added user_id column (nullable) + index to ${table}`);
    }
  }

  // 4️⃣  Drop UNIQUE on milk_plants(name) and replace with a per-user UNIQUE
  //     so different users can each have their own "Main Plant".
  try {
    if (await indexExists('milk_plants', 'uq_milk_plants_name')) {
      await pool.execute(`ALTER TABLE milk_plants DROP INDEX uq_milk_plants_name`);
      console.log('✅ Dropped global UNIQUE on milk_plants(name)');
    }
    if (!(await indexExists('milk_plants', 'uq_milk_plants_user_name'))) {
      // user_id can be NULL → MySQL allows multiple NULLs, which is fine for global defaults.
      await pool.execute(
        `ALTER TABLE milk_plants ADD UNIQUE KEY uq_milk_plants_user_name (user_id, name)`
      );
      console.log('✅ Added per-user UNIQUE on milk_plants(user_id, name)');
    }
  } catch (err) {
    console.warn('⚠️  milk_plants unique-key migration skipped:', err.message);
  }

  // 5️⃣  Same idea for category name uniqueness — per user, with NULL = global.
  for (const [table, oldKey] of [
    ['expense_categories', 'uq_expense_category_name'],
    ['earning_categories', 'uq_earning_category_name'],
  ]) {
    try {
      if (await indexExists(table, oldKey)) {
        await pool.execute(`ALTER TABLE \`${table}\` DROP INDEX \`${oldKey}\``);
      }
      const newKey = `uq_${table}_user_name`;
      if (!(await indexExists(table, newKey))) {
        await pool.execute(
          `ALTER TABLE \`${table}\` ADD UNIQUE KEY \`${newKey}\` (user_id, name)`
        );
      }
    } catch (err) {
      console.warn(`⚠️  ${table} unique-key migration skipped:`, err.message);
    }
  }
};

module.exports = { pool, testConnection, ensureMilkPlantColumn, ensureUserScopingSchema };
