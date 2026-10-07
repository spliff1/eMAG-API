import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { createHttpServer } from '../src/core/http.js';
import { deepMerge } from '../src/core/util.js';
import { MAX_DOCS } from '../src/core/store.js';

let app;
let server;
let base;
let cookie = '';
const AUTH = `Basic ${Buffer.from('tester:pw').toString('base64')}`;

const api = (path, body, headers = {}) => fetch(`${base}/api-3${path}`, { method: 'POST', headers: { Authorization: AUTH, 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const ui = async (method, path, body) => {
  const res = await fetch(`${base}/__ui/api${path}`, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
};

before(async () => {
  app = createApp({ persist: false, host: '0.0.0.0' }); // "exposed" configuration
  app.settings.update({ autoApproveSeconds: 0, rateLimit: { enabled: false } });
  server = createHttpServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const reg = await fetch(`${base}/__ui/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'correct-horse' }) });
  cookie = reg.headers.get('set-cookie').split(';')[0];
});
after(() => server.close());

test('prototype pollution: deepMerge and settings ignore __proto__ / constructor keys', async () => {
  deepMerge({}, JSON.parse('{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted2":1}}}'));
  assert.equal({}.polluted, undefined);
  assert.equal({}.polluted2, undefined);
  const r = await ui('PUT', '/settings', JSON.parse('{"__proto__":{"polluted":1},"latencyMs":0}'));
  assert.equal(r.status, 200);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  const snap = await ui('POST', '/import', JSON.parse('{"collections":{},"meta":{"settings":{"__proto__":{"polluted":1}}}}'));
  assert.equal(snap.status, 200);
  assert.equal({}.polluted, undefined);
  app.resetData(); // the empty snapshot wiped the reference data
});

test('security headers on the UI, none of the restrictive ones on the dummy API', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.doesNotMatch(await page.text(), /<script>/, 'no inline scripts (CSP)');
  const uiRes = await fetch(`${base}/__ui/api/auth/status`);
  assert.equal(uiRes.headers.get('cache-control'), 'no-store');
  const apiRes = await api('/vat/read', {});
  assert.equal(apiRes.headers.get('access-control-allow-origin'), '*');
  assert.equal(apiRes.headers.get('x-frame-options'), null);
});

test('static files: path traversal and null bytes are refused', async () => {
  for (const p of ['/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/server.js', '/..\\..\\package.json']) {
    const res = await fetch(`${base}${p}`);
    assert.notEqual(res.status, 200, p);
    assert.doesNotMatch(await res.text(), /"name": "dummy-emag"|createApp/, p);
  }
  const nul = await fetch(`${base}/index.html%00.js`);
  assert.equal(nul.status, 400);
});

test('API body limit: oversized JSON -> 413 and nothing is stored', async () => {
  const before = app.log.count();
  const res = await api('/product_offer/save', `{"data":[{"x":"${'y'.repeat(3 * 1024 * 1024)}"}]}`).catch(() => null);
  if (res) assert.equal(res.status, 413);
  assert.equal(app.col('offers').size, 0);
  assert.equal(app.log.count(), before + 1);
});

test('request log: bodies above LOG_BODY_MAX_BYTES are stored truncated', async () => {
  const big = { data: [{ big: 'z'.repeat(1_200_000) }] };
  await api('/order/read', big);
  const last = (await ui('GET', '/requests?limit=1')).body.items[0];
  const full = (await ui('GET', `/requests/${last.id}`)).body;
  assert.equal(full.reqBody.__truncated, true);
  assert.ok(full.reqBody.bytes > 1_000_000);
});

test('store capacity: a collection cannot grow past MAX_DOCS_PER_COLLECTION (API -> 507, UI -> 507)', async () => {
  const col = app.col('callback_log');
  col.clear();
  for (let i = 0; i < MAX_DOCS; i++) col.map.set(String(i + 1), { id: i + 1 });
  assert.throws(() => col.insert({ x: 1 }), /Storage limit reached/);
  assert.throws(() => col.insertMany([{ x: 1 }]), /Storage limit reached/);
  assert.doesNotThrow(() => col.insert({ id: 5, x: 'replace existing' }));
  col.clear();

  const offers = app.col('offers');
  offers.clear();
  for (let i = 0; i < MAX_DOCS; i++) offers.map.set(String(i + 1), { id: i + 1 });
  const vatId = app.col('vat_rates').all()[0].vat_id;
  const catId = app.col('categories').find((c) => c._isLeaf)?.id ?? app.col('categories').all()[0].id;
  const res = await api('/product_offer/save', { data: [{ id: 999999, name: 'x', part_number: 'x', brand: 'b', category_id: catId, sale_price: 1, min_sale_price: 1, max_sale_price: 2, vat_id: vatId, stock: [{ warehouse_id: 1, value: 1 }], handling_time: [{ warehouse_id: 1, value: 1 }], status: 1 }] });
  assert.equal(res.status, 507, JSON.stringify(await res.json()));
  const gen = await ui('POST', '/generate/products/offers', { count: 1 });
  assert.equal(gen.status, 507);
  offers.clear();
});

test('callbacks: private / loopback / metadata targets are refused on an exposed server', async () => {
  const target = http.createServer((req, res) => res.end('ok'));
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${target.address().port}/hook`;
  const bad = [url, 'http://localhost:9/x', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/', 'http://[::1]:9/', 'ftp://example.com/x'];
  for (const u of bad) {
    app.settings.update({ callbacks: { events: { 'order.new': { enabled: true, url: u } } } });
    const r = await ui('POST', '/callbacks/test', { event: 'order.new' });
    assert.equal(r.body.ok, false, u);
    assert.match(String(r.body.error), /private|refused|http or https|resolved/i, u);
  }
  target.close();
  app.settings.update({ callbacks: { events: { 'order.new': { enabled: false, url: '' } } } });
});

test('rate limiting is keyed by client address too: changing the Basic username does not reset the window', async () => {
  app.settings.update({ rateLimit: { enabled: true } });
  const statuses = [];
  for (let i = 0; i < 5; i++) {
    const r = await api('/handling_time/read', {}, { Authorization: `Basic ${Buffer.from(`same:pw`).toString('base64')}` });
    statuses.push(r.status);
  }
  assert.equal(statuses[3], 429);
  app.settings.update({ rateLimit: { enabled: false } });
});

test('UI login lockout uses the real client address and ignores X-Forwarded-For unless TRUST_PROXY=1', async () => {
  const login = (xff) => fetch(`${base}/__ui/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(xff ? { 'X-Forwarded-For': xff } : {}) }, body: JSON.stringify({ username: 'admin', password: 'wrong-password' }) });
  for (let i = 0; i < 5; i++) await login(`1.2.3.${i}`); // spoofed addresses must all count against the same (real) address
  const r = await login('9.9.9.9');
  assert.equal(r.status, 429);
});
