// Management API client + shared state + SSE event hub.
import { toast } from './dom.js';

const BASE = '/__ui/api';

export async function api(method, path, body, { quiet = false } = {}) {
  try {
    const res = await fetch(BASE + path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const err = new Error((data && data.error) || `HTTP ${res.status}`);
      err.status = res.status; err.data = data;
      if (res.status === 401 && data && data.code === 'auth_required') { err.authLost = true; emit('authlost'); }
      throw err;
    }
    return data;
  } catch (e) {
    if (!quiet && !e.authLost) toast(`${method} ${path}: ${e.message}`, 'err');
    throw e;
  }
}

/** Public auth status; resolves null when the server cannot be reached. */
export async function authStatus() {
  try {
    const r = await fetch(`${BASE}/auth/status`, { credentials: 'same-origin' });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

export const qs = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

// ---- shared state -----------------------------------------------------------------------------
export const state = { meta: null, settings: null, user: null };
const listeners = new Map(); // event -> Set<fn>

/** Subscribe to hub events ('request', 'data', 'callback', 'meta', 'settings', 'live'). Returns unsubscribe. */
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}
export function emit(event, payload) {
  for (const fn of listeners.get(event) || []) {
    try { fn(payload); } catch (e) { console.error(`[ui] listener for ${event} failed`, e); }
  }
}

export async function loadMeta() {
  const meta = await api('GET', '/meta', undefined, { quiet: true });
  state.meta = meta;
  state.settings = meta.settings;
  emit('meta', meta);
  return meta;
}
export function setSettings(s) { state.settings = s; if (state.meta) state.meta.settings = s; emit('settings', s); }

export const modules = () => state.meta?.modules || [];
export const moduleById = (id) => modules().find((m) => m.id === id);
export const moduleCount = (m) => (m.collections || []).reduce((n, c) => n + (c.virtual ? 0 : c.count || 0), 0); // computed views would count documents twice
export const baseUrl = () => `${location.origin}/api-3`;

// ---- SSE ----------------------------------------------------------------------------------------
let es = null; let wasDown = false; let lastCheck = 0;

export function disconnectEvents() { if (es) { es.onerror = null; es.close(); es = null; } }

/** EventSource hides HTTP status codes, so after an error ask /auth/status whether the session is gone. */
async function checkSession() {
  if (Date.now() - lastCheck < 2000) return;
  lastCheck = Date.now();
  const s = await authStatus();
  if (s && !s.authenticated) emit('authlost');
}

export function connectEvents() {
  disconnectEvents();
  const cur = new EventSource(`${BASE}/events`);
  es = cur;
  cur.onopen = () => { emit('live', { up: true, reconnected: wasDown }); wasDown = false; };
  cur.onerror = () => {
    wasDown = true; emit('live', { up: false });
    checkSession();
    // a non-200 answer (e.g. 401) closes the stream for good: retry by hand
    if (cur.readyState === 2) setTimeout(() => { if (es === cur) connectEvents(); }, 3000);
  };
  for (const ev of ['request', 'callback', 'import']) cur.addEventListener(ev, (e) => { const p = parse(e); if (p) emit(ev, p); });
  cur.addEventListener('data', (e) => {
    const p = parse(e);
    if (!p) return;
    // keep sidebar counts / tab counts current without a /meta round trip
    for (const m of modules()) for (const c of m.collections) if (c.name === p.collection && typeof p.count === 'number') c.count = p.count;
    emit('data', p);
    emit('counts', p);
  });
}
function parse(e) { try { return JSON.parse(e.data); } catch { return null; } }
