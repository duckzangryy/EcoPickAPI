process.env.JWT_SECRET = 'test-secret';
const assert = require('assert');
const jwt = require('jsonwebtoken');
const { handleReports } = require('../lib/reports');
const { handleEventsAndRewards } = require('../lib/eventsAndRewards');
const { createReport, joinEvent } = require('../lib/helpers');

const token = (extra = {}) => jwt.sign({ userId: 'u1', is_staff: false, ...extra }, 'test-secret');
const makeRes = () => {
  const res = { statusCode: 0, setHeader() {}, end(body) { res.body = JSON.parse(body); } };
  return res;
};
const makeReq = (body, tok) => {
  const { EventEmitter } = require('events');
  const req = new EventEmitter();
  req.headers = { authorization: `Bearer ${tok}`, 'content-type': 'application/json' };
  process.nextTick(() => { req.emit('data', JSON.stringify(body || {})); req.emit('end'); });
  return req;
};

(async () => {
  // 1) Claim is single-shot
  let claimCalls = 0;
  const claimDb = async (strings) => {
    const sql = strings.join('?');
    if (sql.includes('SELECT id, upvote_count FROM reports')) return [{ id: 'rep-abc', upvote_count: 0 }];
    if (sql.includes("status='in_progress'")) { claimCalls++; return claimCalls === 1 ? [{ id: 'rep-abc', status: 'in_progress' }] : []; }
    return [];
  };
  const r1 = makeRes(); await handleReports(makeReq({}, token()), r1, '/api/v1/reports/abc/claim', 'POST', claimDb);
  assert.strictEqual(r1.statusCode, 200);
  const r2 = makeRes(); await handleReports(makeReq({}, token()), r2, '/api/v1/reports/abc/claim', 'POST', claimDb);
  assert.strictEqual(r2.statusCode, 409, 're-claim must conflict');
  console.log('claim single-shot OK');

  // 2) status change blocked for non-staff, validated for staff
  let updates = 0;
  const statusDbFactory = (isStaff) => async (strings) => {
    const sql = strings.join('?');
    if (sql.includes('SELECT id, upvote_count FROM reports')) return [{ id: 'rep-abc', upvote_count: 0 }];
    if (sql.includes('SELECT is_staff FROM users')) return [{ is_staff: isStaff }];
    if (sql.startsWith('UPDATE reports SET status=')) { updates++; return [{ id: 'rep-abc', status: 'cleaned' }]; }
    return [];
  };
  const r3 = makeRes(); await handleReports(makeReq({ status: 'cleaned' }, token({ is_staff: true })), r3, '/api/v1/reports/abc/status', 'PATCH', statusDbFactory(false));
  assert.strictEqual(r3.statusCode, 403, 'demoted/stale token must be rejected');
  assert.strictEqual(updates, 0);
  const r4 = makeRes(); await handleReports(makeReq({ status: 'hacked' }, token({ is_staff: true })), r4, '/api/v1/reports/abc/status', 'PATCH', statusDbFactory(true));
  assert.strictEqual(r4.statusCode, 400);
  const r5 = makeRes(); await handleReports(makeReq({ status: 'cleaned' }, token({ is_staff: true })), r5, '/api/v1/reports/abc/status', 'PATCH', statusDbFactory(true));
  assert.strictEqual(r5.statusCode, 200);
  console.log('status staff-only + whitelist OK');

  // 3) owner PATCH cannot change status
  let ownerSql = '';
  const ownerDb = async (strings) => { ownerSql = strings.join('?'); return []; };
  await handleReports(makeReq({ status: 'cleaned', description: 'x' }, token()), makeRes(), '/api/report/reports/rep-1', 'PATCH', ownerDb);
  assert(!/status\s*=/.test(ownerSql), 'owner PATCH must not set status');
  console.log('owner PATCH status blocked OK');

  // 4) event creation staff-only + reward clamp
  const evtDbFactory = (isStaff) => async (strings) => {
    const sql = strings.join('?');
    if (sql.includes('SELECT is_staff FROM users')) return [{ is_staff: isStaff }];
    return [];
  };
  let insertedEvent;
  const staffEvtDb = async (strings, ...vals) => {
    const sql = strings.join('?');
    if (sql.includes('SELECT is_staff FROM users')) return [{ is_staff: true }];
    if (sql.includes("VALUES('events'")) { insertedEvent = JSON.parse(vals[2]); return []; }
    return [];
  };
  const r6 = makeRes(); await handleEventsAndRewards(makeReq({ title: 'X' }, token()), r6, '/api/v1/events', 'POST', evtDbFactory(false));
  assert.strictEqual(r6.statusCode, 403, 'non-staff cannot create event');
  const r7 = makeRes(); await handleEventsAndRewards(makeReq({ title: 'X', eco_point_reward: 999999 }, token()), r7, '/api/v1/events', 'POST', staffEvtDb);
  assert.strictEqual(r7.statusCode, 201);
  assert.strictEqual(insertedEvent.eco_point_reward, 200, 'reward clamp');
  console.log('event staff-only + reward clamp OK');

  // 5) badge / exchange mutations staff-only
  const r8 = makeRes(); await handleEventsAndRewards(makeReq({ name: 'B' }, token()), r8, '/api/badge/badges', 'POST', evtDbFactory(false));
  assert.strictEqual(r8.statusCode, 403, 'non-staff cannot create badge');
  const r9 = makeRes(); await handleEventsAndRewards(makeReq({ title: 'T', points_cost: 5 }, token()), r9, '/api/badge/exchange-items', 'POST', evtDbFactory(false));
  assert.strictEqual(r9.statusCode, 403, 'non-staff cannot create reward');
  const r10 = makeRes(); await handleEventsAndRewards(makeReq({}, token()), r10, '/api/badge/badges/b1', 'DELETE', evtDbFactory(false));
  assert.strictEqual(r10.statusCode, 403, 'non-staff cannot delete badge');
  console.log('badge/reward staff-only OK');

  // 6) report points capped despite forged severity
  let loggedPoints;
  let insertedSeverity;
  const reportDb = async (strings, ...vals) => {
    const sql = strings.join('?');
    if (sql.includes('INSERT INTO reports')) { insertedSeverity = vals[5]; return [{ id: 'rep-1' }]; }
    if (sql.includes('INSERT INTO point_logs')) { loggedPoints = vals[2]; return [{ id: 'pl-1' }]; }
    if (sql.includes('UPDATE users')) return [{ eco_points: 20 }];
    return [];
  };
  await createReport(null, null, reportDb, { userId: 'u1' }, { severity: 'critical', latitude: 1, longitude: 2 }, 'img.jpg');
  assert.strictEqual(loggedPoints, 20, 'critical severity must be capped to medium points');
  assert.strictEqual(insertedSeverity, 'critical', 'display severity preserved');
  console.log('report points capped OK');

  // 7) legacy event reward clamped at join time
  let joinPoints;
  const joinDb = async (strings, ...vals) => {
    const sql = strings.join('?');
    if (sql.includes("collection='events'")) return [{ data: { title: 'E', eco_point_reward: 99999 } }];
    if (sql.includes("VALUES('event_participants'")) return [{ id: 'ep-1' }];
    if (sql.includes('INSERT INTO point_logs')) { joinPoints = vals[2]; return [{ id: 'pl-1' }]; }
    if (sql.includes('UPDATE users')) return [{ eco_points: 200 }];
    return [];
  };
  await joinEvent(joinDb, 'u1', 'evt-1');
  assert.strictEqual(joinPoints, 200, 'legacy reward clamp');
  console.log('join reward clamp OK');

  console.log('\nALL AUTHZ TESTS PASSED');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
