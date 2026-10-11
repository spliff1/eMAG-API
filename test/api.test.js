import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { createHttpServer } from '../src/core/http.js';
import { saveProductOffer } from '../src/modules/products/service.js';

let app;
let server;
let base;
const AUTH = `Basic ${Buffer.from('tester:pw').toString('base64')}`;

async function api(method, path, body, { auth = AUTH, raw = false } = {}) {
  const res = await fetch(`${base}/api-3${path}`, {
    method,
    headers: { ...(auth ? { Authorization: auth } : {}), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (raw) return res;
  return { status: res.status, body: await res.json(), headers: res.headers };
}
let cookie = '';
const ui = async (method, path, body) => {
  const res = await fetch(`${base}/__ui/api${path}`, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  return res.json();
};

before(async () => {
  app = createApp({ persist: false });
  app.settings.update({ autoApproveSeconds: 0, rateLimit: { enabled: false } });
  server = createHttpServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const reg = await fetch(`${base}/__ui/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'correct-horse' }) });
  cookie = reg.headers.get('set-cookie').split(';')[0];
});
after(() => server.close());

test('auth: missing credentials -> 401, any Basic credentials accepted', async () => {
  const noAuth = await api('POST', '/vat/read', {}, { auth: null });
  assert.equal(noAuth.status, 401);
  assert.equal(noAuth.body.isError, true);
  const r = await api('POST', '/vat/read', {});
  assert.equal(r.status, 200);
  assert.equal(r.body.isError, false);
  assert.ok(r.body.results.length >= 3);
});

test('both /api-3/x and the double-prefixed /api-3/api-3/x spec paths work', async () => {
  const a = await api('POST', '/invoice/categories', {});
  const b = await api('POST', '/api-3/invoice/categories', {});
  assert.equal(a.body.results.length, b.body.results.length);
  assert.equal(a.body.results[0].category, 'FC');
});

test('categories: list, by id with characteristics, language, count envelope', async () => {
  const list = await api('POST', '/category/read', {});
  assert.ok(list.body.results.length > 5);
  assert.equal(list.body.results[0].characteristics, undefined);
  const one = await api('POST', '/category/read?language=en', { id: 506 });
  assert.equal(one.body.results[0].name, 'Laptops');
  assert.ok(one.body.results[0].characteristics.some((c) => c.is_mandatory === 1));
  const ro = await api('POST', '/category/read?language=RO', { id: 506 });
  assert.equal(ro.body.results[0].name, 'Laptopuri');
  const count = await api('POST', '/category/count', {});
  assert.deepEqual(Object.keys(count.body.results), ['noOfItems', 'noOfPages', 'itemsPerPage']);
});

test('product_offer/save: schema errors reject the item, valid ones are saved', async () => {
  const bad = await api('POST', '/product_offer/save', { data: [{ id: 1, status: 1, sale_price: 0, vat_id: 1, handling_time: [{ warehouse_id: 1, value: 0 }], stock: [{ warehouse_id: 1, value: 5 }] }] });
  assert.equal(bad.body.isError, true);
  assert.match(bad.body.messages.join(), /sale_price/);
  const none = await api('POST', '/product_offer/read', { id: 1 });
  assert.equal(none.body.results.length, 0);

  const good = await api('POST', '/product_offer/save', {
    data: [{
      id: 2001, category_id: 41, name: 'Pantofi test', part_number: 'PN 2001;', brand: 'Nike', status: 1, sale_price: 100, min_sale_price: 80, max_sale_price: 150,
      vat_id: 1, stock: [{ warehouse_id: 1, value: 10 }], handling_time: [{ warehouse_id: 1, value: 1 }],
      characteristics: [{ id: 1009, value: '42' }], images: [{ url: 'https://x.example.com/a.jpg', display_type: 1 }],
    }],
  });
  assert.deepEqual(good.body, { isError: false, messages: [], results: [] });
  const read = await api('POST', '/product_offer/read', { id: 2001 });
  const o = read.body.results[0];
  assert.equal(o.part_number, 'PN2001', 'spaces/semicolons are stripped');
  assert.equal(o.validation_status[0].value, 1);
  assert.equal(o.offer_validation_status.value, 1);
  assert.equal(o.general_stock, 10);
});

test('product_offer/save: VAT record without a status field (as returned by real /vat/read) is usable', () => {
  app.col('vat_rates').insert({ vat_id: 5000, vat_rate: 0, is_default: null });
  const base = { category_id: 41, name: 'Pantofi VAT', brand: 'Nike', status: 1, sale_price: 100, min_sale_price: 80, max_sale_price: 150, stock: [{ warehouse_id: 1, value: 1 }], handling_time: [{ warehouse_id: 1, value: 1 }], characteristics: [{ id: 1009, value: '42' }], images: [{ url: 'https://x.example.com/a.jpg', display_type: 1 }] };
  assert.deepEqual(saveProductOffer(app, { ...base, id: 2101, part_number: 'PNVAT1', vat_id: 5000 }).errors, []);
  assert.match(saveProductOffer(app, { ...base, id: 2102, part_number: 'PNVAT2', vat_id: 4 }).errors.join(), /inactive/);
});

test('product_offer/save: documentation error => isError true but offer is still saved (status 8 + doc_errors)', async () => {
  const r = await api('POST', '/product_offer/save', {
    data: [{ id: 2002, category_id: 506, name: 'Laptop fara EAN', part_number: 'LAP2002', brand: 'HP', status: 1, sale_price: 3000, min_sale_price: 2000, max_sale_price: 4000, vat_id: 1, stock: [{ warehouse_id: 1, value: 3 }], handling_time: [{ warehouse_id: 1, value: 0 }] }],
  });
  assert.equal(r.body.isError, true);
  const read = await api('POST', '/product_offer/read', { id: 2002 });
  assert.equal(read.body.results[0].validation_status[0].value, 8);
  assert.ok(read.body.results[0].doc_errors.length >= 2);
});

test('product_offer/save: draft + price range => offer_validation_status', async () => {
  const draft = await api('POST', '/product_offer/save', { data: [{ id: 2003, status: 1, sale_price: 50, min_sale_price: 10, max_sale_price: 90, vat_id: 1, stock: [{ warehouse_id: 1, value: 1 }], handling_time: [{ warehouse_id: 1, value: 0 }] }] });
  assert.equal(draft.body.isError, false);
  assert.match(draft.body.messages.join(), /DRAFT/);
  const upd = await api('POST', '/offer/save', { data: [{ id: 2003, sale_price: 95 }] });
  assert.equal(upd.body.isError, false);
  const read = await api('POST', '/product_offer/read', { id: 2003 });
  assert.equal(read.body.results[0].offer_validation_status.value, 2, 'price above max_sale_price');
  const stock = await api('PATCH', '/offer_stock/2003', { data: { stock: [{ warehouse_id: 1, value: 77 }] } });
  assert.equal(stock.body.isError, false);
  assert.equal((await api('POST', '/product_offer/read', { id: 2003 })).body.results[0].general_stock, 77);
});

test('read filters are top-level; wrapping them in "data" is ignored (and flagged in the log)', async () => {
  const r = await api('POST', '/product_offer/read', { data: { id: 2001 } });
  assert.ok(r.body.results.length >= 3);
  const entry = app.log.list({ limit: 1 }).items[0];
  const full = app.log.get(entry.id);
  assert.match(full.notes.join(), /"data" ignored/);
});

test('catalogue: find_by_eans + attach by part_number_key', async () => {
  await ui('POST', '/generate/products/catalogue', { count: 3 });
  const cat = app.col('catalogue').all()[0];
  const found = await api('GET', `/documentation/find_by_eans?eans[]=${cat.ean[0]}&eans[]=0000000000000`);
  assert.equal(found.body.results.length, 1);
  assert.equal(found.body.results[0].part_number_key, cat.part_number_key);
  assert.equal(found.body.results[0].vendor_has_offer, false);
  const attach = await api('POST', '/product_offer/save', { data: [{ id: 2010, part_number_key: cat.part_number_key, status: 1, sale_price: 10, min_sale_price: 5, max_sale_price: 20, vat_id: 1, stock: [{ warehouse_id: 1, value: 5 }], handling_time: [{ warehouse_id: 1, value: 0 }] }] });
  assert.equal(attach.body.isError, false);
  const o = (await api('POST', '/product_offer/read', { id: 2010 })).body.results[0];
  assert.equal(o.validation_status[0].value, 9);
  assert.equal(o.part_number_key, cat.part_number_key);
  const again = await api('GET', `/documentation/find_by_eans?eans[]=${cat.ean[0]}`);
  assert.equal(again.body.results[0].vendor_has_offer, true);
});

test('documentation validation lifecycle can be driven from the UI row actions', async () => {
  await ui('POST', '/action/products/approve', { id: 2001 });
  const o = (await api('POST', '/product_offer/read', { id: 2001 })).body.results[0];
  assert.equal(o.validation_status[0].value, 9);
  assert.ok(o.part_number_key);
});

test('orders: generate, read filters, acknowledge, edit rules, cancel', async () => {
  await ui('POST', '/generate/orders/orders', { count: 12, status: '1', type: '3', payment: '1' });
  const read = await api('POST', '/order/read', { status: 1 });
  assert.ok(read.body.results.length >= 12);
  const order = read.body.results[0];
  assert.equal(order.type, 3);
  assert.ok(order.products[0].id && order.customer.billing_city);

  const count = await api('POST', '/order/count', { status: 1 });
  assert.ok(count.body.results.noOfItems >= 12);

  // createdBefore without createdAfter is rejected
  const badRange = await api('POST', '/order/read', { createdBefore: '2026-01-02 00:00:00' });
  assert.equal(badRange.body.isError, true);

  // cannot edit a New order
  const early = await api('POST', '/order/save', { data: [{ id: order.id, status: 3, type: 3, payment_mode_id: 1 }] });
  assert.equal(early.body.isError, true);

  const ack = await api('POST', `/order/acknowledge/${order.id}`);
  assert.equal(ack.body.isError, false);
  const ack2 = await api('POST', `/order/acknowledge/${order.id}`);
  assert.equal(ack2.body.isError, true);

  const prepared = await api('POST', '/order/save', { data: [{ id: order.id, status: 3, type: 3, payment_mode_id: 1 }] });
  assert.equal(prepared.body.isError, false, prepared.body.messages.join());
  assert.equal(prepared.body.results[0].status, 3);

  const cancelNoReason = await api('POST', '/order/save', { data: [{ id: order.id, status: 0, type: 3, payment_mode_id: 1 }] });
  assert.equal(cancelNoReason.body.isError, true);
  const cancel = await api('POST', '/order/save', { data: [{ id: order.id, status: 0, type: 3, payment_mode_id: 1, reason_cancellation: 1 }] });
  assert.equal(cancel.body.isError, false);
});

test('orders: remove product (omit), online-card restrictions, invoice attachment', async () => {
  await ui('POST', '/generate/orders/orders', { count: 30, status: '2', type: '3', payment: '1' });
  const multi = (await api('POST', '/order/read', { status: 2 })).body.results.find((o) => o.products.length > 1);
  assert.ok(multi, 'a multi-product COD order exists');
  const keep = multi.products[0];
  const r = await api('POST', '/order/save', { data: [{ id: multi.id, status: 2, type: 3, payment_mode_id: 1, products: [{ id: keep.id, quantity: keep.quantity, sale_price: keep.sale_price, status: 1 }] }] });
  assert.equal(r.body.isError, false, r.body.messages.join());
  assert.equal(r.body.results[0].products.filter((p) => p.status === 1).length, 1);

  const att = await api('POST', '/order/attachments/save', { data: [{ order_id: multi.id, order_type: 3, type: 1, name: 'Factura', url: 'https://erp.example.com/f.pdf' }] });
  assert.equal(att.body.isError, false, att.body.messages.join());
  const notPdf = await api('POST', '/order/attachments/save', { data: [{ order_id: multi.id, order_type: 3, type: 1, url: 'https://erp.example.com/f.docx' }] });
  assert.equal(notPdf.body.isError, true);
  const readAtt = await api('POST', '/order/attachments/read', { order_id: multi.id, order_type: 3 });
  assert.equal(readAtt.body.results.length, 1);

  await ui('POST', '/generate/orders/orders', { count: 5, status: '2', type: '3', payment: '3' });
  const card = (await api('POST', '/order/read', { status: 2, payment_mode_id: 3 })).body.results[0];
  const line = card.products[0];
  const bad = await api('POST', '/order/save', { data: [{ id: card.id, status: 2, type: 3, payment_mode_id: 3, products: [{ id: line.id, quantity: line.quantity, status: 0, sale_price: line.sale_price }] }] });
  assert.equal(bad.body.isError, true);
});

test('orders: finalized order accepts only storno', async () => {
  await ui('POST', '/generate/orders/orders', { count: 10, status: '4', type: '3', payment: '1' });
  const fin = (await api('POST', '/order/read', { status: 4 })).body.results.find((o) => o.products.some((p) => p.quantity > 1));
  const target = fin || (await api('POST', '/order/read', { status: 4 })).body.results[0];
  const line = target.products[0];
  const plain = await api('POST', '/order/save', { data: [{ id: target.id, status: 4, type: 3, payment_mode_id: 1 }] });
  assert.equal(plain.body.isError, true);
  const storno = await api('POST', '/order/save', { data: [{ id: target.id, status: 4, type: 3, payment_mode_id: 1, is_storno: true, products: [{ id: line.id, quantity: 0, sale_price: line.sale_price, status: 1 }] }] });
  assert.equal(storno.body.isError, false, storno.body.messages.join());
  assert.equal(storno.body.results[0].products[0].quantity, 0);
});

test('AWB: issue for an acknowledged order, read, PDF/ZPL, re-issuing allowed', async () => {
  await ui('POST', '/generate/orders/orders', { count: 3, status: '2', type: '3', payment: '1' });
  const order = (await api('POST', '/order/read', { status: 2 })).body.results.find((o) => !app.col('awbs').find((a) => a.order_id === o.id));
  const loc = (await api('POST', '/locality/read', { name: 'Cluj' })).body.results[0];
  assert.equal(loc.name, 'Cluj-Napoca');
  const payload = {
    order_id: order.id,
    sender: { name: 'Seller Test', contact: 'Depozit', phone1: '0721000000', locality_id: loc.emag_id, street: 'Strada Test 1' },
    receiver: { name: 'Client Test', contact: 'Client', phone1: '0722000000', locality_id: loc.emag_id, street: 'Strada Client 2' },
    is_oversize: 0, envelope_number: 0, parcel_number: 1, cod: 199.99, weight: 1.5, currency: 'RON',
  };
  const saved = await api('POST', '/awb/save', { data: [payload] });
  assert.equal(saved.body.isError, false, saved.body.messages.join());
  const { emag_id: emagId, reservation_id: resId } = saved.body.results[0];
  assert.ok(emagId && resId);
  const read = await api('POST', '/awb/read', { reservation_id: resId });
  assert.equal(read.body.results[0].awb[0].emag_id, emagId);
  assert.equal(read.body.results[0].status[0].code, 1);
  assert.equal(read.body.results[0].cash_on_delivery, 199.99);

  // like the real eMAG: any order status, and a second AWB for the same order is accepted (order is now Finalized)
  const dup = await api('POST', '/awb/save', { data: [payload] });
  assert.equal(dup.body.isError, false, dup.body.messages.join());
  assert.notEqual(dup.body.results[0].emag_id, emagId);

  const pdf = await api('GET', `/awb/read_pdf?emag_id=${emagId}&awb_format=A6`, undefined, { raw: true });
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  const zpl = await api('GET', `/awb/read_zpl?emag_id=${emagId}`);
  assert.match(Buffer.from(zpl.body.results[0], 'base64').toString(), /^\^XA/);

  await ui('POST', '/action/shipping/advance', { id: emagId });
  assert.equal((await api('POST', '/awb/read', { emag_id: emagId })).body.results[0].status[0].code, 2);

  const badWeight = await api('POST', '/awb/save', { data: [{ ...payload, order_id: 999999999 }] });
  assert.equal(badWeight.body.isError, true);
});

test('shipping reference data: courier accounts, addresses, packages (single default), localities by country', async () => {
  assert.ok((await api('POST', '/courier_accounts/read', {})).body.results.length >= 3);
  assert.ok((await api('POST', '/addresses/read', {})).body.results.some((a) => a.address_type_id === 2));
  const sav = await api('POST', '/awb/package/save', { data: [{ label: 'XL', length: 80, width: 60, height: 40, weight: 20, is_default: true }] });
  assert.equal(sav.body.isError, false);
  const pk = (await api('POST', '/awb/package/read', {})).body.results;
  assert.equal(pk.filter((p) => p.is_default).length, 1);
  assert.equal(pk.find((p) => p.is_default).label, 'XL');
  const bg = await api('POST', '/locality/read', { country_code: 'BG' });
  assert.ok(bg.body.results.every((l) => l.country_code === 'BG') && bg.body.results.length > 0);
  const cnt = await api('POST', '/locality/count', {});
  assert.ok(cnt.body.results.noOfItems > 40);
});

test('returns: generate, read, valid and invalid status transitions', async () => {
  await ui('POST', '/generate/returns/rmas', { count: 3, status: '2' });
  const list = await api('POST', '/rma/read', { request_status: 2 });
  assert.ok(list.body.results.length >= 3);
  const rma = list.body.results[0];
  const base = {
    emag_id: rma.emag_id, order_id: rma.order_id, type: rma.type, customer_name: rma.customer_name, customer_phone: rma.customer_phone, pickup_locality_id: 1, pickup_method: 1,
    return_type: 3, return_reason: 1, date: '2026-10-01 10:00:00', currency: 'RON',
  };
  const bad = await api('POST', '/rma/save', { data: [{ ...base, request_status: 7 }] });
  assert.equal(bad.body.isError, true, 'New -> Finalized is not allowed');
  const ok = await api('POST', '/rma/save', { data: [{ ...base, request_status: 3 }] });
  assert.equal(ok.body.isError, false, ok.body.messages.join());
  assert.equal((await api('POST', '/rma/read', { emag_id: rma.emag_id })).body.results[0].request_status, 3);
  const cnt = await api('POST', '/rma/count', {});
  assert.ok(cnt.body.results.noOfItems >= 3);
});

test('campaigns: read, eligible offers (cursor), proposals, product campaign key', async () => {
  await ui('POST', '/generate/products/offers', { count: 15, validation: 'approved', variety: false });
  await ui('POST', '/generate/campaigns/campaigns', { upcoming: 3 });
  const camps = (await api('POST', '/campaigns/read', { status: 1 })).body.results;
  assert.ok(camps.length >= 2);
  const upcoming = camps.find((c) => Date.parse(c.endPreparationDate) > Date.now());
  assert.ok(upcoming);
  const elig = await api('GET', `/campaigns/${upcoming.id}/eligible-offers?pageSize=2`);
  assert.equal(elig.body.isError, false);
  const first = elig.body.results[0];
  if (first) {
    const prop = await api('POST', '/campaign_proposals/save', {
      data: [{ id: first.ext_id, campaign_id: upcoming.id, sale_price: first.current_price * 0.9, voucher_discount: 15, max_qty_per_order: 2, stock: 10, date_intervals: [{ start_date: { date: '2026-11-01 00:00:00.000000' }, end_date: { date: '2026-11-10 00:00:00.000000' }, voucher_discount: 15, index: 1 }] }],
    });
    assert.equal(prop.body.isError, false, prop.body.messages.join());
    const badge = await api('GET', `/offers/${first.ext_id}/campaign_product_badge_timeline`);
    assert.equal(badge.body.results[0].id, upcoming.id);
  }
  await ui('POST', '/generate/campaigns/proposals', { count: 10 });
  const live = camps.find((c) => Date.parse(c.startDate) < Date.now() && Date.parse(c.endDate) > Date.now());
  const withCampaign = app.col('campaign_proposals').all().find((p) => p.campaign_id === live.id);
  if (withCampaign) {
    const o = (await api('POST', '/product_offer/read', { id: withCampaign.id })).body.results[0];
    assert.equal(o.campaign.id, live.id);
  }
  const sd = await api('GET', `/smart-deals-price-check?productId=${app.col('offers').all()[0].id}`);
  assert.equal(sd.body.isError, false);
  const cc = await api('POST', '/campaign_categories/read', { campaignId: upcoming.id });
  assert.equal(cc.body.isError, false);
});

test('campaigns: generated campaigns have eligible offers with and without eMAG support, visible in the UI view', async () => {
  const gen = await ui('POST', '/generate/campaigns/campaigns', { upcoming: 1, eligible: 4 });
  assert.match(gen.message, /with eMAG support, \d+ without/);
  const now = Date.now();
  const camp = app.col('campaigns').all().filter((c) => c.status === 1 && Date.parse(c.endDate) > now).at(-1);
  const all = [];
  for (let url = `/campaigns/${camp.id}/eligible-offers?pageSize=100`; url;) {
    const r = await api('GET', url);
    all.push(...r.body.results);
    url = r.body.next && new URL(r.body.next).pathname.replace('/api-3', '') + new URL(r.body.next).search;
  }
  assert.ok(all.length >= 4);
  const supported = all.filter((o) => o.emag_support.length);
  assert.ok(supported.length >= 1, 'some offers have eMAG support');
  assert.ok(all.some((o) => Array.isArray(o.emag_support) && o.emag_support.length === 0), 'some offers have none (emag_support: [])');
  for (const t of supported.flatMap((o) => o.emag_support)) assert.deepEqual(Object.keys(t), ['emag_support_pct', 'min_discount_pct', 'emag_support_value']);

  // top up an existing campaign
  const top = await ui('POST', '/generate/campaigns/eligible_offers', { campaign_id: String(camp.id), count: 2 });
  assert.equal(top.created, 2, top.message);
  assert.match(top.message, /1 with eMAG support, 1 without/);

  // computed, read-only view in the data browser
  const meta = await ui('GET', '/meta');
  const view = meta.modules.find((m) => m.id === 'campaigns').collections.find((c) => c.name === 'campaign_eligible_offers');
  assert.equal(view.virtual, true);
  const list = await ui('GET', `/collections/campaign_eligible_offers?q=${encodeURIComponent(`"campaign_id":${camp.id},`)}&limit=500`);
  assert.equal(list.total, all.length + 2);
  const row = list.items.find((r) => r.has_emag_support);
  const one = await ui('GET', `/collections/campaign_eligible_offers/${row.key}`);
  assert.equal(one.ext_id, row.ext_id);
  const put = await fetch(`${base}/__ui/api/collections/campaign_eligible_offers/${row.key}`, { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal(put.status, 405);

  // row action toggles the support seen by the API
  await ui('POST', '/action/campaigns/support_off', { id: row.key });
  const after = (await api('GET', `/campaigns/${camp.id}/eligible-offers?pageSize=100&lastId=${row.ext_id - 1}`)).body.results[0];
  assert.equal(after.ext_id, row.ext_id);
  assert.deepEqual(after.emag_support, []);
  await ui('POST', '/action/campaigns/support_on', { id: row.key });
  assert.ok((await ui('GET', `/collections/campaign_eligible_offers/${row.key}`)).emag_support.length > 0);
});

test('invoices: marketplace + customer invoices', async () => {
  await ui('POST', '/generate/invoices/invoices', { count: 5 });
  await ui('POST', '/generate/invoices/customer_invoices', { count: 4 });
  const inv = await api('POST', '/invoice/read', {});
  assert.equal(inv.body.results.total_results, 5);
  assert.ok(inv.body.results.invoices[0].lines.length);
  const ci = await api('POST', '/customer-invoice/read', { category: 'normal' });
  assert.ok(ci.body.results.total_results >= 4);
});

test('validation: >50 items, wrong shapes, invalid JSON', async () => {
  const many = await api('POST', '/product_offer/save', { data: Array.from({ length: 51 }, (_, i) => ({ id: i + 1 })) });
  assert.equal(many.body.isError, true);
  assert.match(many.body.messages[0], /at most 50/);
  const wrapped = await api('POST', '/product_offer/save', { id: 1 });
  assert.equal(wrapped.body.isError, true);
  const res = await fetch(`${base}/api-3/vat/read`, { method: 'POST', headers: { Authorization: AUTH, 'Content-Type': 'application/json' }, body: '{nope' });
  assert.equal(res.status, 400);
  const nf = await api('POST', '/nope/read', {});
  assert.equal(nf.status, 404);
});

test('rate limiting: >3 req/s on regular resources -> 429 with documented body', async () => {
  app.settings.update({ rateLimit: { enabled: true } });
  const statuses = [];
  let last;
  for (let i = 0; i < 5; i++) { last = await api('POST', '/handling_time/read', {}, { auth: `Basic ${Buffer.from('limited:pw').toString('base64')}` }); statuses.push(last.status); }
  assert.deepEqual(statuses.slice(0, 3), [200, 200, 200]);
  assert.equal(statuses[3], 429);
  assert.deepEqual(last.body, { message: 'API rate limit exceeded' });
  assert.ok(last.headers.get('x-ratelimit-limit-3second'));
  app.settings.update({ rateLimit: { enabled: false } });
});

test('fault injection + strict auth mode', async () => {
  app.settings.update({ faults: [{ id: 'f1', enabled: true, method: 'POST', path: '/vat/*', status: 503, remaining: 1 }] });
  assert.equal((await api('POST', '/vat/read', {})).status, 503);
  assert.equal((await api('POST', '/vat/read', {})).status, 200, 'rule consumed');
  app.settings.update({ faults: [], auth: { mode: 'strict', users: [{ username: 'seller@x.ro', password: 'pw' }] } });
  assert.equal((await api('POST', '/vat/read', {})).status, 401);
  const good = await api('POST', '/vat/read', {}, { auth: `Basic ${Buffer.from('seller@x.ro:pw').toString('base64')}` });
  assert.equal(good.status, 200);
  app.settings.update({ auth: { mode: 'any' } });
});

test('callbacks: events are POSTed to the configured URL and logged', async () => {
  const received = [];
  const target = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { received.push({ event: req.headers['x-dummy-emag-event'], body: JSON.parse(body) }); res.writeHead(200).end('ok'); });
  });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${target.address().port}/hook`;
  app.settings.update({ callbacks: { events: { 'order.new': { enabled: true, url } } } });
  await ui('POST', '/generate/orders/orders', { count: 2, status: '1', type: '3', notify: true });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(received.length, 2);
  assert.equal(received[0].event, 'order.new');
  assert.ok(received[0].body.customer && received[0].body.products.length);
  assert.equal(app.col('callback_log').size, 2);
  const t = await ui('POST', '/callbacks/test', { event: 'order.new' });
  assert.equal(t.ok, true);
  target.close();
});

test('request log captures calls with sections and bodies; UI meta/collections work', async () => {
  const meta = await ui('GET', '/meta');
  assert.ok(meta.modules.find((m) => m.id === 'orders').endpoints.some((e) => e.path === '/api-3/order/read'));
  assert.equal(meta.specVersion, '4.5.2');
  const log = await ui('GET', '/requests?section=Orders&limit=5');
  assert.ok(log.items.length > 0);
  const full = await ui('GET', `/requests/${log.items[0].id}`);
  assert.ok(full.resBody && full.reqHeaders.authorization === 'Basic ***');
  const col = await ui('GET', '/collections/orders?limit=3');
  assert.equal(col.items.length, 3);
  assert.ok(col.total >= 30);
  const snap = await (await fetch(`${base}/__ui/api/export`, { headers: { Cookie: cookie } })).json();
  assert.ok(snap.collections.orders.length >= 30);
});

// ------------------------------------------------------------------------- AWB finalizes the order + dummy AWB labels
import { code128Symbols, code128Widths } from '../src/modules/shipping/pdf.js';

const awbPayload = (orderId, locId) => ({
  order_id: orderId,
  sender: { name: 'Seller Test', contact: 'Depozit', phone1: '0721000000', locality_id: locId, street: 'Strada Test 1' },
  receiver: { name: 'Client Test', contact: 'Client', phone1: '0722000000', locality_id: locId, street: 'Strada Client 2' },
  is_oversize: 0, envelope_number: 0, parcel_number: 1, cod: 50, weight: 1, currency: 'RON',
});

test('issuing an AWB moves the order to Finalized (status 4); can be switched off in Settings', async () => {
  await ui('POST', '/generate/orders/orders', { count: 4, status: '2', type: '3', payment: '1' });
  const [a, b] = (await api('POST', '/order/read', { status: 2 })).body.results.filter((o) => !app.col('awbs').find((x) => x.order_id === o.id));
  const loc = (await api('POST', '/locality/read', { name: 'Cluj' })).body.results[0].emag_id;

  const r = await api('POST', '/awb/save', { data: [awbPayload(a.id, loc)] });
  assert.equal(r.body.isError, false, r.body.messages.join());
  assert.equal((await api('POST', '/order/read', { id: a.id })).body.results[0].status, 4);

  app.settings.update({ awbFinalizesOrder: false });
  const r2 = await api('POST', '/awb/save', { data: [awbPayload(b.id, loc)] });
  assert.equal(r2.body.isError, false);
  assert.equal((await api('POST', '/order/read', { id: b.id })).body.results[0].status, 2, 'unchanged with the setting off');
  app.settings.update({ awbFinalizesOrder: true });
});

test('dummy AWB on demand: any seller order, PDF (A4/A5/A6) + ZPL labels via the UI, once per order', async () => {
  await ui('POST', '/generate/orders/orders', { count: 3, status: '1', type: '3', payment: '1' });
  const order = (await api('POST', '/order/read', { status: 1 })).body.results[0];
  const awbsBefore = app.col('awbs').size;

  // the UI row action issues the AWB and finalizes the (still New) order
  const act = await ui('POST', '/action/orders/dummy_awb', { id: order.id });
  assert.match(act.message, /AWB issued: [A-Z]{3}\d{10}/);
  assert.equal(app.col('awbs').size, awbsBefore + 1);
  assert.equal(app.col('orders').get(order.id).status, 4);
  const awb = app.col('awbs').find((x) => x.order_id === order.id);
  assert.equal(awb.cash_on_delivery > 0, true, 'COD order -> amount to collect');

  const get = (p) => fetch(`${base}/__ui/api${p}`, { headers: { Cookie: cookie } });
  const pdf = await get(`/awb/${awb.emag_id}/label?format=A6`);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  const bytes = Buffer.from(await pdf.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.ok(bytes.includes(`(${awb.awb[0].awb_number}) Tj`), 'AWB number printed on the label');
  assert.ok(bytes.toString('latin1').includes('MediaBox [0 0 298 420]'));
  assert.ok(Buffer.from(await (await get(`/awb/${awb.emag_id}/label?format=A4`)).arrayBuffer()).toString('latin1').includes('MediaBox [0 0 595 842]'));
  assert.ok(Buffer.from(await (await get(`/awb/${awb.emag_id}/label?format=A5`)).arrayBuffer()).toString('latin1').includes('MediaBox [0 0 420 595]'));
  const zpl = await (await get(`/awb/${awb.emag_id}/label?format=ZPL`)).text();
  assert.match(zpl, /^\^XA/);
  assert.ok(zpl.includes(awb.awb[0].awb_number));
  assert.equal((await get(`/awb/${awb.emag_id}/label?format=XL`)).status, 400);

  // order-level link: generates on demand when missing, idempotent afterwards
  const fresh = (await api('POST', '/order/read', { status: 1 })).body.results[0];
  const before = app.col('awbs').size;
  const p1 = await get(`/orders/${fresh.id}/awb-label?format=A6`);
  assert.equal(p1.status, 200);
  assert.equal(app.col('awbs').size, before + 1);
  assert.equal(app.col('orders').get(fresh.id).status, 4);
  await get(`/orders/${fresh.id}/awb-label?format=A4`);
  assert.equal(app.col('awbs').size, before + 1, 'second download reuses the same AWB');

  // the official endpoints return the same nicer label
  const official = await api('GET', `/awb/read_pdf?emag_id=${awb.emag_id}&awb_format=A6`, undefined, { raw: true });
  assert.equal(Buffer.from(await official.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');

  // labels are behind the UI login
  const anon = await fetch(`${base}/__ui/api/awb/${awb.emag_id}/label?format=A6`);
  assert.equal(anon.status, 401);
  // eMAG-fulfilled orders cannot get a seller AWB
  await ui('POST', '/generate/orders/orders', { count: 2, status: '4', type: '2', payment: '3' });
  const fbe = app.col('orders').all().find((o) => o.type === 2);
  assert.equal((await get(`/orders/${fbe.id}/awb-label`)).status, 400);
});

test('Code 128 barcode: every symbol is 11 modules wide, checksum is right and the pattern round-trips', () => {
  assert.deepEqual(code128Symbols('A'), [104, 33, 34, 106], 'start B, "A", checksum (104 + 33) % 103, stop');
  const widths = code128Widths('FAN1234567890');
  const symbols = code128Symbols('FAN1234567890');
  assert.equal(widths.length, (symbols.length - 1) * 6 + 7);
  assert.equal(widths.reduce((a, b) => a + b, 0), (symbols.length - 1) * 11 + 13);
  // decode back to text using the same table the encoder uses
  const syms = code128Symbols('FAN1234567890').slice(1, -2);
  assert.equal(syms.map((v) => String.fromCharCode(v + 32)).join(''), 'FAN1234567890');
});

test('AWB: no status / duplicate restrictions (finalized order that already has an AWB still accepts a new one)', async () => {
  await ui('POST', '/generate/orders/orders', { count: 1, status: '4', type: '3', payment: '1' });
  const order = app.col('orders').all().filter((o) => o.type === 3 && o.status === 4).pop();
  const loc = (await api('POST', '/locality/read', { name: 'Cluj' })).body.results[0];
  const payload = awbPayload(order.id, loc.emag_id);
  const first = await api('POST', '/awb/save', { data: [payload] });
  assert.equal(first.body.isError, false, first.body.messages.join());
  const second = await api('POST', '/awb/save', { data: [payload] });
  assert.equal(second.body.isError, false, second.body.messages.join());
  assert.notEqual(second.body.results[0].emag_id, first.body.results[0].emag_id);
  assert.equal(app.col('orders').get(order.id).status, 4);
});
