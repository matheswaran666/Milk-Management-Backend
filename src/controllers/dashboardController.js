const { pool } = require('../config/db');

const getDashboard = async (req, res) => {
  try {
    const userId = req.user.id;

    const [todayRows] = await pool.execute(
      `SELECT COALESCE(SUM(quantity_liters), 0) AS total_liters,
              COALESCE(SUM(total_amount), 0)    AS total_amount,
              COUNT(*)                          AS entry_count
       FROM milk_entries WHERE user_id = ? AND date = CURDATE()`,
      [userId]
    );

    const [providerRows] = await pool.execute(
      `SELECT COUNT(*) AS active_providers FROM providers WHERE user_id = ? AND is_active = 1`,
      [userId]
    );

    const [monthRows] = await pool.execute(
      `SELECT COALESCE(SUM(quantity_liters), 0) AS total_liters,
              COALESCE(SUM(total_amount), 0)    AS total_amount
       FROM milk_entries
       WHERE user_id = ? AND YEAR(date) = YEAR(CURDATE()) AND MONTH(date) = MONTH(CURDATE())`,
      [userId]
    );

    const [payableRows] = await pool.execute(
      `SELECT COALESCE(SUM(total_amount), 0) AS total_payable
       FROM milk_entries WHERE user_id = ? AND date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)`,
      [userId]
    );

    const [trendRows] = await pool.execute(
      `SELECT date,
              SUM(quantity_liters) AS liters,
              SUM(total_amount)    AS amount
       FROM milk_entries
       WHERE user_id = ? AND date >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)
       GROUP BY date
       ORDER BY date ASC`,
      [userId]
    );

    const [providerContrib] = await pool.execute(
      `SELECT p.id, p.name,
              SUM(me.quantity_liters) AS liters,
              SUM(me.total_amount)    AS amount
       FROM milk_entries me
       JOIN providers p ON me.provider_id = p.id
       WHERE me.user_id = ?
         AND YEAR(me.date) = YEAR(CURDATE()) AND MONTH(me.date) = MONTH(CURDATE())
       GROUP BY p.id, p.name
       ORDER BY liters DESC
       LIMIT 7`,
      [userId]
    );

    const [topToday] = await pool.execute(
      `SELECT p.id, p.name,
              SUM(me.quantity_liters) AS liters
       FROM milk_entries me
       JOIN providers p ON me.provider_id = p.id
       WHERE me.user_id = ? AND me.date = CURDATE()
       GROUP BY p.id, p.name
       ORDER BY liters DESC
       LIMIT 1`,
      [userId]
    );

    const [[expenseToday]] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS today_expense FROM expenses WHERE user_id = ? AND date = CURDATE()`,
      [userId]
    );

    const [[expenseMonth]] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS month_expense
       FROM expenses
       WHERE user_id = ? AND YEAR(date) = YEAR(CURDATE()) AND MONTH(date) = MONTH(CURDATE())`,
      [userId]
    );

    const [[earningToday]] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS today_earning FROM earnings WHERE user_id = ? AND date = CURDATE()`,
      [userId]
    );

    const [[earningMonth]] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS month_earning
       FROM earnings
       WHERE user_id = ? AND YEAR(date) = YEAR(CURDATE()) AND MONTH(date) = MONTH(CURDATE())`,
      [userId]
    );

    // Categories visible to this user (global + own); aggregates only over user's expenses/earnings
    const [expenseByCategory] = await pool.execute(
      `SELECT ec.id, ec.name, ec.color,
              COALESCE(SUM(e.amount), 0) AS total
       FROM expense_categories ec
       LEFT JOIN expenses e
         ON e.category_id = ec.id
        AND e.user_id = ?
        AND YEAR(e.date) = YEAR(CURDATE())
        AND MONTH(e.date) = MONTH(CURDATE())
       WHERE ec.user_id IS NULL OR ec.user_id = ?
       GROUP BY ec.id, ec.name, ec.color
       ORDER BY total DESC
       LIMIT 6`,
      [userId, userId]
    );

    const [earningByCategory] = await pool.execute(
      `SELECT ec.id, ec.name, ec.color,
              COALESCE(SUM(e.amount), 0) AS total
       FROM earning_categories ec
       LEFT JOIN earnings e
         ON e.category_id = ec.id
        AND e.user_id = ?
        AND YEAR(e.date) = YEAR(CURDATE())
        AND MONTH(e.date) = MONTH(CURDATE())
       WHERE ec.user_id IS NULL OR ec.user_id = ?
       GROUP BY ec.id, ec.name, ec.color
       ORDER BY total DESC
       LIMIT 6`,
      [userId, userId]
    );

    const [expenseTrend] = await pool.execute(
      `SELECT date,
              SUM(amount) AS amount
       FROM expenses
       WHERE user_id = ? AND date >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)
       GROUP BY date
       ORDER BY date ASC`,
      [userId]
    );

    const [earningTrend] = await pool.execute(
      `SELECT date,
              SUM(amount) AS amount
       FROM earnings
       WHERE user_id = ? AND date >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)
       GROUP BY date
       ORDER BY date ASC`,
      [userId]
    );

    const monthMilkIncome = parseFloat(monthRows[0].total_amount);
    const monthOtherIncome = parseFloat(earningMonth.month_earning);
    const totalMonthIncome = monthMilkIncome + monthOtherIncome;
    const monthExpense = parseFloat(expenseMonth.month_expense);

    res.json({
      success: true,
      data: {
        today: {
          totalLiters:  parseFloat(todayRows[0].total_liters),
          totalAmount:  parseFloat(todayRows[0].total_amount) + parseFloat(earningToday.today_earning),
          entryCount:   todayRows[0].entry_count,
          topProvider:  topToday[0] || null,
          expenses:     parseFloat(expenseToday.today_expense),
        },
        month: {
          totalLiters:  parseFloat(monthRows[0].total_liters),
          totalAmount:  totalMonthIncome,
          expenses:     monthExpense,
          netIncome:    parseFloat((totalMonthIncome - monthExpense).toFixed(2)),
        },
        activeProviders:   providerRows[0].active_providers,
        totalPayable:      parseFloat(payableRows[0].total_payable),
        trend:             trendRows,
        expenseTrend,
        earningTrend,
        providerContrib,
        expenseByCategory,
        earningByCategory,
      }
    });
  } catch (err) {
    console.error('getDashboard Error:', err);
    res.status(500).json({ success: false, message: 'Failed to load dashboard data. Please try again.' });
  }
};

module.exports = { getDashboard };
