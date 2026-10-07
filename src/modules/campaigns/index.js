import { ok, fail, paginate, ApiError } from '../../core/response.js';
import { rnd, isoOffset, addDays, fmtDateTime, hashInt, round, publicView } from '../../core/util.js';
import { approve, buildOfferPayload, nextOfferId, saveProductOffer } from '../products/service.js';

const CAMPAIGN_TYPES = { 1: 'Black Friday', 2: 'Discount', 3: 'Voucher', 4: 'Multi deals' };
const NAMES = {
  1: ['Black Friday', 'Black Friday Early Access', 'Cyber Week'],
  2: ['Genius Days', 'Spring Sale', 'Summer Deals', 'Back to School'],
  3: ['Voucher Weekend', 'Free shipping voucher'],
  4: ['Multi Deals Autumn', 'Multi Deals Winter'],
};

const inCategory = (camp, categoryId) => !camp.participationRules.restrictedCategories || camp._categoriesUnknown || camp._categories.includes(categoryId);

function offerEligibility(app, camp, offer) {
  const r = camp.participationRules;
  const reasons = [];
  if (offer.status !== 1) reasons.push('offer is not active');
  if (!offer.part_number_key) reasons.push('offer is not attached to an approved product');
  if (r.minStock != null && offer.general_stock < r.minStock) reasons.push(`stock must be at least ${r.minStock}`);
  if (r.maxHandlingTime != null && (offer.handling_time?.[0]?.value ?? 0) > r.maxHandlingTime) reasons.push(`handling time must be at most ${r.maxHandlingTime} days`);
  if (r.minOfferPrice != null && offer.sale_price < r.minOfferPrice) reasons.push(`price must be at least ${r.minOfferPrice}`);
  if (r.maxOfferPrice != null && offer.sale_price > r.maxOfferPrice) reasons.push(`price must be at most ${r.maxOfferPrice}`);
  if (r.geniusOffersOnly && offer.emag_club !== 1) reasons.push('only Genius (emag_club=1) offers are accepted');
  if (!inCategory(camp, offer.category_id)) reasons.push('category is not eligible for this campaign');
  return reasons;
}

// eMAG financial support tiers ({emag_support_pct, min_discount_pct}); the real API answers `emag_support: []` for offers without support
const SUPPORT_TIERS = [
  [[30, 15]],
  [[30, 15], [50, 25]],
  [[20, 10], [35, 20], [50, 30]],
];

function supportTiers(camp, offer) {
  const tiers = SUPPORT_TIERS[hashInt(`t${camp.id}:${offer.id}`) % SUPPORT_TIERS.length];
  return tiers.map(([pct, minDiscount]) => ({ emag_support_pct: pct, min_discount_pct: minDiscount, emag_support_value: round(offer.sale_price * (minDiscount / 100) * (pct / 100), 2) }));
}

/** Explicit choice stored on the campaign (`_emagSupport[offerId]`, set by the generators / row actions), otherwise a stable ~50/50 split. */
function hasSupport(camp, offer) {
  const set = camp._emagSupport?.[offer.id];
  return set !== undefined ? set : hashInt(`s${camp.id}:${offer.id}`) % 2 === 0;
}

function setSupport(app, camp, offerIds, value) {
  camp._emagSupport = { ...camp._emagSupport };
  for (const id of offerIds) camp._emagSupport[id] = value;
  app.col('campaigns').touch();
}

/** Gives eMAG support to about half of `offers` and none to the rest — always at least one of each when there are two or more. */
function splitSupport(app, camp, offers) {
  if (!offers.length) return { withSupport: 0, withoutSupport: 0 };
  const shuffled = rnd.sample(offers, offers.length);
  const n = offers.length === 1 ? Number(rnd.chance()) : Math.min(offers.length - 1, Math.max(1, Math.round(offers.length / 2)));
  setSupport(app, camp, shuffled.slice(0, n).map((o) => o.id), true);
  setSupport(app, camp, shuffled.slice(n).map((o) => o.id), false);
  return { withSupport: n, withoutSupport: offers.length - n };
}

/** Creates (through product_offer/save) an approved offer that satisfies the campaign's participation rules; null if impossible. */
function createEligibleOffer(app, camp) {
  const r = camp.participationRules;
  let cats = app.col('categories').filter((c) => c._isLeaf);
  if (r.restrictedCategories && !camp._categoriesUnknown) cats = cats.filter((c) => camp._categories.includes(c.id));
  if (!cats.length) return null;
  const payload = buildOfferPayload(app, rnd.pick(cats), { id: nextOfferId(app) });
  let price = payload.sale_price;
  const lo = r.minOfferPrice ?? 0;
  const hi = r.maxOfferPrice ?? Infinity;
  if (price < lo || price > hi) price = round(Number.isFinite(hi) ? rnd.float(Math.max(lo, 10), hi) : lo * rnd.float(1.1, 3), 4);
  Object.assign(payload, {
    status: 1,
    sale_price: price,
    min_sale_price: round(price * 0.8, 4),
    max_sale_price: round(price * 1.4, 4),
    recommended_price: round(price * rnd.float(1.1, 1.3, 2), 4),
    stock: [{ warehouse_id: 1, value: (r.minStock ?? 1) + rnd.int(5, 80) }],
    handling_time: [{ warehouse_id: 1, value: rnd.int(0, Math.min(r.maxHandlingTime ?? 2, 2)) }],
    emag_club: r.geniusOffersOnly ? 1 : payload.emag_club,
  });
  const saved = saveProductOffer(app, payload, { strict: false });
  if (!saved.doc) return null;
  approve(app, saved.doc, { silent: true });
  return offerEligibility(app, camp, saved.doc).length ? null : saved.doc;
}

const eligibleOffersOf = (app, camp) => app.col('offers').filter((o) => offerEligibility(app, camp, o).length === 0).sort((a, b) => a.id - b.id);

/** Tops the campaign up to `min` eligible offers, then splits eMAG support between them (new offers only, unless `all`). */
function seedEligibleOffers(app, camp, { min, extra = 0, all = false }) {
  const before = new Set(eligibleOffersOf(app, camp).map((o) => o.id));
  const created = [];
  const want = Math.max(extra, min - before.size);
  for (let tries = 0; created.length < want && tries < want * 3; tries++) {
    const doc = createEligibleOffer(app, camp);
    if (doc) created.push(doc);
  }
  const offers = all ? eligibleOffersOf(app, camp) : created;
  return { created: created.length, ...splitSupport(app, camp, offers) };
}

function eligibleOffer(app, camp, offer) {
  const discountType = camp.type === 1 || camp.type === 2;
  const cmmp = round(offer.sale_price * 0.95, 4);
  return {
    product_name: offer.name,
    category: offer.category_id,
    brand: offer.brand,
    pnk: offer.part_number_key,
    product_code: offer.part_number,
    ext_id: offer.id,
    max_product_performance: 1 + (hashInt(offer.part_number_key) % 5),
    current_price: offer.sale_price,
    cmmp: discountType ? cmmp : null,
    max_campaign_price: discountType ? offer.sale_price : null,
    current_stock: offer.general_stock,
    current_commission_no_discount: 5 + (hashInt(`c${offer.id}`) % 12) + 0.5,
    emag_support: hasSupport(camp, offer) ? supportTiers(camp, offer) : [],
    campaign_id: camp.id,
    campaign_type: discountType ? 'discount' : 'voucher',
  };
}

function buildCampaign(app, kind) {
  const type = rnd.weighted([[1, 25], [2, 40], [3, 20], [4, 15]]);
  const now = new Date();
  const [start, end, prep] = {
    live: [addDays(now, -5), addDays(now, 20), addDays(now, -6)],
    upcoming: [addDays(now, rnd.int(8, 20)), addDays(now, rnd.int(25, 40)), addDays(now, rnd.int(3, 6))],
    past: [addDays(now, -40), addDays(now, -20), addDays(now, -41)],
  }[kind];
  const restricted = rnd.chance(0.3);
  const leaves = app.col('categories').filter((c) => c._isLeaf);
  return {
    id: app.store.nextId('campaigns'),
    name: `${rnd.pick(NAMES[type])} ${now.getFullYear()}`,
    startDate: isoOffset(start),
    endDate: isoOffset(end),
    endPreparationDate: isoOffset(prep),
    status: kind === 'past' ? 0 : 1,
    type,
    participationRules: {
      minAllowedDiscount: 'min. 5% or 50 RON from CMMP depending on category',
      restrictedCategories: restricted,
      geniusOffersOnly: rnd.chance(0.2),
      minStock: rnd.pick([5, 10, 10, null]),
      maxHandlingTime: rnd.pick([2, 3, 5, null]),
      minOfferPrice: rnd.pick([20, 50, null]),
      maxOfferPrice: rnd.pick([2000, 5000, null]),
    },
    _categories: restricted ? rnd.sample(leaves, rnd.int(3, 6)).map((c) => c.id) : [],
  };
}

const iso = (s) => Date.parse(s);

const mod = {
  id: 'campaigns',
  title: 'Campaigns',
  description: 'Campaigns, eligible categories/offers, proposals (campaign_proposals/save), Smart Deals price check and offer badge timelines.',
  collections: [
    { name: 'campaigns', label: 'Campaigns', startAt: 2100, columns: ['id', 'name', 'type', 'status', 'startDate', 'endDate', 'endPreparationDate'] },
    { name: 'campaign_proposals', label: 'Proposals', idField: 'proposal_id', columns: ['proposal_id', 'id', 'campaign_id', 'sale_price', 'stock', 'voucher_discount', 'created'] },
  ],

  views: [
    {
      name: 'campaign_eligible_offers',
      label: 'Eligible offers',
      idField: 'key',
      dependsOn: ['offers', 'campaigns'],
      description: 'Computed live, exactly as campaigns/{campaign_id}/eligible-offers answers (campaigns that have not ended).',
      columns: ['campaign_id', 'ext_id', { path: 'has_emag_support', label: 'eMAG support' }, 'product_name', 'current_price', 'max_campaign_price', 'current_stock', 'emag_support'],
      list(app) {
        const now = Date.now();
        const rows = [];
        for (const camp of app.col('campaigns').filter((x) => iso(x.endDate) > now).sort((a, b) => a.id - b.id)) {
          for (const o of eligibleOffersOf(app, camp)) {
            const e = eligibleOffer(app, camp, o);
            rows.push({ key: `${camp.id}-${o.id}`, has_emag_support: e.emag_support.length > 0, ...e });
          }
        }
        return rows;
      },
    },
  ],

  routes: [
    {
      method: 'POST', path: '/campaigns/read', name: 'campaigns/read', summary: 'Read campaigns', body: 'CampaignReadFilter', readFilter: true,
      handler(c) {
        const f = c.body;
        const list = c.col('campaigns').filter((x) => (f.id === undefined || f.id.includes(x.id))
          && (f.name === undefined || x.name.toLowerCase().includes(f.name.toLowerCase()))
          && (f.status === undefined || x.status === f.status)
          && (f.campaignType === undefined || x.type === f.campaignType)
          && (f.startDate === undefined || x.startDate.startsWith(f.startDate))
          && (f.endDate === undefined || x.endDate.startsWith(f.endDate)));
        return ok(publicView(paginate(list, f)));
      },
    },
    {
      method: 'POST', path: '/campaign_categories/read', name: 'campaign_categories/read', summary: 'Read eligible categories for a campaign', body: 'Pagination', readFilter: true,
      handler(c) {
        const id = c.body.campaignId ?? c.body.campaign_id;
        if (id === undefined && c.settings.strictRules) {
          // observed on the real API: the key is camelCase and mandatory, answered with HTTP 400 and `messages` as an object
          throw new ApiError(400, [], { isError: true, messages: { campaignId: 'campaignId cannot be empty' }, results: [] });
        }
        const cats = c.col('categories');
        const camps = id !== undefined ? [c.col('campaigns').get(id)].filter(Boolean) : c.col('campaigns').all();
        if (id !== undefined && !camps.length) return fail(`Campaign ${id} not found`);
        const rows = new Map();
        for (const camp of camps.filter((x) => x.participationRules.restrictedCategories)) {
          if (camp._categoryRows) { camp._categoryRows.forEach((r) => rows.set(r.id, r)); continue; } // imported verbatim from the real API
          for (const cid of camp._categories) {
            const cat = cats.get(cid);
            if (!cat) continue;
            const parent = cats.get(cat.parent_id);
            const nm = (x) => x.names.en || Object.values(x.names)[0];
            rows.set(cid, { id: cat.id, scmId: cat.id + 10000, name: nm(cat), parentId: cat.parent_id, parentScmId: cat.parent_id + 10000, parentName: parent ? nm(parent) : null });
          }
        }
        return ok(paginate([...rows.values()], c.body));
      },
    },
    {
      method: 'GET', path: '/campaigns/:campaign_id/eligible-offers', name: 'campaigns/{campaign_id}/eligible-offers', summary: 'Read eligible offers for a campaign',
      query: { type: 'object', properties: { pageSize: { type: 'integer', minimum: 1, maximum: 100 }, lastId: { type: 'integer' } } },
      handler(c) {
        const camp = c.col('campaigns').get(c.params.campaign_id);
        if (!camp) return fail(`Campaign ${c.params.campaign_id} not found`);
        const pageSize = c.query.pageSize ?? 50;
        const lastId = c.query.lastId ?? 0;
        const all = eligibleOffersOf(c.app, camp).filter((o) => o.id > lastId);
        const page = all.slice(0, pageSize);
        const more = all.length > pageSize;
        const host = c.req.headers.host || 'localhost';
        const next = more ? `http://${host}/api-3/campaigns/${camp.id}/eligible-offers?pageSize=${pageSize}&lastId=${page.at(-1).id}` : null;
        return { isError: false, messages: [], results: page.map((o) => eligibleOffer(c.app, camp, o)), next };
      },
    },
    {
      method: 'POST', path: '/campaign_proposals/save', name: 'campaign_proposals/save', summary: 'Save campaign proposals', items: { schema: 'CampaignProposal', max: 50 },
      handler(c) {
        const messages = [];
        let isError = false;
        const props = c.col('campaign_proposals');
        for (const it of c.items) {
          if (it.errors.length) { messages.push(...it.errors); isError = true; continue; }
          const v = it.value;
          const tag = `[offer ${v.id} / campaign ${v.campaign_id}]`;
          const errors = [];
          const camp = c.col('campaigns').get(v.campaign_id);
          const offer = c.col('offers').get(v.id);
          if (!camp) errors.push(`${tag} campaign_id: campaign not found`);
          if (!offer) errors.push(`${tag} id: offer not found`);
          if (camp && offer && c.settings.strictRules) {
            if (camp.status !== 1) errors.push(`${tag} the campaign is not active`);
            if (Date.now() > iso(camp.endPreparationDate)) errors.push(`${tag} the deadline for submitting offers has passed (${camp.endPreparationDate})`);
            errors.push(...offerEligibility(c.app, camp, { ...offer, general_stock: v.stock ?? offer.general_stock }).map((r) => `${tag} ${r}`));
            if ((camp.type === 1 || camp.type === 2) && v.sale_price > offer.sale_price) errors.push(`${tag} sale_price: must not exceed the current offer price (${offer.sale_price})`);
            if (camp.type === 3 && v.voucher_discount === undefined) errors.push(`${tag} voucher_discount: required for voucher campaigns`);
            if (camp.type === 4) {
              if (!v.date_intervals?.length) errors.push(`${tag} date_intervals: required for Multi deals campaigns`);
              else {
                const idx = v.date_intervals.map((d) => d.index);
                if (new Set(idx).size !== idx.length) errors.push(`${tag} date_intervals: index values must be unique`);
                for (const [n, d] of v.date_intervals.entries()) {
                  for (const k of ['start_date', 'end_date']) if (!d[k]?.date) errors.push(`${tag} date_intervals[${n}].${k}.date: required`);
                  if (d.voucher_discount === undefined) errors.push(`${tag} date_intervals[${n}].voucher_discount: required`);
                  if (d.index === undefined) errors.push(`${tag} date_intervals[${n}].index: required`);
                }
              }
            }
          }
          if (errors.length) { messages.push(...errors); isError = true; continue; }
          for (const old of props.filter((p) => p.id === v.id && p.campaign_id === v.campaign_id)) props.remove(old.proposal_id);
          props.insert({ ...v, status: 'accepted', created: fmtDateTime() });
        }
        return { isError, messages, results: [] };
      },
    },
    {
      method: 'GET', path: '/smart-deals-price-check', name: 'smart-deals-price-check', summary: 'Smart Deals price check',
      query: { type: 'object', required: ['productId'], properties: { productId: { type: 'integer' } } },
      handler(c) {
        const o = c.col('offers').get(c.query.productId);
        if (!o) return fail(`Offer ${c.query.productId} not found`);
        const target = round(o.sale_price * 0.92, 4);
        return ok([{ productId: o.id, current_price: o.sale_price, target_price: target, currency: c.app.currency(), qualifies: o.sale_price <= target }]);
      },
    },
    {
      method: 'GET', path: '/offers/:extId/campaign_product_badge_timeline', name: 'offers/{extId}/campaign_product_badge_timeline', summary: 'Read campaign product badge timeline',
      handler(c) {
        const id = Number(c.params.extId);
        const results = [];
        for (const p of c.col('campaign_proposals').filter((x) => x.id === id)) {
          const camp = c.col('campaigns').get(p.campaign_id);
          if (!camp || iso(camp.endDate) < Date.now()) continue;
          results.push({ id: camp.id, name: camp.name, labelText: CAMPAIGN_TYPES[camp.type] === 'Black Friday' ? 'Black Friday' : camp.name, startDate: camp.startDate, endDate: camp.endDate });
        }
        return ok(results);
      },
    },
  ],

  generators: [
    {
      id: 'campaigns',
      label: 'Campaigns',
      description: 'Creates one live, one past and several upcoming campaigns (only upcoming ones still accept proposals). Live / upcoming ones get eligible offers, some with eMAG support and some without.',
      params: [
        { name: 'upcoming', label: 'Upcoming campaigns', type: 'number', default: 3, min: 0, max: 20 },
        { name: 'eligible', label: 'Eligible offers per campaign (at least)', type: 'number', default: 6, min: 0, max: 50 },
      ],
      run(app, p) {
        const docs = [buildCampaign(app, 'live'), buildCampaign(app, 'past')];
        for (let i = 0; i < Math.min(Number(p.upcoming ?? 3), 20); i++) docs.push(buildCampaign(app, 'upcoming'));
        app.col('campaigns').insertMany(docs);
        const min = Math.min(Math.max(Number(p.eligible ?? 6) || 0, 0), 50);
        let offers = 0; let withSupport = 0; let withoutSupport = 0;
        for (const camp of docs.filter((d) => d.status === 1)) {
          const r = seedEligibleOffers(app, camp, { min, all: true });
          offers += r.created; withSupport += r.withSupport; withoutSupport += r.withoutSupport;
        }
        app.col('offers').touch();
        return { message: `Created ${docs.length} campaigns${offers ? ` and ${offers} offers` : ''}; eligible offers: ${withSupport} with eMAG support, ${withoutSupport} without`, created: docs.length };
      },
    },
    {
      id: 'eligible_offers',
      label: 'Eligible offers',
      description: 'Creates new offers that satisfy a campaign\'s participation rules, half of them with eMAG support and half without. Works for imported campaigns too.',
      params: [
        { name: 'campaign_id', label: 'Campaign id (empty = every live / upcoming campaign)', type: 'text', default: '' },
        { name: 'count', label: 'New offers per campaign', type: 'number', default: 6, min: 1, max: 50 },
      ],
      run(app, p) {
        const now = Date.now();
        const id = String(p.campaign_id ?? '').trim();
        const camps = id ? [app.col('campaigns').get(id)].filter(Boolean) : app.col('campaigns').filter((x) => x.status === 1 && iso(x.endDate) > now);
        if (!camps.length) return { message: id ? `Campaign ${id} not found` : 'Generate campaigns first', created: 0 };
        const count = Math.min(Math.max(Number(p.count) || 6, 1), 50);
        let created = 0; let withSupport = 0; let withoutSupport = 0; const skipped = [];
        for (const camp of camps) {
          const r = seedEligibleOffers(app, camp, { min: 0, extra: count });
          if (!r.created) skipped.push(camp.id);
          created += r.created; withSupport += r.withSupport; withoutSupport += r.withoutSupport;
        }
        app.col('offers').touch();
        const note = skipped.length ? ` (no eligible offer could be created for campaign ${skipped.join(', ')}: its eligible categories are not in the dummy category tree)` : '';
        return { message: `Created ${created} eligible offers: ${withSupport} with eMAG support, ${withoutSupport} without${note}`, created };
      },
    },
    {
      id: 'proposals',
      label: 'Offers in campaigns',
      description: 'Puts random offers into random campaigns directly (bypasses the participation rules). Offers in a live campaign get a "campaign" key on product_offer/read.',
      params: [{ name: 'count', label: 'How many', type: 'number', default: 10, min: 1, max: 200 }],
      run(app, p) {
        const camps = app.col('campaigns').filter((c) => c.status === 1);
        const offers = app.col('offers').filter((o) => o.status === 1 && o.part_number_key);
        if (!camps.length) return { message: 'Generate campaigns first', created: 0 };
        if (!offers.length) return { message: 'Generate approved offers first', created: 0 };
        let created = 0;
        for (const o of rnd.sample(offers, Math.min(Number(p.count) || 10, offers.length))) {
          const camp = rnd.pick(camps);
          const props = app.col('campaign_proposals');
          if (props.find((x) => x.id === o.id && x.campaign_id === camp.id)) continue;
          props.insert({
            id: o.id, campaign_id: camp.id, sale_price: round(o.sale_price * 0.9, 4), stock: Math.min(255, o.general_stock), max_qty_per_order: rnd.pick([2, 3, 5]),
            ...(camp.type === 3 ? { voucher_discount: rnd.pick([10, 15, 20]) } : {}), status: 'accepted', created: fmtDateTime(),
          });
          created += 1;
        }
        return { message: `Created ${created} proposals`, created };
      },
    },
  ],

  rowActions: [
    {
      id: 'support_on', label: 'Give eMAG support', collection: 'campaign_eligible_offers',
      run(app, row) { setSupport(app, app.col('campaigns').get(row.campaign_id), [row.ext_id], true); return { message: `Offer ${row.ext_id} now has eMAG support in campaign ${row.campaign_id}` }; },
    },
    {
      id: 'support_off', label: 'Remove eMAG support', collection: 'campaign_eligible_offers',
      run(app, row) { setSupport(app, app.col('campaigns').get(row.campaign_id), [row.ext_id], false); return { message: `Offer ${row.ext_id} no longer has eMAG support in campaign ${row.campaign_id}` }; },
    },
    {
      id: 'start_now', label: 'Start now (campaign goes live)', collection: 'campaigns',
      run(app, row) { row.startDate = isoOffset(addDays(new Date(), -1)); row.endDate = isoOffset(addDays(new Date(), 14)); row.status = 1; app.col('campaigns').touch(); return { message: `${row.name} is live` }; },
    },
    {
      id: 'end_now', label: 'End now', collection: 'campaigns', danger: true,
      run(app, row) { row.endDate = isoOffset(new Date(Date.now() - 60_000)); app.col('campaigns').touch(); return { message: `${row.name} ended` }; },
    },
  ],
};

export default mod;
