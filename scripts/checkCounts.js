require('dotenv').config();
const { pool } = require('../src/config/db');

(async () => {
  for (const t of ['users','providers','milk_entries','expenses','earnings','expense_categories','earning_categories','milk_plants','milk_plant_bill_structures']) {
    try {
      const [r] = await pool.execute(`SELECT COUNT(*) AS c FROM ${t}`);
      console.log(t.padEnd(30), r[0].c);
    } catch (e) {
      console.log(t.padEnd(30), 'ERR', e.message);
    }
  }
  await pool.end();
})();
