import { ok, fail, raw, countResults, paginate } from '../../core/response.js';
import { fmtDateTime, rnd } from '../../core/util.js';
import * as fake from '../../core/faker.js';
import { addressDocs, courierDocs, localityDocs, packageDocs } from './seed.js';
import { advanceAwb, AWB_STATUSES, buildDummyAwbPayload, issueAwb, presentAwb, renderLabel, statusOf, labelData } from './service.js';
import { makeZpl } from './pdf.js';

const pageSchema = (extra) => ({
  type: 'object',
  properties: {
    ...extra,
    itemsPerPage: { type: 'integer', minimum: 1, maximum: 100 },
    currentPage: { type: 'integer', minimum: 1, maximum: 65535 },
  },
});

const findAwb = (c, emagId) => c.col('awbs').get(emagId);

const mod = {
  id: 'shipping',
  title: 'Shipping',
  description: 'AWBs (issue, read, PDF/ZPL labels), localities, courier accounts, pickup/return addresses, predefined packages and order volumetry.',
  collections: [
    { name: 'awbs', label: 'AWBs', idField: 'emag_id', startAt: 3000001, columns: ['emag_id', 'order_id', 'rma_id', 'awb.0.awb_number', 'courier.0.courier_name', 'status.0.name', 'cash_on_delivery'] },
    { name: 'localities', label: 'Localities', idField: 'emag_id', columns: ['emag_id', 'name', 'region2', 'zipcode', 'country_code'] },
    { name: 'courier_accounts', label: 'Courier accounts', idField: 'account_id', columns: ['account_id', 'account_display_name', 'courier_account_type', 'status'] },
    { name: 'addresses', label: 'Addresses', idField: 'address_id', columns: ['address_id', 'address_type_id', 'city', 'address', 'is_default'] },
    { name: 'awb_packages', label: 'Predefined packages', idField: 'label', columns: ['label', 'length', 'width', 'height', 'weight', 'is_default'] },
  ],

  routes: [
    {
      method: 'POST', path: '/awb/save', name: 'awb/save', summary: 'Save AWB', items: { schema: 'AWBSave', max: 50 },
      handler(c) {
        const messages = [];
        const results = [];
        let isError = false;
        for (const it of c.items) {
          if (it.errors.length) { messages.push(...it.errors); isError = true; continue; }
          const r = issueAwb(c.app, it.value, { strict: c.settings.strictRules });
          messages.push(...r.errors, ...r.warnings);
          if (r.errors.length) isError = true;
          else results.push({ order_id: r.doc.order_id, ...(r.doc.rma_id ? { rma_id: r.doc.rma_id } : {}), reservation_id: r.doc.reservation_id, emag_id: r.doc.emag_id });
        }
        return { isError, messages, results };
      },
    },
    {
      method: 'POST', path: '/awb/read', name: 'awb/read', summary: 'Read AWB', readFilter: true,
      body: {
        type: 'object',
        properties: {
          emag_id: { type: 'integer', minimum: 1, maximum: 4294967295 },
          reservation_id: { type: 'integer', minimum: 1, maximum: 4294967295 },
        },
      },
      handler(c) {
        const { emag_id: emagId, reservation_id: resId } = c.body;
        const list = c.col('awbs').all().filter((a) => (emagId === undefined || a.emag_id === emagId) && (resId === undefined || a.reservation_id === resId));
        return ok(list.slice(-100).reverse().map(presentAwb));
      },
    },
    {
      method: 'GET', path: '/awb/read_pdf', name: 'awb/read_pdf', summary: 'Read AWB PDF',
      query: {
        type: 'object', required: ['emag_id'],
        properties: { emag_id: { type: 'integer', minimum: 1, maximum: 4294967295 }, awb_format: { type: 'string', enum: ['A4', 'A5', 'A6', 'ZPL'] } },
      },
      handler(c) {
        const awb = findAwb(c, c.query.emag_id);
        if (!awb) return fail(`AWB ${c.query.emag_id} not found (only AWBs issued through the API can be downloaded)`);
        const label = renderLabel(c.app, awb, c.query.awb_format || 'A4');
        return raw(200, { 'Content-Type': label.contentType, 'Content-Disposition': `attachment; filename="${label.filename}"` }, label.body);
      },
    },
    {
      method: 'GET', path: '/awb/read_zpl', name: 'awb/read_zpl', summary: 'Read AWB ZPL',
      query: { type: 'object', required: ['emag_id'], properties: { emag_id: { type: 'integer' } } },
      handler(c) {
        const awb = findAwb(c, c.query.emag_id);
        if (!awb) return fail(`AWB ${c.query.emag_id} not found`);
        const zpl = makeZpl(labelData(c.app, awb));
        return ok([Buffer.from(zpl).toString('base64')]);
      },
    },
    {
      method: 'POST', path: '/locality/read', name: 'locality/read', summary: 'Read localities', readFilter: true,
      body: pageSchema({
        emag_id: { type: 'integer' }, name: { type: 'string', maxLength: 60 }, region2: { type: 'string', maxLength: 60 },
        country_code: { type: 'string', enum: ['RO', 'BG', 'HU', 'PL', 'EL', 'DE'] }, modified: { type: 'string', format: 'date-time' },
      }),
      handler(c) {
        const list = filterLocalities(c);
        return ok(paginate(list, c.body));
      },
    },
    {
      method: 'POST', path: '/locality/count', name: 'locality/count', summary: 'Count localities', readFilter: true,
      body: { type: 'object', properties: { emag_id: { type: 'integer' }, name: { type: 'string', maxLength: 60 }, modified: { type: 'string', format: 'date-time' } } },
      handler: (c) => ok(countResults(filterLocalities(c).length, 100)),
    },
    { method: 'POST', path: '/courier_accounts/read', name: 'courier_accounts/read', summary: 'Read courier accounts', handler: (c) => ok(c.col('courier_accounts').all()) },
    { method: 'POST', path: '/addresses/read', name: 'addresses/read', summary: 'Read addresses', handler: (c) => ok(c.col('addresses').all()) },
    { method: 'POST', path: '/awb/package/read', name: 'awb/package/read', summary: 'Read predefined packages', handler: (c) => ok(c.col('awb_packages').all()) },
    {
      method: 'POST', path: '/awb/package/save', name: 'awb/package/save', summary: 'Save predefined packages', items: { schema: 'AWBPackage', max: 50 },
      handler(c) {
        const pk = c.col('awb_packages');
        const messages = [];
        const valid = [];
        for (const it of c.items) {
          if (it.errors.length) { messages.push(...it.errors); continue; }
          const v = it.value;
          const existing = v.label !== undefined ? pk.get(v.label) : null;
          if (!existing && !v.label) { messages.push(`data[${it.index}].label: required for new packages`); continue; }
          if (existing && v.is_default === undefined && c.settings.strictRules) { messages.push(`data[${it.index}].is_default: required when editing a package`); continue; }
          valid.push(v);
        }
        for (const v of valid) {
          const next = { label: v.label, length: v.length, width: v.width, height: v.height, weight: v.weight, is_default: v.is_default ?? false };
          if (next.is_default) for (const other of pk.all()) other.is_default = false;
          pk.insert(next);
        }
        if (!pk.all().some((p) => p.is_default) && pk.size) pk.all()[0].is_default = true;
        pk.touch();
        return { isError: messages.length > 0, messages, results: [] };
      },
    },
    {
      method: 'POST', path: '/order/volumetry/read', name: 'order/volumetry/read', summary: 'Read product volumetries on an order', body: 'OrderVolumetryReadFilter', readFilter: true,
      handler(c) {
        const { order_id: id, type, product_id: productId } = c.body;
        const o = c.col('orders').get(id);
        if (!o || o.type !== (type ?? 3)) return fail(`Order ${id} not found`);
        const eligible = o.products.every((p) => p.status !== 1 || p.quantity === 1);
        const data = [];
        if (eligible) {
          for (const line of o.products.filter((p) => p.status === 1 && (productId === undefined || p.product_id === productId))) {
            const m = c.col('offers').get(line.product_id)?._measurements;
            if (m) data.push({ product_id: line.product_id, weight: m.weight / 1000, length: m.length / 10, width: m.width / 10, height: m.height / 10 });
          }
        }
        return ok([{ order_id: o.id, type: o.type, volumetric_data: data }]);
      },
    },
  ],

  generators: [
    {
      id: 'awbs',
      label: 'AWBs for orders',
      description: 'Issues AWBs for seller-fulfilled orders that are In progress (2) or Prepared (3) and have none yet (those orders become Finalized). Generate orders first.',
      params: [{ name: 'count', label: 'Max AWBs', type: 'number', default: 10, min: 1, max: 200 }],
      run(app, p) {
        const awbs = app.col('awbs').all();
        const eligible = app.col('orders').filter((o) => o.type === 3 && [2, 3].includes(o.status) && !awbs.some((a) => a.order_id === o.id && !a.rma_id));
        let created = 0;
        for (const o of eligible.slice(0, Math.min(Number(p.count) || 10, 200))) {
          const r = issueAwb(app, buildDummyAwbPayload(app, o), { strict: false });
          if (r.doc) created += 1;
        }
        return { message: created ? `Issued ${created} AWBs` : 'No eligible orders (need seller orders in status 2 or 3 without an AWB)', created };
      },
    },
    {
      id: 'couriers',
      label: 'Courier accounts',
      params: [{ name: 'count', label: 'How many', type: 'number', default: 2, min: 1, max: 20 }],
      run(app, p) {
        const names = ['Fan Courier', 'Sameday', 'Cargus', 'DPD', 'GLS', 'Posta Romana'];
        const docs = [];
        for (let i = 0; i < Math.min(Number(p.count) || 2, 20); i++) {
          const name = rnd.pick(names);
          docs.push({
            account_id: app.store.nextId('courier_accounts'), account_display_name: `${name} - account ${rnd.int(2, 99)}`, courier_account_type: rnd.pick([1, 2, 3, 3]),
            courier_name: name, courier_account_properties: rnd.sample([0, 2, 6, 8, 9], rnd.int(1, 3)), created: fmtDateTime(), status: rnd.chance(0.85) ? 1 : 0, pickup_country_code: 'RO',
          });
        }
        app.col('courier_accounts').insertMany(docs);
        return { message: `Created ${docs.length} courier accounts`, created: docs.length };
      },
    },
    {
      id: 'addresses',
      label: 'Pickup / return addresses',
      params: [{ name: 'count', label: 'How many', type: 'number', default: 2, min: 1, max: 20 }],
      run(app, p) {
        const locs = app.col('localities').filter((l) => l.country_code === 'RO');
        const docs = [];
        for (let i = 0; i < Math.min(Number(p.count) || 2, 20); i++) {
          const l = rnd.pick(locs);
          docs.push({
            address_id: String(app.store.nextId('addresses')), country_id: 1, country_code: 'RO', address_type_id: rnd.pick([1, 2]), locality_id: l.emag_id, suburb: l.region2,
            city: l.name, address: fake.street(), zipcode: l.zipcode, quarter: '', floor: '', is_default: false,
          });
        }
        app.col('addresses').insertMany(docs);
        return { message: `Created ${docs.length} addresses`, created: docs.length };
      },
    },
    {
      id: 'reseed',
      label: 'Reset localities / couriers / addresses / packages',
      description: 'Restores the shipped reference data (AWBs are kept).',
      params: [],
      run(app) { mod.seed(app); return { message: 'Shipping reference data restored' }; },
    },
  ],

  rowActions: [
    { id: 'advance', label: 'Advance courier status (fires awb.status)', collection: 'awbs', run(app, row) { advanceAwb(app, row); return { message: `AWB ${row.awb[0].awb_number}: ${row.status[0].name}` }; } },
    {
      id: 'set_status', label: 'Set status…', collection: 'awbs',
      params: [{ name: 'code', label: 'Status code', type: 'select', default: '5', options: AWB_STATUSES.map((s) => ({ value: String(s.code), label: `${s.code} - ${s.name}` })) }],
      run(app, row, p) { advanceAwb(app, row, Number(p.code)); return { message: `AWB ${row.awb[0].awb_number}: ${statusOf(Number(p.code)).name}` }; },
    },
  ],

  rowLinks: [
    { id: 'pdf_a6', label: 'PDF label (A6)', collection: 'awbs', href: '/__ui/api/awb/{id}/label?format=A6' },
    { id: 'pdf_a4', label: 'PDF (A4)', collection: 'awbs', href: '/__ui/api/awb/{id}/label?format=A4' },
    { id: 'zpl', label: 'ZPL', collection: 'awbs', href: '/__ui/api/awb/{id}/label?format=ZPL' },
  ],

  seed(app) {
    for (const n of ['localities', 'courier_accounts', 'addresses', 'awb_packages']) app.col(n).clear();
    app.col('localities').insertMany(localityDocs());
    app.col('courier_accounts').insertMany(courierDocs());
    const hq = app.col('localities').find((l) => l.name === 'Sectorul 3');
    app.col('addresses').insertMany(addressDocs(hq));
    app.col('awb_packages').insertMany(packageDocs());
  },
};

function filterLocalities(c) {
  const f = c.body;
  const country = f.country_code || c.platform.country;
  const since = f.modified ? Date.parse(f.modified.replace(' ', 'T')) : null;
  return c.col('localities').filter((l) => (f.emag_id === undefined ? l.country_code === country : l.emag_id === f.emag_id)
    && (f.name === undefined || l.name.toLowerCase().includes(f.name.toLowerCase()))
    && (f.region2 === undefined || l.region2.toLowerCase() === f.region2.toLowerCase())
    && (since === null || Date.parse(l.modified.replace(' ', 'T')) >= since));
}

export default mod;
