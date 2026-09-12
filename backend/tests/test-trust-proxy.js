// Test of the `trust proxy` setting in server.js - i.e. of where req.ip comes from.
//
// The bug this pins down: server.js used to say `app.set('trust proxy', true)`, which
// trusts EVERY entry of X-Forwarded-For and therefore makes Express read the LEFTMOST
// one - the value the client typed. nginx in front of the backend uses
// $proxy_add_x_forwarded_for (charts/dietetyk/templates/nginx-configmap.yaml), which only
// APPENDS, so a header forged outside the cluster arrives here intact. Every per-IP
// defence keys off req.ip, so an attacker rotating `X-Forwarded-For: 9.9.9.<n>` got a
// fresh brute-force key (services/loginAttempts.js) and a fresh limiter bucket
// (middleware/rateLimit.js) on every request - unlimited password guessing.
//
// The test drives the REAL apiRateLimiter over a REAL HTTP socket, because req.ip is
// produced by Express's proxy-addr resolution and a hand-made fake req would simply
// hand the middleware whatever `ip` we chose, proving nothing.
//
// The trusted-hop count is read out of server.js rather than hard-coded here, so the test
// follows that file: with the pre-fix `true` the first assertion fails, and with a value
// that is too low (1) the last assertion fails. Both directions of the mistake are
// dangerous - too high re-opens the bypass, too low collapses the whole internet onto the
// proxy's own address and one shared counter.
//
// NOTE: the limiter disables itself under NODE_ENV=test / CI=true (see
// middleware/rateLimit.js), so this test must set a different NODE_ENV explicitly to
// exercise the limit at all.
process.env.NODE_ENV = 'trust-proxy-test';
delete process.env.CI;

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const { apiRateLimiter, MAX_REQUESTS } = require('../middleware/rateLimit');

// The address the outermost proxy (Traefik) actually observed - what req.ip must resolve
// to. The forged entries sit to its LEFT, the in-cluster hop to its RIGHT, exactly as
// production would assemble the header.
const REAL_CLIENT = '203.0.113.5';
const OTHER_CLIENT = '198.51.100.9';
const TRAEFIK_POD = '10.42.0.10';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

// Reads the `trust proxy` argument straight out of server.js so this test cannot pass
// while the production setting says something else.
function readTrustProxyFromServer() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const match = src.match(/app\.set\(\s*['"]trust proxy['"]\s*,\s*(.+?)\s*\)\s*;/);
  if (!match) {
    throw new Error('❌ no app.set(\'trust proxy\', ...) call found in server.js');
  }
  const raw = match[1];
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  // A CIDR string or an array of them is the other legitimate form of this setting.
  try {
    return JSON.parse(raw.replace(/'/g, '"'));
  } catch (e) {
    throw new Error(`❌ unrecognised 'trust proxy' value in server.js: ${raw}`);
  }
}

// Builds the smallest app that reproduces the production middleware order: the trust
// setting, then the global limiter mounted on /api, exactly as in server.js.
function startApp(trustProxy) {
  const app = express();
  app.set('trust proxy', trustProxy);
  app.use('/api', apiRateLimiter);
  app.get('/api/probe', (req, res) => res.json({ ip: req.ip }));

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function request(port, forwardedFor) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/probe', headers: { 'X-Forwarded-For': forwardedFor } },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(body); } catch (e) { /* the 429 body is JSON too, but be defensive */ }
          resolve({ status: res.statusCode, ip: parsed && parsed.ip });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function run() {
  console.log('\n--- TEST: trust proxy / spoofing X-Forwarded-For ---');

  const trustProxy = readTrustProxyFromServer();
  console.log(`   server.js sets trust proxy = ${JSON.stringify(trustProxy)}`);

  const server = await startApp(trustProxy);
  const port = server.address().port;

  try {
    // One attacker, one real address, a different forged prefix on every request - the
    // exact shape of the proof-of-concept. Under `trust proxy: true` each of these lands
    // in its own bucket and none of them is ever blocked.
    const seenIps = new Set();
    let passed = 0;
    let blocked = 0;

    for (let i = 1; i <= MAX_REQUESTS + 1; i++) {
      const forwardedFor = `9.9.9.${i}, ${REAL_CLIENT}, ${TRAEFIK_POD}`;
      const res = await request(port, forwardedFor);
      if (res.status === 429) {
        blocked++;
      } else {
        passed++;
        seenIps.add(res.ip);
      }
    }

    assert(
      seenIps.size === 1,
      `${MAX_REQUESTS + 1} requests with a ROTATING forged X-Forwarded-For resolve to a single req.ip ` +
      `(got ${seenIps.size} distinct: ${[...seenIps].join(', ')}) - one counter, not one per forged value`
    );
    assert(
      seenIps.has(REAL_CLIENT),
      `req.ip is the address the outermost proxy saw (${REAL_CLIENT}), not the forged left-hand entry`
    );
    assert(
      passed === MAX_REQUESTS && blocked === 1,
      `the rotating series is rate limited: ${passed} passed, ${blocked} blocked with 429 ` +
      `(expected ${MAX_REQUESTS} and 1)`
    );

    // The opposite failure mode: too few trusted hops would make EVERY client resolve to
    // the Traefik pod address, so the attacker above would have just locked out the whole
    // internet. A genuinely different client must still get through with its own identity.
    const otherClient = await request(port, `9.9.9.1, ${OTHER_CLIENT}, ${TRAEFIK_POD}`);
    assert(
      otherClient.status === 200 && otherClient.ip === OTHER_CLIENT,
      `a different real client keeps its own counter and is not collateral damage of the ` +
      `attacker's lockout (status ${otherClient.status}, ip ${otherClient.ip})`
    );
  } finally {
    server.close();
  }
}

run()
  .then(() => {
    console.log('\n🎉 TRUST PROXY TESTS PASSED\n');
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n' + err.message);
    console.error('❌ TRUST PROXY TESTS FAILED');
    process.exit(1);
  });
