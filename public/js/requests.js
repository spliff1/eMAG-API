// Requests screen (live log) + request detail drawer + compact "recent requests" list.
import { h, replace, clear, icon, methodBadge, statusBadge, fmtClock, fmtFull, fmtRel, fmtBytes, fmtMs, fmtNum, copyText, confirmBox, toast, debounce, emptyState } from './dom.js';
import { api, qs, on, state, modules, baseUrl } from './api.js';
import { jsonBlock } from './json.js';
import { openDrawer, setDrawer, closeDrawer, isDrawerOpen } from './drawer.js';

const MAX_ROWS = 500;

// ---------------------------------------------------------------------------------------------
// cURL builder
// ---------------------------------------------------------------------------------------------
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function buildCurl(e) {
  const query = typeof e.query === 'string' ? e.query.replace(/^\?/, '') : new URLSearchParams(e.query || {}).toString();
  const url = `${location.origin}${e.path}${query ? `?${query}` : ''}`;
  const parts = [`curl -X ${e.method}`, shq(url), `-u ${shq(`${e.user || 'user'}:***`)}`];
  const ct = e.reqHeaders?.['content-type'];
  const b = e.reqBody;
  if (b !== undefined && b !== null && !(b.__truncated)) {
    parts.push(`-H ${shq(`Content-Type: ${ct || 'application/json'}`)}`);
    parts.push(`-d ${shq(typeof b === 'string' ? b : JSON.stringify(b))}`);
  } else if (b?.__truncated) {
    parts.push(`-H ${shq(`Content-Type: ${ct || 'application/json'}`)}`, `-d ${shq('{"...":"body was truncated in the log"}')}`);
  }
  return parts.join(' \\\n  ');
}

// ---------------------------------------------------------------------------------------------
// Request detail drawer (used by this screen and by the section pages)
// ---------------------------------------------------------------------------------------------
const kv = (k, v) => (v === undefined || v === null || v === '' ? null : [h('dt', k), h('dd', v)]);

export async function openRequestDrawer(id, summary, onCloseCb) {
  const title = (s) => h('div', { class: 'req-title' }, methodBadge(s?.method), h('span', { class: 'mono path' }, s?.path || `Request #${id}`));
  const tok = openDrawer({ label: `Request ${id} details`, title: title(summary), body: h('p', { class: 'muted pad' }, 'Loading...'), close: onCloseCb });
  try {
    const e = await api('GET', `/requests/${id}`, undefined, { quiet: true });
    setDrawer(tok, {
      title: title(e),
      actions: h('button', { type: 'button', class: 'btn sm', onclick: () => copyText(buildCurl(e), 'cURL copied') }, icon('copy', 14), 'Copy as cURL'),
      body: requestBody(e),
    });
  } catch (err) {
    setDrawer(tok, { body: h('div', { class: 'pad' }, emptyState('Request not found', 'It may have been cleared or rotated out of the log.')) });
  }
}

function requestBody(e) {
  const q = typeof e.query === 'string' ? e.query : e.query && Object.keys(e.query).length ? e.query : null;
  const notes = e.notes || [];
  return h('div', { class: 'detail' },
    h('div', { class: 'detail-status' }, statusBadge(e.status, e.isError),
      e.fault ? h('span', { class: 'badge fault', title: 'This response was produced by fault injection' }, `injected: ${e.fault}`) : null,
      h('span', { class: 'muted' }, `${fmtFull(e.ts)} (${fmtRel(e.ts)})`)),
    h('dl', { class: 'kv' },
      kv('Section', e.section), kv('Route', e.route), kv('User', e.user), kv('Client IP', e.ip),
      kv('Duration', fmtMs(e.durationMs)), kv('Response size', e.bytes != null ? fmtBytes(e.bytes) : null), kv('Request id', `#${e.id}`)),
    e.fault ? h('div', { class: 'note-box fault-box' }, h('strong', 'Fault injection. '), `This response was not produced by the real handler (${e.fault}). Adjust rules in Settings.`) : null,
    notes.length ? h('div', { class: 'note-box warn' },
      h('strong', `Notes (${notes.length})`), h('span', { class: 'muted' }, ' - what the dummy coerced, ignored or rejected'),
      h('ul', notes.map((n) => h('li', String(n))))) : null,
    (e.messages || []).length ? h('div', { class: 'note-box' }, h('strong', 'Response messages'), h('ul', e.messages.map((m) => h('li', String(m))))) : null,
    q ? jsonBlock('Query string', q) : null,
    jsonBlock('Request headers', e.reqHeaders, { open: false }),
    jsonBlock('Request body', e.reqBody),
    jsonBlock('Response body', e.resBody, { meta: e.bytes != null ? fmtBytes(e.bytes) : undefined }));
}

// ---------------------------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------------------------
function pathCell(s) {
  let query = '';
  if (typeof s.query === 'string') query = s.query.replace(/^\?/, '');
  else if (s.query && Object.keys(s.query).length) query = new URLSearchParams(s.query).toString();
  return h('td', { class: 'mono path-cell' },
    h('span', { class: 'p' }, s.path),
    query ? h('span', { class: 'q muted' }, `?${decodeURIComponentSafe(query)}`) : null,
    s.fault ? h('span', { class: 'badge fault sm', title: s.fault }, 'fault') : null,
    s.notes ? h('span', { class: 'badge note sm', title: `${s.notes} note(s) - open for details` }, `${s.notes} note${s.notes > 1 ? 's' : ''}`) : null);
}
function decodeURIComponentSafe(s) { try { return decodeURIComponent(s); } catch { return s; } }

function timeCell(ts) {
  const td = h('td', { class: 'mono nowrap time' }, fmtClock(ts));
  td.addEventListener('mouseenter', () => { td.title = `${fmtFull(ts)} - ${fmtRel(ts)}`; });
  return td;
}

function fullRow(s) {
  return h('tr', { tabindex: '0', 'data-id': s.id, class: s.status >= 400 ? 'row-err' : s.isError ? 'row-warn' : '' },
    timeCell(s.ts),
    h('td', methodBadge(s.method)),
    pathCell(s),
    h('td', { class: 'sect' }, s.section === 'unmatched' ? h('span', { class: 'muted' }, 'unmatched') : s.section),
    h('td', statusBadge(s.status, s.isError)),
    h('td', { class: 'num mono nowrap' }, fmtMs(s.durationMs)),
    h('td', { class: 'num mono nowrap' }, fmtBytes(s.bytes)));
}

// ---------------------------------------------------------------------------------------------
// Requests screen
// ---------------------------------------------------------------------------------------------
export function renderRequests(root, ctx) {
  const params = new URLSearchParams(ctx.query || '');
  const f = { section: params.get('section') || '', method: params.get('method') || '', status: params.get('status') || '', q: params.get('q') || '' };
  let items = []; let total = 0; let pending = []; let selected = null; let seq = 0;

  const sel = (name, opts, value) => h('select', { 'aria-label': name, value, onchange: (e) => { f[name.toLowerCase()] = e.target.value; reload(); } },
    opts.map(([v, l]) => h('option', { value: v }, l)));
  const sectionOpts = [['', 'All sections'], ...modules().map((m) => [m.title, m.title]), ['unmatched', 'Unmatched']];
  const methodOpts = [['', 'All methods'], ...['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].map((m) => [m, m])];
  const statusOpts = [['', 'Any status'], ['ok', 'OK (no error)'], ['error', 'Errors'], ['2xx', '2xx'], ['4xx', '4xx'], ['5xx', '5xx']];

  const search = h('input', { type: 'search', placeholder: 'Search path, request or response body...', 'aria-label': 'Search', value: f.q, oninput: debounce(() => { f.q = search.value.trim(); reload(); }, 250) });
  const countEl = h('span', { class: 'muted small' });
  const newBar = h('button', { type: 'button', class: 'newbar', hidden: true, onclick: () => flushPending() });
  const tbody = h('tbody', { onclick: (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) select(tr.dataset.id, true); } });
  const wrap = h('div', { class: 'table-wrap grow' },
    h('table', { class: 'tbl req-tbl' },
      h('thead', h('tr', ['Time', 'Method', 'Path', 'Section', 'Status', 'Time taken', 'Size'].map((c, i) => h('th', { class: i > 4 ? 'num' : '' }, c)))), tbody));
  const empty = h('div', { class: 'pad' });

  const clearBtn = h('button', { type: 'button', class: 'btn danger-ghost', onclick: async () => {
    if (!(await confirmBox('Clear the whole request log?', { danger: true, okLabel: 'Clear log' }))) return;
    await api('DELETE', '/requests'); toast('Request log cleared'); reload();
  } }, icon('trash', 14), 'Clear log');

  replace(root, h('section', { class: 'page page-requests' },
    h('div', { class: 'page-head' }, h('h1', 'Requests'), h('p', { class: 'muted' }, 'Every call made to the dummy API, live. Click a row for the full request, response and validation notes.')),
    h('div', { class: 'toolbar' },
      sel('Section', sectionOpts, f.section), sel('Method', methodOpts, f.method), sel('Status', statusOpts, f.status), search,
      h('span', { class: 'spacer' }), countEl, clearBtn),
    newBar, wrap, empty));

  const rowFor = (id) => tbody.querySelector(`tr[data-id="${id}"]`);

  function matches(s) {
    if (f.section && s.section !== f.section) return false;
    if (f.method && s.method !== f.method) return false;
    if (f.status) {
      const st = f.status;
      if (st === 'error' && !(s.isError || s.status >= 400)) return false;
      if (st === 'ok' && (s.isError || s.status >= 400)) return false;
      if (/^\dxx$/.test(st) && Math.floor(s.status / 100) !== Number(st[0])) return false;
    }
    if (f.q) {
      const n = f.q.toLowerCase();
      if (!(`${s.path} ${s.route || ''} ${(s.messages || []).join(' ')}`.toLowerCase().includes(n))) return false; // bodies unknown client-side
    }
    return true;
  }

  function paintEmpty() {
    clear(empty);
    if (items.length) return;
    const filtered = f.section || f.method || f.status || f.q;
    empty.append(filtered
      ? emptyState('No requests match these filters', 'Clear the filters to see everything.')
      : emptyState('No requests yet', `Point your integration at ${baseUrl()} (any Basic credentials) or use a generator on a section page.`));
  }
  function paintCount() { countEl.textContent = total > items.length ? `${fmtNum(items.length)} shown of ${fmtNum(total)}` : `${fmtNum(total)} request${total === 1 ? '' : 's'}`; }

  async function reload() {
    const my = ++seq;
    pending = []; paintPending();
    try {
      const r = await api('GET', `/requests${qs({ ...f, limit: 200 })}`, undefined, { quiet: true });
      if (my !== seq) return;
      items = r.items || []; total = r.total ?? items.length;
      replace(tbody, items.map(fullRow));
      if (selected && rowFor(selected)) rowFor(selected).classList.add('selected');
      paintEmpty(); paintCount();
    } catch (e) { toast(`Could not load requests: ${e.message}`, 'err'); }
  }

  function paintPending() {
    newBar.hidden = !pending.length;
    newBar.textContent = `${pending.length} new request${pending.length === 1 ? '' : 's'} - click to show`;
  }
  function prepend(list) {
    for (const s of list.slice().reverse()) { items.unshift(s); tbody.prepend(fullRow(s)); }
    while (tbody.children.length > MAX_ROWS) { tbody.lastChild.remove(); items.pop(); }
    total += list.length;
    paintEmpty(); paintCount();
  }
  function flushPending() { const p = pending; pending = []; paintPending(); prepend(p); wrap.scrollTop = 0; }

  ctx.onCleanup(on('request', (s) => {
    if (!matches(s)) return;
    if (wrap.scrollTop > 40) { pending.unshift(s); paintPending(); return; } // user is reading further down: don't move rows
    prepend([s]);
  }));
  ctx.onCleanup(on('live', (l) => { if (l.reconnected) reload(); }));

  function select(id, open) {
    if (selected) rowFor(selected)?.classList.remove('selected');
    selected = id;
    const tr = rowFor(id);
    tr?.classList.add('selected');
    tr?.scrollIntoView({ block: 'nearest' });
    if (open || isDrawerOpen()) openRequestDrawer(id, items.find((x) => String(x.id) === String(id)), () => { /* keep selection highlight */ });
  }
  function move(delta) {
    const rows = [...tbody.querySelectorAll('tr[data-id]')];
    if (!rows.length) return;
    const i = rows.findIndex((r) => r.dataset.id === String(selected));
    const next = rows[Math.min(rows.length - 1, Math.max(0, i < 0 ? 0 : i + delta))];
    select(next.dataset.id, false);
    next.focus({ preventScroll: true });
  }
  const keyHandler = (e) => {
    const t = e.target;
    if (t.matches?.('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
    if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter' && t.matches?.('tr[data-id]')) { select(t.dataset.id, true); }
  };
  document.addEventListener('keydown', keyHandler);
  ctx.onCleanup(() => { document.removeEventListener('keydown', keyHandler); closeDrawer(); });

  reload();
}

// ---------------------------------------------------------------------------------------------
// Compact "recent requests" list for section pages
// ---------------------------------------------------------------------------------------------
export function recentRequests(ctx, sectionTitle, limit = 15) {
  let items = [];
  const list = h('div', { class: 'recent-list' });
  const paint = () => {
    if (!items.length) return replace(list, emptyState('No requests for this section yet', `Call an endpoint of this section on ${baseUrl()}.`));
    replace(list, items.map((s) => h('button', { type: 'button', class: 'recent-row', 'data-id': s.id, onclick: () => openRequestDrawer(s.id, s) },
      h('span', { class: 'mono muted' }, fmtClock(s.ts)), methodBadge(s.method),
      h('span', { class: 'mono path-cell' }, h('span', { class: 'p' }, s.route || s.path), s.fault ? h('span', { class: 'badge fault sm' }, 'fault') : null),
      statusBadge(s.status, s.isError), h('span', { class: 'mono muted num' }, fmtMs(s.durationMs)))));
  };
  const load = async () => {
    try { items = (await api('GET', `/requests${qs({ section: sectionTitle, limit })}`, undefined, { quiet: true })).items || []; paint(); } catch { /* shown empty */ }
  };
  ctx.onCleanup(on('request', (s) => { if (s.section !== sectionTitle) return; items.unshift(s); items = items.slice(0, limit); paint(); }));
  ctx.onCleanup(on('live', (l) => { if (l.reconnected) load(); }));
  paint(); load();
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', 'Recent requests'), h('a', { class: 'small', href: `#/requests?section=${encodeURIComponent(sectionTitle)}` }, 'View all')),
    list);
}
