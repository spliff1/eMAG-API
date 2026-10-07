import { bus } from './events.js';

/** Bodies above this size are stored truncated (env LOG_BODY_MAX_BYTES, default 1 MB); the log keeps at most LOG_MAX_REQUESTS rows (default 20000, 0 = unlimited). */
const BODY_MAX = Number(process.env.LOG_BODY_MAX_BYTES ?? 1024 * 1024);
const MAX_ROWS = Number(process.env.LOG_MAX_REQUESTS ?? 20000);

const json = (v) => (v === undefined ? null : JSON.stringify(v));
const jsonBody = (v) => {
  const text = json(v);
  if (text === null || !(BODY_MAX > 0) || Buffer.byteLength(text) <= BODY_MAX) return text;
  return JSON.stringify({ __truncated: true, bytes: Buffer.byteLength(text), preview: text.slice(0, 4096) });
};
const parse = (s) => (s === null || s === undefined ? undefined : JSON.parse(s));
const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export const summarize = (e) => ({
  id: e.id, ts: e.ts, method: e.method, path: e.path, query: e.query, section: e.section, route: e.route,
  status: e.status, isError: e.isError, durationMs: e.durationMs, user: e.user, notes: e.notes?.length || 0,
  fault: e.fault || null, messages: e.messages?.slice(0, 3) || [], bytes: e.bytes,
});

/**
 * Every API request goes to the `requests` table with its full request and response bodies.
 * Nothing is truncated or deleted automatically (use "Clear log" in the UI to wipe it).
 */
export function createRequestLog({ db }) {
  const insert = db.prepare(`INSERT INTO requests
    (ts, method, path, query, section, route, api_user, ip, req_headers, req_body, status, is_error, duration_ms, bytes, notes, messages, fault, res_body)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const byId = db.prepare('SELECT * FROM requests WHERE id = ?');
  const trim = db.prepare('DELETE FROM requests WHERE id <= (SELECT id FROM requests ORDER BY id DESC LIMIT 1 OFFSET ?)');
  let sinceTrim = 0;

  const rowToEntry = (r) => ({
    id: r.id, ts: r.ts, method: r.method, path: r.path, query: parse(r.query) ?? {}, section: r.section, route: r.route,
    user: r.api_user, ip: r.ip, reqHeaders: parse(r.req_headers) ?? {}, reqBody: parse(r.req_body), status: r.status,
    isError: !!r.is_error, durationMs: r.duration_ms, bytes: r.bytes, notes: parse(r.notes) ?? [], messages: parse(r.messages) ?? [],
    fault: r.fault, resBody: parse(r.res_body),
  });

  return {
    add(entry) {
      const r = insert.run(
        entry.ts, entry.method, entry.path, json(entry.query), entry.section, entry.route, entry.user ?? null, entry.ip ?? null,
        json(entry.reqHeaders), jsonBody(entry.reqBody), entry.status, entry.isError ? 1 : 0, entry.durationMs, entry.bytes,
        json(entry.notes ?? []), json(entry.messages ?? []), entry.fault ?? null, jsonBody(entry.resBody),
      );
      entry.id = Number(r.lastInsertRowid);
      if (MAX_ROWS > 0 && ++sinceTrim >= 100) { sinceTrim = 0; trim.run(MAX_ROWS); }
      bus.emit('request', summarize(entry));
      return entry;
    },
    get(id) {
      const r = byId.get(Number(id));
      return r ? rowToEntry(r) : undefined;
    },
    clear() { db.exec('DELETE FROM requests'); },
    count: () => db.prepare('SELECT COUNT(*) AS n FROM requests').get().n,
    list({ section, method, status, q, before, limit = 100 } = {}) {
      const where = [];
      const args = [];
      if (section) { where.push('section = ?'); args.push(section); }
      if (method) { where.push('method = ?'); args.push(method.toUpperCase()); }
      if (status) {
        if (status === 'error') where.push('(is_error = 1 OR status >= 400)');
        else if (status === 'ok') where.push('(is_error = 0 AND status < 400)');
        else if (/^\dxx$/.test(status)) { where.push('status BETWEEN ? AND ?'); args.push(Number(status[0]) * 100, Number(status[0]) * 100 + 99); }
        else { where.push('status = ?'); args.push(Number(status)); }
      }
      if (q) {
        const like = `%${likeEscape(q)}%`;
        where.push("(path LIKE ? ESCAPE '\\' OR req_body LIKE ? ESCAPE '\\' OR res_body LIKE ? ESCAPE '\\')");
        args.push(like, like, like);
      }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = db.prepare(`SELECT COUNT(*) AS n FROM requests ${w}`).get(...args).n;
      const beforeClause = before ? `${w ? `${w} AND` : 'WHERE'} id < ?` : w;
      const rows = db.prepare(`SELECT id, ts, method, path, query, section, route, api_user, status, is_error, duration_ms, bytes, fault, messages,
          json_array_length(notes) AS notes_n FROM requests ${beforeClause} ORDER BY id DESC LIMIT ?`).all(...args, ...(before ? [Number(before)] : []), Math.min(Number(limit) || 100, 1000));
      return {
        total,
        items: rows.map((r) => ({
          id: r.id, ts: r.ts, method: r.method, path: r.path, query: parse(r.query) ?? {}, section: r.section, route: r.route,
          status: r.status, isError: !!r.is_error, durationMs: r.duration_ms, user: r.api_user, notes: r.notes_n || 0,
          fault: r.fault || null, messages: (parse(r.messages) ?? []).slice(0, 3), bytes: r.bytes,
        })),
      };
    },
  };
}
