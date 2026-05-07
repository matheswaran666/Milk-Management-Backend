/**
 * Health endpoint contract: /api/health is public and always 200 with
 * { status: 'OK', timestamp }. Drives the express app directly via
 * supertest — no port binding, no DB required.
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'a'.repeat(48);

jest.mock('../src/config/db', () => ({
  testConnection: jest.fn().mockResolvedValue(true),
  ensureMilkPlantColumn: jest.fn().mockResolvedValue(undefined),
  ensureUserScopingSchema: jest.fn().mockResolvedValue(undefined),
  pool: { end: jest.fn().mockResolvedValue(undefined) },
}));

const request = require('supertest');
const { app } = require('../server');

describe('GET /api/health', () => {
  it('returns 200 with status OK and a timestamp', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('OK');
    expect(res.body.timestamp).toBeDefined();
    expect(new Date(res.body.timestamp).toString()).not.toBe('Invalid Date');
  });

  it('does not require auth', async () => {
    const res = await request(app).get('/api/health'); // no Authorization header
    expect(res.status).toBe(200);
  });
});
