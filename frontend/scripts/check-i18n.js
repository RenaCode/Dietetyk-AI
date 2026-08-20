#!/usr/bin/env node
// Translation consistency check: whether every text passed to t() has a matching dictionary
// entry, and whether the dictionary still holds entries nobody uses.
//
// Why: the translation key is the Polish sentence itself, so a copy change breaks the
// translation SILENTLY - in English mode the Polish text simply appears. There is no error,
// no exception, not even different application behaviour.
// This script turns that silent failure into a build error.
//
// Usage:
//   npm run check-i18n           # report, exit code 1 when anything is missing
//   npm run check-i18n -- --fix  # appends the missing keys to i18n.js as TODOs

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC_DIR = path.join(__dirname, '..', 'src');
const I18N_FILE = path.join(SRC_DIR, 'utils', 'i18n.js');

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (/\.(jsx?|tsx?)$/.test(entry.name)) files.push(full);
  }
  return files;
}

// Extracts the literals passed to t(). We deliberately handle ONLY literals (single quotes,
// double quotes, backticks without interpolation) - t(variable) cannot be checked statically
// and is reported separately as a warning.
function extractCalls(source) {
  const literals = new Set();
  const dynamic = [];

  const literalRe = /\bt\(\s*(['"`])((?:\\.|(?!\1)[^\\])*?)\1/g;
  let m;
  while ((m = literalRe.exec(source)) !== null) {
    const raw = m[2];
    if (m[1] === '`' && raw.includes('${')) {
      dynamic.push(raw);
      continue;
    }
    // Reconstruct escape sequences the way a JS parser would.
    literals.add(raw.replace(/\\(['"`\\])/g, '$1').replace(/\\n/g, '\n'));
  }

  const dynamicRe = /\bt\(\s*[A-Za-z_$]/g;
  while ((m = dynamicRe.exec(source)) !== null) dynamic.push('t(<zmienna>)');

  return { literals, dynamic };
}

function loadDictionaryKeys() {
  const source = fs.readFileSync(I18N_FILE, 'utf8');
  const start = source.indexOf('const TRANSLATIONS = {');
  if (start === -1) {
    console.error('ERROR: could not find the TRANSLATIONS object in utils/i18n.js');
    process.exit(2);
  }
  const end = source.indexOf('\n};', start);
  const body = source.slice(start, end);

  const keys = new Set();
  const keyRe = /^\s*"((?:\\.|[^"\\])*)"\s*:/gm;
  let m;
  while ((m = keyRe.exec(body)) !== null) {
    keys.add(m[1].replace(/\\(["\\])/g, '$1').replace(/\\n/g, '\n'));
  }
  return keys;
}

const files = walk(SRC_DIR).filter(f => f !== I18N_FILE);
const used = new Set();
const dynamicCalls = [];

for (const file of files) {
  const { literals, dynamic } = extractCalls(fs.readFileSync(file, 'utf8'));
  literals.forEach(l => used.add(l));
  if (dynamic.length) {
    dynamicCalls.push({ file: path.relative(SRC_DIR, file), count: dynamic.length });
  }
}

const dictionary = loadDictionaryKeys();
const missing = [...used].filter(k => !dictionary.has(k)).sort();
const unused = [...dictionary].filter(k => !used.has(k)).sort();

console.log('=== TRANSLATION CHECK ===');
console.log(`Files scanned:            ${files.length}`);
console.log(`Texts used in t():        ${used.size}`);
console.log(`Keys in the dictionary:   ${dictionary.size}`);
console.log('');

if (dynamicCalls.length) {
  const total = dynamicCalls.reduce((s, d) => s + d.count, 0);
  console.log(`ℹ️  ${total} t() calls with a variable (cannot be checked statically):`);
  dynamicCalls.forEach(d => console.log(`     ${d.file} (${d.count})`));
  console.log('');
}

// A dictionary key absent from every t() has two possible causes, and they must be told
// apart because they lead to entirely different actions:
//   (a) the text is in the code but NOT wrapped in t() - switching to English will not change
//       it even though a translation exists. That is a real bug.
//   (b) the text exists nowhere - the entry is simply stale and can be deleted.
const hardcoded = [];
const stale = [];

// The match must be EXACT - a whole occurrence, not a fragment of a longer sentence.
// This used to be a plain `line.includes(key)`. The Polish examples below are quoted
// deliberately - they are the exact strings that produced the bug. The key "Zaloguj się" matched inside
// "Sesja wygasła. Zaloguj się ponownie.", and "Hasło" inside "Hasło dostępowe". The report
// then showed 61 hardcoded texts where only 43 were real - and trying to wrap such a hit
// automatically would have torn the sentence in half.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function exactOccurrences(key, line) {
  const k = escapeRe(key);
  return (
    new RegExp(`(\\w+)=(["'])${k}\\2`).test(line) ||   // placeholder="Key"
    new RegExp(`(["'])${k}\\1`).test(line) ||          // 'Key' as a whole literal
    new RegExp(`>\\s*${k}\\s*<`).test(line) ||         // >Key<
    new RegExp(`^\\s*${k}\\s*$`).test(line)            // Key alone on a JSX line
  );
}

for (const key of unused) {
  const hits = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      // An occurrence inside a comment is not interface text.
      if (/^(\/\/|\*|\/\*)/.test(trimmed)) return;
      if (exactOccurrences(key, line)) {
        hits.push(`${path.relative(SRC_DIR, file)}:${i + 1}`);
      }
    });
    if (hits.length >= 3) break;
  }
  if (hits.length) hardcoded.push({ key, hits });
  else stale.push(key);
}

if (hardcoded.length) {
  console.log(`❗ ${hardcoded.length} texts are HARDCODED in the code despite having a translation.`);
  console.log('   Switching the language to English will not change them - they need wrapping in t().');
  hardcoded.slice(0, 12).forEach(({ key, hits }) => {
    const short = key.length > 55 ? key.slice(0, 55) + '…' : key;
    console.log(`     "${short}"  →  ${hits.slice(0, 2).join(', ')}`);
  });
  if (hardcoded.length > 12) console.log(`     … i ${hardcoded.length - 12} więcej`);
  console.log('');
}

if (stale.length) {
  console.log(`⚠️  ${stale.length} keys appear nowhere in the code (stale entries).`);
  console.log('    Usually this means the Polish copy changed and the entry kept the old wording:');
  stale.slice(0, 10).forEach(k => console.log(`     "${k.length > 70 ? k.slice(0, 70) + '…' : k}"`));
  if (stale.length > 10) console.log(`     … i ${stale.length - 10} więcej`);
  console.log('');
}

const coverage = dictionary.size > 0
  ? Math.round(((dictionary.size - hardcoded.length - stale.length) / dictionary.size) * 100)
  : 100;
console.log(`Dictionary coverage by real t() calls: ${coverage}%`);
console.log('');

if (missing.length === 0) {
  console.log('✅ Every t() text has a translation. The English version is complete.');
  process.exit(0);
}

console.log(`❌ ${missing.length} texts have no EN translation - they will show in Polish in English mode:`);
missing.forEach(k => console.log(`     "${k.length > 70 ? k.slice(0, 70) + '…' : k}"`));

if (process.argv.includes('--fix')) {
  const source = fs.readFileSync(I18N_FILE, 'utf8');
  const marker = '\n};';
  const insertAt = source.indexOf(marker, source.indexOf('const TRANSLATIONS = {'));
  const escape = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  const block = '\n\n  // TODO: fill in these translations (added automatically by check-i18n --fix)\n'
    + missing.map(k => `  "${escape(k)}": "${escape(k)}",`).join('\n');
  fs.writeFileSync(I18N_FILE, source.slice(0, insertAt) + block + source.slice(insertAt));
  console.log(`\n✏️  Appended ${missing.length} keys to utils/i18n.js with the Polish text as the value.`);
  console.log('    Translate them - until you do, the EN version shows Polish text.');
  process.exit(0);
}

console.log('\nRun "npm run check-i18n -- --fix" to append the missing keys as TODOs.');
process.exit(1);
