import { rnd, ean13, fmtDate, fmtDateTime, addDays, round } from '../../core/util.js';
import { sentence } from '../../core/faker.js';

export const VALIDATION = {
  1: 'Awaiting MKTP validation', 2: 'Awaiting Brand validation', 3: 'Awaiting EAN validation', 4: 'Awaiting Documentation Validation',
  5: 'Rejected Brand', 6: 'Rejected EAN', 8: 'Rejected Documentation', 9: 'Approved Documentation', 10: 'Blocked',
  11: 'Documentation update validation pending', 12: 'Update rejected',
  13: 'Waiting for salable offer', 14: 'Unsuccessful translation', 15: 'Translation in progress', 16: 'Translation pending', 17: 'Partial translation',
};

/** Keys describing the product (documentation) vs. keys describing the offer. */
export const DOC_KEYS = ['category_id', 'vendor_category_id', 'name', 'part_number', 'description', 'brand', 'images', 'characteristics', 'family', 'url', 'warranty', 'ean', 'attachments', 'safety_information', 'manufacturer', 'eu_representative', 'source_language', 'green_tax'];
export const OFFER_KEYS = ['status', 'sale_price', 'recommended_price', 'min_sale_price', 'max_sale_price', 'currency_type', 'stock', 'handling_time', 'supply_lead_time', 'vat_id', 'emag_club'];
const SCHEDULABLE = ['sale_price', 'recommended_price', 'stock', 'handling_time', 'vat_id', 'warranty', 'status'];

export const stripPartNumber = (s) => String(s).replace(/[\s,;]/g, '');
export const validationStatus = (value, errors = null) => [{ value, description: VALIDATION[value], errors }];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Recomputes the derived fields stored on every offer document. */
export function finalize(doc) {
  doc.general_stock = (doc.stock || []).reduce((s, x) => s + x.value, 0);
  doc.estimated_stock = doc.general_stock;
  const lo = doc.min_sale_price;
  const hi = doc.max_sale_price;
  const invalid = (lo !== undefined && doc.sale_price < lo) || (hi !== undefined && doc.sale_price > hi);
  doc.offer_validation_status = invalid ? { value: 2, description: 'Invalid price' } : { value: 1, description: 'Saleable' };
  doc.modified = fmtDateTime();
  return doc;
}

const nameOf = (names = {}) => names.en || Object.values(names)[0] || '';

function docChecks(doc, cat) {
  const errs = [];
  if (cat.is_ean_mandatory && !(doc.ean?.length)) errs.push('ean: mandatory for this category');
  if (cat.is_warranty_mandatory && doc.warranty === undefined) errs.push('warranty: mandatory for this category');
  const byId = new Map(cat.characteristics.map((ch) => [ch.id, ch]));
  for (const ch of cat.characteristics) {
    if (ch.is_mandatory && !doc.characteristics?.some((x) => x.id === ch.id)) errs.push(`characteristics: mandatory characteristic "${nameOf(ch.names)}" (id ${ch.id}) is missing`);
  }
  for (const x of doc.characteristics || []) {
    const def = byId.get(x.id);
    if (!def) { errs.push(`characteristics: id ${x.id} does not belong to category ${cat.id}`); continue; }
    const allowed = def.values.some((v) => Object.values(v.names).some((n) => n.toLowerCase() === String(x.value).toLowerCase()));
    if (!def.allow_new_value && def.values.length && !allowed) errs.push(`characteristics: value "${x.value}" is not allowed for "${nameOf(def.names)}" (id ${x.id})`);
  }
  if (doc.family && doc.family.id !== 0) {
    if (!doc.family.name) errs.push('family.name: required when family.id is not 0');
    if (!doc.family.family_type_id) errs.push('family.family_type_id: required when family.id is not 0');
    else if (!cat.family_types.some((ft) => ft.id === doc.family.family_type_id)) errs.push(`family.family_type_id: ${doc.family.family_type_id} is not available in category ${cat.id}`);
  }
  return errs;
}

export function nextOfferId(app) {
  const offers = app.col('offers');
  let id;
  do { id = app.store.nextId('offers'); } while (offers.has(id));
  return id;
}

export function newPartNumberKey() {
  return `${rnd.alnum(6)}BBM`;
}

/** Marks documentation as approved: assigns the part_number_key and publishes the product in the (dummy) catalogue. */
export function approve(app, doc, { silent = false } = {}) {
  const wasPending = doc.validation_status?.[0]?.value !== 9;
  if (!doc.part_number_key) doc.part_number_key = newPartNumberKey();
  doc.validation_status = validationStatus(9);
  doc.doc_errors = null;
  doc._validationAt = Date.now();
  const catalogue = app.col('catalogue');
  if (!catalogue.has(doc.part_number_key)) {
    const cat = app.col('categories').get(doc.category_id);
    catalogue.insert({
      part_number_key: doc.part_number_key, name: doc.name, brand: doc.brand, category_id: doc.category_id,
      category_name: nameOf(cat?.names), part_number: doc.part_number, ean: doc.ean || [], hotness: rnd.pick(['SuperHot', 'Hot', 'Regular', 'Cold']),
      product_image: doc.images?.[0]?.url || null,
    });
  }
  app.col('offers').touch();
  if (wasPending && !silent) app.notify('documentation.approved', presentOffer(app, doc));
  return doc;
}

export function reject(doc, errors = ['Documentation does not meet the category requirements (dummy rejection)']) {
  doc.validation_status = validationStatus(8, errors);
  doc.doc_errors = errors;
  doc._validationAt = Date.now();
  return doc;
}

export function liveCampaign(app, offerId) {
  const props = app.store.collections.get('campaign_proposals');
  const camps = app.store.collections.get('campaigns');
  if (!props || !camps) return null;
  const now = Date.now();
  for (const p of props.all()) {
    if (p.id !== offerId) continue;
    const c = camps.get(p.campaign_id);
    if (c && Date.parse(c.startDate) <= now && now <= Date.parse(c.endDate)) return { id: c.id, name: c.name };
  }
  return null;
}

export function presentOffer(app, doc) {
  const out = {};
  for (const [k, v] of Object.entries(doc)) if (!k.startsWith('_')) out[k] = v;
  const campaign = liveCampaign(app, doc.id);
  if (campaign) out.campaign = campaign;
  return out;
}

/**
 * Create or update an offer. `v` is the already schema-validated (and coerced) ProductOfferSave payload.
 * Returns { errors, docErrors, warnings, doc }.
 *  - errors     : the item is rejected, nothing saved
 *  - docErrors  : documentation problems — offer IS saved (as validation_status 8/12) but the response has isError=true
 */
export function saveProductOffer(app, v, { strict = true } = {}) {
  const offers = app.col('offers');
  const cats = app.col('categories');
  const catalogue = app.col('catalogue');
  const errors = [];
  const warnings = [];
  const tag = `[id=${v.id}]`;
  const existing = offers.get(v.id);

  const vat = app.col('vat_rates').get(v.vat_id);
  if (!vat) errors.push(`${tag} vat_id: ${v.vat_id} is not a valid VAT id (see /vat/read)`);
  else if (vat.status !== 'active' && strict) errors.push(`${tag} vat_id: ${v.vat_id} is inactive`);
  if (v.recommended_price !== undefined && v.recommended_price <= v.sale_price) errors.push(`${tag} recommended_price: must be greater than sale_price`);
  const min = v.min_sale_price ?? existing?.min_sale_price;
  const max = v.max_sale_price ?? existing?.max_sale_price;
  if (!existing && strict && (min === undefined || max === undefined)) errors.push(`${tag} min_sale_price and max_sale_price are mandatory on the first product save`);
  if (min !== undefined && max !== undefined && max <= min) errors.push(`${tag} max_sale_price: must be greater than min_sale_price`);
  if (!existing && v.status === 2 && strict) errors.push(`${tag} status: 2 (End of Life) can only be used when updating an existing offer`);
  if (v.start_date) {
    const tomorrow = fmtDate(addDays(new Date(), 1));
    const limit = fmtDate(addDays(new Date(), 60));
    if (v.start_date < tomorrow || v.start_date > limit) errors.push(`${tag} start_date: must be between ${tomorrow} and ${limit}`);
  }
  if (errors.length) return { errors, docErrors: [], warnings };

  // ---------------------------------------------------------------- update
  if (existing) {
    const doc = existing;
    const patch = {};
    const docChanged = DOC_KEYS.some((k) => v[k] !== undefined && !same(v[k], doc[k]));
    const scheduled = v.start_date ? Object.fromEntries(SCHEDULABLE.filter((k) => v[k] !== undefined).map((k) => [k, v[k]])) : null;
    for (const k of OFFER_KEYS) {
      if (v[k] === undefined) continue;
      if (scheduled && SCHEDULABLE.includes(k)) continue;
      patch[k] = v[k];
    }
    if (scheduled) {
      doc._scheduled = [...(doc._scheduled || []), { date: v.start_date, changes: scheduled }];
      warnings.push(`${tag} changes to ${Object.keys(scheduled).join(', ')} scheduled for ${v.start_date}`);
    }
    Object.assign(doc, patch);

    let docErrors = [];
    if (docChanged) {
      const next = { ...doc };
      for (const k of DOC_KEYS) if (v[k] !== undefined) next[k] = k === 'part_number' ? stripPartNumber(v[k]) : v[k];
      const cat = cats.get(next.category_id);
      if (doc.ownership !== 2 && cat) docErrors = docChecks(next, cat);
      for (const k of DOC_KEYS) if (v[k] !== undefined) doc[k] = next[k];
      if (docErrors.length) {
        doc.validation_status = validationStatus(12, docErrors);
        doc.doc_errors = docErrors;
      } else if (doc.ownership !== 2) {
        doc.validation_status = validationStatus(11);
        doc.doc_errors = null;
      }
      doc._validationAt = Date.now();
    }
    finalize(doc);
    offers.touch();
    return { errors: [], docErrors: docErrors.map((e) => `${tag} ${e}`), warnings, doc, created: false };
  }

  // ------------------------------------------------------------------- new
  let attached = null;
  let attachedBy = null;
  if (v.part_number_key) {
    attached = catalogue.get(v.part_number_key);
    if (!attached) return { errors: [`${tag} part_number_key: "${v.part_number_key}" does not exist in the eMAG catalogue`], docErrors: [], warnings };
    attachedBy = 'pnk';
  } else if (v.ean?.length) {
    attached = catalogue.find((p) => p.ean.some((e) => v.ean.includes(e)));
    if (attached) attachedBy = 'ean';
  }

  const hasDocs = ['category_id', 'name', 'part_number', 'brand'].every((k) => v[k] !== undefined);
  const now = fmtDateTime();
  const doc = {
    id: v.id,
    ...Object.fromEntries([...DOC_KEYS, ...OFFER_KEYS, 'start_date'].filter((k) => v[k] !== undefined).map((k) => [k, v[k]])),
    part_number_key: attached?.part_number_key ?? null,
    ownership: attached ? 2 : 1,
    number_of_offers: 1,
    buy_button_rank: 1,
    best_offer_sale_price: v.sale_price,
    validation_status: validationStatus(1),
    translation_validation_status: [],
    doc_errors: null,
    created: now,
    _validationAt: Date.now(),
  };
  if (doc.part_number) doc.part_number = stripPartNumber(doc.part_number);
  doc.emag_club ??= 1;
  doc.supply_lead_time ??= 14;
  if (v.start_date) doc.start_date = v.start_date;

  let docErrors = [];
  if (attached) {
    doc.number_of_offers = rnd.int(2, 6);
    doc.buy_button_rank = rnd.int(1, doc.number_of_offers);
    doc.best_offer_sale_price = round(Math.min(v.sale_price, v.sale_price * rnd.float(0.9, 1.05, 3)), 4);
    doc.validation_status = validationStatus(attachedBy === 'pnk' ? 9 : 3);
  } else if (!hasDocs) {
    // Draft: documentation incomplete, not sent to validation yet.
    doc.validation_status = [];
    warnings.push(`${tag} saved as DRAFT: send category_id, name, part_number and brand to publish it`);
  } else {
    const cat = cats.get(v.category_id);
    if (!cat) return { errors: [`${tag} category_id: ${v.category_id} does not exist (see /category/read)`], docErrors: [], warnings };
    if (strict && !cat._isLeaf) return { errors: [`${tag} category_id: ${v.category_id} is not a leaf category you can list products in`], docErrors: [], warnings };
    docErrors = docChecks(doc, cat);
    if (docErrors.length) {
      doc.validation_status = validationStatus(8, docErrors);
      doc.doc_errors = docErrors;
    }
  }
  finalize(doc);
  offers.insert(doc);
  return { errors: [], docErrors: docErrors.map((e) => `${tag} ${e}`), warnings, doc, created: true };
}

/** Applies due scheduled updates and auto-approves documentation after settings.autoApproveSeconds. */
export function tick(app) {
  const offers = app.col('offers');
  const today = fmtDate();
  const autoMs = (app.settings.get().autoApproveSeconds || 0) * 1000;
  let touched = false;
  for (const doc of offers.all()) {
    if (doc._scheduled?.length) {
      const due = doc._scheduled.filter((s) => s.date <= today);
      if (due.length) {
        for (const s of due) Object.assign(doc, s.changes);
        doc._scheduled = doc._scheduled.filter((s) => s.date > today);
        finalize(doc);
        touched = true;
      }
    }
    const val = doc.validation_status?.[0]?.value;
    if (autoMs > 0 && [1, 3, 11].includes(val) && Date.now() - (doc._validationAt || 0) >= autoMs) {
      approve(app, doc);
      touched = true;
    }
  }
  if (touched) offers.touch();
}

// ---------------------------------------------------------------- generators
export function randomCharacteristics(cat, { onlyMandatory = false } = {}) {
  const lang = 'ro';
  const out = [];
  for (const ch of cat.characteristics) {
    if (!ch.is_mandatory && (onlyMandatory || !rnd.chance(0.7))) continue;
    if (ch.values.length) out.push({ id: ch.id, value: rnd.pick(ch.values).names[lang] });
    else out.push({ id: ch.id, value: String(rnd.pick([5, 10, 40, 80, 150, 500, 900, 1200, 1800, 2000])) });
  }
  return out;
}

export function randomProductSpec(cat) {
  const g = cat._gen || { noun: 'Produs', brands: ['Generic'], models: ['Basic'], price: [20, 200] };
  const brand = rnd.pick(g.brands);
  const model = rnd.pick(g.models);
  const characteristics = randomCharacteristics(cat);
  const extras = characteristics
    .map((c) => ({ c, def: cat.characteristics.find((x) => x.id === c.id) }))
    .filter(({ def }) => def?.values.length && ![1001, 1008, 1006].includes(def.id)).slice(0, 2).map(({ c }) => c.value);
  const color = characteristics.find((c) => c.id === 1001)?.value;
  const name = [`${g.noun} ${brand} ${model}`, ...extras, color].filter(Boolean).join(', ');
  const base = rnd.float(g.price[0], g.price[1], 2);
  return { brand, model, name, characteristics, base };
}

export function buildOfferPayload(app, cat, { id, status = 1, stockZero = false } = {}) {
  const spec = randomProductSpec(cat);
  const vatId = app.col('vat_rates').find((v) => v.status === 'active' && v.vat_rate === '0.2100')?.vat_id ?? 1;
  const sale = round(spec.base / 1.21, 4);
  const payload = {
    id,
    category_id: cat.id,
    name: spec.name,
    part_number: `${spec.brand.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase()}${rnd.alnum(8)}`,
    brand: spec.brand,
    description: `<p>${spec.name}.</p><p>${sentence()}</p>`,
    images: [1, 2].map((n, i) => ({ display_type: i === 0 ? 1 : 2, url: `https://images.example.com/products/${id}-${n}.jpg` })),
    characteristics: spec.characteristics,
    url: `https://shop.example.com/p/${id}`,
    status,
    sale_price: sale,
    min_sale_price: round(sale * 0.8, 4),
    max_sale_price: round(sale * 1.4, 4),
    recommended_price: round(sale * rnd.float(1.1, 1.3, 2), 4),
    stock: [{ warehouse_id: 1, value: stockZero ? 0 : rnd.int(1, 120) }],
    handling_time: [{ warehouse_id: 1, value: rnd.pick([0, 0, 1, 2, 3]) }],
    vat_id: vatId,
    emag_club: rnd.pick([0, 1, 1]),
  };
  if (cat.is_ean_mandatory || rnd.chance(0.6)) payload.ean = [ean13()];
  if (cat.is_warranty_mandatory || rnd.chance(0.4)) payload.warranty = rnd.pick([0, 12, 24, 36]);
  return payload;
}
