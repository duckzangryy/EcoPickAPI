const { neon } = require('@neondatabase/serverless');
const jwt = require('jsonwebtoken');
const { put } = require('@vercel/blob');
const crypto = require('node:crypto');

const sql = () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured');
  return neon(process.env.DATABASE_URL);
};

const POINTS_BY_SEVERITY = { low: 10, medium: 20, high: 35, critical: 50 };

/** Parse JSON từ field multipart, trả về mặc định nếu không hợp lệ. */
const safeJson = (value, fallback) => {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const DOMAIN_ERRORS = {
  USER_NOT_FOUND: [404, 'Vui lòng đăng nhập lại'],
  EVENT_NOT_FOUND: [404, 'Không tìm thấy sự kiện'],
  PARTICIPANT_NOT_FOUND: [404, 'Không tìm thấy lượt tham gia'],
  REWARD_NOT_FOUND: [404, 'Không tìm thấy phần thưởng'],
  OUT_OF_STOCK: [409, 'Phần thưởng đã hết'],
  INSUFFICIENT_POINTS: [409, 'Bạn không đủ điểm để đổi phần thưởng này'],
};

function failDomain(res, error) {
  const code = Object.keys(DOMAIN_ERRORS).find((key) => String(error?.message || '').includes(key));
  if (!code) return false;
  const [status, message] = DOMAIN_ERRORS[code];
  fail(res, status, code, message);
  return true;
}

const json = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
};

const fail = (res, status, code, message) =>
  json(res, status, { success: false, error: { code, message, details: [] }, detail: message });

function bodyJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) reject(new Error('Request body too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function currentUser(req, res) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token || !process.env.JWT_SECRET) {
    fail(res, 401, 'UNAUTHORIZED', 'Vui lòng đăng nhập');
    return null;
  }
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    fail(res, 401, 'UNAUTHORIZED', 'Token không hợp lệ hoặc đã hết hạn');
    return null;
  }
}

function tokenFor(user) {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not configured');
  return jwt.sign(
    { userId: user.id, email: user.email, is_staff: user.is_staff, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

/** Refresh token 30 ngày, có jti để có thể thu hồi khi đăng xuất. */
function refreshTokenFor(user) {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not configured');
  return jwt.sign(
    { userId: user.id, email: user.email, type: 'refresh', jti: crypto.randomUUID() },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

/** Thêm jti của refresh token vào denylist (app_data) và dọn mục đã hết hạn. */
async function revokeRefreshToken(database, token) {
  if (!token || !process.env.JWT_SECRET) return false;
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return false;
  }
  if (payload.type !== 'refresh' || !payload.jti) return false;
  const expiresAt = new Date((payload.exp || Math.floor(Date.now() / 1000) + 86400) * 1000).toISOString();
  await database`INSERT INTO app_data(collection,id,user_id,data)
    VALUES('revoked_tokens',${payload.jti},${payload.userId || null},${JSON.stringify({ expires_at: expiresAt })}::jsonb)
    ON CONFLICT (collection,id) DO NOTHING`;
  await database`DELETE FROM app_data WHERE collection='revoked_tokens' AND (data->>'expires_at')::timestamptz < now()`;
  return true;
}

async function isRefreshTokenRevoked(database, payload) {
  if (!payload?.jti) return false; // token cũ không có jti thì không thu hồi được
  const [row] = await database`SELECT 1 AS revoked FROM app_data
    WHERE collection='revoked_tokens' AND id=${payload.jti} AND (data->>'expires_at')::timestamptz > now()`;
  return !!row;
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || String(req.headers['x-real-ip'] || '').trim() || 'unknown';
}

/** So sánh chuỗi bí mật (OTP) mà không rò rỉ thời gian. */
function secureEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Đếm theo cửa sổ cố định trong app_data (collection='rate_limits').
 * Trả true và đã ghi 429 nếu vượt hạn mức; caller chỉ cần `return`.
 * created_at là mốc bắt đầu cửa sổ nên phải reset cùng lúc với count.
 */
async function exceedsRateLimit(database, res, bucket, identifier, limit, windowSeconds) {
  const key = crypto.createHash('sha256').update(`${bucket}:${identifier}`).digest('hex');
  const [row] = await database`
    INSERT INTO app_data(collection,id,user_id,data,created_at)
    VALUES('rate_limits',${key},NULL,${JSON.stringify({ count: 1 })}::jsonb,now())
    ON CONFLICT (collection,id) DO UPDATE SET
      data = CASE
        WHEN app_data.created_at < now() - make_interval(secs => ${windowSeconds})
          THEN jsonb_build_object('count', 1)
        ELSE jsonb_set(app_data.data, '{count}', to_jsonb(COALESCE((app_data.data->>'count')::int, 0) + 1))
      END,
      created_at = CASE
        WHEN app_data.created_at < now() - make_interval(secs => ${windowSeconds}) THEN now()
        ELSE app_data.created_at
      END
    RETURNING (data->>'count')::int AS count`;
  if ((Number(row?.count) || 0) <= limit) return false;
  res.setHeader('Retry-After', String(windowSeconds));
  fail(res, 429, 'RATE_LIMITED', 'Bạn thao tác quá nhanh, vui lòng thử lại sau ít phút');
  return true;
}

async function handleCronCleanup(req, res, database) {
  if (!process.env.CRON_SECRET) return fail(res, 503, 'NOT_CONFIGURED', 'Cron chưa được cấu hình');
  if (!secureEqual(req.headers.authorization || '', `Bearer ${process.env.CRON_SECRET}`)) {
    return fail(res, 401, 'UNAUTHORIZED', 'Unauthorized');
  }
  return json(res, 200, { success: true, data: await cleanupExpiredData(database) });
}

/** Dọn bộ đếm rate-limit quá 1 ngày và refresh token đã hết hạn; gọi từ cron. */
async function cleanupExpiredData(database) {
  const [rateLimits, revokedTokens] = await Promise.all([
    database`DELETE FROM app_data WHERE collection='rate_limits' AND created_at < now() - interval '1 day' RETURNING id`,
    database`DELETE FROM app_data WHERE collection='revoked_tokens' AND (data->>'expires_at')::timestamptz < now() RETURNING id`,
  ]);
  return { rateLimits: rateLimits.length, revokedTokens: revokedTokens.length };
}

/** Mã theo dõi request; nhận header từ client/proxy nếu an toàn, nếu không tự sinh UUID. */
function requestIdFor(req) {
  const incoming = req?.headers?.['x-request-id'];
  if (typeof incoming === 'string' && /^[A-Za-z0-9._-]{8,64}$/.test(incoming)) return incoming;
  return crypto.randomUUID();
}

/** Một dòng JSON để Vercel log dễ lọc/nối theo requestId, không lẫn stack rời rạc. */
function logServerError({ requestId, method, path, error, durationMs }) {
  console.error(JSON.stringify({
    level: 'error',
    service: 'ecopick-api',
    requestId,
    method,
    path,
    durationMs,
    error: {
      name: error?.name,
      message: error?.message,
      stack: error?.stack,
    },
  }));
}

/** Readiness probe: xác nhận Postgres còn phản hồi. */
async function databaseReady(database) {
  const startedAt = Date.now();
  await database`SELECT 1 AS ok`;
  return { latencyMs: Date.now() - startedAt };
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' })), ms);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

/**
 * Xác thực người dùng và kiểm tra quyền staff mới nhất từ DB.
 * Không tin cờ is_staff trong token cho thao tác quản trị (quyền có thể bị thu hồi
 * trước khi token hết hạn).
 * Trả null và đã ghi response lỗi nếu không hợp lệ.
 */
async function requireStaff(req, res, database) {
  const auth = currentUser(req, res);
  if (!auth) return null;
  const [row] = await database`SELECT is_staff FROM users WHERE id=${auth.userId} AND is_active=true`;
  if (!row?.is_staff) {
    fail(res, 403, 'FORBIDDEN', 'Chỉ quản trị viên mới được thực hiện thao tác này');
    return null;
  }
  return auth;
}

function cleanAvatarUrl(avatar) {
  if (!avatar || typeof avatar !== 'string') return '';
  if (avatar.startsWith('blob:') || avatar.startsWith('{"uri"') || avatar.startsWith('{\\"uri\\"')) {
    return '';
  }
  return avatar;
}

function userShape(row, socialCounts, options = {}) {
  if (!row) return null;
  const avatar = cleanAvatarUrl(row.avatar);
  return {
    id: row.id,
    // Email chỉ trả về cho chính chủ (auth/me); API công khai không được lộ PII.
    ...(options.includeEmail ? { email: row.email } : {}),
    fullname: row.fullname,
    full_name: row.fullname,
    username: row.username,
    avatar,
    avatar_url: avatar,
    bio: row.bio,
    role: row.role,
    level: row.level,
    eco_points: row.eco_points,
    total_reports: row.total_reports,
    total_events: row.total_events,
    total_trees: row.total_trees,
    followers_count: socialCounts?.followers ?? 0,
    follower_count: socialCounts?.followers ?? 0,
    following_count: socialCounts?.following ?? 0,
    is_verified: row.is_verified,
    is_active: row.is_active,
    is_staff: row.is_staff,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Đếm follower/following thật từ collection 'follows' (id: follow-{follower}-{target}). */
async function socialCounts(database, userId) {
  if (!userId) return { followers: 0, following: 0 };
  const [row] = await database`
    SELECT
      count(*) FILTER (WHERE data->>'user_id' = ${userId})::int AS followers,
      count(*) FILTER (WHERE user_id = ${userId})::int AS following
    FROM app_data WHERE collection='follows'`;
  return { followers: row?.followers ?? 0, following: row?.following ?? 0 };
}

async function parseMultipart(req) {
  const fields = {};
  let uploaded = null;
  // busboy là Writable: 'finish' có thể bắn TRƯỚC khi stream file đọc hết,
  // khi đó uploaded còn null và ảnh bị mất âm thầm (thumb rỗng → icon 📍).
  // Vì vậy chỉ resolve khi vừa parse xong vừa đóng hết stream file.
  const pending = new Set();
  let parsed = false;
  await new Promise((resolve, reject) => {
    let settled = false;
    const done = () => {
      if (settled || !parsed || pending.size > 0) return;
      settled = true;
      resolve();
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    let parser;
    try {
      parser = require('busboy')({ headers: req.headers, limits: { fileSize: 4 * 1024 * 1024, files: 1 } });
    } catch (error) {
      fail(error);
      return;
    }
    parser.on('field', (name, value) => {
      fields[name] = value;
    });
    parser.on('file', (name, stream, info) => {
      const chunks = [];
      pending.add(stream);
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('limit', () => fail(new Error('Ảnh vượt giới hạn 4MB')));
      stream.on('error', fail);
      stream.on('end', () => {
        uploaded = { filename: info.filename, mimeType: info.mimeType, buffer: Buffer.concat(chunks) };
        pending.delete(stream);
        done();
      });
    });
    parser.on('error', fail);
    req.on('error', fail);
    parser.on('finish', () => {
      parsed = true;
      done();
    });
    req.pipe(parser);
  });
  return { fields, uploaded };
}

const IMAGE_SIGNATURES = [
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/webp', test: (b) => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
  { mime: 'image/gif', test: (b) => ['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6)) },
];

/** Nhận dạng ảnh từ magic bytes; client không thể giả Content-Type (SVG/HTML bị loại). */
function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return '';
  return IMAGE_SIGNATURES.find((sig) => sig.test(buffer))?.mime || '';
}

async function uploadImage(uploaded) {
  if (!uploaded) return '';
  const mime = detectImageMime(uploaded.buffer);
  if (!mime) {
    const error = new Error('INVALID_IMAGE');
    error.code = 'INVALID_IMAGE';
    throw error;
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID && !process.env.VERCEL_OIDC_TOKEN) {
    throw new Error('Blob storage is not configured (BLOB_READ_WRITE_TOKEN or BLOB_STORE_ID)');
  }
  const safeName = (uploaded.filename || 'image.jpg').replace(/[^a-zA-Z0-9._-]/g, '_');
  const folder = safeName.startsWith('avatar') ? 'avatars' : 'reports';
  const blob = await put(`${folder}/${Date.now()}-${safeName}`, uploaded.buffer, {
    access: 'public',
    contentType: mime,
  });
  return blob.url;
}

/** Upload ảnh, trả 400 nếu tệp không phải ảnh hợp lệ; trả undefined khi đã ghi response lỗi. */
async function uploadImageOrFail(res, uploaded) {
  try {
    return await uploadImage(uploaded);
  } catch (error) {
    if (error.code === 'INVALID_IMAGE') {
      fail(res, 400, 'INVALID_IMAGE', 'Tệp tải lên phải là ảnh JPEG, PNG, WEBP hoặc GIF');
      return undefined;
    }
    throw error;
  }
}

async function createReport(req, res, database, user, fields, imageUrl) {
  const severity = Object.hasOwn(POINTS_BY_SEVERITY, fields.severity) ? fields.severity : 'medium';
  // Severity do client gửi nên không thể tin để chấm điểm; chặn trần ở mức medium.
  const points = Math.min(POINTS_BY_SEVERITY[severity], POINTS_BY_SEVERITY.medium);
  const id = `rep-${crypto.randomUUID()}`;
  const latitude = Number(fields.latitude || fields.lat) || 12.6828;
  const longitude = Number(fields.longitude || fields.lng) || 108.0378;
  const photoUrls = imageUrl
    ? [imageUrl]
    : Array.isArray(fields.photo_urls)
    ? fields.photo_urls
    : fields.photo_urls
    ? safeJson(fields.photo_urls, [])
    : [];
  const wasteRaw = fields.wasteTypes || fields.waste_type || '';
  const wasteTypes = String(wasteRaw)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  const description = fields.description || '';

  const [report] = await database`INSERT INTO reports (id,user_id,latitude,longitude,address,severity,waste_types,description,status,photo_urls)
    VALUES (${id},${user.userId},${latitude},${longitude},${fields.address || fields.location || fields.title || 'Đắk Lắk, Việt Nam'},
      ${severity},${JSON.stringify(wasteTypes)}::jsonb,${description},'reported',${JSON.stringify(photoUrls)}::jsonb)
    RETURNING *`;

  const [log] = await database`INSERT INTO point_logs (id,user_id,points,action,reason,reference_id)
    VALUES (${'pl-' + id},${user.userId},${points},'report_submitted',${'Gửi báo cáo rác (' + severity + ')'},${id})
    ON CONFLICT (id) DO NOTHING RETURNING id`;

  const earned = log ? points : 0;
  const [u] = await database`UPDATE users SET eco_points=eco_points+${earned},total_reports=total_reports+1,updated_at=now()
    WHERE id=${user.userId} RETURNING eco_points`;
  return { report, pointsEarned: earned, newTotal: u?.eco_points ?? 0 };
}

/** Tham gia sự kiện, cộng điểm một lần duy nhất cho mỗi người/sự kiện. */
async function joinEvent(database, userId, eventId) {
  const [event] = await database`SELECT data FROM app_data WHERE collection='events' AND id=${eventId}`;
  if (!event) throw new Error('EVENT_NOT_FOUND');
  const participantId = `ep-${userId}-${eventId}`;
  const [inserted] = await database`INSERT INTO app_data(collection,id,user_id,data)
    VALUES('event_participants',${participantId},${userId},${JSON.stringify({
      id: participantId, event: eventId, user: userId, status: 'joined', joined_at: new Date().toISOString(),
    })}::jsonb)
    ON CONFLICT (collection,id) DO NOTHING RETURNING id`;
  if (!inserted) {
    const [u] = await database`SELECT eco_points FROM users WHERE id=${userId}`;
    return { id: participantId, joined: false, pointsEarned: 0, newTotal: u?.eco_points ?? 0 };
  }
  // Phần thưởng do người tạo sự kiện đặt; chặn trần để dữ liệu cũ/độc hại không bơm điểm.
  const points = Math.max(0, Math.min(Number(event.data?.eco_point_reward) || 0, 200));
  const [log] = await database`INSERT INTO point_logs (id,user_id,points,action,reason,reference_id)
    VALUES (${'pl-join-' + eventId + '-' + userId},${userId},${points},'event_joined',
      ${'Tham gia sự kiện: ' + (event.data?.title || '')},${eventId})
    ON CONFLICT (id) DO NOTHING RETURNING id`;
  const earned = log ? points : 0;
  const [u] = await database`UPDATE users SET eco_points=eco_points+${earned},total_events=total_events+1,updated_at=now()
    WHERE id=${userId} RETURNING eco_points`;
  return { id: participantId, joined: true, pointsEarned: earned, newTotal: u?.eco_points ?? 0 };
}

/** Rời sự kiện, thu hồi điểm đã cấp khi tham gia. */
async function leaveEvent(database, userId, participantId) {
  const [row] = await database`DELETE FROM app_data
    WHERE collection='event_participants' AND id=${participantId} AND user_id=${userId} RETURNING data`;
  if (!row) throw new Error('PARTICIPANT_NOT_FOUND');
  const eventId = row.data?.event;
  const [log] = await database`DELETE FROM point_logs
    WHERE user_id=${userId} AND action='event_joined' AND reference_id=${eventId} RETURNING points`;
  const revoked = log ? Number(log.points) || 0 : 0;
  const [u] = await database`UPDATE users SET eco_points=GREATEST(0,eco_points-${revoked}),
    total_events=GREATEST(0,total_events-1),updated_at=now()
    WHERE id=${userId} RETURNING eco_points`;
  return { left: true, revoked, newTotal: u?.eco_points ?? 0 };
}

module.exports = {
  sql,  POINTS_BY_SEVERITY,
  DOMAIN_ERRORS,
  failDomain,
  json,
  fail,
  bodyJson,
  currentUser,
  tokenFor,
  refreshTokenFor,
  revokeRefreshToken,
  isRefreshTokenRevoked,
  clientIp,
  secureEqual,
  exceedsRateLimit,
  handleCronCleanup,
  cleanupExpiredData,
  requestIdFor,
  logServerError,
  databaseReady,
  withTimeout,
  requireStaff,
  userShape,
  cleanAvatarUrl,
  socialCounts,
  parseMultipart,
  detectImageMime,
  uploadImage,
  uploadImageOrFail,
  createReport,
  joinEvent,
  leaveEvent,
};
