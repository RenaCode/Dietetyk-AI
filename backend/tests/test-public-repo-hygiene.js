// The repository is PUBLIC (audit 2026-10-04, D-7). Until that audit it carried the owner's
// home public IP address in a comment, the home LAN and VPN tunnel CIDRs with the device names
// behind them in the Helm values, and a private e-mail address in a runbook - together a
// ready-made reconnaissance map for anyone who gets a foothold in any pod on the cluster.
// The CIDRs now live in the private infra repository (Argo CD valuesObject).
//
// This scans every TRACKED file (git ls-files) for:
//   - 192.168.x.x and any 10.x.x.x outside the k3s pod and service ranges (10.42/16,
//     10.43/16) - home LAN and VPN addresses look exactly like that,
//   - any public IPv4 address - only the k3s ranges, 172.16/12, loopback and the
//     documentation ranges (RFC 5737: 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24) pass,
//   - e-mail addresses outside example domains, .invalid/.local and noreply addresses,
//   - the first names of the owner's household (audit 2026-10-11): they had leaked into a
//     variable name, two code comments and two form placeholders. The names are compared as
//     SHA-256 digests of lower-cased words, so this test does not publish them itself.
//     LICENSE is exempt - the copyright line names the author on purpose.
// Lockfiles are skipped (package versions look like IPs and contain registry URLs only).
//
// Run with: node tests/test-public-repo-hygiene.js

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ${message}`);
  }
  console.log(`✅ ${message}`);
}

function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean);
  } catch (err) {
    return null;
  }
}

const SKIP = /(^|\/)package-lock\.json$|\.(png|jpe?g|gif|ico|woff2?|ttf|pdf|db)$/i;

const PERSONAL_NAME_DIGESTS = new Set([
  '62552a91170383e3b54de21d508898927c9382c9c772109a9cc51677f4d37333',
  'e89615782c18608d91e649ba5ebd1fe903e4aa2ca42f9fe1addb6661c17530b3'
]);

// Words of a line, camelCase split too, so `defaultXyzSettings` yields `xyz`.
function wordsOf(line) {
  return line
    .replace(/([a-ząćęłńóśźż])([A-ZĄĆĘŁŃÓŚŹŻ])/g, '$1 $2')
    .split(/[^A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

function isPersonalName(word) {
  return PERSONAL_NAME_DIGESTS.has(crypto.createHash('sha256').update(word).digest('hex'));
}

function isAllowedIp(ip) {
  const [a, b, c] = ip.split('.').map(Number);
  if ([a, b, c, Number(ip.split('.')[3])].some((n) => n > 255)) return true; // not an IP
  if (a === 10) return b === 42 || b === 43;
  if (a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return false;
}

function isAllowedEmail(email) {
  const [local, domain] = email.toLowerCase().split('@');
  if (local === 'noreply' || domain === 'users.noreply.github.com') return true;
  if (/(^|\.)example\.(com|org|net)$/.test(domain)) return true;
  if (/\.(invalid|local|test|example)$/.test(domain)) return true;
  return false;
}

function run() {
  const files = trackedFiles();
  if (files === null) {
    console.log('⚠️  not a git checkout - public repo hygiene check skipped');
    return;
  }
  const badIps = [];
  const badEmails = [];
  const badNames = [];
  for (const rel of files) {
    if (SKIP.test(rel)) continue;
    const checkNames = rel !== 'LICENSE';
    const full = path.join(root, rel);
    let text;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch (err) {
      continue;
    }
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])/g)) {
        if (!isAllowedIp(m[1])) badIps.push(`${rel}:${i + 1} ${m[1]}`);
      }
      for (const m of line.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g)) {
        if (!isAllowedEmail(m[0])) badEmails.push(`${rel}:${i + 1} ${m[0]}`);
      }
      if (checkNames && wordsOf(line).some(isPersonalName)) badNames.push(`${rel}:${i + 1}`);
    });
  }
  assert(badIps.length === 0, `no home/VPN or public IPv4 address in tracked files${badIps.length ? ':\n   ' + badIps.join('\n   ') : ''}`);
  assert(badEmails.length === 0, `no real e-mail address in tracked files${badEmails.length ? ':\n   ' + badEmails.join('\n   ') : ''}`);
  assert(wordsOf('defaultAbcSettings').join(' ') === 'default abc settings', 'the name check splits camelCase words');
  assert(badNames.length === 0, `no household first name in tracked files (LICENSE exempt)${badNames.length ? ':\n   ' + badNames.join('\n   ') : ''}`);
}

try {
  console.log('=== PUBLIC REPO HYGIENE TESTS ===');
  run();
  console.log('\n🎉 PUBLIC REPO HYGIENE TESTS PASSED\n');
  process.exit(0);
} catch (err) {
  console.error('\n' + err.message);
  console.error('❌ PUBLIC REPO HYGIENE TESTS FAILED');
  process.exit(1);
}
