/**
 * Internal management API used by the web UI (mounted at /__ui/api/*).
 * It is NOT part of the eMAG API surface: never rate-limited or logged (request bodies may carry credentials), and gated by the session cookie.
 *
 *   GET    /meta                                modules, collections, generators, row actions, endpoints, settings
 *   GET    /requests?section&method&status&q&before&limit   -> { total, items: [summary] }
 *   GET    /requests/:id                        full entry (request/response bodies, notes)
 *   DELETE /requests                            clear the request log
 *   GET    /events                              Server-Sent Events: request | data | callback
 *   GET    /collections/:name?q&page&limit&sort -> { items, total, page, limit, columns }
 *   GET    /collections/:name/:id               one document
 *   PUT    /collections/:name/:id               replace a document (JSON body)
 *   DELETE /collections/:name/:id               delete a document
 *   DELETE /collections/:name                   clear a collection
 *   POST   /generate/:module/:generator         body = params   -> { message, created }
 *   POST   /action/:module/:action              body = { collection, id, params } -> { message }
 *   GET    /settings    PUT /settings    POST /settings/reset
 *   POST   /reset                               wipe all data and re-seed reference data
 *   GET    /export      POST /import
 *   POST   /callbacks/test                      body = { event }
 *
 *   AUTH (session cookie; everything except /auth/* answers 401 {code:'auth_required'} without a session)
 *   GET    /auth/status                         { registrationOpen, authenticated, username }
 *   POST   /auth/register | /auth/login | /auth/logout | /auth/password
 *
 *   IMPORT from the real eMAG API (read-only; credentials are used in memory only and never stored)
 *   GET    /import/sources                      { platforms, sources }
 *   POST   /import/start                        { platform, username, password, sources[], mode, options } -> { jobId }
 *   GET    /import/jobs   GET /import/jobs/:id   POST /import/jobs/:id/cancel      (SSE event "import" = live job)
 */
import { readBody, send, sendJson } from '../core/net.js';
import { bus } from '../core/events.js';
import { publicView, isObj } from '../core/util.js';
import { CALLBACK_EVENTS, PLATFORMS } from '../core/settings.js';
import { LIMITS } from '../core/ratelimit.js';
import { AuthError, createAuth } from './auth.js';
import { ImportError } from '../importer/client.js';
import { generateDummyAwb, LABEL_FORMATS, renderLabel } from '../modules/shipping/service.js';

export function createUiApi(app, router) {
  const json = async (req) => {
    const buf = await readBody(req);
    if (!buf.length) return {};
    return JSON.parse(buf.toString('utf8'));
  };

  const findModule = (id) => app.modules.find((m) => m.id === id);
  /** Read-only, computed collections declared by modules (`views`), browsed like collections in the UI. */
  const findView = (name) => app.modules.flatMap((m) => m.views || []).find((v) => v.name === name);
  const viewRow = (view, id) => view.list(app).find((r) => String(r[view.idField || 'id']) === String(id));
  const auth = createAuth(app.store.db);
  app.auth = auth;

  /** State-changing requests must come from this very origin (defence in depth next to SameSite=Strict). */
  const sameOrigin = (req) => {
    const origin = req.headers.origin;
    if (!origin) return true;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  };

  function meta() {
    return {
      name: 'dummy-emag',
      specVersion: app.spec.version,
      platforms: Object.values(PLATFORMS),
      callbackEvents: CALLBACK_EVENTS,
      limits: LIMITS,
      requestCount: app.log.count(),
      modules: app.modules.map((m) => ({
        id: m.id,
        title: m.title,
        description: m.description || '',
        collections: (m.collections || []).map((c) => ({
          name: c.name,
          label: c.label || c.name,
          columns: c.columns || [],
          idField: c.idField || 'id',
          count: app.store.col(c.name).size,
        })).concat((m.views || []).map((v) => ({
          name: v.name,
          label: v.label || v.name,
          columns: v.columns || [],
          idField: v.idField || 'id',
          count: v.list(app).length,
          virtual: true,
          dependsOn: v.dependsOn || [],
          description: v.description || '',
        }))),
        generators: (m.generators || []).map((g) => ({ id: g.id, label: g.label, description: g.description || '', params: g.params || [] })),
        rowLinks: (m.rowLinks || []).map((l) => ({ id: l.id, label: l.label, collection: l.collection, href: l.href })),
        rowActions: (m.rowActions || []).map((a) => ({ id: a.id, label: a.label, collection: a.collection, danger: !!a.danger, params: a.params || [] })),
        endpoints: router.routes.filter((r) => r.module === m).map((r) => ({
          method: r.method, path: `/api-3${r.path}`, name: r.name || r.path, summary: r.summary || '', rateGroup: r.rateGroup || 'default',
        })),
      })),
      settings: app.settings.get(),
    };
  }

  function listCollection(name, query) {
    const col = app.store.col(name);
    return listItems(col.all(), query, { columns: col.def.columns, idField: col.idField });
  }

  function listItems(all, query, { columns, idField }) {
    const limit = Math.min(Number(query.get('limit')) || 50, 500);
    const page = Math.max(Number(query.get('page')) || 1, 1);
    let items = all;
    const q = query.get('q')?.toLowerCase();
    if (q) items = items.filter((d) => JSON.stringify(d).toLowerCase().includes(q));
    if (query.get('sort') !== 'asc') items = items.slice().reverse();
    const total = items.length;
    return { items: publicView(items.slice((page - 1) * limit, page * limit)), total, page, limit, columns, idField };
  }

  function sse(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    const push = (event) => (payload) => res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    const handlers = { request: push('request'), data: push('data'), callback: push('callback'), import: push('import') };
    for (const [ev, fn] of Object.entries(handlers)) bus.on(ev, fn);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(ping);
      for (const [ev, fn] of Object.entries(handlers)) bus.off(ev, fn);
    });
  }

  async function handle(req, res, url, sub) {
    const method = req.method.toUpperCase();
    const seg = sub.split('/').filter(Boolean); // e.g. ['collections', 'orders', '123']
    const route = seg[0];
    try {
      // ---- authentication ------------------------------------------------------
      if (route === 'auth') {
        if (method !== 'GET' && !sameOrigin(req)) return sendJson(res, 403, { error: 'Cross-origin request refused' });
        if (seg[1] === 'status' && method === 'GET') return sendJson(res, 200, auth.status(req));
        if (method !== 'POST') return sendJson(res, 404, { error: 'Not found' });
        if (seg[1] === 'register') {
          const r = auth.register(req, await json(req));
          return sendJson(res, 200, { ok: true, username: r.username }, { 'Set-Cookie': auth.cookieHeader(r.token, req) });
        }
        if (seg[1] === 'login') {
          const r = auth.login(req, await json(req));
          return sendJson(res, 200, { ok: true, username: r.username }, { 'Set-Cookie': auth.cookieHeader(r.token, req) });
        }
        if (seg[1] === 'logout') {
          auth.logout(req);
          return sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie(req) });
        }
        if (seg[1] === 'password') {
          auth.changePassword(req, await json(req));
          return sendJson(res, 200, { ok: true });
        }
        return sendJson(res, 404, { error: 'Not found' });
      }
      if (!auth.sessionFrom(req)) return sendJson(res, 401, { error: 'Unauthorized', code: 'auth_required' });
      if (method !== 'GET' && !sameOrigin(req)) return sendJson(res, 403, { error: 'Cross-origin request refused' });

      // ---- AWB label downloads (PDF / ZPL), opened from the data browser ----------------------
      if (method === 'GET' && ((route === 'awb' && seg[2] === 'label') || (route === 'orders' && seg[2] === 'awb-label'))) {
        const format = (url.searchParams.get('format') || 'A6').toUpperCase();
        if (!LABEL_FORMATS.includes(format)) return sendJson(res, 400, { error: `format must be one of ${LABEL_FORMATS.join(', ')}` });
        let awb;
        if (route === 'awb') awb = app.col('awbs').get(seg[1]);
        else {
          const order = app.col('orders').get(seg[1]);
          if (!order) return sendJson(res, 404, { error: `Order ${seg[1]} not found` });
          const r = generateDummyAwb(app, order); // on demand: issues the AWB (and finalizes the order) when there is none yet
          if (r.error) return sendJson(res, 400, { error: r.error });
          awb = r.doc;
        }
        if (!awb) return sendJson(res, 404, { error: 'AWB not found' });
        const label = renderLabel(app, awb, format);
        return send(res, 200, { 'Content-Type': label.contentType, 'Content-Disposition': `inline; filename="${label.filename}"`, 'Cache-Control': 'no-store' }, label.body);
      }

      if (route === 'import' && seg[1]) {
        if (seg[1] === 'sources' && method === 'GET') return sendJson(res, 200, { platforms: app.importer.platforms(), sources: app.importer.sources() });
        if (seg[1] === 'start' && method === 'POST') return sendJson(res, 200, await app.importer.start(await json(req)));
        if (seg[1] === 'jobs' && !seg[2] && method === 'GET') return sendJson(res, 200, { items: app.importer.list() });
        if (seg[1] === 'jobs' && seg[2] && !seg[3] && method === 'GET') {
          const job = app.importer.get(seg[2]);
          return job ? sendJson(res, 200, job) : sendJson(res, 404, { error: 'Not found' });
        }
        if (seg[1] === 'jobs' && seg[3] === 'cancel' && method === 'POST') return sendJson(res, 200, { ok: app.importer.cancel(seg[2]) });
        return sendJson(res, 404, { error: 'Not found' });
      }

      if (route === 'meta' && method === 'GET') return sendJson(res, 200, meta());
      if (route === 'events' && method === 'GET') return sse(req, res);

      if (route === 'requests') {
        if (method === 'DELETE') { app.log.clear(); return sendJson(res, 200, { ok: true }); }
        if (seg[1]) {
          const e = app.log.get(seg[1]);
          return e ? sendJson(res, 200, e) : sendJson(res, 404, { error: 'Not found' });
        }
        const q = url.searchParams;
        return sendJson(res, 200, app.log.list({
          section: q.get('section') || undefined, method: q.get('method') || undefined, status: q.get('status') || undefined,
          q: q.get('q') || undefined, before: q.get('before') || undefined, limit: Number(q.get('limit')) || 100,
        }));
      }

      if (route === 'collections' && findView(seg[1])) {
        const view = findView(seg[1]);
        if (method !== 'GET') return sendJson(res, 405, { error: `${view.label || view.name} is computed and read-only` });
        if (!seg[2]) return sendJson(res, 200, listItems(view.list(app), url.searchParams, { columns: view.columns || [], idField: view.idField || 'id' }));
        const row = viewRow(view, seg[2]);
        return row ? sendJson(res, 200, publicView(row)) : sendJson(res, 404, { error: 'Not found' });
      }

      if (route === 'collections') {
        const name = seg[1];
        if (!app.store.collections.has(name)) return sendJson(res, 404, { error: `Unknown collection ${name}` });
        const col = app.store.col(name);
        if (!seg[2]) {
          if (method === 'GET') return sendJson(res, 200, listCollection(name, url.searchParams));
          if (method === 'DELETE') return sendJson(res, 200, { cleared: col.clear() });
        } else {
          const id = seg[2];
          const doc = col.get(id);
          if (method === 'GET') return doc ? sendJson(res, 200, publicView(doc)) : sendJson(res, 404, { error: 'Not found' });
          if (method === 'DELETE') return sendJson(res, 200, { deleted: col.remove(id) });
          if (method === 'PUT') {
            if (!doc) return sendJson(res, 404, { error: 'Not found' });
            const body = await json(req);
            if (!isObj(body)) return sendJson(res, 400, { error: 'Body must be a JSON object' });
            const hidden = Object.fromEntries(Object.entries(doc).filter(([k]) => k.startsWith('_')));
            col.map.delete(String(id));
            col.insert({ ...hidden, ...body, [col.idField]: doc[col.idField] });
            return sendJson(res, 200, { ok: true });
          }
        }
      }

      if (route === 'generate' && method === 'POST') {
        const mod = findModule(seg[1]);
        const gen = mod?.generators?.find((g) => g.id === seg[2]);
        if (!gen) return sendJson(res, 404, { error: 'Unknown generator' });
        const params = await json(req);
        const result = await gen.run(app, params);
        return sendJson(res, 200, result ?? { message: 'Done' });
      }

      if (route === 'action' && method === 'POST') {
        const mod = findModule(seg[1]);
        const action = mod?.rowActions?.find((a) => a.id === seg[2]);
        if (!action) return sendJson(res, 404, { error: 'Unknown action' });
        const body = await json(req);
        const view = findView(action.collection);
        const row = view ? viewRow(view, body.id) : app.store.col(action.collection).get(body.id);
        if (!row) return sendJson(res, 404, { error: 'Row not found' });
        const result = await action.run(app, row, body.params || {});
        return sendJson(res, 200, result ?? { message: 'Done' });
      }

      if (route === 'settings') {
        if (method === 'GET') return sendJson(res, 200, app.settings.get());
        if (method === 'PUT') return sendJson(res, 200, app.settings.update(await json(req)));
        if (method === 'POST' && seg[1] === 'reset') return sendJson(res, 200, app.settings.reset());
      }

      if (route === 'reset' && method === 'POST') {
        app.resetData();
        return sendJson(res, 200, { ok: true });
      }

      if (route === 'export' && method === 'GET') {
        return send(res, 200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="dummy-emag-${new Date().toISOString().slice(0, 10)}.json"`,
        }, JSON.stringify(app.store.snapshot(), null, 1));
      }
      if (route === 'import' && method === 'POST') {
        const snap = await json(req);
        if (!snap?.collections) return sendJson(res, 400, { error: 'Not a dummy-emag snapshot' });
        app.store.restore(snap);
        if (snap.meta?.settings) app.settings.update(snap.meta.settings);
        return sendJson(res, 200, { ok: true });
      }

      if (route === 'callbacks' && seg[1] === 'test' && method === 'POST') {
        const { event } = await json(req);
        const result = await app.sendTestCallback(event);
        return sendJson(res, 200, result);
      }

      return sendJson(res, 404, { error: `No UI route for ${method} ${sub}` });
    } catch (e) {
      if (e instanceof AuthError) return sendJson(res, e.status, { error: e.message, ...e.extra });
      if (e instanceof ImportError) return sendJson(res, e.status || 502, { error: e.message });
      if (e instanceof SyntaxError) return sendJson(res, 400, { error: 'Invalid JSON body' });
      console.error('[ui-api]', e.message); // never log request bodies: they may carry credentials
      return sendJson(res, e.status || 500, { error: e.message });
    }
  }

  return { handle };
}
