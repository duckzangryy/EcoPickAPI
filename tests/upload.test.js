process.env.JWT_SECRET = 'test-secret';
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.BLOB_STORE_ID;
delete process.env.VERCEL_OIDC_TOKEN;

const assert = require('assert');
const { Readable } = require('stream');
const jwt = require('jsonwebtoken');
const { handleReports } = require('../lib/reports');
const { detectImageMime, uploadImage, uploadImageOrFail } = require('../lib/helpers');

const pad = (b, n = 16) => Buffer.concat([b, Buffer.alloc(Math.max(0, n - b.length), 1)]);

const jpeg = pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]));
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8, 0)]);
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const gif = pad(Buffer.from('GIF89a'));
const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const html = pad(Buffer.from('<html><script>alert(1)</script></html>'));

const makeRes = () => {
  const res = { statusCode: 0, headers: {}, setHeader(n, v) { res.headers[n.toLowerCase()] = v; }, end(body) { res.body = JSON.parse(body); } };
  return res;
};

const makeMultipartReq = (token, fileName, fileType, fileBody) => {
  const boundary = '----ecopicktest';
  const req = new Readable({ read() {} });
  req.headers = {
    authorization: `Bearer ${token}`,
    'content-type': `multipart/form-data; boundary=${boundary}`,
    'x-forwarded-for': '1.2.3.4',
  };
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="latitude"\r\n\r\n12.5\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="longitude"\r\n\r\n108.5\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${fileName}"\r\nContent-Type: ${fileType}\r\n\r\n`,
  ];
  const payload = Buffer.concat([Buffer.from(parts.join('')), fileBody, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  process.nextTick(() => { req.push(payload); req.push(null); });
  return req;
};

(async () => {
  // 1) Nhận dạng đúng 4 định dạng ảnh
  assert.strictEqual(detectImageMime(jpeg), 'image/jpeg');
  assert.strictEqual(detectImageMime(png), 'image/png');
  assert.strictEqual(detectImageMime(webp), 'image/webp');
  assert.strictEqual(detectImageMime(gif), 'image/gif');
  console.log('magic bytes detection OK');

  // 2) SVG/HTML/ngắn bị loại
  assert.strictEqual(detectImageMime(svg), '', 'SVG phải bị loại');
  assert.strictEqual(detectImageMime(html), '', 'HTML phải bị loại');
  assert.strictEqual(detectImageMime(Buffer.from([0xff, 0xd8])), '', 'buffer quá ngắn bị loại');
  assert.strictEqual(detectImageMime(null), '', 'null an toàn');
  console.log('non-image rejection OK');

  // 3) uploadImage ném INVALID_IMAGE trước khi chạm Blob
  let code = null;
  try { await uploadImage({ filename: 'x.html', mimeType: 'image/jpeg', buffer: html }); } catch (e) { code = e.code; }
  assert.strictEqual(code, 'INVALID_IMAGE');

  // 4) uploadImageOrFail: ảnh giả bị 400; ảnh thật đi tiếp tới bước cấu hình Blob
  const badRes = makeRes();
  const badResult = await uploadImageOrFail(badRes, { filename: 'x.svg', mimeType: 'image/svg+xml', buffer: svg });
  assert.strictEqual(badResult, undefined);
  assert.strictEqual(badRes.statusCode, 400);
  assert.strictEqual(badRes.body.error.code, 'INVALID_IMAGE');

  let blobError = null;
  try { await uploadImageOrFail(makeRes(), { filename: 'ok.png', mimeType: 'text/html', buffer: png }); } catch (e) { blobError = e.message; }
  assert(blobError && blobError.includes('Blob storage is not configured'), 'ảnh thật phải qua bước validate');
  console.log('uploadImageOrFail OK');

  // 5) Handler /api/upload: file HTML giả mạo Content-Type bị chặn 400, không ghi DB
  const token = jwt.sign({ userId: 'u1' }, 'test-secret');
  const db = async (strings) => {
    throw new Error('DB không được gọi khi ảnh không hợp lệ: ' + strings.join('?').slice(0, 60));
  };
  const res = makeRes();
  await handleReports(makeMultipartReq(token, 'evil.html', 'image/jpeg', html), res, '/api/upload', 'POST', db);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.error.code, 'INVALID_IMAGE');
  console.log('report upload rejects spoofed HTML OK');

  console.log('\nALL UPLOAD VALIDATION TESTS PASSED');
})().catch((e) => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
