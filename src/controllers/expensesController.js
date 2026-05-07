const { pool } = require('../config/db');

// Categories: NULL user_id = system default (visible to all users);
// otherwise scoped to the owner.
// CRUD on categories: users can only modify/delete their own.

// ─── CATEGORIES ──────────────────────────────────────────────

const getCategories = async (req, res) => {
  try {
    const userId = req.user.id;
    const [rows] = await pool.execute(
      `SELECT ec.id, ec.user_id, ec.name, ec.color, ec.icon, ec.created_at,
              COUNT(e.id)              AS expense_count,
              COALESCE(SUM(e.amount), 0) AS total_amount
       FROM expense_categories ec
       LEFT JOIN expenses e
         ON e.category_id = ec.id AND e.user_id = ?
       WHERE ec.user_id IS NULL OR ec.user_id = ?
       GROUP BY ec.id, ec.user_id, ec.name, ec.color, ec.icon, ec.created_at
       ORDER BY ec.name ASC`,
      [userId, userId]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to load categories.' });
  }
};

const createCategory = async (req, res) => {
  try {
    const { name, color, icon } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Category name is required.' });
    const [result] = await pool.execute(
      'INSERT INTO expense_categories (user_id, name, color, icon) VALUES (?, ?, ?, ?)',
      [req.user.id, name, color || '#1a6b3c', icon || 'receipt']
    );
    const [row] = await pool.execute('SELECT * FROM expense_categories WHERE id = ?', [result.insertId]);
    res.status(201).json({ success: true, data: row[0], message: 'Category created.' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'A category with that name already exists.' });
    }
    res.status(500).json({ success: false, message: 'Failed to create category.' });
  }
};

const updateCategory = async (req, res) => {
  try {
    const { name, color, icon } = req.body;
    const [existing] = await pool.execute(
      'SELECT id, user_id FROM expense_categories WHERE id = ?',
      [req.params.id]
    );
    if (!existing.length) return res.status(404).json({ success: false, message: 'Category not found.' });
    if (existing[0].user_id === null) {
      return res.status(403).json({ success: false, message: 'Default categories cannot be edited.' });
    }
    if (existing[0].user_id !== req.user.id) {
      return res.status(404).json({ success: false, message: 'Category not found.' });
    }
    await pool.execute(
      'UPDATE expense_categories SET name=?, color=?, icon=? WHERE id=? AND user_id=?',
      [name, color || '#1a6b3c', icon || 'receipt', req.params.id, req.user.id]
    );
    const [row] = await pool.execute('SELECT * FROM expense_categories WHERE id = ?', [req.params.id]);
    res.json({ success: true, data: row[0], message: 'Category updated.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to update category.' });
  }
};

const deleteCategory = async (req, res) => {
  try {
    const [existing] = await pool.execute(
      'SELECT id, user_id FROM expense_categories WHERE id = ?',
      [req.params.id]
    );
    if (!existing.length) return res.status(404).json({ success: false, message: 'Category not found.' });
    if (existing[0].user_id === null) {
      return res.status(403).json({ success: false, message: 'Default categories cannot be deleted.' });
    }
    if (existing[0].user_id !== req.user.id) {
      return res.status(404).json({ success: false, message: 'Category not found.' });
    }
    await pool.execute('DELETE FROM expense_categories WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ success: true, message: 'Category deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to delete category.' });
  }
};

// ─── EXPENSES ────────────────────────────────────────────────

const getAllExpenses = async (req, res) => {
  try {
    const userId = req.user.id;
    const { category_id, date_from, date_to, payment_method, search, page = 1, limit = 20 } = req.query;

    let where = 'WHERE e.user_id = ?';
    const params = [userId];

    if (category_id)    { where += ' AND e.category_id = ?';              params.push(category_id); }
    if (date_from)      { where += ' AND e.date >= ?';                    params.push(date_from); }
    if (date_to)        { where += ' AND e.date <= ?';                    params.push(date_to); }
    if (payment_method) { where += ' AND e.payment_method = ?';           params.push(payment_method); }
    if (search)         {
      where += ' AND (e.title LIKE ? OR e.description LIKE ?)';
      const s = `%${search}%`; params.push(s, s);
    }

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM expenses e LEFT JOIN expense_categories ec ON e.category_id = ec.id ${where}`,
      params
    );

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const [rows] = await pool.query(
      `SELECT e.id, e.category_id, e.title, e.description, e.amount, e.date,
              e.payment_method, e.reference_no, e.receipt_note, e.created_at,
              ec.name AS category_name, ec.color AS category_color, ec.icon AS category_icon
       FROM expenses e
       LEFT JOIN expense_categories ec ON e.category_id = ec.id
       ${where}
       ORDER BY e.date DESC, e.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    res.json({
      success: true,
      data: rows,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, totalPages: Math.ceil(total / parseInt(limit)) }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to load expenses.' });
  }
};

const getExpense = async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT e.*, ec.name AS category_name
       FROM expenses e
       LEFT JOIN expense_categories ec ON e.category_id = ec.id
       WHERE e.id = ? AND e.user_id = ?`,
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Expense not found.' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to load expense.' });
  }
};

// Verify a category is usable by this user (NULL = global OR owned by user).
const assertCategoryAccessible = async (categoryId, userId) => {
  if (!categoryId) return true;
  const [rows] = await pool.execute(
    'SELECT id FROM expense_categories WHERE id = ? AND (user_id IS NULL OR user_id = ?) LIMIT 1',
    [categoryId, userId]
  );
  return rows.length > 0;
};

const createExpense = async (req, res) => {
  try {
    const { category_id, title, description, amount, date, payment_method, reference_no, receipt_note } = req.body;
    if (!title || !amount || !date) {
      return res.status(400).json({ success: false, message: 'Title, amount, and date are required.' });
    }
    if (isNaN(amount) || parseFloat(amount) <= 0) {
      return res.status(400).json({ success: false, message: 'Amount must be a positive number.' });
    }
    if (category_id && !(await assertCategoryAccessible(category_id, req.user.id))) {
      return res.status(400).json({ success: false, message: 'Invalid category.' });
    }
    const [result] = await pool.execute(
      `INSERT INTO expenses (user_id, category_id, title, description, amount, date, payment_method, reference_no, receipt_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, category_id || null, title, description || null, amount, date,
       payment_method || 'cash', reference_no || null, receipt_note || null]
    );
    const [row] = await pool.execute(
      `SELECT e.*, ec.name AS category_name, ec.color AS category_color
       FROM expenses e LEFT JOIN expense_categories ec ON e.category_id = ec.id
       WHERE e.id = ?`,
      [result.insertId]
    );
    res.status(201).json({ success: true, data: row[0], message: 'Expense added successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to add expense.' });
  }
};

const updateExpense = async (req, res) => {
  try {
    const { category_id, title, description, amount, date, payment_method, reference_no, receipt_note } = req.body;
    const [existing] = await pool.execute(
      'SELECT id FROM expenses WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!existing.length) return res.status(404).json({ success: false, message: 'Expense not found.' });
    if (category_id && !(await assertCategoryAccessible(category_id, req.user.id))) {
      return res.status(400).json({ success: false, message: 'Invalid category.' });
    }
    await pool.execute(
      `UPDATE expenses SET category_id=?, title=?, description=?, amount=?, date=?,
       payment_method=?, reference_no=?, receipt_note=? WHERE id=? AND user_id=?`,
      [category_id || null, title, description || null, amount, date,
       payment_method || 'cash', reference_no || null, receipt_note || null, req.params.id, req.user.id]
    );
    const [row] = await pool.execute(
      `SELECT e.*, ec.name AS category_name, ec.color AS category_color
       FROM expenses e LEFT JOIN expense_categories ec ON e.category_id = ec.id
       WHERE e.id = ?`,
      [req.params.id]
    );
    res.json({ success: true, data: row[0], message: 'Expense updated.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to update expense.' });
  }
};

const deleteExpense = async (req, res) => {
  try {
    const [existing] = await pool.execute(
      'SELECT id FROM expenses WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!existing.length) return res.status(404).json({ success: false, message: 'Expense not found.' });
    await pool.execute('DELETE FROM expenses WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ success: true, message: 'Expense deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to delete expense.' });
  }
};

// ─── SUMMARY ─────────────────────────────────────────────────

const getExpenseSummary = async (req, res) => {
  try {
    const userId = req.user.id;
    const { date_from, date_to, group_by = 'category' } = req.query;
    let dateFilter = ' AND e.user_id = ?';
    const params = [userId];
    if (date_from) { dateFilter += ' AND e.date >= ?'; params.push(date_from); }
    if (date_to)   { dateFilter += ' AND e.date <= ?'; params.push(date_to); }

    let query;
    if (group_by === 'month') {
      query = `
        SELECT DATE_FORMAT(e.date, '%Y-%m') AS period,
               COUNT(*)       AS count,
               SUM(e.amount)  AS total
        FROM expenses e
        WHERE 1=1 ${dateFilter}
        GROUP BY DATE_FORMAT(e.date, '%Y-%m')
        ORDER BY period DESC
      `;
    } else if (group_by === 'payment') {
      query = `
        SELECT e.payment_method AS period,
               COUNT(*)         AS count,
               SUM(e.amount)    AS total
        FROM expenses e
        WHERE 1=1 ${dateFilter}
        GROUP BY e.payment_method
        ORDER BY total DESC
      `;
    } else {
      // category — visible categories = global ∪ user's own
      query = `
        SELECT ec.name AS period, ec.color, ec.icon,
               COUNT(e.id)                AS count,
               COALESCE(SUM(e.amount), 0) AS total
        FROM expense_categories ec
        LEFT JOIN expenses e
          ON e.category_id = ec.id
         AND e.user_id = ?
         ${date_from ? 'AND e.date >= ?' : ''}
         ${date_to ? 'AND e.date <= ?' : ''}
        WHERE ec.user_id IS NULL OR ec.user_id = ?
        GROUP BY ec.id, ec.name, ec.color, ec.icon
        ORDER BY total DESC
      `;
      // Build params: userId for join, optional dates, then userId for outer WHERE
      const catParams = [userId];
      if (date_from) catParams.push(date_from);
      if (date_to) catParams.push(date_to);
      catParams.push(userId);
      const [rows] = await pool.query(query, catParams);
      const [[totals]] = await pool.query(
        `SELECT COUNT(*)                                                          AS count,
                COALESCE(SUM(amount), 0)                                          AS total,
                COALESCE(SUM(CASE WHEN date = CURDATE() THEN amount ELSE 0 END), 0) AS today_total,
                COALESCE(SUM(CASE WHEN YEAR(date)=YEAR(CURDATE())
                                   AND MONTH(date)=MONTH(CURDATE())
                                   THEN amount ELSE 0 END), 0)                     AS month_total
         FROM expenses e WHERE 1=1 ${dateFilter}`,
        params
      );
      return res.json({ success: true, data: rows, totals });
    }

    const [rows] = await pool.query(query, params);

    const [[totals]] = await pool.query(
      `SELECT COUNT(*)                                                          AS count,
              COALESCE(SUM(amount), 0)                                          AS total,
              COALESCE(SUM(CASE WHEN date = CURDATE() THEN amount ELSE 0 END), 0) AS today_total,
              COALESCE(SUM(CASE WHEN YEAR(date)=YEAR(CURDATE())
                                 AND MONTH(date)=MONTH(CURDATE())
                                 THEN amount ELSE 0 END), 0)                     AS month_total
       FROM expenses e WHERE 1=1 ${dateFilter}`,
      params
    );

    res.json({ success: true, data: rows, totals });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to load expense summary.' });
  }
};

// ─── CSV EXPORT ───────────────────────────────────────────────

const exportExpensesCSV = async (req, res) => {
  try {
    const userId = req.user.id;
    const { category_id, date_from, date_to, payment_method, search } = req.query;
    let where = 'WHERE e.user_id = ?';
    const params = [userId];
    if (category_id)    { where += ' AND e.category_id = ?';              params.push(category_id); }
    if (date_from)      { where += ' AND e.date >= ?';                    params.push(date_from); }
    if (date_to)        { where += ' AND e.date <= ?';                    params.push(date_to); }
    if (payment_method) { where += ' AND e.payment_method = ?';           params.push(payment_method); }
    if (search) {
      where += ' AND (e.title LIKE ? OR e.description LIKE ?)';
      const s = `%${search}%`; params.push(s, s);
    }

    const [rows] = await pool.query(
      `SELECT e.id, ec.name AS category, e.title, e.description, e.amount,
              e.date, e.payment_method, e.reference_no, e.receipt_note
       FROM expenses e
       LEFT JOIN expense_categories ec ON e.category_id = ec.id
       ${where}
       ORDER BY e.date DESC`,
      params
    );

    const headers = ['ID', 'Category', 'Title', 'Description', 'Amount', 'Date', 'Payment Method', 'Reference', 'Notes'];
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
          r.id, r.category || '', r.title, r.description || '',
          r.amount, formattedDate, r.payment_method, r.reference_no || '', r.receipt_note || ''
        ].map(v => {
            const val = (v === null || v === undefined) ? '' : String(v);
            return `"${val.replace(/"/g, '""')}"`;
        }).join(',');
      })
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=expenses.csv');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to export expenses.' });
  }
};

module.exports = {
  getCategories, createCategory, updateCategory, deleteCategory,
  getAllExpenses, getExpense, createExpense, updateExpense, deleteExpense,
  getExpenseSummary, exportExpensesCSV,
};
