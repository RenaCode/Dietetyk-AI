// Tests of the process-level error handlers (services/processErrors.js).
//
// Audit 2026-10-03 (D3): when k3s closed the pod's stdout, every console write failed with
// EPIPE, the EPIPE surfaced as an uncaughtException, and the handler's own log line hit the
// same dead pipe - 556 "Uncaught exception: write EPIPE" rows in app_logs within 2 seconds.
//
// Part 1 drives the handlers with a fake process object and the real logger + database.
// Part 2 reproduces the production failure for real: a child process whose stdout and stderr
// pipes the parent closes, then keeps writing to the console.
//
// Run with: node tests/test-process-errors.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');

const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-process-errors-'));
process.env.DATABASE_DIR = tmpDbDir;
process.env.NODE_ENV = 'test';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'test-app-password-for-process-errors';

const db = require('../db');
const logger = require('../services/logger');
const { installProcessErrorHandlers } = require('../services/processErrors');

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function epipe() {
  const err = new Error('write EPIPE');
  err.code = 'EPIPE';
  err.syscall = 'write';
  return err;
}

async function countUncaughtRows() {
  const row = await db.get(`SELECT COUNT(*) AS n FROM app_logs WHERE message LIKE 'Uncaught exception%'`);
  return row.n;
}

async function testFakeProcess() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  const exits = [];
  installProcessErrorHandlers({ proc, logger, exit: (code) => exits.push(code), exitDelayMs: 50 });

  // Without a listener, emit('error') on a stream throws - that throw was the uncaught
  // exception that started the loop.
  let threw = false;
  try {
    proc.stdout.emit('error', epipe());
    proc.stderr.emit('error', epipe());
  } catch (e) {
    threw = true;
  }
  assert(!threw, 'EPIPE on stdout/stderr is absorbed by the stream listener');
  await sleep(100);
  assert(await countUncaughtRows() === 0, 'a stdio EPIPE writes nothing to app_logs');

  proc.emit('uncaughtException', epipe());
  proc.emit('uncaughtException', epipe());
  for (let i = 0; i < 50; i++) proc.emit('uncaughtException', new Error('later failure during shutdown'));
  await sleep(200);
  assert(await countUncaughtRows() === 1, 'two (and more) uncaughtExceptions while going down -> exactly 1 app_logs row');
  assert(exits.length === 1 && exits[0] === 1, 'the exit is scheduled once, with code 1');
}

// The child installs the real handlers on the real process, with a logger stub that does
// what the real one does first - write to the console - and records each call in a file the
// parent can read after the pipes are gone.
const CHILD_SOURCE = `
const fs = require('fs');
const { installProcessErrorHandlers } = require(${JSON.stringify(path.join(__dirname, '..', 'services', 'processErrors'))});
const counter = process.argv[1];
const logger = { error: (msg) => { fs.appendFileSync(counter, msg + '\\n'); console.error(msg); } };
installProcessErrorHandlers({ logger, exitDelayMs: 300 });
process.stdin.once('data', () => {
  let i = 0;
  const t = setInterval(() => { console.log('tick ' + i); console.error('tock ' + i); if (++i > 50) { clearInterval(t); setTimeout(() => process.exit(0), 100); } }, 5);
});
`;

async function testRealClosedPipe() {
  const counter = path.join(tmpDbDir, 'logger-calls.txt');
  fs.writeFileSync(counter, '');
  const child = spawn(process.execPath, ['-e', CHILD_SOURCE, counter], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  // Close the read ends first, like a dead log collector, then let the child start writing.
  child.stdout.destroy();
  child.stderr.destroy();
  await sleep(100);
  child.stdin.write('go\n');
  const code = await Promise.race([exited, sleep(5000).then(() => 'timeout')]);
  const calls = fs.readFileSync(counter, 'utf8').split('\n').filter(Boolean);
  assert(code === 0, `a child writing to closed stdout/stderr keeps running and exits normally (exit=${code})`);
  assert(calls.length === 0, `no logger calls caused by EPIPE (got ${calls.length})`);
}

async function run() {
  await db.initDb();
  await testFakeProcess();
  await testRealClosedPipe();
}

run()
  .then(() => {
    console.log('\n🎉 PROCESS ERROR HANDLER TESTS PASSED\n');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n' + err.message);
    console.error('❌ PROCESS ERROR HANDLER TESTS FAILED');
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    process.exit(1);
  });
