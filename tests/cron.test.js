process.env.JWT_SECRET = 'test-secret';
const assert = require('assert');
const { handleCronCleanup, cleanupExpiredData } = require('../lib/helpers');

const makeRes = () => {
  const res = { statusCode: 0, headers: {}, setHeader(n, v) { res.headers[n.toLowerCase()] = v; }, end(body) { res.body = JSON.parse(body); } };
  return res;
};

(async () => {
  // 1) cleanupExpiredData: đúng 2 câu DELETE, chỉ đụng rows hết hạn
  const queries = [];
  const db = async (strings) => {
    const sql = strings.join('?');
    queries.push(sql);
    if (sql.includes("collection='rate_limits'")) return [{ id: 'k1' }, { id: 'k2' }];
    if (sql.includes("collection='revoked_tokens'")) return [{ id: 'j1' }];
    return [];
  };
  const cleaned = await cleanupExpiredData(db);
  assert.deepStrictEqual(cleaned, { rateLimits: 2, revokedTokens: 1 });
  assert.strictEqual(queries.length, 2);
  assert(queries[0].includes("created_at < now() - interval '1 day'"), 'chỉ xoá rate limit cũ hơn 1 ngày');
  assert(queries[1].includes('(data->>\'expires_at\')::timestamptz < now()'), 'chỉ xoá refresh token đã hết hạn');
  console.log('cleanupExpiredData OK');

  // 2) Chưa cấu hình CRON_SECRET -> 503, không chạm DB
  delete process.env.CRON_SECRET;
  let touched = false;
  const noSecretDb = async () => { touched = true; return []; };
  const r1 = makeRes();
  await handleCronCleanup({ headers: {} }, r1, noSecretDb);
  assert.strictEqual(r1.statusCode, 503);
  assert.strictEqual(touched, false);
  console.log('cron without secret blocked OK');

  // 3) Sai/mất Authorization -> 401, không chạm DB
  process.env.CRON_SECRET = 'cron-secret';
  const r2 = makeRes();
  await handleCronCleanup({ headers: { authorization: 'Bearer wrong' } }, r2, noSecretDb);
  assert.strictEqual(r2.statusCode, 401);
  const r3 = makeRes();
  await handleCronCleanup({ headers: {} }, r3, noSecretDb);
  assert.strictEqual(r3.statusCode, 401);
  assert.strictEqual(touched, false);
  console.log('cron wrong secret blocked OK');

  // 4) Đúng secret -> 200 + số lượng đã dọn
  const r4 = makeRes();
  await handleCronCleanup({ headers: { authorization: 'Bearer cron-secret' } }, r4, db);
  assert.strictEqual(r4.statusCode, 200);
  assert.deepStrictEqual(r4.body.data, { rateLimits: 2, revokedTokens: 1 });
  console.log('cron authorized OK');

  console.log('\nALL CRON CLEANUP TESTS PASSED');
})().catch((e) => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
