CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  fullname text NOT NULL,
  username text UNIQUE NOT NULL,
  avatar text NOT NULL DEFAULT '',
  bio text NOT NULL DEFAULT '',
  role jsonb NOT NULL DEFAULT '{"id":"role-user","name":"user"}'::jsonb,
  level integer NOT NULL DEFAULT 1,
  eco_points integer NOT NULL DEFAULT 0 CHECK (eco_points >= 0),
  total_reports integer NOT NULL DEFAULT 0,
  total_events integer NOT NULL DEFAULT 0,
  total_trees integer NOT NULL DEFAULT 0,
  is_verified boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  is_staff boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS exchange_items (
  id text PRIMARY KEY,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  points_cost integer NOT NULL CHECK (points_cost > 0),
  image_url text NOT NULL DEFAULT '',
  sponsor text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT 'voucher',
  available_quantity integer CHECK (available_quantity IS NULL OR available_quantity >= 0),
  data jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS redemptions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  item_id text NOT NULL REFERENCES exchange_items(id),
  item_title text NOT NULL,
  item_image_url text NOT NULL DEFAULT '',
  sponsor text NOT NULL DEFAULT '',
  points_spent integer NOT NULL CHECK (points_spent > 0),
  code text UNIQUE NOT NULL,
  status text NOT NULL DEFAULT 'unused',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS redemptions_user_created_idx ON redemptions(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reports (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  address text NOT NULL DEFAULT '',
  severity text NOT NULL,
  waste_types jsonb NOT NULL DEFAULT '[]'::jsonb,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'reported',
  upvote_count integer NOT NULL DEFAULT 0,
  comment_count integer NOT NULL DEFAULT 0,
  photo_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reports_user_created_idx ON reports(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS point_logs (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  points integer NOT NULL,
  action text NOT NULL,
  reason text NOT NULL DEFAULT '',
  reference_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS point_logs_user_created_idx ON point_logs(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS app_data (
  collection text NOT NULL,
  id text NOT NULL,
  user_id text,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS app_data_collection_created_idx ON app_data(collection, created_at DESC);
CREATE INDEX IF NOT EXISTS app_data_user_idx ON app_data(collection, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS otps (
  email text PRIMARY KEY,
  otp text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE OR REPLACE FUNCTION ecopick_redeem(p_user_id text, p_item_id text, p_redemption_id text, p_code text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE u users%ROWTYPE; r exchange_items%ROWTYPE; result jsonb;
BEGIN
  SELECT * INTO u FROM users WHERE id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'USER_NOT_FOUND'; END IF;
  SELECT * INTO r FROM exchange_items WHERE id=p_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'REWARD_NOT_FOUND'; END IF;
  IF r.available_quantity IS NOT NULL AND r.available_quantity < 1 THEN RAISE EXCEPTION 'OUT_OF_STOCK'; END IF;
  IF u.eco_points < r.points_cost THEN RAISE EXCEPTION 'INSUFFICIENT_POINTS'; END IF;
  UPDATE users SET eco_points=eco_points-r.points_cost, updated_at=now() WHERE id=p_user_id RETURNING * INTO u;
  IF r.available_quantity IS NOT NULL THEN UPDATE exchange_items SET available_quantity=available_quantity-1 WHERE id=p_item_id; END IF;
  INSERT INTO redemptions (id,user_id,item_id,item_title,item_image_url,sponsor,points_spent,code,status)
    VALUES (p_redemption_id,p_user_id,r.id,r.title,r.image_url,r.sponsor,r.points_cost,p_code,'unused');
  INSERT INTO point_logs (id,user_id,points,action,reason,reference_id)
    VALUES ('pl-'||p_redemption_id,p_user_id,-r.points_cost,'reward_redeemed','Đổi quà: '||r.title,p_redemption_id);
  result := jsonb_build_object(
    'redemption', jsonb_build_object('id',p_redemption_id,'item_id',r.id,'item_title',r.title,'item_image_url',r.image_url,'sponsor',r.sponsor,'points_spent',r.points_cost,'code',p_code,'status','unused','created_at',now()),
    'newTotal',u.eco_points
  );
  RETURN result;
END;
$$;

-- Điểm báo cáo, tham gia/rời sự kiện được xử lý trong lib/helpers.js
-- (idempotent qua point_logs.id) để tránh phụ thuộc chữ ký hàm SQL khi deploy.


