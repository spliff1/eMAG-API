import { test, before, after, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { createHttpServer } from '../src/core/http.js';

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `dummy-emag-${n}-`));
const API_AUTH = `Basic ${Buffer.from('tester:pw').toString('base64')}`;

async function boot(dataDir, { persist = true } = {}) {
  const app = createApp({ dataDir, persist });
  app.settings.update({ rateLimit: { enabled: false }, autoApproveSeconds: 0 });
  const server = createHttpServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise((r) => server.close(() => { app.store.flush(); app.db.close(); r(); }));
  return { app, server, base, close };
}

const jsonFetch = async (base, method, p, body, cookie) => {
  const res = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
};

describe('SQLite persistence', () => {
  test('collections, settings, accounts and the FULL request log survive a restart', async () => {
    const dir = tmp('persist');
    let s = await boot(dir);
    const reg = await jsonFetch(s.base, 'POST', '/__ui/api/auth/register', { username: 'owner', password: 'long-enough-pw' });
    const cookie = reg.headers.get('set-cookie').split(';')[0];
    await jsonFetch(s.base, 'POST', '/__ui/api/generate/orders/orders', { count: 6, status: '2' }, cookie);
    await jsonFetch(s.base, 'PUT', '/__ui/api/settings', { latencyMs: 0, strictRules: false }, cookie);

    // a very large request body (>300 KB, previously truncated) must be stored verbatim
    const huge = 'x'.repeat(400_000);
    await fetch(`${s.base}/api-3/product_offer/save`, {
      method: 'POST', headers: { Authorization: API_AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [{ id: 777, category_id: 41, name: 'Big', part_number: 'BIG1', brand: 'Nike', description: huge, status: 1, sale_price: 10, min_sale_price: 5, max_sale_price: 20, vat_id: 1, stock: [{ warehouse_id: 1, value: 1 }], handling_time: [{ warehouse_id: 1, value: 0 }], characteristics: [{ id: 1009, value: '42' }] }] }),
    });
    const orderIds = s.app.col('orders').all().map((o) => o.id).sort();
    const lastReq = s.app.log.list({ limit: 1 }).items[0].id;
    await s.close();

    s = await boot(dir);
    assert.deepEqual(s.app.col('orders').all().map((o) => o.id).sort(), orderIds);
    assert.equal(s.app.col('offers').get(777).description.length, 400_000);
    assert.equal(s.app.settings.get().strictRules, false);
    assert.equal(s.app.col('categories').size, 18, 'seed is not duplicated');
    const full = s.app.log.get(lastReq);
    assert.equal(full.reqBody.data[0].description.length, 400_000, 'request body stored without truncation');
    assert.equal(full.reqHeaders.authorization, 'Basic ***');
    // sequences continue where they stopped
    const before = Math.max(...orderIds);
    await jsonFetch(s.base, 'POST', '/__ui/api/auth/login', { username: 'owner', password: 'long-enough-pw' });
    assert.equal(s.app.auth.registrationOpen(), false, 'account survived the restart');
    assert.ok(s.app.store.nextId('orders') > before);
    await s.close();
  });

  test('in-place document edits are detected and written (no explicit save call needed)', async () => {
    const dir = tmp('mutate');
    let s = await boot(dir);
    await jsonFetch(s.base, 'POST', '/api-3/product_offer/save', undefined); // noop (401 body-less)
    s.app.col('vat_rates').get(1).vat_rate = '0.9999';
    s.app.col('vat_rates').touch();
    await s.close();
    s = await boot(dir);
    assert.equal(s.app.col('vat_rates').get(1).vat_rate, '0.9999');
    await s.close();
  });

  test('legacy data/db.json + requests.json are migrated once', async () => {
    const dir = tmp('legacy');
    fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ version: 1, seq: { orders: 51000005 }, meta: { seeded: { categories: true }, settings: { strictRules: false } }, collections: { vat_rates: [{ vat_id: 42, vat_rate: '0.4200', status: 'active' }] } }));
    fs.writeFileSync(path.join(dir, 'requests.json'), JSON.stringify({ seq: 1, entries: [{ id: 1, ts: '2026-01-01T00:00:00Z', method: 'POST', path: '/api-3/x', status: 200, isError: false, reqBody: { a: 1 }, resBody: { ok: true }, notes: [], messages: [] }] }));
    const s = await boot(dir);
    assert.equal(s.app.col('vat_rates').get(42).vat_rate, '0.4200');
    assert.equal(s.app.settings.get().strictRules, false);
    assert.equal(s.app.log.count(), 1);
    assert.ok(fs.existsSync(path.join(dir, 'db.json.migrated')));
    await s.close();
  });
});

describe('Interrupted imports', () => {
  test('an import left "running" by a closed app is shown as interrupted and does not block new imports', async () => {
    const dir = tmp('stale');
    let s = await boot(dir);
    const job = { id: 'stale-1', status: 'running', platform: 'ro', mode: 'merge', startedAt: '2026-10-04T10:00:00.000Z', finishedAt: null, error: null,
      steps: [{ id: 'vat', label: 'VAT', status: 'done', done: 2, total: 2, imported: 2, message: '2 imported' }, { id: 'offers', label: 'Offers', status: 'running', done: 40, total: 150, imported: 40, message: '' }, { id: 'orders', label: 'Orders', status: 'pending', done: 0, total: null, imported: 0, message: '' }], log: [] };
    s.app.db.prepare('INSERT INTO import_runs (id, started_at, finished_at, status, data) VALUES (?, ?, NULL, ?, ?)').run(job.id, job.startedAt, 'running', JSON.stringify(job));
    await s.close();

    s = await boot(dir);
    const reg = await jsonFetch(s.base, 'POST', '/__ui/api/auth/register', { username: 'owner', password: 'long-enough-pw' });
    const cookie = reg.headers.get('set-cookie').split(';')[0];
    const list = (await jsonFetch(s.base, 'GET', '/__ui/api/import/jobs', undefined, cookie)).body.items;
    assert.equal(list.length, 1);
    assert.equal(list[0].status, 'failed');
    assert.match(list[0].error, /app was closed/);
    assert.deepEqual(list[0].steps.map((x) => x.status), ['done', 'failed', 'skipped']);
    assert.ok(list[0].finishedAt);
    assert.equal(s.app.db.prepare("SELECT COUNT(*) n FROM import_runs WHERE status = 'running'").get().n, 0);
    await s.close();
  });
});

describe('Leftover "running" jobs (regression)', () => {
  test('status column says failed but the stored JSON still says running (older versions) -> repaired, cancel settles it, new import allowed', async () => {
    const dir = tmp('stale2');
    let s = await boot(dir);
    const job = { id: 'stale-2', status: 'running', platform: 'ro', mode: 'merge', startedAt: '2026-10-04T09:38:17.707Z', finishedAt: null, error: null, steps: [{ id: 'campaigns', label: 'Campaigns', status: 'pending', done: 0, total: null, imported: 0, message: '' }], log: [] };
    s.app.db.prepare('INSERT INTO import_runs (id, started_at, finished_at, status, data) VALUES (?, ?, NULL, ?, ?)').run(job.id, job.startedAt, 'failed', JSON.stringify(job));
    await s.close();

    s = await boot(dir);
    const reg = await jsonFetch(s.base, 'POST', '/__ui/api/auth/register', { username: 'owner', password: 'long-enough-pw' });
    const cookie = reg.headers.get('set-cookie').split(';')[0];
    const items = (await jsonFetch(s.base, 'GET', '/__ui/api/import/jobs', undefined, cookie)).body.items;
    assert.equal(items[0].status, 'failed');
    assert.equal((await jsonFetch(s.base, 'GET', '/__ui/api/import/jobs/stale-2', undefined, cookie)).body.status, 'failed');
    const row = s.app.db.prepare('SELECT status, data FROM import_runs WHERE id = ?').get('stale-2');
    assert.equal(JSON.parse(row.data).status, 'failed', 'repaired in storage, not just in the response');
    await s.close();

    // even if a row somehow turns up as running at runtime, Cancel settles it instead of doing nothing
    s = await boot(dir);
    const reg2 = await jsonFetch(s.base, 'POST', '/__ui/api/auth/login', { username: 'owner', password: 'long-enough-pw' });
    const ck = reg2.headers.get('set-cookie').split(';')[0];
    s.app.db.prepare('INSERT INTO import_runs (id, started_at, finished_at, status, data) VALUES (?, ?, NULL, ?, ?)').run('stale-3', '2026-10-04T10:00:00.000Z', 'running', JSON.stringify({ ...job, id: 'stale-3', status: 'running' }));
    const cancel = await jsonFetch(s.base, 'POST', '/__ui/api/import/jobs/stale-3/cancel', {}, ck);
    assert.deepEqual(cancel.body, { ok: true });
    assert.equal((await jsonFetch(s.base, 'GET', '/__ui/api/import/jobs/stale-3', undefined, ck)).body.status, 'failed');
    await s.close();
  });
});

describe('UI authentication', () => {
  let s;
  before(async () => { s = await boot(tmp('auth'), { persist: false }); });
  after(() => s.close());

  test('before the first account: registration open, everything else locked', async () => {
    const st = await jsonFetch(s.base, 'GET', '/__ui/api/auth/status');
    assert.deepEqual(st.body, { registrationOpen: true, authenticated: false, username: null });
    for (const [m, p] of [['GET', '/meta'], ['GET', '/requests'], ['GET', '/events'], ['GET', '/export'], ['POST', '/reset'], ['GET', '/import/sources'], ['GET', '/collections/orders']]) {
      const r = await fetch(`${s.base}/__ui/api${p}`, { method: m });
      assert.equal(r.status, 401, `${m} ${p}`);
      assert.equal((await r.json()).code, 'auth_required');
    }
  });

  test('weak credentials are refused, the first valid sign-up wins and logs in', async () => {
    assert.equal((await jsonFetch(s.base, 'POST', '/__ui/api/auth/register', { username: 'ab', password: 'long-enough-pw' })).status, 400);
    assert.equal((await jsonFetch(s.base, 'POST', '/__ui/api/auth/register', { username: 'admin', password: 'short' })).status, 400);
    const ok = await jsonFetch(s.base, 'POST', '/__ui/api/auth/register', { username: 'admin', password: 'correct-horse' });
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const sid = cookie.split(';')[0];
    assert.equal((await jsonFetch(s.base, 'GET', '/__ui/api/meta', undefined, sid)).status, 200);
    assert.deepEqual((await jsonFetch(s.base, 'GET', '/__ui/api/auth/status', undefined, sid)).body, { registrationOpen: false, authenticated: true, username: 'admin' });
  });

  test('after the first account NOTHING can register (even with valid input or a session)', async () => {
    const again = await jsonFetch(s.base, 'POST', '/__ui/api/auth/register', { username: 'intruder', password: 'another-long-pw' });
    assert.equal(again.status, 403);
    assert.equal((await jsonFetch(s.base, 'GET', '/__ui/api/auth/status')).body.registrationOpen, false);
    assert.equal(s.app.db.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
  });

  test('concurrent first sign-ups: exactly one account is created', async () => {
    const t = await boot(tmp('race'), { persist: false });
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => jsonFetch(t.base, 'POST', '/__ui/api/auth/register', { username: `user${i}`, password: 'long-enough-pw' })));
    assert.equal(rs.filter((r) => r.status === 200).length, 1);
    assert.equal(t.app.db.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
    await t.close();
  });

  test('password is stored as a scrypt hash, session token only as SHA-256', async () => {
    const row = s.app.db.prepare('SELECT password_hash FROM users').get();
    assert.match(row.password_hash, /^scrypt\$/);
    assert.ok(!row.password_hash.includes('correct-horse'));
    const sess = s.app.db.prepare('SELECT token_hash FROM sessions').get();
    assert.match(sess.token_hash, /^[0-9a-f]{64}$/);
  });

  test('login: wrong password 401, throttled after repeated failures, logout kills the session, cross-origin writes refused', async () => {
    const t = await boot(tmp('login'), { persist: false });
    const reg = await jsonFetch(t.base, 'POST', '/__ui/api/auth/register', { username: 'admin', password: 'correct-horse' });
    const sid = reg.headers.get('set-cookie').split(';')[0];

    const evil = await fetch(`${t.base}/__ui/api/reset`, { method: 'POST', headers: { Cookie: sid, Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(evil.status, 403);

    const out = await jsonFetch(t.base, 'POST', '/__ui/api/auth/logout', {}, sid);
    assert.equal(out.status, 200);
    assert.equal((await jsonFetch(t.base, 'GET', '/__ui/api/meta', undefined, sid)).status, 401, 'session invalidated server-side');

    for (let i = 0; i < 5; i++) assert.equal((await jsonFetch(t.base, 'POST', '/__ui/api/auth/login', { username: 'admin', password: 'nope-nope-nope' })).status, 401);
    const locked = await jsonFetch(t.base, 'POST', '/__ui/api/auth/login', { username: 'admin', password: 'correct-horse' });
    assert.equal(locked.status, 429);
    assert.ok(locked.body.retryAfter > 0);
    await t.close();
  });

  test('change password: requires the current one and signs out other sessions', async () => {
    const t = await boot(tmp('pw'), { persist: false });
    const a = (await jsonFetch(t.base, 'POST', '/__ui/api/auth/register', { username: 'admin', password: 'correct-horse' })).headers.get('set-cookie').split(';')[0];
    const b = (await jsonFetch(t.base, 'POST', '/__ui/api/auth/login', { username: 'admin', password: 'correct-horse' })).headers.get('set-cookie').split(';')[0];
    assert.equal((await jsonFetch(t.base, 'POST', '/__ui/api/auth/password', { current: 'wrong', next: 'new-long-password' }, a)).status, 401);
    assert.equal((await jsonFetch(t.base, 'POST', '/__ui/api/auth/password', { current: 'correct-horse', next: 'new-long-password' }, a)).status, 200);
    assert.equal((await jsonFetch(t.base, 'GET', '/__ui/api/meta', undefined, a)).status, 200);
    assert.equal((await jsonFetch(t.base, 'GET', '/__ui/api/meta', undefined, b)).status, 401);
    assert.equal((await jsonFetch(t.base, 'POST', '/__ui/api/auth/login', { username: 'admin', password: 'new-long-password' })).status, 200);
    await t.close();
  });

  test('the dummy eMAG API itself is unaffected by UI accounts (Basic auth only)', async () => {
    const r = await jsonFetch(s.base, 'POST', '/api-3/vat/read', {});
    assert.equal(r.status, 401);
    const ok = await fetch(`${s.base}/api-3/vat/read`, { method: 'POST', headers: { Authorization: API_AUTH, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(ok.status, 200);
  });
});

// ------------------------------------------------------------------------------------------------ import
const REAL_USER = 'seller-real@firma.example';
const REAL_PASS = 'S3cr3t-Pa55-X9z!';
const REAL_AUTH = `Basic ${Buffer.from(`${REAL_USER}:${REAL_PASS}`).toString('base64')}`;

/** Minimal stand-in for the real marketplace, used on loopback. */
function fakeEmag() {
  const seen = [];
  const counters = {};
  const state = { big: false, poison: [], failFrom: null, detailError: null };
  const ok = (results) => ({ isError: false, messages: [], results });
  const page = (list, b) => list.slice(((b.currentPage || 1) - 1) * (b.itemsPerPage || 100), (b.currentPage || 1) * (b.itemsPerPage || 100));
  const offers = Array.from({ length: 150 }, (_, i) => ({
    id: i + 1, part_number_key: `PNK${String(i + 1).padStart(4, '0')}`, category_id: i % 2 ? 201 : 200, brand: 'RealBrand', name: `Real product ${i + 1}`, part_number: `RP${i + 1}`,
    ean: [`590000000${String(i).padStart(4, '0')}`], sale_price: 10 + i, status: 1, stock: [{ warehouse_id: 1, value: 5 }], vat_id: 11,
    validation_status: [{ value: 9, description: 'Approved documentation', errors: null }], offer_validation_status: { value: 1, description: 'Saleable' },
  }));
  const customer = { id: 987654, name: 'Real Person Name', email: 'abcdef@mkt.emag.ro', phone_1: '0711223344', billing_name: 'Real Person Name', billing_street: 'Strada Reala 1', billing_city: 'Cluj-Napoca', billing_locality_id: '5', shipping_contact: 'Real Person Name', shipping_phone: '0711223344', shipping_street: 'Strada Reala 1', shipping_city: 'Cluj-Napoca', shipping_locality_id: '5', legal_entity: 0 };
  const orders = [1, 2, 3].map((n) => ({ id: 9000 + n, status: 1, type: 3, payment_mode_id: 1, date: '2026-10-01 10:00:00', modified: '2026-10-01 10:00:00', customer: { ...customer }, observation: 'sună-mă', products: [{ id: n, product_id: n, name: 'Real product', quantity: 1, sale_price: 10, status: 1 }], attachments: [] }));
  const bigChar = { id: 7001, name: 'Big list', type_id: 1, display_order: 1, is_mandatory: 1, is_filter: 1, allow_new_value: 0, values: Array.from({ length: 300 }, (_, i) => ({ id: 700100 + i, name: `V${i}` })) };
  const categories = [
    { id: 100, name: 'Root', is_allowed: 0, parent_id: 0, is_ean_mandatory: 0, is_warranty_mandatory: 0 },
    { id: 200, name: 'Leaf A', is_allowed: 1, parent_id: 100, is_ean_mandatory: 1, is_warranty_mandatory: 1 },
    { id: 201, name: 'Leaf B', is_allowed: 1, parent_id: 100, is_ean_mandatory: 0, is_warranty_mandatory: 0 },
    { id: 202, name: 'Leaf C unused', is_allowed: 1, parent_id: 100, is_ean_mandatory: 0, is_warranty_mandatory: 0 },
  ];

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const b = raw ? JSON.parse(raw) : {};
      const p = req.url.replace(/^\/api-3/, '').split('?')[0];
      seen.push({ method: req.method, path: p, auth: req.headers.authorization, body: b });
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.headers.authorization !== REAL_AUTH) return send(401, { isError: true, messages: ['Unauthorized'] });
      switch (p) {
        case '/vat/read': return send(200, ok([{ vat_id: 11, vat_rate: '0.2100', status: 'active' }, { vat_id: 12, vat_rate: '0.1100', status: 'active' }]));
        case '/handling_time/read': return send(200, ok([{ id: 0, value: 0 }, { id: 2, value: 2 }]));
        case '/category/count': return send(200, ok({ noOfItems: state.big ? 250 : categories.length, noOfPages: 1, itemsPerPage: 100 }));
        case '/category/read': {
          if (b.id && state.detailError === b.id) return send(200, { isError: true, messages: ['An internal error occurred.'], errors: [], results: [] });
          if (state.big && !b.id) {
            const size = b.itemsPerPage || 100;
            const offset = ((b.currentPage || 1) - 1) * size;
            const bad = state.poison.some((i) => i >= offset && i < offset + size) || (state.failFrom !== null && offset >= state.failFrom);
            if (bad) return send(200, { isError: true, messages: ['An internal error occurred.'], errors: [], results: [] });
            const all = Array.from({ length: 250 }, (_, i) => ({ id: 1000 + i, name: `Big ${i}`, is_allowed: 1, parent_id: 0, is_ean_mandatory: 0, is_warranty_mandatory: 0 }));
            return send(200, ok(all.slice(offset, offset + size)));
          }
          if (b.id) {
            const c = categories.find((x) => x.id === b.id);
            const per = b.valuesPerPage || 256;
            const vals = bigChar.values.slice(((b.valuesCurrentPage || 1) - 1) * per, (b.valuesCurrentPage || 1) * per);
            return send(200, ok(c ? [{ ...c, characteristics: [{ ...bigChar, values: vals }], family_types: [] }] : []));
          }
          return send(200, ok(page(categories, b)));
        }
        case '/product_offer/count': return send(200, ok({ noOfItems: offers.length, noOfPages: 2, itemsPerPage: 100 }));
        case '/product_offer/read': return send(200, ok(page(offers, b)));
        case '/order/count': return send(200, ok({ noOfItems: orders.length, noOfPages: 1, itemsPerPage: 100 }));
        case '/order/read': return send(200, ok(page(JSON.parse(JSON.stringify(orders)), b)));
        case '/campaigns/read': return send(200, ok([1, 2, 3, 4, 5, 6, 7].map((n) => ({ id: 2400 + n, name: `Camp ${n}`, status: 1, type: 2, startDate: '2026-10-01T00:00:00+03:00', endDate: '2026-12-01T00:00:00+03:00', endPreparationDate: '2026-10-20T00:00:00+03:00', participationRules: { restrictedCategories: true, minStock: null } }))));
        case '/campaign_categories/read': {
          const shapes = {
            2401: ok([{ id: 200, name: 'Laptops', scmId: 21, parentId: 100, parentName: 'Root', parentScmId: 11 }, { id: 201, name: 'Phones', scmId: 22, parentId: 100, parentName: 'Root', parentScmId: 11 }]),
            2402: ok({ categories: [{ id: 200, name: 'Imprimante', scmId: 22, parentId: null, parentName: null, parentScmId: null }] }),
            2403: ok({ 200: { name: 'A' }, 201: { name: 'B' } }),
            2404: ok({ message: 'something unexpected' }),
          };
          if (b.campaignId === 2406) { // 250 categories, properly paged
            const all = Array.from({ length: 250 }, (_, i) => ({ id: 5000 + i, name: `Cat ${i}`, scmId: i, parentId: null, parentName: null, parentScmId: null }));
            return send(200, ok(all.slice(((b.currentPage || 1) - 1) * 100, (b.currentPage || 1) * 100)));
          }
          if (b.campaignId === 2407) { // ignores currentPage: always the same full page (must not loop)
            counters.paged2407 = (counters.paged2407 || 0) + 1;
            return send(200, ok(Array.from({ length: 100 }, (_, i) => ({ id: 9000 + i, name: `Same ${i}`, scmId: i, parentId: null, parentName: null, parentScmId: null }))));
          }
          if (!b.campaignId) return send(400, { isError: true, messages: { campaignId: 'campaignId cannot be empty' }, results: [] });
          if (b.campaignId === 2405) return send(200, { isError: true, messages: { campaign_id: 'Campaign is not available for this account' }, results: [] });
          return send(200, shapes[b.campaignId] || ok([]));
        }
        case '/courier_accounts/read': return send(200, ok([{ account_id: 55, account_display_name: 'Real courier', courier_account_type: 3, courier_name: 'Fan Courier', status: 1 }]));
        default: return send(404, { isError: true, messages: [`unknown ${p}`] });
      }
    });
  });
  return { server, seen, counters, state };
}

describe('Import from the real API (credentials never stored)', () => {
  let dir; let s; let cookie; let fake; let fakeBase;
  before(async () => {
    fake = fakeEmag();
    await new Promise((r) => fake.server.listen(0, '127.0.0.1', r));
    fakeBase = `http://127.0.0.1:${fake.server.address().port}/api-3`;
    dir = tmp('import');
    s = await boot(dir);
    const reg = await jsonFetch(s.base, 'POST', '/__ui/api/auth/register', { username: 'owner', password: 'long-enough-pw' });
    cookie = reg.headers.get('set-cookie').split(';')[0];
  });
  after(async () => { await s.close(); fake.server.close(); });

  const startImport = (body) => jsonFetch(s.base, 'POST', '/__ui/api/import/start', { platform: 'ro', baseUrl: fakeBase, mode: 'replace', ...body }, cookie);
  async function waitJob(id) {
    for (let i = 0; i < 100; i++) {
      const j = (await jsonFetch(s.base, 'GET', `/__ui/api/import/jobs/${id}`, undefined, cookie)).body;
      if (j.status !== 'running') return j;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('import did not finish');
  }

  test('lists platforms and sources, flags personal-data sources', async () => {
    const r = (await jsonFetch(s.base, 'GET', '/__ui/api/import/sources', undefined, cookie)).body;
    assert.deepEqual(r.platforms.map((p) => p.id).sort(), ['bg', 'fd_bg', 'fd_ro', 'hu', 'ro']);
    assert.ok(r.platforms.every((p) => p.baseUrl.startsWith('https://')));
    assert.deepEqual(r.sources.filter((x) => x.pii).map((x) => x.id).sort(), ['orders', 'rmas']);
    assert.ok(r.sources.find((x) => x.id === 'categories').options.length >= 1);
  });

  test('bad input / unknown source / arbitrary hosts are refused before any request leaves', async () => {
    assert.equal((await startImport({ username: 'u', password: 'p', sources: ['nope'] })).status, 400);
    assert.equal((await startImport({ username: '', password: '', sources: ['vat'] })).status, 400);
    const before = fake.seen.length;
    const ext = await jsonFetch(s.base, 'POST', '/__ui/api/import/start', { platform: 'ro', baseUrl: 'https://attacker.example/api-3', username: 'u', password: 'p', sources: ['vat'] }, cookie);
    assert.equal(ext.status, 400);
    assert.match(ext.body.error, /loopback/);
    assert.equal(fake.seen.length, before);
  });

  test('wrong credentials -> 401 with a clear message and no job', async () => {
    const r = await startImport({ username: REAL_USER, password: 'wrong', sources: ['vat'] });
    assert.equal(r.status, 401);
    assert.match(r.body.error, /rejected the credentials/);
    assert.equal((await jsonFetch(s.base, 'GET', '/__ui/api/import/jobs', undefined, cookie)).body.items.length, 0);
  });

  test('imports reference data, offers (+catalogue), categories with paged values and anonymized orders', async () => {
    // local dummy offers use dummy categories; the real import must replace them
    s.app.module('products').generators.find((g) => g.id === 'offers').run(s.app, { count: 3, validation: 'approved' });
    const r = await startImport({
      username: REAL_USER, password: REAL_PASS, sources: ['vat', 'handling_time', 'offers', 'categories', 'courier_accounts', 'orders'],
      options: { categories: { details: 'used' }, orders: { days: 7, anonymize: true } },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const job = await waitJob(r.body.jobId);
    assert.equal(job.status, 'done', JSON.stringify(job.steps));
    assert.deepEqual(job.steps.map((x) => [x.id, x.status]), [['vat', 'done'], ['handling_time', 'done'], ['offers', 'done'], ['categories', 'done'], ['courier_accounts', 'done'], ['orders', 'done']]);

    assert.deepEqual(s.app.col('vat_rates').all().map((v) => v.vat_id).sort(), [11, 12]);
    assert.equal(s.app.col('offers').size, 150, 'replace mode dropped the 3 dummy offers');
    assert.ok(s.app.col('offers').get(150)._imported);
    assert.ok(s.app.col('catalogue').has('PNK0007'), 'imported offers feed the catalogue');
    assert.equal(s.app.col('categories').size, 4);
    const leafA = s.app.col('categories').get(200);
    assert.equal(leafA._detail, true);
    assert.equal(leafA.names.ro, 'Leaf A');
    assert.equal(leafA.characteristics[0].values.length, 300, 'characteristic values fetched across pages');
    assert.equal(s.app.col('categories').get(202)._detail, false, 'unused categories only get the tree entry');
    assert.equal(s.app.col('categories').get(100)._isLeaf, false);
    assert.equal(s.app.col('courier_accounts').get(55).courier_name, 'Fan Courier');

    // anonymized orders keep structure/ids but no personal data
    const orders = s.app.col('orders').all();
    assert.equal(orders.length, 3);
    const o = orders[0];
    assert.notEqual(o.customer.name, 'Real Person Name');
    assert.notEqual(o.customer.phone_1, '0711223344');
    assert.notEqual(o.customer.billing_street, 'Strada Reala 1');
    assert.equal(o.customer.billing_city, 'Cluj-Napoca');
    assert.equal(o.observation, '');
    assert.equal(new Set(orders.map((x) => x.customer.name)).size, 1, 'same real customer -> same fake customer');

    // and the imported data is served by the dummy API
    const read = await fetch(`${s.base}/api-3/product_offer/read`, { method: 'POST', headers: { Authorization: API_AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 42 }) });
    assert.equal((await read.json()).results[0].name, 'Real product 42');
    const cat = await fetch(`${s.base}/api-3/category/read`, { method: 'POST', headers: { Authorization: API_AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 200 }) });
    assert.equal((await cat.json()).results[0].characteristics[0].values.length, 256, 'dummy paginates values like the real one');
  });

  test('the importer is strictly read-only and used exactly the credentials it was given', async () => {
    assert.ok(fake.seen.length > 10);
    const wrongAttempts = fake.seen.filter((c) => c.auth !== REAL_AUTH);
    assert.equal(wrongAttempts.length, 1, 'only the deliberate wrong-password probe used other credentials');
    for (const c of fake.seen) {
      assert.equal(c.method, 'POST');
      assert.match(c.path, /\/(read|count)$/, `unexpected endpoint ${c.path}`);
    }
    assert.ok(!fake.seen.some((c) => /save|acknowledge|attachments/.test(c.path)));
  });

  test('CREDENTIALS ARE NEVER PERSISTED: database, WAL, job history, request log and exports contain no trace', async () => {
    s.app.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    s.app.store.flush();
    const needles = [REAL_PASS, REAL_USER, Buffer.from(`${REAL_USER}:${REAL_PASS}`).toString('base64'), Buffer.from(REAL_PASS).toString('base64'), encodeURIComponent(REAL_PASS)];
    const files = fs.readdirSync(dir).map((f) => path.join(dir, f));
    assert.ok(files.some((f) => f.endsWith('.sqlite')));
    for (const f of files) {
      const bytes = fs.readFileSync(f).toString('latin1');
      for (const n of needles) assert.ok(!bytes.includes(n), `${path.basename(f)} contains "${n.slice(0, 6)}…"`);
    }
    const dumps = [
      JSON.stringify(s.app.importer.list()),
      JSON.stringify(s.app.db.prepare('SELECT * FROM import_runs').all()),
      JSON.stringify(s.app.db.prepare('SELECT * FROM requests').all()),
      JSON.stringify(s.app.store.snapshot()),
    ];
    for (const d of dumps) for (const n of needles) assert.ok(!d.includes(n));
    const job = s.app.importer.list()[0];
    assert.ok(!JSON.stringify(job).includes('password'));
  });

  test('campaigns: eligible categories are extracted from any response shape, unknown shapes become "all eligible" instead of crashing', async () => {
    const c = (id) => s.app.col('campaigns').get(id);
    const logs = mock.method(console, 'log', () => {});
    const r = await startImport({ username: REAL_USER, password: REAL_PASS, sources: ['campaigns'], mode: 'replace' });
    const job = await waitJob(r.body.jobId);
    logs.mock.restore();
    assert.equal(job.status, 'done', JSON.stringify(job.steps));
    const printed = logs.mock.calls.map((c) => c.arguments.join(' ')).join('\n');
    assert.match(printed, /\[import:debug\].*campaignId: 2404.*something unexpected/s, 'unknown shape is printed to the console');
    assert.match(printed, /\[import:debug\].*campaignId: 2401.*2 ids recognised/s, 'the first campaign is always sampled, even when recognised');
    assert.match(printed, /\[import\] Campaigns: done, 7 imported/);
    assert.equal(c(2406)._categories.length, 250, 'all pages read');
    assert.equal(c(2407)._categories.length, 100, 'a repeating page is detected and stops the loop');
    assert.equal(fake.counters.paged2407, 2, 'exactly one extra request, no endless paging');
    assert.ok(job.steps[0].total === 7 && job.steps[0].done === 7, JSON.stringify(job.steps[0]));
    // the real API answers isError with `messages` as an OBJECT: it must be reported, not crash the formatter
    assert.equal(c(2405)._categoriesUnknown, true);
    assert.ok(job.log.some((l) => /Campaign 2405.*Campaign is not available for this account/.test(l)), job.log.join('\n'));
    assert.doesNotMatch(job.log.join('\n'), /is not a function/);
    assert.match(printed, /\[import:error\] \/campaign_categories\/read \{"campaignId":2405.*not available for this account/s);
    assert.ok(!printed.includes(REAL_PASS) && !printed.includes(REAL_USER) && !/Basic /.test(printed), 'console output never contains credentials');
    assert.deepEqual(c(2401)._categories, [200, 201]);
    assert.deepEqual(c(2402)._categories, [200]);
    // names/parents come straight from the real reply and are served back verbatim, even without the category tree
    s.app.col('categories').clear();
    const served = await fetch(`${s.base}/api-3/campaign_categories/read`, { method: 'POST', headers: { Authorization: API_AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ campaignId: 2401 }) });
    assert.deepEqual((await served.json()).results.map((r) => [r.id, r.name, r.parentName]), [[200, 'Laptops', 'Root'], [201, 'Phones', 'Root']]);
    assert.deepEqual(c(2403)._categories.sort(), [200, 201]);
    assert.equal(c(2404)._categoriesUnknown, true);
    assert.ok(job.log.some((l) => /Campaign 2404.*object\{message\}/.test(l)), 'log describes the shape (keys only, no values)');
    assert.ok(!job.log.some((l) => l.includes('something unexpected')));
    // an unrecognised restriction does not make the campaign useless for proposals
    const camps = await fetch(`${s.base}/api-3/campaign_categories/read`, { method: 'POST', headers: { Authorization: API_AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ campaignId: 2404 }) });
    assert.equal((await camps.json()).isError, false);
    const missing = await fetch(`${s.base}/api-3/campaign_categories/read`, { method: 'POST', headers: { Authorization: API_AUTH, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(missing.status, 400, 'like the real API: campaignId is mandatory');
    assert.deepEqual((await missing.json()).messages, { campaignId: 'campaignId cannot be empty' });
  });

  test('a broken page ("An internal error occurred.") is split to isolate and skip only the poisonous record', async () => {
    fake.state.big = true; fake.state.poison = [137];
    const callsBefore = fake.seen.length;
    const logs = mock.method(console, 'log', () => {});
    const r = await startImport({ username: REAL_USER, password: REAL_PASS, sources: ['categories'], mode: 'replace', options: { categories: { details: 'none' } } });
    const job = await waitJob(r.body.jobId);
    logs.mock.restore();
    fake.state.big = false; fake.state.poison = [];
    assert.equal(job.status, 'done', JSON.stringify(job.steps));
    assert.equal(s.app.col('categories').size, 249, 'everything except the one broken record');
    assert.ok(!s.app.col('categories').has(1137));
    assert.match(job.steps[0].message, /249 imported, 1 skipped/);
    assert.ok(job.log.some((l) => /page 2.*1 item\(s\) could not be read and were skipped/.test(l)), job.log.join('\n'));
    const catCalls = fake.seen.slice(callsBefore).filter((c) => c.path === '/category/read').length;
    assert.ok(catCalls < 60, `request budget respected (${catCalls})`);
  });

  test('a failing category-details call only costs that category its characteristics', async () => {
    fake.state.detailError = 201;
    const logs = mock.method(console, 'log', () => {});
    const r = await startImport({ username: REAL_USER, password: REAL_PASS, sources: ['categories'], mode: 'replace', options: { categories: { details: 'allowed' } } });
    const job = await waitJob(r.body.jobId);
    logs.mock.restore();
    fake.state.detailError = null;
    assert.equal(job.status, 'done', JSON.stringify(job.steps));
    assert.equal(s.app.col('categories').get(200)._detail, true);
    assert.equal(s.app.col('categories').get(201)._detail, false);
    assert.ok(job.log.some((l) => /Category 201: details could not be read/.test(l)));
  });

  test('when the marketplace keeps failing, the import stops with a partial result instead of failing everything', async () => {
    fake.state.big = true; fake.state.failFrom = 100;
    const logs = mock.method(console, 'log', () => {});
    const r = await startImport({ username: REAL_USER, password: REAL_PASS, sources: ['categories'], mode: 'replace', options: { categories: { details: 'none' } } });
    const job = await waitJob(r.body.jobId);
    logs.mock.restore();
    fake.state.big = false; fake.state.failFrom = null;
    assert.equal(job.status, 'done');
    assert.equal(s.app.col('categories').size, 100, 'the readable first page is kept');
    assert.ok(job.log.some((l) => /keeps failing/.test(l)));
  });

  test('merge mode keeps local data; failures are reported per step; cancel works', async () => {
    s.app.col('vat_rates').insert({ vat_id: 99, vat_rate: '0.9900', status: 'active' });
    const r = await startImport({ username: REAL_USER, password: REAL_PASS, sources: ['vat'], mode: 'merge' });
    const job = await waitJob(r.body.jobId);
    assert.equal(job.status, 'done');
    assert.ok(s.app.col('vat_rates').has(99) && s.app.col('vat_rates').has(11));

    // a source whose endpoint 404s fails alone, the job reports it
    const bad = await startImport({ username: REAL_USER, password: REAL_PASS, sources: ['addresses', 'vat'] });
    const bj = await waitJob(bad.body.jobId);
    assert.equal(bj.status, 'failed');
    assert.ok(bj.steps.find((x) => x.id === 'addresses').status === 'failed');
    assert.ok(bj.steps.find((x) => x.id === 'vat').status === 'done');
  });
});
