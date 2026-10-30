const assert = require('assert');
const { handleReports } = require('../lib/reports');

const rows = [{ data: { id: '1', name: 'A', lat: 12.6, lng: 108.3, userid: 'u1' } }];
const database = async () => rows;

const makeRes = () => {
  const res = {
    statusCode: 0,
    headers: {},
    body: undefined,
    setHeader(name, value) { res.headers[name.toLowerCase()] = value; },
    end(body) { res.body = body === undefined ? undefined : JSON.parse(body); },
  };
  return res;
};

(async () => {
  const first = makeRes();
  await handleReports({ headers: {} }, first, '/api/photos', 'GET', database);
  assert.strictEqual(first.statusCode, 200);
  const cacheControl = first.headers['cache-control'] || '';
  assert(cacheControl.includes('public'), 'photos phải public');
  assert(cacheControl.includes('s-maxage=20'), 'phải cho CDN cache 20s');
  assert(cacheControl.includes('stale-while-revalidate=40'), 'phải có SWR');
  assert(/^W\/".+"$/.test(first.headers['etag'] || ''), 'phải có weak ETag');
  assert.deepStrictEqual(first.body, rows.map((r) => r.data), 'body vẫn là mảng ảnh');
  console.log('photos cache headers OK');

  const cached = makeRes();
  await handleReports({ headers: { 'if-none-match': first.headers['etag'] } }, cached, '/api/photos', 'GET', database);
  assert.strictEqual(cached.statusCode, 304, 'ETag khớp phải trả 304');
  assert.strictEqual(cached.body, undefined, '304 không có body');
  assert.strictEqual(cached.headers['etag'], first.headers['etag']);
  assert.strictEqual(cached.headers['cache-control'], cacheControl);
  console.log('photos conditional 304 OK');

  const changed = makeRes();
  await handleReports({ headers: { 'if-none-match': 'W/"stale-tag"' } }, changed, '/api/photos', 'GET', database);
  assert.strictEqual(changed.statusCode, 200, 'ETag khác phải trả 200');
  assert.ok(Array.isArray(changed.body));
  console.log('photos stale ETag returns 200 OK');
})().catch((e) => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
