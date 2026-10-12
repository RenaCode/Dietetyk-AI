#!/usr/bin/env node
// Built-CSS check: every rule that declares both `-webkit-X` and `X` in src/*.css still
// declares the unprefixed `X` after the production build.
//
// Why: Vite 8 minifies CSS with Lightning CSS, which treats a prefixed and an unprefixed
// declaration as one property and keeps only the LAST of the pair. `.glass-card` declared
// `backdrop-filter` and then `-webkit-backdrop-filter`, so the build kept only the prefixed
// one - and Chrome, Edge, Firefox and Android, which do not know the prefix, lost the blur
// behind every card and dialog (review of #74, 10.2026). No test or E2E run noticed: the page
// works, it only looks different. The build itself is the thing under test, so this script
// runs it (into a temporary directory) and reads what came out.
//
// Usage:
//   npm run check-css            # exit code 1 when an unprefixed declaration was dropped

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { build } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.name.endsWith('.css')) files.push(full);
  }
  return files;
}

// Innermost `selector { declarations }` blocks - at-rules (@media and so on) only wrap them,
// so their bodies are skipped by matching blocks that contain no further braces. Enough for
// plain CSS like ours; not a general CSS parser.
function blocks(css) {
  const out = [];
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of stripped.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim().replace(/\s+/g, '');
    const props = new Set();
    for (const decl of m[2].split(';')) {
      const i = decl.indexOf(':');
      if (i > 0) props.add(decl.slice(0, i).trim().toLowerCase());
    }
    out.push({ selector, props });
  }
  return out;
}

// For every (selector, property) where the source block has both `-webkit-property` and
// `property`: how many such blocks there are.
function pairedInSource(cssFiles) {
  const required = new Map();
  for (const file of cssFiles) {
    for (const { selector, props } of blocks(fs.readFileSync(file, 'utf8'))) {
      for (const prop of props) {
        if (!prop.startsWith('-webkit-')) continue;
        const plain = prop.slice('-webkit-'.length);
        if (!props.has(plain)) continue;
        const key = `${selector} { ${plain} }`;
        required.set(key, { selector, plain, count: (required.get(key)?.count || 0) + 1 });
      }
    }
  }
  return [...required.values()];
}

function findDropped(required, builtCss) {
  const built = blocks(builtCss);
  const dropped = [];
  for (const { selector, plain, count } of required) {
    const found = built.filter((b) => b.selector === selector && b.props.has(plain)).length;
    if (found < count) dropped.push(`${selector} { ${plain} } - ${count} in src, ${found} in the build`);
  }
  return dropped;
}

async function main() {
  const required = pairedInSource(walk(SRC_DIR));
  if (required.length === 0) {
    // src/index.css has two such pairs today; none at all means the parser above broke.
    console.error('❌ found no -webkit-X / X pair in src/*.css - the check would prove nothing');
    process.exit(1);
  }

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dietetyk-css-check-'));
  try {
    await build({ root: ROOT, logLevel: 'warn', build: { outDir, emptyOutDir: true } });
    const assets = path.join(outDir, 'assets');
    const builtCss = fs.readdirSync(assets)
      .filter((f) => f.endsWith('.css'))
      .map((f) => fs.readFileSync(path.join(assets, f), 'utf8'))
      .join('\n');

    const dropped = findDropped(required, builtCss);
    if (dropped.length) {
      console.error('❌ The build dropped unprefixed declarations that src/*.css pairs with -webkit-:');
      for (const line of dropped) console.error('   ' + line);
      console.error('Declare the -webkit- variant FIRST and the unprefixed one after it.');
      process.exit(1);
    }
    console.log(`✅ ${required.length} -webkit-/unprefixed pairs from src/*.css keep the unprefixed declaration in the build.`);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
