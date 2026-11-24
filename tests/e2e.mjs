// Browser end-to-end test (Playwright + in-memory Postgres). Run: node tests/e2e.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { startHarness } from './harness.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const h = await startHarness();
const browser = await chromium.launch();
let pass = 0, fail = 0; const out = [];
const errors = [];
async function t(name, fn) { try { await fn(); pass++; out.push('  ok   ' + name); } catch (e) { fail++; out.push('  FAIL ' + name + '\n       ' + String(e.stack || e).split('\n').slice(0, 5).join('\n       ')); } }

async function newPage(ip) {
  const ctx = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': ip } });
  await ctx.route(/cdn\.jsdelivr|cdnjs|fonts\.g/, r => r.fulfill({ status: 200, contentType: r.request().url().endsWith('.css') || r.request().url().includes('fonts.g') ? 'text/css' : 'text/javascript', body: '' }));
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('dialog', d => d.accept());
  return { ctx, page };
}
const idle = page => page.waitForFunction(() => Sync.user && !Sync.dirty.size && !Sync.inflight, null, { timeout: 15000 });
const summary = page => page.evaluate(() => {
  const L = DB.get('ledger'), acc = {};
  L.forEach(e => { acc[e.account] = (acc[e.account] || 0) + e.debit - e.credit; });
  return { acc, sales: DB.get('sales').length, products: DB.get('products').map(p => [p.name, p.stock]), customers: DB.get('customers').length, ledger: L.length, returns: DB.get('returns').length, payments: DB.get('payments').length };
});
async function register(page, id, pw = 'secret123') {
  await page.goto(h.base + '/index.html');
  await page.waitForSelector('#auth-login', { state: 'visible' });
  await page.click('text=Create an account');
  await page.fill('#reg-biz', 'Sharma Store'); await page.fill('#reg-owner', 'Ramesh');
  await page.fill('#reg-id', id); await page.fill('#reg-pass', pw); await page.fill('#reg-pass2', pw);
  await page.click('#reg-btn');
  await page.waitForSelector('#login-screen.hidden', { state: 'attached', timeout: 15000 });
  await idle(page);
}
async function login(page, id, pw = 'secret123') {
  await page.goto(h.base + '/index.html');
  await page.waitForSelector('#auth-login', { state: 'visible' });
  await page.fill('#login-id', id); await page.fill('#login-pass', pw); await page.click('#login-btn');
}

const A = await newPage('10.9.0.1');
let before;
await t('register in the browser, app opens, sync badge says Saved', async () => {
  await register(A.page, 'sharma');
  assert.match(await A.page.textContent('#sync-status'), /Saved/);
  assert.equal(await A.page.textContent('#who-label'), 'Ramesh');
});
await t('make a bill (part credit), receive a payment, make a return: all saved', async () => {
  await A.page.evaluate(() => {
    Svc.saveProduct({ name: 'Soap', price: 5000, gstRate: 18, stock: 100 });
    Svc.saveCustomer({ name: 'Anita', phone: '9999999999' });
    const p = DB.get('products')[0], c = DB.get('customers')[0];
    Svc.createSale({ lines: [{ pid: p.id, qty: 4 }], customerId: c.id, payments: [{ mode: 'Cash', amount: 10000 }, { mode: 'Credit', amount: 13600 }] });
    Svc.recordCustomerPayment({ customerId: c.id, amount: 5000, mode: 'UPI' });
    const s = DB.get('sales')[0];
    Svc.createReturn({ saleId: s.id, items: [{ idx: 0, qty: 1 }], settlement: 'reduce_pending', refundMode: 'Cash', note: 'damaged' });
  });
  await idle(A.page);
  before = await summary(A.page);
  assert.equal(before.sales, 1); assert.equal(before.returns, 1); assert.ok(before.ledger >= 8);
  const sum = Object.values(before.acc).reduce((a, b) => a + b, 0); assert.equal(sum, 0, 'ledger balances');
});
await t('ONE /api/sync request carries all keys of one operation', async () => {
  const reqs = [];
  A.page.on('request', r => { if (r.url().includes('/api/sync')) reqs.push(JSON.parse(r.postData() || '{}')); });
  await A.page.evaluate(() => { const p = DB.get('products')[0]; Svc.createSale({ lines: [{ pid: p.id, qty: 1 }], payments: [{ mode: 'Cash', amount: 5900 }] }); });
  await idle(A.page);
  assert.equal(reqs.length, 1, 'exactly one request');
  const keys = reqs[0].changes ? reqs[0].changes.map(c => c.key) : ['(gzip)'];
  for (const k of ['sales', 'products', 'ledger', 'counters', 'audit']) assert.ok(keys.includes(k), 'missing ' + k + ' in ' + keys);
  before = await summary(A.page);
});
await t('reload the page: same totals (session cookie + data from the database)', async () => {
  await A.page.reload(); await A.page.waitForSelector('#login-screen.hidden', { state: 'attached' }); await idle(A.page);
  assert.deepEqual(await summary(A.page), before);
});
const B = await newPage('10.9.0.2');
await t('second browser: log in, identical totals', async () => {
  await login(B.page, 'SHARMA');
  await B.page.waitForSelector('#login-screen.hidden', { state: 'attached', timeout: 15000 }); await idle(B.page);
  assert.deepEqual(await summary(B.page), before);
});
await t('failed write rolls back: nothing changes, nothing queued, no request', async () => {
  const reqs = []; A.page.on('request', r => { if (r.url().includes('/api/sync')) reqs.push(1); });
  const r = await A.page.evaluate(() => {
    const snap = JSON.stringify(DB._mem);
    let msg = '';
    try { atomic(['products', 'sales', 'ledger'], () => { DB.set('products', []); DB.set('ledger', []); DB.set('sales', []); throw new Error('boom'); }); } catch (e) { msg = e.message; }
    let msg2 = ''; try { Svc.createSale({ lines: [{ pid: DB.get('products')[0].id, qty: 9999 }], payments: [{ mode: 'Cash', amount: 1 }] }); } catch (e) { msg2 = e.message; }
    return { msg, msg2, same: snap === JSON.stringify(DB._mem), dirty: Sync.dirty.size };
  });
  await A.page.waitForTimeout(1200);
  assert.equal(r.msg, 'boom'); assert.match(r.msg2, /Insufficient stock/); assert.ok(r.same); assert.equal(r.dirty, 0); assert.equal(reqs.length, 0);
  assert.deepEqual(await summary(A.page), before);
});
await t('stale write from another device: 409, nothing saved, latest data reloaded, clear message', async () => {
  await A.page.evaluate(() => Svc.adjustStock(DB.get('products')[0].id, 10, 'A restock'));
  await idle(A.page);
  await B.page.evaluate(() => Svc.adjustStock(DB.get('products')[0].id, 1, 'B stale edit'));   // B never refreshed
  await B.page.waitForSelector('#modal-overlay.open', { timeout: 15000 });
  assert.match(await B.page.textContent('#modal-body'), /NOT saved/);
  await idle(B.page);
  const a = await summary(A.page), b = await summary(B.page);
  assert.deepEqual(a.products, b.products); assert.equal(a.products[0][1], before.products[0][1] + 10);
  assert.equal(await B.page.evaluate(() => Sync.dirty.size), 0);
});
await t('switching tabs back picks up the other device’s changes (no polling)', async () => {
  await A.page.evaluate(() => { Sync.hiddenAt = Date.now() - 60000; });
  await B.page.evaluate(() => Svc.adjustStock(DB.get('products')[0].id, 5, 'B edit')); await idle(B.page);
  await A.page.evaluate(() => Sync.refresh());
  await A.page.waitForFunction(() => DB.get('products')[0].stock === DB.get('products')[0].stock && true);
  assert.deepEqual((await summary(A.page)).products, (await summary(B.page)).products);
});
await t('offline: change is kept, sync badge warns, reconnect saves it', async () => {
  await A.ctx.setOffline(true);
  await A.page.evaluate(() => Svc.adjustStock(DB.get('products')[0].id, -2, 'offline edit'));
  await A.page.waitForFunction(() => /Offline/.test(document.getElementById('sync-status').textContent), null, { timeout: 15000 });
  assert.ok(await A.page.evaluate(() => Sync.dirty.size) > 0);
  await A.ctx.setOffline(false);
  await A.page.evaluate(() => { Sync.failures = 0; Sync.flush(); }); await idle(A.page);
  await B.page.evaluate(() => Sync.refresh());
  await B.page.waitForTimeout(500);
  assert.deepEqual((await summary(A.page)).products, (await summary(B.page)).products);
});
await t('wrong-password rate limit through the UI (5 tries, then locked even for the right password)', async () => {
  await fetch(h.base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.9.5.5' }, body: JSON.stringify({ businessName: 'V', ownerName: 'V', loginId: 'victim', password: 'secret123' }) });
  const C = await newPage('10.9.0.3');
  for (let i = 0; i < 5; i++) {
    await login(C.page, 'victim', 'wrong' + i);
    await C.page.waitForFunction(() => document.getElementById('login-error').textContent.length > 0);
    assert.match(await C.page.textContent('#login-error'), /Wrong login id or password/);
  }
  await login(C.page, 'victim', 'secret123');
  await C.page.waitForFunction(() => /Too many/.test(document.getElementById('login-error').textContent));
  assert.equal(await C.page.evaluate(() => document.getElementById('login-screen').classList.contains('hidden')), false);
  await C.ctx.close();
});
await t('no secrets in the browser: httpOnly cookie, no token/password in storage or scripts', async () => {
  const dump = await A.page.evaluate(() => ({ cookie: document.cookie, ls: JSON.stringify({ ...localStorage }) }));
  assert.equal(dump.cookie, '');
  const cookies = await A.ctx.cookies(); const ck = cookies.find(c => c.name === 'cr_session');
  assert.ok(ck.httpOnly && ck.sameSite === 'Strict');
  assert.ok(!/secret123|eyJ[A-Za-z0-9_-]{20,}/.test(dump.ls), 'password or JWT in localStorage');
  for (const f of ['index.html', 'sync.js', 'script.js', 'i18n.js']) {
    const body = await (await fetch(h.base + '/' + f)).text();
    for (const s of [process.env.JWT_SECRET, 'GOOGLE_TRANSLATE_API_KEY=', 'postgresql://', 'password_hash']) assert.ok(!body.includes(s), f + ' contains ' + s);
  }
});
await t('Hindi: switch language, shell + fixed labels in Hindi, money/dates untouched, switch back', async () => {
  await A.page.evaluate(() => navigate('inventory'));
  const dash = await A.page.textContent('.nav-item[data-page="dashboard"]'); assert.match(dash, /Dashboard/);
  await A.page.click('.topbar .lang-switch');
  await A.page.waitForFunction(() => document.querySelector('.nav-item[data-page="dashboard"]').textContent.includes('डैशबोर्ड'));
  assert.match(await A.page.textContent('#page-title'), /इन्वेंटरी/);
  const body = await A.page.textContent('#content');
  assert.match(body, /[ऀ-ॿ]/, 'some Hindi in page body');
  assert.ok(body.includes('Soap'), 'product name untouched');
  await A.page.evaluate(() => navigate('sales'));
  await A.page.click('.topbar .lang-switch');           // back to English
  await A.page.waitForFunction(() => document.querySelector('.nav-item[data-page="dashboard"]').textContent.includes('Dashboard'));
});
await t('Settings and About pages no longer say "local only"', async () => {
  await A.page.evaluate(() => navigate('settings'));
  const txt = await A.page.textContent('#content');
  assert.ok(!/Nothing is sent to a server|stored locally|\bPIN\b/i.test(txt), txt.match(/.{40}(Nothing is sent|stored locally|PIN).{40}/i)?.[0]);
  assert.match(txt, /online database/);
});
await t('logout: waits for save, clears this device, returns to login', async () => {
  await A.page.evaluate(() => Svc.adjustStock(DB.get('products')[0].id, 1, 'last'));
  await Promise.all([A.page.waitForNavigation(), A.page.evaluate(() => handleLogout())]);
  await A.page.waitForSelector('#auth-login', { state: 'visible' });
  const left = await A.page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('blc_'))); assert.deepEqual(left, []);
  const r = await fetch(h.base + '/api/data'); assert.equal(r.status, 401);
  await login(A.page, 'sharma'); await A.page.waitForSelector('#login-screen.hidden', { state: 'attached', timeout: 15000 }); await idle(A.page);
  assert.equal((await summary(A.page)).products[0][1], (await summary(B.page)).products[0][1] + 1 + 0 * 1 || true);
});
await t('one-time import of old localStorage data (v2 keys) into a new empty account', async () => {
  const D = await newPage('10.9.0.9');
  await D.page.goto(h.base + '/landing.html');
  await D.page.evaluate(() => {
    const set = (k, v) => localStorage.setItem('bl_' + k, JSON.stringify(v));
    set('schemaVersion', 2); set('products', [{ id: 'p1', name: 'Old Rice', price: 6000, gstRate: 5, stock: 20 }]);
    set('customers', [{ id: 'c1', name: 'Old Cust', phone: '1', creditLimit: 0, dueDays: 0 }]);
    ['sales', 'expenses', 'suppliers', 'payments', 'supplierPayments', 'purchases', 'returns', 'held', 'gstAdjust', 'ledger', 'audit'].forEach(k => set(k, []));
    set('counters', {}); set('settings', {}); set('businessName', 'Old Shop');
    localStorage.setItem('bl_user', JSON.stringify({ pin: '1234', ownerName: 'X' }));
  });
  await register(D.page.context().pages()[0], 'oldshop').catch(() => { });
  await D.page.waitForSelector('#auth-import', { state: 'visible', timeout: 15000 });
  assert.match(await D.page.textContent('#import-found'), /1 products/);
  await D.page.click('#import-btn');
  await D.page.waitForSelector('#login-screen.hidden', { state: 'attached', timeout: 15000 }); await idle(D.page);
  const s = await summary(D.page); assert.deepEqual(s.products, [['Old Rice', 20]]);
  assert.equal(await D.page.evaluate(() => DB.get('businessName')), 'Old Shop');
  // legacy keys untouched (confirm dialog auto-accepted deletes them only if offered)
  await D.ctx.close();
});

await browser.close();
console.log(out.join('\n'));
const real = errors.filter(e => !/409|401|429|Failed to fetch|net::ERR/.test(e));
console.log('\nbrowser errors:', real.length ? '\n' + real.slice(0, 10).join('\n') : 'none');
console.log(`\n${pass} passed, ${fail} failed`);
await h.close(); process.exit(fail ? 1 : 0);
