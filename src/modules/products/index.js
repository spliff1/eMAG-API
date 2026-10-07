import { ok, fail, countResults, paginate } from '../../core/response.js';
import { rnd, ean13, round } from '../../core/util.js';
import {
  approve, buildOfferPayload, finalize, presentOffer, randomProductSpec, reject, saveProductOffer, stripPartNumber, tick, validationStatus, newPartNumberKey, nextOfferId,
} from './service.js';

function applyFilters(offers, f) {
  const pn = f.part_number !== undefined ? stripPartNumber(f.part_number) : undefined;
  return offers.filter((o) => (f.id === undefined || o.id === f.id)
    && (f.status === undefined || o.status === f.status)
    && (pn === undefined || o.part_number === pn)
    && (f.part_number_key === undefined || o.part_number_key === f.part_number_key)
    && (f.general_stock === undefined || o.general_stock <= f.general_stock)
    && (f.estimated_stock === undefined || o.estimated_stock <= f.estimated_stock)
    && (f.offer_validation_status === undefined || o.offer_validation_status?.value === f.offer_validation_status)
    && (f.validation_status === undefined || o.validation_status?.[0]?.value === f.validation_status)
    && (f.translation_validation_status === undefined || o.translation_validation_status?.[0]?.value === f.translation_validation_status));
}

/** Shared response builder for batch saves: per-item schema errors reject the item; documentation errors keep it. */
function batchSave(c, processItem) {
  const messages = [];
  let isError = false;
  for (const it of c.items) {
    if (it.errors.length) { messages.push(...it.errors); isError = true; continue; }
    const r = processItem(it.value);
    messages.push(...r.errors, ...r.docErrors, ...r.warnings);
    if (r.errors.length || r.docErrors.length) isError = true;
  }
  return { isError, messages, results: [] };
}

const leafCategories = (app) => app.col('categories').filter((c) => c._isLeaf);

const mod = {
  id: 'products',
  title: 'Products & Offers',
  description: 'Seller offers (product_offer/*, offer/save, offer_stock), the dummy eMAG catalogue used for attach-by-EAN/PNK and find_by_eans, and the documentation validation lifecycle.',
  collections: [
    {
      name: 'offers', label: 'My offers', startAt: 100001,
      columns: ['id', 'name', 'sale_price', 'status', 'general_stock', 'validation_status.0.value', 'offer_validation_status.value', 'part_number_key'],
    },
    { name: 'catalogue', label: 'eMAG catalogue', idField: 'part_number_key', columns: ['part_number_key', 'name', 'brand', 'category_name', 'ean'] },
  ],

  init(app) {
    const t = setInterval(() => { try { tick(app); } catch (e) { console.warn('[products] tick failed', e); } }, 5000);
    t.unref();
  },

  routes: [
    {
      method: 'POST', path: '/product_offer/read', name: 'product_offer/read', summary: 'Read products and offers',
      body: 'ProductOfferReadFilter', readFilter: true,
      handler(c) {
        const list = applyFilters(c.col('offers').all(), c.body);
        return ok(paginate(list, c.body).map((o) => presentOffer(c.app, o)));
      },
    },
    {
      method: 'POST', path: '/product_offer/count', name: 'product_offer/count', summary: 'Count products and offers',
      body: 'ProductOfferReadFilter', readFilter: true,
      handler: (c) => ok(countResults(applyFilters(c.col('offers').all(), c.body).length, c.body.itemsPerPage || 100)),
    },
    {
      method: 'POST', path: '/product_offer/save', name: 'product_offer/save', summary: 'Save product and offer',
      items: { schema: 'ProductOfferSave', max: 50 },
      handler: (c) => batchSave(c, (v) => saveProductOffer(c.app, v, { strict: c.settings.strictRules })),
    },
    {
      method: 'POST', path: '/offer/save', name: 'offer/save', summary: 'Update existing offer (light API)',
      items: { schema: 'OfferSave', max: 50 },
      handler: (c) => batchSave(c, (v) => {
        const tag = `[id=${v.id}]`;
        const doc = c.col('offers').get(v.id);
        const errors = [];
        if (!doc) return { errors: [`${tag} offer not found — create it with product_offer/save first`], docErrors: [], warnings: [] };
        if (v.sale_price !== undefined && v.sale_price <= 0) errors.push(`${tag} sale_price: must be greater than 0`);
        if (v.vat_id !== undefined) {
          const vat = c.col('vat_rates').get(v.vat_id);
          if (!vat) errors.push(`${tag} vat_id: ${v.vat_id} is not a valid VAT id`);
        }
        const next = { ...doc, ...v };
        if (v.recommended_price !== undefined && v.recommended_price <= next.sale_price) errors.push(`${tag} recommended_price: must be greater than sale_price`);
        if (next.min_sale_price !== undefined && next.max_sale_price !== undefined && next.max_sale_price <= next.min_sale_price) errors.push(`${tag} max_sale_price: must be greater than min_sale_price`);
        if (errors.length) return { errors, docErrors: [], warnings: [] };
        Object.assign(doc, v);
        finalize(doc);
        c.col('offers').touch();
        return { errors: [], docErrors: [], warnings: [] };
      }),
    },
    {
      method: 'PATCH', path: '/offer_stock/:resourceId', name: 'offer_stock/{resourceId}', summary: 'Update offer stock',
      body: {
        type: 'object',
        required: ['data'],
        properties: { data: { type: 'object', required: ['stock'], properties: { stock: { type: 'array', minItems: 1, items: { $ref: '#/components/schemas/StockItem' } } } } },
      },
      handler(c) {
        const id = Number(c.params.resourceId);
        const doc = Number.isInteger(id) ? c.col('offers').get(id) : null;
        if (!doc) return fail(`Offer ${c.params.resourceId} not found`);
        doc.stock = c.body.data.stock;
        finalize(doc);
        c.col('offers').touch();
        return ok();
      },
    },
    {
      method: 'POST', path: '/measurements/save', name: 'measurements/save', summary: 'Save volume measurements',
      items: { schema: 'Measurement', max: 50 },
      handler: (c) => batchSave(c, (v) => {
        const doc = c.col('offers').get(v.id);
        if (!doc) return { errors: [`[id=${v.id}] offer not found`], docErrors: [], warnings: [] };
        doc._measurements = { length: v.length, width: v.width, height: v.height, weight: v.weight };
        c.col('offers').touch();
        return { errors: [], docErrors: [], warnings: [] };
      }),
    },
    {
      method: 'GET', path: '/documentation/find_by_eans', name: 'documentation/find_by_eans', summary: 'Find products by EAN', rateGroup: 'ean',
      query: { type: 'object', required: ['eans'], properties: { eans: { type: 'array', items: { type: 'string' } } } },
      handler(c) {
        const messages = [];
        let eans = c.query.eans;
        if (eans.length > 100) { messages.push('Maximum 100 EAN codes per request: the extra codes were ignored'); eans = eans.slice(0, 100); }
        const offers = c.col('offers').all();
        const results = c.col('catalogue').filter((p) => p.ean.some((e) => eans.includes(e))).map((p) => {
          const vendorHasOffer = offers.some((o) => o.part_number_key === p.part_number_key);
          return {
            eans: p.ean,
            part_number_key: p.part_number_key,
            product_name: p.name,
            brand_name: p.brand,
            category_name: p.category_name,
            doc_category_id: p.category_id,
            site_url: `https://www.emag.example/${p.part_number_key}/pd/${p.part_number_key}/`,
            allow_to_add_offer: !vendorHasOffer,
            vendor_has_offer: vendorHasOffer,
            hotness: p.hotness,
            product_image: p.product_image,
          };
        });
        return ok(results, messages);
      },
    },
  ],

  generators: [
    {
      id: 'offers',
      label: 'My offers',
      description: 'Creates offers through the same code path as product_offer/save (so they are fully valid).',
      params: [
        { name: 'count', label: 'How many', type: 'number', default: 10, min: 1, max: 200 },
        {
          name: 'validation', label: 'Documentation state', type: 'select', default: 'approved',
          options: [{ value: 'approved', label: 'Approved (9)' }, { value: 'awaiting', label: 'Awaiting validation (1)' }, { value: 'mixed', label: 'Mixed (incl. rejected / blocked)' }],
        },
        { name: 'variety', label: 'Include inactive / out-of-stock offers', type: 'boolean', default: true },
      ],
      run(app, p) {
        const cats = leafCategories(app);
        const count = Math.min(Number(p.count) || 10, 200);
        let created = 0;
        for (let i = 0; i < count; i++) {
          const cat = rnd.pick(cats);
          const status = p.variety !== false && rnd.chance(0.15) ? 0 : 1;
          const payload = buildOfferPayload(app, cat, { id: nextOfferId(app), status, stockZero: p.variety !== false && rnd.chance(0.1) });
          const r = saveProductOffer(app, payload, { strict: false });
          if (!r.doc) continue;
          const mode = p.validation === 'mixed' ? rnd.weighted([['approved', 70], ['awaiting', 15], ['rejected', 10], ['blocked', 5]]) : (p.validation || 'approved');
          if (mode === 'approved') approve(app, r.doc, { silent: true });
          else if (mode === 'rejected') reject(r.doc);
          else if (mode === 'blocked') r.doc.validation_status = validationStatus(10);
          created += 1;
        }
        app.col('offers').touch();
        return { message: `Created ${created} offers`, created };
      },
    },
    {
      id: 'catalogue',
      label: 'eMAG catalogue products',
      description: 'Products that already exist on eMAG — use their EAN / part_number_key to test "attach offer to existing product" and documentation/find_by_eans.',
      params: [{ name: 'count', label: 'How many', type: 'number', default: 20, min: 1, max: 500 }],
      run(app, p) {
        const cats = leafCategories(app);
        const count = Math.min(Number(p.count) || 20, 500);
        const docs = [];
        for (let i = 0; i < count; i++) {
          const cat = rnd.pick(cats);
          const spec = randomProductSpec(cat);
          docs.push({
            part_number_key: newPartNumberKey(),
            name: spec.name,
            brand: spec.brand,
            category_id: cat.id,
            category_name: cat.names.en || Object.values(cat.names)[0],
            part_number: `${spec.brand.slice(0, 3).toUpperCase()}${rnd.alnum(8)}`,
            ean: [ean13()],
            hotness: rnd.pick(['SuperHot', 'Hot', 'Regular', 'Cold', 'SuperCold']),
            product_image: `https://images.example.com/catalogue/${rnd.alnum(8)}.jpg`,
          });
        }
        app.col('catalogue').insertMany(docs);
        return { message: `Created ${docs.length} catalogue products (see the EAN column)`, created: docs.length };
      },
    },
  ],

  rowActions: [
    { id: 'approve', label: 'Approve documentation (9)', collection: 'offers', run(app, row) { approve(app, row); return { message: `Offer ${row.id} approved (part_number_key ${row.part_number_key})` }; } },
    { id: 'reject', label: 'Reject documentation (8)', collection: 'offers', run(app, row) { reject(row); app.col('offers').touch(); return { message: `Offer ${row.id} rejected` }; } },
    { id: 'block', label: 'Block (10)', collection: 'offers', danger: true, run(app, row) { row.validation_status = validationStatus(10); app.col('offers').touch(); return { message: `Offer ${row.id} blocked` }; } },
    { id: 'update_rejected', label: 'Reject update (12)', collection: 'offers', run(app, row) { row.validation_status = validationStatus(12, ['Documentation update rejected (dummy)']); row.doc_errors = ['Documentation update rejected (dummy)']; app.col('offers').touch(); return { message: `Update rejected for ${row.id}` }; } },
    { id: 'out_of_stock', label: 'Set stock to 0', collection: 'offers', run(app, row) { row.stock = row.stock.map((s) => ({ ...s, value: 0 })); finalize(row); app.col('offers').touch(); return { message: 'Stock set to 0' }; } },
    { id: 'restock', label: 'Restock (+50)', collection: 'offers', run(app, row) { row.stock = row.stock.map((s) => ({ ...s, value: s.value + 50 })); finalize(row); app.col('offers').touch(); return { message: 'Stock +50' }; } },
    { id: 'invalid_price', label: 'Break price range (offer_validation_status 2)', collection: 'offers', run(app, row) { row.max_sale_price ??= round(row.sale_price * 1.4, 4); row.sale_price = round(row.max_sale_price * 1.5, 4); finalize(row); app.col('offers').touch(); return { message: 'sale_price is now above max_sale_price' }; } },
  ],
};

export default mod;
