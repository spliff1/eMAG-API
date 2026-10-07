import { rnd, fmtDate, fmtDateTime, addDays } from '../../core/util.js';
import * as fake from '../../core/faker.js';
import { makeLabelPdf, makeZpl } from './pdf.js';

/** Dummy courier tracking states (the real code list is not part of the public spec). */
export const AWB_STATUSES = [
  { code: 1, name: 'Created', description: 'AWB generated, waiting for courier pickup' },
  { code: 2, name: 'Picked up', description: 'Parcel picked up from the sender' },
  { code: 3, name: 'In transit', description: 'Parcel is on its way to the destination hub' },
  { code: 4, name: 'Out for delivery', description: 'Courier is delivering the parcel' },
  { code: 5, name: 'Delivered', description: 'Parcel delivered to the receiver' },
  { code: 6, name: 'Returned to sender', description: 'Delivery failed, parcel returned' },
  { code: 7, name: 'Cancelled', description: 'AWB cancelled' },
];
const PREFIX = { 'Fan Courier': 'FAN', Sameday: 'SMD', Cargus: 'CRG', DPD: 'DPD', GLS: 'GLS' };

export const statusOf = (code) => AWB_STATUSES.find((s) => s.code === code) || AWB_STATUSES[0];
const nextReservation = (app) => (app.store.seq.awb_reservations = (app.store.seq.awb_reservations ?? 9_000_000) + 1);

/** Default courier = first active account supporting orders (2/3) or returns (1/3). */
export function pickCourier(app, { rma = false, id } = {}) {
  const accounts = app.col('courier_accounts').all();
  const ok = (a) => a.status === 1 && (rma ? [1, 3].includes(a.courier_account_type) : [2, 3].includes(a.courier_account_type));
  if (id !== undefined) return accounts.find((a) => a.account_id === id);
  return accounts.find(ok);
}

export function presentAwb(doc) {
  const out = {};
  for (const [k, v] of Object.entries(doc)) if (!k.startsWith('_')) out[k] = v;
  return out;
}

/** v = schema-validated AWBSave item. Returns { errors, warnings, doc }. */
export function issueAwb(app, v, { strict = true } = {}) {
  const tag = v.rma_id !== undefined ? `[order ${v.order_id} / rma ${v.rma_id}]` : `[order ${v.order_id}]`;
  const errors = [];
  const warnings = [];
  const isRma = v.rma_id !== undefined;
  const order = app.col('orders').get(v.order_id);
  const rma = isRma ? app.col('rmas').get(v.rma_id) : null;
  const localities = app.col('localities');

  if (!order) errors.push(`${tag} order_id: order not found`);
  if (isRma && !rma) errors.push(`${tag} rma_id: return request not found`);
  if (isRma && rma && rma.order_id !== v.order_id) errors.push(`${tag} rma_id: return request ${v.rma_id} does not belong to order ${v.order_id}`);
  if (v.envelope_number === 0 && v.parcel_number === 0) errors.push(`${tag} envelope_number / parcel_number: they cannot both be 0`);
  if (v.packages?.length && v.weight !== undefined) {
    const sum = v.packages.reduce((s, p) => s + p.weight, 0);
    if (Math.abs(sum - v.weight) > 0.01) errors.push(`${tag} weight: must equal the sum of the package weights (${sum})`);
  }
  for (const role of ['sender', 'receiver']) {
    if (!localities.has(v[role].locality_id)) errors.push(`${tag} ${role}.locality_id: ${v[role].locality_id} is not a valid locality (see /locality/read)`);
  }

  if (order && strict) {
    if (!isRma) {
      if (order.type !== 3) errors.push(`${tag} AWBs can only be issued for orders fulfilled by the seller (type 3)`);
      if (Array.isArray(order.enforced_vendor_courier_accounts)) {
        if (!order.enforced_vendor_courier_accounts.length) errors.push(`${tag} AWBs cannot be issued from the Marketplace for this order`);
        else if (v.courier_account_id !== undefined && !order.enforced_vendor_courier_accounts.includes(v.courier_account_id)) errors.push(`${tag} courier_account_id: this order requires one of ${order.enforced_vendor_courier_accounts.join(', ')}`);
      }
    } else {
      if (!v.date) errors.push(`${tag} date: required for AWBs belonging to returns`);
      else if (v.date < fmtDate(addDays(new Date(), 1))) errors.push(`${tag} date: must be at least the next day`);
      if (v.pickup_and_return === 1) errors.push(`${tag} pickup_and_return: must be 0 for an AWB belonging to a return`);
    }
  }

  const courier = pickCourier(app, { rma: isRma, id: v.courier_account_id });
  if (v.courier_account_id !== undefined) {
    if (!courier) errors.push(`${tag} courier_account_id: ${v.courier_account_id} not found (see /courier_accounts/read)`);
    else if (courier.status !== 1) errors.push(`${tag} courier_account_id: account ${courier.account_id} is inactive`);
    else if (isRma ? ![1, 3].includes(courier.courier_account_type) : ![2, 3].includes(courier.courier_account_type)) errors.push(`${tag} courier_account_id: account ${courier.account_id} cannot be used for ${isRma ? 'returns' : 'orders'}`);
  } else if (!courier) errors.push(`${tag} no active courier account available`);

  if (errors.length) return { errors, warnings };

  const currency = v.currency || app.currency();
  if (!v.currency) warnings.push(`${tag} currency not sent: the platform default (${currency}) was used`);
  if (order?.delivery_mode === 'pickup' && !v.locker_id) warnings.push(`${tag} locker_id: the order was placed for locker delivery but no locker_id was sent`);

  const emagId = app.store.nextId('awbs');
  const number = `${PREFIX[courier.courier_name] || 'AWB'}${rnd.digits(10)}`;
  const weight = v.weight ?? v.packages?.reduce((s, p) => s + p.weight, 0) ?? 1;
  const doc = {
    emag_id: emagId,
    reservation_id: nextReservation(app),
    order_id: v.order_id,
    ...(isRma ? { rma_id: v.rma_id } : {}),
    type: order.type,
    weight,
    awb_type: isRma ? 2 : 1,
    awb: [{ emag_id: emagId, awb_number: number, awb_barcode: number }],
    status: [statusOf(1)],
    courier: [{ courier_account_id: courier.account_id, courier_name: courier.courier_name }],
    currency,
    cash_on_delivery: v.cod,
    created: fmtDateTime(),
    _request: v,
  };
  app.col('awbs').insert(doc);
  if (!isRma && [1, 2, 3].includes(order.status) && app.settings.get().awbFinalizesOrder !== false) {
    order.status = 4; // issuing the AWB completes the seller's part of the order (cancelled/returned/finalized orders keep their status)
    order.modified = fmtDateTime();
    app.col('orders').touch();
  }
  return { errors: [], warnings, doc };
}

/** A believable AWB payload for an order (sender = default pickup address, receiver = the customer's delivery data). */
export function buildDummyAwbPayload(app, order) {
  const pickup = app.col('addresses').find((a) => a.address_type_id === 2 && a.is_default) || app.col('addresses').all()[0];
  const lines = order.products.filter((x) => x.status === 1);
  const cod = order.payment_mode_id === 1 ? Math.round((lines.reduce((s, x) => s + x.quantity * x.sale_price * (1 + Number(x.vat)), 0) + (order.shipping_tax || 0)) * 100) / 100 : 0;
  return {
    order_id: order.id,
    sender: { name: 'Seller Dummy S.R.L.', contact: 'Depozit', phone1: fake.phone(), locality_id: pickup?.locality_id ?? 1, street: pickup?.address || 'Strada Depozitului nr. 10' },
    receiver: {
      name: order.customer.shipping_contact || order.customer.name, contact: order.customer.name, phone1: order.customer.shipping_phone || fake.phone(),
      locality_id: Number(order.customer.shipping_locality_id) || 1, street: order.customer.shipping_street || 'Strada Garii nr. 1',
      ...(order.customer.shipping_postal_code ? { zipcode: order.customer.shipping_postal_code } : {}),
    },
    is_oversize: 0, envelope_number: 0, parcel_number: 1, cod, weight: Math.round(lines.reduce((s, x) => s + x.quantity * rnd.float(0.2, 2, 1), 0) * 10) / 10 || 1,
    currency: app.currency(), ...(order.details?.locker_id ? { locker_id: order.details.locker_id } : {}),
  };
}

/**
 * Issues a dummy AWB for an order on demand (no payload needed) — or returns the one it already has.
 * Works on any seller-fulfilled order status; the order ends up Finalized (unless disabled in Settings).
 */
export function generateDummyAwb(app, order) {
  if (order.type !== 3) return { error: 'AWBs can only be issued for orders fulfilled by the seller (type 3)' };
  const existing = app.col('awbs').find((a) => a.order_id === order.id && !a.rma_id && a.status[0].code !== 7);
  if (existing) return { doc: existing, existing: true };
  const r = issueAwb(app, buildDummyAwbPayload(app, order), { strict: false });
  return r.errors.length ? { error: r.errors.join('; ') } : { doc: r.doc, existing: false };
}

// -------------------------------------------------------------------------------- labels
export const LABEL_FORMATS = ['A4', 'A5', 'A6', 'ZPL'];

/** Everything printed on the label, resolved from the AWB request, the order and the localities. */
export function labelData(app, awb) {
  const order = app.col('orders').get(awb.order_id);
  const req = awb._request || {};
  const party = (p) => {
    if (!p) return null;
    const l = app.col('localities').get(p.locality_id);
    return { name: p.name, contact: p.contact, phone: p.phone1, street: p.street, city: l?.name, county: l?.region2, zip: p.zipcode || l?.zipcode };
  };
  const c = order?.customer;
  const receiver = party(req.receiver) || (c && { name: c.shipping_contact || c.name, contact: c.name, phone: c.shipping_phone, street: c.shipping_street, city: c.shipping_city, county: c.shipping_suburb, zip: c.shipping_postal_code });
  return {
    courier: awb.courier[0].courier_name,
    awbNumber: awb.awb[0].awb_number,
    orderId: awb.order_id,
    rmaId: awb.rma_id,
    receiver,
    sender: party(req.sender),
    cod: awb.cash_on_delivery,
    currency: awb.currency,
    weight: awb.weight,
    parcels: req.parcel_number,
    envelopes: req.envelope_number,
    date: awb.created,
    service: order?.delivery_mode === 'pickup' ? 'LOCKER' : 'STANDARD',
    observation: req.observation,
  };
}

/** -> { contentType, filename, body } for A4 / A5 / A6 (PDF) or ZPL. */
export function renderLabel(app, awb, format = 'A6') {
  const label = labelData(app, awb);
  const name = awb.awb[0].awb_number;
  if (format === 'ZPL') return { contentType: 'text/plain; charset=utf-8', filename: `${name}.zpl`, body: Buffer.from(makeZpl(label)) };
  return { contentType: 'application/pdf', filename: `${name}-${format}.pdf`, body: makeLabelPdf(label, format) };
}

export function advanceAwb(app, doc, code) {
  const next = code ?? Math.min(doc.status[0].code + 1, 5);
  doc.status = [statusOf(next)];
  app.col('awbs').touch();
  app.notify('awb.status', presentAwb(doc));
  return doc;
}
