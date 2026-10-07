import { rnd, fmtDateTime, daysAgo, parseDateTime, round } from '../../core/util.js';
import * as fake from '../../core/faker.js';

export const PAYMENT_MODES = { 1: 'Cash on delivery', 2: 'Bank transfer', 3: 'Online card' };

/** Allowed status transitions through order/save (current -> [allowed new statuses]). */
const TRANSITIONS = { 1: [0], 2: [2, 3, 0], 3: [3, 2, 4, 0], 4: [4, 5], 0: [0, 2], 5: [5] };
const CUSTOMER_LOCKED = ['id', 'email'];

export const nextLineId = (app) => {
  app.store.seq.order_lines = (app.store.seq.order_lines ?? 1_000_000) + 1;
  return app.store.seq.order_lines;
};
const nextAttachmentId = (app) => {
  app.store.seq.order_attachments = (app.store.seq.order_attachments ?? 0) + 1;
  return app.store.seq.order_attachments;
};

export function orderTotal(o) {
  const lines = o.products.filter((p) => p.status === 1).reduce((s, p) => s + p.quantity * p.sale_price * (1 + Number(p.vat)), 0);
  return round(lines + (o.shipping_tax || 0), 2);
}

function randomLocality(app) {
  const all = app.store.collections.get('localities')?.all().filter((l) => l.country_code === 'RO') || [];
  if (all.length) return rnd.pick(all);
  return { emag_id: 1, name: 'Bucuresti', region2: 'Bucuresti', zipcode: '010011' };
}

export function randomCustomer(app) {
  const { name, gender } = fake.person();
  const loc = randomLocality(app);
  const shipLoc = rnd.chance(0.8) ? loc : randomLocality(app);
  const legal = rnd.chance(0.15);
  const phoneNo = fake.phone();
  const street = fake.street();
  const c = {
    id: rnd.int(1_000_000, 90_000_000),
    name,
    email: fake.maskedEmail(),
    company: legal ? fake.company() : '',
    gender,
    code: legal ? fake.cui() : '',
    registration_number: legal ? fake.regNumber() : '',
    bank: legal ? fake.bank() : '',
    iban: legal ? fake.iban() : '',
    fax: '',
    legal_entity: legal ? 1 : 0,
    is_vat_payer: legal ? 1 : 0,
    phone_1: phoneNo,
    phone_2: '',
    phone_3: '',
    billing_name: legal ? fake.company() : name,
    billing_phone: phoneNo,
    billing_country: 'Romania',
    billing_suburb: loc.region2,
    billing_city: loc.name,
    billing_locality_id: String(loc.emag_id),
    billing_street: street,
    billing_postal_code: loc.zipcode,
    shipping_country: 'Romania',
    shipping_suburb: shipLoc.region2,
    shipping_city: shipLoc.name,
    shipping_locality_id: String(shipLoc.emag_id),
    shipping_street: shipLoc === loc ? street : fake.street(),
    shipping_postal_code: shipLoc.zipcode,
    shipping_contact: name,
    shipping_phone: phoneNo,
  };
  return c;
}

export function ensureOffers(app, minimum = 5) {
  const offers = app.col('offers');
  const usable = offers.filter((o) => o.status === 1);
  if (usable.length >= minimum) return usable;
  const gen = app.module('products').generators.find((g) => g.id === 'offers');
  gen.run(app, { count: Math.max(minimum, 10), validation: 'approved', variety: false });
  return offers.filter((o) => o.status === 1);
}

export function buildOrder(app, { status = 1, type = 3, payment, ageDays } = {}) {
  const offers = ensureOffers(app);
  const currency = app.currency();
  const id = app.store.nextId('orders');
  const paymentModeId = payment || (type === 2 ? 3 : rnd.weighted([[1, 50], [3, 40], [2, 10]]));
  const created = status === 1 ? new Date(Date.now() - rnd.int(1, 36) * 3600_000) : daysAgo(ageDays ?? rnd.int(1, 20), 1);
  const modified = status === 1 ? created : new Date(created.getTime() + rnd.int(1, 48) * 3600_000);
  const stamp = fmtDateTime(created);

  const products = rnd.sample(offers, rnd.int(1, 3)).map((offer) => ({
    id: nextLineId(app),
    product_id: offer.id,
    mkt_id: offer.id,
    name: offer.name || `Offer ${offer.id}`,
    status: 1,
    ext_part_number: offer.part_number || String(offer.id),
    part_number: offer.part_number_key || offer.part_number || String(offer.id),
    part_number_key: offer.part_number_key || null,
    currency,
    vat: app.col('vat_rates').get(offer.vat_id)?.vat_rate ?? '0.2100',
    retained_amount: 0,
    quantity: rnd.weighted([[1, 75], [2, 18], [3, 7]]),
    sale_price: offer.sale_price,
    original_price: offer.recommended_price ?? offer.sale_price,
    created: stamp,
    modified: fmtDateTime(modified),
    details: '',
    recycle_warranties: [],
    product_voucher_split: [],
    serial_numbers: '',
  }));

  const vouchers = [];
  if (rnd.chance(0.2)) {
    const vid = rnd.int(100000, 999999);
    const value = round(-rnd.pick([5, 10, 20]) / 1.21, 2);
    const vat = round(value * 0.21, 2);
    products[0].product_voucher_split.push({ voucher_id: vid, value, vat_value: vat, vat: 0.21, offered_by: 'eMAG', voucher_name: 'Voucher promotional' });
    vouchers.push({
      voucher_id: vid, modified: stamp, created: stamp, status: 1, sale_price_vat: vat, sale_price: value,
      voucher_name: 'Voucher promotional', vat: 0.21, issue_date: stamp.slice(0, 10),
    });
  }

  const pickup = type === 3 && rnd.chance(0.15);
  const order = {
    id,
    status,
    is_complete: status === 1 && rnd.chance(0.03) ? 0 : 1,
    type,
    payment_mode: PAYMENT_MODES[paymentModeId],
    payment_mode_id: paymentModeId,
    detailed_payment_method: paymentModeId === 3 ? rnd.pick(['card', 'card', 'eCREDIT']) : (paymentModeId === 1 ? 'cash' : 'transfer'),
    delivery_mode: pickup ? 'pickup' : 'courier',
    observation: rnd.chance(0.1) ? 'Va rog sunati inainte de livrare.' : '',
    details: pickup
      ? { locker_id: `EB${rnd.digits(5)}`, locker_name: `Easybox ${fake.street().split(' nr.')[0]}`, locker_delivery_eligible: 1 }
      : { locker_id: '', locker_name: '', locker_delivery_eligible: rnd.pick([0, 1]) },
    date: stamp,
    payment_status: paymentModeId === 1 ? (status === 4 ? 1 : 0) : 1,
    cashed_co: 0,
    cashed_cod: 0,
    shipping_tax: pickup ? rnd.pick([0, 6.99]) : rnd.pick([0, 0, 9.99, 14.99]),
    shipping_tax_voucher_split: [],
    customer: randomCustomer(app),
    products,
    vouchers,
    attachments: [],
    enforced_vendor_courier_accounts: null,
    modified: fmtDateTime(modified),
  };
  if (paymentModeId === 3) order.cashed_co = Math.round(orderTotal(order));
  if (status === 0) order.reason_cancellation = rnd.pick([2, 3, 23, 24, 34]);
  if (status === 4 && type === 3 && rnd.chance(0.85)) {
    order.attachments.push({ id: nextAttachmentId(app), name: `Factura ${id}`, url: `https://erp.example.com/invoices/FACT-${id}.pdf`, type: 1, force_download: 0 });
  }
  return order;
}

// ------------------------------------------------------------------ read filters
function parseRange(f, a, b, { requireAfterForBefore, requireBeforeForAfter }) {
  const errors = [];
  const after = f[a] !== undefined ? parseDateTime(f[a]) : null;
  const before = f[b] !== undefined ? parseDateTime(f[b]) : null;
  if (f[a] !== undefined && !after) errors.push(`${a}: invalid date, expected YYYY-mm-dd HH:ii:ss`);
  if (f[b] !== undefined && !before) errors.push(`${b}: invalid date, expected YYYY-mm-dd HH:ii:ss`);
  if (requireAfterForBefore && f[b] !== undefined && f[a] === undefined) errors.push(`${b}: can only be set if ${a} is present`);
  if (requireBeforeForAfter && f[a] !== undefined && f[b] === undefined) errors.push(`${a}: can only be set if ${b} is present`);
  if (after && before && before - after > 32 * 864e5) errors.push(`${a}/${b}: maximum 1 month difference`);
  return { after, before, errors };
}

export function filterOrders(orders, f, { count, strict }) {
  const created = parseRange(f, 'createdAfter', 'createdBefore', { requireAfterForBefore: true, requireBeforeForAfter: count });
  const modified = parseRange(f, 'modifiedAfter', 'modifiedBefore', { requireAfterForBefore: true, requireBeforeForAfter: count });
  const errors = strict ? [...created.errors, ...modified.errors] : [];
  const list = (v) => (v === undefined ? undefined : [].concat(v));
  const statuses = list(f.status);
  const payments = list(f.payment_mode_id);
  const type = f.type ?? 3;
  const out = orders.filter((o) => {
    if (o.type !== type) return false;
    if (f.id !== undefined && o.id !== f.id) return false;
    if (statuses && !statuses.includes(o.status)) return false;
    if (payments && !payments.includes(o.payment_mode_id)) return false;
    if (f.is_complete !== undefined && o.is_complete !== f.is_complete) return false;
    if (created.after || created.before) {
      const cd = parseDateTime(o.date);
      if (created.after && cd < created.after) return false;
      if (created.before && cd > created.before) return false;
    }
    if (modified.after || modified.before) {
      const md = parseDateTime(o.modified);
      if (modified.after && md < modified.after) return false;
      if (modified.before && md > modified.before) return false;
    }
    return true;
  });
  return { errors, list: out.sort((a, b) => b.id - a.id) };
}

// ---------------------------------------------------------------------- save
export function saveOrder(app, v, { strict = true } = {}) {
  const orders = app.col('orders');
  const tag = `[order ${v.id}]`;
  const o = orders.get(v.id);
  const errors = [];
  const warnings = [];
  if (!o) return { errors: [`${tag} order not found`], warnings };

  if (v.type !== o.type) errors.push(`${tag} type: ${v.type} does not match the order type (${o.type})`);
  if (errors.length) return { errors, warnings };

  const mergeAttachments = () => {
    for (const a of v.attachments || []) {
      if (o.attachments.some((x) => x.url === a.url && x.type === (a.type ?? 1))) continue;
      o.attachments.push({ id: nextAttachmentId(app), name: a.name || `Attachment ${o.id}`, url: a.url, type: a.type ?? 1, force_download: a.force_download ?? 0 });
    }
  };

  if (o.type === 2) {
    if (v.status !== o.status) return { errors: [`${tag} orders fulfilled by eMAG (type 2) cannot be edited, only attachments can be uploaded`], warnings };
    mergeAttachments();
    o.modified = fmtDateTime();
    orders.touch();
    return { errors: [], warnings, doc: o };
  }

  const from = o.status;
  const to = v.status;
  const onlineCard = o.payment_mode_id === 3;

  if (strict) {
    if (from === 1 && to !== 0) errors.push(`${tag} the order is New: acknowledge it first (POST /order/acknowledge/${o.id}); only cancelling (status 0) is possible before that`);
    else if (!TRANSITIONS[from].includes(to)) errors.push(`${tag} status: transition ${from} -> ${to} is not allowed`);
    if (to === 0 && v.reason_cancellation === undefined) errors.push(`${tag} reason_cancellation: required when cancelling an order`);
    if (from === 0 && to === 2 && Date.now() - parseDateTime(o.modified) > 48 * 3600_000) errors.push(`${tag} a cancelled order can no longer be reactivated after 48 hours`);
  }
  if (errors.length) return { errors, warnings };

  // ---- finalized order: only storno
  if (from === 4) {
    if (to === 5) {
      o.status = 5;
    } else {
      if (v.is_storno !== true) return { errors: [`${tag} a finalized order cannot be modified: send is_storno=true for a partial storno or status 5 for a full one`], warnings };
      let reduced = 0;
      for (const p of v.products || []) {
        const line = o.products.find((l) => l.id === p.id);
        if (!line) { errors.push(`${tag} products: line ${p.id} not found`); continue; }
        if (p.quantity < 0) errors.push(`${tag} products[${p.id}].quantity: negative quantities are rejected`);
        else if (p.quantity > line.quantity) errors.push(`${tag} products[${p.id}].quantity: cannot be increased on a storno`);
        else if (p.quantity < line.quantity) { reduced += 1; line.quantity = p.quantity; line.modified = fmtDateTime(); }
      }
      if (!errors.length && !reduced) errors.push(`${tag} partial storno requires at least one product quantity to be reduced`);
      if (errors.length) { return { errors, warnings }; }
    }
    mergeAttachments();
    o.modified = fmtDateTime();
    orders.touch();
    return { errors: [], warnings, doc: o };
  }

  // ---- order in progress / prepared / cancelled / returned
  if (v.products && [2, 3].includes(from) && to !== 0) {
    const lines = new Map(o.products.map((p) => [p.id, p]));
    const seen = new Set();
    const pending = [];
    for (const p of v.products) {
      const line = lines.get(p.id);
      if (line) {
        seen.add(line.id);
        if (p.status === 0) {
          if (line.status === 1) {
            if (onlineCard) errors.push(`${tag} products[${p.id}]: products cannot be removed from Online Card orders`);
            else pending.push(() => { line.status = 0; line.modified = fmtDateTime(); });
          }
        } else if (p.quantity < line.quantity) {
          if (onlineCard) errors.push(`${tag} products[${p.id}].quantity: quantities cannot be reduced on Online Card orders`);
          else pending.push(() => { line.quantity = p.quantity; line.modified = fmtDateTime(); });
        } else if (p.quantity > line.quantity) {
          pending.push(() => { line.quantity = p.quantity; line.modified = fmtDateTime(); });
        }
        if (p.sale_price !== undefined && round(p.sale_price, 4) !== round(line.sale_price, 4)) warnings.push(`${tag} products[${p.id}].sale_price: updating product prices is not available, value ignored`);
      } else {
        // not an existing order line: "add product" (id = seller product id)
        if (!p.name) { errors.push(`${tag} products[${p.id}]: to add a product send id, name, status, sale_price and currency`); continue; }
        pending.push(() => {
          const offer = app.col('offers').get(p.id);
          o.products.push({
            id: nextLineId(app), product_id: p.id, mkt_id: p.id, name: p.name, status: p.status, ext_part_number: offer?.part_number || String(p.id),
            part_number: offer?.part_number_key || offer?.part_number || String(p.id), part_number_key: offer?.part_number_key || null,
            currency: p.currency || app.currency(), vat: app.col('vat_rates').get(offer?.vat_id)?.vat_rate ?? '0.2100', retained_amount: 0,
            quantity: p.quantity, sale_price: p.sale_price, original_price: p.sale_price, created: fmtDateTime(), modified: fmtDateTime(),
            details: p.details || '', recycle_warranties: [], product_voucher_split: [], serial_numbers: '',
          });
        });
      }
    }
    for (const line of o.products) {
      if (line.status === 1 && !seen.has(line.id)) {
        if (onlineCard) errors.push(`${tag} products[${line.id}]: omitting a product removes it, which is not allowed on Online Card orders`);
        else pending.push(() => { line.status = 0; line.modified = fmtDateTime(); });
      }
    }
    if (errors.length) return { errors, warnings };
    for (const apply of pending) apply();
    if (strict && !o.products.some((p) => p.status === 1)) {
      // Everything removed: undo is not needed for a dummy, but surface it.
      warnings.push(`${tag} the order has no active products left; consider cancelling it (status 0)`);
    }
  }

  if (v.customer) for (const [k, val] of Object.entries(v.customer)) if (!CUSTOMER_LOCKED.includes(k)) o.customer[k] = val;
  if (v.is_complete !== undefined) o.is_complete = v.is_complete;
  if (to === 0) o.reason_cancellation = v.reason_cancellation;
  o.status = to;
  mergeAttachments();
  o.modified = fmtDateTime();
  orders.touch();
  return { errors: [], warnings, doc: o };
}

export function attachInvoice(app, order) {
  if (order.attachments.some((a) => a.type === 1)) return;
  order.attachments.push({ id: nextAttachmentId(app), name: `Factura ${order.id}`, url: `https://erp.example.com/invoices/FACT-${order.id}.pdf`, type: 1, force_download: 0 });
}
export { nextAttachmentId };
