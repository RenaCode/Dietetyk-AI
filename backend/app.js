const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const logger = require('./services/logger');
const { requireAuth } = require('./middleware/auth');
const { apiRateLimiter } = require('./middleware/rateLimit');

// The Express application, without listening or background jobs - those live in server.js.
// Split out so tests can drive the REAL middleware order (tests/test-app-middleware.js):
// both the anonymous body-parsing DoS and the health-check sitting behind the rate limiter
// were bugs of ORDER in this file, invisible to any test that builds its own app.
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
// WHAT THIS NUMBER COULD NOT FIX UNTIL 03.10.2026. The hop count was already correct and
// spoofing dead, but every request from the internet arrived here as 10.42.0.1, the node's
// cni0 gateway (measured on production 2026-09-12, a forged X-Forwarded-For included). k3s
// fronts Traefik with klipper-lb, which DNATs and MASQUERADEs, and the traefik Service ran
// with `externalTrafficPolicy: Cluster`, so the client address never entered the chain. In
// that period the rate limiter, the registration lockout and the per-IP brute-force keys were
// all effectively global, and app_logs recorded 10.42.0.1 for everyone.
//
// Since 03.10.2026 the traefik Service runs with `externalTrafficPolicy: Local`, and req.ip
// is the real client: middleware/rateLimit.js and the 'register_endpoint' lockout are per
// client again, and the IP columns mean what they say. The flip side (audit 04.10.2026, D-3):
// every brute-force key in services/loginAttempts.js contained the IP, so the per-account key
// stopped acting as an accidental global limit and an attacker with N addresses got N times
// the guesses. That is why login and 2FA now also reserve an account-wide, IP-independent
// slot (reserveAccountAttempt). Do NOT raise the number below - at 3 the forged left-hand
// entry becomes the one Express believes, which is the original hole.
app.set('trust proxy', 2);

// `X-Powered-By: Express` only tells a scanner which CVE list to try (audit 04.10.2026, D-10).
app.disable('x-powered-by');

// Middleware
// CORS restricted to the configured application URL (APP_URL). A bare cors() used to
// answer Access-Control-Allow-Origin for EVERY domain. With Bearer-token authentication
// that is not critical - the token is not a cookie the browser sends automatically - but
// it needlessly made requests from any unknown site easier. In local development, where
// APP_URL is unset, it stays open so work across different ports and localhost is not
// blocked.
const allowedOrigin = process.env.APP_URL;
app.use(cors(allowedOrigin ? { origin: allowedOrigin } : {}));
// Morgan's default 'dev' format logs the full request URL INCLUDING the query string.
// That is a problem because some endpoints (/api/invitation-status?token=..., for
// instance) accept sensitive values there - such a token would land in the container logs
// in plain text. Session tokens (Google OAuth) no longer travel in the query string (see
// routes/auth.js - they are passed in the URL fragment, which the server never sees), but
// this is an extra layer of defence in depth for other or future parameters of that kind.
morgan.token('safe-url', (req) => {
  const url = req.originalUrl || req.url || '';
  return url
    .replace(/([?&])(token|ticket|code|state|access_token|refresh_token|client_secret|secret|key)=[^&]+/gi, '$1$2=%5Bredacted%5D')
    // The Apple Health webhook (routes/appleHealth.js) takes sync_token as a PATH
    // segment (/api/integrations/apple-health/:syncToken), not as a query parameter -
    // the query-string replace above does not cover it, so the token ended up in the logs
    // in plain text. We redact it separately here, regardless of its length or format.
    .replace(/(\/api\/integrations\/apple-health\/)[^/?]+/i, '$1%5Bredacted%5D')
    // Same for the public shared-report link (routes/sharedReport.js): the token in that
    // path is the ONLY thing protecting a PDF of somebody's health data, and it was logged in
    // full on every view.
    .replace(/(\/api\/public\/shared-reports\/)[^/?]+/i, '$1%5Bredacted%5D');
});
app.use(morgan(':method :safe-url :status :response-time ms - :res[content-length]'));

// Public health-check (NO session authentication), mounted FIRST of everything under /api:
// before requireAuth (Docker/CI/kubelet would get a 401 instead of the real status) and -
// since the 2026-10 audit - before the rate limiter as well.
//
// It used to sit behind apiRateLimiter on the assumption that 120 req/min per IP left plenty
// of room for probes. That assumption died with the discovery that every request then reached
// this process as 10.42.0.1 (see the trust-proxy note above): the kubelet's probes shared ONE bucket
// with the whole internet. Measured with the audit PoC: after 121 anonymous requests to
// /api/healthz in a minute the probe itself got 429. At ~2 req/s from anybody, readiness
// takes the pod out of the Service (full outage) and liveness restarts it every 90 s - and
// each restart takes a backup (see server.js). The endpoint does one `SELECT 1` and reads no
// input, so there is nothing for the limiter to protect here.
app.use(require('./routes/healthcheck'));

// Global rate limiter (protects the Gemini-backed routes and the rest of /api from
// abuse) - mounted BEFORE requireAuth so that it also limits login attempts, not just
// requests from authenticated users, and BEFORE the body parser so that a flood is turned
// away without its bodies being parsed.
// NOTE: it must be mounted BEFORE the Apple Health webhook and the shared-report route
// below - both of those paths also start with /api/, and Express middleware runs in
// registration order. The Apple Health webhook in particular is authorised solely by the
// token in its URL (sync_token) - without the limiter mounted before it, that endpoint had
// no protection whatsoever against request floods or token guessing.
// Per client since 03.10.2026 (see the trust-proxy note above); before that it was one
// global bucket.
app.use('/api', apiRateLimiter);

// Request bodies. The global parser used to be `express.json({ limit: '20mb' })`, mounted
// before the limiter and before requireAuth, so ANY anonymous POST to ANY /api path had up to
// 20 MB of JSON parsed in full. Measured: ~150 MB of RSS per 19.5 MB body, against a 512Mi
// container limit - three or four parallel POSTs to /api/login were an OOM kill, and every
// restart takes a backup (see server.js).
//
// Now everything gets a small limit, and the few endpoints that genuinely receive large
// payloads get a larger one only once the caller is known:
//   - the Apple Health webhook: 20 MB, parsed inside routes/appleHealth.js AFTER its
//     sync_token has been looked up;
//   - meals with a photo, the profile (avatar + body-goal photo), the chat (it resends the
//     whole conversation): parsed further down, AFTER requireAuth.
// The sizes are derived from the per-field limits those routes enforce themselves
// (MAX_MEAL_IMAGE_BASE64_CHARS ~5 MB in routes/meals.js; avatar 3 MB + body-goal photo 4 MB in
// routes/account.js), with headroom for the JSON around them. Anything over the limit is a
// 413 through the central error handler.
const SMALL_JSON_LIMIT = '256kb';
const smallJsonParser = express.json({ limit: SMALL_JSON_LIMIT });
const AUTHENTICATED_LARGE_BODY_ROUTES = [
  { path: '/api/meals', limit: '8mb' },
  { path: '/api/user/profile', limit: '10mb' },
  { path: '/api/chat', limit: '2mb' }
];
const isAppleHealthWebhook = (req) => req.method === 'POST' && req.path.startsWith('/api/integrations/apple-health/');
const isAuthenticatedLargeBodyRoute = (req) => req.method === 'POST' && AUTHENTICATED_LARGE_BODY_ROUTES.some(r => r.path === req.path);

app.use((req, res, next) => {
  if (isAppleHealthWebhook(req) || isAuthenticatedLargeBodyRoute(req)) return next();
  return smallJsonParser(req, res, next);
});

// Serve the built frontend as static files in production
app.use(express.static(path.join(__dirname, 'public')));

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

// The larger body limits - only for callers requireAuth has let through (see the note on
// SMALL_JSON_LIMIT above). An anonymous request to these paths was answered with 401 before
// its body was read.
for (const route of AUTHENTICATED_LARGE_BODY_ROUTES) {
  app.post(route.path, express.json({ limit: route.limit }));
}

// --- API ROUTES (mounted as routers; each defines its full /api/... paths) ---
app.use(require('./routes/auth'));
app.use(require('./routes/meals'));
app.use(require('./routes/account'));
app.use(require('./routes/integrations'));
app.use(require('./routes/health'));
app.use(require('./routes/admin'));
app.use(require('./routes/dashboard'));
app.use(require('./routes/chat'));

// Serve index.html for every remaining route (React SPA routing)
//
// The production backend image has no public/ (the frontend is its own nginx image, see
// docker/frontend.Dockerfile), so sendFile failed with ENOENT and every stray non-API request
// - a scanner, a probe of `/` - became a "WARN HTTP error 404 ... /app/public/index.html" row
// in app_logs and the admin report. Without the build there is nothing to serve: a plain 404.
const SPA_INDEX = path.join(__dirname, 'public', 'index.html');
app.get('*', (req, res) => {
  if (!fs.existsSync(SPA_INDEX)) {
    return res.status(404).json({ error: 'Nie znaleziono.' });
  }
  res.sendFile(SPA_INDEX);
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

module.exports = app;
