/**
 * Module registry — order = order in the UI sidebar.
 *
 * A module is a plain object:
 *   id, title, description
 *   collections : [{ name, label, idField='id', startAt=1, columns[] }]   -> persisted document collections
 *   routes      : [{ method, path, name, summary, rateGroup, body, items, query, readFilter, handler(c) }]
 *   generators  : [{ id, label, description, params[], run(app, params) }] -> "Generate dummy data" in the UI
 *   rowActions  : [{ id, label, collection, danger, params[], run(app, row, params) }]
 *   seed(app)   : optional reference data inserted on first start
 *   init(app)   : optional one-time wiring (timers, event subscriptions)
 *
 * To add a section, create src/modules/<name>/index.js and add it here.
 */
import products from './products/index.js';
import orders from './orders/index.js';
import shipping from './shipping/index.js';
import returns from './returns/index.js';
import categories from './categories/index.js';
import campaigns from './campaigns/index.js';
import invoices from './invoices/index.js';
import callbacks from './callbacks/index.js';

export default [products, orders, shipping, returns, categories, campaigns, invoices, callbacks];
