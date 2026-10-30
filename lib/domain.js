const crypto = require('node:crypto');
const {
  json,
  fail,
  bodyJson,
  currentUser,
  userShape,
  parseMultipart,
  detectImageMime,
  uploadImageOrFail,
  joinEvent,
} = require('./helpers');
const { analyzeWasteImage } = require('./gemini');

const collections = {
  '/api/post/posts': 'posts',
  '/api/v1/posts': 'posts',
  '/api/v1/feed': 'posts',
  '/api/v1/feed/discover': 'posts',
  '/api/post/comments': 'comments',
  '/api/post/likes': 'likes',
  '/api/post/post-media': 'post_media',
  '/api/badge/badges': 'badges',
  '/api/v1/badges': 'badges',
  '/api/badge/user-badges': 'user_badges',
  '/api/badge/exchange-items': 'exchange_items',
  '/api/roles': 'roles',
  '/api/event/events': 'events',
  '/api/event/event-participants': 'event_participants',
  '/api/event/tour-stops': 'tour_stops',
  '/api/chat/conversations': 'conversations',
  '/api/v1/conversations': 'conversations',
  '/api/chat/conversation-members': 'conversation_members',
  '/api/chat/messages': 'messages',
  '/api/chat/point-logs': 'point_logs',
  '/api/v1/notifications': 'notifications',
  '/api/v1/notifications/unread-count': 'notifications',
  '/api/v1/notifications/read-all': 'notifications',
};

async function handleDomain(req, res, path, method, database, url) {
  const normalized = path.replace(/\/$/, '');
  if (normalized === '/api/ai/scan' && method === 'POST') {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) return fail(res, 400, 'VALIDATION_ERROR', 'Cần gửi ảnh dạng multipart/form-data (trường image)');
    const { uploaded } = await parseMultipart(req);
    if (!uploaded || !uploaded.buffer?.length) return fail(res, 400, 'VALIDATION_ERROR', 'Không tìm thấy ảnh (trường image)');
    const mime = detectImageMime(uploaded.buffer);
    if (!mime) return fail(res, 400, 'INVALID_IMAGE', 'Tệp tải lên phải là ảnh JPEG, PNG, WEBP hoặc GIF');
    const analysis = await analyzeWasteImage(uploaded.buffer, mime);
    if (!analysis) return fail(res, 502, 'AI_UNAVAILABLE', 'AI đang bận, vui lòng thử lại sau');
    return json(res, 200, { success: true, data: analysis });
  }
  if ((normalized === '/api/users' || normalized === '/api/v1/users') && method === 'GET') {
    const rows = await database`SELECT * FROM users WHERE is_active=true ORDER BY created_at DESC LIMIT 100`;
    return json(res, 200, rows.map(userShape));
  }
  if ((path === '/api/roles' || path === '/api/roles/') && method === 'GET') {
    const rows = await database`SELECT data FROM app_data WHERE collection='roles' ORDER BY created_at`;
    return json(res, 200, rows.map((row) => row.data));
  }

  const collection = collections[normalized];
  const detail = normalized.match(/^(.+)\/([^/]+)$/);
  const detailCollection = detail && collections[detail[1]];
  const user = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || normalized.startsWith('/api/chat/') || normalized.startsWith('/api/v1/notifications') || normalized === '/api/v1/feed/discover' ? currentUser(req, res) : null;
  if (user === null && (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || normalized.startsWith('/api/chat/') || normalized.startsWith('/api/v1/notifications'))) return true;

  const userDetail = normalized.match(/^\/api\/(?:v1\/)?users\/([^/]+)$/);
  if (userDetail && userDetail[1] !== 'me') {
    const targetId = userDetail[1];
    if (method === 'GET') {
      const [row] = await database`SELECT * FROM users WHERE id=${targetId}`;
      return row ? json(res, 200, userShape(row)) : fail(res, 404, 'NOT_FOUND', 'Không tìm thấy tài khoản');
    }
    const auth = user || currentUser(req, res);
    if (!auth) return true;
    if (method === 'DELETE') {
      if (auth.userId !== targetId && !auth.is_staff) return fail(res, 403, 'FORBIDDEN', 'Không có quyền');
      await database`UPDATE users SET is_active=false,updated_at=now() WHERE id=${targetId}`;
      return json(res, 200, { success: true });
    }
    if (method === 'PUT' || method === 'PATCH') {
      if (auth.userId !== targetId && !auth.is_staff) return fail(res, 403, 'FORBIDDEN', 'Không có quyền');
      const body = (req.headers['content-type'] || '').includes('multipart/form-data') ? (await parseMultipart(req)).fields : await bodyJson(req);
      let newAvatar = body.avatar || body.avatarUrl || null;
      if (typeof newAvatar === 'object' && newAvatar !== null) {
        if (newAvatar.base64) newAvatar = newAvatar.base64;
        else if (newAvatar.data) newAvatar = newAvatar.data;
        else newAvatar = null;
      }
      if (typeof newAvatar === 'string' && (newAvatar.startsWith('blob:') || newAvatar.startsWith('{"uri"') || newAvatar.startsWith('{\\"uri\\"'))) {
        newAvatar = null;
      }
      const [row] = await database`UPDATE users SET fullname=COALESCE(${body.fullname || null},fullname),avatar=COALESCE(${newAvatar},avatar),bio=COALESCE(${body.bio || null},bio),updated_at=now() WHERE id=${targetId} RETURNING *`;
      return row ? json(res, 200, userShape(row)) : fail(res, 404, 'NOT_FOUND', 'Không tìm thấy tài khoản');
    }
  }

  if (normalized === '/api/v1/users/me/activity' && method === 'GET') {
    const auth = currentUser(req, res);
    if (!auth) return true;
    const rows = await database`SELECT id,user_id,points,action,reason,reference_id,created_at FROM point_logs WHERE user_id=${auth.userId} ORDER BY created_at DESC LIMIT 50`;
    return json(res, 200, { success: true, data: rows });
  }

  if (normalized === '/api/v1/leaderboard' && method === 'GET') {
    // period=weekly|monthly|all — cộng điểm từ point_logs theo kỳ (mặc định all = eco_points tổng)
    const period = (url.searchParams.get('period') || 'all').toLowerCase();
    if (period === 'weekly' || period === 'monthly') {
      const days = period === 'weekly' ? 7 : 30;
      const rows = await database`
        SELECT u.id, u.fullname, u.avatar, u.level,
          COALESCE(SUM(pl.points),0)::int AS eco_points,
          count(*) FILTER (WHERE pl.action='report_submitted')::int AS total_reports
        FROM point_logs pl JOIN users u ON u.id=pl.user_id AND u.is_active=true
        WHERE pl.created_at >= now() - (${days} || ' days')::interval AND pl.points > 0
        GROUP BY u.id, u.fullname, u.avatar, u.level
        ORDER BY eco_points DESC LIMIT 100`;
      return json(res, 200, { success: true, data: { leaderboard: rows.map((row, index) => ({ rank: index + 1, id: row.id, fullName: row.fullname, avatarUrl: typeof row.avatar === 'string' && /blob:|^\{\\?"uri/.test(row.avatar) ? '' : row.avatar, ecoPoints: row.eco_points, level: row.level, reportsCount: row.total_reports })) } });
    }
    const rows = await database`SELECT id,fullname,avatar,eco_points,level,total_reports FROM users WHERE is_active=true ORDER BY eco_points DESC LIMIT 100`;
    return json(res, 200, { success: true, data: { leaderboard: rows.map((row, index) => ({ rank: index + 1, id: row.id, fullName: row.fullname, avatarUrl: typeof row.avatar === 'string' && /blob:|^\{\\?"uri/.test(row.avatar) ? '' : row.avatar, ecoPoints: row.eco_points, level: row.level, reportsCount: row.total_reports })) } });
  }

  // Chuỗi ngày hoạt động liên tục (streak) của tôi — dựa trên point_logs
  if (normalized === '/api/v1/users/me/streak' && method === 'GET') {
    const auth = currentUser(req, res);
    if (!auth) return true;
    const rows = await database`
      SELECT DISTINCT (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS d
      FROM point_logs WHERE user_id=${auth.userId} AND points > 0
      ORDER BY d DESC LIMIT 120`;
    // Neon driver trả Date (UTC nửa đêm +07) cho ::date — chuẩn hóa về yyyy-mm-dd
    const days = rows.map((r) => (r.d instanceof Date ? r.d.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }) : String(r.d).slice(0, 10)));
    let streak = 0;
    if (days.length > 0) {
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
      const cursor = new Date(days[0] + 'T00:00:00+07:00');
      const todayMs = new Date(today + 'T00:00:00+07:00').getTime();
      // Chuỗi chỉ tính khi có hoạt động hôm nay hoặc hôm qua
      if (todayMs - cursor.getTime() <= 86400000) {
        streak = 1;
        for (let i = 1; i < days.length; i++) {
          const gap = cursor.getTime() - new Date(days[i] + 'T00:00:00+07:00').getTime();
          if (gap === 86400000) { streak++; cursor.setDate(cursor.getDate() - 1); } else break;
        }
      }
    }
    return json(res, 200, { success: true, data: { streak, activeDays: days.length, lastActive: days[0] || null } });
  }

  if (normalized === '/api/v1/challenges/daily' && method === 'GET') {
    const rows = await database`SELECT data FROM app_data WHERE collection='challenges' ORDER BY created_at DESC`;
    return json(res, 200, { success: true, data: { challenges: rows.map((row) => row.data) } });
  }

  if (normalized === '/api/v1/feed/discover' && method === 'GET') {
    const rows = await database`SELECT data FROM app_data WHERE collection='posts' ORDER BY created_at DESC LIMIT 100`;
    return json(res, 200, { success: true, data: rows.map((row) => row.data), results: rows.map((row) => row.data) });
  }

  if (normalized === '/api/v1/reports/nearby' && method === 'GET') {
    const rows = await database`SELECT r.*,u.fullname,u.avatar FROM reports r JOIN users u ON u.id=r.user_id ORDER BY r.created_at DESC LIMIT 100`;
    const reports = rows.map(({ fullname, avatar, ...report }) => ({ ...report, distance: null, reportedBy: { id: report.user_id, fullName: fullname, avatarUrl: avatar } }));
    return json(res, 200, { success: true, data: { reports, pagination: { page: 1, limit: 100, total: reports.length } } });
  }

  if (normalized === '/api/v1/events/nearby' && method === 'GET') {
    const rows = await database`SELECT data FROM app_data WHERE collection='events' ORDER BY created_at DESC`;
    return json(res, 200, { success: true, data: { events: rows.map((row) => row.data) } });
  }

  const eventAction = normalized.match(/^\/api\/v1\/events\/([^/]+)\/(join|check-in)$/);
  if (eventAction && method === 'POST') {
    const auth = user || currentUser(req, res);
    if (!auth) return true;
    const participantId = `ep-${auth.userId}-${eventAction[1]}`;
    if (eventAction[2] === 'join') {
      const result = await joinEvent(database, auth.userId, eventAction[1]);
      return json(res, 200, { success: true, data: { message: 'Đã tham gia sự kiện thành công!', ...result }, ...result });
    }
    await database`INSERT INTO app_data(collection,id,user_id,data)
      VALUES('event_participants',${participantId},${auth.userId},${JSON.stringify({
        id: participantId, event: eventAction[1], user: auth.userId, status: 'checked_in', joined_at: new Date().toISOString(),
      })}::jsonb)
      ON CONFLICT (collection,id) DO NOTHING`;
    return json(res, 200, { success: true, data: { message: 'Đã điểm danh sự kiện!' } });
  }

  const userAction = normalized.match(/^\/api\/v1\/users\/([^/]+)\/(?:stats|badges|activity)$/);
  if (userAction && method === 'GET') {
    const auth = currentUser(req, res);
    if (!auth) return true;
    const targetId = userAction[1];
    if (normalized.endsWith('/activity')) {
      const rows = await database`SELECT id,user_id,points,action,reason,reference_id,created_at FROM point_logs WHERE user_id=${targetId} ORDER BY created_at DESC LIMIT 50`;
      return json(res, 200, { success: true, data: rows });
    }
    if (normalized.endsWith('/badges')) {
      const rows = await database`SELECT data FROM app_data WHERE collection='user_badges' AND user_id=${targetId} ORDER BY created_at DESC`;
      return json(res, 200, rows.map((row) => row.data));
    }
    const [row] = await database`SELECT total_reports,total_events,total_trees,eco_points,level FROM users WHERE id=${targetId}`;
    return row ? json(res, 200, { success: true, data: { totalReports: row.total_reports, totalEvents: row.total_events, treesPlanted: row.total_trees, ecoPoints: row.eco_points, level: row.level } }) : fail(res, 404, 'NOT_FOUND', 'Không tìm thấy tài khoản');
  }

  const followMatch = normalized.match(/^\/api\/v1\/users\/([^/]+)\/follow$/);
  if (followMatch && ['POST', 'DELETE'].includes(method)) {
    const auth = user || currentUser(req, res);
    if (!auth) return true;
    const target = followMatch[1];
    const id = `follow-${auth.userId}-${target}`;
    if (method === 'POST') await database`INSERT INTO app_data(collection,id,user_id,data) VALUES('follows',${id},${auth.userId},${JSON.stringify({ id, follower_id: auth.userId, user_id: target })}::jsonb) ON CONFLICT(collection,id) DO NOTHING`;
    else await database`DELETE FROM app_data WHERE collection='follows' AND id=${id}`;
    return json(res, 200, { success: true, data: { isFollowing: method === 'POST' } });
  }

  if (normalized === '/api/v1/users/me/fcm-token' && method === 'POST') {
    const auth = user || currentUser(req, res);
    if (!auth) return true;
    const body = await bodyJson(req);
    await database`INSERT INTO app_data(collection,id,user_id,data) VALUES('user_tokens',${auth.userId},${auth.userId},${JSON.stringify({ token: body.token || body.fcm_token || '' })}::jsonb) ON CONFLICT(collection,id) DO UPDATE SET data=EXCLUDED.data`;
    return json(res, 200, { success: true });
  }

  if (normalized === '/api/v1/uploads/presigned' && method === 'POST') {
    const auth = currentUser(req, res);
    if (!auth) return true;
    return fail(res, 501, 'NOT_CONFIGURED', 'Dùng POST /api/upload để upload ảnh trực tiếp');
  }

  if (normalized === '/api/v1/notifications/read-all' && ['POST', 'PATCH'].includes(method)) {
    await database`UPDATE app_data SET data=data || '{"is_read":true}'::jsonb WHERE collection='notifications' AND user_id=${user.userId}`;
    return json(res, 200, { success: true, data: { message: 'Đã đánh dấu tất cả đã đọc' } });
  }

  if ((collection || detailCollection) && ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const name = collection || detailCollection;
    const id = detailCollection ? detail[2] : null;
    if (method === 'GET') {
      if (name === 'notifications' && id === 'unread-count') {
        const [row] = await database`SELECT count(*)::int AS count FROM app_data WHERE collection='notifications' AND user_id=${user.userId} AND COALESCE((data->>'is_read')::boolean,false)=false`;
        return json(res, 200, { success: true, data: { count: row.count } });
      }
      if (name === 'notifications') {
        const rows = await database`SELECT data FROM app_data WHERE collection=${name} AND user_id=${user.userId} ORDER BY created_at DESC`;
        const items = rows.map((row) => row.data);
        if (id === 'unread-count') return json(res, 200, { success: true, data: { count: items.filter((item) => !item.is_read).length } });
        if (id) return fail(res, 404, 'NOT_FOUND', 'Không tìm thấy thông báo');
        return json(res, 200, { success: true, data: { notifications: items, pagination: { page: 1, limit: items.length, total: items.length } } });
      }
      if (name === 'posts' && id) {
        const [row] = await database`SELECT data FROM app_data WHERE collection=${name} AND id=${id}`;
        return row ? json(res, 200, { success: true, data: row.data, ...row.data }) : fail(res, 404, 'NOT_FOUND', 'Không tìm thấy bài viết');
      }
      if (['messages', 'conversations', 'conversation_members', 'point_logs'].includes(name) && !user) {
        const auth = currentUser(req, res);
        if (!auth) return true;
      }
      if (['messages', 'conversations', 'conversation_members'].includes(name)) {
        const rows = await database`SELECT data FROM app_data WHERE collection=${name} AND (user_id=${user?.userId || ''} OR data->>'user'=${user?.userId || ''} OR data->>'sender_id'=${user?.userId || ''}) ORDER BY created_at DESC`;
        const values = rows.map((row) => row.data);
        if (!id) return json(res, 200, values);
        const item = values.find((entry) => String(entry.id) === id);
        return item ? json(res, 200, item) : fail(res, 404, 'NOT_FOUND', 'Không tìm thấy dữ liệu');
      }
      if (name === 'roles' && id) return fail(res, 404, 'NOT_FOUND', 'Không tìm thấy vai trò');
      if (name === 'posts' && !id) {
        const rows = await database`SELECT data FROM app_data WHERE collection=${name} ORDER BY created_at DESC`;
        return json(res, 200, normalized === '/api/v1/feed' ? { success: true, data: rows.map((row) => row.data), results: rows.map((row) => row.data) } : rows.map((row) => row.data));
      }
      if (name === 'badges' && id) {
        const [row] = await database`SELECT data FROM app_data WHERE collection=${name} AND id=${id}`;
        return row ? json(res, 200, row.data) : fail(res, 404, 'NOT_FOUND', 'Không tìm thấy huy hiệu');
      }
      if (name === 'user_badges') {
        const rows = await database`SELECT data FROM app_data WHERE collection=${name} ORDER BY created_at DESC`;
        let values = rows.map((row) => row.data);
        const userId = url.searchParams.get('user_id');
        const badgeId = url.searchParams.get('badge_id');
        if (userId) values = values.filter((item) => item.user_id === userId);
        if (badgeId) values = values.filter((item) => item.badge_id === badgeId);
        return json(res, 200, values);
      }
      if (name === 'roles') {
        const rows = await database`SELECT data FROM app_data WHERE collection=${name} ORDER BY created_at ASC`;
        return json(res, 200, rows.map((row) => row.data));
      }
      if (name === 'event_participants') {
        const rows = await database`SELECT data FROM app_data WHERE collection='event_participants' ORDER BY created_at DESC`;
        let values = rows.map((row) => row.data);
        const eventId = url.searchParams.get('event') || url.searchParams.get('event_id');
        if (eventId) {
          values = values.filter((item) => item.event === eventId || item.event_id === eventId);
        }
        // Mỗi user chỉ xuất hiện một lần trong danh sách (row mới nhất thắng)
        const seenUsers = new Set();
        values = values.filter((item) => {
          const uid = item.user || item.user_id;
          if (!uid) return true;
          if (seenUsers.has(uid)) return false;
          seenUsers.add(uid);
          return true;
        });
        const userIds = [...new Set(values.map((v) => v.user || v.user_id).filter(Boolean))];
        let usersMap = {};
        if (userIds.length > 0) {
          const uRows = await database`SELECT id, fullname, avatar FROM users WHERE id IN ${database(userIds)}`;
          usersMap = Object.fromEntries(uRows.map((u) => [u.id, u]));
        }
        values = values.map((item) => {
          const u = usersMap[item.user || item.user_id] || {};
          return {
            ...item,
            participant: {
              id: u.id || item.user,
              fullname: u.fullname || item.participant?.fullname || 'Người dùng EcoPick',
              avatar: u.avatar || item.participant?.avatar || '',
            },
          };
        });
        if (!id) return json(res, 200, values);
        const item = values.find((entry) => String(entry.id) === id);
        return item ? json(res, 200, item) : fail(res, 404, 'NOT_FOUND', 'Không tìm thấy dữ liệu');
      }
      if (name === 'tour_stops') {
        const rows = await database`SELECT data FROM app_data WHERE collection=${name} ORDER BY created_at DESC`;
        const values = rows.map((row) => row.data);
        if (!id) return json(res, 200, values);
        const item = values.find((entry) => String(entry.id) === id);
        return item ? json(res, 200, item) : fail(res, 404, 'NOT_FOUND', 'Không tìm thấy dữ liệu');
      }
      if (name === 'point_logs') {
        const auth = user || currentUser(req, res);
        if (!auth) return true;
        const logs = await database`SELECT id,user_id,points,action,reason,reference_id,created_at FROM point_logs WHERE user_id=${auth.userId} ORDER BY created_at DESC LIMIT 100`;
        return json(res, 200, logs);
      }
      if (['comments', 'likes', 'post_media'].includes(name)) {
        const rows = await database`SELECT data FROM app_data WHERE collection=${name} ORDER BY created_at DESC`;
        const values = rows.map((row) => row.data);
        const postId = url.searchParams.get('post');
        const filtered = postId ? values.filter((item) => item.post_id === postId) : values;
        return json(res, 200, id ? filtered.find((entry) => String(entry.id) === id) || null : filtered);
      }
      if (collection) {
        const rows = await database`SELECT data FROM app_data WHERE collection=${name} ORDER BY created_at DESC`;
        return json(res, 200, rows.map((row) => row.data));
      }
      if (id) {
        const [row] = await database`SELECT data FROM app_data WHERE collection=${name} AND id=${id}`;
        return row ? json(res, 200, row.data) : fail(res, 404, 'NOT_FOUND', 'Không tìm thấy dữ liệu');
      }
      const rows = await database`SELECT data FROM app_data WHERE collection=${name} ORDER BY created_at DESC`;
      return json(res, 200, rows.map((row) => row.data));
    }
    if (method === 'DELETE') {
      if (name === 'exchange_items') {
        const [row] = await database`DELETE FROM exchange_items WHERE id=${id} RETURNING id`;
        return row ? json(res, 200, { success: true }) : fail(res, 404, 'NOT_FOUND', 'Không tìm thấy dữ liệu');
      }
      if (!id) return fail(res, 400, 'VALIDATION_ERROR', 'ID bắt buộc');
      const [existing] = await database`SELECT user_id FROM app_data WHERE collection=${name} AND id=${id}`;
      if (!existing) return fail(res, 404, 'NOT_FOUND', 'Không tìm thấy dữ liệu');
      if (existing.user_id && existing.user_id !== user?.userId && !user?.is_staff) return fail(res, 403, 'FORBIDDEN', 'Không có quyền');
      const [deleted] = await database`DELETE FROM app_data WHERE collection=${name} AND id=${id} RETURNING id`;
      return deleted ? json(res, 200, { success: true }) : fail(res, 404, 'NOT_FOUND', 'Không tìm thấy dữ liệu');
    }
    const contentType = req.headers['content-type'] || '';
    const parsed = contentType.includes('multipart/form-data') ? await parseMultipart(req) : { fields: await bodyJson(req), uploaded: null };
    const body = parsed.fields;
    if (name === 'post_media') {
      if (parsed.uploaded) {
        const mediaUrl = await uploadImageOrFail(res, parsed.uploaded);
        if (mediaUrl === undefined) return true;
        body.media_url = mediaUrl;
        body.media_type ||= detectImageMime(parsed.uploaded.buffer) || 'image';
      }
    }
    if (method === 'PATCH' || method === 'PUT') {
      if (!id) return fail(res, 400, 'VALIDATION_ERROR', 'ID bắt buộc');
      const [existing] = await database`SELECT data FROM app_data WHERE collection=${name} AND id=${id}`;
      if (!existing) return fail(res, 404, 'NOT_FOUND', 'Không tìm thấy dữ liệu');
      const updated = { ...existing.data, ...body, updated_at: new Date().toISOString() };
      const [row] = await database`UPDATE app_data SET data=${JSON.stringify(updated)}::jsonb WHERE collection=${name} AND id=${id} RETURNING data`;
      return json(res, 200, row.data);
    }
    const newId = String(body.id || `${name.slice(0, -1)}-${crypto.randomUUID()}`);
    const created = { ...body, id: newId, created_at: body.created_at || new Date().toISOString() };
    if (name === 'posts') { created.author_id = user.userId; created.likes_count = 0; created.comments_count = 0; }
    if (name === 'comments') created.user_id = user.userId;
    if (name === 'likes') created.user_id = user.userId;
    if (name === 'messages') { created.sender_id = user.userId; created.conversation_id ||= 'conv-001'; created.text ||= created.content || ''; }
    if (name === 'event_participants') { created.user = user.userId; created.status ||= 'joined'; created.joined_at ||= new Date().toISOString(); }
    if (name === 'notifications') created.user_id = user.userId;
    if (name === 'user_badges' && !user.is_staff) return fail(res, 403, 'FORBIDDEN', 'Không có quyền cấp huy hiệu');
    if (name === 'roles' && !user.is_staff) return fail(res, 403, 'FORBIDDEN', 'Không có quyền quản lý vai trò');
    if (name === 'exchange_items' && !user.is_staff) return fail(res, 403, 'FORBIDDEN', 'Không có quyền quản lý phần thưởng');
    if (name === 'event_participants') {
      const eventId = String(created.event || '');
      const [event] = await database`SELECT data FROM app_data WHERE collection='events' AND id=${eventId}`;
      if (!event) return fail(res, 404, 'NOT_FOUND', 'Không tìm thấy sự kiện');
      // Cấp điểm đúng một lần mỗi người/sự kiện (idempotent)
      const result = await joinEvent(database, user.userId, eventId);
      return json(res, 201, { ...created, id: newId, ...result });
    }
    if (name === 'likes') {
      // Một like duy nhất mỗi user/post (idempotent, toggle không tạo trùng)
      const postId = String(created.post_id || created.post || '');
      if (!postId) return fail(res, 400, 'VALIDATION_ERROR', 'post_id bắt buộc');
      const likeId = `like-${user.userId}-${postId}`;
      const [inserted] = await database`INSERT INTO app_data(collection,id,user_id,data)
        VALUES('likes',${likeId},${user.userId},${JSON.stringify({ id: likeId, post_id: postId, user_id: user.userId, created_at: created.created_at })}::jsonb)
        ON CONFLICT (collection,id) DO NOTHING RETURNING id`;
      if (inserted) {
        await database`UPDATE app_data SET data=jsonb_set(data,'{likes_count}',(((data->>'likes_count')::int + 1)::text)::jsonb)
          WHERE collection='posts' AND id=${postId}`;
      }
      const [post] = await database`SELECT data FROM app_data WHERE collection='posts' AND id=${postId}`;
      return json(res, 201, { ...created, id: likeId, likes_count: post?.data?.likes_count ?? 0 });
    }
    if (name === 'conversation_members') {
      // Một thành viên duy nhất mỗi user/conversation
      const convId = String(created.conversation_id || created.conversation || '');
      if (!convId) return fail(res, 400, 'VALIDATION_ERROR', 'conversation_id bắt buộc');
      const memberId = `cm-${convId}-${user.userId}`;
      const [inserted] = await database`INSERT INTO app_data(collection,id,user_id,data)
        VALUES('conversation_members',${memberId},${user.userId},${JSON.stringify({ id: memberId, conversation_id: convId, user_id: user.userId, joined_at: created.created_at })}::jsonb)
        ON CONFLICT (collection,id) DO NOTHING RETURNING id`;
      return json(res, 201, { ...created, id: memberId, deduped: !inserted });
    }
    if (name === 'messages') {
      const [membership] = await database`SELECT id FROM app_data WHERE collection='conversation_members' AND data->>'conversation_id'=${created.conversation_id} AND data->>'user_id'=${user.userId}`;
      if (!membership) return fail(res, 403, 'FORBIDDEN', 'Bạn không thuộc cuộc trò chuyện này');
    }
    if (name === 'roles' && method === 'PATCH' && !id) {
      const roleId = String(body.id || '');
      if (!roleId) return fail(res, 400, 'VALIDATION_ERROR', 'ID bắt buộc');
      const [existing] = await database`SELECT data FROM app_data WHERE collection='roles' AND id=${roleId}`;
      if (!existing) return fail(res, 404, 'NOT_FOUND', 'Không tìm thấy vai trò');
      const updated = { ...existing.data, ...body };
      const [row] = await database`UPDATE app_data SET data=${JSON.stringify(updated)}::jsonb WHERE collection='roles' AND id=${roleId} RETURNING data`;
      return json(res, 200, row.data);
    }
    await database`INSERT INTO app_data(collection,id,user_id,data) VALUES(${name},${newId},${user.userId},${JSON.stringify(created)}::jsonb)`;
    return json(res, 201, created);
  }

  return false;
}

module.exports = { handleDomain };
