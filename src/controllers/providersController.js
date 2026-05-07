const { pool } = require('../config/db');

const getAllProviders = async (req, res) => {
  try {
    const userId = req.user.id;
    const { search, active } = req.query;
    let where = 'WHERE user_id = ?';
    const params = [userId];
    if (search) {
      where += ' AND (name LIKE ? OR phone LIKE ? OR address LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s);
    }
    if (active !== undefined) {
      where += ' AND is_active = ?';
      params.push(active === 'true' ? 1 : 0);
    }
    const [rows] = await pool.execute(`SELECT * FROM providers ${where} ORDER BY name ASC`, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to load providers.' });
  }
};

const getProvider = async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM providers WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Provider not found.' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to load provider.' });
  }
};

const createProvider = async (req, res) => {
  try {
    const { name, phone, address, notes, route } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ success: false, message: 'Provider name is required.' });
    const [result] = await pool.execute(
      'INSERT INTO providers (user_id, name, phone, address, notes, route) VALUES (?, ?, ?, ?, ?, ?)',
      [req.user.id, name.trim(), phone || null, address || null, notes || null, route || 'LOCAL']
    );
    const [row] = await pool.execute('SELECT * FROM providers WHERE id = ?', [result.insertId]);
    res.status(201).json({ success: true, data: row[0], message: 'Provider added successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to add provider.' });
  }
};

const updateProvider = async (req, res) => {
  try {
    const { name, phone, address, notes, route, is_active } = req.body;
    const [existing] = await pool.execute(
      'SELECT id FROM providers WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!existing.length) return res.status(404).json({ success: false, message: 'Provider not found.' });
    await pool.execute(
      'UPDATE providers SET name=?, phone=?, address=?, notes=?, route=?, is_active=? WHERE id=? AND user_id=?',
      [name, phone || null, address || null, notes || null, route || 'LOCAL', is_active !== undefined ? is_active : 1, req.params.id, req.user.id]
    );
    const [row] = await pool.execute('SELECT * FROM providers WHERE id = ?', [req.params.id]);
    res.json({ success: true, data: row[0], message: 'Provider updated.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to update provider.' });
  }
};

const deleteProvider = async (req, res) => {
  try {
    const [existing] = await pool.execute(
      'SELECT id FROM providers WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!existing.length) return res.status(404).json({ success: false, message: 'Provider not found.' });
    await pool.execute('DELETE FROM providers WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ success: true, message: 'Provider deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to delete provider.' });
  }
};

module.exports = { getAllProviders, getProvider, createProvider, updateProvider, deleteProvider };
