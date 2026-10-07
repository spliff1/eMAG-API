import fs from 'node:fs';
import path from 'node:path';
import { Store } from './core/store.js';
import { openDb } from './core/db.js';
import { loadSpec, ROOT } from './core/spec.js';
import { createSettings, PLATFORMS } from './core/settings.js';
import { createRequestLog } from './core/requestlog.js';
import { createImportManager } from './importer/manager.js';
import { bus } from './core/events.js';
import modules from './modules/index.js';

/** One-time import of the pre-SQLite JSON files (data/db.json, data/requests.json), which are then renamed. */
function migrateLegacyJson(dataDir, store, db) {
  const dbJson = path.join(dataDir, 'db.json');
  const reqJson = path.join(dataDir, 'requests.json');
  try {
    if (fs.existsSync(dbJson) && !store.collections.size) return; // collections not defined yet
    if (fs.existsSync(dbJson)) {
      const snap = JSON.parse(fs.readFileSync(dbJson, 'utf8'));
      store.restore(snap);
      if (snap.meta?.settings) Object.assign(store.meta.settings, snap.meta.settings);
      fs.renameSync(dbJson, `${dbJson}.migrated`);
      console.log('[migrate] data/db.json imported into SQLite (original kept as db.json.migrated)');
    }
    if (fs.existsSync(reqJson)) {
      const { entries = [] } = JSON.parse(fs.readFileSync(reqJson, 'utf8'));
      const ins = db.prepare(`INSERT INTO requests (ts, method, path, query, section, route, api_user, ip, req_headers, req_body, status, is_error, duration_ms, bytes, notes, messages, fault, res_body)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const j = (v) => (v === undefined ? null : JSON.stringify(v));
      db.exec('BEGIN');
      for (const e of entries) {
        ins.run(e.ts, e.method, e.path, j(e.query), e.section ?? null, e.route ?? null, e.user ?? null, e.ip ?? null, j(e.reqHeaders), j(e.reqBody), e.status ?? null, e.isError ? 1 : 0,
          e.durationMs ?? null, e.bytes ?? null, j(e.notes ?? []), j(e.messages ?? []), e.fault ?? null, j(e.resBody));
      }
      db.exec('COMMIT');
      fs.renameSync(reqJson, `${reqJson}.migrated`);
      console.log(`[migrate] ${entries.length} logged requests imported into SQLite`);
    }
  } catch (e) {
    console.warn('[migrate] legacy JSON import failed:', e.message);
    if (db.isTransaction) db.exec('ROLLBACK');
  }
}

/**
 * Assembles the application: SQLite + store + spec + settings + request log + importer + modules.
 * `persist: false` keeps everything in a private in-memory SQLite database (tests).
 */
export function createApp({ dataDir = path.join(ROOT, 'data'), persist = true, host = '127.0.0.1' } = {}) {
  const db = openDb(persist ? path.join(dataDir, 'dummy-emag.sqlite') : null);
  const store = new Store({ db });
  const spec = loadSpec();
  const log = createRequestLog({ db });

  const app = {
    db, store, spec, log, bus, modules,
    config: { dataDir, persist, host, exposed: !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host) },
    col: (name) => store.col(name),
    module: (id) => modules.find((m) => m.id === id),
    currency: () => (PLATFORMS[app.settings.get().platform] || PLATFORMS.ro).currency,
    notify: (event, payload) => bus.emit('notify', { event, payload }),
    sendTestCallback: async () => ({ ok: false, error: 'callbacks module not loaded' }),
    seedAll(force = false) {
      for (const m of modules) {
        if (!m.seed) continue;
        if (!force && store.meta.seeded[m.id]) continue;
        m.seed(app);
        store.meta.seeded[m.id] = true;
      }
      store.changed('__seed');
    },
    resetData() {
      store.clearAll();
      app.seedAll(true);
    },
  };

  for (const m of modules) for (const c of m.collections || []) store.define(c);
  app.settings = createSettings(store);
  if (persist) migrateLegacyJson(dataDir, store, db);
  for (const m of modules) m.init?.(app);
  app.seedAll();
  app.importer = createImportManager(app);
  store.flush();
  return app;
}
