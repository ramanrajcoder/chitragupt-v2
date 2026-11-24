import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { startHarness } from './harness.mjs';

const h = await startHarness();
const B = h.base;
let pass = 0, fail = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); pass++; results.push('  ok   ' + name); } catch (e) { fail++; results.push('  FAIL ' + name + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n       ')); }
}
function client(ip = '10.0.0.1') {
  let cookie = '';
  return {
    async call(method, path, body, headers = {}) {
      const r = await fetch(B + path, {
        method, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...(cookie ? { Cookie: cookie } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const sc = r.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0].startsWith('cr_session=') && sc.includes('Max-Age=0') ? '' : sc.split(';')[0];
      let json = null; try { json = await r.json(); } catch { }
      return { status: r.status, json, headers: r.headers, setCookie: sc };
    },
    get cookie() { return cookie; }
  };
}
const reg = (c, id, pw = 'secret123') => c.call('POST', '/api/auth/register', { businessName: 'Sharma Store', ownerName: 'Ramesh', loginId: id, password: pw });
const ledger = (n, amt = 10000) => Array.from({ length: n }, (_, i) => ({ id: 'l' + i, account: i % 2 ? 'SALES' : 'CASH', debit: i % 2 ? 0 : amt, credit: i % 2 ? amt : 0 }));

await t('health', async () => {
  const r = await client().call('GET', '/api/health');
  assert.equal(r.status, 200); assert.equal(r.json.db, 'ok'); assert.equal(r.json.configured.jwtSecret, true);
  assert.ok(!JSON.stringify(r.json).includes(process.env.JWT_SECRET));
});

await t('register: validation (6-char password minimum)', async () => {
  const r = await reg(client(), 'shop1', '12345');
  assert.equal(r.status, 400); assert.match(r.json.error, /at least 6/);
});

const A = client('10.0.0.2');
await t('register: ok, cookie is HttpOnly + Secure + SameSite=Strict, only a bcrypt hash is stored', async () => {
  const r = await reg(A, 'Shop.One');
  assert.equal(r.status, 201);
  assert.match(r.setCookie, /HttpOnly/); assert.match(r.setCookie, /Secure/); assert.match(r.setCookie, /SameSite=Strict/);
  const rows = (await h.pg.query(`select password_hash from businesses where lower(login_id)='shop.one'`)).rows;
  assert.match(rows[0].password_hash, /^\$2[aby]\$10\$/);
  assert.ok(!JSON.stringify(r.json).includes('secret123'));
});
await t('register: login id unique, case-insensitive', async () => {
  const r = await reg(client('10.0.0.3'), 'SHOP.ONE');
  assert.equal(r.status, 409);
});

await t('data: needs a session', async () => {
  assert.equal((await client().call('GET', '/api/data')).status, 401);
  const bad = client(); bad.call; 
  const r = await fetch(B + '/api/data', { headers: { Cookie: 'cr_session=garbage' } });
  assert.equal(r.status, 401);
});
await t('data: new account is empty', async () => {
  const r = await A.call('GET', '/api/data');
  assert.equal(r.status, 200); assert.equal(r.json.empty, true); assert.equal(r.json.user.ownerName, 'Ramesh');
});

await t('sync: insert (base 0) then update (base 1); versions increase', async () => {
  let r = await A.call('POST', '/api/sync', { changes: [{ key: 'products', base: 0, value: [{ id: 'p1', name: 'Soap', price: 4500, stock: 10 }] }, { key: 'counters', base: 0, value: { inv2026: 1 } }] });
  assert.equal(r.status, 200); assert.deepEqual(r.json.versions, { products: 1, counters: 1 });
  r = await A.call('POST', '/api/sync', { changes: [{ key: 'products', base: 1, value: [{ id: 'p1', name: 'Soap', price: 4500, stock: 9 }] }] });
  assert.equal(r.status, 200); assert.equal(r.json.versions.products, 2);
  const d = await A.call('GET', '/api/data');
  assert.equal(d.json.data.products.version, 2); assert.equal(d.json.data.products.value[0].stock, 9);
});
await t('sync: stale write -> 409 and the WHOLE request is rolled back (nothing half-saved)', async () => {
  const r = await A.call('POST', '/api/sync', { changes: [
    { key: 'products', base: 1, value: [{ id: 'STALE' }] },          // stale (server is at 2)
    { key: 'counters', base: 1, value: { inv2026: 99 } }             // would be fine on its own
  ] });
  assert.equal(r.status, 409); assert.deepEqual(r.json.conflicts, ['products']);
  const d = (await A.call('GET', '/api/data')).json.data;
  assert.deepEqual(d.counters.value, { inv2026: 1 }); assert.equal(d.counters.version, 1);   // untouched
  assert.equal(d.products.value[0].id, 'p1');
});
await t('sync: inserting a key that already exists (base 0) -> 409', async () => {
  const r = await A.call('POST', '/api/sync', { changes: [{ key: 'counters', base: 0, value: {} }] });
  assert.equal(r.status, 409);
});
await t('sync: two simultaneous writes with the same base -> exactly one wins', async () => {
  const mk = n => A.call('POST', '/api/sync', { changes: [{ key: 'address', base: 0, value: 'Addr ' + n }] });
  const [x, y] = await Promise.all([mk(1), mk(2)]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
});
await t('sync: validation (unknown key, bad ledger amounts, duplicate keys, empty)', async () => {
  const bad = async changes => (await A.call('POST', '/api/sync', { changes })).status;
  assert.equal(await bad([{ key: 'hacker', base: 0, value: [] }]), 400);
  assert.equal(await bad([{ key: 'ledger', base: 0, value: [{ account: 'CASH', debit: 10.5, credit: 0 }] }]), 400);
  assert.equal(await bad([{ key: 'ledger', base: 0, value: [{ account: 'NOPE', debit: 1, credit: 0 }] }]), 400);
  assert.equal(await bad([{ key: 'products', base: 0, value: 'x' }]), 400);
  assert.equal(await bad([{ key: 'audit', base: 0, value: [] }, { key: 'audit', base: 0, value: [] }]), 400);
  assert.equal(await bad([]), 400);
});
await t('sync: business_id in the body is ignored; another business is never touched', async () => {
  const Bc = client('10.0.0.9'); await reg(Bc, 'other.shop');
  const other = (await h.pg.query(`select id from businesses where login_id='other.shop'`)).rows[0].id;
  await Bc.call('POST', '/api/sync', { changes: [{ key: 'customers', base: 0, value: [{ id: 'c1', name: 'Mine' }] }] });
  const r = await A.call('POST', '/api/sync', { business_id: other, businessId: other, changes: [{ key: 'customers', base: 0, value: [{ id: 'c9', name: 'Intruder' }] }] });
  assert.equal(r.status, 200);
  const rows = (await h.pg.query(`select business_id, value from business_data where key='customers' order by business_id`)).rows;
  assert.equal(rows.length, 2);
  const theirs = rows.find(x => x.business_id === other);
  assert.equal(theirs.value[0].name, 'Mine');
});
await t('sync: gzip envelope accepted (big saves)', async () => {
  const big = { changes: [{ key: 'ledger', base: 0, value: ledger(20000) }] };
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(big))).toString('base64');
  const r = await A.call('POST', '/api/sync', { gz });
  assert.equal(r.status, 200); assert.ok(gz.length < JSON.stringify(big).length / 5);
});
await t('data: big reply is gzip-compressed', async () => {
  const raw = await fetch(B + '/api/data', { headers: { Cookie: A.cookie, 'Accept-Encoding': 'gzip' } });
  assert.equal(raw.headers.get('content-encoding'), 'gzip');
  const j = await raw.json(); assert.equal(j.data.ledger.value.length, 20000);
});
await t('data: ?versions=1 and ?keys=', async () => {
  const v = await A.call('GET', '/api/data?versions=1'); assert.equal(v.json.versions.products, 2);
  const k = await A.call('GET', '/api/data?keys=counters'); assert.deepEqual(Object.keys(k.json.data), ['counters']);
});
await t('cross-site POST is blocked', async () => {
  const r = await A.call('POST', '/api/sync', { changes: [{ key: 'bizPhone', base: 0, value: '1' }] }, { Origin: 'http://evil.example' });
  assert.equal(r.status, 403);
});

await t('import: allowed once on an empty business, then refused', async () => {
  const C = client('10.0.0.20'); await reg(C, 'import.me');
  const data = { products: [{ id: 'p', name: 'X', price: 100, stock: 1 }], ledger: ledger(4), settings: { snapEvery: 20 }, businessName: 'Old Shop' };
  let r = await C.call('POST', '/api/import', { data });
  assert.equal(r.status, 200);
  const d = (await C.call('GET', '/api/data')).json;
  assert.equal(d.empty, false); assert.equal(d.data.businessName.value, 'Old Shop');
  r = await C.call('POST', '/api/import', { data });
  assert.equal(r.status, 409);
});
await t('import: unbalanced ledger / unknown key refused', async () => {
  const C = client('10.0.0.21'); await reg(C, 'import.bad');
  assert.equal((await C.call('POST', '/api/import', { data: { ledger: [{ account: 'CASH', debit: 5, credit: 0 }] } })).status, 400);
  assert.equal((await C.call('POST', '/api/import', { data: { evil: [] } })).status, 400);
  assert.equal((await C.call('POST', '/api/import', { data: {} })).status, 400);
});

await t('login: ok, wrong password, unknown id use the same message', async () => {
  const C = client('10.0.0.30');
  let r = await C.call('POST', '/api/auth/login', { loginId: 'SHOP.one', password: 'secret123' });
  assert.equal(r.status, 200); assert.ok(C.cookie.startsWith('cr_session='));
  const w = client('10.0.0.31');
  const r1 = await w.call('POST', '/api/auth/login', { loginId: 'shop.one', password: 'wrong' });
  const r2 = await w.call('POST', '/api/auth/login', { loginId: 'nobody.here', password: 'wrong' });
  assert.equal(r1.status, 401); assert.equal(r1.json.error, r2.json.error);
});
await t('login: 5 wrong attempts per login id -> 429, even with the right password and from another IP', async () => {
  await reg(client('10.0.0.40'), 'victim');
  for (let i = 0; i < 5; i++) {
    const r = await client('10.1.0.' + i).call('POST', '/api/auth/login', { loginId: 'victim', password: 'bad' + i });
    assert.equal(r.status, 401);
  }
  const r = await client('10.1.0.99').call('POST', '/api/auth/login', { loginId: 'victim', password: 'secret123' });
  assert.equal(r.status, 429); assert.ok(r.json.retryAfterSeconds > 0 && r.json.retryAfterSeconds <= 900);
});
await t('login: 5 wrong attempts from one IP (different ids) -> 429', async () => {
  const ip = '10.2.0.1';
  for (let i = 0; i < 5; i++) assert.equal((await client(ip).call('POST', '/api/auth/login', { loginId: 'ghost' + i, password: 'x' })).status, 401);
  assert.equal((await client(ip).call('POST', '/api/auth/login', { loginId: 'shop.one', password: 'secret123' })).status, 429);
});
await t('login: the limit lifts after the 15-minute window', async () => {
  await h.pg.query(`update login_attempts set at = now() - interval '16 minutes' where lower(login_id) = 'victim'`);
  const r = await client('10.1.0.77').call('POST', '/api/auth/login', { loginId: 'victim', password: 'secret123' });
  assert.equal(r.status, 200);
});
await t('logout clears the cookie', async () => {
  const C = client('10.0.0.50'); await C.call('POST', '/api/auth/login', { loginId: 'shop.one', password: 'secret123' });
  const r = await C.call('POST', '/api/auth/logout', {});
  assert.match(r.setCookie, /Max-Age=0/);
  assert.equal((await C.call('GET', '/api/data')).status, 401);
});

// ---- translate (Google is stubbed; no real network) ----
const realFetch = globalThis.fetch;
let googleCalls = 0, googleMode = 'ok';
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('translation.googleapis.com')) {
    googleCalls++;
    if (googleMode === 'fail') return new Response('{}', { status: 500 });
    const q = JSON.parse(opts.body).q;
    return new Response(JSON.stringify({ data: { translations: q.map(s => ({ translatedText: 'HI:' + s.replace(/'/g, '&#39;') })) } }), { status: 200 });
  }
  return realFetch(url, opts);
};
const TR = (texts, target = 'hi') => A.call('POST', '/api/translate', { texts, target });
await t('translate: no Google key -> original text back', async () => {
  delete process.env.GOOGLE_TRANSLATE_API_KEY;
  const r = await TR(['Shop rent']); assert.equal(r.status, 200); assert.equal(r.json.translations[0].translated, 'Shop rent'); assert.equal(googleCalls, 0);
});
await t('translate: needs a session', async () => {
  assert.equal((await client().call('POST', '/api/translate', { texts: ['a'], target: 'hi' })).status, 401);
});
process.env.GOOGLE_TRANSLATE_API_KEY = 'fake-key-for-tests';
await t('translate: numbers, amounts, invoice no., GSTIN, dates are never sent to Google', async () => {
  googleCalls = 0;
  const keep = ['1234', '₹1,250.00', 'INV-2026-0001', '07AAAAA0000A1Z5', '2026-11-23', '23/11/2026', 'CN-0003'];
  const r = await TR(keep); assert.deepEqual(r.json.translations.map(x => x.translated), keep); assert.equal(googleCalls, 0);
});
await t('translate: Google called once, result cached, second request is a cache hit (0 Google calls)', async () => {
  googleCalls = 0; process.env.MONTHLY_CHAR_CAP = '1000';
  let r = await TR(["Shop's rent", 'Tea for staff']);
  assert.equal(googleCalls, 1); assert.deepEqual(r.json.translations.map(x => x.translated), ["HI:Shop's rent", 'HI:Tea for staff']);
  r = await TR(["Shop's rent"]); assert.equal(googleCalls, 1); assert.equal(r.json.translations[0].source, 'cache');
  const u = (await h.pg.query(`select chars from usage_counter`)).rows[0]; assert.equal(u.chars, "Shop's rent".length + 'Tea for staff'.length);
});
await t('translate: monthly cap refuses and returns the original text (capped:true)', async () => {
  googleCalls = 0; process.env.MONTHLY_CHAR_CAP = '30';   // 24 already used
  const r = await TR(['This text is too long to fit']);
  assert.equal(r.json.capped, true); assert.equal(r.json.translations[0].translated, 'This text is too long to fit'); assert.equal(googleCalls, 0);
});
await t('translate: Google error -> original text, characters refunded', async () => {
  process.env.MONTHLY_CHAR_CAP = '1000'; googleMode = 'fail';
  const before = (await h.pg.query(`select chars from usage_counter`)).rows[0].chars;
  const r = await TR(['Electricity bill']);
  assert.equal(r.status, 200); assert.equal(r.json.translations[0].translated, 'Electricity bill');
  assert.equal((await h.pg.query(`select chars from usage_counter`)).rows[0].chars, before); googleMode = 'ok';
});
await t('translate: target "en" returns text unchanged', async () => {
  googleCalls = 0; const r = await TR(['Hello shop'], 'en'); assert.equal(r.json.translations[0].translated, 'Hello shop'); assert.equal(googleCalls, 0);
});
await t('no secret or password hash appears in any API response', async () => {
  const all = JSON.stringify([(await A.call('GET', '/api/data')).json, (await A.call('GET', '/api/health')).json]);
  for (const s of [process.env.JWT_SECRET, 'fake-key-for-tests', '$2b$', '$2a$']) assert.ok(!all.includes(s), 'leaked ' + s);
});

console.log(results.join('\n')); console.log(`\n${pass} passed, ${fail} failed`);
await h.close(); process.exit(fail ? 1 : 0);
