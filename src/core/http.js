import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { buildRouter } from './router.js';
import { createAbuseGuard, createRateLimiter } from './ratelimit.js';
import { pickFault, faultBody } from './faults.js';
import { ApiError, fail, isRaw, ok } from './response.js';
import { leafCount, sleep, isObj, rnd } from './util.js';
import { createUiApi } from '../ui/api.js';
import { ROOT } from './spec.js';
import { clientIp, readBody, send, sendJson, UI_SECURITY_HEADERS } from './net.js';
import { StoreFullError } from './store.js';

const PUBLIC_DIR = path.join(ROOT, 'public');
/** Max body for the public API (the real API caps requests at 4000 variables / 50 items, so 2 MB is plenty). Env: API_MAX_BODY_BYTES. */
const API_MAX_BODY = Number(process.env.API_MAX_BODY_BYTES) || 2 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png',
};

function parseBasic(header) {
  if (!header || !/^basic /i.test(header)) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  return { username: decoded.slice(0, i), password: decoded.slice(i + 1) };
}

/** Express-style query parsing incl. eans[]=1&eans[]=2 and eans[0]=1 */
function parseQuery(searchParams) {
  const q = {};
  for (const [rawKey, value] of searchParams) {
    const m = rawKey.match(/^([^[\]]+)\[(\d*)\]$/);
    if (m) (q[m[1]] ||= []).push(value);
    else q[rawKey] = value;
  }
  return q;
}

export function createHttpServer(app) {
  const router = buildRouter(app.modules);
  // Routes may declare `body: (spec) => schema` to tweak official schemas (e.g. raise a documented-but-undeclared limit).
  for (const r of router.routes) if (typeof r.body === 'function') r.body = r.body(app.spec);
  const limiter = createRateLimiter();
  const abuse = createAbuseGuard();
  const ui = createUiApi(app, router);

  async function handleApi(req, res, url, apiPath) {
    const started = Date.now();
    const settings = app.settings.get();
    const method = req.method.toUpperCase();
    const entry = {
      ts: new Date().toISOString(), method, path: url.pathname, query: Object.fromEntries(url.searchParams),
      section: 'unmatched', route: null, user: null, ip: clientIp(req),
      reqHeaders: {
        'content-type': req.headers['content-type'], 'user-agent': req.headers['user-agent'],
        authorization: req.headers.authorization ? 'Basic ***' : undefined,
      },
      reqBody: undefined, notes: [], messages: [],
    };
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS' };
    let rateHeaders = {};

    const finish = (status, body, headers = {}, { rawBody } = {}) => {
      const payload = rawBody ?? JSON.stringify(body);
      entry.status = status;
      entry.resBody = rawBody ? { __binary: true, contentType: headers['Content-Type'], bytes: rawBody.length } : body;
      entry.isError = !rawBody && (body?.isError === true || status >= 400);
      entry.messages = Array.isArray(body?.messages) ? body.messages.filter((m) => typeof m === 'string') : (body?.message ? [body.message] : []);
      entry.bytes = Buffer.byteLength(payload);
      entry.durationMs = Date.now() - started;
      app.log.add(entry);
      app.store.flush(); // an acknowledged write is already on disk
      send(res, status, { 'Content-Type': 'application/json; charset=utf-8', ...cors, ...rateHeaders, ...headers }, payload);
    };

    try {
      if (method === 'OPTIONS') { send(res, 204, cors); return; }

      // ---- body ---------------------------------------------------------
      const buf = ['GET', 'HEAD'].includes(method) ? Buffer.alloc(0) : await readBody(req, API_MAX_BODY);
      let body = {};
      if (buf.length) {
        try { body = JSON.parse(buf.toString('utf8')); } catch (e) {
          entry.reqBody = buf.toString('utf8').slice(0, 5000);
          return finish(400, fail([`Invalid JSON body: ${e.message}`]));
        }
        entry.reqBody = body;
      }

      // ---- auth ---------------------------------------------------------
      const creds = parseBasic(req.headers.authorization);
      if (creds) entry.user = creds.username;
      const authOk = creds && creds.username && (settings.auth.mode !== 'strict'
        || settings.auth.users.some((u) => u.username === creds.username && u.password === creds.password));
      if (!authOk) {
        entry.notes.push(creds ? 'Basic credentials rejected (auth mode: strict)' : 'Missing or malformed Authorization: Basic header');
        return finish(401, fail(['Unauthorized']), { 'WWW-Authenticate': 'Basic realm="eMAG Marketplace API"' });
      }

      // resolve the route early so injected faults / errors are attributed to the right section in the log
      const m = router.match(method, apiPath);
      if (m?.route) { entry.section = m.route.section; entry.route = m.route.name || m.route.path; }

      // ---- chaos / latency / injected faults --------------------------------
      if (settings.latencyMs > 0) await sleep(settings.latencyMs);
      const fault = pickFault(app.settings, method, apiPath);
      if (fault) {
        entry.fault = `rule ${fault.id || ''}`.trim();
        entry.notes.push(`Fault injected: HTTP ${fault.status}`);
        if (fault.delayMs > 0) await sleep(fault.delayMs);
        return finish(fault.status, faultBody(fault));
      }
      if (settings.errorRate > 0 && Math.random() * 100 < settings.errorRate) {
        const status = rnd.pick([500, 502, 503]);
        entry.fault = 'random error';
        entry.notes.push(`Random error injected: HTTP ${status}`);
        return finish(status, fail(['Internal Server Error']));
      }

      // ---- routing --------------------------------------------------------
      if (!m) return finish(404, fail([`Resource not found: ${method} ${apiPath}`]));
      if (m.methodNotAllowed) return finish(405, fail([`Method ${method} not allowed for ${apiPath}`]));
      const { route, params } = m;
      entry.section = route.section;
      entry.route = route.name || route.path;

      // ---- rate limiting --------------------------------------------------
      if (settings.rateLimit.enabled) {
        const rl = limiter(entry.ip, creds.username, route.rateGroup || 'default');
        rateHeaders = { 'X-RateLimit-Limit-3second': String(rl.limit), 'X-RateLimit-Remaining-3second': String(rl.remaining) };
        if (!rl.allowed) return finish(429, { message: 'API rate limit exceeded' });
      }

      // ---- generic validation --------------------------------------------------
      if (leafCount(body) > 4000) return finish(200, fail(['Maximum input vars of 4000 exceeded']));

      const c = {
        app, store: app.store, settings, req, method, path: apiPath, params, user: creds.username,
        query: parseQuery(url.searchParams), body, items: null, notes: entry.notes,
        col: (name) => app.store.col(name),
        note: (msg) => entry.notes.push(msg),
        platform: app.settings.platform(),
      };

      if (route.body) {
        const r = app.spec.validate(route.body, body);
        entry.notes.push(...r.notes);
        if (r.errors.length) return finish(200, fail(r.errors));
        c.body = r.value;
        if (route.readFilter && isObj(body) && 'data' in body) {
          entry.notes.push('Key "data" ignored: read/count filters must be top-level keys, not wrapped in "data" — all matching records were returned.');
        }
      }

      if (route.items) {
        const { schema, max = 50, key = 'data' } = route.items;
        const arr = body?.[key];
        if (!Array.isArray(arr)) return finish(200, fail([`${key}: is required and must be an array`]));
        if (arr.length === 0) return finish(200, fail([`${key}: must contain at least one item`]));
        if (arr.length > max) return finish(200, fail([`${key}: at most ${max} items allowed per request`]));
        c.items = arr.map((rawItem, index) => {
          const r = app.spec.validate(schema, rawItem);
          entry.notes.push(...r.notes.map((n) => `${key}[${index}].${n}`));
          return { index, value: r.value, errors: r.errors.map((e) => `${key}[${index}].${e}`) };
        });
      }

      if (route.query) {
        const r = app.spec.validate(route.query, c.query);
        if (r.errors.length) return finish(200, fail(r.errors));
        c.query = r.value;
      }

      // ---- handler ------------------------------------------------------------------
      let result;
      try {
        result = await route.handler(c);
      } catch (e) {
        if (e instanceof ApiError) return finish(e.status, e.body ?? fail(e.messages));
        throw e;
      }
      if (isRaw(result)) return finish(result.status, { isError: false }, result.headers, { rawBody: Buffer.from(result.body) });
      return finish(200, result ?? ok());
    } catch (e) {
      if (e instanceof ApiError) return finish(e.status, e.body ?? fail(e.messages));
      if (e instanceof StoreFullError) { entry.notes.push(e.message); return finish(507, fail([e.message])); }
      console.error('[api] unhandled error', e);
      entry.notes.push(`Unhandled error: ${e.stack || e}`);
      return finish(500, fail(['Internal Server Error']));
    }
  }

  function serveStatic(req, res, pathname) {
    let rel = pathname === '/' ? '/index.html' : pathname;
    if (rel.includes('\0')) return send(res, 400, {}, 'Bad request');
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, {}, 'Forbidden');
    fs.readFile(file, (err, data) => {
      if (err) {
        if (!path.extname(rel)) {
          return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => (e2 ? send(res, 404, {}, 'Not found') : send(res, 200, { 'Content-Type': MIME['.html'] }, d2)));
        }
        return send(res, 404, {}, 'Not found');
      }
      send(res, 200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }, data);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { pathname = url.pathname; }

      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (pathname === '/api-3' || pathname.startsWith('/api-3/')) {
        // Per-address flood guard, evaluated before the body is even read and never written to the request log.
        if (!abuse(clientIp(req))) {
          req.resume();
          return send(res, 429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '1' }, JSON.stringify({ message: 'API rate limit exceeded' }));
        }
        // The official spec lists some paths already prefixed with /api-3 (invoices, smart-deals), so accept both.
        const apiPath = pathname.replace(/^(\/api-3)+/, '').replace(/\/+$/, '') || '/';
        return await handleApi(req, res, url, apiPath);
      }

      for (const [k, v] of Object.entries(UI_SECURITY_HEADERS)) res.setHeader(k, v);
      if (pathname.startsWith('/__ui/api/')) {
        res.setHeader('Cache-Control', 'no-store');
        return await ui.handle(req, res, url, pathname.slice('/__ui/api'.length));
      }
      if (pathname === '/health') return sendJson(res, 200, { status: 'ok', specVersion: app.spec.version });
      if (pathname === '/openapi.json') return sendJson(res, 200, app.spec.doc);
      if (pathname === '/api-doc') return send(res, 302, { Location: 'https://marketplace-api.emag.ro/api-doc' }, '');
      return serveStatic(req, res, pathname);
    } catch (e) {
      console.error('[http] fatal', e);
      if (!res.headersSent) sendJson(res, 500, fail(['Internal Server Error']));
    }
  });
  // Slow-client protection: bound how long a request may take to arrive (defaults are 60 s / 300 s).
  server.headersTimeout = 30_000;
  server.requestTimeout = 120_000;
  server.maxHeadersCount = 100;
  return server;
}
