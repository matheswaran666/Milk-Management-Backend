require('dotenv').config();
const { pool } = require('../src/config/db');
(async () => {
  const [rows] = await pool.execute('SELECT id, name, email, role, created_at FROM users ORDER BY id');
  console.table(rows);
  await pool.end();
})();
