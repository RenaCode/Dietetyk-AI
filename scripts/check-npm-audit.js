#!/usr/bin/env node

// Evaluates the output of `npm audit --json` and decides whether to block the pipeline.
//
// Why this script exists: `npm audit` treats ALL "high"/"critical" vulnerabilities alike,
// regardless of whether they affect code that actually runs in production or only tooling
// used by `npm ci` to compile a native binding (the sqlite3 -> node-gyp -> ... chain).
// Build-time tooling NEVER reaches the running application and is never invoked at runtime -
// it is used exactly once, during dependency installation. The only real way to "fix" those
// findings would be bumping sqlite3 to a major version whose prebuilt binary needs a newer
// glibc than the production image (node:20-slim) provides - which actually BROKE production
// (ERR_DLOPEN_FAILED / GLIBC_2.38 not found) when that fix was attempted. Packages from that
// specific, documented chain are therefore explicitly whitelisted below; any OTHER
// high/critical vulnerability, meaning a real runtime dependency, still blocks the pipeline.
//
// Usage: node check-npm-audit.js <audit-file.json> [allowed-package,...]

const fs = require('fs');

const auditPath = process.argv[2];
const allowList = (process.argv[3] || '').split(',').map(s => s.trim()).filter(Boolean);

if (!auditPath) {
  console.error('Usage: node check-npm-audit.js <audit-file.json> [allowed-package,...]');
  process.exit(1);
}

let report;
try {
  report = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
} catch (err) {
  console.error(`Nie udało się odczytać/sparsować ${auditPath}: ${err.message}`);
  process.exit(1);
}

const vulns = report.vulnerabilities || {};
const blocking = [];
const accepted = [];

for (const [pkgName, info] of Object.entries(vulns)) {
  const severity = info.severity;
  if (severity !== 'high' && severity !== 'critical') continue;

  if (allowList.includes(pkgName)) {
    accepted.push(`${pkgName} (${severity})`);
  } else {
    blocking.push(`${pkgName} (${severity})`);
  }
}

if (accepted.length > 0) {
  console.log('Accepted vulnerabilities (the known, documented exception list - build-time only, never at runtime):');
  accepted.forEach(p => console.log(`  - ${p}`));
}

if (blocking.length > 0) {
  console.error('\nBlocking high/critical vulnerabilities (NOT whitelisted):');
  blocking.forEach(p => console.error(`  - ${p}`));
  console.error('\nnpm audit failed. If this is a new, real vulnerability in a runtime dependency, fix it (update the package).');
  process.exit(1);
}

console.log('\nOK - no blocking high/critical vulnerabilities outside the accepted list.');
process.exit(0);
