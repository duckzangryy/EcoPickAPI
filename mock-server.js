/**
 * ============================================================
 * EcoPick Local Mock API Server (v1 REST API + Legacy Compat)
 * ============================================================
 * Triển khai theo tài liệu: 04-BACKEND-API.md
 * - Đầy đủ xác thực: register, login, verify-email, forgot-password, reset-password, refresh, logout
 * - Quản lý người dùng: /api/v1/users/me, stats, activity, badges, avatar, fcm-token
 * - Báo cáo rác: nearby geo query, upvote, claim, comments, presigned upload
 * - Sự kiện & Tour: events, join, check-in, participants
 * - Mạng xã hội: posts, feed, likes, comments, follow/unfollow
 * - Gamification: leaderboard, daily challenges, points history, badges
 * - Tương thích 100% ngược với các endpoint cũ: /api/users/signin/, /api/users/userinfo/, etc.
 * - Hỗ trợ CORS hoàn chỉnh cho Expo Web và Mobile
 * - Tự động đồng bộ vào mock-db.json
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPORT_POINTS = { low: 10, medium: 25, high: 50, critical: 75 };

function awardReportPoints(user, reportId, severity) {
  const points = REPORT_POINTS[severity] || REPORT_POINTS.medium;
  user.eco_points = (user.eco_points || 0) + points;
  user.total_reports = (user.total_reports || 0) + 1;
  db.point_logs = db.point_logs || [];
  db.point_logs.unshift({
    id: 'pl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    user_id: user.id,
    points,
    action: 'report_submitted',
    reason: `Gửi báo cáo rác (${severity})`,
    report_id: reportId,
    created_at: new Date().toISOString(),
  });
  return points;
}

const PORT = process.env.PORT || 8000;
const DB_FILE = path.join(__dirname, 'mock-db.json');
const DAKLAK_DIR = '/home/awsc/opendesign/mockups/daklak-map';
const LOCAL_DAKLAK_DIR = path.join(__dirname, 'daklak-map');
const DAKLAK_PHOTOS_FILE = path.join(DAKLAK_DIR, 'photos.json');
const LOCAL_PHOTOS_FILE = path.join(LOCAL_DAKLAK_DIR, 'photos.json');
const DAKLAK_INDEX_FILE = path.join(DAKLAK_DIR, 'index.html');
const LOCAL_INDEX_FILE = path.join(LOCAL_DAKLAK_DIR, 'index.html');

// ─── Dữ liệu khởi tạo ─────────────────────────────────────
const initialData = {
  users: [
    {
      id: "user-admin-local-001",
      email: "admin@ecopick.vn",
      password: "123456",
      fullname: "EcoPick Admin",
      full_name: "EcoPick Admin",
      username: "admin_ecopick",
      phone_number: "0987654321",
      address: "Quận 1, TP. Hồ Chí Minh",
      date_of_birth: "2000-01-01",
      avatar: "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=400",
      avatar_url: "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=400",
      bio: "Tình nguyện viên tích cực vì một Việt Nam xanh - sạch - đẹp 🌿",
      role: { id: "role-admin", name: "admin" },
      level: 5,
      eco_points: 1250,
      total_reports: 12,
      total_events: 8,
      total_trees: 25,
      followers_count: 142,
      follower_count: 142,
      following_count: 38,
      is_verified: true,
      is_active: true,
      is_staff: true,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-10-15T00:00:00.000Z",
    },
    {
      id: "user-volunteer-002",
      email: "volunteer@ecopick.vn",
      password: "123456",
      fullname: "Nguyễn Văn Xanh",
      full_name: "Nguyễn Văn Xanh",
      username: "nguyenvanxanh",
      phone_number: "0912345678",
      address: "Buôn Ma Thuột, Đắk Lắk",
      date_of_birth: "1998-05-15",
      avatar: "https://images.unsplash.com/photo-1570295999919-56ceb5ecca61?w=400",
      avatar_url: "https://images.unsplash.com/photo-1570295999919-56ceb5ecca61?w=400",
      bio: "Yêu thiên nhiên và bảo vệ môi trường cao nguyên",
      role: { id: "role-user", name: "user" },
      level: 3,
      eco_points: 620,
      total_reports: 5,
      total_events: 4,
      total_trees: 10,
      followers_count: 56,
      follower_count: 56,
      following_count: 22,
      is_verified: true,
      is_active: true,
      is_staff: false,
      created_at: "2026-02-15T00:00:00.000Z",
      updated_at: "2026-10-15T00:00:00.000Z",
    },
  ],
  roles: [
    { id: "role-admin", name: "admin" },
    { id: "role-organizer", name: "organizer" },
    { id: "role-moderator", name: "moderator" },
    { id: "role-user", name: "user" },
  ],
  otps: {
    "admin@ecopick.vn": { otp: "123456", expiresAt: Date.now() + 86400000 },
  },
  events: [
    {
      id: "evt-001",
      title: "Chủ Nhật Xanh: Dọn rác bờ hồ Ea Kao",
      description: "Chiến dịch làm sạch lòng hồ Ea Kao cùng các tình nguyện viên TP. Buôn Ma Thuột.",
      cover_image_url: "https://images.unsplash.com/photo-1542601906990-b4d3fb778b09?w=800&auto=format&fit=crop",
      type: "clean up",
      start_date: "15/10/2026 07:30:00",
      end_date: "15/10/2026 11:30:00",
      latitude: 12.605,
      longitude: 108.067,
      location: "Hồ Ea Kao",
      address: "Xã Ea Kao, TP. Buôn Ma Thuột, Đắk Lắk",
      max_paticipants: 50,
      current_paticipants: 32,
      equipment: "Găng tay bảo hộ, kẹp rác, túi rác tự huỷ, nước uống",
      difficulty: "medium",
      eco_point_reward: 100,
      status: "upcoming",
      created_at: "2026-10-01T08:00:00.000Z",
      updated_at: "2026-10-01T08:00:00.000Z",
      organizer_id: "user-admin-local-001",
    },
    {
      id: "evt-002",
      title: "Trồng 500 cây xanh chắn gió Buôn Đôn",
      description: "Hoạt động phủ xanh đồi trọc, bảo vệ nguồn nước và chống xói mòn đất.",
      cover_image_url: "https://images.unsplash.com/photo-1542601906990-b4d3fb778b09?w=800&auto=format&fit=crop",
      type: "tree planting",
      start_date: "20/10/2026 06:30:00",
      end_date: "20/10/2026 12:00:00",
      latitude: 12.898,
      longitude: 107.784,
      location: "Huyện Buôn Đôn",
      address: "Xã Krông Na, Huyện Buôn Đôn, Đắk Lắk",
      max_paticipants: 80,
      current_paticipants: 65,
      equipment: "Cuốc xẻng, cây giống, cọc chống",
      difficulty: "hard",
      eco_point_reward: 150,
      status: "upcoming",
      created_at: "2026-10-02T09:00:00.000Z",
      updated_at: "2026-10-02T09:00:00.000Z",
      organizer_id: "user-admin-local-001",
    },
  ],
  event_participants: [
    {
      id: "ep-001",
      event: "evt-001",
      user: "user-admin-local-001",
      status: "joined",
      joined_at: "2026-10-02T10:00:00.000Z",
      participant: {
        id: "user-admin-local-001",
        fullname: "EcoPick Admin",
        email: "admin@ecopick.vn",
        avatar: "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=400",
      },
    },
  ],
  tour_stops: [
    {
      id: "stop-001",
      event_id: "evt-001",
      name: "Trạm 1: Cổng chào Ea Kao",
      description: "Tập kết dụng cụ và chia tổ hành động",
      latitude: 12.605,
      longitude: 108.067,
      order_index: 1,
      goal: "Thu gom 20kg rác nhựa",
    },
  ],
  posts: [
    {
      id: "post-001",
      author_id: "user-admin-local-001",
      author: {
        id: "user-admin-local-001",
        fullname: "EcoPick Admin",
        avatar: "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=400",
      },
      content: "Chiến dịch dọn sạch bãi rác tự phát tại Buôn Ma Thuột sáng nay đã thành công tốt đẹp! Cảm ơn 25 bạn tình nguyện viên đã chung tay 💚 #GreenDakLak #EcoPick",
      media_urls: [
        "https://images.unsplash.com/photo-1532996122724-e3c354a0b15b?w=800&auto=format&fit=crop",
      ],
      likes_count: 38,
      comments_count: 5,
      created_at: "2026-10-03T11:00:00.000Z",
    },
  ],
  comments: [
    {
      id: "cmt-001",
      post_id: "post-001",
      user_id: "user-volunteer-002",
      user: {
        id: "user-volunteer-002",
        fullname: "Nguyễn Văn Xanh",
        avatar: "https://images.unsplash.com/photo-1570295999919-56ceb5ecca61?w=400",
      },
      content: "Hoạt động rất ý nghĩa, mong có thêm nhiều đợt nữa ạ!",
      created_at: "2026-10-03T12:00:00.000Z",
    },
  ],
  badges: [
    {
      id: "badge-001",
      name: "Tân binh Xanh",
      description: "Tham gia báo cáo điểm rác đầu tiên trên hệ thống",
      icon_url: "https://cdn-icons-png.flaticon.com/512/2583/2583344.png",
      category: "reporting",
    },
    {
      id: "badge-002",
      name: "Dũng sĩ Dọn rác",
      description: "Tham gia tối thiểu 5 sự kiện làm sạch môi trường",
      icon_url: "https://cdn-icons-png.flaticon.com/512/2583/2583319.png",
      category: "events",
    },
    {
      id: "badge-003",
      name: "Người Trồng Rừng",
      description: "Đóng góp trồng trên 20 cây xanh",
      icon_url: "https://cdn-icons-png.flaticon.com/512/620/620851.png",
      category: "special",
    },
  ],
  user_badges: [
    {
      id: "ub-001",
      user_id: "user-admin-local-001",
      badge_id: "badge-001",
      badge: {
        id: "badge-001",
        name: "Tân binh Xanh",
        description: "Tham gia báo cáo điểm rác đầu tiên trên hệ thống",
        icon_url: "https://cdn-icons-png.flaticon.com/512/2583/2583344.png",
        category: "reporting",
      },
      earned_at: "2026-09-15T08:00:00.000Z",
    },
    {
      id: "ub-002",
      user_id: "user-admin-local-001",
      badge_id: "badge-002",
      badge: {
        id: "badge-002",
        name: "Dũng sĩ Dọn rác",
        description: "Tham gia tối thiểu 5 sự kiện làm sạch môi trường",
        icon_url: "https://cdn-icons-png.flaticon.com/512/2583/2583319.png",
        category: "events",
      },
      earned_at: "2026-09-25T14:30:00.000Z",
    },
  ],
  exchange_items: [
    {
      id: "ex-001",
      title: "Một ly cà phê size vừa",
      description: "Đổi một ly cà phê size vừa tại cửa hàng đối tác.",
      points_cost: 300,
      image_url: "https://images.unsplash.com/photo-1514432324607-a09d9b4aefdd?w=400",
      sponsor: "Highlands Coffee",
      category: "beverage",
      available_quantity: 45,
    },
    {
      id: "ex-002",
      title: "Một chai nước suối",
      description: "Nhận một chai nước suối tại điểm đổi quà đối tác.",
      points_cost: 100,
      image_url: "https://images.unsplash.com/photo-1523362628745-0c100150b3a2?w=400",
      sponsor: "Nhà tài trợ EcoPick",
      category: "beverage",
      available_quantity: 80,
    },
    {
      id: "ex-003",
      title: "Voucher giảm 50.000đ",
      description: "Voucher mua sắm thân thiện môi trường, dùng một lần.",
      points_cost: 250,
      image_url: "https://images.unsplash.com/photo-1544816155-12df9643f363?w=400",
      sponsor: "EcoMart",
      category: "voucher",
      available_quantity: 100,
    },
  ],
  redemptions: [],
  conversations: [
    {
      id: "conv-001",
      name: "Tổ Dọn Rác Ea Kao",
      type: "group",
      last_message: "Mọi người có mặt đúng giờ nhé!",
      updated_at: "2026-10-04T07:00:00.000Z",
    },
  ],
  messages: [
    {
      id: "msg-001",
      conversation_id: "conv-001",
      sender_id: "user-admin-local-001",
      sender_name: "EcoPick Admin",
      sender_avatar: "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=400",
      text: "Mọi người có mặt đúng 7h30 sáng tại Cổng Hồ Ea Kao nhé!",
      created_at: "2026-10-04T07:00:00.000Z",
    },
  ],
  point_logs: [
    {
      id: "pl-001",
      user_id: "user-admin-local-001",
      points: 100,
      reason: "Báo cáo bãi rác đường Lê Duẩn",
      created_at: "2026-10-02T10:00:00.000Z",
    },
    {
      id: "pl-002",
      user_id: "user-admin-local-001",
      points: 150,
      reason: "Hoàn thành sự kiện Chủ Nhật Xanh",
      created_at: "2026-10-03T12:00:00.000Z",
    },
  ],
  notifications: [
    {
      id: "notif-001",
      user_id: "user-admin-local-001",
      type: "badge",
      title: "Huy hiệu mới!",
      body: "Chúc mừng bạn đã đạt huy hiệu Tân binh Xanh 🌿",
      data: { badgeId: "badge-001" },
      is_read: false,
      created_at: "2026-10-04T08:00:00.000Z",
    },
    {
      id: "notif-002",
      user_id: "user-admin-local-001",
      type: "event",
      title: "Nhắc nhở sự kiện sắp diễn ra",
      body: "Sự kiện Dọn rác bờ hồ Ea Kao sẽ diễn ra trong 24 giờ tới.",
      data: { eventId: "evt-001" },
      is_read: true,
      created_at: "2026-10-03T09:00:00.000Z",
    },
  ],
  challenges: [
    {
      id: "ch-001",
      title: "Báo cáo 1 điểm rác hôm nay",
      description: "Chụp ảnh và gửi tọa độ 1 điểm rác trong khu vực bạn sinh sống",
      reward_points: 50,
      target: 1,
      current: 1,
      is_completed: true,
    },
    {
      id: "ch-002",
      title: "Tham gia 1 sự kiện xanh",
      description: "Đăng ký tham gia một chiến dịch môi trường cuối tuần",
      reward_points: 100,
      target: 1,
      current: 0,
      is_completed: false,
    },
  ],
  reports: [
    {
      id: "rep-001",
      user_id: "user-admin-local-001",
      latitude: 12.6828,
      longitude: 108.0378,
      address: "123 Lê Duẩn, TP. Buôn Ma Thuột",
      severity: "heavy",
      waste_types: ["plastic", "organic"],
      description: "Đống rác nhựa và túi nilon tồn đọng ven đường gần chợ.",
      status: "reported",
      upvote_count: 8,
      comment_count: 3,
      photo_urls: [
        "https://images.unsplash.com/photo-1530587191325-3db32d826c18?w=800",
      ],
      created_at: "2026-10-03T09:15:00.000Z",
    },
    {
      id: "rep-002",
      user_id: "user-volunteer-002",
      latitude: 12.6712,
      longitude: 108.0456,
      address: "Đường Nguyễn Tất Thành, TP. Buôn Ma Thuột",
      severity: "medium",
      waste_types: ["plastic", "paper"],
      description: "Chai nhựa và ly giấy vương vãi trên thảm cỏ công viên.",
      status: "verified",
      upvote_count: 4,
      comment_count: 1,
      photo_urls: [
        "https://images.unsplash.com/photo-1618477461853-cf6ed80fbea5?w=800",
      ],
      created_at: "2026-10-04T14:20:00.000Z",
    },
  ],
  report_images: [
    {
      id: "img-001",
      report_id: "rep-001",
      image_url: "https://images.unsplash.com/photo-1530587191325-3db32d826c18?w=800",
      created_at: "2026-10-03T09:15:00.000Z",
    },
    {
      id: "img-002",
      report_id: "rep-002",
      image_url: "https://images.unsplash.com/photo-1618477461853-cf6ed80fbea5?w=800",
      created_at: "2026-10-04T14:20:00.000Z",
    },
  ],
};

// ─── Đọc/Ghi Database JSON ────────────────────────────────
function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const content = fs.readFileSync(DB_FILE, 'utf-8');
      const data = JSON.parse(content);
      // Đảm bảo các collection chính luôn tồn tại
      return {
        ...initialData,
        ...data,
        users: data.users && data.users.length ? data.users : initialData.users,
        otps: data.otps || initialData.otps,
        notifications: data.notifications || initialData.notifications,
        challenges: data.challenges || initialData.challenges,
        reports: data.reports || initialData.reports,
        report_images: data.report_images || initialData.report_images,
        exchange_items: (data.exchange_items || initialData.exchange_items).map((item) => ({
          ...item,
          points_cost: Number(item.points_cost ?? item.points_required ?? 0),
          available_quantity: item.available_quantity ?? item.available_count,
          sponsor: item.sponsor || item.sponsor_name || '',
        })),
        redemptions: data.redemptions || initialData.redemptions || [],
        point_logs: data.point_logs || initialData.point_logs || [],
      };
    }
  } catch (err) {
    console.error('Lỗi đọc mock-db.json, dùng initialData:', err.message);
  }
  return JSON.parse(JSON.stringify(initialData));
}

function saveDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Lỗi lưu mock-db.json:', err.message);
  }
}

function loadDaklakPhotos() {
  try {
    if (fs.existsSync(LOCAL_PHOTOS_FILE)) {
      return JSON.parse(fs.readFileSync(LOCAL_PHOTOS_FILE, 'utf-8'));
    }
    if (fs.existsSync(DAKLAK_PHOTOS_FILE)) {
      return JSON.parse(fs.readFileSync(DAKLAK_PHOTOS_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('Lỗi đọc photos.json:', err.message);
  }
  return [];
}

function saveDaklakPhotos(photos) {
  const json = JSON.stringify(photos, null, 2);
  try {
    if (!fs.existsSync(LOCAL_DAKLAK_DIR)) {
      fs.mkdirSync(LOCAL_DAKLAK_DIR, { recursive: true });
    }
    fs.writeFileSync(LOCAL_PHOTOS_FILE, json, 'utf-8');
  } catch (err) {
    console.error('Lỗi lưu LOCAL_PHOTOS_FILE:', err.message);
  }
  try {
    if (fs.existsSync(DAKLAK_DIR)) {
      fs.writeFileSync(DAKLAK_PHOTOS_FILE, json, 'utf-8');
    }
  } catch (err) {
    // Thư mục bên ngoài có thể read-only trong sandbox, bỏ qua lỗi
  }
}

let db = loadDB();

// ─── HTTP Utilities ───────────────────────────────────────
function sendJSON(res, data, statusCode = 200) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, X-Requested-With',
  });
  res.end(body);
}

function sendError(res, code, message, statusCode = 400, details = []) {
  return sendJSON(res, {
    success: false,
    error: {
      code,
      message,
      details,
    },
    detail: message, // legacy Django format compat
  }, statusCode);
}

function parseBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      if (buffer.length === 0) return resolve({});

      const contentType = req.headers['content-type'] || '';
      if (contentType.includes('application/json')) {
        try {
          return resolve(JSON.parse(buffer.toString('utf-8')));
        } catch (e) {
          return resolve({});
        }
      }

      if (contentType.includes('multipart/form-data')) {
        const fields = {};
        const raw = buffer.toString('binary');
        const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
        const boundary = boundaryMatch ? (boundaryMatch[1] || boundaryMatch[2]) : null;

        if (boundary) {
          const parts = raw.split('--' + boundary);
          for (const part of parts) {
            if (part.includes('Content-Disposition')) {
              const nameMatch = part.match(/name="([^"]+)"/);
              if (!nameMatch) continue;
              const fieldName = nameMatch[1];
              const filenameMatch = part.match(/filename="([^"]+)"/);

              const headerEnd = part.indexOf('\r\n\r\n');
              if (headerEnd !== -1) {
                let body = part.slice(headerEnd + 4);
                if (body.endsWith('\r\n')) body = body.slice(0, -2);

                if (filenameMatch || fieldName === 'image' || fieldName === 'report_img') {
                  if (body.length > 0) {
                    const fileBuf = Buffer.from(body, 'binary');
                    fields[fieldName] = {
                      filename: filenameMatch ? filenameMatch[1] : 'upload.jpg',
                      data: fileBuf,
                      base64: fileBuf.toString('base64'),
                      dataUri: `data:image/jpeg;base64,${fileBuf.toString('base64')}`
                    };
                  }
                } else {
                  fields[fieldName] = Buffer.from(body, 'binary').toString('utf-8').trim();
                }
              }
            }
          }
          return resolve(fields);
        }
      }

      try {
        const str = buffer.toString('utf-8');
        const params = new URLSearchParams(str);
        const obj = {};
        for (const [k, v] of params) obj[k] = v;
        if (Object.keys(obj).length > 0) return resolve(obj);
      } catch (e) {}

      resolve({});
    });
  });
}

function getUserFromToken(req, database) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token.startsWith('mock_jwt_')) {
      try {
        const email = Buffer.from(token.replace('mock_jwt_', ''), 'base64').toString('utf-8');
        const found = database.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
        if (found) return found;
      } catch (e) {}
    }
    const foundById = database.users.find((u) => token.includes(u.id) || (u.email && token.includes(u.email)));
    if (foundById) return foundById;
  }
  return database.users[0];
}

// ─── Request Handler ──────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost:8000'}`);
  const pathname = reqUrl.pathname;
  const method = req.method.toUpperCase();

  // Log request
  console.log(`[${new Date().toLocaleTimeString()}] ${method} ${pathname}`);

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, X-Requested-With',
    });
    return res.end();
  }

  // 1. Health check & Root
  if (pathname === '/' || pathname === '/health' || pathname === '/api/health' || pathname === '/api/v1/health') {
    return sendJSON(res, {
      success: true,
      ok: true,
      message: 'EcoPick Local Mock API Server (v1 REST) is running 🚀',
      version: '2.0.0',
      activeUsers: db.users.length,
      endpoints: {
        auth: ['/api/v1/auth/register', '/api/v1/auth/login', '/api/v1/auth/verify-email', '/api/v1/auth/forgot-password', '/api/v1/auth/reset-password', '/api/v1/auth/refresh', '/api/v1/auth/logout'],
        users: ['/api/v1/users/me', '/api/v1/users/:id/stats', '/api/v1/users/:id/activity', '/api/v1/users/:id/badges'],
        reports: ['/api/v1/reports', '/api/v1/reports/nearby'],
        events: ['/api/v1/events', '/api/v1/events/nearby'],
        gamification: ['/api/v1/badges', '/api/v1/leaderboard', '/api/v1/challenges/daily', '/api/v1/points/history'],
        notifications: ['/api/v1/notifications', '/api/v1/notifications/unread-count'],
        daklakMap: ['/opendesign/mockups/daklak-map/', '/api/photos', '/api/upload'],
      },
    });
  }

  // ============================================================
  // 1.1 DAK LAK MAP WEBPAGE & PHOTOS API
  // ============================================================

  // 1.1.1 Serve Map HTML: GET /opendesign/mockups/daklak-map/
  if (
    pathname === '/opendesign/mockups/daklak-map/' ||
    pathname === '/opendesign/mockups/daklak-map' ||
    pathname === '/opendesign/mockups/daklak-map/index.html'
  ) {
    let filePath = LOCAL_INDEX_FILE;
    if (!fs.existsSync(filePath)) {
      filePath = DAKLAK_INDEX_FILE;
    }
    if (fs.existsSync(filePath)) {
      const html = fs.readFileSync(filePath, 'utf-8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(html);
    }
    return sendError(res, 'NOT_FOUND', 'Dak Lak map index.html not found', 404);
  }

  // 1.1.2 GET /api/photos
  if (pathname === '/api/photos' && method === 'GET') {
    const photos = loadDaklakPhotos();
    return sendJSON(res, photos);
  }

  // 1.1.3 Upload photo: POST /api/upload
  if (pathname === '/api/upload' && method === 'POST') {
    const body = await parseBody(req);
    const user = getUserFromToken(req, db);

    // Xác định tên người đăng (yêu cầu: thay name = tên người up ảnh)
    let uploaderName = body.uploader || body.reporter_name || body.name || '';
    if (!uploaderName || /\.(jpe?g|png|webp|gif)$/i.test(uploaderName)) {
      uploaderName = user.fullname || user.full_name || user.username || 'EcoPick Volunteer';
    }

    const title = body.title || body.description || 'Báo cáo rác Đắk Lắk';
    const severity = REPORT_POINTS[body.severity] ? body.severity : 'medium';
    const userId = body.userid || body.reporter_id || user.email || user.id || 'admin@ecopick.vn';
    const lat = parseFloat(body.lat || body.latitude) || 12.6828;
    const lng = parseFloat(body.lng || body.longitude) || 108.0378;

    let thumb = 'https://images.unsplash.com/photo-1530587191325-3db32d826c18?w=800';
    if (body.image && body.image.dataUri) {
      thumb = body.image.dataUri;
    } else if (body.report_img && body.report_img.dataUri) {
      thumb = body.report_img.dataUri;
    }

    const newId = 'daklak_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4);
    const newPhoto = {
      id: newId,
      name: uploaderName,
      uploader: uploaderName,
      title: title,
      userid: userId,
      thumb: thumb,
      lat: lat,
      lng: lng,
      hasGps: true,
      outside: false,
      exif: {
        datetime: body.datetime || new Date().toLocaleString('vi-VN'),
        model: body.model || 'EcoPick App',
      },
      createdAt: Date.now(),
      source: 'app',
    };

    const photos = loadDaklakPhotos();
    photos.unshift(newPhoto);
    saveDaklakPhotos(photos);

    // Đồng bộ vào db.reports
    const newReport = {
      id: 'rep-' + newId,
      user_id: user.id,
      latitude: lat,
      longitude: lng,
      address: title,
      severity,
      waste_types: ['plastic'],
      description: title,
      status: 'reported',
      upvote_count: 0,
      comment_count: 0,
      photo_urls: [thumb],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    db.reports.unshift(newReport);
    const reportPoints = awardReportPoints(user, newReport.id, newReport.severity);
    saveDB(db);

    return sendJSON(res, {
      success: true,
      id: newId,
      pointsEarned: reportPoints,
      newTotal: user.eco_points,
      name: uploaderName,
      title: title,
      lat: lat,
      lng: lng,
      thumb: thumb,
      message: 'Upload ảnh thành công lên bản đồ Đắk Lắk',
    }, 201);
  }

  // 1.1.4 Delete photo: DELETE /api/photos/:id
  const photoDeleteMatch = pathname.match(/^\/api\/photos\/([^/]+)\/?$/);
  if (photoDeleteMatch && method === 'DELETE') {
    const photoId = decodeURIComponent(photoDeleteMatch[1]);
    let photos = loadDaklakPhotos();
    const beforeCount = photos.length;
    photos = photos.filter((p) => p.id !== photoId);
    if (photos.length !== beforeCount) {
      saveDaklakPhotos(photos);
    }
    db.reports = db.reports.filter((r) => r.id !== photoId && r.id !== 'rep-' + photoId);
    saveDB(db);
    return sendJSON(res, { success: true, message: 'Deleted photo' });
  }

  // ============================================================
  // 2. AUTHENTICATION (04-BACKEND-API.md Section 3.1)
  // ============================================================

  // 2.1 Register: POST /api/v1/auth/register hoặc /api/users/signup/
  if ((pathname === '/api/v1/auth/register' || pathname === '/api/users/signup/' || pathname === '/api/users/signup') && method === 'POST') {
    const body = await parseBody(req);
    const email = (body.email || '').trim().toLowerCase();
    const password = body.password || '';
    const fullName = body.fullName || body.fullname || (email ? email.split('@')[0] : 'Tình nguyện viên mới');
    const username = body.username || email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '') + '_' + Math.floor(Math.random() * 1000);

    if (!email) {
      return sendError(res, 'VALIDATION_ERROR', 'Email không được để trống', 400, [{ field: 'email', message: 'Required' }]);
    }
    if (!password || password.length < 6) {
      return sendError(res, 'VALIDATION_ERROR', 'Mật khẩu phải có ít nhất 6 ký tự', 400, [{ field: 'password', message: 'Min length 6' }]);
    }

    // Kiểm tra trùng email
    const exists = db.users.find((u) => u.email.toLowerCase() === email);
    if (exists) {
      return sendError(res, 'EMAIL_EXISTS', 'Email này đã được đăng ký trong hệ thống', 409);
    }

    const newUser = {
      id: 'user-' + Date.now(),
      email,
      password,
      fullname: fullName,
      full_name: fullName,
      username,
      phone_number: body.phone_number || body.phoneNumber || '',
      address: body.address || '',
      date_of_birth: body.date_of_birth || body.dateOfBirth || null,
      avatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=400',
      avatar_url: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=400',
      bio: body.bio || 'Người bảo vệ môi trường 🌿',
      role: { id: 'role-user', name: body.role || 'user' },
      level: 1,
      eco_points: 50,
      total_reports: 0,
      total_events: 0,
      total_trees: 0,
      followers_count: 0,
      follower_count: 0,
      following_count: 0,
      is_verified: false,
      is_active: true,
      is_staff: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    db.users.push(newUser);
    db.otps = db.otps || {};
    db.otps[email] = { otp: '123456', expiresAt: Date.now() + 15 * 60 * 1000 };
    saveDB(db);

    return sendJSON(res, {
      success: true,
      data: {
        user: newUser,
        message: 'Đăng ký thành công! Mã xác thực đã được gửi.',
        otp: '123456',
      },
      // Hỗ trợ legacy frontend
      id: newUser.id,
      email: newUser.email,
      message: 'Đăng ký thành công',
      otp: '123456',
    }, 201);
  }

  // 2.2 Login: POST /api/v1/auth/login hoặc /api/users/signin/
  if ((pathname === '/api/v1/auth/login' || pathname === '/api/users/signin/' || pathname === '/api/users/signin') && method === 'POST') {
    const body = await parseBody(req);
    const email = (body.email || '').trim().toLowerCase();
    const password = body.password || '';

    if (!email || !password) {
      return sendError(res, 'VALIDATION_ERROR', 'Vui lòng nhập đầy đủ email và mật khẩu', 400);
    }

    // Tìm kiếm user
    let user = db.users.find((u) => u.email.toLowerCase() === email);

    // Kiểm tra mật khẩu (nếu user tồn tại nhưng mật khẩu sai thì báo lỗi, nếu là tài khoản admin mặc định thì auto accept)
    if (user && user.password && user.password !== password && email !== 'admin@ecopick.vn') {
      return sendError(res, 'INVALID_CREDENTIALS', 'Email hoặc mật khẩu không chính xác', 401);
    }

    // Nếu không tìm thấy và là email admin thì tự động dùng admin
    if (!user && email === 'admin@ecopick.vn') {
      user = db.users[0];
    } else if (!user) {
      return sendError(res, 'USER_NOT_FOUND', 'Tài khoản không tồn tại. Vui lòng đăng ký.', 404);
    }

    const accessToken = 'mock_jwt_' + Buffer.from(email).toString('base64');
    const refreshToken = 'mock_refresh_' + Date.now();

    return sendJSON(res, {
      success: true,
      data: {
        user,
        accessToken,
        refreshToken,
        message: 'Đăng nhập thành công',
      },
      // Hỗ trợ legacy fields cho useSignIn hook
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: 86400 * 30,
      scope: 'read write',
      user,
    });
  }

  // 2.3 Verify Email: POST /api/v1/auth/verify-email
  if ((pathname === '/api/v1/auth/verify-email' || pathname === '/api/users/verify-email/' || pathname === '/api/users/verify-email') && method === 'POST') {
    const body = await parseBody(req);
    const email = (body.email || '').trim().toLowerCase();
    const otp = (body.otp || body.code || '').trim();

    const user = db.users.find((u) => u.email.toLowerCase() === email) || db.users[0];
    const storedOtp = db.otps?.[email]?.otp || '123456';

    if (otp === storedOtp || otp === '123456') {
      user.is_verified = true;
      user.updated_at = new Date().toISOString();
      saveDB(db);
      return sendJSON(res, {
        success: true,
        data: {
          message: 'Xác thực email thành công! Bạn có thể sử dụng ứng dụng ngay bây giờ.',
          user,
        },
      });
    }

    return sendError(res, 'INVALID_OTP', 'Mã xác thực không chính xác hoặc đã hết hạn', 400);
  }

  // 2.4 Forgot Password: POST /api/v1/auth/forgot-password
  if ((pathname === '/api/v1/auth/forgot-password' || pathname === '/api/users/forgot-password/' || pathname === '/api/users/forgot-password') && method === 'POST') {
    const body = await parseBody(req);
    const email = (body.email || '').trim().toLowerCase();

    const user = db.users.find((u) => u.email.toLowerCase() === email);
    if (!user) {
      return sendError(res, 'NOT_FOUND', 'Email không tồn tại trong hệ thống', 404);
    }

    db.otps = db.otps || {};
    db.otps[email] = { otp: '123456', expiresAt: Date.now() + 15 * 60 * 1000 };
    saveDB(db);

    return sendJSON(res, {
      success: true,
      data: {
        message: 'Mã xác nhận đặt lại mật khẩu đã được gửi đến email của bạn',
        email,
        otp: '123456',
        resetToken: 'mock_reset_' + Buffer.from(email).toString('base64'),
      },
    });
  }

  // 2.5 Reset Password: POST /api/v1/auth/reset-password
  if ((pathname === '/api/v1/auth/reset-password' || pathname === '/api/users/reset-password/' || pathname === '/api/users/reset-password') && method === 'POST') {
    const body = await parseBody(req);
    const email = (body.email || '').trim().toLowerCase();
    const newPassword = body.newPassword || body.new_password || body.password || '';
    const otp = (body.otp || body.token || body.resetToken || body.reset_token || body.code || '').trim();

    if (!newPassword || newPassword.length < 6) {
      return sendError(res, 'VALIDATION_ERROR', 'Mật khẩu mới phải có ít nhất 6 ký tự', 400);
    }

    const user = db.users.find((u) => u.email.toLowerCase() === email);
    if (!user) {
      return sendError(res, 'NOT_FOUND', 'Người dùng không tồn tại', 404);
    }

    user.password = newPassword;
    user.updated_at = new Date().toISOString();
    saveDB(db);

    return sendJSON(res, {
      success: true,
      data: {
        message: 'Đặt lại mật khẩu thành công! Bạn có thể đăng nhập bằng mật khẩu mới.',
      },
    });
  }

  // 2.6 Refresh Token: POST /api/v1/auth/refresh
  if ((pathname === '/api/v1/auth/refresh' || pathname === '/api/users/refresh/' || pathname === '/api/users/refresh') && method === 'POST') {
    const user = getUserFromToken(req, db);
    const newAccessToken = 'mock_jwt_' + Buffer.from(user.email).toString('base64');
    const newRefreshToken = 'mock_refresh_' + Date.now();

    return sendJSON(res, {
      success: true,
      data: {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
        expiresIn: 86400 * 30,
      },
      access_token: newAccessToken,
      refresh_token: newRefreshToken,
    });
  }

  // 2.7 Logout: POST /api/v1/auth/logout
  if ((pathname === '/api/v1/auth/logout' || pathname === '/api/users/logout/' || pathname === '/api/users/logout') && method === 'POST') {
    return sendJSON(res, {
      success: true,
      data: {
        message: 'Đăng xuất thành công',
      },
    });
  }

  // 2.8 Social Logins: POST /api/v1/auth/google & /api/v1/auth/apple
  if ((pathname === '/api/v1/auth/google' || pathname === '/api/v1/auth/apple') && method === 'POST') {
    const body = await parseBody(req);
    const email = (body.email || 'social_user@ecopick.vn').toLowerCase();
    let user = db.users.find((u) => u.email.toLowerCase() === email);
    if (!user) {
      user = {
        id: 'user-' + Date.now(),
        email,
        fullname: body.fullName || body.fullname || 'Google User',
        full_name: body.fullName || body.fullname || 'Google User',
        username: email.split('@')[0],
        avatar: body.avatarUrl || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=400',
        role: { id: 'role-user', name: 'user' },
        level: 1,
        eco_points: 50,
        total_reports: 0,
        total_events: 0,
        total_trees: 0,
        followers_count: 0,
        following_count: 0,
        is_verified: true,
        is_active: true,
        is_staff: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      db.users.push(user);
      saveDB(db);
    }
    const accessToken = 'mock_jwt_' + Buffer.from(email).toString('base64');
    return sendJSON(res, {
      success: true,
      data: {
        user,
        accessToken,
        refreshToken: 'mock_refresh_' + Date.now(),
      },
      access_token: accessToken,
      user,
    });
  }

  // ============================================================
  // 3. USER PROFILE (04-BACKEND-API.md Section 3.2)
  // ============================================================

  // 3.1 Get Profile: GET /api/v1/users/me & /api/users/userinfo/
  if ((pathname === '/api/v1/users/me' || pathname === '/api/users/userinfo/' || pathname === '/api/users/userinfo') && method === 'GET') {
    const currentUser = getUserFromToken(req, db);
    const stats = {
      totalReports: currentUser.total_reports || 0,
      totalEvents: currentUser.total_events || 0,
      treesPlanted: currentUser.total_trees || 0,
      followerCount: currentUser.followers_count || 0,
      followingCount: currentUser.following_count || 0,
    };
    return sendJSON(res, {
      success: true,
      data: {
        ...currentUser,
        stats,
      },
      // Legacy flat properties
      ...currentUser,
    });
  }

  // 3.2 Update Profile: PATCH /api/v1/users/me & /api/users/userinfo/
  if ((pathname === '/api/v1/users/me' || pathname === '/api/users/userinfo/' || pathname === '/api/users/userinfo') && (method === 'PATCH' || method === 'PUT')) {
    const currentUser = getUserFromToken(req, db);
    const body = await parseBody(req);
    const idx = db.users.findIndex((u) => u.id === currentUser.id);
    if (idx !== -1) {
      db.users[idx] = {
        ...db.users[idx],
        ...body,
        fullname: body.fullname || body.fullName || db.users[idx].fullname,
        full_name: body.fullName || body.fullname || db.users[idx].full_name,
        avatar: body.avatar || body.avatarUrl || db.users[idx].avatar,
        avatar_url: body.avatarUrl || body.avatar || db.users[idx].avatar_url,
        updated_at: new Date().toISOString(),
      };
      saveDB(db);
      return sendJSON(res, {
        success: true,
        data: db.users[idx],
        ...db.users[idx],
      });
    }
    return sendError(res, 'USER_NOT_FOUND', 'User not found', 404);
  }

  // 3.3 Delete Account (soft delete): DELETE /api/v1/users/me
  if (pathname === '/api/v1/users/me' && method === 'DELETE') {
    const currentUser = getUserFromToken(req, db);
    currentUser.is_active = false;
    saveDB(db);
    return sendJSON(res, {
      success: true,
      data: { message: 'Tài khoản đã được vô hiệu hóa thành công' },
    });
  }

  // 3.4 Upload Avatar: POST /api/v1/users/me/avatar
  if (pathname === '/api/v1/users/me/avatar' && method === 'POST') {
    const currentUser = getUserFromToken(req, db);
    const body = await parseBody(req);
    const avatarUrl = body.avatarUrl || body.avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=400';
    currentUser.avatar = avatarUrl;
    currentUser.avatar_url = avatarUrl;
    saveDB(db);
    return sendJSON(res, {
      success: true,
      data: { avatarUrl },
    });
  }

  // 3.5 FCM Token: POST /api/v1/users/me/fcm-token
  if (pathname === '/api/v1/users/me/fcm-token' && method === 'POST') {
    const currentUser = getUserFromToken(req, db);
    const body = await parseBody(req);
    currentUser.fcm_token = body.fcmToken || body.fcm_token || '';
    saveDB(db);
    return sendJSON(res, {
      success: true,
      data: { message: 'Đã cập nhật token thông báo' },
    });
  }

  // 3.6 User Stats: GET /api/v1/users/:id/stats
  const statsMatch = pathname.match(/^\/api\/v1\/users\/([^/]+)\/stats\/?$/);
  if (statsMatch && method === 'GET') {
    const uid = statsMatch[1];
    const user = uid === 'me' ? getUserFromToken(req, db) : (db.users.find((u) => u.id === uid) || db.users[0]);
    return sendJSON(res, {
      success: true,
      data: {
        totalReports: user.total_reports || 0,
        totalEvents: user.total_events || 0,
        treesPlanted: user.total_trees || 0,
        ecoPoints: user.eco_points || 0,
        level: user.level || 1,
        followerCount: user.followers_count || 0,
        followingCount: user.following_count || 0,
        streakDays: 7,
        rank: 3,
      },
    });
  }

  // 3.7 User Activity: GET /api/v1/users/:id/activity
  const activityMatch = pathname.match(/^\/api\/v1\/users\/([^/]+)\/activity\/?$/);
  if (activityMatch && method === 'GET') {
    return sendJSON(res, {
      success: true,
      data: [
        { id: 'act-1', type: 'report', title: 'Báo cáo điểm rác tại Hồ Ea Kao', time: '2 giờ trước' },
        { id: 'act-2', type: 'event', title: 'Tham gia chiến dịch Chủ Nhật Xanh', time: '1 ngày trước' },
        { id: 'act-3', type: 'badge', title: 'Đạt huy hiệu Tân binh Xanh', time: '3 ngày trước' },
        { id: 'act-4', type: 'tree', title: 'Trồng cây xanh tại Huyện Buôn Đôn', time: '1 tuần trước' },
      ],
    });
  }

  // 3.8 User Badges: GET /api/v1/users/:id/badges
  const userBadgesMatch = pathname.match(/^\/api\/v1\/users\/([^/]+)\/badges\/?$/);
  if (userBadgesMatch && method === 'GET') {
    const uid = userBadgesMatch[1];
    const targetId = uid === 'me' ? getUserFromToken(req, db).id : uid;
    const badges = db.user_badges.filter((b) => b.user_id === targetId);
    return sendJSON(res, {
      success: true,
      data: badges.length ? badges : db.user_badges,
    });
  }

  // 3.9 Follow User: POST & DELETE /api/v1/users/:id/follow
  const followMatch = pathname.match(/^\/api\/v1\/users\/([^/]+)\/follow\/?$/);
  if (followMatch) {
    if (method === 'POST') {
      return sendJSON(res, { success: true, data: { isFollowing: true, message: 'Đã theo dõi' } });
    }
    if (method === 'DELETE') {
      return sendJSON(res, { success: true, data: { isFollowing: false, message: 'Đã bỏ theo dõi' } });
    }
  }

  // 3.10 Users List & Detail: GET /api/users/ & GET /api/users/:id
  if ((pathname === '/api/users/' || pathname === '/api/users' || pathname === '/api/v1/users') && method === 'GET') {
    return sendJSON(res, db.users);
  }
  const userMatch = pathname.match(/^\/api\/(?:v1\/)?users\/([^/]+)\/?$/);
  if (userMatch) {
    const uid = userMatch[1];
    if (uid !== 'me') {
      const user = db.users.find((u) => u.id === uid) || db.users[0];
      if (method === 'GET') return sendJSON(res, user);
      if (method === 'PATCH' || method === 'PUT') {
        const body = await parseBody(req);
        const idx = db.users.findIndex((u) => u.id === uid);
        if (idx !== -1) {
          db.users[idx] = { ...db.users[idx], ...body };
          saveDB(db);
          return sendJSON(res, db.users[idx]);
        }
        return sendJSON(res, user);
      }
    }
  }

  // ============================================================
  // 4. REPORTS & UPLOADS (04-BACKEND-API.md Section 3.3 & 3.11)
  // ============================================================

  // 4.1 Presigned Upload: POST /api/v1/uploads/presigned
  if (pathname === '/api/v1/uploads/presigned' && method === 'POST') {
    const body = await parseBody(req);
    const category = body.category || 'report';
    const ext = body.fileType === 'image/png' ? 'png' : 'jpg';
    const fileKey = `uploads/${category}/${Date.now()}.${ext}`;
    return sendJSON(res, {
      success: true,
      data: {
        uploadUrl: `http://localhost:${PORT}/api/v1/uploads/mock-upload`,
        fileKey,
        publicUrl: `https://images.unsplash.com/photo-1542601906990-b4d3fb778b09?w=800`,
        expiresIn: 3600,
      },
    });
  }

  // Mock direct upload receiver
  if (pathname === '/api/v1/uploads/mock-upload') {
    return sendJSON(res, { success: true, message: 'Upload succeeded' });
  }

  // 4.2 Nearby Reports: GET /api/v1/reports/nearby
  if (pathname === '/api/v1/reports/nearby' && method === 'GET') {
    const reportsWithDistance = db.reports.map((r, i) => ({
      ...r,
      distance: Number((0.5 + i * 0.7).toFixed(1)),
      reportedBy: {
        id: db.users[0].id,
        fullName: db.users[0].fullname,
        avatarUrl: db.users[0].avatar,
      },
    }));
    return sendJSON(res, {
      success: true,
      data: {
        reports: reportsWithDistance,
        pagination: { page: 1, limit: 50, total: reportsWithDistance.length, totalPages: 1 },
      },
    });
  }

  // 4.3 Reports List & Create: GET & POST /api/v1/reports & /api/report/reports/
  if ((pathname === '/api/v1/reports' || pathname === '/api/report/reports/' || pathname === '/api/report/reports') && method === 'GET') {
    if (pathname.includes('/v1/')) {
      return sendJSON(res, {
        success: true,
        data: db.reports,
        results: db.reports, // legacy format
      });
    }
    return sendJSON(res, db.reports);
  }
  if ((pathname === '/api/v1/reports' || pathname === '/api/report/reports/' || pathname === '/api/report/reports') && method === 'POST') {
    const body = await parseBody(req);
    const user = getUserFromToken(req, db);
    const newReport = {
      id: 'rep-' + Date.now(),
      user_id: user.id,
      latitude: parseFloat(body.latitude) || 12.6828,
      longitude: parseFloat(body.longitude) || 108.0378,
      address: body.address || 'Đắk Lắk, Việt Nam',
      severity: REPORT_POINTS[body.severity] ? body.severity : 'medium',
      waste_types: Array.isArray(body.wasteTypes || body.waste_types) ? (body.wasteTypes || body.waste_types) : ['plastic'],
      description: body.description || '',
      status: 'reported',
      upvote_count: 0,
      comment_count: 0,
      photo_urls: body.photoKeys || body.photo_urls || ['https://images.unsplash.com/photo-1530587191325-3db32d826c18?w=800'],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    db.reports.unshift(newReport);
    const pointsEarned = awardReportPoints(user, newReport.id, newReport.severity);
    saveDB(db);
    return sendJSON(res, {
      success: true,
      data: {
        report: newReport,
        pointsEarned,
        newTotal: user.eco_points,
      },
      ...newReport,
      pointsEarned,
      newTotal: user.eco_points,
    }, 201);
  }

  // 4.4 Report Upvote: POST & DELETE /api/v1/reports/:id/upvote
  const upvoteMatch = pathname.match(/^\/api\/v1\/reports\/([^/]+)\/upvote\/?$/);
  if (upvoteMatch) {
    const rid = upvoteMatch[1];
    const rep = db.reports.find((r) => r.id === rid);
    if (rep) {
      if (method === 'POST') rep.upvote_count = (rep.upvote_count || 0) + 1;
      if (method === 'DELETE') rep.upvote_count = Math.max(0, (rep.upvote_count || 1) - 1);
      saveDB(db);
      return sendJSON(res, { success: true, data: { upvoteCount: rep.upvote_count } });
    }
    return sendError(res, 'NOT_FOUND', 'Report not found', 404);
  }

  // 4.5 Claim Cleanup Task: POST /api/v1/reports/:id/claim
  const claimMatch = pathname.match(/^\/api\/v1\/reports\/([^/]+)\/claim\/?$/);
  if (claimMatch && method === 'POST') {
    const rid = claimMatch[1];
    const rep = db.reports.find((r) => r.id === rid);
    if (rep) {
      rep.status = 'in_progress';
      rep.cleaned_by = getUserFromToken(req, db).id;
      saveDB(db);
      return sendJSON(res, { success: true, data: { report: rep, message: 'Đã nhận nhiệm vụ dọn dẹp!' } });
    }
  }

  // 4.6 Report Images: GET & POST /api/report/report-images/ & /api/report-images/
  if ((pathname === '/api/report/report-images/' || pathname === '/api/report/report-images' || pathname === '/api/report-images/' || pathname === '/api/report-images') && method === 'GET') {
    return sendJSON(res, db.report_images || []);
  }
  if ((pathname === '/api/report/report-images/' || pathname === '/api/report/report-images' || pathname === '/api/report-images/' || pathname === '/api/report-images') && method === 'POST') {
    const body = await parseBody(req);
    const newImg = {
      id: 'img-' + Date.now(),
      report_id: body.report_id || body.report || '',
      image_url: body.image_url || 'https://images.unsplash.com/photo-1530587191325-3db32d826c18?w=800',
      created_at: new Date().toISOString(),
    };
    db.report_images = db.report_images || [];
    db.report_images.push(newImg);
    saveDB(db);
    return sendJSON(res, newImg, 201);
  }
  const reportImageMatch = pathname.match(/^\/api\/(?:report\/)?report-images\/([^/]+)\/?$/);
  if (reportImageMatch && method === 'DELETE') {
    const imgId = reportImageMatch[1];
    db.report_images = (db.report_images || []).filter((img) => img.id !== imgId);
    saveDB(db);
    return sendJSON(res, { success: true, message: 'Deleted image' });
  }

  // ============================================================
  // 5. EVENTS & TOURS (04-BACKEND-API.md Section 3.4 & 3.5)
  // ============================================================

  if ((pathname === '/api/v1/events' || pathname === '/api/event/events/' || pathname === '/api/event/events') && method === 'GET') {
    if (pathname.includes('/v1/')) {
      return sendJSON(res, {
        success: true,
        data: { events: db.events, pagination: { page: 1, limit: 20, total: db.events.length } },
        events: db.events,
      });
    }
    return sendJSON(res, db.events);
  }
  if ((pathname === '/api/v1/events' || pathname === '/api/event/events/' || pathname === '/api/event/events') && method === 'POST') {
    const body = await parseBody(req);
    const newEvent = {
      id: 'evt-' + Date.now(),
      title: body.title || 'Sự kiện môi trường mới',
      description: body.description || '',
      cover_image_url: body.cover_image_url || body.coverImageUrl || 'https://images.unsplash.com/photo-1542601906990-b4d3fb778b09?w=800',
      type: body.type || 'clean up',
      start_date: body.start_date || body.startDate || new Date().toISOString(),
      end_date: body.end_date || body.endDate || new Date().toISOString(),
      latitude: parseFloat(body.latitude) || 12.6828,
      longitude: parseFloat(body.longitude) || 108.0378,
      location: body.location || 'Tỉnh Đắk Lắk',
      address: body.address || 'Đắk Lắk, Việt Nam',
      max_participants: parseInt(body.max_participants || body.max_paticipants) || 50,
      current_participants: 1,
      equipment: body.equipment || ['Găng tay', 'Bao rác'],
      difficulty: body.difficulty || 'medium',
      eco_point_reward: parseInt(body.eco_point_reward || body.ecoPointsReward) || 100,
      status: 'upcoming',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      organizer_id: getUserFromToken(req, db).id,
    };
    db.events.unshift(newEvent);
    saveDB(db);
    return sendJSON(res, { success: true, data: newEvent, ...newEvent }, 201);
  }

  // Event Detail: GET /api/v1/events/:id
  const eventMatch = pathname.match(/^\/api\/(?:v1\/)?(?:event\/)?events\/([^/]+)\/?$/);
  if (eventMatch) {
    const eid = eventMatch[1];
    const found = db.events.find((e) => e.id === eid);
    if (method === 'GET') {
      if (found) return sendJSON(res, { success: true, data: found, ...found });
      return sendError(res, 'NOT_FOUND', 'Event not found', 404);
    }
    if (method === 'DELETE') {
      db.events = db.events.filter((e) => e.id !== eid);
      saveDB(db);
      return sendJSON(res, { success: true, message: 'Đã hủy sự kiện' });
    }
  }

  // Join Event: POST /api/v1/events/:id/join
  const joinMatch = pathname.match(/^\/api\/v1\/events\/([^/]+)\/join\/?$/);
  if (joinMatch && method === 'POST') {
    const eid = joinMatch[1];
    const user = getUserFromToken(req, db);
    const existing = db.event_participants.find((p) => p.event === eid && p.user === user.id);
    if (!existing) {
      db.event_participants.push({
        id: 'ep-' + Date.now(),
        event: eid,
        user: user.id,
        status: 'joined',
        joined_at: new Date().toISOString(),
      });
      saveDB(db);
    }
    return sendJSON(res, { success: true, data: { message: 'Đã tham gia sự kiện thành công!' } });
  }

  // Event Participants: GET /api/event/event-participants/
  if (pathname === '/api/event/event-participants/' || pathname === '/api/event/event-participants') {
    return sendJSON(res, db.event_participants);
  }

  // Tour Stops: GET /api/event/tour-stops/
  if (pathname === '/api/event/tour-stops/' || pathname === '/api/event/tour-stops') {
    return sendJSON(res, db.tour_stops);
  }

  // ============================================================
  // 6. SOCIAL & POSTS (04-BACKEND-API.md Section 3.6)
  // ============================================================

  if ((pathname === '/api/v1/posts' || pathname === '/api/v1/feed' || pathname === '/api/post/posts/' || pathname === '/api/post/posts') && method === 'GET') {
    if (pathname.includes('/v1/')) {
      return sendJSON(res, {
        success: true,
        data: db.posts,
        results: db.posts, // legacy
      });
    }
    return sendJSON(res, db.posts);
  }
  if ((pathname === '/api/v1/posts' || pathname === '/api/post/posts/' || pathname === '/api/post/posts') && method === 'POST') {
    const body = await parseBody(req);
    const user = getUserFromToken(req, db);
    const newPost = {
      id: 'post-' + Date.now(),
      author_id: user.id,
      author: {
        id: user.id,
        fullname: user.fullname,
        avatar: user.avatar,
      },
      content: body.content || '',
      media_urls: body.media_urls || body.mediaUrls || [],
      likes_count: 0,
      comments_count: 0,
      created_at: new Date().toISOString(),
    };
    db.posts.unshift(newPost);
    saveDB(db);
    return sendJSON(res, { success: true, data: newPost, ...newPost }, 201);
  }

  // Comments: GET & POST /api/post/comments/
  if (pathname === '/api/post/comments/' || pathname === '/api/post/comments') {
    if (method === 'GET') {
      const postId = reqUrl.searchParams.get('post');
      const list = postId ? db.comments.filter((c) => c.post_id === postId) : db.comments;
      return sendJSON(res, list);
    }
    if (method === 'POST') {
      const body = await parseBody(req);
      const user = getUserFromToken(req, db);
      const newCmt = {
        id: 'cmt-' + Date.now(),
        post_id: body.post || body.post_id,
        user_id: user.id,
        user: { id: user.id, fullname: user.fullname, avatar: user.avatar },
        content: body.content || '',
        created_at: new Date().toISOString(),
      };
      db.comments.push(newCmt);
      saveDB(db);
      return sendJSON(res, newCmt, 201);
    }
  }

  // Like: POST /api/post/likes/
  if (pathname === '/api/post/likes/' || pathname === '/api/post/likes') {
    return sendJSON(res, { ok: true, liked: true });
  }

  // ============================================================
  // 7. GAMIFICATION & LEADERBOARD (04-BACKEND-API.md Section 3.9)
  // ============================================================

  // Badges
  if (pathname === '/api/v1/badges' || pathname === '/api/badge/badges/' || pathname === '/api/badge/badges') {
    if (pathname.includes('/v1/')) {
      return sendJSON(res, { success: true, data: db.badges, badges: db.badges });
    }
    return sendJSON(res, db.badges);
  }
  if (pathname === '/api/badge/user-badges/' || pathname === '/api/badge/user-badges') {
    return sendJSON(res, db.user_badges);
  }
  if ((pathname === '/api/badge/exchange-items/' || pathname === '/api/badge/exchange-items') && method === 'GET') {
    return sendJSON(res, db.exchange_items || []);
  }

  if ((pathname === '/api/badge/redemptions/' || pathname === '/api/badge/redemptions') && method === 'GET') {
    const authHeader = req.headers['authorization'] || '';
    if (!authHeader.startsWith('Bearer ')) return sendError(res, 'UNAUTHORIZED', 'Vui lòng đăng nhập để xem quà đã đổi', 401);
    const user = getUserFromToken(req, db);
    const redemptions = (db.redemptions || []).filter((redemption) => redemption.user_id === user.id);
    const items = redemptions.map((redemption) => {
      const item = (db.exchange_items || []).find((entry) => entry.id === redemption.item_id);
      return { ...redemption, item_title: redemption.item_title || item?.title || 'Phần thưởng EcoPick', item_image_url: redemption.item_image_url || item?.image_url || '', sponsor: redemption.sponsor || item?.sponsor || '' };
    });
    return sendJSON(res, items);
  }

  const redemptionDetailMatch = pathname.match(/^\/api\/badge\/redemptions\/([^/]+)\/?$/);
  if (redemptionDetailMatch && method === 'GET') {
    const authHeader = req.headers['authorization'] || '';
    if (!authHeader.startsWith('Bearer ')) return sendError(res, 'UNAUTHORIZED', 'Vui lòng đăng nhập để xem mã đổi quà', 401);
    const user = getUserFromToken(req, db);
    const redemption = (db.redemptions || []).find((entry) => entry.id === redemptionDetailMatch[1] && entry.user_id === user.id);
    if (!redemption) return sendError(res, 'NOT_FOUND', 'Không tìm thấy phần thưởng đã đổi', 404);
    const item = (db.exchange_items || []).find((entry) => entry.id === redemption.item_id);
    return sendJSON(res, { ...redemption, item_title: redemption.item_title || item?.title || 'Phần thưởng EcoPick', item_image_url: redemption.item_image_url || item?.image_url || '', sponsor: redemption.sponsor || item?.sponsor || '' });
  }

  const redeemMatch = pathname.match(/^\/api\/badge\/exchange-items\/([^/]+)\/redeem\/?$/);
  if (redeemMatch && method === 'POST') {
    const authHeader = req.headers['authorization'] || '';
    if (!authHeader.startsWith('Bearer ')) return sendError(res, 'UNAUTHORIZED', 'Vui lòng đăng nhập để đổi quà', 401);
    const user = getUserFromToken(req, db);
    const item = (db.exchange_items || []).find((reward) => reward.id === redeemMatch[1]);
    if (!item) return sendError(res, 'REWARD_NOT_FOUND', 'Quà tặng không tồn tại', 404);

    const cost = Number(item.points_cost);
    const stock = Number(item.available_quantity);
    if (!Number.isFinite(cost) || cost <= 0) return sendError(res, 'INVALID_REWARD', 'Quà tặng chưa có giá điểm hợp lệ', 400);
    if (Number.isFinite(stock) && stock <= 0) return sendError(res, 'OUT_OF_STOCK', 'Quà tặng đã hết', 409);
    if ((user.eco_points || 0) < cost) return sendError(res, 'INSUFFICIENT_POINTS', 'Bạn chưa đủ EcoPoints để đổi quà', 409);

    user.eco_points -= cost;
    if (Number.isFinite(stock)) item.available_quantity = stock - 1;
    const redemption = {
      id: 'red-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      user_id: user.id,
      item_id: item.id,
      item_title: item.title,
      item_image_url: item.image_url || '',
      sponsor: item.sponsor || '',
      points_spent: cost,
      code: `ECO-${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
      status: 'unused',
      created_at: new Date().toISOString(),
    };
    db.redemptions = db.redemptions || [];
    db.redemptions.unshift(redemption);
    db.point_logs = db.point_logs || [];
    db.point_logs.unshift({
      id: 'pl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      user_id: user.id,
      points: -cost,
      action: 'reward_redeemed',
      reason: `Đổi quà: ${item.title}`,
      redemption_id: redemption.id,
      created_at: redemption.created_at,
    });
    saveDB(db);
    return sendJSON(res, { success: true, data: { redemption, newTotal: user.eco_points } }, 201);
  }

  // Leaderboard: GET /api/v1/leaderboard
  if (pathname === '/api/v1/leaderboard' && method === 'GET') {
    const sortedUsers = [...db.users]
      .sort((a, b) => (b.eco_points || 0) - (a.eco_points || 0))
      .map((u, index) => ({
        rank: index + 1,
        id: u.id,
        fullName: u.fullname,
        avatarUrl: u.avatar,
        ecoPoints: u.eco_points || 0,
        level: u.level || 1,
        reportsCount: u.total_reports || 0,
      }));
    return sendJSON(res, { success: true, data: { leaderboard: sortedUsers } });
  }

  // Daily Challenges: GET /api/v1/challenges/daily
  if (pathname === '/api/v1/challenges/daily' && method === 'GET') {
    return sendJSON(res, { success: true, data: { challenges: db.challenges } });
  }

  // Points History: GET /api/v1/points/history & /api/chat/point-logs/
  if (pathname === '/api/v1/points/history' || pathname === '/api/chat/point-logs/' || pathname === '/api/chat/point-logs') {
    return sendJSON(res, { success: true, data: db.point_logs, results: db.point_logs });
  }

  // ============================================================
  // 8. NOTIFICATIONS (04-BACKEND-API.md Section 3.10)
  // ============================================================

  if (pathname === '/api/v1/notifications' && method === 'GET') {
    return sendJSON(res, {
      success: true,
      data: {
        notifications: db.notifications,
        pagination: { page: 1, limit: 20, total: db.notifications.length },
      },
    });
  }
  if (pathname === '/api/v1/notifications/unread-count' && method === 'GET') {
    const unread = db.notifications.filter((n) => !n.is_read).length;
    return sendJSON(res, { success: true, data: { count: unread } });
  }
  if (pathname === '/api/v1/notifications/read-all' && (method === 'PATCH' || method === 'POST')) {
    db.notifications.forEach((n) => (n.is_read = true));
    saveDB(db);
    return sendJSON(res, { success: true, data: { message: 'Đã đánh dấu tất cả đã đọc' } });
  }

  // ============================================================
  // 9. CHAT (04-BACKEND-API.md Section 3.7)
  // ============================================================

  if (pathname === '/api/v1/conversations' || pathname === '/api/chat/conversations/' || pathname === '/api/chat/conversations') {
    return sendJSON(res, db.conversations);
  }
  if (pathname === '/api/chat/messages/' || pathname === '/api/chat/messages') {
    if (method === 'GET') return sendJSON(res, db.messages);
    if (method === 'POST') {
      const body = await parseBody(req);
      const user = getUserFromToken(req, db);
      const newMsg = {
        id: 'msg-' + Date.now(),
        conversation_id: body.conversation_id || 'conv-001',
        sender_id: user.id,
        sender_name: user.fullname,
        sender_avatar: user.avatar,
        text: body.text || '',
        created_at: new Date().toISOString(),
      };
      db.messages.push(newMsg);
      saveDB(db);
      return sendJSON(res, newMsg, 201);
    }
  }

  // Roles: GET /api/roles/
  if (pathname === '/api/roles/' || pathname === '/api/roles') {
    return sendJSON(res, db.roles);
  }

  // Fallback 404
  return sendError(res, 'NOT_FOUND', `Endpoint ${method} ${pathname} not found`, 404);
});

// ─── Khởi động Server ─────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log('======================================================');
  console.log(`🌿 EcoPick Mock API Server (v1 REST API) đang chạy tại:`);
  console.log(`👉 http://localhost:${PORT}`);
  console.log(`👉 http://127.0.0.1:${PORT}`);
  console.log(`📄 Database lưu tại: ${DB_FILE}`);
  console.log('======================================================');
});
