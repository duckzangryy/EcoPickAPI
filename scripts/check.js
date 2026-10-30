const assert = require('node:assert/strict');
const handler = require('../api/index.js');

async function call(path, method = 'GET', headers = {}) {
  const req = { url: path, method, headers, on() { throw new Error('No body expected in route checks'); } };
  const res = {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(text = '') { this.body = text; },
  };
  await handler(req, res);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

(async () => {
  const options = await call('/api/health', 'OPTIONS');
  assert.equal(options.status, 204);
  assert.equal(options.body, null);
  const health = await call('/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  const noSecret = await call('/api/v1/auth/login', 'POST');
  assert.equal(noSecret.status, 500);
  assert.match(noSecret.body.error.message, /DATABASE_URL/);
  for (const path of [
    '/api/event/events/', '/api/badge/exchange-items/', '/api/badge/badges/',
    '/api/badge/user-badges/', '/api/badge/redemptions/',
  ]) {
    const result = await call(path);
    assert.equal(result.status, 500, `${path} should reach DB handler, got ${result.status}`);
    assert.match(result.body.error.message, /DATABASE_URL/);
  }
  console.log('Vercel handler health, CORS and dispatch checks passed.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
