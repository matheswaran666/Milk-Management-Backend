/**
 * Boot resilience: when the DB probe fails the server must still bind and
 * serve /api/health (degraded mode). Mocks the db module so testConnection
 * resolves false, then runs the real boot sequence on an ephemeral port.
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'a'.repeat(48);
process.env.PORT = '0'; // let the OS pick a free port

jest.mock('../src/config/db', () => ({
  testConnection: jest.fn().mockResolvedValue(false),
  ensureMilkPlantColumn: jest.fn().mockResolvedValue(undefined),
  ensureUserScopingSchema: jest.fn().mockResolvedValue(undefined),
  pool: { end: jest.fn().mockResolvedValue(undefined) },
}));

const request = require('supertest');
const db = require('../src/config/db');
const { start } = require('../server');

describe('boot resilience', () => {
  let server;

  afterAll(async () => {
    if (server && server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('still binds and serves /api/health when the DB is unreachable', async () => {
    server = await start();

    // Sanity: our mock was actually consulted, and the migration helpers
    // were skipped because the probe failed.
    expect(db.testConnection).toHaveBeenCalled();
    expect(db.ensureMilkPlantColumn).not.toHaveBeenCalled();
    expect(db.ensureUserScopingSchema).not.toHaveBeenCalled();

    const res = await request(server).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('OK');
  });
});
