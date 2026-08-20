// Simple, dependency-free global API rate limiter, held in process memory,
// w tym samym stylu co backend/services/loginAttempts.js. Chroni przede
// primarily the routes that call Gemini (meal/photo analysis, the dietician chat) and the
// rest of /api, against abuse - a flood of requests from a single IP, manual or scripted -
// before the API cost/quota is burned or the database is overwhelmed.
// Requires no additional npm package such as express-rate-limit.

const WINDOW_MS = 60 * 1000;   // window over which requests are counted
const MAX_REQUESTS = 120;      // max /api requests per IP address within the window

const logger = require('../services/logger');

const hits = new Map(); // ip -> { count, windowStart }

function apiRateLimiter(req, res, next) {
  if (process.env.NODE_ENV === 'test' || process.env.CI === 'true') {
    return next();
  }
  const ip = req.ip || 'unknown';
  const now = Date.now();
  let rec = hits.get(ip);

  if (!rec || (now - rec.windowStart) > WINDOW_MS) {
    rec = { count: 0, windowStart: now };
  }

  rec.count += 1;
  hits.set(ip, rec);

  if (rec.count > MAX_REQUESTS) {
    const retryAfterSec = Math.ceil((rec.windowStart + WINDOW_MS - now) / 1000);
    res.set('Retry-After', String(Math.max(retryAfterSec, 1)));
    
    logger.security(
      `API request limit exceeded (${rec.count}/${MAX_REQUESTS})`,
      'RATE_LIMIT',
      { path: req.originalUrl, method: req.method },
      ip
    );

    return res.status(429).json({ error: 'Zbyt wiele żądań. Spróbuj ponownie za chwilę.' });
  }

  next();
}

// Periodic cleanup of expired entries so the map does not grow without bound
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of hits.entries()) {
    if ((now - rec.windowStart) > WINDOW_MS) {
      hits.delete(ip);
    }
  }
}, 10 * 60 * 1000);

// A dedicated, stricter per-user limiter for the endpoints that send test summary emails
// (send-weekly/daily/monthly-summary). Those endpoints accept an arbitrary `email` in the
// body - an intentional "send a test email to this address" feature - so without this
// limit a logged-in user could send mail repeatedly to any external address, burning the
// sender reputation and quota
// of the Mailgun account for spam. The limit is per-user_id (not per-IP like the global
// apiRateLimiter above), because the risk here is one user calling the endpoint
// repeatedly, regardless of which IP address they come from.
const SUMMARY_EMAIL_WINDOW_MS = 10 * 60 * 1000; // 10 minut
const SUMMARY_EMAIL_MAX = 5;                    // max 5 test sends per 10 min per user

const summaryEmailHits = new Map(); // userId -> { count, windowStart }

function summaryEmailLimiter(req, res, next) {
  if (process.env.NODE_ENV === 'test' || process.env.CI === 'true') {
    return next();
  }
  const userId = req.user && req.user.id;
  if (!userId) return next(); // requireAuth should have caught this earlier; defensive only

  const now = Date.now();
  let rec = summaryEmailHits.get(userId);

  if (!rec || (now - rec.windowStart) > SUMMARY_EMAIL_WINDOW_MS) {
    rec = { count: 0, windowStart: now };
  }

  rec.count += 1;
  summaryEmailHits.set(userId, rec);

  if (rec.count > SUMMARY_EMAIL_MAX) {
    const retryAfterSec = Math.ceil((rec.windowStart + SUMMARY_EMAIL_WINDOW_MS - now) / 1000);
    res.set('Retry-After', String(Math.max(retryAfterSec, 1)));

    logger.security(
      `Test email send limit exceeded (${rec.count}/${SUMMARY_EMAIL_MAX})`,
      'RATE_LIMIT_EMAIL',
      { email: req.body.email },
      req.ip || 'unknown',
      userId
    );

    return res.status(429).json({ error: 'Zbyt wiele wysłanych e-maili testowych. Spróbuj ponownie później.' });
  }

  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [userId, rec] of summaryEmailHits.entries()) {
    if ((now - rec.windowStart) > SUMMARY_EMAIL_WINDOW_MS) {
      summaryEmailHits.delete(userId);
    }
  }
}, 10 * 60 * 1000);

// A dedicated, stricter per-user limiter for endpoints that call Gemini directly on user
// action (the dietician chat in routes/chat.js, meal photo/description analysis in
// routes/meals.js POST /api/meals). The round 18 audit found that the only protection on
// these endpoints was the global apiRateLimiter (120 req/min/IP across all of /api),
// which in practice did not guard the Gemini cost/quota at all: a single user could
// consume almost the entire allowance with AI requests alone.
// The limit is per-user rather than per-IP, because the risk here is cost and abuse tied
// to one account, no matter how many IP addresses it is used from.
const AI_WINDOW_MS = 10 * 60 * 1000; // 10 minut
const AI_MAX_REQUESTS = 30;          // max 30 AI calls per 10 min per user

const aiHits = new Map(); // userId -> { count, windowStart }

function aiRateLimiter(req, res, next) {
  if (process.env.NODE_ENV === 'test' || process.env.CI === 'true') {
    return next();
  }
  const userId = req.user && req.user.id;
  if (!userId) return next(); // requireAuth should have caught this earlier; defensive only

  const now = Date.now();
  let rec = aiHits.get(userId);

  if (!rec || (now - rec.windowStart) > AI_WINDOW_MS) {
    rec = { count: 0, windowStart: now };
  }

  rec.count += 1;
  aiHits.set(userId, rec);

  if (rec.count > AI_MAX_REQUESTS) {
    const retryAfterSec = Math.ceil((rec.windowStart + AI_WINDOW_MS - now) / 1000);
    res.set('Retry-After', String(Math.max(retryAfterSec, 1)));

    logger.security(
      `AI request limit exceeded (${rec.count}/${AI_MAX_REQUESTS})`,
      'RATE_LIMIT_AI',
      { path: req.originalUrl, method: req.method },
      req.ip || 'unknown',
      userId
    );

    return res.status(429).json({ error: 'Zbyt wiele zapytań do AI w krótkim czasie. Spróbuj ponownie za kilka minut.' });
  }

  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [userId, rec] of aiHits.entries()) {
    if ((now - rec.windowStart) > AI_WINDOW_MS) {
      aiHits.delete(userId);
    }
  }
}, 10 * 60 * 1000);

module.exports = { apiRateLimiter, WINDOW_MS, MAX_REQUESTS, summaryEmailLimiter, aiRateLimiter };
