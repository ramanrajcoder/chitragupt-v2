// Builds i18n/en.json (all fixed strings) and the Google-free fallback i18n/hi.json.
//   node scripts/build-i18n.mjs
// Named keys come from core-strings.mjs; fixed labels found in the page templates become "ui.<slug>" keys.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CORE } from './core-strings.mjs';
import { UI_HI } from './ui-hi.mjs';
import { extract } from './extract-ui.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const en = {}, hi = {};
for (const [k, [e, h]] of Object.entries(CORE)) { en[k] = e; hi[k] = h; }

const taken = new Set(Object.values(en));
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'x';
for (const text of extract()) {
  if (taken.has(text)) continue;                       // already covered by a named key (matched by text at runtime)
  let key = 'ui.' + slug(text);
  if (key in en) key += '_' + crypto.createHash('md5').update(text).digest('hex').slice(0, 4);
  en[key] = text; taken.add(text);
  if (UI_HI[text]) hi[key] = UI_HI[text];
}
// named keys whose text the DOM translator should also catch (same English text -> same Hindi) are already in `en`
const out = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))), null, 2) + '\n';
fs.mkdirSync(path.join(ROOT, 'i18n'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'i18n/en.json'), out(en));
fs.writeFileSync(path.join(ROOT, 'i18n/hi.json'), out(hi));
fs.writeFileSync(path.join(ROOT, 'i18n/languages.json'), JSON.stringify([
  { code: 'en', name: 'English', pill: 'EN' }, { code: 'hi', name: 'हिंदी', pill: 'HI' }], null, 2) + '\n');
console.log(`en.json: ${Object.keys(en).length} strings | hi.json: ${Object.keys(hi).length} translated (${Object.keys(en).length - Object.keys(hi).length} stay English)`);
