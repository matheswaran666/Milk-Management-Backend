require('dotenv').config();
const { pool } = require('./src/config/db');

async function migrate_db() {
  try {
    await pool.query(`
      ALTER TABLE milk_entries
      ADD COLUMN shift ENUM('AM', 'PM') NOT NULL DEFAULT 'AM' AFTER date,
      ADD COLUMN milk_type ENUM('CM', 'BM') NOT NULL DEFAULT 'CM' AFTER shift,
      ADD COLUMN quantity_kgs DECIMAL(10, 2) NOT NULL DEFAULT 0.00 AFTER milk_type,
      ADD COLUMN snf_percentage DECIMAL(5, 2) NOT NULL DEFAULT 8.00 AFTER fat_percentage,
      ADD COLUMN clr DECIMAL(5, 2) NOT NULL DEFAULT 28.00 AFTER snf_percentage;
    `);
    
    // Update existing entries
    await pool.query(`
      UPDATE milk_entries
      SET quantity_kgs = quantity_liters * 1.028
      WHERE quantity_kgs = 0.00;
    `);
    
    console.log("Migration successful.");
    process.exit(0);
  } catch(e) {
    if (e.code === 'ER_DUP_FIELDNAME') {
      console.log("Columns already exist.");
      process.exit(0);
    }
    console.error(e);
    process.exit(1);
  }
}

migrate_db();
