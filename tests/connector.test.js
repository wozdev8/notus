import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, '..', 'connector', 'server.js');
const TEST_PORT = 19471;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

let serverProcess;

function fetch_(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
}

beforeAll(async () => {
  // Start server on test port
  serverProcess = spawn('node', [SERVER_PATH, `--port=${TEST_PORT}`], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  // Wait for server to be ready by polling
  const maxWait = 8000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const res = await fetch_(`${BASE_URL}/health`);
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('Server did not start within 8 seconds');
});

afterAll(async () => {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    // Give it a moment to shut down
    await new Promise(r => setTimeout(r, 500));
    if (!serverProcess.killed) {
      serverProcess.kill('SIGKILL');
    }
  }
});

// ── Health endpoint ─────────────────────────────────────
// Note: GET /health and /status are exempt from rate limiting in the server code.

describe('GET /health', () => {
  it('returns correct format', async () => {
    const res = await fetch_(`${BASE_URL}/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(data).toHaveProperty('version');
    expect(data).toHaveProperty('claude');
    expect(typeof data.claude).toBe('boolean');
  });
});

// ── Status endpoint ─────────────────────────────────────

describe('GET /status', () => {
  it('returns detailed status info', async () => {
    const res = await fetch_(`${BASE_URL}/status`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(data).toHaveProperty('version');
    expect(data).toHaveProperty('uptime');
    expect(data.uptime).toHaveProperty('seconds');
    expect(data.uptime).toHaveProperty('human');
    expect(data).toHaveProperty('claude');
    expect(data.claude).toHaveProperty('available');
    expect(data).toHaveProperty('server');
    expect(data.server.port).toBe(TEST_PORT);
    expect(data).toHaveProperty('stats');
    expect(data).toHaveProperty('limits');
    expect(data.limits.validActions).toContain('summarize');
    expect(data.limits.validActions).toContain('custom');
  });
});

// ── CORS ────────────────────────────────────────────────

describe('CORS', () => {
  it('handles OPTIONS preflight', async () => {
    const res = await fetch_(`${BASE_URL}/health`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

// ── Validation tests ────────────────────────────────────
// These must run BEFORE the rate limit test which exhausts the quota.

describe('POST /analyze validation', () => {
  it('rejects missing action', async () => {
    const res = await fetch_(`${BASE_URL}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: { title: 'test', body: 'test' } }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('Validation failed');
    expect(data.details.some(d => d.includes('action'))).toBe(true);
  });

  it('rejects invalid action', async () => {
    const res = await fetch_(`${BASE_URL}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'nonexistent', note: { title: 'test', body: 'test' } }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.details.some(d => d.includes('Invalid action'))).toBe(true);
  });

  it('rejects empty body', async () => {
    const res = await fetch_(`${BASE_URL}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '',
    });
    // Empty body should return 400
    expect(res.status).toBe(400);
  });
});

// ── Transform endpoint ──────────────────────────────────

describe('POST /transform validation', () => {
  it('rejects missing prompt and files', async () => {
    const res = await fetch_(`${BASE_URL}/transform`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'some text' }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('prompt');
  });
});

// ── Backup endpoint ─────────────────────────────────────

describe('POST /backup', () => {
  it('successfully backs up notes', async () => {
    const notes = [
      { id: 'test-1', title: 'Test Note', body: 'Test body', tags: ['test'], createdAt: Date.now(), updatedAt: Date.now() },
    ];
    const res = await fetch_(`${BASE_URL}/backup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('path');
    expect(data.noteCount).toBe(1);
  });

  it('rejects backup without notes array', async () => {
    const res = await fetch_(`${BASE_URL}/backup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: 'not notes' }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('Validation failed');
  });
});

// ── 404 for unknown routes ──────────────────────────────
// Note: GET to unknown routes IS rate limited (only /health and /status are exempt).

describe('Unknown routes', () => {
  it('returns 404 for unknown GET paths', async () => {
    const res = await fetch_(`${BASE_URL}/nonexistent`);
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('Not found');
    expect(data).toHaveProperty('hint');
  });
});

// ── Rate limiting ───────────────────────────────────────
// This test MUST be last because it exhausts the rate limit for 1 minute.

describe('Rate limiting', () => {
  it('returns 429 after exceeding rate limit', async () => {
    // The rate limit is 30 requests per minute per IP for non-GET health/status.
    // We've already used some requests above, so send enough to exceed the limit.
    // Send requests sequentially to ensure ordering.
    const statuses = [];
    for (let i = 0; i < 35; i++) {
      const res = await fetch_(`${BASE_URL}/backup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: [{ id: `rl-${i}`, title: 'rate limit test' }] }),
      });
      statuses.push(res.status);
    }
    // Some should be 429 (the ones after the 30-request limit is hit)
    expect(statuses.filter(s => s === 429).length).toBeGreaterThan(0);
    // At least the very first one in the test suite should have been allowed
    // (even if not here, the earlier tests used some quota)
    const has200 = statuses.includes(200);
    const has429 = statuses.includes(429);
    expect(has429).toBe(true);
  });
});
