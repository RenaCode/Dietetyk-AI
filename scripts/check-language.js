#!/usr/bin/env node
// Language audit for the rule in CLAUDE.md: all code and comments in English.
//
// Why this exists as a script rather than a one-off count: the codebase predates
// the rule, so the interesting number is not "how much Polish is there" but "how
// much of it is a violation". Those are very different figures. Polish UI text,
// API error messages shown to the user, the i18n dictionary and the AI prompt
// bodies are product content and stay Polish by design; comments, log messages
// and identifiers must not be.
//
// Usage:
//   node scripts/check-language.js              summary + worst files
//   node scripts/check-language.js --file <p>   every flagged line in one file
//   node scripts/check-language.js --category comment|log|identifier
//
// Exit code is always 0: this is a progress report, not a gate. Failing the build
// on ~2800 pre-existing Polish comments would only mean disabling the check.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const ROOTS = ['backend', 'frontend/src', 'frontend/scripts', 'scripts', 'e2e-tests', '.github'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'public', 'dist', 'backups', 'assets']);
const EXT = /\.(js|jsx|sh|yml|yaml)$/;

// Two detectors, because one is not enough.
//
// Diacritics catch most Polish, but plenty of real sentences carry none at all -
// "co przy uwierzytelnianiu tokenem Bearer nie jest krytyczne" has not a single
// ą/ć/ę. During the translation pass this blind spot reported several files as
// fully compliant while half their comment blocks were still Polish, and it hid
// blocks left half-translated mid-sentence. A checker that under-reports is worse
// than no checker, because it is believed.
//
// The word list is therefore applied as a second pass. An earlier comment here
// argued that word matching produces too many false positives ("nie" inside
// "denied"); that concern was overstated - \b word boundaries make "denied" a
// non-match. To keep the remaining risk low the word list runs ONLY on comment
// lines, never on code or strings, where an English identifier could collide.
const PL_DIACRITICS = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/;
const PL_WORDS = /\b(nie|jest|sie|dla|przez|zeby|tego|ktore|ktory|oraz|albo|jako|tylko|takze|wiec|bez|przy|jednak|zawsze|nigdy|teraz|potem|kazdy|wszystkie|dane|uzytkownik|posilek|zdjecie|dzien|godzina|kopia|jesli|mozna|trzeba|byla|byly|zostac|moze|nawet|wtedy|czyli|patrz|robi|maja|ma to|do tego)\b/i;

const PL = PL_DIACRITICS;
const isCommentLine = (trimmed) => /^(\/\/|\*|\/\*|#)/.test(trimmed) || /\{\s*\/\*/.test(trimmed);
// A comment line counts as Polish if either detector fires.
const commentIsPolish = (line) => {
  if (PL_DIACRITICS.test(line)) return true;
  return isCommentLine(line.trim()) && PL_WORDS.test(line);
};

// Files whose Polish string content is product content by design.
const CONTENT_FILES = [
  'frontend/src/utils/i18n.js',    // dictionary keys ARE the Polish source strings
  'backend/utils/mealPrompts.js'   // prompt body drives Gemini's output language
];

const LOG_CALL = /(console\.(log|warn|error|info|debug)|logger\.(info|warn|error|debug))\s*\(/;
const API_ERROR = /res\.(status\(\d+\)\.)?json\(\s*\{\s*error|throw new Error|error:\s*['"]/;
// A line that is part of a JSON schema description inside an AI prompt, e.g.
//   "protein": (number - grams of protein),
const PROMPT_SCHEMA = /^\s*"?[a-z_]+"?\s*:\s*[("']|^\s*-\s|^\s*[A-ZŚŻ]{2,}/;

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (EXT.test(entry.name)) out.push(full);
  }
  return out;
}

const CATEGORIES = {
  comment: { violation: true, label: 'Comments' },
  log: { violation: true, label: 'Log / console messages' },
  identifier: { violation: true, label: 'Identifiers' },
  content: { violation: false, label: 'Product content (UI, API errors, prompts, i18n)' }
};

// Classify a Polish-bearing line. Heuristic, not a parser - good enough to size
// the work and point at files, but a prompt body split across many lines can
// still land in the wrong bucket. Treat single-line verdicts as advisory.
function classify(line, inBlockComment, opts) {
  const trimmed = line.trim();

  if (inBlockComment) return 'comment';
  if (/^(\/\/|\*|#)/.test(trimmed)) return 'comment';
  if (/^\/\*/.test(trimmed)) return 'comment';
  if (/\{\s*\/\*/.test(line)) return 'comment';

  // Trailing comment carrying all the Polish on the line.
  const slash = line.indexOf('//');
  if (slash > -1 && PL.test(line.slice(slash)) && !PL.test(line.slice(0, slash))) return 'comment';

  if (opts.isContentFile) return 'content';
  if (opts.inTemplateLiteral && PROMPT_SCHEMA.test(trimmed)) return 'content';
  // A regex literal asserted against prompt text (tests/test-meal-prompts.js) matches the
  // Polish PROMPT, so the Polish in it is data, not prose. Translating it would break the
  // assertion rather than change any wording a person reads.
  if (/\/.*\/\s*\.test\(/.test(line)) return 'content';
  if (LOG_CALL.test(line)) return 'log';
  if (API_ERROR.test(line)) return 'content';

  // Polish outside any string literal. In .jsx that is almost always a JSX text
  // node (user-visible); in .js inside a template literal it is prompt text.
  const withoutStrings = line.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '');
  if (PL.test(withoutStrings)) {
    if (opts.isJsx || opts.inTemplateLiteral) return 'content';
    return 'identifier';
  }
  return 'content';
}

function auditFile(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const rel = path.relative(REPO_ROOT, file);
  const isContentFile = CONTENT_FILES.some(c => rel.replace(/\\/g, '/').endsWith(c));
  const isJsx = /\.jsx$/.test(file);

  const hits = { comment: 0, log: 0, identifier: 0, content: 0 };
  const flagged = [];
  let inBlockComment = false;
  let backtickDepth = 0;

  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    const opensBlock = /^\/\*/.test(trimmed);
    const wasBlock = inBlockComment || opensBlock;
    if (opensBlock) inBlockComment = true;
    if (/\*\//.test(trimmed)) inBlockComment = false;

    const wasInTemplate = backtickDepth % 2 === 1;
    backtickDepth += (line.match(/`/g) || []).length;

    if (!commentIsPolish(line)) return;

    const category = classify(line, wasBlock, {
      isContentFile, isJsx, inTemplateLiteral: wasInTemplate
    });
    hits[category]++;
    flagged.push({ line: idx + 1, category, text: trimmed });
  });

  const violations = hits.comment + hits.log + hits.identifier;
  return { file: rel, hits, violations, flagged, total: lines.length };
}

const files = ROOTS.flatMap(r => walk(path.join(REPO_ROOT, r)));
const results = files.map(auditFile).filter(r => r.violations + r.hits.content > 0);

const args = process.argv.slice(2);
const fileArg = args.includes('--file') ? args[args.indexOf('--file') + 1] : null;
const catArg = args.includes('--category') ? args[args.indexOf('--category') + 1] : null;

if (fileArg) {
  const match = results.find(r => r.file.endsWith(fileArg));
  if (!match) {
    console.log(`No Polish found in a file matching "${fileArg}" (or the file is not scanned).`);
    process.exit(0);
  }
  console.log(`=== ${match.file} ===\n`);
  match.flagged
    .filter(f => !catArg || f.category === catArg)
    .forEach(f => console.log(`${String(f.line).padStart(5)}  [${f.category.padEnd(10)}] ${f.text.slice(0, 110)}`));
  process.exit(0);
}

const totals = { comment: 0, log: 0, identifier: 0, content: 0 };
results.forEach(r => Object.keys(totals).forEach(k => { totals[k] += r.hits[k]; }));
const totalViolations = totals.comment + totals.log + totals.identifier;
const withViolations = results.filter(r => r.violations > 0).sort((a, b) => b.violations - a.violations);

console.log('=== LANGUAGE AUDIT ===');
console.log('Rule (CLAUDE.md): all code and comments in English.\n');
console.log(`Files scanned:          ${files.length}`);
console.log(`Files with violations:  ${withViolations.length}`);
console.log(`Fully compliant files:  ${files.length - withViolations.length}\n`);

console.log('VIOLATIONS — must become English:');
for (const key of ['comment', 'log', 'identifier']) {
  console.log(`  ${CATEGORIES[key].label.padEnd(24)} ${String(totals[key]).padStart(5)}`);
}
console.log(`  ${'TOTAL'.padEnd(24)} ${String(totalViolations).padStart(5)}\n`);
console.log(`ALLOWED — ${CATEGORIES.content.label}: ${totals.content}\n`);

console.log('--- FILES BY VIOLATION COUNT ---');
console.log(' viol  comm   log ident | file');
withViolations.slice(0, 25).forEach(r => console.log(
  `${String(r.violations).padStart(5)} ${String(r.hits.comment).padStart(5)} ` +
  `${String(r.hits.log).padStart(5)} ${String(r.hits.identifier).padStart(5)} | ${r.file}`
));
const rest = withViolations.slice(25);
if (rest.length) {
  console.log(`      ... and ${rest.length} more files (${rest.reduce((s, r) => s + r.violations, 0)} violations)`);
}

console.log('\nInspect one file:  node scripts/check-language.js --file routes/dashboard.js');
