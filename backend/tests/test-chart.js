// Assertions on the rendered Helm chart (charts/dietetyk) - the parts of the 2026-10 audit
// fixes that live in Kubernetes manifests and the nginx config rather than in Node code:
//
//   M8  backend Deployment uses strategy Recreate (two pods on one SQLite file sent every
//       summary twice and raced rotating OAuth refresh tokens) and has a startupProbe.
//   L2  nginx sends HSTS and a CSP; the backend container runs as non-root without privilege
//       escalation.
//   L3  nginx passes on Traefik's X-Forwarded-Proto instead of overwriting it with `http`.
//   M4  nginx logs neither query strings nor the token-bearing paths, and the registration
//       page (whose URL carries the invitation token) sends no Referer.
//
// Needs the `helm` binary. Where it is missing (a CI image without it) the test says so and
// passes, rather than failing the whole backend suite for a tool it does not otherwise use.
//
// Run with: node tests/test-chart.js

const { execFileSync } = require('child_process');
const path = require('path');

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

function render() {
  const chartDir = path.join(__dirname, '..', '..', 'charts', 'dietetyk');
  try {
    return execFileSync('helm', ['template', 'dietetyk', chartDir], { encoding: 'utf8' });
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function run() {
  const rendered = render();
  if (rendered === null) {
    console.log('⚠️  helm not found - chart assertions skipped');
    return;
  }
  const docs = rendered.split(/^---$/m);
  const find = (kind, name) => docs.find(d => new RegExp(`^kind: ${kind}$`, 'm').test(d) && new RegExp(`^  name: ${name}$`, 'm').test(d)) || '';

  console.log('\n--- TEST: backend Deployment ---');
  const backend = find('Deployment', 'dietetyk-backend');
  assert(/strategy:\s*\n\s*type: Recreate/.test(backend), 'strategy.type is Recreate');
  assert(/startupProbe:\s*\n\s*httpGet:\s*\n\s*path: \/api\/healthz/.test(backend), 'a startupProbe on /api/healthz is defined');
  assert(/runAsNonRoot: true/.test(backend) && /allowPrivilegeEscalation: false/.test(backend), 'the backend container runs as non-root without privilege escalation');

  console.log('\n--- TEST: nginx config ---');
  const nginx = find('ConfigMap', 'dietetyk-nginx-config');
  assert(/add_header Strict-Transport-Security "max-age=\d+/.test(nginx), 'HSTS header is set');
  assert(/add_header Content-Security-Policy "default-src 'self';[^"]*frame-ancestors 'none'/.test(nginx), 'a CSP with frame-ancestors is set');
  assert(/add_header Referrer-Policy "no-referrer"/.test(nginx), 'Referrer-Policy is no-referrer');
  assert(!/proxy_set_header X-Forwarded-Proto \$scheme;/.test(nginx), 'X-Forwarded-Proto is no longer overwritten with $scheme');
  assert(/access_log \S+ dietetyk_safe;/.test(nginx), 'the access log uses the query-free format');
  assert(!/log_format dietetyk_safe[^;]*\$request[ "']/.test(nginx) && !/log_format dietetyk_safe[^;]*\$http_referer/.test(nginx), 'that format contains neither $request nor $http_referer');
}

try {
  run();
  console.log('\n🎉 CHART TESTS PASSED\n');
  process.exit(0);
} catch (err) {
  console.error('\n' + err.message);
  console.error('❌ CHART TESTS FAILED');
  process.exit(1);
}
