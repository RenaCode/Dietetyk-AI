// Strips comments and Polish string literals from a JS/JSX file, leaving only
// executable structure. Used to PROVE that a translation pass changed nothing but
// prose: strip(before) must equal strip(after), byte for byte.
import fs from 'fs';

export function strip(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let state = 'code';   // code | line | block | sq | dq | tpl
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && d === '*') { state = 'block'; i += 2; continue; }
      if (c === "'") { state = 'sq'; out += c; i++; continue; }
      if (c === '"') { state = 'dq'; out += c; i++; continue; }
      if (c === '`') { state = 'tpl'; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; }
      i++; continue;
    }
    if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; i += 2; continue; }
      if (c === '\n') out += c;    // keep line count stable
      i++; continue;
    }
    // Inside a string: copy verbatim (string contents are NOT touched by the
    // comment pass, so any difference here is a real change and must fail).
    out += c;
    if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) {
      if (out.length >= 2 && out[out.length - 2] !== undefined) state = 'code';
    }
    i++;
  }
  // Normalise trailing whitespace produced by removing a trailing comment.
  return out.split('\n').map(l => l.replace(/\s+$/, '')).join('\n');
}

if (process.argv[2]) {
  console.log(strip(fs.readFileSync(process.argv[2], 'utf8')));
}
