import { bus } from './events.js';
import { transaction } from './db.js';

/** Upper bound of documents per collection (everything lives in memory). Env: MAX_DOCS_PER_COLLECTION (0 = unlimited). */
export const MAX_DOCS = Number(process.env.MAX_DOCS_PER_COLLECTION ?? 20000);

export class StoreFullError extends Error {
  constructor(name, max) {
    super(`Storage limit reached: collection "${name}" already holds ${max} documents. Delete data from the UI (or raise MAX_DOCS_PER_COLLECTION).`);
    this.name = 'StoreFullError';
    this.status = 507;
  }
}

export class Collection {
  constructor(store, def) {
    this.store = store;
    this.def = { idField: 'id', startAt: 1, columns: [], ...def };
    this.name = def.name;
    this.map = new Map();
    this._persisted = new Map(); // id -> JSON text currently stored in SQLite (used to detect in-place mutations)
  }
  get idField() { return this.def.idField; }
  get size() { return this.map.size; }
  all() { return [...this.map.values()]; }
  get(id) { return this.map.get(String(id)); }
  has(id) { return this.map.has(String(id)); }
  find(pred) { for (const v of this.map.values()) if (pred(v)) return v; return undefined; }
  filter(pred) { return this.all().filter(pred); }

  _checkCapacity(adding) {
    if (MAX_DOCS > 0 && this.map.size + adding > MAX_DOCS) throw new StoreFullError(this.name, MAX_DOCS);
  }

  /** Insert or replace. Assigns an auto-increment id when the document has none. */
  insert(doc) {
    if (doc[this.idField] == null) { this._checkCapacity(1); doc[this.idField] = this.store.nextId(this.name); }
    else { if (!this.map.has(String(doc[this.idField]))) this._checkCapacity(1); this.store.bumpSeq(this.name, doc[this.idField]); }
    this.map.set(String(doc[this.idField]), doc);
    this.store.changed(this.name);
    return doc;
  }
  upsert(doc) { return this.insert(doc); }
  insertMany(docs) {
    this._checkCapacity(docs.filter((d) => d[this.idField] == null || !this.map.has(String(d[this.idField]))).length);
    for (const d of docs) {
      if (d[this.idField] == null) d[this.idField] = this.store.nextId(this.name);
      else this.store.bumpSeq(this.name, d[this.idField]);
      this.map.set(String(d[this.idField]), d);
    }
    this.store.changed(this.name);
    return docs;
  }
  update(id, patch) {
    const cur = this.get(id);
    if (!cur) return null;
    Object.assign(cur, patch);
    this.store.changed(this.name);
    return cur;
  }
  /** Call after mutating a document in place. */
  touch() { this.store.changed(this.name); }
  remove(id) {
    const had = this.map.delete(String(id));
    if (had) this.store.changed(this.name);
    return had;
  }
  clear() {
    const n = this.map.size;
    this.map.clear();
    this.store.changed(this.name);
    return n;
  }
}

/**
 * Collections kept in memory (fast reads, handlers mutate documents in place) and persisted to SQLite.
 * `flush()` writes only what changed (JSON text diff) in one transaction; it runs on a short debounce,
 * synchronously after every API request (so an acknowledged write is on disk) and on process exit.
 */
export class Store {
  constructor({ db }) {
    this.db = db;
    this.collections = new Map();
    this.seq = {};
    this.meta = { seeded: {}, settings: {} };
    this._dirty = new Set();
    this._timer = null;
    this._emitTimer = null;
    this._pending = new Set();

    const rows = db.prepare('SELECT key, value FROM meta').all();
    const saved = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
    this.seq = saved.seq || {};
    this.meta = { seeded: saved.seeded || {}, settings: saved.settings || {} };

    this._stmt = {
      load: db.prepare('SELECT id, data FROM docs WHERE collection = ?'),
      upsert: db.prepare('INSERT INTO docs (collection, id, data) VALUES (?, ?, ?) ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data'),
      del: db.prepare('DELETE FROM docs WHERE collection = ? AND id = ?'),
      meta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    };
    process.once('exit', () => { try { this.flush(); } catch { /* db already closed */ } });
  }

  /** Declare a collection (idempotent) and hydrate it from SQLite. */
  define(def) {
    let col = this.collections.get(def.name);
    if (!col) {
      col = new Collection(this, def);
      this.collections.set(def.name, col);
      for (const row of this._stmt.load.all(def.name)) {
        col.map.set(row.id, JSON.parse(row.data));
        col._persisted.set(row.id, row.data);
      }
    } else col.def = { ...col.def, ...def };
    return col;
  }
  col(name) {
    const c = this.collections.get(name);
    if (!c) throw new Error(`Unknown collection "${name}"`);
    return c;
  }

  nextId(name) {
    const start = this.collections.get(name)?.def.startAt ?? 1;
    this.seq[name] = Math.max(this.seq[name] ?? start - 1, start - 1) + 1;
    return this.seq[name];
  }
  bumpSeq(name, id) {
    if (typeof id === 'number' && id > (this.seq[name] ?? 0)) this.seq[name] = id;
  }

  changed(name) {
    this._dirty.add(name);
    if (!name.startsWith('__')) {
      this._pending.add(name);
      clearTimeout(this._emitTimer);
      this._emitTimer = setTimeout(() => {
        for (const n of this._pending) bus.emit('data', { collection: n, count: this.collections.get(n)?.size ?? 0 });
        this._pending.clear();
      }, 50);
      this._emitTimer.unref?.();
    }
    clearTimeout(this._timer);
    this._timer = setTimeout(() => { try { this.flush(); } catch (e) { console.error('[store] flush failed:', e.message); } }, 150);
    this._timer.unref?.();
  }

  flush() {
    if (!this._dirty.size) return;
    clearTimeout(this._timer);
    const names = [...this._dirty];
    this._dirty.clear();
    try {
      transaction(this.db, () => {
        for (const name of names) {
          const col = this.collections.get(name);
          if (!col) continue;
          for (const [id, doc] of col.map) {
            const text = JSON.stringify(doc);
            if (col._persisted.get(id) !== text) {
              this._stmt.upsert.run(name, id, text);
              col._persisted.set(id, text);
            }
          }
          for (const id of [...col._persisted.keys()]) {
            if (!col.map.has(id)) {
              this._stmt.del.run(name, id);
              col._persisted.delete(id);
            }
          }
        }
        this._stmt.meta.run('seq', JSON.stringify(this.seq));
        this._stmt.meta.run('seeded', JSON.stringify(this.meta.seeded));
        this._stmt.meta.run('settings', JSON.stringify(this.meta.settings));
      });
    } catch (e) {
      for (const n of names) this._dirty.add(n);
      throw e;
    }
  }

  snapshot() {
    return {
      version: 2,
      seq: this.seq,
      meta: this.meta,
      collections: Object.fromEntries([...this.collections].map(([n, c]) => [n, c.all()])),
    };
  }

  /** Replace everything with a snapshot (import). */
  restore(snap) {
    this.seq = snap.seq || {};
    this.meta.seeded = snap.meta?.seeded || {};
    for (const [name, col] of this.collections) {
      col.map.clear();
      for (const d of snap.collections?.[name] || []) col.map.set(String(d[col.idField]), d);
      this.changed(name);
    }
    this.changed('__meta');
  }

  /** Wipe all collections but keep settings (and, being separate tables, accounts / sessions / request log). */
  clearAll() {
    for (const col of this.collections.values()) col.clear();
    this.seq = {};
    this.meta.seeded = {};
    this.changed('__meta');
  }
}
