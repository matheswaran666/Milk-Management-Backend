#!/usr/bin/env node
/**
 * Lightweight API smoke checks. Expects the backend already listening
 * (e.g. `npm start` in another shell). Loads backend/.env for PORT when set.
 */
const http = require('http');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const port = Number(process.env.PORT || 5000);
const host = process.env.SMOKE_HOST || '127.0.0.1';

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path, timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', (c) => {
        body += c;
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`timeout GET ${path}`));
    });
  });
}

(async () => {
  const checks = [
    ['/api/health', (r) => r.status === 200 && r.body.includes('"OK"')],
    ['/api/dashboard', (r) => r.status === 200 && r.body.includes('"success":true')],
    ['/api/milk-plants/options', (r) => r.status === 200 && r.body.includes('"success":true')],
  ];

  for (const [path, ok] of checks) {
    try {
      const res = await get(path);
      if (!ok(res)) {
        console.error(`FAIL ${path} → status=${res.status} body=${res.body.slice(0, 200)}`);
        process.exit(1);
      }
      console.log(`ok ${path}`);
    } catch (e) {
      console.error(`FAIL ${path}: ${e.message}`);
      console.error('Is the API server running? Try: cd backend && npm start');
      process.exit(1);
    }
  }
  console.log('All smoke checks passed.');
})();
