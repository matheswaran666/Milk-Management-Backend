const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { pool } = require('../config/db');
const { signToken } = require('../middleware/requireAuth');

// ── Simple in-memory rate-limit for failed logins ──────────────────────────
// Keyed by `${ip}|${email}`. Allows 5 failures per 15 min window.
const FAILURES = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;

const keyFor = (req, email) =>
  `${req.ip || 'unknown'}|${(email || '').toLowerCase()}`;

const isLocked = (key) => {
  const entry = FAILURES.get(key);
  if (!entry) return false;
  if (Date.now() - entry.firstAt > WINDOW_MS) {
    FAILURES.delete(key);
    return false;
  }
  return entry.count >= MAX_FAILS;
};

const recordFailure = (key) => {
  const entry = FAILURES.get(key);
  if (!entry || Date.now() - entry.firstAt > WINDOW_MS) {
    FAILURES.set(key, { count: 1, firstAt: Date.now() });
  } else {
    entry.count += 1;
  }
};

const clearFailures = (key) => FAILURES.delete(key);

// ── Helpers ────────────────────────────────────────────────────────────────
const sanitizeUser = (row) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  role: row.role || 'user',
  created_at: row.created_at,
});

const handleValidation = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({
      message: errors.array()[0].msg,
      errors: errors.array(),
    });
    return false;
  }
  return true;
};

// ── Validators ─────────────────────────────────────────────────────────────
const registerValidators = [
  body('name').trim().isLength({ min: 2, max: 80 })
    .withMessage('Name must be 2-80 characters.'),
  body('email').trim().toLowerCase().isEmail()
    .withMessage('Please enter a valid email address.'),
  body('password').isLength({ min: 8, max: 128 })
    .withMessage('Password must be at least 8 characters.'),
];

const loginValidators = [
  body('email').trim().toLowerCase().isEmail()
    .withMessage('Please enter a valid email address.'),
  body('password').isLength({ min: 1 })
    .withMessage('Password is required.'),
];

// ── Controllers ────────────────────────────────────────────────────────────
const register = async (req, res, next) => {
  try {
    if (!handleValidation(req, res)) return;
    const { name, email, password } = req.body;

    const [existing] = await pool.execute(
      'SELECT id FROM users WHERE email = ? LIMIT 1',
      [email]
    );
    if (existing.length) {
      return res.status(409).json({ message: 'An account with this email already exists.' });
    }

    const hash = await bcrypt.hash(password, 10);
    const [result] = await pool.execute(
      'INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)',
      [name.trim(), email, hash, 'user']
    );

    const [rows] = await pool.execute(
      'SELECT id, name, email, role, created_at FROM users WHERE id = ?',
      [result.insertId]
    );
    const user = sanitizeUser(rows[0]);
    const token = signToken({ sub: user.id, email: user.email, role: user.role });

    return res.status(201).json({ token, user });
  } catch (err) {
    next(err);
  }
};

const login = async (req, res, next) => {
  try {
    if (!handleValidation(req, res)) return;
    const { email, password } = req.body;
    const key = keyFor(req, email);

    if (isLocked(key)) {
      return res.status(429).json({
        message: 'Too many failed attempts. Please try again in a few minutes.',
      });
    }

    const [rows] = await pool.execute(
      'SELECT id, name, email, role, password_hash, created_at FROM users WHERE email = ? LIMIT 1',
      [email]
    );
    if (!rows.length) {
      recordFailure(key);
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    const ok = await bcrypt.compare(password, rows[0].password_hash);
    if (!ok) {
      recordFailure(key);
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    clearFailures(key);
    const user = sanitizeUser(rows[0]);
    const token = signToken({ sub: user.id, email: user.email, role: user.role });
    return res.json({ token, user });
  } catch (err) {
    next(err);
  }
};

const me = async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      'SELECT id, name, email, role, created_at FROM users WHERE id = ? LIMIT 1',
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ message: 'User not found.' });
    return res.json({ user: sanitizeUser(rows[0]) });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  register,
  login,
  me,
  registerValidators,
  loginValidators,
};
