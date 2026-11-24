// Finds the FIXED labels in index.html and script.js (text between tags, placeholder/title attributes).
// Text that has ${...} mixed in (numbers, names, amounts) is deliberately never extracted.
// usage: node scripts/extract-ui.mjs   -> prints the list; build-i18n.mjs calls extract() itself.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const decode = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&middot;/g, '·').replace(/&rarr;/g, '→').replace(/&ndash;/g, '–').replace(/&mdash;/g, '—').replace(/&#39;/g, "'").replace(/&quot;/g, '"');

export function extract() {
  const found = new Set();
  const add = raw => {
    let s = decode(raw).replace(/\s+/g, ' ').trim();
    if (s.length < 2 || s.length > 160) return;
    if (!/\p{L}{2}/u.test(s)) return;
    if (/[;{}\[\]=\\]|=>|&&|\|\||\$\{|\bfunction\b|\breturn\b|\bconst\b/.test(s)) return;
    if (/^[\w.-]+\(\)$/.test(s)) return;
    if (/['"]\s*\+|\+\s*['"]|\?\s*'|\b(?:esc|fmt|toP|rs)\(|^\d+\s*\?|^[A-Z0-9]{5,}$|^\. /.test(s)) return;   // code fragments and sample values
    found.add(s);
  };
  for (const f of ['index.html', 'script.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/>([^<>`]*)</g)) if (!/\$\{|\}/.test(m[1])) add(m[1]);
    for (const m of src.matchAll(/\b(?:placeholder|title|aria-label)="([^"$]+)"/g)) add(m[1]);
    for (const m of src.matchAll(/\b(?:placeholder|title)=\\?'([^'$]+)'/g)) add(m[1]);
  }
  return [...found].sort((a, b) => a.localeCompare(b));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) { const l = extract(); console.log(l.join('\n')); console.error(l.length + ' strings'); }
