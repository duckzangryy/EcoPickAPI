# EcoPick API + Đắk Lắk map on Vercel

Vercel project root: `vercel-api/`. Expo mobile app stays a separate client. Native map uses `react-native-maps`; the browser map is a Leaflet page hosted at `/opendesign/mockups/daklak-map/` on this deployment.

## Production services

- Neon Postgres: users, reports, reward redemption, points, app collections (`app_data`).
- Vercel Blob: public uploaded report images. `BLOB_STORE_ID` OIDC or `BLOB_READ_WRITE_TOKEN`.
- Set `DATABASE_URL`, `JWT_SECRET` (random, >=32 bytes), `CORS_ORIGIN`, `CRON_SECRET` in Vercel project environment. Keep secrets out of git and archives. `CRON_SECRET` is what Vercel sends to the daily `/api/cron/cleanup` job.
- Schema: `psql "$DATABASE_URL" -f db/schema.sql`; seed sample rewards: `npm run db:seed`.

## Deploy

Project is configured to use root `vercel-api`. Deploy from that project root:

```bash
npm install
npx vercel --prod
```

Vercel serves `/api/*` through `api/index.js`; `vercel.json` preserves legacy paths with or without trailing slash. Map page is served from `public/opendesign/mockups/daklak-map/index.html`; its `GET /api/photos` and image URLs share the same deployment.

## SEO & caching

- Both map pages (`/` and `/opendesign/mockups/daklak-map/`) ship description, canonical, Open Graph/Twitter tags, JSON-LD `WebPage`/`Place`, a no-JS fallback and lazy-loaded images. Leaflet CDN assets are pinned with SRI.
- `public/robots.txt` and `public/sitemap.xml` list the map URLs; `vercel.json` sets `Cache-Control` for map HTML, `favicon.png` and `og-image.png`.
- `GET /api/photos` returns `Cache-Control: public, max-age=0, s-maxage=20, stale-while-revalidate=40` plus a weak ETag, so repeat polling is served by the edge and conditional requests get `304`. New photos can take up to ~60s to appear on the public map.
- Canonical/OG URLs and the sitemap hardcode `https://ecopick-api-iota.vercel.app`. Update them (and regenerate `og-image.png`) if the deployment moves to a custom domain.

## Observability

- Mọi response có header `X-Request-Id` (giữ `x-request-id` do client/proxy gửi nếu hợp lệ, không thì sinh UUID). Client đọc được qua `Access-Control-Expose-Headers`.
- Lỗi chưa xử lý và readiness thất bại ghi đúng một dòng JSON (`level`, `requestId`, `method`, `path`, `durationMs`, `error.stack`) để lọc trong Vercel Logs.
- `GET /health` là liveness (không chạm DB). `GET /health/ready` ping Postgres với timeout 3s: 200 `{ database: 'up', latencyMs }` hoặc 503 `NOT_READY`.

## Tests

```bash
npm test
```

Fake-DB handler tests, no network or real database needed: auth (rate limits, OTP lockout, JWT TTL, logout revocation), upload magic-byte validation, report authorization/points, PII filtering, cron cleanup, photos cache/ETag, observability (request id, structured error log, readiness).

## Route coverage

API route groups currently include auth/profile, users, reports/photos/image uploads, events, posts/comments/likes/media, badges/rewards, roles, point logs, leaderboard/challenges, notifications, conversations and messages. This is not yet verified as complete parity with every method/body in `src/api/services/*`; point-log writes, role CRUD, unread notifications and chat membership/access still need end-to-end verification. Collections without dedicated relational tables use JSONB `app_data`; no local mock DB is copied to production.

Nearby routes currently return recent items without radius filtering. Do not treat the route list as a completed production certification; run authorized deployment smoke tests after each remaining parity fix.

Check deployment:

```bash
curl -i https://<deployment>/health
curl -i https://<deployment>/health/ready   # expect 200 database=up
curl -i https://<deployment>/api/photos   # expect Cache-Control + ETag
curl -I https://<deployment>/opendesign/mockups/daklak-map/
curl -I https://<deployment>/robots.txt
curl -I https://<deployment>/sitemap.xml
```

## Known limits

- Nearby endpoints return current reports/events; no PostGIS radius calculation is included.
- Uploads use direct Vercel Blob, not presigned URLs. OAuth providers, real OTP email delivery, push notifications and sponsor code validation require external integrations.
- Map markers load the original uploaded image; no server-side thumbnail generation. Use Vercel Blob image transformations or an upload pipeline if thumbnail bandwidth becomes a problem.
- Map tiles come from OpenStreetMap and routing from OSRM; they are external services, not hosted by Vercel. Respect their usage policies.
- This is not a production security certification. Configure backups and monitoring before launch. Review the smoke tests and `npm test` after each schema/API change.
