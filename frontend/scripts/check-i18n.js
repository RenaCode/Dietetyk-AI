#!/usr/bin/env node
// Kontrola spójności tłumaczeń: czy każdy tekst przekazany do t() ma odpowiednik
// w słowniku, i czy w słowniku nie zostały wpisy, których już nikt nie używa.
//
// Po co: kluczem tłumaczenia jest samo polskie zdanie, więc zmiana copy zrywa
// tłumaczenie CICHO - w trybie angielskim po prostu pojawia się polski tekst.
// Nie ma po tym ani błędu, ani wyjątku, ani nawet innego zachowania aplikacji.
// Ten skrypt zamienia tę cichą awarię w błąd builda.
//
// Użycie:
//   npm run check-i18n           # raport + kod wyjścia 1 przy brakach
//   npm run check-i18n -- --fix  # dopisuje brakujące klucze do i18n.js jako TODO

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

// Wyciąga literały przekazane do t(). Świadomie obsługujemy WYŁĄCZNIE literały
// (apostrofy, cudzysłowy, backticki bez interpolacji) - t(zmienna) jest nie do
// sprawdzenia statycznie i jest raportowane osobno jako ostrzeżenie.
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
    // Odtworzenie sekwencji ucieczki tak, jak zrobiłby to parser JS.
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
    console.error('BŁĄD: nie znaleziono obiektu TRANSLATIONS w utils/i18n.js');
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

console.log('=== KONTROLA TŁUMACZEŃ ===');
console.log(`Przeskanowano plików:      ${files.length}`);
console.log(`Tekstów użytych w t():     ${used.size}`);
console.log(`Kluczy w słowniku:         ${dictionary.size}`);
console.log('');

if (dynamicCalls.length) {
  const total = dynamicCalls.reduce((s, d) => s + d.count, 0);
  console.log(`ℹ️  ${total} wywołań t() ze zmienną (nie da się sprawdzić statycznie):`);
  dynamicCalls.forEach(d => console.log(`     ${d.file} (${d.count})`));
  console.log('');
}

// Klucz ze słownika, którego nie ma w żadnym t(), ma dwie możliwe przyczyny i
// trzeba je rozróżnić, bo prowadzą do zupełnie różnych działań:
//   (a) tekst jest w kodzie, ale NIE opakowany w t() - przełączenie na angielski
//       go nie zmieni, mimo że tłumaczenie istnieje. To realny błąd.
//   (b) tekstu nie ma nigdzie - wpis jest po prostu nieaktualny do usunięcia.
const hardcoded = [];
const stale = [];

// Dopasowanie musi być DOKŁADNE - całe wystąpienie, nie fragment dłuższego zdania.
// Wcześniej było tu zwykłe `line.includes(key)`, przez co klucz "Zaloguj się"
// trafiał w zdanie "Sesja wygasła. Zaloguj się ponownie.", a "Hasło" w "Hasło
// dostępowe". Raport pokazywał wtedy 61 tekstów "na sztywno", z których realnych
// było 43 - a próba automatycznego opakowania takiego trafienia rozerwałaby zdanie
// w połowie.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function exactOccurrences(key, line) {
  const k = escapeRe(key);
  return (
    new RegExp(`(\\w+)=(["'])${k}\\2`).test(line) ||   // placeholder="Klucz"
    new RegExp(`(["'])${k}\\1`).test(line) ||          // 'Klucz' jako cały literał
    new RegExp(`>\\s*${k}\\s*<`).test(line) ||         // >Klucz<
    new RegExp(`^\\s*${k}\\s*$`).test(line)            // Klucz sam w linii JSX
  );
}

for (const key of unused) {
  const hits = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      // Wystąpienie w komentarzu nie jest tekstem interfejsu.
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
  console.log(`❗ ${hardcoded.length} tekstów jest w kodzie NA SZTYWNO, mimo że mają tłumaczenie.`);
  console.log('   Przełączenie języka na angielski ich nie zmieni - trzeba opakować je w t().');
  hardcoded.slice(0, 12).forEach(({ key, hits }) => {
    const short = key.length > 55 ? key.slice(0, 55) + '…' : key;
    console.log(`     "${short}"  →  ${hits.slice(0, 2).join(', ')}`);
  });
  if (hardcoded.length > 12) console.log(`     … i ${hardcoded.length - 12} więcej`);
  console.log('');
}

if (stale.length) {
  console.log(`⚠️  ${stale.length} kluczy nie występuje nigdzie w kodzie (nieaktualne wpisy).`);
  console.log('    Zwykle znaczy to, że polskie copy zmieniono, a wpis został ze starym brzmieniem:');
  stale.slice(0, 10).forEach(k => console.log(`     "${k.length > 70 ? k.slice(0, 70) + '…' : k}"`));
  if (stale.length > 10) console.log(`     … i ${stale.length - 10} więcej`);
  console.log('');
}

const coverage = dictionary.size > 0
  ? Math.round(((dictionary.size - hardcoded.length - stale.length) / dictionary.size) * 100)
  : 100;
console.log(`Pokrycie słownika realnymi wywołaniami t(): ${coverage}%`);
console.log('');

if (missing.length === 0) {
  console.log('✅ Każdy tekst z t() ma tłumaczenie. Wersja angielska jest kompletna.');
  process.exit(0);
}

console.log(`❌ ${missing.length} tekstów bez tłumaczenia EN - w trybie angielskim pokażą się po polsku:`);
missing.forEach(k => console.log(`     "${k.length > 70 ? k.slice(0, 70) + '…' : k}"`));

if (process.argv.includes('--fix')) {
  const source = fs.readFileSync(I18N_FILE, 'utf8');
  const marker = '\n};';
  const insertAt = source.indexOf(marker, source.indexOf('const TRANSLATIONS = {'));
  const escape = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  const block = '\n\n  // TODO: uzupełnić tłumaczenia (dodane automatycznie przez check-i18n --fix)\n'
    + missing.map(k => `  "${escape(k)}": "${escape(k)}",`).join('\n');
  fs.writeFileSync(I18N_FILE, source.slice(0, insertAt) + block + source.slice(insertAt));
  console.log(`\n✏️  Dopisano ${missing.length} kluczy do utils/i18n.js z polskim tekstem jako wartością.`);
  console.log('    Przetłumacz je - dopóki tego nie zrobisz, wersja EN pokazuje polski tekst.');
  process.exit(0);
}

console.log('\nUruchom "npm run check-i18n -- --fix", żeby dopisać brakujące klucze jako TODO.');
process.exit(1);
