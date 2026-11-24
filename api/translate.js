import crypto from 'node:crypto';
import { route } from '../lib/http.js';
import { query } from '../lib/db.js';
import { translateBody } from '../lib/schemas.js';

/*
 * POST /api/translate   { texts: ["Monthly rent", ...], target: "hi" }
 * ONLY for user-entered free text (notes, expense descriptions ...).
 * Order of work: 1) skip things that must never be translated  2) translation_cache
 *                3) monthly character cap (usage_counter)        4) Google Translation Basic v2
 * Any refusal or error -> the ORIGINAL text is returned, so the screen never breaks.
 */
const GOOGLE_URL = 'https://translation.googleapis.com/language/translate/v2';

/** numbers, amounts, dates, invoice/receipt numbers, GSTIN, ids: never sent to Google */
export function mustKeep(text) {
  const s = String(text).trim();
  if (!s) return true;
  if (!/\p{L}/u.test(s)) return true;                                        // no letters: numbers, amounts, dates, symbols
  if (/^[A-Z]{2,4}-(\d{4}-)?\d+$/.test(s)) return true;                      // INV-2026-0001, CN-0003, RC-0001, PB-0002
  if (/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/.test(s)) return true;      // GSTIN
  if (/^[₹$]?\s?[\d,]+(\.\d+)?$/.test(s)) return true;                       // amounts
  if (/^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/.test(s)) return true;              // dates
  if (/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(s)) return true;                      // e-mail
  if (/^https?:\/\//i.test(s)) return true;                                  // links
  return false;
}

const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const decodeEntities = s => String(s).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

async function callGoogle(texts, target) {
  const key = process.env.GOOGLE_TRANSLATE_API_KEY;
  if (!key) throw new Error('translate key not set');
  const r = await fetch(`${GOOGLE_URL}?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: texts, target, format: 'text' }),
    signal: AbortSignal.timeout(8000)
  });
  if (!r.ok) throw new Error('google ' + r.status); // never include the URL (it carries the key)
  const j = await r.json();
  const out = j?.data?.translations;
  if (!Array.isArray(out) || out.length !== texts.length) throw new Error('google bad reply');
  return out.map(t => decodeEntities(t.translatedText));
}

export default route({
  methods: ['POST'],
  async handler({ body }) {
    const b = translateBody.parse(body);
    const target = b.target.toLowerCase();
    const result = b.texts.map(t => ({ text: t, translated: t, source: 'original' }));
    let capped = false;

    if (target === 'en') return { json: { translations: result, capped } };

    // which entries are eligible at all
    const todo = [];
    b.texts.forEach((t, i) => { if (!mustKeep(t)) todo.push({ i, t: t.trim(), hash: sha(t.trim()) }); });
    if (!todo.length) return { json: { translations: result, capped } };

    // 1. cache
    const hashes = [...new Set(todo.map(x => x.hash))];
    const cached = await query(`select hash, translated from translation_cache where target_lang = $1 and hash = any($2::text[])`, [target, hashes]);
    const hit = new Map(cached.map(r => [r.hash, r.translated]));
    const miss = [];
    todo.forEach(x => {
      if (hit.has(x.hash)) { result[x.i].translated = hit.get(x.hash); result[x.i].source = 'cache'; }
      else miss.push(x);
    });
    if (!miss.length || !process.env.GOOGLE_TRANSLATE_API_KEY) return { json: { translations: result, capped } };

    // 2. monthly cap: reserve the characters BEFORE calling Google (atomic, one statement)
    const uniq = [...new Map(miss.map(x => [x.hash, x])).values()];
    const chars = uniq.reduce((s, x) => s + [...x.t].length, 0);
    const cap = Math.max(0, parseInt(process.env.MONTHLY_CHAR_CAP || '400000', 10) || 400000);
    const month = new Date().toISOString().slice(0, 7);
    let reserved = false;
    if (chars <= cap) {
      const r = await query(
        `insert into usage_counter (month, chars) values ($1, $2)
         on conflict (month) do update set chars = usage_counter.chars + $2
           where usage_counter.chars + $2 <= $3
         returning chars`, [month, chars, cap]);
      reserved = r.length > 0;
    }
    if (!reserved) { capped = true; return { json: { translations: result, capped } }; }

    // 3. Google
    try {
      const out = await callGoogle(uniq.map(x => x.t), target);
      const byHash = new Map(uniq.map((x, k) => [x.hash, out[k]]));
      miss.forEach(x => { result[x.i].translated = byHash.get(x.hash); result[x.i].source = 'google'; });
      await query(
        `insert into translation_cache (hash, target_lang, source_text, translated)
         select h, $1, s, t from unnest($2::text[], $3::text[], $4::text[]) as u(h, s, t)
         on conflict do nothing`,
        [target, uniq.map(x => x.hash), uniq.map(x => x.t), uniq.map(x => byHash.get(x.hash))]);
    } catch (e) {
      console.error('translate failed:', e.message);
      // give the reserved characters back; Google did not process them
      await query(`update usage_counter set chars = greatest(0, chars - $2) where month = $1`, [month, chars]).catch(() => {});
    }
    return { json: { translations: result, capped } };
  }
});
