// Test of the dedicated AI limiter (middleware/rateLimit.js -> aiRateLimiter, round 18 -
// audit fix: routes/chat.js and routes/meals.js POST /api/meals had only the global
// apiRateLimiter at 120 req/min/IP protecting them, which in practice did not guard the
// Gemini call cost against a single user).
// A pure unit test of the middleware with fake req/res - no database or network.
// NOTE: the limiter disables itself under NODE_ENV=test / CI=true (see
// middleware/rateLimit.js), so this test must set a different NODE_ENV explicitly to
// exercise the limit at all.
process.env.NODE_ENV = 'rate-limit-test';
delete process.env.CI;

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

function makeRes(capture) {
  return {
    set: (k, v) => { capture.headers[k] = v; },
    status: (code) => {
      capture.status = code;
      return { json: (body) => { capture.body = body; } };
    }
  };
}

function run() {
  console.log('\n--- TEST: aiRateLimiter ---');
  const { aiRateLimiter } = require('../middleware/rateLimit');

  const req = { user: { id: 424242 }, ip: '127.0.0.1', originalUrl: '/api/chat', method: 'POST' };
  let nextCalls = 0;
  const next = () => { nextCalls++; };

  const AI_MAX_REQUESTS = 30; // must match the constant in middleware/rateLimit.js
  let lastCapture = null;
  for (let i = 0; i < AI_MAX_REQUESTS + 1; i++) {
    lastCapture = { headers: {}, status: null, body: null };
    aiRateLimiter(req, makeRes(lastCapture), next);
  }

  assert(nextCalls === AI_MAX_REQUESTS, `next() called exactly ${AI_MAX_REQUESTS} times - the over-limit request is blocked, not passed through`);
  assert(lastCapture.status === 429, 'the over-limit request receives status 429');
  assert(lastCapture.body && typeof lastCapture.body.error === 'string', 'the 429 response carries an error message');
  assert(!!lastCapture.headers['Retry-After'], 'the 429 response carries a Retry-After header');

  // A different user has their OWN counter - the limit is per-user, not global.
  const otherUserReq = { user: { id: 999999 }, ip: '127.0.0.1', originalUrl: '/api/chat', method: 'POST' };
  let otherUserNextCalls = 0;
  const otherCapture = { headers: {}, status: null, body: null };
  aiRateLimiter(otherUserReq, makeRes(otherCapture), () => { otherUserNextCalls++; });
  assert(otherUserNextCalls === 1, 'a different user (different user_id) is NOT blocked by the first user\'s limit (per-user limit)');
}

try {
  run();
  console.log('\n🎉 AI RATE LIMITER TESTS PASSED\n');
  process.exit(0);
} catch (err) {
  console.error('\n' + err.message);
  console.error('❌ TESTY LIMITERA AI NIEUDANE');
  process.exit(1);
}
