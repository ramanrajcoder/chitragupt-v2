// ONE-TIME helper: translate i18n/en.json into another language with Google Cloud Translation (Basic v2).
//
//   GOOGLE_TRANSLATE_API_KEY=xxxx node scripts/generate-i18n.mjs hi "हिंदी" HI
//   (or: node --env-file=.env scripts/generate-i18n.mjs hi "हिंदी" HI )
//
//   args: <language code> [display name] [pill text]     flags: --dry (only count characters)  --overwrite (re-translate existing keys)
//
// - Only keys missing from i18n/<code>.json are sent (hand-corrected translations are kept).
// - {placeholders}, brand names and abbreviations are protected from translation.
// - Run it on YOUR computer, never on the website. The key never goes into the browser or the repo.
// - The English file is ~12,000 characters, i.e. about 2% of Google's free 500,000 per month.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter(a => a.startsWith('--')));
const [code, name, pill] = args;
if (!code || !/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(code)) { console.error('Usage: node scripts/generate-i18n.mjs <lang code e.g. hi|mr|gu|ta> [display name] [pill]'); process.exit(1); }
if (code === 'en') { console.error('en.json is the source file.'); process.exit(1); }

const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n/en.json'), 'utf8'));
const file = path.join(ROOT, `i18n/${code}.json`);
const have = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const todo = Object.entries(en).filter(([k, v]) => !k.startsWith('_') && typeof v === 'string' && (flags.has('--overwrite') || !(k in have)));
const chars = todo.reduce((n, [, v]) => n + [...v].length, 0);
console.log(`${todo.length} strings, about ${chars} characters to translate into "${code}" (Google free tier: 500,000 per month).`);
if (flags.has('--dry') || !todo.length) process.exit(0);

const KEY = process.env.GOOGLE_TRANSLATE_API_KEY;
if (!KEY) { console.error('Set GOOGLE_TRANSLATE_API_KEY first (see README), or just use the ready-made i18n/hi.json.'); process.exit(1); }
if (chars > 150000 && !flags.has('--yes')) { console.error('That is more than 150,000 characters. Re-run with --yes if you are sure.'); process.exit(1); }

const URL_ = process.env.GOOGLE_TRANSLATE_URL || 'https://translation.googleapis.com/language/translate/v2';
const KEEP = ['ChitRagupt', 'Chitragupt', 'GSTIN', 'GST', 'CGST', 'SGST', 'IGST', 'UPI', 'PDF', 'CSV', 'JSON', 'HSN', 'EOQ', 'ROP', 'POS', 'WhatsApp', 'Excel', 'PIN', 'CRM'];
const protect = s => s
  .replace(/\{(\w+)\}/g, '<span translate="no">{$1}</span>')
  .replace(new RegExp('\\b(' + KEEP.join('|') + ')\\b', 'g'), '<span translate="no">$1</span>')
  .replace(/\n/g, '<br>');
const unprotect = s => s.replace(/<span[^>]*>(.*?)<\/span>/g, '$1').replace(/<br\s*\/?>/g, '\n')
  .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const out = { ...have };
let sent = 0;
for (let i = 0; i < todo.length;) {
  const batch = []; let size = 0;
  while (i < todo.length && batch.length < 80 && size < 12000) { batch.push(todo[i]); size += todo[i][1].length * 2; i++; }
  const r = await fetch(`${URL_}?key=${encodeURIComponent(KEY)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: batch.map(([, v]) => protect(escapeHtml(v))), source: 'en', target: code, format: 'html' })
  });
  if (!r.ok) { console.error('Google answered', r.status, (await r.text()).slice(0, 300).replace(KEY, '***')); process.exit(1); }
  const j = await r.json();
  batch.forEach(([k], n) => { out[k] = unprotect(j.data.translations[n].translatedText); });
  sent += batch.reduce((a, [, v]) => a + [...v].length, 0);
  console.log(`  translated ${Math.min(i, todo.length)}/${todo.length}`);
}
const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
fs.writeFileSync(file, JSON.stringify(sorted, null, 2) + '\n');

const lp = path.join(ROOT, 'i18n/languages.json');
const langs = JSON.parse(fs.readFileSync(lp, 'utf8'));
if (!langs.some(l => l.code === code)) { langs.push({ code, name: name || code, pill: pill || code.toUpperCase() }); fs.writeFileSync(lp, JSON.stringify(langs, null, 2) + '\n'); }
console.log(`Wrote i18n/${code}.json (${sent} characters sent). Please read it once: machine translation can be awkward for accounting words.`);
