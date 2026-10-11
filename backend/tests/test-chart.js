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
//   NetworkPolicy (2026-10-03) on by default: backend :3000 only from the frontend, frontend
//       :8080 only from Traefik in kube-system; egress everywhere except the home network.
//   S-K1 (2026-10-10) the frontend nginx runs as non-root on 8080, read-only, no capabilities.
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

function render(...args) {
  const chartDir = path.join(__dirname, '..', '..', 'charts', 'dietetyk');
  try {
    return execFileSync('helm', ['template', 'dietetyk', chartDir, ...args], { encoding: 'utf8' });
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
  // D-1 (2026-10-04): the error log printed the raw request line with the sync_token.
  assert(/^\s*error_log \/dev\/stderr error;/m.test(nginx), 'the error log is at level error (no request-line warnings)');
  assert(/location \/api \{[^}]*client_body_buffer_size 1m;/.test(nginx), 'webhook bodies up to 1 MB stay in memory');
  const frontend = find('Deployment', 'dietetyk-frontend');
  assert(/checksum\/nginx-config: [0-9a-f]{64}/.test(frontend), 'a config change rolls the frontend pod (subPath mounts never update)');

  // D-14 (2026-10-04).
  console.log('\n--- TEST: pod hardening ---');
  assert(/automountServiceAccountToken: false/.test(backend) && /automountServiceAccountToken: false/.test(frontend), 'neither pod mounts a ServiceAccount token');
  assert(/readinessProbe:\s*\n\s*httpGet:\s*\n\s*path: \/\s*\n\s*port: 8080\n/.test(frontend), 'the frontend has a readinessProbe on / :8080');

  // S-K1 (audit 2026-10-10): the internet-facing nginx ran as root with default capabilities
  // and a writable root filesystem. Every port below has to agree, or the site answers 502
  // (Traefik -> Service targetPort -> containerPort/listen -> NetworkPolicy).
  console.log('\n--- TEST: frontend runs as non-root on 8080 ---');
  assert(/runAsNonRoot: true/.test(frontend) && /runAsUser: 101\n/.test(frontend), 'the frontend pod runs as non-root uid 101 (also on the previous nginx:alpine image)');
  assert(/allowPrivilegeEscalation: false/.test(frontend) && /readOnlyRootFilesystem: true/.test(frontend) && /capabilities:\s*\n\s*drop: \[ALL\]/.test(frontend), 'the frontend container: no escalation, read-only root, no capabilities');
  for (const dir of ['/tmp', '/var/cache/nginx', '/run']) {
    assert(new RegExp(`mountPath: ${dir.replace(/\//g, '\\/')}\n`).test(frontend), `${dir} is a writable emptyDir`);
  }
  const listen = (nginx.match(/^\s*listen (\d+);/m) || [])[1];
  assert(listen === '8080', 'nginx listens on 8080');
  assert(new RegExp(`containerPort: ${listen}\\n`).test(frontend), 'containerPort matches the nginx listen port');
  const frontendService = find('Service', 'dietetyk-frontend');
  assert(/- port: 80\n\s*targetPort: 8080\n/.test(frontendService), 'the Service keeps port 80 for the Ingress and targets 8080');
  const dockerfile = require('fs').readFileSync(path.join(__dirname, '..', '..', 'docker', 'frontend.Dockerfile'), 'utf8');
  assert(/^FROM nginxinc\/nginx-unprivileged:[^\s]+@sha256:[0-9a-f]{64}$/m.test(dockerfile) && /^EXPOSE 8080$/m.test(dockerfile), 'the image is nginx-unprivileged (pinned by digest) and exposes 8080');
  assert(/livenessProbe:[^]*?failureThreshold: 6/.test(frontend), 'the frontend has a tolerant livenessProbe');

  // D-13 (2026-10-04): port 80 answered a bare 404.
  console.log('\n--- TEST: HTTP -> HTTPS redirect ---');
  const redirect = find('Middleware', 'dietetyk-redirect-https');
  assert(/redirectScheme:\s*\n\s*scheme: https\s*\n\s*permanent: true/.test(redirect), 'a redirectScheme middleware exists');
  const httpIngress = find('Ingress', 'dietetyk-http-redirect');
  assert(/router\.entrypoints: web\n/.test(httpIngress) && /router\.middlewares: default-dietetyk-redirect-https@kubernetescrd/.test(httpIngress), 'a web-entrypoint Ingress uses it');
  assert(!/tls:/.test(httpIngress), 'the redirect Ingress requests no second certificate');

  console.log('\n--- TEST: NetworkPolicy ---');
  const backendPolicy = find('NetworkPolicy', 'dietetyk-backend');
  const frontendPolicy = find('NetworkPolicy', 'dietetyk-frontend');
  assert(backendPolicy && frontendPolicy, 'both NetworkPolicies render by default (networkPolicy.enabled: true)');
  assert(/podSelector:\s*\n\s*matchLabels:[^]*?app\.kubernetes\.io\/component: backend\s*\n\s*policyTypes/.test(backendPolicy), 'the backend policy selects the backend pod');
  assert(/from:\s*\n\s*- podSelector:\s*\n\s*matchLabels:[^]*?app\.kubernetes\.io\/component: frontend\s*\n\s*ports:/.test(backendPolicy) && !/namespaceSelector/.test(backendPolicy), 'the backend admits only the frontend pod from its own namespace');
  assert((backendPolicy.match(/- port: \d+/g) || []).join() === '- port: 3000', 'the backend admits port 3000 only - not the sqlite-web sidecar on 8080');
  assert(/namespaceSelector:\s*\n\s*matchLabels:\s*\n\s*kubernetes\.io\/metadata\.name: kube-system\s*\n\s*podSelector:\s*\n\s*matchLabels:\s*\n\s*app\.kubernetes\.io\/name: traefik/.test(frontendPolicy), 'the frontend admits Traefik from kube-system (one peer: namespace AND pod)');
  assert((frontendPolicy.match(/- port: \d+/g) || []).join() === '- port: 8080', 'the frontend admits the pod port 8080 only');
  assert(![backendPolicy, frontendPolicy].some(p => /Egress|egress:/.test(p)), 'the policies restrict ingress only');
  const egressPolicy = find('NetworkPolicy', 'dietetyk-egress');
  assert(/podSelector:\s*\n\s*matchLabels:\s*\n\s*app\.kubernetes\.io\/name: dietetyk\s*\n\s*app\.kubernetes\.io\/instance: dietetyk\s*\n\s*policyTypes:\s*\n\s*- Egress\s*\n/.test(egressPolicy), 'one egress policy covers both pods (no component label in the selector)');
  assert(/protocol: UDP, port: 53/.test(egressPolicy) && /protocol: TCP, port: 53/.test(egressPolicy), 'egress allows DNS over UDP and TCP');
  assert(/- to:\s*\n\s*- namespaceSelector: \{\}/.test(egressPolicy), 'egress allows every pod in the cluster');
  // P-D4 (2026-10-04): the repository is public, so the blocked CIDRs are NOT in values.yaml -
  // the cluster operator sets them in the Argo CD valuesObject. The default renders a plain
  // 0.0.0.0/0 (no `except: []`, which is pointless at best), and a list renders as `except`.
  assert(/cidr: 0\.0\.0\.0\/0\s*\n(?!\s*except)/.test(egressPolicy), 'with the default empty list the internet rule has no except');
  const withPrivate = render('--set-json', 'networkPolicy.egress.siecDomowa=["192.0.2.0/24","198.51.100.0/24"]');
  const egressWithPrivate = withPrivate.split(/^---$/m).find(d => /^ {2}name: dietetyk-egress$/m.test(d)) || '';
  assert(/cidr: 0\.0\.0\.0\/0\s*\n\s*except:\s*\n\s*- 192\.0\.2\.0\/24\s*\n\s*- 198\.51\.100\.0\/24/.test(egressWithPrivate), 'an operator list renders as except on the internet rule');
  assert(!/cidr: (192\.0\.2|198\.51\.100)\./.test(egressWithPrivate), 'no rule opens any of the listed networks');
  const noEgress = render('--set', 'networkPolicy.egress.enabled=false');
  assert(!/name: dietetyk-egress/.test(noEgress) && /name: dietetyk-backend\n/.test(noEgress), 'networkPolicy.egress.enabled=false drops only the egress policy');
  const disabled = render('--set', 'networkPolicy.enabled=false');
  assert(!/^kind: NetworkPolicy$/m.test(disabled), 'networkPolicy.enabled=false renders no policy (quick rollback)');

  console.log('\n--- TEST: SSO (Authelia) only in front of /api/admin ---');
  assert(!/authelia/.test(rendered) && !/^kind: IngressRoute$/m.test(rendered), 'by default nothing goes behind SSO');
  const sso = render('--set', 'sso.enabled=true');
  const ssoDocs = sso.split(/^---$/m);
  const route = ssoDocs.find(d => /^kind: IngressRoute$/m.test(d)) || '';
  assert(/match: Host\(`dietetyk\.renacode\.com`\) && PathRegexp\(`\(\?i\)\^\/api\/admin`\)/.test(route), 'the admin route matches /api/admin case-insensitively (Express routes ignore case)');
  assert(/middlewares:\s*\n\s*- name: authelia-sso\s*\n\s*namespace: default/.test(route), 'the admin route goes through the Authelia forwardAuth middleware');
  assert(/entryPoints:\s*\n\s*- websecure/.test(route) && /secretName: dietetyk-tls-cert/.test(route), 'HTTPS only, with the main certificate');
  assert(!/cert-manager\.io\/cluster-issuer:/.test(route), 'the route requests no second certificate');
  const mainWithSso = ssoDocs.find(d => /^kind: Ingress$/m.test(d) && /^ {2}name: dietetyk$/m.test(d)) || '';
  assert(!/authelia/.test(mainWithSso) && /path: \//.test(mainWithSso), 'the public Ingress (users, Apple Health, OAuth callbacks, shared reports) stays without SSO');
  assert(ssoDocs.filter(d => /authelia/.test(d)).length === 1, 'exactly one object references Authelia');
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
