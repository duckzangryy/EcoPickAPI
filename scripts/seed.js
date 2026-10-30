const { neon } = require('@neondatabase/serverless');

const rewards = [
  { id: 'ex-001', title: 'Một ly cà phê size vừa', description: 'Đổi một ly cà phê size vừa tại cửa hàng đối tác.', points_cost: 600, image_url: 'https://images.unsplash.com/photo-1514432324607-a09d9b4aefdd?w=400', sponsor: 'Highlands Coffee', category: 'beverage', available_quantity: 45 },
  { id: 'ex-002', title: 'Một chai nước suối', description: 'Nhận một chai nước suối tại điểm đổi quà đối tác.', points_cost: 150, image_url: 'https://images.unsplash.com/photo-1523362628745-0c100150b3a2?w=400', sponsor: 'Nhà tài trợ EcoPick', category: 'beverage', available_quantity: 80 },
  { id: 'ex-003', title: 'Voucher giảm 50.000đ', description: 'Voucher mua sắm thân thiện môi trường, dùng một lần.', points_cost: 1200, image_url: 'https://images.unsplash.com/photo-1544816155-12df9643f363?w=400', sponsor: 'EcoMart', category: 'voucher', available_quantity: 100 },
  { id: 'ex-004', title: 'Bình nước tái sử dụng', description: 'Bình nước dùng nhiều lần, giảm rác thải nhựa.', points_cost: 1500, image_url: 'https://images.unsplash.com/photo-1602143407151-7111542de6e8?w=400', sponsor: 'EcoPick', category: 'eco-product', available_quantity: 30 },
  { id: 'ex-005', title: 'Voucher đồ uống 30.000đ', description: 'Voucher đồ uống tại cửa hàng đối tác.', points_cost: 700, image_url: 'https://images.unsplash.com/photo-1551024709-8f23befc6f87?w=400', sponsor: 'Green Cafe', category: 'voucher', available_quantity: 60 },
  { id: 'ex-006', title: 'Túi vải thân thiện môi trường', description: 'Túi vải tái sử dụng thay túi nilon.', points_cost: 900, image_url: 'https://images.unsplash.com/photo-1590879239515-2b9e4f3e7d6d?w=400', sponsor: 'EcoPick', category: 'eco-product', available_quantity: 40 },
];

const events = [
  { id: 'evt-ecopick-cleanup-eakao', title: 'Chủ Nhật Xanh – Dọn rác hồ Ea Kao', description: 'Thu gom rác và phân loại tái chế quanh hồ Ea Kao.', type: 'clean up', start_date: '2026-11-01T07:00:00+07:00', end_date: '2026-11-01T10:00:00+07:00', latitude: 12.636, longitude: 108.038, location: 'Hồ Ea Kao', address: 'Buôn Ma Thuột, Đắk Lắk', max_paticipants: 50, current_paticipants: 0, equipment: 'Găng tay, bao rác', difficulty: 'easy', eco_point_reward: 50, status: 'upcoming', organizer_id: 'ecopick-demo' },
  { id: 'evt-ecopick-planting-buonmathuot', title: 'Trồng cây xanh Buôn Ma Thuột', description: 'Cùng trồng cây bản địa và chăm sóc không gian công cộng.', type: 'tree planting', start_date: '2026-11-08T06:30:00+07:00', end_date: '2026-11-08T09:30:00+07:00', latitude: 12.666, longitude: 108.038, location: 'Công viên Thành phố', address: 'Buôn Ma Thuột, Đắk Lắk', max_paticipants: 40, current_paticipants: 0, equipment: 'Găng tay, dụng cụ trồng cây', difficulty: 'easy', eco_point_reward: 60, status: 'upcoming', organizer_id: 'ecopick-demo' },
  { id: 'evt-ecopick-recycle-market', title: 'Ngày hội đổi rác lấy cây', description: 'Mang giấy, chai nhựa sạch đến đổi cây xanh.', type: 'recycling', start_date: '2026-11-15T08:00:00+07:00', end_date: '2026-11-15T11:00:00+07:00', latitude: 12.679, longitude: 108.044, location: 'Quảng trường 10/3', address: 'Buôn Ma Thuột, Đắk Lắk', max_paticipants: 100, current_paticipants: 0, equipment: 'Rác tái chế đã phân loại', difficulty: 'easy', eco_point_reward: 30, status: 'upcoming', organizer_id: 'ecopick-demo' },
  { id: 'evt-ecopick-cleanup-draysap', title: 'Làm sạch tuyến tham quan Dray Sap', description: 'Giữ gìn cảnh quan và thu gom rác dọc lối tham quan.', type: 'clean up', start_date: '2026-11-22T07:00:00+07:00', end_date: '2026-11-22T10:30:00+07:00', latitude: 12.526, longitude: 107.893, location: 'Thác Dray Sap', address: 'Krông Ana, Đắk Lắk', max_paticipants: 35, current_paticipants: 0, equipment: 'Găng tay, kẹp gắp rác', difficulty: 'medium', eco_point_reward: 70, status: 'upcoming', organizer_id: 'ecopick-demo' },
  { id: 'evt-ecopick-green-workshop', title: 'Workshop phân loại rác tại nguồn', description: 'Hướng dẫn phân loại rác và thực hành tái chế đơn giản.', type: 'workshop', start_date: '2026-11-29T08:30:00+07:00', end_date: '2026-11-29T11:00:00+07:00', latitude: 12.671, longitude: 108.052, location: 'Nhà văn hóa Thanh thiếu nhi', address: 'Buôn Ma Thuột, Đắk Lắk', max_paticipants: 60, current_paticipants: 0, equipment: 'Không yêu cầu', difficulty: 'easy', eco_point_reward: 25, status: 'upcoming', organizer_id: 'ecopick-demo' },
];

const badges = [
  { id: 'badge-first-report', name: 'Báo cáo đầu tiên', description: 'Gửi báo cáo rác đầu tiên.', icon_url: '', category: 'report' },
  { id: 'badge-green-volunteer', name: 'Tình nguyện xanh', description: 'Tham gia hoạt động cộng đồng.', icon_url: '', category: 'event' },
  { id: 'badge-eco-champion', name: 'Nhà vô địch xanh', description: 'Lan tỏa lối sống thân thiện với môi trường.', icon_url: '', category: 'eco' },
];

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const email = String(process.env.ADMIN_EMAIL || process.argv[2] || '').trim().toLowerCase();
  if (!email || !email.includes('@')) throw new Error('Pass the already-registered account email as ADMIN_EMAIL or argv[2]');
  const apply = process.argv.includes('--apply');
  const sql = neon(process.env.DATABASE_URL);
  const users = await sql`SELECT id,email,is_staff,role FROM users WHERE lower(email)=${email}`;
  if (users.length !== 1) throw new Error(`Expected exactly one existing user for ${email}; found ${users.length}`);
  const existingRewards = await sql`SELECT count(*)::int AS count FROM exchange_items WHERE id = ANY(${rewards.map((item) => item.id)})`;
  const existingEvents = await sql`SELECT count(*)::int AS count FROM app_data WHERE collection='events' AND id = ANY(${events.map((event) => event.id)})`;
  const existingBadges = await sql`SELECT count(*)::int AS count FROM app_data WHERE collection='badges' AND id = ANY(${badges.map((badge) => badge.id)})`;
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', user: { email: users[0].email, is_staff: users[0].is_staff }, planned: { rewards: rewards.length, events: events.length, badges: badges.length }, alreadyPresent: { rewards: existingRewards[0].count, events: existingEvents[0].count, badges: existingBadges[0].count } }));
  if (!apply) return;

  const [existingAdmin] = await sql`SELECT count(*)::int AS count FROM users WHERE is_staff=true`;
  if (users[0].is_staff !== true && existingAdmin.count > 0) {
    throw new Error(`Refusing promotion: another admin already exists (${existingAdmin.count}). Manually verify the target and admin policy first.`);
  }
  if (users[0].is_staff !== true) {
    const confirmation = String(process.env.CONFIRM_ADMIN_EMAIL || '').trim().toLowerCase();
    if (confirmation !== email) throw new Error('Set CONFIRM_ADMIN_EMAIL to the exact target email before promoting this account');
  }

  for (const item of rewards) {
    await sql`INSERT INTO exchange_items (id,title,description,points_cost,image_url,sponsor,category,available_quantity)
      VALUES (${item.id},${item.title},${item.description},${item.points_cost},${item.image_url},${item.sponsor},${item.category},${item.available_quantity})
      ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title,description=EXCLUDED.description,points_cost=EXCLUDED.points_cost,image_url=EXCLUDED.image_url,sponsor=EXCLUDED.sponsor,category=EXCLUDED.category`;
  }
  for (const event of events) {
    const record = { ...event, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    await sql`INSERT INTO app_data(collection,id,user_id,data) VALUES('events',${event.id},NULL,${JSON.stringify(record)}::jsonb)
      ON CONFLICT(collection,id) DO UPDATE SET data=app_data.data || EXCLUDED.data`;
  }
  for (const badge of badges) {
    await sql`INSERT INTO app_data(collection,id,user_id,data) VALUES('badges',${badge.id},NULL,${JSON.stringify(badge)}::jsonb)
      ON CONFLICT(collection,id) DO UPDATE SET data=EXCLUDED.data`;
  }
  const promoted = await sql`UPDATE users SET is_staff=true,role='{"id":"role-admin","name":"admin"}'::jsonb,updated_at=now() WHERE id=${users[0].id} AND lower(email)=${email} RETURNING email,is_staff,role`;
  if (promoted.length !== 1 || promoted[0].is_staff !== true) throw new Error('Admin promotion did not update exactly one account');
  console.log(JSON.stringify({ applied: true, promoted: { email: promoted[0].email, is_staff: promoted[0].is_staff, role: promoted[0].role }, seeded: { rewards: rewards.length, events: events.length, badges: badges.length } }));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
