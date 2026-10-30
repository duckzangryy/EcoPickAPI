const {
  sql,
  failDomain,
  json,
  fail,
  handleCronCleanup,
  requestIdFor,
  logServerError,
  databaseReady,
  withTimeout,
} = require('../lib/helpers');
const { handleAuth } = require('../lib/auth');
const { handleReports } = require('../lib/reports');
const { handleEventsAndRewards } = require('../lib/eventsAndRewards');
const { handleDomain } = require('../lib/domain');

async function handler(req, res, meta) {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,Accept,X-Requested-With,X-Request-Id');
  res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, Retry-After, ETag');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  const originalUrl = req.url || '/';
  const url = new URL(originalUrl, `https://${req.headers.host || 'localhost'}`);
  const routedPath = url.searchParams.get('route');
  const forwardedPath =
    req.headers['x-original-uri'] ||
    req.headers['x-vercel-original-path'] ||
    req.headers['x-forwarded-uri'];
  const path =
    (routedPath || (forwardedPath ? new URL(forwardedPath, url).pathname : url.pathname)).replace(/\/+$/, '') || '/';
  const method = req.method.toUpperCase();
  meta.path = path;
  meta.method = method;

  if (path === '/' || path === '/health' || path === '/api/health' || path === '/api/v1/health') {
    return json(res, 200, {
      success: true,
      ok: true,
      message: 'EcoPick API is running',
      version: '1.0.0',
    });
  }

  if (['/health/ready', '/api/health/ready', '/api/v1/health/ready'].includes(path) && method === 'GET') {
    try {
      const { latencyMs } = await withTimeout(databaseReady(sql()), 3000);
      return json(res, 200, { success: true, ok: true, database: 'up', latencyMs });
    } catch (error) {
      logServerError({ requestId: meta.requestId, method, path, error, durationMs: Date.now() - meta.startedAt });
      return json(res, 503, {
        success: false,
        ok: false,
        database: 'down',
        error: { code: 'NOT_READY', message: 'Cơ sở dữ liệu không phản hồi', details: [] },
      });
    }
  }

  const database = sql();

  if (path === '/api/cron/cleanup' && method === 'GET') {
    return handleCronCleanup(req, res, database);
  }

  await handleAuth(req, res, path, method, database);
  if (res.writableEnded || res.headersSent) return;
  await handleReports(req, res, path, method, database);
  if (res.writableEnded || res.headersSent) return;
  await handleEventsAndRewards(req, res, path, method, database);
  if (res.writableEnded || res.headersSent) return;
  await handleDomain(req, res, path, method, database, url);
  if (res.writableEnded || res.headersSent) return;

  return fail(res, 404, 'NOT_FOUND', `Endpoint ${method} ${path} chưa được đóng gói`);
}

module.exports = async (req, res) => {
  const meta = {
    requestId: requestIdFor(req),
    method: String(req.method || 'GET').toUpperCase(),
    path: req.url || '/',
    startedAt: Date.now(),
  };
  res.setHeader('X-Request-Id', meta.requestId);
  try {
    await handler(req, res, meta);
  } catch (error) {
    logServerError({ requestId: meta.requestId, method: meta.method, path: meta.path, error, durationMs: Date.now() - meta.startedAt });
    if (!res.headersSent && !failDomain(res, error)) {
      fail(
        res,
        500,
        'INTERNAL_ERROR',
        process.env.NODE_ENV === 'development' ? error.message : 'Lỗi máy chủ'
      );
    } else if (!res.writableEnded) {
      res.end();
    }
  }
};
