import { ok, fail, countResults, paginate } from '../../core/response.js';
import { buildCategoryDocs, handlingTimeDocs, presentCategory, vatDocs } from './service.js';

const LANGS = ['EN', 'RO', 'HU', 'BG', 'PL', 'GR', 'DE'];

const readSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', minimum: 1 },
    currentPage: { type: 'integer', minimum: 1 },
    itemsPerPage: { type: 'integer', minimum: 1, maximum: 100 },
    valuesCurrentPage: { type: 'integer', minimum: 1 },
    valuesPerPage: { type: 'integer', minimum: 1 },
  },
};

function language(c) {
  const q = c.query.language;
  if (q === undefined) return c.platform.id === 'ro' ? 'ro' : 'en';
  const up = String(q).toUpperCase();
  if (!LANGS.includes(up)) return null;
  return up === 'RO' ? 'ro' : 'en'; // dummy only ships EN + RO names
}

const mod = {
  id: 'categories',
  title: 'Categories',
  description: 'Reference data: categories with characteristics & family types, VAT rates and handling-time values. Read-only through the API; regenerate it here.',
  collections: [
    { name: 'categories', label: 'Categories', columns: ['id', 'names', 'parent_id', 'is_ean_mandatory', 'is_warranty_mandatory'] },
    { name: 'vat_rates', label: 'VAT rates', idField: 'vat_id', columns: ['vat_id', 'vat_rate', 'status'] },
    { name: 'handling_times', label: 'Handling times', columns: ['id', 'value'] },
  ],

  routes: [
    {
      method: 'POST', path: '/category/read', name: 'category/read', summary: 'Read categories', body: readSchema, readFilter: true,
      query: { type: 'object', properties: { language: { type: 'string' } } },
      handler(c) {
        const lang = language(c);
        if (!lang) return fail(`language: must be one of ${LANGS.join(', ')}`);
        const { id, currentPage = 1, itemsPerPage = 100, valuesCurrentPage = 1, valuesPerPage = 256 } = c.body;
        const cats = c.col('categories');
        if (id) {
          const doc = cats.get(id);
          if (!doc) return fail(`Category ${id} not found`);
          return ok([presentCategory(doc, { lang, full: true, valuesPage: valuesCurrentPage, valuesPerPage })]);
        }
        const page = paginate(cats.all(), { currentPage, itemsPerPage });
        return ok(page.map((d) => presentCategory(d, { lang })));
      },
    },
    {
      method: 'POST', path: '/category/count', name: 'category/count', summary: 'Count categories',
      handler(c) {
        return ok(countResults(c.col('categories').size, 100));
      },
    },
    {
      method: 'POST', path: '/vat/read', name: 'vat/read', summary: 'Read VAT rates',
      handler: (c) => ok(c.col('vat_rates').all()),
    },
    {
      method: 'POST', path: '/handling_time/read', name: 'handling_time/read', summary: 'Read handling time values',
      handler: (c) => ok(c.col('handling_times').all()),
    },
  ],

  generators: [
    {
      id: 'reseed',
      label: 'Reset reference data',
      description: 'Re-creates the dummy categories (with characteristics), VAT rates and handling times. Existing offers keep their ids.',
      params: [],
      run(app) {
        mod.seed(app);
        return { message: 'Reference data re-created', created: app.col('categories').size };
      },
    },
  ],

  seed(app) {
    app.col('categories').clear();
    app.col('categories').insertMany(buildCategoryDocs());
    app.col('vat_rates').clear();
    app.col('vat_rates').insertMany(vatDocs());
    app.col('handling_times').clear();
    app.col('handling_times').insertMany(handlingTimeDocs());
  },
};

export default mod;
