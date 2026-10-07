import dns from 'node:dns/promises';
import net from 'node:net';
import { bus } from '../../core/events.js';
import { fmtDateTime, publicView } from '../../core/util.js';

/**
 * SSRF guard: callbacks may only target public http(s) hosts once the server is exposed (HOST other than loopback).
 * Private / loopback / link-local / cloud-metadata addresses are refused, so a hijacked UI session cannot probe the
 * network the dummy runs in. Override with CALLBACKS_ALLOW_PRIVATE=1 (allow) or =0 (refuse even on loopback).
 */
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateIp(v6.slice(7));
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}
function privateAllowed(app) {
  const env = process.env.CALLBACKS_ALLOW_PRIVATE;
  if (env === '1') return true;
  if (env === '0') return false;
  return !app.config.exposed;
}
async function assertSafeTarget(app, raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Invalid callback URL'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Callback URL must use http or https');
  if (privateAllowed(app)) return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('Callback URL points to a private address (refused on an exposed server)');
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length) throw new Error(`Callback host "${host}" could not be resolved`);
  if (addrs.some(isPrivateIp)) throw new Error('Callback URL resolves to a private address (refused on an exposed server)');
}

const SOURCES = {
  'order.new': 'orders', 'order.cancel': 'orders', 'rma.new': 'rmas', 'rma.status': 'rmas', 'awb.status': 'awbs', 'documentation.approved': 'offers',
};

/** POSTs `payload` as JSON to the URL configured for `event`. Records the attempt in callback_log. */
async function deliver(app, event, payload, { force = false, retryOf } = {}) {
  const cfg = app.settings.get().callbacks;
  const target = cfg.events[event];
  if (!force && !(target?.enabled && target.url)) return { ok: false, skipped: true, error: 'callback not enabled' };
  if (!target?.url) return { ok: false, error: `No URL configured for ${event}` };

  const headers = { 'Content-Type': 'application/json', 'X-Dummy-Emag-Event': event, 'User-Agent': 'dummy-emag/1.0' };
  const { username, password } = cfg.basicAuth || {};
  if (username) headers.Authorization = `Basic ${Buffer.from(`${username}:${password || ''}`).toString('base64')}`;

  const started = Date.now();
  const entry = {
    ts: new Date().toISOString(), event, url: target.url, requestHeaders: { ...headers, Authorization: headers.Authorization ? 'Basic ***' : undefined },
    requestBody: payload, ok: false, status: null, durationMs: 0, responseBody: null, error: null, ...(retryOf ? { retryOf } : {}),
  };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.min(Number(cfg.timeoutMs) || 10000, 60_000));
  try {
    await assertSafeTarget(app, target.url);
    const res = await fetch(target.url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ac.signal, redirect: 'manual' });
    entry.status = res.status;
    entry.ok = res.ok;
    entry.responseBody = (await res.text()).slice(0, 1_000_000);
  } catch (e) {
    entry.error = e.name === 'AbortError' ? `timeout after ${cfg.timeoutMs || 10000} ms` : (e.cause?.code || e.message);
  } finally {
    clearTimeout(timer);
    entry.durationMs = Date.now() - started;
  }
  const saved = app.col('callback_log').insert(entry);
  bus.emit('callback', { id: saved.id, event, ok: entry.ok, status: entry.status, error: entry.error });
  return { ok: entry.ok, status: entry.status, error: entry.error, durationMs: entry.durationMs, responseBody: entry.responseBody, logId: saved.id };
}

const mod = {
  id: 'callbacks',
  title: 'Callbacks',
  description: 'Notifications eMAG pushes to your server (new order, cancellation, new return / status change, AWB status, approved documentation). Configure target URLs below.',
  collections: [
    { name: 'callback_log', label: 'Delivery log', startAt: 1, columns: ['id', 'ts', 'event', 'ok', 'status', 'url', 'durationMs', 'error'] },
  ],
  routes: [],

  init(app) {
    bus.on('notify', ({ event, payload }) => { deliver(app, event, payload).catch((e) => console.warn('[callbacks]', e.message)); });
    app.sendTestCallback = async (event) => {
      const source = SOURCES[event];
      const latest = source ? app.col(source).all().at(-1) : null;
      const payload = latest ? publicView(latest) : { test: true, event, at: fmtDateTime() };
      return deliver(app, event, payload, { force: true });
    };
  },

  rowActions: [
    {
      id: 'retry', label: 'Re-send this callback', collection: 'callback_log',
      async run(app, row) {
        const r = await deliver(app, row.event, row.requestBody, { force: true, retryOf: row.id });
        return { message: r.ok ? `Delivered (HTTP ${r.status})` : `Failed: ${r.error || `HTTP ${r.status}`}` };
      },
    },
  ],
};

export default mod;
