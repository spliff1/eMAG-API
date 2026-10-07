// Tiny DOM helpers: h() element builder, toasts, modals, formatters, parameter forms.
// All dynamic text goes through textContent / text nodes - never innerHTML.

const PROPS = new Set(['value', 'checked', 'disabled', 'hidden', 'selected', 'open', 'readOnly', 'indeterminate']);

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props != null && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) { kids.unshift(props); props = null; }
  const late = [];
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (PROPS.has(k)) late.push([k, v]); // set after children (e.g. <select>.value)
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, kids);
  for (const [k, v] of late) el[k] = v;
  return el;
}

export function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
export const replace = (el, ...kids) => append(clear(el), kids);

// ---- icons (static, trusted SVG strings) --------------------------------------------------
const ICONS = {
  list: '<path d="M3 4h10M3 8h10M3 12h6"/>',
  box: '<path d="M2.5 5 8 2l5.5 3v6L8 14l-5.5-3z M2.5 5 8 8l5.5-3M8 8v6"/>',
  gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>',
  bell: '<path d="M4 11V7a4 4 0 1 1 8 0v4l1 1.5H3zM6.5 14h3"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/>',
  moon: '<path d="M13 9.5A5.5 5.5 0 0 1 6.5 3 5.5 5.5 0 1 0 13 9.5z"/>',
  menu: '<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  chev: '<path d="M6 3.5 10.5 8 6 12.5"/>',
  download: '<path d="M8 2.5v8M4.5 7.5 8 11l3.5-3.5M3 13.5h10"/>',
  logout: '<path d="M6.5 2.5h-3v11h3M10 5l3 3-3 3M13 8H6"/>',
  link: '<path d="M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1"/>',
};
export function icon(name, size = 16) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('width', size); s.setAttribute('height', size);
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.4');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name] || ''; // constant strings above only
  return s;
}

// ---- formatters -----------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
export function fmtClock(ts) {
  const d = new Date(ts);
  return Number.isNaN(+d) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
export function fmtFull(ts) {
  const d = new Date(ts);
  return Number.isNaN(+d) ? String(ts ?? '') : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${fmtClock(ts)}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}
export function fmtRel(ts) {
  const s = Math.round((Date.now() - new Date(ts)) / 1000);
  if (!Number.isFinite(s)) return '';
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export function fmtBytes(n) {
  if (n == null || Number.isNaN(+n)) return '';
  n = +n;
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
export const fmtMs = (n) => (n == null ? '' : n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`);
export const fmtNum = (n) => (Number.isFinite(+n) ? Number(n).toLocaleString() : '0');

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

/** Resolve a dotted path ("customer.name", "items.0.sku") on an object. */
export function getPath(obj, path) {
  let cur = obj;
  for (const k of String(path).split('.')) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}

// ---- badges -------------------------------------------------------------------------------
export const methodBadge = (m) => h('span', { class: `badge m-${String(m || '').toLowerCase()}` }, m || '?');

export function statusBadge(status, isError) {
  const cls = status >= 400 ? 'err' : isError ? 'warn' : 'ok';
  const title = status >= 400 ? 'HTTP error' : isError ? 'HTTP 2xx but body has isError=true' : 'OK';
  return h('span', { class: `badge s-${cls}`, title }, status ?? '-');
}

// ---- clipboard & toasts ---------------------------------------------------------------------
export async function copyText(text, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
    ta.value = text; document.body.append(ta); ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
  }
  toast(what);
}

export function toast(msg, kind = 'ok', ms = 3500) {
  const box = document.getElementById('toasts');
  const t = h('div', { class: `toast ${kind}`, role: kind === 'err' ? 'alert' : 'status' }, String(msg));
  box.append(t);
  while (box.children.length > 5) box.firstChild.remove();
  setTimeout(() => t.remove(), kind === 'err' ? Math.max(ms, 6000) : ms);
}

// ---- modal dialogs ------------------------------------------------------------------------
/** Generic modal. Returns a promise resolved with the value passed to close(). */
export function modal({ title, body, actions }) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'modal', 'aria-label': title });
    const close = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(undefined); });
    append(dlg, [
      h('h3', title),
      h('div', { class: 'modal-body' }, body),
      h('div', { class: 'modal-actions' }, (actions || []).map((a) => h('button', {
        type: 'button', class: `btn ${a.kind || ''}`, onclick: () => a.onClick ? a.onClick(close) : close(a.value),
      }, a.label))),
    ]);
    document.body.append(dlg);
    dlg.showModal();
    (dlg.querySelector('[data-autofocus]') || dlg.querySelector('.btn:last-child'))?.focus();
  });
}

export async function confirmBox(message, { danger = false, okLabel = 'Confirm', title = 'Are you sure?' } = {}) {
  const r = await modal({
    title, body: h('p', message),
    actions: [{ label: 'Cancel', value: false }, { label: okLabel, value: true, kind: danger ? 'danger' : 'primary' }],
  });
  return r === true;
}

// ---- generic parameter forms (generators / row actions) --------------------------------------
const optList = (p) => (p.options || []).map((o) => (o && typeof o === 'object' ? { value: o.value, label: o.label ?? String(o.value) } : { value: o, label: String(o) }));

/** Build a form from [{name,label,type,default,min,max,options}] -> { el, values() } */
export function paramForm(params = [], { idPrefix = 'p' } = {}) {
  const fields = [];
  const el = h('div', { class: 'params' });
  params.forEach((p, i) => {
    const id = `${idPrefix}-${p.name}-${i}`;
    const type = p.type || (p.options ? 'select' : typeof p.default === 'number' ? 'number' : typeof p.default === 'boolean' ? 'boolean' : 'text');
    let input; let read;
    if (type === 'select') {
      const opts = optList(p);
      input = h('select', { id, value: String(p.default ?? opts[0]?.value ?? '') }, opts.map((o) => h('option', { value: String(o.value) }, o.label)));
      read = () => { const o = opts.find((x) => String(x.value) === input.value); return o ? o.value : input.value; };
    } else if (type === 'boolean') {
      input = h('input', { id, type: 'checkbox', checked: !!p.default });
      read = () => input.checked;
    } else if (type === 'number') {
      input = h('input', { id, type: 'number', value: p.default ?? '', min: p.min, max: p.max, step: p.step ?? 'any' });
      read = () => (input.value === '' ? undefined : Number(input.value));
    } else {
      input = h('input', { id, type: 'text', value: p.default ?? '', placeholder: p.placeholder, autocomplete: 'off' });
      read = () => (input.value === '' ? undefined : input.value);
    }
    fields.push({ name: p.name, read });
    el.append(h('div', { class: `field${type === 'boolean' ? ' check' : ''}` },
      type === 'boolean' ? [input, h('label', { for: id }, p.label || p.name)] : [h('label', { for: id }, p.label || p.name), input]));
  });
  return {
    el,
    values() {
      const o = {};
      for (const f of fields) { const v = f.read(); if (v !== undefined && !(typeof v === 'number' && Number.isNaN(v))) o[f.name] = v; }
      return o;
    },
  };
}

/** Modal asking for params; resolves with values or null if cancelled. */
export async function askParams(title, params, okLabel = 'Run', danger = false) {
  const form = paramForm(params, { idPrefix: 'ask' });
  const r = await modal({
    title, body: form.el,
    actions: [{ label: 'Cancel', value: null }, { label: okLabel, kind: danger ? 'danger' : 'primary', onClick: (close) => close(form.values()) }],
  });
  return r ?? null;
}

export function emptyState(title, hint) {
  return h('div', { class: 'empty' }, h('strong', title), hint ? h('span', hint) : null);
}
