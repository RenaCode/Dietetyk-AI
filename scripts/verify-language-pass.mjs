// Two-level check for a language pass.
//
// Level 1 (must always hold): STRUCTURE. Comments removed and every string literal
// blanked to a placeholder. Any difference here means executable logic changed, which
// a translation pass must never do.
//
// Level 2 (informational): which string literals changed. Log and error messages are
// supposed to change - they are required to be English - so these are listed for review
// rather than treated as failures.
import { strip } from './strip-comments.mjs';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const repo = path.join(__dirname, '..');
const blankStrings = (src) => src
  .replace(/'(?:\\.|[^'\\])*'/g, "'S'")
  .replace(/"(?:\\.|[^"\\])*"/g, '"S"')
  .replace(/`(?:\\.|[^`\\])*`/g, '`S`');
const nonEmpty = (t) => t.split('\n').filter(l => l.trim() !== '').join('\n');
const structure = (src) => nonEmpty(blankStrings(strip(src)));
const strings = (src) => (strip(src).match(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g) || []);

const changed = execSync('git diff --name-only HEAD', { cwd: repo, encoding: 'utf8' })
  .split('\n').filter(f => /\.(js|jsx)$/.test(f));

let broken = 0, stringChanges = 0;
for (const f of changed) {
  let before;
  try { before = execSync(`git show HEAD:${f}`, { cwd: repo, encoding: 'utf8' }); }
  catch { console.log(`  NEW    ${f}`); continue; }
  const after = fs.readFileSync(`${repo}/${f}`, 'utf8');

  if (structure(before) !== structure(after)) {
    broken++;
    console.log(`  BROKEN ${f}  <-- executable structure changed`);
    const la = structure(before).split('\n'), lb = structure(after).split('\n');
    for (let i = 0; i < Math.max(la.length, lb.length); i++) {
      if (la[i] !== lb[i]) { console.log(`         - ${la[i]}\n         + ${lb[i]}`); break; }
    }
    continue;
  }
  const sa = strings(before), sb = strings(after);
  const diffs = sa.map((v, i) => [v, sb[i]]).filter(([x, y]) => x !== y);
  if (diffs.length) {
    stringChanges += diffs.length;
    console.log(`  ok     ${f}  (structure identical; ${diffs.length} string(s) translated)`);
    diffs.slice(0, 2).forEach(([x, y]) => console.log(`           ${x.slice(0, 60)}\n        -> ${y.slice(0, 60)}`));
  } else {
    console.log(`  ok     ${f}  (comments only)`);
  }
}
console.log(broken === 0
  ? `\nOK: executable structure unchanged in every file. ${stringChanges} string(s) translated (log/error messages).`
  : `\nFAIL: ${broken} file(s) changed executable structure.`);
process.exit(broken === 0 ? 0 : 1);
