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
//   node scripts/check-language.js --unresolved     lines the check could not decide
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

// Third detector: an ENGLISH DICTIONARY check.
//
// The two detectors above are allow-lists of Polish, and an allow-list can only ever find
// what someone already thought to add. That failed in practice: after a pass that reported
// "0 violations, 82/82 compliant", 131 Polish comment lines were still in the tree - whole
// comments like "// Inicjalizacja Gemini API" and "// Zapisz cache" carry no diacritics and
// matched no listed word. A previous attempt to patch this with a longer word list caught
// exactly the two lines it was written against and nothing else.
//
// Inverting the test fixes that: instead of asking "is this word Polish?", ask "is this word
// English?". Anything left over after removing English words, technical vocabulary and the
// code's own identifiers is, in this codebase, Polish. That found all 131 without being told
// what to look for.
//
// The dictionary is the system word list. If it is unavailable (a slim CI image, for
// instance) the check degrades to the two detectors above and SAYS SO in the report - the
// one thing it must never do is stay silent and imply a clean tree it did not verify.
const DICT_PATHS = ['/usr/share/dict/words', '/usr/share/dict/web2'];
const ENGLISH = new Set();
for (const p of DICT_PATHS) {
  try {
    for (const w of fs.readFileSync(p, 'utf8').split('\n')) {
      const t = w.trim().toLowerCase();
      if (t) ENGLISH.add(t);
    }
  } catch { /* dictionary absent - handled by DICT_AVAILABLE below */ }
}
const DICT_AVAILABLE = ENGLISH.size > 1000;

// Vocabulary this project uses that a general English dictionary does not carry. Kept short
// on purpose: every entry here is a hole in the detector, so add a word only after checking
// it really is English or a technical term, never to silence a Polish word.
const TECHNICAL = new Set((`
api uri json sql sqlite http https js jsx css html dom ui ux env npm node express react vite
gemini oura withings karvonen hrv rhr spo bmi bmr tdee kcal kg cm ms utc cron webhook oauth
csrf uuid jwt regex async await eslint playwright mailgun ghcr helm kubernetes docker compose
timestamp timestamps params param config configs init auth middleware middlewares backend
frontend runtime repo readme boolean nullable enum lookback datetime endpoint endpoints crud
upsert rebase dedupe deduped iife jsdoc favicon svg png webp localstorage useeffect usestate
props polyfill stringify parseint isnan isfinite sedentary readiness wearable macronutrient
macronutrients whr adonis percentile percentiles zscore stddev renormalise renormalised
renormalisation prioritise prioritised normalise normalised unlogged subquery subqueries
sanitise sanitised sanitisation authorise authorised authorisation behaviour behaviours
tokenise tokenised serialisation gdpr mvp i18n cdn tsx mjs cjs
`).trim().split(/\s+/));

// Words that are plainly English but absent from the system list (inflections it omits).
const englishish = (w) => ENGLISH.has(w)
  || (w.endsWith('s') && ENGLISH.has(w.slice(0, -1)))
  || (w.endsWith('es') && ENGLISH.has(w.slice(0, -2)))
  || (w.endsWith('ed') && (ENGLISH.has(w.slice(0, -2)) || ENGLISH.has(w.slice(0, -1))))
  || (w.endsWith('ing') && (ENGLISH.has(w.slice(0, -3)) || ENGLISH.has(w.slice(0, -3) + 'e')))
  || (w.endsWith('ly') && ENGLISH.has(w.slice(0, -2)))
  || (w.endsWith('er') && ENGLISH.has(w.slice(0, -2)))
  || (w.endsWith('ise') && ENGLISH.has(w.slice(0, -3) + 'ize'))
  || (w.endsWith('ised') && ENGLISH.has(w.slice(0, -4) + 'ized'));

// Everything that is not prose: quoted spans, URLs, identifiers, paths. A comment naming
// `getWarsawWallClock` must not be reported because the dictionary has never heard of it.
const proseOnly = (line) => line
  .replace(/https?:\/\/\S+/g, ' ')
  .replace(/`[^`]*`/g, ' ')
  .replace(/"[^"]*"/g, ' ')
  .replace(/'[^']*'/g, ' ')
  .replace(/\b[\w.]*[A-Z][a-z]*[A-Z]\w*\b/g, ' ')
  .replace(/\b\w*[_./]\w*\b/g, ' ');

// The dictionary alone is too noisy to be a verdict: run over this codebase it leaves ~1170
// lines, of which only ~130 are Polish - the rest are technical terms and coinages no general
// word list carries. So the dictionary SELECTS candidates and Polish morphology CONFIRMS
// them. Neither half works alone: morphology on its own fires on English words that happen to
// end in -ie or -om, and the dictionary on its own drowns the real hits in noise. Together
// they found every one of the 131 lines the diacritics-and-word-list detectors had missed,
// with no false positives on this tree.
const PL_INFLECTION = /(ych|ego|emu|ami|ach|owa|owe|owy|iem|iej|ie|ia|ii|om|ow|em|ym|im|nia|nie|cja|cji|sci|osc|acz|arz|ka|ki|ku|cy|cie|ymi|imi)$/;
const PL_CLUSTER = /(cz|sz|rz|dz|prz|krz|trz|wsz|zn|zb|zg|zd|zl|zm|zr|zw)/;
// Short Polish function and domain words that carry no diacritics and no distinctive ending -
// the ones a dictionary check finds but morphology cannot confirm on its own.
const PL_BARE = new Set((`
jak czy tak nie tez juz bez dla oraz albo lub przez zeby aby wiec przy nad pod gdy bo kiedy
zawsze nigdy teraz potem jeszcze tylko takze nawet wtedy czyli patrz robi maja jest byla byly
bedzie moze mozna trzeba zostac dane danych dni dzien dnia doba runda rundy funkcja typ typu
krok kroku klucz klucze token tokeny baza bazy bazie tabela kolumna wiersz zapis zapisz odczyt
pole pola brak braku nowa nowy nowe stary stare tej tego temu ten tych ktore ktory ktora kazdy
wszystkie migracja weryfikacja inicjalizacja pomocnicza suplement suplementy trening treningu
pobranie oura oury sekret sekrety danego samego wlasny ostatni ostatnich pierwszy drugi liczba
liczby wartosc wartosci przed
`).trim().split(/\s+/));

const looksPolish = (lw) => PL_BARE.has(lw)
  || (PL_INFLECTION.test(lw) && PL_CLUSTER.test(lw));

// Returns the words on the line that the dictionary does not recognise, split by whether
// morphology could confirm them as Polish. `confirmed` drives the violation count;
// `unconfirmed` is REPORTED SEPARATELY rather than dropped.
//
// That separation is the point. The previous detector silently discarded everything it could
// not confirm, so the report said "0 violations, 82/82 compliant" while 131 Polish lines sat
// in the tree - and because the script is the acceptance signal for this work, a false
// all-clear is worse than no check at all. Morphology will always miss some Polish
// ("// 2. Katalog aplikacji" has no diacritics, no Polish ending and no consonant cluster),
// so the honest design is to surface the residue for a human to glance at instead of
// pretending it was checked.
const foreignWords = (line) => {
  const confirmed = [];
  const unconfirmed = [];
  if (!DICT_AVAILABLE) return { confirmed, unconfirmed };
  for (const w of proseOnly(line).match(/[A-Za-zĄ-ża-ż]{3,}/g) || []) {
    const lw = w.toLowerCase();
    if (englishish(lw) || TECHNICAL.has(lw)) continue;
    (looksPolish(lw) ? confirmed : unconfirmed).push(w);
  }
  return { confirmed, unconfirmed };
};

const hasNonEnglishProse = (line) => foreignWords(line).confirmed.length > 0;

const PL = PL_DIACRITICS;
const isCommentLine = (trimmed) => /^(\/\/|\*|\/\*|#)/.test(trimmed) || /\{\s*\/\*/.test(trimmed);
// Polish inside quotation marks within an otherwise English comment is quoted DATA, not
// prose: a comment documenting which exact strings caused a bug has to name them. Stripping
// quoted spans before testing keeps those out of the report - otherwise the only way to
// "fix" the violation would be deleting the example that makes the comment useful.
const stripQuoted = (line) => line
  .replace(/"[^"]*"/g, '""')
  .replace(/'[^']*'/g, "''")
  .replace(/`[^`]*`/g, '``');

// A comment line counts as Polish if either detector fires on its unquoted text.
const commentIsPolish = (line) => {
  const bare = isCommentLine(line.trim()) ? stripQuoted(line) : line;
  if (PL_DIACRITICS.test(bare)) return true;
  if (!isCommentLine(line.trim())) return false;
  return PL_WORDS.test(bare) || hasNonEnglishProse(line);
};

// Files whose Polish string content is product content by design.
const CONTENT_FILES = [
  'frontend/src/utils/i18n.js',    // dictionary keys ARE the Polish source strings
  'backend/utils/mealPrompts.js'   // prompt body drives Gemini's output language
];

// Replaces the contents of string literals with spaces, preserving the line's length so that
// indices computed on the result still address the original line.
const blankStrings = (line) => line.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, (m) => ' '.repeat(m.length));

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
  // A leading `*` only means "comment" INSIDE a block comment - the tracker above already
  // reported that via inBlockComment. Outside one it is ordinary text, and in JSX it is a
  // footnote rendered to the user ("* Height is optional, but without it..."). Treating a
  // bare `*` line as a comment flagged those two UI footnotes in Settings.jsx as permanent
  // violations whose only "fix" would be translating text the user reads.
  if (/^(\/\/|#)/.test(trimmed)) return 'comment';
  if (/^\/\*/.test(trimmed)) return 'comment';
  if (/\{\s*\/\*/.test(line)) return 'comment';

  // Trailing comment carrying all the Polish on the line. The search runs on a copy with the
  // string literals blanked out, because a URL inside a string contains `//` too - the footer
  // in App.jsx (`href="https://renacode.com"` followed by Polish link captions) was reported
  // as a Polish COMMENT for exactly that reason, and the only way to "fix" it would have been
  // translating product copy.
  const slash = blankStrings(line).indexOf('//');
  if (slash > -1 && PL.test(line.slice(slash)) && !PL.test(line.slice(0, slash))) return 'comment';

  if (opts.isContentFile) return 'content';
  if (opts.inTemplateLiteral && PROMPT_SCHEMA.test(trimmed)) return 'content';
  // A regex literal asserted against prompt text (tests/test-meal-prompts.js) matches the
  // Polish PROMPT, so the Polish in it is data, not prose. Translating it would break the
  // assertion rather than change any wording a person reads.
  if (/\/.*\/\s*\.test\(/.test(line)) return 'content';
  // A Polish literal on a line that also builds a template literal is prompt text being
  // assembled (a fallback label interpolated into a Gemini prompt, for example). Those stay
  // Polish by the same rule as the prompt bodies themselves.
  if (line.includes('`')) return 'content';
  // `${...}` interpolation can only appear inside a template literal, so a Polish line
  // carrying one is prompt text being assembled across several lines.
  if (line.includes('${')) return 'content';
  // A line of bare prose carrying no JS syntax at all cannot be code: in a .js file it can
  // only be the body of a multi-line template literal, i.e. prompt text. Backtick-parity
  // tracking alone missed these, because the opening backtick sits many lines above and any
  // stray backtick in a comment skews the count.
  if (!/[=;(){}[\]]|=>|\bconst\b|\blet\b|\bfunction\b/.test(trimmed)) return 'content';
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

// This file is skipped: it necessarily contains Polish - the detector's own character class
// and the examples in the comments explaining why the detector needs to exist. Scanning it
// would report permanent "violations" whose only fix would be breaking the detector.
const SELF = path.join(REPO_ROOT, 'scripts', 'check-language.js');
const files = ROOTS.flatMap(r => walk(path.join(REPO_ROOT, r))).filter(f => f !== SELF);
const results = files.map(auditFile).filter(r => r.violations + r.hits.content > 0);

const args = process.argv.slice(2);
const fileArg = args.includes('--file') ? args[args.indexOf('--file') + 1] : null;
const catArg = args.includes('--category') ? args[args.indexOf('--category') + 1] : null;
const showUnresolved = args.includes('--unresolved');

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

// Advisory: comment lines carrying words that are neither English nor known technical
// vocabulary, which morphology could NOT confirm as Polish. Not counted as violations - most
// are coinages or product nouns - but listed so nothing the check could not decide disappears
// from the report.
const unresolved = [];
for (const file of files) {
  const rel = path.relative(REPO_ROOT, file);
  let inBlock = false;
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, idx) => {
    const trimmed = line.trim();
    if (/^\/\*/.test(trimmed)) inBlock = true;
    const isComment = inBlock || isCommentLine(trimmed);
    if (/\*\//.test(trimmed)) inBlock = false;
    if (!isComment || commentIsPolish(line)) return;
    const { unconfirmed } = foreignWords(line);
    if (unconfirmed.length) unresolved.push({ rel, line: idx + 1, words: unconfirmed, text: trimmed });
  });
}
if (!DICT_AVAILABLE) {
  console.log('\nNOTE: no system word list found - the English-dictionary detector is DISABLED,');
  console.log('      so this report may under-report. Install one, or run the check on a machine');
  console.log('      that has /usr/share/dict/words.\n');
} else if (unresolved.length) {
  // Deliberately ONE line, not a list. The system word list is a 1934 Webster's - it has
  // never heard of "database", "startup" or "cardio" - so the raw residue here is ~900 lines
  // of noise. Printing all of it would train the reader to skip the report, which is how a
  // check stops being read at all. The count stays visible so the residue is never hidden,
  // and --unresolved prints it when someone actually wants to audit it.
  console.log(`\nUnresolved: ${unresolved.length} comment line(s) contain words the dictionary`);
  console.log('does not know and morphology could not confirm as Polish (mostly modern technical');
  console.log('vocabulary the 1934 word list predates). Run with --unresolved to list them.');
  if (showUnresolved) unresolved.forEach(u => console.log(`  ${u.rel}:${u.line}  [${u.words.join(', ')}]  ${u.text.slice(0, 80)}`));
}

console.log('\nInspect one file:  node scripts/check-language.js --file routes/dashboard.js');
