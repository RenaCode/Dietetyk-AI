// The reverse proxy must wait longer than the slowest AI call the backend can make (audit
// 2026-10-09, W2).
//
// nginx in front of /api had no proxy_read_timeout, i.e. the default 60 s, while one Gemini
// request may take 90 s and generateContentWithFallback tries a second model after a timeout.
// A slow photo analysis therefore reached the browser as 504 while the backend went on and
// saved the meal - and the user, told it had failed, sent it again.
//
// Reads the chart template and the compose-era nginx.conf directly (no helm needed), so the
// check runs everywhere the backend suite runs.
//
// Run with: node tests/test-proxy-timeouts.js

const fs = require('fs');
const path = require('path');

process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-proxy-timeouts';
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret-for-proxy-timeouts';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

const { GEMINI_WORST_CASE_MS } = require('../config');
const ROOT = path.join(__dirname, '..', '..');

// The `location /api { ... }` block of an nginx config, and the seconds of one directive in it.
function apiBlock(text) {
  const start = text.search(/location \/api\s*\{/); // not a mention of it in a comment
  if (start === -1) return '';
  // Up to the first line holding only `}` - the chart template has `{{ ... }}` inside the
  // block, so the first brace is not the end of it.
  const end = text.slice(start).search(/\n\s*\}\s*\n/);
  return end === -1 ? text.slice(start) : text.slice(start, start + end);
}
function seconds(block, directive) {
  const m = new RegExp(`${directive}\\s+(\\d+)s?;`).exec(block);
  return m ? Number(m[1]) : null;
}

try {
  assert(Number.isFinite(GEMINI_WORST_CASE_MS) && GEMINI_WORST_CASE_MS >= 90 * 1000, `config exports the worst-case AI time (${GEMINI_WORST_CASE_MS} ms)`);
  for (const file of ['charts/dietetyk/templates/nginx-configmap.yaml', 'docker/nginx.conf']) {
    const block = apiBlock(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    assert(block.length > 0, `${file} has a location /api block`);
    const read = seconds(block, 'proxy_read_timeout');
    assert(read !== null && read * 1000 > GEMINI_WORST_CASE_MS, `${file}: proxy_read_timeout ${read}s is longer than the worst AI call (${GEMINI_WORST_CASE_MS / 1000}s)`);
  }
  console.log('\n🎉 PROXY TIMEOUT TESTS PASSED\n');
  process.exit(0);
} catch (err) {
  console.error('\n' + err.message);
  console.error('❌ PROXY TIMEOUT TESTS FAILED');
  process.exit(1);
}
