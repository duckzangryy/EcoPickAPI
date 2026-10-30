const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('node:crypto');
const {
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
  userShape,
  socialCounts,
  parseMultipart,
  uploadImage,
  uploadImageOrFail,
} = require('./helpers');

const ACCESS_TOKEN_SECONDS = 60 * 60;
const FORGOT_MESSAGE = 'Nếu email tồn tại, mã đặt lại mật khẩu đã được tạo';

async function handleAuth(req, res, path, method, database) {
  if ((path === '/api/v1/auth/register' || path === '/api/users/signup') && method === 'POST') {
    if (await exceedsRateLimit(database, res, 'register:ip', clientIp(req), 10, 3600)) return;
    const contentType = req.headers['content-type'] || '';
    const body = contentType.includes('multipart/form-data')
      ? (await parseMultipart(req)).fields
      : await bodyJson(req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!email || password.length < 8) {
      return fail(res, 400, 'VALIDATION_ERROR', 'Email bắt buộc; mật khẩu tối thiểu 8 ký tự');
    }
    const fullname = body.fullName || body.fullname || email.split('@')[0];
    const username =
      String(body.username || email.split('@')[0])
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '')
        .slice(0, 40) || `user_${Date.now()}`;
    const id = `user-${crypto.randomUUID()}`;
    const hash = await bcrypt.hash(password, 12);
    try {
      const [row] = await database`INSERT INTO users (id,email,password_hash,fullname,username,eco_points,is_verified)
        VALUES (${id},${email},${hash},${fullname},${username},0,false) RETURNING *`;
      const user = userShape(row, undefined, { includeEmail: true });
      const otp = crypto.randomInt(100000, 1000000).toString();
      await database`INSERT INTO otps(email,otp,expires_at) VALUES(${email},${otp},now()+interval '15 minutes') ON CONFLICT(email) DO UPDATE SET otp=EXCLUDED.otp,expires_at=EXCLUDED.expires_at`;
      return json(res, 201, {
        success: true,
        data: { user, message: 'Đăng ký thành công', otp: process.env.NODE_ENV === 'development' ? otp : undefined },
        id,
        email,
        message: 'Đăng ký thành công',
      });
    } catch (error) {
      if (error.code === '23505') return fail(res, 409, 'EMAIL_EXISTS', 'Email hoặc username đã được sử dụng');
      throw error;
    }
  }

  if ((path === '/api/v1/auth/login' || path === '/api/users/signin') && method === 'POST') {
    if (await exceedsRateLimit(database, res, 'login:ip', clientIp(req), 60, 900)) return;
    const body = await bodyJson(req);
    const email = String(body.email || '').trim().toLowerCase();
    if (await exceedsRateLimit(database, res, 'login:email', email, 20, 900)) return;
    const [row] = await database`SELECT * FROM users WHERE email=${email} AND is_active=true`;
    if (!row || !(await bcrypt.compare(String(body.password || ''), row.password_hash))) {
      return fail(res, 401, 'INVALID_CREDENTIALS', 'Email hoặc mật khẩu không chính xác');
    }
    const social = await socialCounts(database, row.id);
    const user = userShape(row, social, { includeEmail: true });
    const accessToken = tokenFor(user);
    const refreshToken = refreshTokenFor(user);
    return json(res, 200, {
      success: true,
      data: { user, accessToken, refreshToken },
      access_token: accessToken,
      accessToken,
      refresh_token: refreshToken,
      refreshToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_SECONDS,
      user,
    });
  }

  if (path === '/api/v1/auth/refresh' && method === 'POST') {
    const body = await bodyJson(req);
    try {
      const token = body.refreshToken || body.refresh_token;
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      if (payload.type !== 'refresh') throw new Error('Invalid refresh token');
      if (await isRefreshTokenRevoked(database, payload)) {
        return fail(res, 401, 'UNAUTHORIZED', 'Phiên đăng nhập đã kết thúc, vui lòng đăng nhập lại');
      }
      const [row] = await database`SELECT * FROM users WHERE id=${payload.userId} AND is_active=true`;
      if (!row) return fail(res, 401, 'UNAUTHORIZED', 'Tài khoản không còn tồn tại');
      const accessToken = tokenFor(userShape(row, undefined, { includeEmail: true }));
      return json(res, 200, { success: true, data: { accessToken, refreshToken: token }, access_token: accessToken, refresh_token: token });
    } catch {
      return fail(res, 401, 'UNAUTHORIZED', 'Refresh token không hợp lệ');
    }
  }

  if (path === '/api/v1/auth/logout' && method === 'POST') {
    // Thu hồi refresh token nếu client gửi kèm; access token sống 1 giờ nên tự hết hạn.
    const body = await bodyJson(req);
    await revokeRefreshToken(database, body.refreshToken || body.refresh_token);
    return json(res, 200, { success: true, data: { message: 'Đăng xuất thành công' } });
  }

  if ((path === '/api/v1/auth/google' || path === '/api/v1/auth/apple') && method === 'POST') {
    return fail(res, 501, 'NOT_CONFIGURED', 'OAuth chưa được cấu hình cho deployment này');
  }

  if (path === '/api/v1/auth/verify-email' && method === 'POST') {
    if (await exceedsRateLimit(database, res, 'verify:ip', clientIp(req), 30, 900)) return;
    const body = await bodyJson(req);
    const email = String(body.email || '').trim().toLowerCase();
    // OTP 6 số: giới hạn 5 lần thử / 15 phút cho mỗi email để chặn brute force.
    if (await exceedsRateLimit(database, res, 'verify:email', email, 5, 900)) return;
    const [stored] = await database`SELECT otp FROM otps WHERE email=${email} AND expires_at > now()`;
    if (!stored || !secureEqual(stored.otp, String(body.otp || body.code || '').trim())) {
      return fail(res, 400, 'INVALID_OTP', 'Mã xác thực không hợp lệ hoặc đã hết hạn');
    }
    const [row] = await database`UPDATE users SET is_verified=true, updated_at=now() WHERE email=${email} RETURNING *`;
    await database`DELETE FROM otps WHERE email=${email}`;
    if (!row) return fail(res, 404, 'NOT_FOUND', 'Không tìm thấy tài khoản');
    return json(res, 200, { success: true, data: { user: userShape(row, undefined, { includeEmail: true }), message: 'Xác thực email thành công' } });
  }

  if ((path === '/api/v1/auth/forgot-password' || path === '/api/v1/auth/reset-password') && method === 'POST') {
    const body = await bodyJson(req);
    const email = String(body.email || '').trim().toLowerCase();
    const isForgot = path.endsWith('forgot-password');
    const scope = isForgot ? 'forgot' : 'reset';
    if (await exceedsRateLimit(database, res, `${scope}:ip`, clientIp(req), 20, 900)) return;
    if (await exceedsRateLimit(database, res, `${scope}:email`, email, 5, 900)) return;

    if (isForgot) {
      const [user] = await database`SELECT id FROM users WHERE email=${email}`;
      // Không tiết lộ email có tồn tại hay không (chống enumeration).
      if (!user) {
        return json(res, 200, { success: true, data: { email, message: FORGOT_MESSAGE } });
      }
      const otp = crypto.randomInt(100000, 1000000).toString();
      await database`INSERT INTO otps(email,otp,expires_at) VALUES(${email},${otp},now()+interval '15 minutes') ON CONFLICT(email) DO UPDATE SET otp=EXCLUDED.otp,expires_at=EXCLUDED.expires_at`;
      return json(res, 200, {
        success: true,
        data: { email, message: FORGOT_MESSAGE, otp: process.env.NODE_ENV === 'development' ? otp : undefined },
      });
    }

    const otp = String(body.otp || body.code || '').trim();
    const password = String(body.newPassword || body.new_password || body.password || '');
    if (password.length < 8) return fail(res, 400, 'VALIDATION_ERROR', 'Mật khẩu mới tối thiểu 8 ký tự');
    const [stored] = await database`SELECT otp FROM otps WHERE email=${email} AND expires_at > now()`;
    if (!stored || !secureEqual(stored.otp, otp)) return fail(res, 400, 'INVALID_OTP', 'Mã xác thực không hợp lệ hoặc đã hết hạn');
    const [user] = await database`SELECT id FROM users WHERE email=${email}`;
    if (!user) return fail(res, 400, 'INVALID_OTP', 'Mã xác thực không hợp lệ hoặc đã hết hạn');
    const hash = await bcrypt.hash(password, 12);
    await database`UPDATE users SET password_hash=${hash},updated_at=now() WHERE id=${user.id}`;
    await database`DELETE FROM otps WHERE email=${email}`;
    return json(res, 200, { success: true, data: { message: 'Đặt lại mật khẩu thành công' } });
  }

  if (path === '/api/v1/users/me' || path === '/api/users/userinfo') {
    const auth = currentUser(req, res);
    if (!auth) return;
    if (method === 'GET') {
      const [row] = await database`SELECT * FROM users WHERE id=${auth.userId}`;
      if (!row) return fail(res, 404, 'NOT_FOUND', 'Không tìm thấy tài khoản');
      const social = await socialCounts(database, auth.userId);
      const user = userShape(row, social, { includeEmail: true });
      return json(res, 200, {
        success: true,
        data: {
          ...user,
          stats: {
            totalReports: user.total_reports,
            totalEvents: user.total_events,
            treesPlanted: user.total_trees,
            followerCount: social.followers,
            followingCount: social.following,
          },
        },
        ...user,
      });
    }
    if (method === 'PATCH' || method === 'PUT') {
      const body = await bodyJson(req);
      const fullName = body.fullname || body.fullName;
      let newAvatar = body.avatarUrl || body.avatar || null;
      if (typeof newAvatar === 'object' && newAvatar !== null) {
        if (newAvatar.base64) newAvatar = newAvatar.base64;
        else if (newAvatar.data) newAvatar = newAvatar.data;
        else newAvatar = null;
      }
      if (typeof newAvatar === 'string' && newAvatar.startsWith('data:image/')) {
        const [, base64Data = ''] = newAvatar.split(',');
        const buffer = Buffer.from(base64Data, 'base64');
        newAvatar = await uploadImageOrFail(res, { filename: `avatar_${auth.userId}.jpg`, buffer });
        if (newAvatar === undefined) return;
      } else if (typeof newAvatar === 'string' && (newAvatar.startsWith('blob:') || newAvatar.startsWith('{"uri"') || newAvatar.startsWith('{\\"uri\\"'))) {
        newAvatar = null;
      }
      const [row] = await database`UPDATE users SET fullname=COALESCE(${fullName || null},fullname), avatar=COALESCE(${newAvatar},avatar), bio=COALESCE(${body.bio || null},bio), updated_at=now() WHERE id=${auth.userId} RETURNING *`;
      const social = await socialCounts(database, auth.userId);
      const user = userShape(row, social, { includeEmail: true });
      return json(res, 200, { success: true, data: user, ...user });
    }
    return fail(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  }

  if (path === '/api/v1/users/me/avatar' && method === 'POST') {
    const auth = currentUser(req, res);
    if (!auth) return;
    const contentType = req.headers['content-type'] || '';
    const parsed = contentType.includes('multipart/form-data')
      ? await parseMultipart(req)
      : { fields: await bodyJson(req), uploaded: null };
    let avatarUrl = '';
    if (parsed.uploaded) {
      avatarUrl = await uploadImageOrFail(res, parsed.uploaded);
      if (avatarUrl === undefined) return;
    } else {
      let raw = parsed.fields.avatarUrl || parsed.fields.avatar || parsed.fields.base64 || '';
      if (typeof raw === 'string' && raw.startsWith('data:image/')) {
        try {
          const [meta, base64Data] = raw.split(',');
          const mimeMatch = meta.match(/:(.*?);/);
          const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
          const buffer = Buffer.from(base64Data, 'base64');
          avatarUrl = await uploadImage({ filename: `avatar_${auth.userId}.jpg`, mimeType, buffer });
        } catch {
          avatarUrl = '';
        }
      } else if (typeof raw === 'string' && !raw.startsWith('blob:') && !raw.startsWith('{')) {
        avatarUrl = raw;
      }
    }
    if (!avatarUrl) {
      return fail(res, 400, 'INVALID_AVATAR', 'Không thể xử lý ảnh đại diện');
    }
    const [row] = await database`UPDATE users SET avatar=${avatarUrl}, updated_at=now() WHERE id=${auth.userId} RETURNING *`;
    return json(res, 200, { success: true, data: { avatarUrl: row.avatar, avatar: row.avatar } });
  }

  return false;
}

module.exports = { handleAuth };
