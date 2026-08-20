// Touch to trigger CI rebuild
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const db = require('./db');
const { PORT } = require('./config');
const logger = require('./services/logger');
const { requireAuth } = require('./middleware/auth');
const { apiRateLimiter } = require('./middleware/rateLimit');
const { runHourlySyncIfDue } = require('./scheduler');

const app = express();

// Trust the X-Forwarded-For header from nginx (the reverse proxy in front of the backend
// in docker-compose) so that req.ip shows the real client address rather than the nginx
// container's. Required for the per-IP brute-force protection to work correctly.
app.set('trust proxy', true);

// Middleware
// CORS restricted to the configured application URL (APP_URL). A bare cors() used to
// answer Access-Control-Allow-Origin for EVERY domain. With Bearer-token authentication
// that is not critical - the token is not a cookie the browser sends automatically - but
// it needlessly made requests from any unknown site easier. In local development, where
// APP_URL is unset, it stays open so work across different ports and localhost is not
// blocked.
const allowedOrigin = process.env.APP_URL;
app.use(cors(allowedOrigin ? { origin: allowedOrigin } : {}));
// Raised from the 100 kb default: the Apple Health webhook (Health Auto Export, see
// routes/appleHealth.js) sends large JSON payloads when exporting Workouts with "Route
// Data" (GPS) enabled over a longer period. Those exceeded the default limit and failed
// with a 413, surfaced as a generic bad-request message by the central error handler below.
app.use(express.json({ limit: '20mb' }));

// Morgan's default 'dev' format logs the full request URL INCLUDING the query string.
// That is a problem because some endpoints (/api/invitation-status?token=..., for
// instance) accept sensitive values there - such a token would land in the container logs
// in plain text. Session tokens (Google OAuth) no longer travel in the query string (see
// routes/auth.js - they are passed in the URL fragment, which the server never sees), but
// this is an extra layer of defence in depth for other or future parameters of that kind.
morgan.token('safe-url', (req) => {
  const url = req.originalUrl || req.url || '';
  return url
    .replace(/([?&])(token|code|state|access_token|refresh_token|client_secret|secret|key)=[^&]+/gi, '$1$2=%5Bredacted%5D')
    // The Apple Health webhook (routes/appleHealth.js) takes sync_token as a PATH
    // segment (/api/integrations/apple-health/:syncToken), not as a query parameter -
    // the query-string replace above does not cover it, so the token ended up in the logs
    // in plain text. We redact it separately here, regardless of its length or format.
    .replace(/(\/api\/integrations\/apple-health\/)[^/?]+/i, '$1%5Bredacted%5D');
});
app.use(morgan(':method :safe-url :status :response-time ms - :res[content-length]'));

// Serve the built frontend as static files in production
app.use(express.static(path.join(__dirname, 'public')));

// Global rate limiter (protects the Gemini-backed routes and the rest of /api from
// abuse) - mounted BEFORE requireAuth so that it also limits login attempts, not just
// requests from authenticated users.
// NOTE: it must be mounted BEFORE the public health-check and the Apple Health webhook
// below, NOT after them - both of those paths also start with /api/, and Express
// middleware runs in registration order. The Apple Health webhook in particular is
// authorised solely by the token in its URL (sync_token) - without the limiter mounted
// before it, that endpoint had no protection whatsoever against request floods or token
// guessing, even though the code and comments below always assumed the limiter covered
// "the rest of /api", this route included.
app.use('/api', apiRateLimiter);

// Public health-check (NO session authentication) - must be mounted BEFORE
// `app.use('/api', requireAuth)` below, otherwise Docker/CI would get a 401 instead of
// the real application status. The 120 req/min/IP limit above is high enough not to
// interfere with the health-check's typical polling frequency.
app.use(require('./routes/healthcheck'));

// The Apple Health webhook (the Health Auto Export app) must likewise be mounted BEFORE
// requireAuth, because it authenticates per request with a sync_token in the URL (see
// routes/appleHealth.js) rather than with a session or cookie like the rest of /api/.
app.use(require('./routes/appleHealth'));

// Public, unauthenticated retrieval of a shared PDF report (product feature: share a
// report by link) - for the same reasons it must be mounted BEFORE requireAuth. The token
// in the URL (see routes/sharedReport.js and services/sharedReports.js) is the endpoint's
// only authorisation, because the recipient of the link - a doctor or dietician - has no
// account in the app.
app.use(require('./routes/sharedReport'));

// Protect every /api/ route with the auth middleware
app.use('/api', requireAuth);

// --- API ROUTES (mounted as routers; each defines its full /api/... paths) ---
app.use(require('./routes/auth'));
app.use(require('./routes/meals'));
app.use(require('./routes/account'));
app.use(require('./routes/integrations'));
app.use(require('./routes/health'));
app.use(require('./routes/dayEvents'));
app.use(require('./routes/admin'));
app.use(require('./routes/dashboard'));
app.use(require('./routes/chat'));

// Serve index.html for every remaining route (React SPA routing)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Central error handler - must be registered as the last middleware. It ensures that
// errors not handled inside routes (malformed request JSON thrown by express.json(), for
// example) return clean JSON rather than Express's default error page, which would leak a
// stack trace and server file paths.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  
  const status = err.status || err.statusCode || 500;
  const level = status >= 500 ? 'ERROR' : 'WARN';
  
  logger[level.toLowerCase()](
    `HTTP error ${status}: ${err.message}`,
    'HTTP_SERVER',
    err,
    req.ip,
    req.user ? req.user.id : null
  );

  res.status(status).json({ error: 'Nieprawidłowe żądanie.' });
});

// Start the server
async function start() {
  await db.initDb();

  // Clean up old photos, logs and expired sessions at startup
  await db.cleanupExpiredSessions();
  await db.cleanupOldImages();
  await db.cleanupOldLogs();

  // First database backup at startup (see backupDatabase in db.js), so a copy exists
  // immediately rather than only after the container has run for 24h.
  await db.backupDatabase();

  // Run the cleanup and the backup every 24 hours
  setInterval(async () => {
    console.log('[CRON] Running the periodic cleanup of old photos, logs and expired sessions...');
    await db.cleanupExpiredSessions();
    await db.cleanupOldImages();
    await db.cleanupOldLogs();
  }, 24 * 60 * 60 * 1000);

  setInterval(async () => {
    console.log('[CRON] Running the periodic database backup...');
    await db.backupDatabase();
  }, 24 * 60 * 60 * 1000);

  // Data sync (Oura, Withings) and summary checks: hourly, and only within the
  // 05:00-22:00 window. We check every 5 minutes whether a new clock hour has begun and
  // whether we are inside the active window - which also makes this robust to a server
  // restart mid-day, since it syncs immediately after startup.
  await runHourlySyncIfDue();
  setInterval(runHourlySyncIfDue, 5 * 60 * 1000);

  app.listen(PORT, () => {
    console.log(`Dietetyk AI server listening on port ${PORT}`);
  });
}

start();

// Global process-level error handling
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err.message}`, 'SYSTEM', err);
  // Give the logs time to flush before exiting the process
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason) => {
  logger.error(
    `Unhandled promise rejection: ${reason}`,
    'SYSTEM',
    reason instanceof Error ? reason : new Error(String(reason))
  );
});
