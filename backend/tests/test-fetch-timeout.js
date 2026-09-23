// Tests for utils/fetchWithTimeout.js (audit 2026-09-23).
//
// The comment at the top of that file promises that "a single hung request cannot stall the
// whole process". It did not hold. The timer was cleared in a `finally` around
// `await fetch(...)`, and fetch() resolves as soon as the response HEADERS arrive - the body
// is still an unread stream at that point. So the AbortController was disarmed exactly one
// line before the part that actually hangs: `await res.json()` in services/sync.js.
//
// This is not a theoretical shape. A dying TLS proxy answers 200, sends the headers, and
// then simply stops transmitting - it never resets the connection, so nothing downstream
// ever errors. `await sleepRes.json()` stayed pending for ever, which meant the `finally`
// in scheduler.js never ran, `isSyncRunning` stayed true, and every later tick returned at
// `if (isSyncRunning) return;`. Syncing AND, at the time, the summary mail for every user
// stopped until someone restarted the pod - with one skipped-tick warning in the log to
// show for it.
//
// Run with: node tests/test-fetch-timeout.js

const http = require('http');
const assert = require('assert');
const { fetchWithTimeout } = require('../utils/fetchWithTimeout');

// Handles kept so the test can close them; a socket left open holds the process alive.
const openSockets = new Set();

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/hang-body') {
      // Headers and an opening brace, then silence for ever: a valid start to a JSON body
      // the client will wait for the rest of.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"sleep":');
      return; // never res.end()
    }
    if (req.url === '/hang-headers') {
      return; // not even a status line
    }
    if (req.url === '/slow-but-complete') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"data":');
      setTimeout(() => res.end('[1,2,3]}'), 150);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  server.on('connection', (socket) => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function assertOk(condition, message) {
  if (!condition) throw new Error(`❌ ${message}`);
  console.log(`✅ ${message}`);
}

async function expectTimeout(promise, timeoutMs, what) {
  const startedAt = Date.now();
  let error = null;
  try {
    await promise;
  } catch (err) {
    error = err;
  }
  const elapsed = Date.now() - startedAt;
  assert.ok(error, `${what}: the call resolved instead of timing out - this is the hang.`);
  assert.ok(
    /timed out/i.test(error.message),
    `${what}: expected a timeout error, got "${error.message}"`
  );
  // Generous upper bound: the point is that it ends at all, and roughly when it was told to.
  assert.ok(
    elapsed < timeoutMs + 2000,
    `${what}: took ${elapsed}ms for a ${timeoutMs}ms timeout.`
  );
  return elapsed;
}

async function main() {
  console.log('=== FETCH TIMEOUT TESTS ===');
  const { server, baseUrl } = await startServer();
  try {
    console.log('\n--- TEST 1: a body that never finishes is aborted ---');
    const res = await fetchWithTimeout(`${baseUrl}/hang-body`, {}, 400);
    assert.strictEqual(res.status, 200, 'the headers arrive normally - that was never the problem');
    const elapsed = await expectTimeout(res.json(), 400, 'reading a body that never ends');
    console.log(`✅ res.json() on a half-delivered body rejects after ${elapsed}ms instead of hanging for ever`);

    console.log('\n--- TEST 2: a server that never answers at all is still aborted ---');
    await expectTimeout(
      fetchWithTimeout(`${baseUrl}/hang-headers`, {}, 400),
      400,
      'a request that never gets a response'
    );
    console.log('✅ the header-phase timeout still works');

    console.log('\n--- TEST 3: a slow but complete body is NOT aborted ---');
    // The other half of the contract: extending the timeout over the body must not start
    // killing responses that merely take a moment to arrive.
    const slow = await fetchWithTimeout(`${baseUrl}/slow-but-complete`, {}, 3000);
    const slowBody = await slow.json();
    assert.deepStrictEqual(slowBody, { data: [1, 2, 3] }, 'the slow body should have been read in full');
    console.log('✅ a body that arrives in chunks within the timeout is read normally');

    console.log('\n--- TEST 4: an ordinary response is unchanged ---');
    const ok = await fetchWithTimeout(`${baseUrl}/ok`, {}, 3000);
    assert.deepStrictEqual(await ok.json(), { ok: true }, 'the normal path should be untouched');
    console.log('✅ callers keep the ordinary Response API');

    console.log('\n🎉 FETCH TIMEOUT TESTS PASSED\n');
  } catch (err) {
    console.error('\n' + (err && err.message ? err.message : err));
    console.error('❌ FETCH TIMEOUT TESTS FAILED');
    for (const socket of openSockets) socket.destroy();
    server.close();
    process.exit(1);
  }
  for (const socket of openSockets) socket.destroy();
  server.close();
  process.exit(0);
}

main();
