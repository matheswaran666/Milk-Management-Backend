require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const morgan  = require('morgan');
const { testConnection, ensureMilkPlantColumn, ensureUserScopingSchema } = require('./src/config/db');
const { notFound, errorHandler } = require('./src/middleware/errorHandler');

// ── Bootstrap JWT secret ───────────────────────────────────────────────────
// In dev, auto-generate a secret on first boot and persist it to .env so
// tokens stay valid across restarts. In production it MUST be set explicitly.
(function ensureJwtSecret() {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32) return;

  if (process.env.NODE_ENV === 'production') {
    console.error('❌ JWT_SECRET must be set in production. Refusing to start.');
    process.exit(1);
  }

  const secret = crypto.randomBytes(48).toString('hex');
  process.env.JWT_SECRET = secret;

  try {
    const envPath = path.join(__dirname, '.env');
    let body = '';
    if (fs.existsSync(envPath)) {
      body = fs.readFileSync(envPath, 'utf8');
      body = body.replace(/^JWT_SECRET=.*$/m, '').trimEnd();
    }
    fs.writeFileSync(envPath, `${body}\n\n# Auto-generated on first boot — keep secret\nJWT_SECRET=${secret}\n`);
    console.log('🔐 Generated and persisted JWT_SECRET in .env');
  } catch (err) {
    console.warn('⚠️  Could not persist JWT_SECRET to .env:', err.message);
  }
})();

const { requireAuth } = require('./src/middleware/requireAuth');

const app = express();

// Security & logging
app.use(helmet());
const allowedOrigins = (
  process.env.FRONTEND_URL ||
  'http://localhost:3000,http://localhost:8081,http://127.0.0.1:3000,http://127.0.0.1:8081'
)
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow server-to-server and same-origin requests without an Origin header.
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`Origin not allowed by CORS: ${origin}`));
    },
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
if (process.env.NODE_ENV !== 'production') app.use(morgan('dev'));

// Multer OCR writes here — ensure it exists regardless of cwd
fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });

// Public routes
app.use('/api/auth', require('./src/routes/auth'));
app.get('/api/health', (req, res) => res.json({ status: 'OK', timestamp: new Date() }));

// Protected routes
app.use('/api/providers',    requireAuth, require('./src/routes/providers'));
app.use('/api/milk-entries', requireAuth, require('./src/routes/milkEntries'));
app.use('/api/billing',      requireAuth, require('./src/routes/billing'));
app.use('/api/dashboard',    requireAuth, require('./src/routes/dashboard'));
app.use('/api/expenses',     requireAuth, require('./src/routes/expenses'));
app.use('/api/earnings',     requireAuth, require('./src/routes/earnings'));
app.use('/api/finance',      requireAuth, require('./src/routes/finance'));
app.use('/api/ocr',          requireAuth, require('./src/routes/ocr'));
app.use('/api/milk-plants',  requireAuth, require('./src/routes/milkPlants'));

// Error handling (must come AFTER routes)
app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

// ── Boot sequence ──────────────────────────────────────────────────────────
// 1. Probe the DB (non-fatal — see db.js).
// 2. If reachable, run idempotent schema migrations.
// 3. Start listening either way, so health checks + auth-less routes still
//    work during a DB outage. DB-backed handlers will surface a 5xx via the
//    error middleware, which is the correct behaviour for a transient outage.
async function start() {
  const dbOk = await testConnection();

  if (dbOk) {
    try {
      await ensureMilkPlantColumn();
      await ensureUserScopingSchema();
    } catch (err) {
      console.error('❌ Schema migration failed:', err.message);
      console.error('   → Continuing to start the server; fix the DB and retry migrations.');
    }
  } else {
    console.warn('⚠️  Skipping schema migrations — database is unreachable.');
  }

  const server = app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    if (!dbOk) {
      console.log('   (running in degraded mode — DB unreachable, only /api/health works)');
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`❌ Port ${PORT} is already in use. Stop the other process or set PORT in .env.`);
    } else {
      console.error('❌ Server failed to start:', err.message);
    }
    process.exit(1);
  });

  // Graceful shutdown — terminate the shared OCR worker so we don't leak the
  // WASM runtime on nodemon restarts.
  const ocrWorker = require('./src/utils/ocrWorker');
  const shutdown = async (sig) => {
    console.log(`\n${sig} received — shutting down...`);
    server.close();
    try { await ocrWorker.terminate(); } catch (_) {}
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

// Only auto-boot when this file is the entry point. When required by tests
// we just hand back `app` so supertest can drive it without binding a port.
if (require.main === module) {
  start().catch((err) => {
    console.error('❌ Fatal error during boot:', err);
    process.exit(1);
  });
}

module.exports = { app, start };
