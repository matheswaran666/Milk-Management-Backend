const { pool } = require('../config/db');

const getFinanceSummary = async (req, res) => {
  try {
    const userId = req.user.id;
    const { date_from, date_to, period = 'monthly' } = req.query;

    const from = date_from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
    const to   = date_to   || new Date().toISOString().split('T')[0];

    // ── Overall totals for selected range ──
    const [[income]] = await pool.execute(
      `SELECT COALESCE(SUM(total_amount), 0) AS total,
              COUNT(*)                        AS entry_count,
              COALESCE(SUM(quantity_liters), 0) AS total_liters
       FROM milk_entries WHERE user_id = ? AND date BETWEEN ? AND ?`,
      [userId, from, to]
    );

    const [[expenses]] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS total,
              COUNT(*)                  AS entry_count
       FROM expenses WHERE user_id = ? AND date BETWEEN ? AND ?`,
      [userId, from, to]
    );

    const [[earnings]] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS total,
              COUNT(*)                  AS entry_count
       FROM earnings WHERE user_id = ? AND date BETWEEN ? AND ?`,
      [userId, from, to]
    );

    // ── Today ──
    const [[todayMilk]] = await pool.execute(
      `SELECT COALESCE(SUM(total_amount), 0) AS total FROM milk_entries WHERE user_id = ? AND date = CURDATE()`,
      [userId]
    );
    const [[todayExpense]] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE user_id = ? AND date = CURDATE()`,
      [userId]
    );
    const [[todayEarning]] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM earnings WHERE user_id = ? AND date = CURDATE()`,
      [userId]
    );

    // ── This month ──
    const [[monthMilk]] = await pool.execute(
      `SELECT COALESCE(SUM(total_amount), 0) AS total
       FROM milk_entries WHERE user_id = ? AND YEAR(date)=YEAR(CURDATE()) AND MONTH(date)=MONTH(CURDATE())`,
      [userId]
    );
    const [[monthExpense]] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM expenses WHERE user_id = ? AND YEAR(date)=YEAR(CURDATE()) AND MONTH(date)=MONTH(CURDATE())`,
      [userId]
    );
    const [[monthEarning]] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM earnings WHERE user_id = ? AND YEAR(date)=YEAR(CURDATE()) AND MONTH(date)=MONTH(CURDATE())`,
      [userId]
    );

    // ── This year ──
    const [[yearMilk]] = await pool.execute(
      `SELECT COALESCE(SUM(total_amount), 0) AS total
       FROM milk_entries WHERE user_id = ? AND YEAR(date)=YEAR(CURDATE())`,
      [userId]
    );
    const [[yearExpense]] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM expenses WHERE user_id = ? AND YEAR(date)=YEAR(CURDATE())`,
      [userId]
    );
    const [[yearEarning]] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM earnings WHERE user_id = ? AND YEAR(date)=YEAR(CURDATE())`,
      [userId]
    );

    const [milkTrend] = await pool.execute(
      `SELECT DATE_FORMAT(date, '%Y-%m') AS period,
               SUM(total_amount)          AS amount
        FROM milk_entries
        WHERE user_id = ? AND date BETWEEN ? AND ?
        GROUP BY DATE_FORMAT(date, '%Y-%m')
        ORDER BY period ASC`,
      [userId, from, to]
    );

    const [earningTrend] = await pool.execute(
      `SELECT DATE_FORMAT(date, '%Y-%m') AS period,
               SUM(amount)                AS amount
        FROM earnings
        WHERE user_id = ? AND date BETWEEN ? AND ?
        GROUP BY DATE_FORMAT(date, '%Y-%m')
        ORDER BY period ASC`,
      [userId, from, to]
    );

    const [expenseTrend] = await pool.execute(
      `SELECT DATE_FORMAT(date, '%Y-%m') AS period,
               SUM(amount)                AS amount
        FROM expenses
        WHERE user_id = ? AND date BETWEEN ? AND ?
        GROUP BY DATE_FORMAT(date, '%Y-%m')
        ORDER BY period ASC`,
      [userId, from, to]
    );

    // ── Expense & Earning breakdown by category ──
    const [expenseByCategory] = await pool.execute(
      `SELECT ec.id, ec.name, ec.color,
              COALESCE(SUM(e.amount), 0) AS total,
              COUNT(e.id)                AS count
       FROM expense_categories ec
       LEFT JOIN expenses e ON e.category_id = ec.id
         AND e.user_id = ?
         AND e.date BETWEEN ? AND ?
       WHERE ec.user_id IS NULL OR ec.user_id = ?
       GROUP BY ec.id, ec.name, ec.color
       HAVING total > 0
       ORDER BY total DESC`,
      [userId, from, to, userId]
    );

    const [earningByCategory] = await pool.execute(
      `SELECT ec.id, ec.name, ec.color,
              COALESCE(SUM(e.amount), 0) AS total,
              COUNT(e.id)                AS count
       FROM earning_categories ec
       LEFT JOIN earnings e ON e.category_id = ec.id
         AND e.user_id = ?
         AND e.date BETWEEN ? AND ?
       WHERE ec.user_id IS NULL OR ec.user_id = ?
       GROUP BY ec.id, ec.name, ec.color
       HAVING total > 0
       ORDER BY total DESC`,
      [userId, from, to, userId]
    );

    // ── Monthly P&L for last 12 months ──
    const [monthly] = await pool.execute(
      `SELECT months.period,
              COALESCE(i.income,  0) + COALESCE(e.earning, 0) AS income,
              COALESCE(ex.expense, 0) AS expense
       FROM (
         SELECT DATE_FORMAT(date, '%Y-%m') AS period FROM milk_entries
         WHERE user_id = ? AND date >= DATE_SUB(CURDATE(), INTERVAL 11 MONTH)
         GROUP BY DATE_FORMAT(date, '%Y-%m')
         UNION
         SELECT DATE_FORMAT(date, '%Y-%m') AS period FROM expenses
         WHERE user_id = ? AND date >= DATE_SUB(CURDATE(), INTERVAL 11 MONTH)
         GROUP BY DATE_FORMAT(date, '%Y-%m')
         UNION
         SELECT DATE_FORMAT(date, '%Y-%m') AS period FROM earnings
         WHERE user_id = ? AND date >= DATE_SUB(CURDATE(), INTERVAL 11 MONTH)
         GROUP BY DATE_FORMAT(date, '%Y-%m')
       ) months
       LEFT JOIN (
         SELECT DATE_FORMAT(date, '%Y-%m') AS p, SUM(total_amount) AS income
         FROM milk_entries
         WHERE user_id = ? AND date >= DATE_SUB(CURDATE(), INTERVAL 11 MONTH)
         GROUP BY DATE_FORMAT(date, '%Y-%m')
       ) i ON i.p = months.period
       LEFT JOIN (
         SELECT DATE_FORMAT(date, '%Y-%m') AS p, SUM(amount) AS earning
         FROM earnings
         WHERE user_id = ? AND date >= DATE_SUB(CURDATE(), INTERVAL 11 MONTH)
         GROUP BY DATE_FORMAT(date, '%Y-%m')
       ) e ON e.p = months.period
       LEFT JOIN (
         SELECT DATE_FORMAT(date, '%Y-%m') AS p, SUM(amount) AS expense
         FROM expenses
         WHERE user_id = ? AND date >= DATE_SUB(CURDATE(), INTERVAL 11 MONTH)
         GROUP BY DATE_FORMAT(date, '%Y-%m')
       ) ex ON ex.p = months.period
       ORDER BY months.period ASC`,
      [userId, userId, userId, userId, userId, userId]
    );

    const combinedIncomeTrend = [];
    const periods = new Set([...milkTrend.map(t => t.period), ...earningTrend.map(t => t.period)]);
    Array.from(periods).sort().forEach(p => {
      const milk = milkTrend.find(t => t.period === p)?.amount || 0;
      const other = earningTrend.find(t => t.period === p)?.amount || 0;
      combinedIncomeTrend.push({ period: p, amount: parseFloat(milk) + parseFloat(other) });
    });

    const totalIncome  = parseFloat(income.total) + parseFloat(earnings.total);
    const totalExpense = parseFloat(expenses.total);

    const [topDays] = await pool.execute(
      `SELECT date, SUM(total_amount) AS amount FROM milk_entries
       WHERE user_id = ? AND date BETWEEN ? AND ? GROUP BY date ORDER BY amount DESC LIMIT 5`,
      [userId, from, to]
    );

    const [topExpenseDays] = await pool.execute(
      `SELECT date, SUM(amount) AS amount FROM expenses
       WHERE user_id = ? AND date BETWEEN ? AND ? GROUP BY date ORDER BY amount DESC LIMIT 5`,
      [userId, from, to]
    );

    res.json({
      success: true,
      data: {
        range:    { from, to },
        summary: {
          income:       totalIncome,
          expenses:     totalExpense,
          profit:       parseFloat((totalIncome - totalExpense).toFixed(2)),
          profitMargin: totalIncome > 0 ? parseFloat(((totalIncome - totalExpense) / totalIncome * 100).toFixed(1)) : 0,
          incomeEntries:   parseInt(income.entry_count) + parseInt(earnings.entry_count),
          expenseEntries:  expenses.entry_count,
          totalLiters:     parseFloat(income.total_liters),
        },
        today: {
          income:  parseFloat(todayMilk.total) + parseFloat(todayEarning.total),
          expense: parseFloat(todayExpense.total),
          profit:  parseFloat((parseFloat(todayMilk.total) + parseFloat(todayEarning.total) - parseFloat(todayExpense.total)).toFixed(2)),
        },
        month: {
          income:  parseFloat(monthMilk.total) + parseFloat(monthEarning.total),
          expense: parseFloat(monthExpense.total),
          profit:  parseFloat((parseFloat(monthMilk.total) + parseFloat(monthEarning.total) - parseFloat(monthExpense.total)).toFixed(2)),
        },
        year: {
          income:  parseFloat(yearMilk.total) + parseFloat(yearEarning.total),
          expense: parseFloat(yearExpense.total),
          profit:  parseFloat((parseFloat(yearMilk.total) + parseFloat(yearEarning.total) - parseFloat(yearExpense.total)).toFixed(2)),
        },
        monthly,
        incomeTrend: combinedIncomeTrend,
        expenseTrend,
        expenseByCategory,
        earningByCategory,
        topDays,
        topExpenseDays,
      }
    });
  } catch (err) {
    console.error('getFinanceSummary Error:', err);
    res.status(500).json({ success: false, message: 'Failed to load finance summary.' });
  }
};

module.exports = { getFinanceSummary };
