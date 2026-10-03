#!/usr/bin/env node

// Evaluates the output of `npm audit --json` and decides whether to block the pipeline.
//
// Why this script exists: `npm audit` treats ALL "high"/"critical" vulnerabilities alike,
// and occasionally a finding genuinely cannot be fixed yet (no patched release, or the fix
// needs a breaking upgrade that has to be scheduled). This script lets CI whitelist such a
// package BY NAME, with the justification written next to the call in
// .github/workflows/docker-publish.yml; any other high/critical vulnerability still blocks
// the pipeline.
//
// The backend list is empty since sqlite3@6: every former exception (tar, node-gyp,
// make-fetch-happen, cacache, http-proxy-agent, @tootallnate/once, brace-expansion,
// ip-address, sqlite3 itself) came from the sqlite3@5 -> node-gyp@8 chain. Note that those
// were not "build-time only" either - tar ships in the production image's node_modules.
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
