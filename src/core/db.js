import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * SQLite (node:sqlite, built into Node >= 22.13) is the single source of truth:
 *
 *   docs         one row per document of every collection (JSON text)      -> offers, orders, awbs, ...
 *   meta         id sequences, seeded flags, runtime settings
 *   requests     EVERY API request with full request/response bodies (never truncated, never auto-deleted)
 *   users        UI accounts (scrypt hashes)         sessions   UI sessions (hashed tokens)
 *   import_runs  history of imports from the real eMAG API (never contains credentials)
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS docs (
  collection TEXT NOT NULL,
  id         TEXT NOT NULL,
  data       TEXT NOT NULL,
  PRIMARY KEY (collection, id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  method      TEXT NOT NULL,
  path        TEXT NOT NULL,
  query       TEXT,
  section     TEXT,
  route       TEXT,
  api_user    TEXT,
  ip          TEXT,
  req_headers TEXT,
  req_body    TEXT,
  status      INTEGER,
  is_error    INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  bytes       INTEGER,
  notes       TEXT,
  messages    TEXT,
  fault       TEXT,
  res_body    TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_section ON requests(section);
CREATE INDEX IF NOT EXISTS idx_requests_status  ON requests(status);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS import_runs (
  id          TEXT PRIMARY KEY,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL,
  data        TEXT NOT NULL
) WITHOUT ROWID;
`;

/** Opens (creating if needed) the database. `file = null` -> private in-memory database (tests). */
export function openDb(file) {
  if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file || ':memory:');
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

/** Runs fn inside a transaction (re-entrant calls just join the outer one). */
export function transaction(db, fn) {
  if (db.isTransaction) return fn();
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
