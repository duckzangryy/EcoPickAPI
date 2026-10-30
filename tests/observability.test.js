const assert = require('assert');
const { requestIdFor, logServerError, databaseReady, withTimeout } = require('../lib/helpers');

const originalError = console.error;

(async () => {
  // requestIdFor: tái sử dụng header hợp lệ, chặn injection/ký tự lạ
  assert.strictEqual(requestIdFor({ headers: { 'x-request-id': 'abc12345-xyz' } }), 'abc12345-xyz');
  const injected = requestIdFor({ headers: { 'x-request-id': 'bad\nvalue' } });
  assert(/^[0-9a-f-]{36}$/.test(injected), 'header lạ phải sinh UUID');
  assert.notStrictEqual(requestIdFor({ headers: {} }), requestIdFor({ headers: {} }), 'mỗi request phải có id riêng');
  assert.ok(requestIdFor({}).length > 0, 'không có headers vẫn phải chạy');
  console.log('requestIdFor OK');

  // logServerError: đúng 1 dòng JSON, có ngữ cảnh và stack
  const lines = [];
  console.error = (...args) => lines.push(args.join(' '));
  try {
    logServerError({ requestId: 'req-1', method: 'POST', path: '/api/v1/reports', durationMs: 42, error: new Error('boom') });
    logServerError({ requestId: 'req-2', method: 'GET', path: '/api/photos', durationMs: 1 });
  } finally {
    console.error = originalError;
  }
  assert.strictEqual(lines.length, 2);
  const logged = JSON.parse(lines[0]);
  assert.strictEqual(logged.level, 'error');
  assert.strictEqual(logged.service, 'ecopick-api');
  assert.strictEqual(logged.requestId, 'req-1');
  assert.strictEqual(logged.method, 'POST');
  assert.strictEqual(logged.path, '/api/v1/reports');
  assert.strictEqual(logged.durationMs, 42);
  assert.strictEqual(logged.error.message, 'boom');
  assert(logged.error.stack.includes('boom'));
  const bare = JSON.parse(lines[1]);
  assert.strictEqual(bare.error.message, undefined, 'error thiếu vẫn log được');
  console.log('logServerError OK');

  // databaseReady: chạy SELECT 1 và báo latency; lỗi DB phải ném ra ngoài
  let seenSql = '';
  const okDb = async (strings) => {
    seenSql = strings.join('?');
    return [{ ok: 1 }];
  };
  const ready = await databaseReady(okDb);
  assert.strictEqual(seenSql, 'SELECT 1 AS ok');
  assert(Number.isInteger(ready.latencyMs) && ready.latencyMs >= 0);
  await assert.rejects(() => databaseReady(async () => { throw new Error('db down'); }), /db down/);
  console.log('databaseReady OK');

  // withTimeout: kịp thì trả giá trị, chậm thì reject TIMEOUT
  assert.strictEqual(await withTimeout(Promise.resolve('ok'), 50), 'ok');
  await assert.rejects(
    () => withTimeout(new Promise(() => {}), 10),
    (error) => error.code === 'TIMEOUT'
  );
  await assert.rejects(() => withTimeout(Promise.reject(new Error('inner')), 50), /inner/);
  console.log('withTimeout OK');

  // Wiring thật của api/index.js: request id, liveness, readiness khi thiếu DB
  const api = require('../api/index');
  const makeRes = () => ({
    statusCode: 0,
    headers: {},
    headersSent: false,
    writableEnded: false,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(body) { this.writableEnded = true; this.body = body ? JSON.parse(body) : undefined; },
  });
  const makeReq = (method, url, headers = {}) => ({ method, url, headers: { host: 'localhost', ...headers } });

  const savedUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;

  const liveRes = makeRes();
  await api(makeReq('GET', '/health'), liveRes);
  assert.strictEqual(liveRes.statusCode, 200);
  assert.strictEqual(liveRes.body.ok, true);
  assert(/^[0-9a-f-]{36}$/.test(liveRes.headers['x-request-id']), 'response phải có X-Request-Id');
  assert(liveRes.headers['access-control-expose-headers'].includes('X-Request-Id'));
  console.log('liveness + request id OK');

  const echoRes = makeRes();
  await api(makeReq('GET', '/health', { 'x-request-id': 'mobile-abc123' }), echoRes);
  assert.strictEqual(echoRes.headers['x-request-id'], 'mobile-abc123', 'id hợp lệ từ client phải được giữ');
  console.log('request id passthrough OK');

  const logs = [];
  let readyRes;
  console.error = (...args) => logs.push(args.join(' '));
  try {
    readyRes = makeRes();
    await api(makeReq('GET', '/health/ready'), readyRes);
  } finally {
    console.error = originalError;
    if (savedUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedUrl;
  }
  assert.strictEqual(readyRes.statusCode, 503, 'thiếu DATABASE_URL phải NOT_READY');
  assert.strictEqual(readyRes.body.error.code, 'NOT_READY');
  assert.strictEqual(logs.length, 1, 'readiness lỗi phải log 1 dòng');
  assert.strictEqual(JSON.parse(logs[0]).path, '/health/ready');
  console.log('readiness 503 + structured log OK');

  const optRes = makeRes();
  await api(makeReq('OPTIONS', '/api/v1/reports'), optRes);
  assert.strictEqual(optRes.statusCode, 204);
  assert(optRes.headers['access-control-expose-headers'].includes('Retry-After'));

  console.log('\nALL OBSERVABILITY TESTS PASSED');
})().catch((error) => {
  console.error = originalError;
  console.error('FAIL:', error.stack || error.message);
  process.exit(1);
});
