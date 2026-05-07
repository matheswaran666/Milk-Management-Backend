const { pool } = require('../config/db');

const getAllEntries = async (req, res) => {
  try {
    const userId = req.user.id;
    const { provider_id, milk_plant, date_from, date_to, fat_min, fat_max, qty_min, qty_max, search, page = 1, limit = 20 } = req.query;

    let where = 'WHERE me.user_id = ?';
    const params = [userId];

    if (provider_id) { where += ' AND me.provider_id = ?';         params.push(provider_id); }
    if (milk_plant)  { where += ' AND me.milk_plant = ?';          params.push(milk_plant); }
    if (date_from)   { where += ' AND me.date >= ?';               params.push(date_from); }
    if (date_to)     { where += ' AND me.date <= ?';               params.push(date_to); }
    if (fat_min)     { where += ' AND me.fat_percentage >= ?';     params.push(fat_min); }
    if (fat_max)     { where += ' AND me.fat_percentage <= ?';     params.push(fat_max); }
    if (qty_min)     { where += ' AND me.quantity_liters >= ?';    params.push(qty_min); }
    if (qty_max)     { where += ' AND me.quantity_liters <= ?';    params.push(qty_max); }
    if (search)      { where += ' AND p.name LIKE ?';              params.push(`%${search}%`); }

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM milk_entries me JOIN providers p ON me.provider_id = p.id ${where}`,
      params
    );

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const [rows] = await pool.query(
      `SELECT me.id, me.provider_id, me.date, me.shift, me.milk_type, me.milk_plant, me.quantity_kgs,
              me.quantity_liters, me.fat_percentage, me.snf_percentage, me.clr, me.water_percentage,
              me.rate_per_liter, me.total_amount, me.notes, me.created_at,
              p.name AS provider_name, p.phone AS provider_phone
       FROM milk_entries me
       JOIN providers p ON me.provider_id = p.id
       ${where}
       ORDER BY me.date DESC, me.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    res.json({
      success: true,
      data: rows,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, totalPages: Math.ceil(total / parseInt(limit)) }
    });
  } catch (err) {
    console.error('getAllEntries error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load records.' });
  }
};

const getEntry = async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT me.*, p.name AS provider_name
       FROM milk_entries me JOIN providers p ON me.provider_id = p.id
       WHERE me.id = ? AND me.user_id = ?`,
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Entry not found.' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('getEntry error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load entry.' });
  }
};

// Verify a provider belongs to the current user (prevents foreign-key cross-tenant misuse).
const assertProviderBelongsToUser = async (providerId, userId) => {
  const [rows] = await pool.execute(
    `SELECT id FROM providers WHERE id = ? AND user_id = ? LIMIT 1`,
    [providerId, userId]
  );
  return rows.length > 0;
};

const createEntry = async (req, res) => {
  try {
    const { provider_id, date, shift, milk_type, milk_plant, quantity_kgs, fat_percentage, snf_percentage, clr, water_percentage, rate_per_liter, notes } = req.body;
    if (!provider_id || !date || !quantity_kgs || !fat_percentage || !rate_per_liter) {
      return res.status(400).json({ success: false, message: 'Provider, date, quantity(kgs), fat %, and rate are required.' });
    }
    if (isNaN(quantity_kgs) || parseFloat(quantity_kgs) <= 0)
      return res.status(400).json({ success: false, message: 'Quantity must be a positive number.' });
    if (isNaN(fat_percentage) || parseFloat(fat_percentage) <= 0 || parseFloat(fat_percentage) > 20)
      return res.status(400).json({ success: false, message: 'Fat percentage must be valid.' });
    if (isNaN(rate_per_liter) || parseFloat(rate_per_liter) <= 0)
      return res.status(400).json({ success: false, message: 'Rate per liter must be a positive number.' });

    if (!(await assertProviderBelongsToUser(provider_id, req.user.id))) {
      return res.status(404).json({ success: false, message: 'Provider not found.' });
    }

    const q_kgs = parseFloat(quantity_kgs);
    const clr_val = clr ? parseFloat(clr) : 28.00;
    const rate = parseFloat(rate_per_liter);

    // Calculate Liters = Weight / (1 + (CLR/1000))
    const density = 1 + (clr_val / 1000);
    const quantity_liters = (q_kgs / density).toFixed(2);
    const total_amount = (parseFloat(quantity_liters) * rate).toFixed(2);

    const [result] = await pool.execute(
      `INSERT INTO milk_entries (user_id, provider_id, date, shift, milk_type, milk_plant, quantity_kgs, quantity_liters, fat_percentage, snf_percentage, clr, water_percentage, rate_per_liter, total_amount, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, provider_id, date, shift || 'AM', milk_type || 'CM', milk_plant || 'Main Plant', q_kgs, quantity_liters, fat_percentage, snf_percentage || 8.0, clr_val, water_percentage || 0.0, rate, total_amount, notes || null]
    );
    const [row] = await pool.execute(
      `SELECT me.*, p.name AS provider_name
       FROM milk_entries me JOIN providers p ON me.provider_id = p.id
       WHERE me.id = ?`,
      [result.insertId]
    );
    res.status(201).json({ success: true, data: row[0], message: 'Milk entry saved successfully.' });
  } catch (err) {
    console.error('createEntry error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to save entry.' });
  }
};

const updateEntry = async (req, res) => {
  try {
    const { provider_id, date, shift, milk_type, milk_plant, quantity_kgs, fat_percentage, snf_percentage, clr, water_percentage, rate_per_liter, notes } = req.body;
    const [existing] = await pool.execute(
      'SELECT id FROM milk_entries WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!existing.length) return res.status(404).json({ success: false, message: 'Entry not found.' });

    if (!(await assertProviderBelongsToUser(provider_id, req.user.id))) {
      return res.status(404).json({ success: false, message: 'Provider not found.' });
    }

    const q_kgs = parseFloat(quantity_kgs);
    const clr_val = clr ? parseFloat(clr) : 28.00;
    const rate = parseFloat(rate_per_liter);

    const density = 1 + (clr_val / 1000);
    const quantity_liters = (q_kgs / density).toFixed(2);
    const total_amount = (parseFloat(quantity_liters) * rate).toFixed(2);

    await pool.execute(
      `UPDATE milk_entries SET provider_id=?, date=?, shift=?, milk_type=?, milk_plant=?, quantity_kgs=?, quantity_liters=?, fat_percentage=?, snf_percentage=?, clr=?, water_percentage=?,
       rate_per_liter=?, total_amount=?, notes=? WHERE id=? AND user_id=?`,
      [provider_id, date, shift || 'AM', milk_type || 'CM', milk_plant || 'Main Plant', q_kgs, quantity_liters, fat_percentage, snf_percentage || 8.0, clr_val, water_percentage || 0.0, rate, total_amount, notes || null, req.params.id, req.user.id]
    );
    const [row] = await pool.execute(
      `SELECT me.*, p.name AS provider_name
       FROM milk_entries me JOIN providers p ON me.provider_id = p.id
       WHERE me.id = ?`,
      [req.params.id]
    );
    res.json({ success: true, data: row[0], message: 'Entry updated.' });
  } catch (err) {
    console.error('updateEntry error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update entry.' });
  }
};

const deleteEntry = async (req, res) => {
  try {
    const [existing] = await pool.execute(
      'SELECT id FROM milk_entries WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!existing.length) return res.status(404).json({ success: false, message: 'Entry not found.' });
    await pool.execute('DELETE FROM milk_entries WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ success: true, message: 'Entry deleted.' });
  } catch (err) {
    console.error('deleteEntry error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete entry.' });
  }
};

const exportCSV = async (req, res) => {
  try {
    const userId = req.user.id;
    const { provider_id, milk_plant, date_from, date_to, fat_min, fat_max, qty_min, qty_max, search } = req.query;
    let where = 'WHERE me.user_id = ?';
    const params = [userId];

    if (provider_id) { where += ' AND me.provider_id = ?';         params.push(provider_id); }
    if (milk_plant)  { where += ' AND me.milk_plant = ?';          params.push(milk_plant); }
    if (date_from)   { where += ' AND me.date >= ?';               params.push(date_from); }
    if (date_to)     { where += ' AND me.date <= ?';               params.push(date_to); }
    if (fat_min)     { where += ' AND me.fat_percentage >= ?';     params.push(fat_min); }
    if (fat_max)     { where += ' AND me.fat_percentage <= ?';     params.push(fat_max); }
    if (qty_min)     { where += ' AND me.quantity_liters >= ?';    params.push(qty_min); }
    if (qty_max)     { where += ' AND me.quantity_liters <= ?';    params.push(qty_max); }
    if (search)      { where += ' AND p.name LIKE ?';              params.push(`%${search}%`); }

    const [rows] = await pool.query(
      `SELECT me.id, p.name AS provider_name, p.phone, me.date, me.shift, me.milk_type, me.milk_plant, me.quantity_kgs,
              me.quantity_liters, me.fat_percentage, me.snf_percentage, me.clr, me.water_percentage, me.rate_per_liter, me.total_amount, me.notes
       FROM milk_entries me JOIN providers p ON me.provider_id = p.id
       ${where}
       ORDER BY me.date DESC`,
      params
    );

    const headers = ['ID', 'Provider', 'Phone', 'Date', 'Shift', 'Milk Type', 'Milk Plant', 'Qty (Kgs)', 'Qty (L)', 'Fat %', 'SNF %', 'CLR', 'Water %', 'Rate/L', 'Total Amount', 'Notes'];
    const csv = [
      headers.join(','),
      ...rows.map(r => {
        let formattedDate = '';
        if (r.date) {
            try {
                const d = new Date(r.date);
                if (!isNaN(d.getTime())) formattedDate = d.toISOString().split('T')[0];
            } catch(e) {}
        }
        return [
          r.id, r.provider_name, r.phone || '', formattedDate, r.shift, r.milk_type, r.milk_plant || '',
          r.quantity_kgs, r.quantity_liters, r.fat_percentage, r.snf_percentage, r.clr, r.water_percentage,
          r.rate_per_liter, r.total_amount, r.notes || ''
        ].map(v => {
            const val = (v === null || v === undefined) ? '' : String(v);
            return `"${val.replace(/"/g, '""')}"`;
        }).join(',');
      })
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=milk_records.csv');
    res.send(csv);
  } catch (err) {
    console.error('exportCSV error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to export records.' });
  }
};

module.exports = { getAllEntries, getEntry, createEntry, updateEntry, deleteEntry, exportCSV };
