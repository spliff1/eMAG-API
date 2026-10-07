import { ok, countResults, paginate } from '../../core/response.js';
import { rnd, fmtDateTime, parseDateTime, publicView, daysAgo } from '../../core/util.js';
import * as fake from '../../core/faker.js';
import { buildOrder } from '../orders/service.js';

const STATUS_NAMES = { 1: 'Incomplete', 2: 'New', 3: 'Acknowledged', 4: 'Refused', 5: 'Canceled', 6: 'Received', 7: 'Finalized' };
/** actual -> allowed new statuses (from the official documentation). */
const TRANSITIONS = { 2: [2, 3, 5], 3: [3, 5, 6], 4: [4], 5: [5], 6: [4, 6, 7], 7: [7] };
const nextLineId = (app) => (app.store.seq.rma_lines = (app.store.seq.rma_lines ?? 5_000_000) + 1);

const EDITABLE = [
  'id', 'invoice_number', 'customer_company', 'awbs', 'pickup_locality_id', 'pickup_method', 'return_reason', 'observations', 'return_type',
  'return_address_id', 'return_tax_value', 'customer_account_iban', 'customer_account_bank', 'customer_account_beneficiary',
  'replacement_product_emag_id', 'replacement_product_id', 'replacement_product_name', 'replacement_product_quantity', 'currency',
];

function filterRmas(list, f) {
  const from = f.date_start ? parseDateTime(f.date_start) : null;
  const to = f.date_end ? parseDateTime(f.date_end) : null;
  return list.filter((r) => (f.id === undefined || r.id === f.id)
    && (f.emag_id === undefined || r.emag_id === f.emag_id)
    && (f.order_id === undefined || r.order_id === f.order_id)
    && (f.product_id === undefined || r.products.some((p) => p.product_id === f.product_id))
    && (f.product_emag_id === undefined || r.products.some((p) => p.product_emag_id === f.product_emag_id))
    && (f.request_status === undefined || r.request_status === f.request_status)
    && (f.type === undefined || r.type === f.type)
    && (!from || parseDateTime(r.date) >= from)
    && (!to || parseDateTime(r.date) <= to)).sort((a, b) => b.emag_id - a.emag_id);
}

function buildRma(app, order, status) {
  const lines = order.products.filter((p) => p.status === 1);
  const picked = rnd.sample(lines, rnd.int(1, Math.min(2, lines.length)));
  const reason = rnd.int(1, 8);
  const created = daysAgo(rnd.int(0, 10), 1);
  const returnType = rnd.pick([1, 2, 3, 3, 3, 5]);
  const c = order.customer;
  return {
    emag_id: app.store.nextId('rmas'),
    id: null,
    order_id: order.id,
    type: order.type,
    invoice_number: order.attachments.find((a) => a.type === 1) ? `FACT-${order.id}` : '',
    customer_name: c.name,
    customer_company: c.company,
    customer_phone: c.phone_1,
    products: picked.map((l) => ({
      id: nextLineId(app),
      product_emag_id: l.mkt_id,
      product_id: l.product_id,
      quantity: rnd.int(1, l.quantity),
      product_name: l.name,
      return_reason: reason,
      observations: rnd.chance(0.3) ? 'Produsul nu corespunde descrierii.' : '',
      diagnostic: null,
      reject_reason: null,
      refund_value: '',
    })),
    awbs: [],
    pickup_locality_id: Number(c.shipping_locality_id) || 1,
    pickup_method: rnd.pick([1, 2, 3]),
    return_reason: reason,
    observations: '',
    return_type: returnType,
    return_address_id: 1002,
    return_tax_value: rnd.pick([0, 0, 15]),
    customer_account_iban: returnType === 3 && order.payment_mode_id !== 3 ? fake.iban() : '',
    customer_account_bank: returnType === 3 && order.payment_mode_id !== 3 ? fake.bank() : '',
    customer_account_beneficiary: returnType === 3 && order.payment_mode_id !== 3 ? c.name : '',
    replacement_product_emag_id: null,
    replacement_product_id: null,
    replacement_product_name: '',
    replacement_product_quantity: null,
    date: fmtDateTime(created),
    request_status: status,
    request_status_name: STATUS_NAMES[status],
    currency: app.currency(),
  };
}

const mod = {
  id: 'returns',
  title: 'Returns',
  description: 'Return requests (RMA) opened by customers. The API can only read them and move them through the allowed status transitions.',
  collections: [
    { name: 'rmas', label: 'Return requests', idField: 'emag_id', startAt: 7000001, columns: ['emag_id', 'order_id', 'request_status', 'request_status_name', 'customer_name', 'return_type', 'date'] },
  ],

  routes: [
    {
      method: 'POST', path: '/rma/read', name: 'rma/read', summary: 'Read return requests', body: 'RMAReadFilter', readFilter: true,
      handler(c) {
        return ok(publicView(paginate(filterRmas(c.col('rmas').all(), c.body), c.body)));
      },
    },
    {
      method: 'POST', path: '/rma/count', name: 'rma/count', summary: 'Count return requests', body: 'RMAReadFilter', readFilter: true,
      handler: (c) => ok(countResults(filterRmas(c.col('rmas').all(), c.body).length, c.body.itemsPerPage || 100)),
    },
    {
      method: 'POST', path: '/rma/save', name: 'rma/save', summary: 'Save/update return request', items: { schema: 'RMASave', max: 50 },
      handler(c) {
        const messages = [];
        const results = [];
        let isError = false;
        const col = c.col('rmas');
        for (const it of c.items) {
          if (it.errors.length) { messages.push(...it.errors); isError = true; continue; }
          const v = it.value;
          const tag = `[rma ${v.emag_id}]`;
          const rma = col.get(v.emag_id);
          if (!rma) { messages.push(`${tag} return request not found (return requests are created by customers, not through the API)`); isError = true; continue; }
          if (rma.order_id !== v.order_id) { messages.push(`${tag} order_id: does not match the return request`); isError = true; continue; }
          if (v.request_status !== undefined && c.settings.strictRules && !(TRANSITIONS[rma.request_status] || []).includes(v.request_status)) {
            messages.push(`${tag} request_status: transition ${rma.request_status} (${STATUS_NAMES[rma.request_status]}) -> ${v.request_status} is not allowed`);
            isError = true;
            continue;
          }
          if (!v.currency) messages.push(`${tag} currency not sent: the platform default (${c.app.currency()}) was used`);
          for (const k of EDITABLE) if (v[k] !== undefined) rma[k] = v[k];
          for (const p of v.products || []) {
            const line = rma.products.find((l) => l.id === p.id);
            if (!line) { messages.push(`${tag} products: line ${p.id} not found`); continue; }
            Object.assign(line, p);
          }
          if (v.request_status !== undefined) { rma.request_status = v.request_status; rma.request_status_name = STATUS_NAMES[v.request_status]; }
          results.push(publicView(rma));
        }
        col.touch();
        return { isError, messages, results };
      },
    },
  ],

  generators: [
    {
      id: 'rmas',
      label: 'Return requests',
      description: 'Creates RMAs from finalized orders (finalized orders are generated if none exist). New ones can fire the "rma.new" callback.',
      params: [
        { name: 'count', label: 'How many', type: 'number', default: 5, min: 1, max: 100 },
        {
          name: 'status', label: 'Status', type: 'select', default: '2',
          options: [{ value: 'mixed', label: 'Mixed' }, ...Object.entries(STATUS_NAMES).map(([k, v]) => ({ value: k, label: `${k} - ${v}` }))],
        },
        { name: 'notify', label: 'Fire "rma.new" callbacks', type: 'boolean', default: false },
      ],
      run(app, p) {
        const count = Math.min(Number(p.count) || 5, 100);
        const orders = app.col('orders');
        let pool = orders.filter((o) => o.status === 4 && o.products.some((x) => x.status === 1));
        while (pool.length < Math.min(count, 5)) {
          const o = buildOrder(app, { status: 4, type: 3 });
          orders.insert(o);
          pool.push(o);
        }
        let created = 0;
        for (let i = 0; i < count; i++) {
          const status = p.status && p.status !== 'mixed' ? Number(p.status) : rnd.weighted([[2, 40], [3, 25], [6, 15], [7, 10], [5, 5], [4, 5]]);
          const rma = buildRma(app, rnd.pick(pool), status);
          app.col('rmas').insert(rma);
          created += 1;
          if (p.notify && status === 2) app.notify('rma.new', publicView(rma));
        }
        return { message: `Created ${created} return requests`, created };
      },
    },
  ],

  rowActions: [
    ...[[3, 'Acknowledged'], [6, 'Received'], [5, 'Canceled by customer']].map(([code, label]) => ({
      id: `to_${code}`, label: `Set ${label} (${code}) + rma.status callback`, collection: 'rmas', danger: code === 5,
      run(app, row) {
        row.request_status = code; row.request_status_name = STATUS_NAMES[code];
        app.col('rmas').touch();
        app.notify('rma.status', publicView(row));
        return { message: `RMA ${row.emag_id} -> ${STATUS_NAMES[code]}` };
      },
    })),
    { id: 'notify_new', label: 'Re-send rma.new callback', collection: 'rmas', run(app, row) { app.notify('rma.new', publicView(row)); return { message: 'rma.new queued' }; } },
  ],
};

export default mod;
