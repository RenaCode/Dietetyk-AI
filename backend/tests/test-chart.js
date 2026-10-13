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
  // 2026-10-05: after a node reboot nginx resolved the literal backend host in proxy_pass at
  // start, before cluster DNS answered, and did not come up. Starting with no DNS at all is
  // checked by scripts/check-nginx-chart.sh (nginx -t with --network none, CI job test-chart).
  // `server ... resolve` rather than a variable in proxy_pass: a variable needs DNS again after
  // every `valid` (502 on all of /api during a CoreDNS restart), the upstream keeps the last
  // good address.
  const upstream = (nginx.match(/upstream dietetyk_backend \{[^}]*\}/) || [''])[0];
  assert(/zone dietetyk_backend \d+k;/.test(upstream) && /\n\s*resolver 10\.43\.0\.10 valid=\d+s ipv6=off;/.test(upstream), 'upstream dietetyk_backend has a zone and a resolver given as an IP (kube-dns), not a hostname');
  assert((upstream.match(/^\s*server .*$/gm) || []).join() === '        server dietetyk-backend.default.svc.cluster.local:3000 resolve;', 'its only server is the backend FQDN, re-resolved at run time');
  assert(/location \/api \{[^}]*\n\s*proxy_pass http:\/\/dietetyk_backend;/.test(nginx), 'location /api proxies to that upstream, with no URI part (request URI passed unchanged)');
  assert(/proxy_pass http:\/\/dietetyk_backend;\n(\s*#.*\n)*\s*proxy_redirect http:\/\/dietetyk-backend:3000\/ \/;/.test(nginx), 'every absolute Location under the backend Service is still rewritten to this host (as the literal proxy_pass did)');
  assert((nginx.match(/^\s*proxy_pass .*$/gm) || []).every(l => /proxy_pass http:\/\/dietetyk_backend;/.test(l)), 'no proxy_pass with a literal host:port (resolved at start)');
  const otherNs = render('-n', 'apps', '--set', 'frontend.nginx.resolver=192.0.2.53');
  assert(/server dietetyk-backend\.apps\.svc\.cluster\.local:3000 resolve;/.test(otherNs) && /resolver 192\.0\.2\.53 /.test(otherNs), 'the FQDN follows the release namespace and the resolver comes from values');
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
  // Peers are listed by component: the frontend always, the catering sync job when
  // catering.enabled (it posts to the import endpoint directly). Compared as an exact set, so
  // any third peer - or a namespaceSelector widening one - still fails here.
  const peersOf = (policy) => [...policy.matchAll(/- from:\s*\n\s*- podSelector:\s*\n\s*matchLabels:[^]*?app\.kubernetes\.io\/component: ([\w-]+)\s*\n\s*ports:/g)].map(m => m[1]).sort().join(',');
  const expectedPeers = find('CronJob', 'dietetyk-catering-sync') ? 'catering-sync,frontend' : 'frontend';
  assert(peersOf(backendPolicy) === expectedPeers && !/namespaceSelector/.test(backendPolicy), `the backend admits exactly [${expectedPeers}] from its own namespace (got [${peersOf(backendPolicy)}])`);
  const withoutCatering = render('--set', 'catering.enabled=false').split(/^---$/m)
    .find(d => /^kind: NetworkPolicy$/m.test(d) && /^ {2}name: dietetyk-backend$/m.test(d)) || '';
  assert(peersOf(withoutCatering) === 'frontend', 'with catering off, the frontend is the backend\'s only peer again');
  assert((backendPolicy.match(/- port: \d+/g) || []).every(p => p === '- port: 3000'), 'the backend admits port 3000 only - not the sqlite-web sidecar on 8080');
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

  console.log('\n--- TEST: SSO (Authelia) in front of the whole host, machine paths beside it ---');
  assert(!/authelia/.test(rendered) && !/^kind: IngressRoute$/m.test(rendered), 'by default nothing goes behind SSO');
  const sso = render('--set', 'sso.enabled=true');
  const ssoDocs = sso.split(/^---$/m);
  const main = ssoDocs.find(d => /^kind: Ingress$/m.test(d) && /^ {2}name: dietetyk$/m.test(d)) || '';
  assert(/router\.middlewares: default-authelia-naglowki@kubernetescrd,default-authelia-sso@kubernetescrd\n/.test(main), 'the main Ingress strips client identity headers, then goes through Authelia');
  assert(/cert-manager\.io\/cluster-issuer: letsencrypt-prod/.test(main) && /router\.entrypoints: websecure/.test(main), 'the main Ingress keeps its other annotations');
  const route = ssoDocs.find(d => /^kind: IngressRoute$/m.test(d)) || '';
  const matches = (route.match(/match: .*/g) || []);
  assert(matches.length === 2, 'exactly two machine routes');
  assert(/Method\(`POST`\) && PathRegexp\(`\^\/api\/integrations\/apple-health\/\[A-Za-z0-9_-\]\{16,128\}\$`\)/.test(matches[0]), 'Apple Health webhook: POST and the whole token-shaped path only');
  assert(/\(Method\(`GET`\) \|\| Method\(`HEAD`\)\) && PathRegexp\(`\^\/api\/public\/shared-reports\/\[A-Za-z0-9_-\]\{16,128\}\$`\)/.test(matches[1]), 'shared report: GET/HEAD and the whole token-shaped path only');
  assert(!/authelia-sso/.test(route) && (route.match(/name: authelia-naglowki/g) || []).length === 2, 'machine routes skip forwardAuth but still strip identity headers');
  assert(/secretName: dietetyk-tls-cert/.test(route) && !/cert-manager\.io\/cluster-issuer:/.test(route), 'HTTPS with the main certificate, no second certificate');
  const ssoRedirect = ssoDocs.find(d => /^ {2}name: dietetyk-http-redirect$/m.test(d)) || '';
  assert(!/authelia/.test(ssoRedirect), 'the HTTP->HTTPS redirect needs no SSO (it never reaches the app)');

  // The app trusts Remote-* headers only with SSO_NAGLOWKI=1 (backend/services/ssoIdentity.js).
  // The same switch must set it - never trust without the stripping middleware, never the
  // middleware without the app reading who is logged in.
  const backendDoc = (docs) => docs.find(d => /^kind: Deployment$/m.test(d) && /^ {2}name: dietetyk-backend$/m.test(d)) || '';
  const ssoBackend = backendDoc(ssoDocs);
  assert(/- name: SSO_NAGLOWKI\n\s*value: "1"/.test(ssoBackend), 'sso.enabled sets SSO_NAGLOWKI=1 in the backend pod');
  assert(/- name: SSO_LOGOUT_URL\n\s*value: "https:\/\/auth\.renacode\.com\/logout\?rd=https%3A%2F%2Fdietetyk\.renacode\.com%2F"/.test(ssoBackend), 'and the portal logout URL returning to this host');
  assert(/- name: SSO_GRUPY\n\s*value: "wlasciciel,rodzina,admins,dietetyk"/.test(ssoBackend), 'and the admitted groups from sso.allowedGroups');
  assert(!/SSO_/.test(backendDoc(rendered.split(/^---$/m))), 'by default the backend gets no SSO variable at all');
  const frontendSso = ssoDocs.find(d => /^kind: Deployment$/m.test(d) && /^ {2}name: dietetyk-frontend$/m.test(d)) || '';
  assert(frontendSso && !/SSO_NAGLOWKI/.test(frontendSso), 'only the backend reads the flag');
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
