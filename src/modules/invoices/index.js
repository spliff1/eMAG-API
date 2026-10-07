import { ok, paginate } from '../../core/response.js';
import { rnd, fmtDate, round, daysAgo } from '../../core/util.js';
import * as fake from '../../core/faker.js';
import { buildOrder } from '../orders/service.js';

const CATEGORIES = [
  { category: 'FC', name: 'Commission' },
  { category: 'FL', name: 'Logistics services' },
  { category: 'FM', name: 'Marketing services' },
  { category: 'FP', name: 'Penalties' },
  { category: 'FS', name: 'Storno' },
];

const supplier = () => ({
  name: 'Marketplace Dummy S.A.', register_number: 'J40/0000/2000', cif: 'RO00000000', tax_code: 'RO00000000', social_capital: '1000000 RON',
  iban: 'RO00DUMY0000000000000000', bank: 'Dummy Bank', address: 'Strada Exemplu nr. 1, Bucuresti', phone_number: '0210000000',
});

function totals(lines) {
  const wo = round(lines.reduce((s, l) => s + l.value, 0), 2);
  const vat = round(lines.reduce((s, l) => s + l.vat_value, 0), 2);
  return { total_without_vat: wo, total_vat_value: vat, total_with_vat: round(wo + vat, 2) };
}

function line(name, qty, unit, rate = 21) {
  const value = round(qty * unit, 2);
  return { product_name: name, unit_of_measure: 'buc', quantity: qty, unit_price: unit, vat_rate: rate, value, vat_value: round((value * rate) / 100, 2) };
}

function buildInvoice(app, n) {
  const cat = rnd.pick(CATEGORIES.slice(0, 4));
  const date = daysAgo(rnd.int(1, 120));
  const lines = {
    FC: () => [line('Marketplace commission', 1, rnd.float(80, 4000, 2))],
    FL: () => [line('Fulfilment & logistics services', rnd.int(5, 80), rnd.float(4, 15, 2))],
    FM: () => [line('Promotion / advertising services', 1, rnd.float(50, 1500, 2))],
    FP: () => [line('Late shipment penalty', rnd.int(1, 5), rnd.float(10, 50, 2))],
  }[cat.category]();
  return {
    category: cat.category,
    name: cat.name,
    number: `${cat.category}-${date.getFullYear()}-${String(n).padStart(6, '0')}`,
    date: fmtDate(date),
    is_storno: 0,
    supplier: supplier(),
    customer: {
      name: 'Seller Dummy S.R.L.', register_number: 'J40/1234/2015', cif: 'RO12345678', tax_code: 'RO12345678', iban: fake.iban(), bank: fake.bank(), country: 'Romania', address: 'Strada Depozitului nr. 10, Bucuresti',
    },
    lines,
    payment_term: fmtDate(new Date(date.getTime() + 15 * 864e5)),
    ...totals(lines),
    currency: app.currency(),
  };
}

function customerInvoiceFor(app, order, { storno = false, reversalFor = '' } = {}) {
  const sign = storno ? -1 : 1;
  const lines = order.products.filter((p) => p.status === 1).map((p) => ({ ...line(p.name, sign * p.quantity, p.sale_price, Math.round(Number(p.vat) * 100)) }));
  const c = order.customer;
  return {
    category: storno ? 'storno' : 'normal',
    order_id: order.id,
    number: `${storno ? 'STO' : 'FACT'}-${order.id}`,
    date: order.modified.slice(0, 10),
    is_storno: storno ? 1 : 0,
    reversal_for: reversalFor,
    supplier: { name: 'Seller Dummy S.R.L.', register_number: 'J40/1234/2015', cif: 'RO12345678', tax_code: 'RO12345678', social_capital: '200 RON', iban: fake.iban(), bank: fake.bank(), country: 'Romania', address: 'Strada Depozitului nr. 10, Bucuresti' },
    customer: { name: c.billing_name, register_number: c.registration_number, cif: c.code, tax_code: c.code, iban: c.iban, bank: c.bank, country: c.billing_country, address: `${c.billing_street}, ${c.billing_city}` },
    lines,
    ...totals(lines),
    total_with_vat: round(totals(lines).total_with_vat, 2),
    currency: lines.length ? order.products[0].currency : 'RON',
  };
}

function dateFilter(f) {
  return (inv) => (!f.date_start || inv.date >= f.date_start) && (!f.date_end || inv.date <= f.date_end);
}

const readSchema = (extra) => ({
  type: 'object',
  properties: {
    ...extra,
    date_start: { type: 'string', format: 'date' },
    date_end: { type: 'string', format: 'date' },
    itemsPerPage: { type: 'integer', minimum: 1, maximum: 1000 },
    currentPage: { type: 'integer', minimum: 1 },
  },
});

const mod = {
  id: 'invoices',
  title: 'Invoices',
  description: 'Invoices issued by eMAG to the seller (commission, logistics, ...) and invoices the seller issued to customers.',
  collections: [
    { name: 'invoices', label: 'Marketplace invoices', idField: 'number', columns: ['number', 'category', 'name', 'date', 'total_with_vat', 'currency'] },
    { name: 'customer_invoices', label: 'Customer invoices', idField: 'number', columns: ['number', 'category', 'order_id', 'date', 'total_with_vat', 'currency'] },
  ],

  routes: [
    // Spec lists these under /api-3/... (the server base already ends in /api-3); both spellings reach this route.
    { method: 'POST', path: '/invoice/categories', name: 'invoice/categories', summary: 'Read invoice categories', handler: () => ok(CATEGORIES) },
    {
      method: 'POST', path: '/invoice/read', name: 'invoice/read', summary: 'Read invoice data', readFilter: true,
      body: readSchema({ category: { type: 'string' }, number: { type: 'string' } }),
      handler(c) {
        const f = c.body;
        const list = c.col('invoices').filter((i) => (!f.category || i.category === f.category) && (!f.number || i.number === f.number)).filter(dateFilter(f))
          .sort((a, b) => (a.date < b.date ? 1 : -1));
        return ok({ total_results: list.length, invoices: paginate(list, { currentPage: f.currentPage, itemsPerPage: f.itemsPerPage ?? 100 }) });
      },
    },
    {
      method: 'POST', path: '/customer-invoice/read', name: 'customer-invoice/read', summary: 'Read customer invoice data', readFilter: true,
      body: readSchema({ category: { type: 'string', enum: ['normal', 'storno'] }, order_id: { type: 'integer' }, number: { type: 'string' } }),
      handler(c) {
        const f = c.body;
        const list = c.col('customer_invoices').filter((i) => (!f.category || i.category === f.category) && (f.order_id === undefined || i.order_id === f.order_id) && (!f.number || i.number === f.number))
          .filter(dateFilter(f)).sort((a, b) => (a.date < b.date ? 1 : -1));
        return ok({ total_results: list.length, invoices: paginate(list, { currentPage: f.currentPage, itemsPerPage: f.itemsPerPage ?? 100 }) });
      },
    },
  ],

  generators: [
    {
      id: 'invoices',
      label: 'Marketplace invoices',
      params: [{ name: 'count', label: 'How many', type: 'number', default: 10, min: 1, max: 200 }],
      run(app, p) {
        const col = app.col('invoices');
        const count = Math.min(Number(p.count) || 10, 200);
        for (let i = 0; i < count; i++) col.insert(buildInvoice(app, col.size + 1 + rnd.int(0, 5000)));
        return { message: `Created ${count} invoices`, created: count };
      },
    },
    {
      id: 'customer_invoices',
      label: 'Customer invoices (from orders)',
      description: 'One invoice per finalized order and a storno for returned ones. Finalized orders are generated if missing.',
      params: [{ name: 'count', label: 'Max invoices', type: 'number', default: 10, min: 1, max: 200 }],
      run(app, p) {
        const col = app.col('customer_invoices');
        const orders = app.col('orders');
        const count = Math.min(Number(p.count) || 10, 200);
        const pending = () => orders.filter((o) => o.type === 3 && [4, 5].includes(o.status) && !col.has(`FACT-${o.id}`));
        while (pending().length < count && orders.size < 500) orders.insert(buildOrder(app, { status: 4, type: 3 }));
        let created = 0;
        for (const o of pending().slice(0, count)) {
          const inv = customerInvoiceFor(app, o);
          col.insert(inv);
          created += 1;
          if (o.status === 5) { col.insert(customerInvoiceFor(app, o, { storno: true, reversalFor: inv.number })); created += 1; }
        }
        return { message: `Created ${created} customer invoices`, created };
      },
    },
  ],

  seed(app) {
    app.col('invoices').clear();
    app.col('customer_invoices').clear();
  },
};

export default mod;
