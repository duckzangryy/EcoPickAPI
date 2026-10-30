const crypto = require('node:crypto');
const {
  json,
  fail,
  bodyJson,
  currentUser,
  requireStaff,
  parseMultipart,
  leaveEvent,
} = require('./helpers');

async function handleEventsAndRewards(req, res, path, method, database) {
  const rewardPath = path.match(/^\/api\/badge\/exchange-items\/([^/]+)\/redeem$/);
  if ((path === '/api/badge/exchange-items' || path === '/api/v1/rewards') && method === 'GET') {
    const items = await database`SELECT id,title,description,points_cost,image_url,sponsor,category,available_quantity FROM exchange_items ORDER BY id`;
    return json(res, 200, path.includes('/v1/') ? { success: true, data: items } : items);
  }
  if (path === '/api/badge/exchange-items' && method === 'POST') {
    const auth = await requireStaff(req, res, database);
    if (!auth) return;
    const body = await bodyJson(req);
    if (!body.title || !Number.isFinite(Number(body.points_cost)) || Number(body.points_cost) < 1) {
      return fail(res, 400, 'VALIDATION_ERROR', 'Tên quà và điểm đổi hợp lệ là bắt buộc');
    }
    const item = {
      id: String(body.id || `ex-${crypto.randomUUID()}`),
      title: String(body.title),
      description: String(body.description || ''),
      points_cost: Number(body.points_cost),
      image_url: String(body.image_url || ''),
      sponsor: String(body.sponsor || ''),
      category: String(body.category || 'voucher'),
      available_quantity: body.available_quantity == null ? null : Number(body.available_quantity),
    };
    await database`INSERT INTO exchange_items(id,title,description,points_cost,image_url,sponsor,category,available_quantity,data) VALUES(${item.id},${item.title},${item.description},${item.points_cost},${item.image_url},${item.sponsor},${item.category},${item.available_quantity},${JSON.stringify(item)}::jsonb)`;
    return json(res, 201, item);
  }
  const exchangeItemId = path.match(/^\/api\/badge\/exchange-items\/([^/]+)$/);
  if (exchangeItemId && method === 'DELETE') {
    const auth = await requireStaff(req, res, database);
    if (!auth) return;
    const [row] = await database`DELETE FROM exchange_items WHERE id=${exchangeItemId[1]} RETURNING id`;
    return row ? json(res, 200, { success: true }) : fail(res, 404, 'NOT_FOUND', 'Không tìm thấy phần thưởng');
  }
  if (rewardPath && method === 'POST') {
    const auth = currentUser(req, res);
    if (!auth) return;
    const newId = `red-${crypto.randomUUID()}`;
    const code = `ECO-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    const [result] = await database`SELECT ecopick_redeem(${auth.userId},${rewardPath[1]},${newId},${code}) AS value`;
    if (!result?.value) throw new Error('Could not persist redemption');
    return json(res, 201, { success: true, data: result.value });
  }

  if (path === '/api/badge/redemptions' && method === 'GET') {
    const auth = currentUser(req, res);
    if (!auth) return;
    const rows = await database`SELECT * FROM redemptions WHERE user_id=${auth.userId} ORDER BY created_at DESC`;
    return json(res, 200, rows);
  }

  const redemptionDetail = path.match(/^\/api\/badge\/redemptions\/([^/]+)$/);
  if (redemptionDetail && method === 'GET') {
    const auth = currentUser(req, res);
    if (!auth) return;
    const [row] = await database`SELECT * FROM redemptions WHERE id=${redemptionDetail[1]} AND user_id=${auth.userId}`;
    return row ? json(res, 200, row) : fail(res, 404, 'NOT_FOUND', 'Không tìm thấy phần thưởng đã đổi');
  }

  if ((path === '/api/chat/point-logs' || path === '/api/v1/points/history') && method === 'GET') {
    const auth = currentUser(req, res);
    if (!auth) return;
    const logs = await database`SELECT id,user_id,points,action,reason,reference_id,created_at FROM point_logs WHERE user_id=${auth.userId} ORDER BY created_at DESC LIMIT 100`;
    return json(res, 200, { success: true, data: logs, results: logs });
  }

  if ((path === '/api/event/events' || path === '/api/v1/events') && method === 'GET') {
    const rows = await database`SELECT data FROM app_data WHERE collection='events' ORDER BY created_at DESC`;
    const pRows = await database`SELECT data->>'event' AS event_id, count(*)::int AS count FROM app_data WHERE collection='event_participants' AND COALESCE(data->>'status','joined')='joined' GROUP BY data->>'event'`;
    const countMap = Object.fromEntries(pRows.map((r) => [r.event_id, r.count]));
    const events = rows.map((row) => {
      const e = row.data;
      const count = countMap[e.id] != null ? countMap[e.id] : (Number(e.current_paticipants) || 0);
      return { ...e, current_paticipants: count, current_participants: count };
    });
    return json(res, 200, path.includes('/v1/') ? { success: true, data: { events }, events } : events);
  }
  if ((path === '/api/event/events' || path === '/api/v1/events') && method === 'POST') {
    const auth = await requireStaff(req, res, database);
    if (!auth) return;
    const contentType = req.headers['content-type'] || '';
    const body = contentType.includes('multipart/form-data') ? (await parseMultipart(req)).fields : await bodyJson(req);
    if (!body.title) return fail(res, 400, 'VALIDATION_ERROR', 'Tên sự kiện bắt buộc');
    const now = new Date().toISOString();
    const event = {
      ...body,
      id: `evt-${crypto.randomUUID()}`,
      title: String(body.title),
      organizer_id: auth.userId,
      latitude: Number(body.latitude) || 12.6828,
      longitude: Number(body.longitude) || 108.0378,
      start_date: body.start_date || body.startDate || now,
      end_date: body.end_date || body.endDate || now,
      max_paticipants: Number(body.max_paticipants || body.max_participants) || 50,
      eco_point_reward: Math.max(0, Math.min(Number(body.eco_point_reward) || 0, 200)),
      current_paticipants: 1,
      status: body.status || 'upcoming',
      created_at: now,
      updated_at: now,
    };
    await database`INSERT INTO app_data(collection,id,user_id,data) VALUES('events',${event.id},${auth.userId},${JSON.stringify(event)}::jsonb)`;
    return json(res, 201, { success: true, data: event, ...event });
  }
  const eventDetail = path.match(/^\/api\/(?:v1\/)?(?:event\/)?events\/([^/]+)$/);
  if (eventDetail && method === 'GET') {
    const [event] = await database`SELECT data FROM app_data WHERE collection='events' AND id=${eventDetail[1]}`;
    if (!event) return fail(res, 404, 'NOT_FOUND', 'Không tìm thấy sự kiện');
    const [pCount] = await database`SELECT count(*)::int AS count FROM app_data WHERE collection='event_participants' AND data->>'event'=${eventDetail[1]} AND COALESCE(data->>'status','joined')='joined'`;
    const count = pCount?.count != null ? pCount.count : (Number(event.data.current_paticipants) || 0);
    const data = { ...event.data, current_paticipants: count, current_participants: count };
    return json(res, 200, { success: true, data, ...data });
  }
  if (eventDetail && ['PUT', 'PATCH'].includes(method)) {
    const auth = currentUser(req, res);
    if (!auth) return;
    const [event] = await database`SELECT data FROM app_data WHERE collection='events' AND id=${eventDetail[1]}`;
    if (!event) return fail(res, 404, 'NOT_FOUND', 'Không tìm thấy sự kiện');
    if (event.data.organizer_id !== auth.userId && !auth.is_staff) return fail(res, 403, 'FORBIDDEN', 'Không có quyền');
    const body = (req.headers['content-type'] || '').includes('multipart/form-data')
      ? (await parseMultipart(req)).fields
      : await bodyJson(req);
    const updated = {
      ...event.data,
      ...body,
      id: eventDetail[1],
      updated_at: new Date().toISOString(),
    };
    await database`UPDATE app_data SET data=${JSON.stringify(updated)}::jsonb WHERE collection='events' AND id=${eventDetail[1]}`;
    return json(res, 200, { success: true, data: updated, ...updated });
  }
  if (eventDetail && method === 'DELETE') {
    const auth = currentUser(req, res);
    if (!auth) return;
    const [event] = await database`SELECT data FROM app_data WHERE collection='events' AND id=${eventDetail[1]}`;
    if (!event) return fail(res, 404, 'NOT_FOUND', 'Không tìm thấy sự kiện');
    if (event.data.organizer_id !== auth.userId && !auth.is_staff) return fail(res, 403, 'FORBIDDEN', 'Không có quyền');
    await database`DELETE FROM app_data WHERE collection='events' AND id=${eventDetail[1]}`;
    return json(res, 200, { success: true, message: 'Đã hủy sự kiện' });
  }

  const participantDetail = path.match(/^\/api\/event\/event-participants\/([^/]+)$/);
  if (participantDetail && method === 'DELETE') {
    const auth = currentUser(req, res);
    if (!auth) return;
    const result = await leaveEvent(database, auth.userId, participantDetail[1]);
    return json(res, 200, { success: true, ...result });
  }

  if (path === '/api/badge/badges' && method === 'POST') {
    const auth = await requireStaff(req, res, database);
    if (!auth) return;
    const body = (req.headers['content-type'] || '').includes('multipart/form-data')
      ? (await parseMultipart(req)).fields
      : await bodyJson(req);
    if (!body.name) return fail(res, 400, 'VALIDATION_ERROR', 'Tên huy hiệu bắt buộc');
    const badge = {
      id: String(body.id || `badge-${crypto.randomUUID()}`),
      name: String(body.name),
      description: String(body.description || ''),
      icon_url: String(body.icon_url || ''),
      category: String(body.category || 'general'),
    };
    await database`INSERT INTO app_data(collection,id,user_id,data) VALUES('badges',${badge.id},${auth.userId},${JSON.stringify(badge)}::jsonb)`;
    return json(res, 201, badge);
  }
  const badgeDelete = path.match(/^\/api\/badge\/badges\/([^/]+)$/);
  if (badgeDelete && method === 'DELETE') {
    const auth = await requireStaff(req, res, database);
    if (!auth) return;
    await database`DELETE FROM app_data WHERE collection='badges' AND id=${badgeDelete[1]}`;
    return json(res, 200, { success: true });
  }
  if (path === '/api/badge/user-badges' && method === 'POST') {
    const auth = await requireStaff(req, res, database);
    if (!auth) return;
    const body = (req.headers['content-type'] || '').includes('multipart/form-data')
      ? (await parseMultipart(req)).fields
      : await bodyJson(req);
    if (!body.user_id || !body.badge_id) return fail(res, 400, 'VALIDATION_ERROR', 'user_id và badge_id bắt buộc');
    const [badge] = await database`SELECT data FROM app_data WHERE collection='badges' AND id=${body.badge_id}`;
    if (!badge) return fail(res, 404, 'NOT_FOUND', 'Không tìm thấy huy hiệu');
    // Một huy hiệu duy nhất mỗi user/badge (idempotent)
    const item = {
      id: `ub-${body.user_id}-${body.badge_id}`,
      user_id: String(body.user_id),
      badge_id: String(body.badge_id),
      badge: badge.data,
      awarded_at: new Date().toISOString(),
    };
    const [inserted] = await database`INSERT INTO app_data(collection,id,user_id,data)
      VALUES('user_badges',${item.id},${item.user_id},${JSON.stringify(item)}::jsonb)
      ON CONFLICT (collection,id) DO NOTHING RETURNING id`;
    return json(res, inserted ? 201 : 200, item);
  }
  const userBadgeDelete = path.match(/^\/api\/badge\/user-badges\/([^/]+)$/);
  if (userBadgeDelete && method === 'DELETE') {
    const auth = await requireStaff(req, res, database);
    if (!auth) return;
    const [row] = await database`DELETE FROM app_data WHERE collection='user_badges' AND id=${userBadgeDelete[1]} RETURNING id`;
    return row ? json(res, 200, { success: true }) : fail(res, 404, 'NOT_FOUND', 'Không tìm thấy huy hiệu');
  }

  return false;
}

module.exports = { handleEventsAndRewards };
