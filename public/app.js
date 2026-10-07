// dummy-emag web UI: shell (sidebar, theme, routing, live indicator).
import { h, replace, icon, copyText, fmtNum, toast } from './js/dom.js';
import { state, on, api, loadMeta, connectEvents, disconnectEvents, authStatus, modules, moduleById, moduleCount, baseUrl } from './js/api.js';
import { renderAuth, changePasswordDialog } from './js/auth.js';
import { renderImport } from './js/import.js';
import { renderRequests } from './js/requests.js';
import { renderSection } from './js/section.js';
import { renderCallbacks } from './js/callbacks.js';
import { renderSettings } from './js/settings.js';
import { closeDrawer } from './js/drawer.js';

const $ = (id) => document.getElementById(id);
const main = $('main');
let cleanups = [];

// ---- theme --------------------------------------------------------------------------------------
const root = document.documentElement;
const isDark = () => (root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches);
function paintThemeBtn() { replace($('themeBtn'), icon(isDark() ? 'sun' : 'moon')); }
$('themeBtn').onclick = () => {
  const next = isDark() ? 'light' : 'dark';
  root.dataset.theme = next;
  try { localStorage.setItem('dummy-emag-theme', next); } catch { /* storage unavailable */ }
  paintThemeBtn();
};
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', paintThemeBtn);
paintThemeBtn();

// ---- mobile menu --------------------------------------------------------------------------------
const sidebar = $('sidebar');
replace($('menuBtn'), icon('menu'));
$('menuBtn').onclick = () => {
  const open = sidebar.classList.toggle('open');
  $('menuBtn').setAttribute('aria-expanded', String(open));
};

// ---- live indicator -------------------------------------------------------------------------------
on('live', ({ reconnected }) => { if (reconnected) loadMeta().catch(() => {}); });
on('live', ({ up }) => {
  const el = $('live');
  el.className = `live ${up ? 'up' : 'down'}`;
  el.title = up ? 'Receiving live events' : 'Disconnected - retrying...';
  el.lastChild.textContent = up ? 'live' : 'offline';
});

// ---- sidebar ------------------------------------------------------------------------------------
const navIcons = { callbacks: 'bell' };
function paintNav() {
  const mods = modules();
  const ordered = [...mods.filter((m) => m.id !== 'callbacks'), ...mods.filter((m) => m.id === 'callbacks')];
  const item = (href, label, ic, count, key) => h('a', { class: 'nav-item', href, 'data-key': key },
    icon(ic), h('span', { class: 'nav-label' }, label), count != null ? h('span', { class: 'count', 'data-count': key }, fmtNum(count)) : null);
  replace($('nav'),
    item('#/requests', 'Requests', 'list', null, 'requests'),
    h('div', { class: 'nav-group' }, 'Sections'),
    ordered.map((m) => item(`#/section/${m.id}`, m.title, navIcons[m.id] || 'box', moduleCount(m), `section/${m.id}`)),
    h('div', { class: 'nav-group' }, 'System'),
    item('#/import', 'Import', 'download', null, 'import'),
    item('#/settings', 'Settings', 'gear', null, 'settings'));
  markActive();
}
function paintCounts() {
  for (const m of modules()) {
    const el = $('nav').querySelector(`[data-count="section/${m.id}"]`);
    if (el) el.textContent = fmtNum(moduleCount(m));
  }
}
function markActive() {
  const key = currentKey();
  for (const a of $('nav').querySelectorAll('.nav-item')) {
    const on = a.dataset.key === key;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}

function paintFoot() {
  const s = state.settings || {}; const m = state.meta || {};
  const strict = s.auth?.mode === 'strict';
  const plat = (m.platforms || []).find((p) => p.id === s.platform);
  replace($('sideFoot'),
    h('div', { class: 'foot-label' }, 'Base URL for your integration'),
    h('div', { class: 'baseurl' }, h('code', baseUrl()), h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Copy base URL', title: 'Copy', onclick: () => copyText(baseUrl(), 'Base URL copied') }, icon('copy', 14))),
    h('div', { class: 'foot-meta' },
      h('span', strict ? 'Auth: HTTP Basic - strict mode (listed users only)' : 'Auth: HTTP Basic - any credentials'),
      h('span', `Platform: ${plat ? `${plat.label} (${plat.currency})` : s.platform || '-'}`),
      h('span', `Spec version: ${m.specVersion ?? '-'}`)),
    h('div', { class: 'foot-user' },
      h('span', { class: 'foot-who', title: 'Signed in' }, state.user || ''),
      h('button', { type: 'button', class: 'btn sm ghost', onclick: () => changePasswordDialog().then((ok) => { if (ok) toast('Password changed'); }) }, 'Change password'),
      h('button', { type: 'button', class: 'btn sm', onclick: signOut }, icon('logout', 13), 'Sign out')));
}

on('meta', () => { paintNav(); paintFoot(); paintCounts(); });
on('settings', () => paintFoot());
on('counts', paintCounts);

// ---- routing --------------------------------------------------------------------------------------
function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/requests';
  const [path, query = ''] = raw.split('?');
  return { path: path.replace(/\/+$/, '') || '/requests', query };
}
function currentKey() {
  const { path } = parseHash();
  if (path.startsWith('/section/')) return `section/${decodeURIComponent(path.slice(9))}`;
  return path.slice(1);
}

function route() {
  for (const fn of cleanups.splice(0)) { try { fn(); } catch (e) { console.error(e); } }
  closeDrawer();
  sidebar.classList.remove('open'); $('menuBtn').setAttribute('aria-expanded', 'false');
  const { path, query } = parseHash();
  const ctx = { query, onCleanup: (fn) => { cleanups.push(fn); } };
  markActive();
  main.scrollTop = 0; window.scrollTo(0, 0);
  try {
    if (path === '/requests') { renderRequests(main, ctx); document.title = 'Requests - dummy-emag'; }
    else if (path === '/import') { renderImport(main, ctx); document.title = 'Import - dummy-emag'; }
    else if (path === '/settings') { renderSettings(main, ctx); document.title = 'Settings - dummy-emag'; }
    else if (path.startsWith('/section/')) {
      const mod = moduleById(decodeURIComponent(path.slice(9)));
      if (!mod) { location.hash = '#/requests'; return; }
      document.title = `${mod.title} - dummy-emag`;
      (mod.id === 'callbacks' ? renderCallbacks : (r, c, m) => renderSection(r, c, m))(main, ctx, mod);
    } else location.hash = '#/requests';
  } catch (e) {
    console.error(e);
    replace(main, h('div', { class: 'pad' }, h('div', { class: 'note-box warn' }, `This screen failed to render: ${e.message}`)));
  }
}

// ---- auth gate + boot ---------------------------------------------------------------------------
const authHost = h('div', { id: 'auth', hidden: true });
document.body.append(authHost);
let locked = true; let stopAuth = null; let retryTimer = null;

function lock(note) {
  if (locked && !note) return;
  locked = true;
  clearTimeout(retryTimer);
  disconnectEvents();
  window.removeEventListener('hashchange', route);
  for (const fn of cleanups.splice(0)) { try { fn(); } catch (e) { console.error(e); } }
  closeDrawer();
  for (const d of document.querySelectorAll('dialog')) { try { d.close(); } catch { /* ignore */ } d.remove(); }
  state.meta = null; state.settings = null; state.user = null;
  replace($('nav')); replace($('sideFoot')); replace(main);
  showAuth(note);
}

async function showAuth(note) {
  document.body.classList.add('locked');
  authHost.hidden = false;
  const st = await authStatus();
  if (st?.authenticated) { enter(st.username); return; }
  if (!st) { // server unreachable: say so and retry
    replace(authHost, h('div', { class: 'auth-wrap' }, h('div', { class: 'auth-card' }, h('h1', 'Cannot reach the server'), h('p', { class: 'muted' }, 'Retrying...'))));
    retryTimer = setTimeout(() => showAuth(note), 3000);
    return;
  }
  stopAuth?.();
  stopAuth = renderAuth(authHost, { registrationOpen: st.registrationOpen, note, onSuccess: (username) => enter(username) });
}

async function enter(username) {
  stopAuth?.(); stopAuth = null;
  state.user = username;
  locked = false;
  connectEvents();
  try {
    await loadMeta();
  } catch (e) {
    if (e.authLost || locked) return; // 'authlost' handler already showed the login screen
    replace(main, h('div', { class: 'pad' }, h('div', { class: 'note-box warn' }, `Cannot reach the management API (${e.message}). Retrying...`)));
    retryTimer = setTimeout(() => { if (!locked) enter(username); }, 3000);
    return;
  }
  authHost.hidden = true; replace(authHost);
  document.body.classList.remove('locked');
  window.removeEventListener('hashchange', route);
  window.addEventListener('hashchange', route);
  route();
}

async function signOut() {
  try { await api('POST', '/auth/logout', {}, { quiet: true }); } catch { /* fall through to login screen anyway */ }
  lock('');
  locked = true;
}

on('authlost', () => { if (!locked) lock('Session expired - please sign in again.'); });

(async () => {
  const st = await authStatus();
  if (st?.authenticated) enter(st.username);
  else showAuth();
})();

// Periodic session check: a live SSE stream may outlive an expired session.
setInterval(async () => {
  if (locked) return;
  const st = await authStatus();
  if (st && !st.authenticated) lock('Session expired - please sign in again.');
}, 30000);
