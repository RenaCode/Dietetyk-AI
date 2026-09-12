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

// How many reverse proxies sit in front of this process, counted from the socket
// inwards. Express hands `req.ip` to every per-IP defence we have (the brute-force lock
// in services/loginAttempts.js, the global limiter in middleware/rateLimit.js), so this
// number decides whether those defences can be bypassed - or whether they misfire.
//
// DERIVED, NOT GUESSED. Production runs on k3s via ArgoCD (renacode-infra/argocd-apps.yaml
// deploys charts/dietetyk). The request path is:
//   client
//     -> Traefik           (k3s built-in ingress controller in kube-system, LoadBalancer
//                           on 80/443; charts/dietetyk/values.yaml sets
//                           ingress.className: traefik)
//     -> nginx             (the frontend pod; charts/dietetyk/templates/ingress.yaml
//                           routes / to the -frontend Service, and
//                           templates/nginx-configmap.yaml proxy_passes /api to the
//                           -backend Service)
//     -> this process
// Exactly two of those hops are HTTP proxies that write X-Forwarded-For, so the value is
// 2. The k3s LoadBalancer in front of Traefik is layer 4 and never touches the header, so
// it does not count.
//
// `true` - what this used to be - was a real, exploited hole: it trusts EVERY entry, so
// Express takes the LEFTMOST one, which is whatever the client typed. nginx uses
// $proxy_add_x_forwarded_for, which only APPENDS, so a header forged outside survives all
// the way here. An attacker rotating `X-Forwarded-For: 9.9.9.<n>` got a fresh brute-force
// key (`${ip}::${username}`) and a fresh limiter bucket on every single request: 12 wrong
// passwords in a row, 12 let through, 0 lockouts, against MAX_ATTEMPTS=5.
//
// Both directions of error hurt, so do not "round up for safety":
//   too high  - the same bypass as `true`: every extra trusted hop is one more attacker-
//               controlled entry that Express will believe.
//   too low   - every user collapses onto the proxy's own address (with 1 here, that is
//               the Traefik pod IP), giving the entire internet ONE shared counter: the
//               first attacker to trip the 120 req/min limiter locks out everybody else.
// Verified against express 4 / proxy-addr with a forged prefix `9.9.9.7, <client>,
// <traefik>`: 2 yields <client>, `true` yields 9.9.9.7, 1 yields <traefik>.
// tests/test-trust-proxy.js pins this down, and reads the number straight out of this
// file so that changing it here cannot silently pass.
//
// WHAT THIS NUMBER CANNOT FIX (measured on production, 2026-09-12). The hop count above is
// correct and spoofing is genuinely dead, but req.ip is still NOT the caller's address: every
// request from the internet arrives here as 10.42.0.1, the node's cni0 gateway. Proof - two
// requests to https://dietetyk.renacode.com/api/login from a machine whose public address was
// 83.4.148.167, the second one carrying a forged `X-Forwarded-For: 9.9.9.7`; both were logged
// by services/logger.js as `(IP: 10.42.0.1)`.
//
// The cause is upstream of every header decision made here. k3s fronts Traefik with klipper-lb
// (the svclb DaemonSet), which DNATs and then MASQUERADEs incoming connections, and the traefik
// Service in kube-system runs with `externalTrafficPolicy: Cluster`. Traefik therefore sees the
// node, not the client, and the X-Forwarded-For chain it starts is truthful about what it saw
// and useless to us. No value of this setting can recover an address that never entered the
// chain: the comment above is right that 1 would collapse everyone onto the Traefik pod, and
// what is actually happening is the same collapse one hop further out.
//
// The practical consequences, all live today:
//   - middleware/rateLimit.js keeps ONE bucket for the whole internet. 121 requests in a minute
//     from anybody returns 429 to everybody for the rest of that minute.
//   - the per-IP registration lockout in routes/auth.js ('register_endpoint') is likewise
//     global: five attempts from anyone freeze registration for 15 minutes for all.
//   - the brute-force key in services/loginAttempts.js is `10.42.0.1::<username>`, so it still
//     limits guessing per account, but no longer per source.
//   - every `ip` column in app_logs and every SECURITY log line records 10.42.0.1.
// The fix is in the cluster, not in this file: `externalTrafficPolicy: Local` on the traefik
// Service (or the PROXY protocol between klipper-lb and Traefik). Until that lands, treat
// req.ip as "the cluster", not "the caller". Do NOT raise the number below to compensate - at 3
// the forged left-hand entry becomes the one Express believes, which is the original hole.
app.set('trust proxy', 2);

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

// A failure inside start() - a migration that could not run (see addColumn in db.js), a
// database that will not open - must stop the process, not leave it standing. Without this
// catch the rejection only reached the unhandledRejection handler below, which logs and
// returns: app.listen() never ran, so the container stayed "up" with nothing on port 3000,
// and the only symptom was the liveness probe timing out a minute later with no explanation
// in between. Exiting non-zero makes Kubernetes restart the pod and puts the real error at
// the top of `kubectl logs --previous`.
start().catch((err) => {
  logger.error(`Server startup failed: ${err.message}`, 'SYSTEM', err);
  console.error('[STARTUP FAILED]', err);
  setTimeout(() => process.exit(1), 1000);
});

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
