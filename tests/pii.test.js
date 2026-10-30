const assert = require('assert');
const { userShape } = require('../lib/helpers');
const { handleReports } = require('../lib/reports');
const { handleDomain } = require('../lib/domain');

const base = { id: 'u1', email: 'a@b.com', fullname: 'A', username: 'a' };
assert(!('email' in userShape(base)), 'public userShape must hide email');
assert.strictEqual(userShape(base, undefined, { includeEmail: true }).email, 'a@b.com');
console.log('userShape OK');

const makeRes = () => {
  const res = { statusCode: 0, setHeader() {}, end(body) { res.body = JSON.parse(body); } };
  return res;
};

(async () => {
  const photoRows = [
    { data: { id: '1', name: 'Old User', userid: 'old@example.com' } },
    { data: { id: '2', name: 'New User' } },
  ];
  const photosDb = async (strings) => {
    const sql = strings.join('?');
    if (sql.includes("collection='map_photos'")) return photoRows;
    return [];
  };
  const res1 = makeRes();
  const handled = await handleReports({ headers: {} }, res1, '/api/photos', 'GET', photosDb);
  assert.strictEqual(handled, undefined);
  assert.ok(Array.isArray(res1.body), 'photos response is an array');
  assert.strictEqual(res1.body[0].userid, undefined, 'legacy email userid stripped');
  assert.strictEqual(res1.body[0].name, 'Old User');
  console.log('photos sanitize OK:', JSON.stringify(res1.body));

  const nearbyRows = [{ id: 'rep-1', user_id: 'u1', latitude: 1, longitude: 2, fullname: 'A', avatar: '', email: 'a@b.com' }];
  const nearbyDb = async (strings) => (strings.join('?').includes('FROM reports r JOIN users u') ? nearbyRows : []);
  const res2 = makeRes();
  await handleDomain({ headers: {} }, res2, '/api/v1/reports/nearby', 'GET', nearbyDb, new URL('https://x/api/v1/reports/nearby'));
  assert(!('email' in res2.body.data.reports[0].reportedBy), 'nearby must hide email');
  assert.strictEqual(res2.body.data.reports[0].reportedBy.fullName, 'A');
  console.log('nearby PII OK:', JSON.stringify(res2.body.data.reports[0].reportedBy));

  const userRows = [{ id: 'u1', email: 'a@b.com', fullname: 'A', username: 'a', is_active: true }];
  const usersDb = async () => userRows;
  const res3 = makeRes();
  await handleDomain({ headers: {} }, res3, '/api/v1/users', 'GET', usersDb, new URL('https://x/api/v1/users'));
  assert(!('email' in res3.body[0]), 'users list must hide email');
  console.log('users list OK');

  const participantRows = [{ data: { id: 'ep-1', user: 'u1', status: 'joined', participant: { fullname: 'A' } } }];
  const partDb = async (strings) => {
    const sql = strings.join('?');
    if (sql.includes("collection='event_participants'") || sql.includes('app_data')) return participantRows;
    if (sql.includes('FROM users')) return [{ id: 'u1', fullname: 'A', avatar: '' }];
    return [];
  };
  const res4 = makeRes();
  await handleDomain({ headers: {} }, res4, '/api/event/event-participants', 'GET', partDb, new URL('https://x/api/event/event-participants'));
  assert(!('email' in res4.body[0].participant), 'participants must hide email');
  console.log('participants PII OK');

  console.log('\nALL PII TESTS PASSED');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
