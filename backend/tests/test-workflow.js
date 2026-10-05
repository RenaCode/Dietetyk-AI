// Guards on .github/workflows/docker-publish.yml (audit 2026-10-04, D-4, D-5, D-8, D-9; PR runs 2026-10-05).
// Plain text checks - the backend has no YAML parser and these properties are visible as text.
//
//   D-4  images were built from a lockfile regenerated in CI (`npm install --package-lock-only`)
//        instead of the committed one, so production ran an unreviewed dependency tree.
//   D-5  every job had `contents: write` + `packages: write`, and install scripts ran next to
//        a token persisted by actions/checkout.
//   D-8  two runs could write image tags in the wrong order and roll production back.
//   D-9  the frontend unit tests, i18n check and lint never ran.
//
// Run with: node tests/test-workflow.js

const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', '..', '.github', 'workflows', 'docker-publish.yml');
const text = fs.readFileSync(file, 'utf8');
const code = text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

function jobBlock(name) {
  const start = code.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`❌ job ${name} not found`);
  const rest = code.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z0-9-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

try {
  console.log('=== WORKFLOW TESTS ===');
  assert(!code.includes('--package-lock-only'), 'no lockfile is regenerated in CI');
  assert(!/upload-artifact|download-artifact/.test(code), 'no lockfile artifacts are passed between jobs');
  assert(/\npermissions:\n {2}contents: read\n(?! {2}\S)/.test(code), 'workflow-level permissions are only contents: read');
  for (const job of ['test-backend', 'test-frontend', 'test-e2e', 'changes']) {
    assert(!/packages: write|contents: write/.test(jobBlock(job)), `${job} gets no write permission`);
  }
  const checkouts = (code.match(/uses: actions\/checkout@/g) || []).length;
  const persisted = (code.match(/persist-credentials: false/g) || []).length;
  assert(persisted === checkouts - 1, `every checkout except update-git's drops the token (${persisted}/${checkouts - 1})`);
  const uses = code.match(/uses: \S+/g) || [];
  assert(uses.every((u) => /@[0-9a-f]{40}$/.test(u)), 'every action is pinned to a commit SHA');
  assert(/npm ci --ignore-scripts/.test(jobBlock('test-backend')), 'test-backend installs without install scripts');
  assert(/concurrency:\s*\n\s+group: update-git-/.test(jobBlock('update-git')), 'update-git runs one at a time');
  assert(/merge-base --is-ancestor "\$GITHUB_SHA" "\$current"/.test(jobBlock('update-git')), 'update-git refuses to write an older tag');
  const fe = jobBlock('test-frontend');
  assert(/npm test/.test(fe) && /check-i18n/.test(fe) && /npm run lint/.test(fe), 'test-frontend runs unit tests, i18n check and lint');
  assert(/\non:\n(?: {2}\S.*\n(?: {4}.*\n)*)* {2}pull_request:/.test(code), 'pull requests run the workflow');
  assert(!code.includes('pull_request_target'), 'PRs never run with the base repository\'s secrets (no pull_request_target)');
  for (const job of ['build-backend', 'build-frontend', 'update-git']) {
    assert(/\n {4}if: \|\n(?: {6}.*\n)*? {6}github\.event_name != 'pull_request' &&/.test(jobBlock(job)), `${job} never runs for a pull request`);
  }
  for (const job of ['test-backend', 'test-frontend']) {
    assert(/github\.event_name != 'push'/.test(jobBlock(job)), `${job} runs for every pull request, not only when its paths changed`);
  }
  console.log('\n🎉 WORKFLOW TESTS PASSED\n');
} catch (err) {
  console.error('\n' + err.message);
  console.error('❌ WORKFLOW TESTS FAILED');
  process.exit(1);
}
