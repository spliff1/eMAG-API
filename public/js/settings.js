// Settings screen (bound to GET/PUT /settings) + data management card.
import { h, replace, toast, confirmBox } from './dom.js';
import { api, state, setSettings, loadMeta } from './api.js';

const METHODS = ['*', 'GET', 'POST', 'PATCH', 'PUT', 'DELETE'];
const PRESETS = [
  { label: '429 on orders', rule: { method: '*', path: '/order/*', status: 429, body: '', delayMs: 0, remaining: -1 } },
  { label: '500 on awb/save', rule: { method: 'POST', path: '/awb/save', status: 500, body: '', delayMs: 0, remaining: -1 } },
  { label: '401 everywhere', rule: { method: '*', path: '*', status: 401, body: '', delayMs: 0, remaining: -1 } },
  { label: '503 once (any call)', rule: { method: '*', path: '*', status: 503, body: '', delayMs: 0, remaining: 1 } },
  { label: '403 IP not whitelisted', rule: { method: '*', path: '*', status: 403, body: '', delayMs: 0, remaining: -1 } },
];
const RATE_LABELS = { orders: 'Orders (order/*)', ean: 'find_by_eans', default: 'Everything else (cumulated)' };

export function renderSettings(root, ctx) {
  const draft = JSON.parse(JSON.stringify(state.settings || {}));
  draft.auth ||= { mode: 'any', users: [] }; draft.auth.users ||= [];
  draft.rateLimit ||= { enabled: true }; draft.faults ||= [];
  const meta = state.meta || {};

  const num = (v, d) => (v === '' || Number.isNaN(Number(v)) ? d : Number(v));
  const field = (label, input, hint) => h('div', { class: 'field' }, h('label', { for: input.id }, label), input, hint ? h('div', { class: 'hint' }, hint) : null);
  const check = (id, label, checked, onchange, hint) => h('div', { class: 'field check' },
    h('input', { id, type: 'checkbox', checked, onchange: (e) => onchange(e.target.checked) }), h('label', { for: id }, label), hint ? h('div', { class: 'hint' }, hint) : null);

  // ---- general ----
  const platform = h('select', { id: 's-platform', value: draft.platform, onchange: (e) => { draft.platform = e.target.value; } },
    (meta.platforms || []).map((p) => h('option', { value: p.id }, `${p.label} (${p.currency})`)));
  const authMode = h('select', { id: 's-auth', value: draft.auth.mode, onchange: (e) => { draft.auth.mode = e.target.value; paintUsers(); } },
    h('option', { value: 'any' }, 'Any credentials accepted'), h('option', { value: 'strict' }, 'Strict: only listed users'));
  const usersBox = h('div', { class: 'users' });
  function paintUsers() {
    usersBox.hidden = draft.auth.mode !== 'strict';
    replace(usersBox, h('div', { class: 'small muted' }, 'Accepted HTTP Basic users (401 otherwise):'),
      draft.auth.users.map((u, i) => h('div', { class: 'row-inline' },
        h('input', { type: 'text', placeholder: 'username', 'aria-label': 'Username', value: u.username, autocomplete: 'off', oninput: (e) => { u.username = e.target.value; } }),
        h('input', { type: 'text', placeholder: 'password', 'aria-label': 'Password', value: u.password, autocomplete: 'off', oninput: (e) => { u.password = e.target.value; } }),
        h('button', { type: 'button', class: 'btn sm danger-ghost', onclick: () => { draft.auth.users.splice(i, 1); paintUsers(); } }, 'Remove'))),
      h('button', { type: 'button', class: 'btn sm', onclick: () => { draft.auth.users.push({ username: '', password: '' }); paintUsers(); } }, 'Add user'));
  }
  paintUsers();

  const general = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', 'General')),
    h('div', { class: 'form-grid' },
      field('Platform', platform, 'Currency, locale and country used by generated data.'),
      field('Authentication', authMode, 'The real API uses HTTP Basic auth.'),
      h('div', { class: 'span-all' }, usersBox),
      field('Documentation auto-approval (seconds)', h('input', { id: 's-approve', type: 'number', min: 0, value: draft.autoApproveSeconds ?? 20, oninput: (e) => { draft.autoApproveSeconds = num(e.target.value, 0); } }),
        'Documentation validation becomes "approved" after this delay. 0 = never, approve manually from the data browser.'),
      field('Added latency (ms)', h('input', { id: 's-lat', type: 'number', min: 0, value: draft.latencyMs ?? 0, oninput: (e) => { draft.latencyMs = num(e.target.value, 0); } }), 'Delay applied to every API response.'),
      field('Random error rate (%)', h('input', { id: 's-err', type: 'number', min: 0, max: 100, step: 'any', value: draft.errorRate ?? 0, oninput: (e) => { draft.errorRate = num(e.target.value, 0); } }), '% of requests answered with a random 500/502/503.'),
      check('s-rl', 'Enforce rate limits', !!draft.rateLimit.enabled, (v) => { draft.rateLimit.enabled = v; }, 'Answers HTTP 429 above the production limits (see table below).'),
      check('s-awb', 'Issuing an AWB finalizes the order', draft.awbFinalizesOrder !== false, (v) => { draft.awbFinalizesOrder = v; }, 'awb/save (and "Generate dummy AWB") moves the order to status 4 (Finalized).'),
      check('s-strict', 'Strict business rules', !!draft.strictRules, (v) => { draft.strictRules = v; }, 'Enforce production business rules: status transitions, mandatory fields, ...')));

  // ---- faults ----
  const faultBox = h('div', { class: 'table-wrap' });
  function paintFaults() {
    if (!draft.faults.length) { replace(faultBox, h('div', { class: 'empty small' }, h('strong', 'No fault rules'), h('span', 'Add one below or start from a preset.'))); return; }
    const inp = (f, key, type, extra = {}) => h('input', { type, value: f[key] ?? '', 'aria-label': key, ...extra,
      oninput: (e) => { f[key] = type === 'number' ? num(e.target.value, 0) : e.target.value; } });
    replace(faultBox, h('table', { class: 'tbl fault-tbl' },
      h('thead', h('tr', ['On', 'Method', 'Path', 'Status', 'Body (JSON, optional)', 'Delay ms', 'Uses left', ''].map((c) => h('th', c)))),
      h('tbody', draft.faults.map((f, i) => h('tr',
        h('td', h('input', { type: 'checkbox', checked: !!f.enabled, 'aria-label': 'Enabled', onchange: (e) => { f.enabled = e.target.checked; } })),
        h('td', h('select', { 'aria-label': 'Method', value: f.method || '*', onchange: (e) => { f.method = e.target.value; } }, METHODS.map((m) => h('option', { value: m }, m)))),
        h('td', inp(f, 'path', 'text', { placeholder: '/order/read, /order/*, *', class: 'mono' })),
        h('td', inp(f, 'status', 'number', { min: 100, max: 599, class: 'w-s' })),
        h('td', inp(f, 'body', 'text', { placeholder: '{"isError":true,"messages":["..."]}', class: 'mono' })),
        h('td', inp(f, 'delayMs', 'number', { min: 0, class: 'w-s' })),
        h('td', inp(f, 'remaining', 'number', { min: -1, class: 'w-s', title: '-1 = unlimited' })),
        h('td', h('button', { type: 'button', class: 'btn sm danger-ghost', onclick: () => { draft.faults.splice(i, 1); paintFaults(); } }, 'Remove')))))));
  }
  paintFaults();
  const addFault = (rule) => { draft.faults.push({ id: `f-${Date.now()}${draft.faults.length}`, enabled: true, method: '*', path: '*', status: 500, body: '', delayMs: 0, remaining: -1, ...rule }); paintFaults(); };

  const faults = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', 'Fault injection')),
    h('p', { class: 'muted' }, 'Rules are checked in order; the first enabled match answers the request instead of the real handler. Paths are relative to /api-3 and accept * wildcards. Unsaved changes are applied with "Save settings".'),
    faultBox,
    h('div', { class: 'toolbar' }, h('button', { type: 'button', class: 'btn', onclick: () => addFault({}) }, 'Add rule'),
      h('span', { class: 'muted small' }, 'Presets:'), PRESETS.map((p) => h('button', { type: 'button', class: 'btn sm ghost', onclick: () => addFault(p.rule) }, p.label))));

  // ---- rate limits ----
  const limits = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', 'Rate limits (reference)')),
    h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('thead', h('tr', h('th', 'Group'), h('th', { class: 'num' }, 'Per second'), h('th', { class: 'num' }, 'Per minute'))),
      h('tbody', Object.entries(meta.limits || {}).map(([g, l]) => h('tr', h('td', RATE_LABELS[g] || g), h('td', { class: 'num mono' }, l.perSec), h('td', { class: 'num mono' }, l.perMin)))))));

  // ---- data ----
  const file = h('input', { type: 'file', accept: 'application/json,.json', id: 's-import', class: 'visually-hidden', onchange: async () => {
    const f = file.files[0]; if (!f) return;
    try {
      const snap = JSON.parse(await f.text());
      if (!(await confirmBox(`Replace ALL data with the contents of "${f.name}"?`, { danger: true, okLabel: 'Import' }))) return;
      await api('POST', '/import', snap); toast('Snapshot imported'); await loadMeta();
    } catch (e) { toast(`Import failed: ${e.message}`, 'err'); } finally { file.value = ''; }
  } });
  const data = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', 'Data')),
    h('div', { class: 'data-actions' },
      h('a', { class: 'btn', href: '/__ui/api/export', download: '' }, 'Export snapshot'),
      h('label', { class: 'btn', for: 's-import', tabindex: '0', role: 'button', onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } } }, 'Import snapshot...'), file,
      h('button', { type: 'button', class: 'btn danger', onclick: async () => {
        if (!(await confirmBox('Wipe all data (orders, products, ...) and re-seed the reference data?', { danger: true, okLabel: 'Reset data' }))) return;
        try { await api('POST', '/reset'); toast('Data reset and re-seeded'); await loadMeta(); } catch { /* toast */ }
      } }, 'Reset all data & re-seed'),
      h('button', { type: 'button', class: 'btn danger', onclick: async () => {
        if (!(await confirmBox('Restore all settings (auth, faults, callbacks, ...) to their defaults?', { danger: true, okLabel: 'Reset settings' }))) return;
        try { setSettings(await api('POST', '/settings/reset')); toast('Settings reset'); renderSettings(root, ctx); } catch { /* toast */ }
      } }, 'Reset settings')));

  async function save() {
    const faultsOut = draft.faults.map((f) => ({ ...f, status: num(f.status, 500), delayMs: num(f.delayMs, 0), remaining: num(f.remaining, -1) }));
    const body = {
      platform: draft.platform, auth: { mode: draft.auth.mode, users: draft.auth.users.filter((u) => u.username) },
      rateLimit: { enabled: !!draft.rateLimit.enabled }, strictRules: !!draft.strictRules, awbFinalizesOrder: draft.awbFinalizesOrder !== false,
      autoApproveSeconds: draft.autoApproveSeconds, latencyMs: draft.latencyMs, errorRate: draft.errorRate, faults: faultsOut,
    };
    try { setSettings(await api('PUT', '/settings', body)); toast('Settings saved'); renderSettings(root, ctx); } catch { /* toast */ }
  }

  replace(root, h('section', { class: 'page' },
    h('div', { class: 'page-head' }, h('h1', 'Settings'), h('p', { class: 'muted' }, 'Behaviour of the dummy API. Changes apply to new requests immediately.')),
    general, faults, limits, data,
    h('div', { class: 'savebar' }, h('span', { class: 'muted small' }, 'Callbacks are configured on the Callbacks page.'), h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn', onclick: () => renderSettings(root, ctx) }, 'Discard changes'),
      h('button', { type: 'button', class: 'btn primary', onclick: save }, 'Save settings'))));
}
