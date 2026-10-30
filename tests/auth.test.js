process.env.JWT_SECRET = 'test-secret';
delete process.env.NODE_ENV;

const assert = require('assert');
const crypto = require('node:crypto');
const { EventEmitter } = require('events');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { handleAuth } = require('../lib/auth');
const { tokenFor, refreshTokenFor, clientIp, exceedsRateLimit, secureEqual } = require('../lib/helpers');

const rlKey = (bucket, id) => crypto.createHash('sha256').update(`${bucket}:${id}`).digest('hex');

const makeRes = () => {
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(name, value) { res.headers[name.toLowerCase()] = value; },
    end(body) { res.body = JSON.parse(body); },
  };
  return res;
};

const makeReq = (body, ip = '1.2.3.4') => {
  const req = new EventEmitter();
  req.headers = { 'content-type': 'application/json', 'x-forwarded-for': ip };
  process.nextTick(() => { req.emit('data', JSON.stringify(body || {})); req.emit('end'); });
  return req;
};

function makeDb({ user = null, otp = null, counts = {}, revoked = new Set() } = {}) {
  const state = { queries: [], revokedJtis: [] };
  const db = async (strings, ...vals) => {
    const sql = strings.join('?');
    state.queries.push({ sql, vals });
    if (sql.includes("VALUES('rate_limits'")) return [{ count: counts[vals[0]] ?? 1 }];
    if (sql.includes("'revoked_tokens'")) {
      if (sql.startsWith('SELECT')) return revoked.has(vals[0]) ? [{ revoked: 1 }] : [];
      if (sql.startsWith('INSERT')) { state.revokedJtis.push(vals[0]); return []; }
      return [];
    }
    if (sql.includes('FROM users WHERE email=')) return user ? [user] : [];
    if (sql.includes('FROM users WHERE id=')) return user ? [user] : [];
    if (sql.includes('FROM app_data WHERE collection=')) return [{ followers: 0, following: 0 }];
    if (sql.includes('FROM otps WHERE email=')) return otp ? [{ otp }] : [];
    if (sql.includes('INSERT INTO otps')) return [];
    if (sql.includes('SET is_verified=true')) return user ? [user] : [];
    if (sql.includes('SET password_hash=')) return [];
    if (sql.includes('DELETE FROM otps')) return [];
    return [];
  };
  db.state = state;
  return db;
}

(async () => {
  // 1) Access token TTL = 1h, refresh = 30d và có jti
  const access = tokenFor({ id: 'u1', email: 'a@b.c', is_staff: false, role: 'user' });
  const accessPayload = jwt.decode(access);
  assert.strictEqual(accessPayload.exp - accessPayload.iat, 3600, 'access token 1 giờ');
  const refreshProbe = jwt.decode(refreshTokenFor({ id: 'u1', email: 'a@b.c' }));
  assert.strictEqual(refreshProbe.exp - refreshProbe.iat, 2592000, 'refresh 30 ngày');
  assert(refreshProbe.jti && refreshProbe.type === 'refresh', 'refresh có jti');
  console.log('token TTL 1h/30d + jti OK');

  // 2) clientIp lấy IP đầu tiên từ x-forwarded-for
  assert.strictEqual(clientIp({ headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' } }), '1.1.1.1');
  assert.strictEqual(clientIp({ headers: {} }), 'unknown');
  console.log('clientIp OK');

  // 3) secureEqual đúng/sai
  assert.strictEqual(secureEqual('123456', '123456'), true);
  assert.strictEqual(secureEqual('123456', '123457'), false);
  assert.strictEqual(secureEqual('123456', '12345'), false);
  assert.strictEqual(secureEqual(undefined, '1'), false);
  console.log('secureEqual OK');

  // 4) Ngưỡng rate limit + reset cửa sổ (created_at phải được reset cùng count)
  let capturedSql = '';
  const rlDb = async (strings) => {
    capturedSql = strings.join('?');
    return [{ count: 5 }];
  };
  const rlRes = makeRes();
  assert.strictEqual(await exceedsRateLimit(rlDb, rlRes, 't', 'x', 5, 900), false, 'đúng ngưỡng chưa chặn');
  const rlDbOver = async () => [{ count: 6 }];
  const overRes = makeRes();
  assert.strictEqual(await exceedsRateLimit(rlDbOver, overRes, 't', 'x', 5, 900), true);
  assert.strictEqual(overRes.statusCode, 429);
  assert.strictEqual(overRes.headers['retry-after'], '900');
  assert(/\bcreated_at = CASE[\s\S]*THEN now\(\)/.test(capturedSql), 'phải reset created_at khi hết cửa sổ');
  assert(capturedSql.includes("VALUES('rate_limits'"), 'lưu trong app_data collection rate_limits');
  console.log('rate limit threshold + window reset OK');

  // 5) Login bị chặn 429 theo IP, không chạm bảng users
  const blockedIp = '9.9.9.9';
  const blockedDb = makeDb({ counts: { [rlKey('login:ip', blockedIp)]: 61 } });
  const r1 = makeRes();
  await handleAuth(makeReq({ email: 'a@b.c', password: 'x' }, blockedIp), r1, '/api/v1/auth/login', 'POST', blockedDb);
  assert.strictEqual(r1.statusCode, 429, 'IP quá hạn mức login');
  assert.strictEqual(r1.body.error.code, 'RATE_LIMITED');
  assert(!blockedDb.state.queries.some((q) => q.sql.includes('SELECT * FROM users')), 'không query users khi bị chặn');
  console.log('login IP rate limit OK');

  // 6) Login bị chặn 429 theo email (chống spray từ nhiều IP)
  const blockedEmail = 'spray@b.c';
  const emailDb = makeDb({ counts: { [rlKey('login:email', blockedEmail)]: 21 } });
  const r2 = makeRes();
  await handleAuth(makeReq({ email: blockedEmail, password: 'x' }, '8.8.8.8'), r2, '/api/v1/auth/login', 'POST', emailDb);
  assert.strictEqual(r2.statusCode, 429, 'email quá hạn mức login');
  console.log('login email rate limit OK');

  // 7) Login đúng: 200, expires_in 1 giờ, refresh 30 ngày
  const hash = await bcrypt.hash('correct-password', 4);
  const loginUser = {
    id: 'u1', email: 'a@b.c', password_hash: hash, fullname: 'A', username: 'a',
    avatar: null, bio: null, role: 'user', level: 1, eco_points: 0, total_reports: 0,
    total_events: 0, total_trees: 0, is_verified: true, is_active: true, is_staff: false,
    created_at: null, updated_at: null,
  };
  const okDb = makeDb({ user: loginUser });
  const r3 = makeRes();
  await handleAuth(makeReq({ email: 'a@b.c', password: 'correct-password' }, '7.7.7.7'), r3, '/api/v1/auth/login', 'POST', okDb);
  assert.strictEqual(r3.statusCode, 200);
  assert.strictEqual(r3.body.expires_in, 3600);
  const refreshPayload = jwt.decode(r3.body.refresh_token);
  assert.strictEqual(refreshPayload.exp - refreshPayload.iat, 2592000, 'refresh vẫn 30 ngày');
  assert(refreshPayload.jti, 'refresh token đăng nhập có jti');
  assert(r3.body.user && !('password_hash' in r3.body.user), 'không lộ hash');
  console.log('login success 200 + TTL OK');

  // 8) Login sai mật khẩu
  const r4 = makeRes();
  await handleAuth(makeReq({ email: 'a@b.c', password: 'wrong-password' }, '7.7.7.7'), r4, '/api/v1/auth/login', 'POST', makeDb({ user: loginUser }));
  assert.strictEqual(r4.statusCode, 401);
  console.log('login wrong password 401 OK');

  // 9) Register bị chặn theo IP
  const regIp = '6.6.6.6';
  const regDb = makeDb({ counts: { [rlKey('register:ip', regIp)]: 11 } });
  const r5 = makeRes();
  await handleAuth(makeReq({ email: 'new@b.c', password: 'password123' }, regIp), r5, '/api/v1/auth/register', 'POST', regDb);
  assert.strictEqual(r5.statusCode, 429);
  console.log('register IP rate limit OK');

  // 10) verify-email: đúng OTP, sai OTP, quá hạn mức
  const verifyUser = { ...loginUser };
  const r6 = makeRes();
  await handleAuth(makeReq({ email: 'a@b.c', otp: '123456' }), r6, '/api/v1/auth/verify-email', 'POST', makeDb({ user: verifyUser, otp: '123456' }));
  assert.strictEqual(r6.statusCode, 200, 'OTP đúng phải qua');

  const r7 = makeRes();
  await handleAuth(makeReq({ email: 'a@b.c', otp: '654321' }), r7, '/api/v1/auth/verify-email', 'POST', makeDb({ user: verifyUser, otp: '123456' }));
  assert.strictEqual(r7.statusCode, 400, 'OTP sai phải 400');
  assert.strictEqual(r7.body.error.code, 'INVALID_OTP');

  const vEmail = 'a@b.c';
  const verifyBlockedDb = makeDb({ user: verifyUser, otp: '123456', counts: { [rlKey('verify:email', vEmail)]: 6 } });
  const r8 = makeRes();
  await handleAuth(makeReq({ email: vEmail, otp: '123456' }, '5.5.5.5'), r8, '/api/v1/auth/verify-email', 'POST', verifyBlockedDb);
  assert.strictEqual(r8.statusCode, 429, 'brute force OTP phải bị chặn');
  assert(!verifyBlockedDb.state.queries.some((q) => q.sql.includes('FROM otps')), 'không query OTP khi bị chặn');
  console.log('verify-email OTP + lockout OK');

  // 11) forgot-password không tiết lộ email tồn tại
  const unknownDb = makeDb({ user: null });
  const r9 = makeRes();
  await handleAuth(makeReq({ email: 'ghost@b.c' }, '4.4.4.4'), r9, '/api/v1/auth/forgot-password', 'POST', unknownDb);
  assert.strictEqual(r9.statusCode, 200, 'email lạ phải trả 200 chung');
  assert.strictEqual(r9.body.success, true);
  assert(!r9.body.data.otp, 'không trả OTP ngoài dev');
  assert(!unknownDb.state.queries.some((q) => q.sql.includes('INSERT INTO otps')), 'không tạo OTP cho email lạ');

  const knownDb = makeDb({ user: { id: 'u1' } });
  const r10 = makeRes();
  await handleAuth(makeReq({ email: 'a@b.c' }, '4.4.4.4'), r10, '/api/v1/auth/forgot-password', 'POST', knownDb);
  assert.strictEqual(r10.statusCode, 200);
  const otpInsert = knownDb.state.queries.find((q) => q.sql.includes('INSERT INTO otps'));
  assert(otpInsert, 'email thật phải tạo OTP');
  assert(/^\d{6}$/.test(otpInsert.vals[1]), 'OTP 6 số');
  console.log('forgot-password generic response OK');

  // 12) reset-password: email lạ trả INVALID_OTP (không 404), email thật đổi được mật khẩu
  const resetRes = makeRes();
  await handleAuth(makeReq({ email: 'ghost@b.c', otp: '000000', password: 'newpassword1' }, '3.3.3.3'), resetRes, '/api/v1/auth/reset-password', 'POST', makeDb({ user: null, otp: null }));
  assert.strictEqual(resetRes.statusCode, 400);
  assert.strictEqual(resetRes.body.error.code, 'INVALID_OTP', 'không lộ email không tồn tại');

  const resetDb = makeDb({ user: { id: 'u1' }, otp: '123456' });
  const resetOk = makeRes();
  await handleAuth(makeReq({ email: 'a@b.c', otp: '123456', password: 'newpassword1' }, '3.3.3.3'), resetOk, '/api/v1/auth/reset-password', 'POST', resetDb);
  assert.strictEqual(resetOk.statusCode, 200);
  assert(resetDb.state.queries.some((q) => q.sql.includes('SET password_hash=')), 'phải cập nhật mật khẩu');
  console.log('reset-password OK');

  // 13) Logout thu hồi refresh token: jti vào denylist + dọn mục hết hạn
  const logoutRefresh = refreshTokenFor({ id: 'u1', email: 'a@b.c' });
  const logoutJti = jwt.decode(logoutRefresh).jti;
  const logoutDb = makeDb({ user: loginUser });
  const logoutRes = makeRes();
  await handleAuth(makeReq({ refreshToken: logoutRefresh }), logoutRes, '/api/v1/auth/logout', 'POST', logoutDb);
  assert.strictEqual(logoutRes.statusCode, 200);
  assert.deepStrictEqual(logoutDb.state.revokedJtis, [logoutJti], 'jti phải vào denylist');
  assert(logoutDb.state.queries.some((q) => q.sql.includes("DELETE FROM app_data WHERE collection='revoked_tokens'")), 'phải dọn token hết hạn');
  console.log('logout revokes refresh token OK');

  // 14) Logout không kèm token vẫn 200 và không ghi gì
  const emptyLogoutDb = makeDb({ user: loginUser });
  const emptyLogoutRes = makeRes();
  await handleAuth(makeReq({}), emptyLogoutRes, '/api/v1/auth/logout', 'POST', emptyLogoutDb);
  assert.strictEqual(emptyLogoutRes.statusCode, 200);
  assert.strictEqual(emptyLogoutDb.state.revokedJtis.length, 0);
  console.log('logout without token OK');

  // 15) Refresh token đã thu hồi bị từ chối
  const revokedDb = makeDb({ user: loginUser, revoked: new Set([logoutJti]) });
  const revokedRes = makeRes();
  await handleAuth(makeReq({ refreshToken: logoutRefresh }), revokedRes, '/api/v1/auth/refresh', 'POST', revokedDb);
  assert.strictEqual(revokedRes.statusCode, 401, 'refresh token đã thu hồi phải bị chặn');
  assert(!revokedDb.state.queries.some((q) => q.sql.includes('FROM users WHERE id=')), 'không cấp token khi đã thu hồi');
  console.log('revoked refresh rejected OK');

  // 16) Refresh token hợp lệ vẫn cấp access token 1 giờ
  const okRefreshToken = refreshTokenFor({ id: 'u1', email: 'a@b.c' });
  const refreshOkDb = makeDb({ user: loginUser });
  const refreshOkRes = makeRes();
  await handleAuth(makeReq({ refreshToken: okRefreshToken }), refreshOkRes, '/api/v1/auth/refresh', 'POST', refreshOkDb);
  assert.strictEqual(refreshOkRes.statusCode, 200);
  const freshAccess = jwt.decode(refreshOkRes.body.access_token);
  assert.strictEqual(freshAccess.exp - freshAccess.iat, 3600, 'access token mới 1 giờ');
  console.log('valid refresh still works OK');

  console.log('\nALL AUTH HARDENING TESTS PASSED');
})().catch((e) => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
