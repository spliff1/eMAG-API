/**
 * What can be imported from the real marketplace. Every source only issues READ calls (see client.js allow-list)
 * and writes into the same collections the dummy API serves, so imported data is immediately usable by the dummy.
 *
 * run(ctx) -> number of imported items.   ctx = { client, app, options, mode, signal, step, log, anonymizer, platform }
 *   mode 'replace': the local data of that source is replaced by the real data (cleared once the first page arrived OK)
 *   mode 'merge'  : real documents are upserted by id, everything else is kept
 */
import { fmtDateTime } from '../core/util.js';

const clamp = (v, lo, hi, d) => Math.min(Math.max(Number.isFinite(Number(v)) ? Number(v) : d, lo), hi);
const PAGE = 100;

/** Writes docs into a collection honouring the mode; `first` = this is the first batch of the run. */
function put(col, docs, { mode, first }) {
  if (mode === 'replace' && first) col.clear();
  col.insertMany(docs);
}

const SPLIT = { 100: 50, 50: 25, 25: 5, 5: 1 };
const pause = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('Import cancelled'), { fatal: true })); }, { once: true });
});

/**
 * Reads items [offset, offset+size) of a paged endpoint. If the marketplace answers with an error (it sometimes
 * answers "An internal error occurred." for one poisonous record) it retries, then splits the range into smaller
 * pages (100 -> 50 -> 25 -> 5 -> 1) to isolate and skip only the broken records. `budget` caps the requests spent on one page.
 */
async function readRange(ctx, path, body, offset, size, budget) {
  const tries = size === PAGE ? 3 : size === 50 ? 2 : 1;
  let lastErr;
  for (let t = 1; t <= tries && budget.left > 0; t++) {
    budget.left -= 1;
    try {
      const { results } = await ctx.client.post(path, { ...body, currentPage: offset / size + 1, itemsPerPage: size });
      return { items: Array.isArray(results) ? results : [], skipped: 0 };
    } catch (e) {
      if (e.fatal) throw e;
      lastErr = e;
      if (t < tries) await pause((ctx.retryDelayMs ?? 2000) * t, ctx.signal);
    }
  }
  const next = SPLIT[size];
  if (!next || budget.left <= 0) return { items: [], skipped: size, error: lastErr };
  const out = { items: [], skipped: 0, error: lastErr };
  for (let o = offset; o < offset + size; o += next) {
    const r = await readRange(ctx, path, body, o, next, budget);
    out.items.push(...r.items);
    out.skipped += r.skipped;
    out.error ??= r.error;
  }
  return out;
}

/** Generic page loop. onPage(results, pageIndex) returns how many docs it imported. Tolerates broken pages (see readRange). */
async function paged(ctx, path, body, { total = null, maxPages = 10_000, onPage }) {
  let imported = 0;
  let failedInARow = 0;
  ctx.step.set({ done: 0, total, imported: 0 });
  for (let page = 1; page <= maxPages; page++) {
    const r = await readRange(ctx, path, body, (page - 1) * PAGE, PAGE, { left: 40 });
    const list = r.items;
    if (r.skipped) {
      if (ctx.stats) ctx.stats.skipped += r.skipped;
      ctx.log(`${path} page ${page} (items ${(page - 1) * PAGE + 1}-${page * PAGE}): ${r.skipped} item(s) could not be read and were skipped — ${r.error?.message || 'unknown error'}`);
    }
    failedInARow = r.skipped >= PAGE ? failedInARow + 1 : 0;
    if (failedInARow >= 2) {
      ctx.log(`${path}: the marketplace keeps failing from item ${(page - 2) * PAGE + 1}; stopping here with ${imported} imported (partial import).`);
      break;
    }
    if (!list.length && (page > 1 || r.skipped)) { if (r.skipped >= PAGE) continue; break; }
    imported += (await onPage(list, page)) || 0;
    ctx.step.set({ done: imported, total, imported });
    if (list.length + r.skipped < PAGE) break;
  }
  return imported;
}

const countOf = async (ctx, path, body) => {
  try {
    const r = await ctx.client.post(path, body);
    return r.results?.noOfItems ?? null;
  } catch (e) {
    if (e.fatal) throw e;
    return null;
  }
};

/** Simple one-shot sources (a single read call returning everything). */
const simple = (id, label, description, path, collection, toDoc, extra = {}) => ({
  id, label, description, group: 'reference', defaultSelected: false, slow: false, pii: false, options: [], order: 50, ...extra,
  async run(ctx) {
    const { results } = await ctx.client.post(path, {});
    const docs = (Array.isArray(results) ? results : []).map(toDoc).filter(Boolean);
    if (!docs.length) {
      ctx.log(`${label}: the marketplace returned nothing — local data left untouched.`);
      return 0;
    }
    put(ctx.app.col(collection), docs, { mode: ctx.mode, first: true });
    return docs.length;
  },
});

// ------------------------------------------------------------------ categories
function toCategoryDoc(raw, lang, leafIds, detail) {
  const nm = (name) => ({ [lang]: name });
  return {
    id: raw.id,
    parent_id: raw.parent_id ?? 0,
    names: nm(raw.name),
    is_allowed: raw.is_allowed ?? 1,
    is_ean_mandatory: raw.is_ean_mandatory ? 1 : 0,
    is_warranty_mandatory: raw.is_warranty_mandatory ? 1 : 0,
    characteristics: (detail?.characteristics || []).map((ch) => ({
      id: ch.id, names: nm(ch.name), type_id: ch.type_id, display_order: ch.display_order, is_mandatory: ch.is_mandatory ? 1 : 0,
      is_filter: ch.is_filter ? 1 : 0, allow_new_value: ch.allow_new_value ? 1 : 0, values: (ch.values || []).map((v) => ({ id: v.id, names: nm(v.name) })),
    })),
    family_types: detail?.family_types || [],
    _gen: null,
    _isLeaf: leafIds.has(raw.id),
    _detail: !!detail,
    _imported: true,
  };
}

async function fetchCategoryDetail(ctx, id) {
  const per = 256;
  const first = (await ctx.client.post('/category/read', { id, valuesCurrentPage: 1, valuesPerPage: per })).results?.[0];
  if (!first) return null;
  const chars = first.characteristics || [];
  let full = new Set(chars.filter((c) => (c.values?.length || 0) >= per).map((c) => c.id));
  for (let page = 2; page <= 30 && full.size; page++) {
    const next = (await ctx.client.post('/category/read', { id, valuesCurrentPage: page, valuesPerPage: per })).results?.[0];
    const nextFull = new Set();
    for (const c of next?.characteristics || []) {
      if (!full.has(c.id) || !c.values?.length) continue;
      chars.find((x) => x.id === c.id).values.push(...c.values);
      if (c.values.length >= per) nextFull.add(c.id);
    }
    full = nextFull;
  }
  return first;
}

const categories = {
  id: 'categories',
  label: 'Categories',
  description: 'Category tree with real ids. Optionally with characteristics, allowed values and family types (needed to validate product documentation exactly like production).',
  group: 'reference', defaultSelected: true, slow: true, pii: false, order: 40,
  options: [
    {
      name: 'details', label: 'Characteristics & values for', type: 'select', default: 'used',
      options: [{ value: 'used', label: 'Categories used by my offers (recommended)' }, { value: 'allowed', label: 'All categories I may list in (slow)' }, { value: 'none', label: 'None (tree only)' }],
    },
    { name: 'maxDetails', label: 'Max. categories with details', type: 'number', default: 300, min: 1, max: 5000 },
  ],
  async run(ctx) {
    const lang = ctx.platform.lang;
    const total = await countOf(ctx, '/category/count', {});
    const raw = [];
    await paged(ctx, '/category/read', {}, { total, onPage: (list) => { raw.push(...list); return list.length; } });
    const parents = new Set(raw.map((c) => c.parent_id).filter(Boolean));
    const leafIds = new Set(raw.filter((c) => !parents.has(c.id)).map((c) => c.id));

    const wanted = new Set();
    const mode = ctx.options.details || 'used';
    const cap = clamp(ctx.options.maxDetails, 1, 5000, 300);
    if (mode === 'used') {
      for (const o of ctx.app.col('offers').all()) if (o.category_id) wanted.add(o.category_id);
      if (!wanted.size) ctx.log('No local offers to derive "used" categories from — importing the tree only (import offers in the same run, or pick another option).');
    } else if (mode === 'allowed') {
      for (const c of raw) if (leafIds.has(c.id) && c.is_allowed) wanted.add(c.id);
    }
    const ids = [...wanted].filter((id) => raw.some((c) => c.id === id)).slice(0, cap);
    if (wanted.size > ids.length) ctx.log(`Details limited to ${ids.length} of ${wanted.size} categories (maxDetails).`);

    const details = new Map();
    ctx.step.set({ message: `Fetching details for ${ids.length} categories…` });
    let n = 0;
    for (const id of ids) {
      try {
        details.set(id, await fetchCategoryDetail(ctx, id));
      } catch (e) {
        if (e.fatal) throw e;
        if (ctx.stats) ctx.stats.skipped += 1;
        ctx.log(`Category ${id}: details could not be read (${e.message}); imported without characteristics.`);
      }
      ctx.step.set({ done: ++n, total: ids.length, message: `Details ${n}/${ids.length}` });
    }

    const col = ctx.app.col('categories');
    const docs = raw.map((r) => {
      const doc = toCategoryDoc(r, lang, leafIds, details.get(r.id));
      if (!doc._detail && ctx.mode === 'merge') {
        const old = col.get(r.id);
        if (old?._detail) { doc.characteristics = old.characteristics; doc.family_types = old.family_types; doc._detail = true; }
      }
      return doc;
    });
    put(col, docs, { mode: ctx.mode, first: true });
    if (ctx.mode === 'replace') {
      const known = new Set(docs.map((d) => d.id));
      const orphans = ctx.app.col('offers').filter((o) => o.category_id && !known.has(o.category_id)).length;
      if (orphans) ctx.log(`${orphans} local offer(s) reference categories that do not exist in the real tree (e.g. dummy-generated ones).`);
    }
    ctx.step.set({ imported: docs.length });
    return docs.length;
  },
};

// ---------------------------------------------------------------------- offers
const offers = {
  id: 'offers',
  label: 'My products & offers',
  description: 'Your own offers with the documentation you sent (name, brand, images, characteristics, EAN, prices, stock, validation status). Also feeds the dummy catalogue so attach-by-EAN / part_number_key works with real codes.',
  group: 'catalog', defaultSelected: true, slow: true, pii: false, order: 20,
  options: [{ name: 'maxOffers', label: 'Max. offers', type: 'number', default: 5000, min: 1, max: 100000 }],
  async run(ctx) {
    const cap = clamp(ctx.options.maxOffers, 1, 100000, 5000);
    const total = await countOf(ctx, '/product_offer/count', {});
    const col = ctx.app.col('offers');
    const cat = ctx.app.col('catalogue');
    let first = true;
    let seen = 0;
    return paged(ctx, '/product_offer/read', {}, {
      total: total === null ? null : Math.min(total, cap),
      maxPages: Math.ceil(cap / PAGE),
      onPage(list) {
        const docs = list.filter((o) => o?.id != null).slice(0, cap - seen).map((o) => ({ ...o, _imported: true }));
        seen += docs.length;
        put(col, docs, { mode: ctx.mode, first });
        first = false;
        for (const o of docs) {
          if (o.part_number_key && !cat.has(o.part_number_key)) {
            cat.insert({
              part_number_key: o.part_number_key, name: o.name, brand: o.brand, category_id: o.category_id,
              category_name: ctx.app.col('categories').get(o.category_id)?.names?.en, part_number: o.part_number,
              ean: o.ean || [], hotness: 'Regular', product_image: o.images?.[0]?.url || null, _imported: true,
            });
          }
        }
        return docs.length;
      },
    });
  },
};

/** Pulls category ids out of whatever shape campaign_categories/read answers with (array, {categories: []}, map keyed by id, ids or objects). */
export function extractIds(results) {
  const idOf = (x) => (typeof x === 'number' ? x : typeof x === 'string' && /^\d+$/.test(x) ? Number(x) : x && typeof x === 'object' ? (x.id ?? x.categoryId ?? x.category_id ?? null) : null);
  const fromArray = (a) => a.map(idOf).filter((v) => Number.isInteger(Number(v)) && v !== null).map(Number);
  if (Array.isArray(results)) return fromArray(results);
  if (results && typeof results === 'object') {
    const arr = Object.values(results).find(Array.isArray);
    if (arr) return fromArray(arr);
    const objs = Object.entries(results).filter(([, v]) => v && typeof v === 'object');
    if (objs.length) return objs.map(([k, v]) => idOf(v) ?? (/^\d+$/.test(k) ? Number(k) : null)).filter((v) => v !== null);
  }
  return [];
}

/** Full category rows ({id, name, scmId, parentId, parentName, parentScmId}) when the reply carries them. */
export function extractRows(results) {
  const arr = Array.isArray(results) ? results : results && typeof results === 'object' ? Object.values(results).find(Array.isArray) : null;
  return (arr || []).filter((x) => x && typeof x === 'object' && x.id != null)
    .map((x) => ({ id: Number(x.id), scmId: x.scmId ?? null, name: x.name ?? null, parentId: x.parentId ?? null, parentScmId: x.parentScmId ?? null, parentName: x.parentName ?? null }));
}

/** Structure only (never values) so a failure can be reported without leaking data. */
const describeShape = (v) => (Array.isArray(v) ? `array[${v.length}]` : v && typeof v === 'object' ? `object{${Object.keys(v).slice(0, 8).join(',')}}` : typeof v);

async function readCampaignCategoryIds(ctx, campaignId, { sampleOnce = false, onPage } = {}) {
  const ids = new Set();
  const rows = new Map();
  let shape = 'no response';
  let pages = 0;
  for (let page = 1; page <= 300; page++) {
    const { results } = await ctx.client.post('/campaign_categories/read', { campaignId, currentPage: page, itemsPerPage: PAGE });
    pages = page;
    shape = describeShape(results);
    const got = extractIds(results);
    if (page === 1 && (sampleOnce || !got.length)) {
      // category data is not personal: print the raw reply (first campaign always, any unrecognised one) so a new shape can be reported and supported
      console.log(`[import:debug] POST /campaign_categories/read {campaignId: ${campaignId}} -> ${got.length ? `${got.length} ids recognised` : 'UNRECOGNISED response'}, shape ${shape} (first 2000 chars):\n${JSON.stringify(results)?.slice(0, 2000)}`);
    }
    const before = ids.size;
    got.forEach((id) => ids.add(id));
    extractRows(results).forEach((r) => rows.set(r.id, r));
    onPage?.(page, ids.size);
    if (got.length < PAGE) break; // last page
    if (ids.size === before) break; // the API ignored the page number and repeated itself: nothing new, stop
  }
  return { ids: [...ids], rows: [...rows.values()], shape, pages };
}

// ------------------------------------------------------------------- campaigns
const campaigns = {
  id: 'campaigns',
  label: 'Campaigns',
  description: 'Campaigns with their participation rules and real campaign ids (for testing proposals). Restricted-category lists are fetched on a best-effort basis.',
  group: 'catalog', defaultSelected: false, slow: false, pii: false, order: 60,
  options: [
    { name: 'onlyActive', label: 'Only active campaigns', type: 'boolean', default: true },
    { name: 'fetchCategories', label: 'Fetch the eligible-category lists of restricted campaigns (slow: one request per 100 categories, per campaign)', type: 'boolean', default: true },
  ],
  async run(ctx) {
    const col = ctx.app.col('campaigns');
    const raw = [];
    await paged(ctx, '/campaigns/read', ctx.options.onlyActive === false ? {} : { status: 1 }, { onPage: (list) => { raw.push(...list); return list.length; } });
    const docs = [];
    let sampledOne = false;
    const fetchCats = ctx.options.fetchCategories !== false;
    const restricted = raw.filter((c) => c.participationRules?.restrictedCategories);
    ctx.log(`${raw.length} campaigns read, ${restricted.length} with restricted categories${fetchCats ? '' : ' (category lists skipped)'}`);
    let doneCamps = 0;
    ctx.step.set({ done: 0, total: fetchCats ? restricted.length : raw.length, message: 'Reading eligible categories…' });
    for (const c of raw) {
      let ids = [];
      let rows = [];
      let unknown = false;
      if (c.participationRules?.restrictedCategories && !fetchCats) {
        unknown = true; // lists not fetched: treated as "all categories eligible" by the dummy
      } else if (c.participationRules?.restrictedCategories) {
        try {
          const r = await readCampaignCategoryIds(ctx, c.id, {
            sampleOnce: !sampledOne,
            onPage: (page, total) => ctx.step.set({ message: `Campaign ${c.id} (${doneCamps + 1}/${restricted.length}): page ${page}, ${total} categories` }),
          });
          sampledOne = true;
          ids = r.ids;
          rows = r.rows;
          ctx.log(`Campaign ${c.id}: ${ids.length} eligible categories (${r.pages} page${r.pages === 1 ? '' : 's'})`);
          if (!ids.length) {
            unknown = true;
            ctx.log(`Campaign ${c.id}: could not extract eligible categories from the response (${r.shape}); the dummy will treat every category as eligible for it.`);
          }
        } catch (e) {
          if (e.fatal) throw e;
          unknown = true;
          ctx.log(`Campaign ${c.id}: eligible categories could not be read (${e.message}); the dummy will treat every category as eligible for it.`);
        }
      }
      if (c.participationRules?.restrictedCategories && fetchCats) ctx.step.set({ done: ++doneCamps });
      docs.push({ ...c, _categories: ids, ...(rows.length === ids.length && rows.every((x) => x.name) ? { _categoryRows: rows } : {}), ...(unknown ? { _categoriesUnknown: true } : {}), _imported: true });
    }
    put(col, docs, { mode: ctx.mode, first: true });
    return docs.length;
  },
};

// ------------------------------------------------------------------ operations
const dateWindow = (days) => {
  const before = new Date();
  return { after: fmtDateTime(new Date(before.getTime() - days * 864e5)), before: fmtDateTime(before) };
};

const orders = {
  id: 'orders',
  label: 'Orders',
  description: 'Recent orders (read only). Useful to test your order sync against real shapes and edge cases.',
  group: 'operations', defaultSelected: false, slow: true, pii: true, order: 70,
  options: [
    { name: 'days', label: 'Created in the last N days', type: 'number', default: 30, min: 1, max: 30 },
    { name: 'type', label: 'Fulfilled by', type: 'select', default: '3', options: [{ value: '3', label: 'Seller (3)' }, { value: '2', label: 'eMAG (2)' }] },
    { name: 'status', label: 'Status', type: 'select', default: 'any', options: [{ value: 'any', label: 'Any' }, { value: '1', label: '1 - New' }, { value: '2', label: '2 - In progress' }, { value: '3', label: '3 - Prepared' }, { value: '4', label: '4 - Finalized' }, { value: '0', label: '0 - Canceled' }, { value: '5', label: '5 - Returned' }] },
    { name: 'anonymize', label: 'Replace customer personal data with fake data (strongly recommended)', type: 'boolean', default: true },
    { name: 'maxOrders', label: 'Max. orders', type: 'number', default: 2000, min: 1, max: 20000 },
  ],
  async run(ctx) {
    const days = clamp(ctx.options.days, 1, 30, 30);
    const { after, before } = dateWindow(days);
    const filter = {
      createdAfter: after, createdBefore: before, type: Number(ctx.options.type || 3),
      ...(ctx.options.status && ctx.options.status !== 'any' ? { status: Number(ctx.options.status) } : {}),
    };
    const cap = clamp(ctx.options.maxOrders, 1, 20000, 2000);
    const total = await countOf(ctx, '/order/count', filter);
    const anonymize = ctx.options.anonymize !== false;
    if (!anonymize) ctx.log('WARNING: customer personal data is being stored unmodified in the local database.');
    const col = ctx.app.col('orders');
    let first = true;
    let seen = 0;
    return paged(ctx, '/order/read', filter, {
      total: total === null ? null : Math.min(total, cap), maxPages: Math.ceil(cap / PAGE),
      onPage(list) {
        const docs = list.filter((o) => o?.id != null).slice(0, cap - seen).map((o) => (anonymize ? ctx.anonymizer.order(o) : o));
        seen += docs.length;
        put(col, docs.map((o) => ({ ...o, _imported: true })), { mode: ctx.mode, first });
        first = false;
        return docs.length;
      },
    });
  },
};

const rmas = {
  id: 'rmas',
  label: 'Return requests (RMA)',
  description: 'Recent return requests (read only).',
  group: 'operations', defaultSelected: false, slow: false, pii: true, order: 80,
  options: [
    { name: 'days', label: 'Created in the last N days', type: 'number', default: 90, min: 1, max: 365 },
    { name: 'anonymize', label: 'Replace customer personal data with fake data (strongly recommended)', type: 'boolean', default: true },
  ],
  async run(ctx) {
    const days = clamp(ctx.options.days, 1, 365, 90);
    const { after, before } = dateWindow(days);
    const anonymize = ctx.options.anonymize !== false;
    if (!anonymize) ctx.log('WARNING: customer personal data is being stored unmodified in the local database.');
    const col = ctx.app.col('rmas');
    let first = true;
    return paged(ctx, '/rma/read', { date_start: after, date_end: before }, {
      onPage(list) {
        const docs = list.filter((r) => r?.emag_id != null).map((r) => ({ ...(anonymize ? ctx.anonymizer.rma(r) : r), _imported: true }));
        put(col, docs, { mode: ctx.mode, first });
        first = false;
        return docs.length;
      },
    });
  },
};

const localities = {
  id: 'localities',
  label: 'Localities',
  description: 'Real locality ids / zip codes for AWB issuing (platform country by default). A lot of data: expect a few minutes at the API rate limit.',
  group: 'reference', defaultSelected: false, slow: true, pii: false, order: 45,
  options: [
    { name: 'country', label: 'Country', type: 'select', default: 'platform', options: [{ value: 'platform', label: 'Platform country' }, { value: 'RO', label: 'RO' }, { value: 'BG', label: 'BG' }, { value: 'HU', label: 'HU' }] },
    { name: 'maxPages', label: 'Max. pages (100 localities each)', type: 'number', default: 400, min: 1, max: 2000 },
  ],
  async run(ctx) {
    const filter = ctx.options.country && ctx.options.country !== 'platform' ? { country_code: ctx.options.country } : {};
    const total = await countOf(ctx, '/locality/count', {});
    const col = ctx.app.col('localities');
    let first = true;
    return paged(ctx, '/locality/read', filter, {
      total, maxPages: clamp(ctx.options.maxPages, 1, 2000, 400),
      onPage(list) {
        const docs = list.filter((l) => l?.emag_id != null);
        put(col, docs, { mode: ctx.mode, first });
        first = false;
        return docs.length;
      },
    });
  },
};

export const SOURCES = [
  simple('vat', 'VAT rates', 'Real vat_id values (needed in every product save).', '/vat/read', 'vat_rates', (r) => ((r.vat_id ?? r.id) == null ? null : { ...r, vat_id: r.vat_id ?? r.id, status: r.status ?? 'active' }), { defaultSelected: true, order: 10 }),
  simple('handling_time', 'Handling time values', 'Allowed handling-time values.', '/handling_time/read', 'handling_times', (r, i) => ({ ...r, id: r.id ?? r.value ?? i }), { defaultSelected: true, order: 11 }),
  offers,
  categories,
  simple('courier_accounts', 'Courier accounts', 'Your courier accounts (ids used on awb/save).', '/courier_accounts/read', 'courier_accounts', (r) => (r.account_id == null ? null : r), { order: 41 }),
  simple('addresses', 'Pickup / return addresses', 'Your saved addresses (address_id used on awb/save).', '/addresses/read', 'addresses', (r) => (r.address_id == null ? null : { ...r, address_id: String(r.address_id) }), { order: 42 }),
  simple('awb_packages', 'Predefined AWB packages', 'Your predefined package sizes.', '/awb/package/read', 'awb_packages', (r) => (r.label == null ? null : r), { order: 43 }),
  localities,
  campaigns,
  orders,
  rmas,
].sort((a, b) => a.order - b.order);

export const sourceById = (id) => SOURCES.find((s) => s.id === id);

/** What the UI needs to render the form. */
export const describeSources = () => SOURCES.map(({ id, label, description, group, defaultSelected, slow, pii, options }) => ({ id, label, description, group, defaultSelected, slow, pii, options }));
