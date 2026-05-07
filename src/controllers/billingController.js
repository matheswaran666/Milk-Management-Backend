const { pool } = require('../config/db');

// ── Helpers ─────────────────────────────────────────────────────────────────

// ISO date (YYYY-MM-DD) — strict format check + real-calendar validity
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isValidISODate = (s) => {
  if (typeof s !== 'string' || !ISO_DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  // Guard against silent rollover (e.g. 2024-02-30 → Mar 1)
  return s === d.toISOString().slice(0, 10);
};

// Coerce DB DECIMAL/strings to a finite number, defaulting to 0 for NULLs.
const toNum = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

const round2 = (n) => parseFloat((Number.isFinite(n) ? n : 0).toFixed(2));

// Cap free-text query params to a reasonable length.
const MAX_PLANT_LEN = 100;

// Generate bill for a provider
const generateBill = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { provider_id, date_from, date_to, milk_plant } = req.query;

    // ── Input validation ────────────────────────────────────────────────
    if (!provider_id || !date_from || !date_to) {
      return res.status(400).json({ success: false, message: 'Please select a provider and date range.' });
    }
    const providerIdNum = Number.parseInt(provider_id, 10);
    if (!Number.isInteger(providerIdNum) || providerIdNum <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid provider id.' });
    }
    if (!isValidISODate(date_from) || !isValidISODate(date_to)) {
      return res.status(400).json({ success: false, message: 'Dates must be in YYYY-MM-DD format.' });
    }
    if (date_from > date_to) {
      return res.status(400).json({ success: false, message: '"From" date cannot be after "To" date.' });
    }
    let plantFilter = null;
    if (milk_plant !== undefined && milk_plant !== '') {
      if (typeof milk_plant !== 'string' || milk_plant.length > MAX_PLANT_LEN) {
        return res.status(400).json({ success: false, message: 'Invalid milk plant filter.' });
      }
      plantFilter = milk_plant;
    }

    // ── Fetch provider (scoped to user) ────────────────────────────────
    const [providerRows] = await pool.execute(
      'SELECT * FROM providers WHERE id = ? AND user_id = ?',
      [providerIdNum, userId]
    );
    if (!providerRows.length) {
      return res.status(404).json({ success: false, message: 'Provider not found.' });
    }

    // ── Fetch entries in range ─────────────────────────────────────────
    let entriesQuery = `SELECT * FROM milk_entries WHERE user_id = ? AND provider_id = ? AND date BETWEEN ? AND ?`;
    const entriesParams = [userId, providerIdNum, date_from, date_to];
    if (plantFilter !== null) {
      entriesQuery += ` AND milk_plant = ?`;
      entriesParams.push(plantFilter);
    }
    entriesQuery += ` ORDER BY date ASC`;
    const [entries] = await pool.execute(entriesQuery, entriesParams);

    // ── Calculate Yearly Deepavali Bonus (cycle starts Oct 1) ─────────
    // Parse YYYY-MM-DD safely without timezone surprises.
    const [fy, fm] = date_from.split('-').map(Number);
    let bonusStartYear = fy;
    if (fm < 10) bonusStartYear -= 1;
    const bonusStartDate = `${bonusStartYear}-10-01`;

    let historyQuery = `SELECT SUM(quantity_liters) AS cycleTotalLiters
       FROM milk_entries
       WHERE user_id = ? AND provider_id = ? AND date >= ? AND date < ?`;
    const historyParams = [userId, providerIdNum, bonusStartDate, date_from];
    if (plantFilter !== null) {
      historyQuery += ` AND milk_plant = ?`;
      historyParams.push(plantFilter);
    }
    const [historyRows] = await pool.execute(historyQuery, historyParams);
    const openingBonusBalance = toNum(historyRows[0] && historyRows[0].cycleTotalLiters) / 2;

    if (!entries.length) {
      return res.json({
        success: true,
        data: {
          provider: providerRows[0],
          entries: [],
          summary: {
            totalKgs: 0, totalLiters: 0, totalAmount: 0,
            avgFat: 0, avgSnf: 0, avgClr: 0, avgRate: 0,
            entryCount: 0,
            openingBonusBalance: round2(openingBonusBalance),
            milkPlant: plantFilter || 'All Plants',
            dateFrom: date_from,
            dateTo: date_to,
          },
        },
      });
    }

    // ── Aggregate using NULL-safe coercion ─────────────────────────────
    const totalKgs    = entries.reduce((s, e) => s + toNum(e.quantity_kgs), 0);
    const totalLiters = entries.reduce((s, e) => s + toNum(e.quantity_liters), 0);
    const totalAmount = entries.reduce((s, e) => s + toNum(e.total_amount), 0);
    const avgFat      = entries.reduce((s, e) => s + toNum(e.fat_percentage), 0) / entries.length;
    const avgSnf      = entries.reduce((s, e) => s + toNum(e.snf_percentage), 0) / entries.length;
    const avgClr      = entries.reduce((s, e) => s + toNum(e.clr), 0) / entries.length;
    const avgRate     = entries.reduce((s, e) => s + toNum(e.rate_per_liter), 0) / entries.length;

    res.json({
      success: true,
      data: {
        provider: providerRows[0],
        entries,
        summary: {
          totalKgs:            round2(totalKgs),
          totalLiters:         round2(totalLiters),
          totalAmount:         round2(totalAmount),
          avgFat:              round2(avgFat),
          avgSnf:              round2(avgSnf),
          avgClr:              round2(avgClr),
          avgRate:             round2(avgRate),
          entryCount:          entries.length,
          openingBonusBalance: round2(openingBonusBalance),
          milkPlant:           plantFilter || 'All Plants',
          dateFrom:            date_from,
          dateTo:              date_to,
        },
      },
    });
  } catch (err) {
    // Delegate to centralized error handler (logs full error server-side,
    // returns a friendly message to the client).
    return next(err);
  }
};

const getMilkPlants = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { provider_id, date_from, date_to } = req.query;

    let query = `
      SELECT DISTINCT milk_plant
      FROM milk_entries
      WHERE user_id = ?
        AND milk_plant IS NOT NULL
        AND milk_plant <> ''
    `;
    const params = [userId];

    if (provider_id !== undefined && provider_id !== '') {
      const pid = Number.parseInt(provider_id, 10);
      if (!Number.isInteger(pid) || pid <= 0) {
        return res.status(400).json({ success: false, message: 'Invalid provider id.' });
      }
      query += ` AND provider_id = ?`;
      params.push(pid);
    }
    if (date_from !== undefined && date_from !== '') {
      if (!isValidISODate(date_from)) {
        return res.status(400).json({ success: false, message: '"date_from" must be in YYYY-MM-DD format.' });
      }
      query += ` AND date >= ?`;
      params.push(date_from);
    }
    if (date_to !== undefined && date_to !== '') {
      if (!isValidISODate(date_to)) {
        return res.status(400).json({ success: false, message: '"date_to" must be in YYYY-MM-DD format.' });
      }
      query += ` AND date <= ?`;
      params.push(date_to);
    }
    query += ` ORDER BY milk_plant ASC`;

    const [rows] = await pool.execute(query, params);
    res.json({ success: true, data: rows.map((r) => r.milk_plant) });
  } catch (err) {
    return next(err);
  }
};

// Summary reports — fully ONLY_FULL_GROUP_BY compliant, scoped per user.
const ALLOWED_SUMMARY_TYPES = new Set(['daily', 'weekly', 'monthly']);

const getSummaryReport = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { provider_id } = req.query;
    const type = req.query.type || 'monthly';

    if (!ALLOWED_SUMMARY_TYPES.has(type)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid summary type. Use one of: daily, weekly, monthly.',
      });
    }

    // Whitelisted SQL fragments — never interpolate user input directly.
    const PERIOD_BY_TYPE = {
      daily:   'DATE_FORMAT(me.date, "%Y-%m-%d")',
      weekly:  'DATE_FORMAT(me.date, "%x-W%v")',
      monthly: 'DATE_FORMAT(me.date, "%Y-%m")',
    };
    const periodExpr = PERIOD_BY_TYPE[type];
    const groupByExpr = periodExpr;

    let query = `
      SELECT
        ${periodExpr}            AS period,
        p.id                     AS provider_id,
        p.name                   AS provider_name,
        COUNT(me.id)             AS entry_count,
        SUM(me.quantity_liters)  AS total_liters,
        AVG(me.fat_percentage)   AS avg_fat,
        AVG(me.rate_per_liter)   AS avg_rate,
        SUM(me.total_amount)     AS total_amount
      FROM milk_entries me
      JOIN providers p ON me.provider_id = p.id AND p.user_id = me.user_id
      WHERE me.user_id = ?
    `;
    const params = [userId];

    if (provider_id !== undefined && provider_id !== '') {
      const pid = Number.parseInt(provider_id, 10);
      if (!Number.isInteger(pid) || pid <= 0) {
        return res.status(400).json({ success: false, message: 'Invalid provider id.' });
      }
      query += ' AND me.provider_id = ?';
      params.push(pid);
    }

    query += ` GROUP BY ${groupByExpr}, p.id, p.name ORDER BY period DESC`;

    const [rows] = await pool.execute(query, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    return next(err);
  }
};

module.exports = { generateBill, getSummaryReport, getMilkPlants };
