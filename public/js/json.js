// Safe, lazy, collapsible JSON viewer (builds DOM nodes; never uses innerHTML).
import { h, fmtBytes, copyText } from './dom.js';

const PAGE = 100;        // array/object children rendered per chunk
const STR_MAX = 400;     // long strings are cut with an expander

const isContainer = (v) => v !== null && typeof v === 'object';

function prim(v) {
  if (v === null) return h('span', { class: 'jz' }, 'null');
  if (typeof v === 'string') {
    if (v.length <= STR_MAX) return h('span', { class: 'js' }, JSON.stringify(v));
    const span = h('span', { class: 'js' }, JSON.stringify(v.slice(0, STR_MAX)).slice(0, -1) + '…"');
    const more = h('button', { type: 'button', class: 'jmore' }, `show ${v.length - STR_MAX} more chars`);
    more.onclick = () => { span.textContent = JSON.stringify(v); more.remove(); };
    return h('span', span, ' ', more);
  }
  if (typeof v === 'number') return h('span', { class: 'jn' }, String(v));
  if (typeof v === 'boolean') return h('span', { class: 'jb' }, String(v));
  return h('span', String(v));
}

const keyEl = (k) => (k == null ? null : [h('span', { class: 'jk' }, JSON.stringify(String(k))), ': ']);

function build(key, val, depth, comma) {
  const c = comma ? ',' : '';
  if (!isContainer(val)) return h('div', { class: 'jl' }, keyEl(key), prim(val), c);

  const isArr = Array.isArray(val);
  const keys = isArr ? null : Object.keys(val);
  const n = isArr ? val.length : keys.length;
  const [o, cl] = isArr ? ['[', ']'] : ['{', '}'];
  if (n === 0) return h('div', { class: 'jl' }, keyEl(key), o + cl, c);

  const startOpen = depth === 0 || (depth <= 2 && n <= 50);
  const wrap = h('div', { class: 'jc' });
  const toggle = h('button', { type: 'button', class: 'jt', 'aria-label': 'Toggle', 'aria-expanded': 'false' });
  const body = h('div', { class: 'jbody' });
  const summary = h('span', { class: 'jsum' }, ` ${n} ${isArr ? 'item' : 'key'}${n === 1 ? '' : 's'} ${cl}${c}`);
  let built = false;

  function fill() {
    built = true;
    let shown = 0;
    const renderChunk = () => {
      const end = Math.min(shown + PAGE, n);
      for (let i = shown; i < end; i++) {
        const k = isArr ? null : keys[i];
        body.insertBefore(build(isArr ? null : k, isArr ? val[i] : val[k], depth + 1, i < n - 1), moreBtn);
      }
      shown = end;
      moreBtn.hidden = shown >= n;
      moreBtn.textContent = `… ${n - shown} more ${isArr ? 'items' : 'keys'}`;
    };
    const moreBtn = h('button', { type: 'button', class: 'jmore jl', onclick: renderChunk, hidden: true });
    body.append(moreBtn, h('div', { class: 'jl' }, cl, c));
    renderChunk();
  }
  function setOpen(open) {
    wrap.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
    if (open && !built) fill();
  }
  toggle.onclick = (e) => { setOpen(!wrap.classList.contains('open')); e.stopPropagation(); };
  const head = h('div', { class: 'jl jh' }, toggle, keyEl(key), o, summary);
  head.addEventListener('dblclick', () => toggle.click());
  wrap.append(head, body);
  setOpen(startOpen);
  return wrap;
}

/** Render any JSON value. Understands the request-log placeholders {__truncated} / {__binary}. */
export function jsonView(value) {
  const root = h('div', { class: 'json' });
  if (value && value.__truncated) {
    root.append(h('div', { class: 'note-box warn' }, `Body truncated in the log (${fmtBytes(value.bytes)}); showing the first characters only.`),
      h('pre', { class: 'raw' }, String(value.preview ?? '')));
  } else if (value && value.__binary) {
    root.append(h('div', { class: 'note-box' }, `Binary response: ${value.contentType || 'unknown type'}, ${fmtBytes(value.bytes)}`));
  } else if (value === undefined) {
    root.append(h('span', { class: 'muted' }, '(empty)'));
  } else if (typeof value === 'string') {
    root.append(h('pre', { class: 'raw' }, value));
  } else {
    root.append(build(null, value, 0, false));
  }
  return root;
}

/** Text to put on the clipboard for a body value. */
export function jsonText(value) {
  if (value === undefined) return '';
  if (value && value.__truncated) return String(value.preview ?? '');
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

/** A titled block (header with Copy button + viewer). */
export function jsonBlock(title, value, { open = true, meta } = {}) {
  const empty = value === undefined || (value && typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length && !value.__binary);
  const d = h('details', { class: 'block', open: open && !empty });
  d.append(h('summary', {},
    h('span', { class: 'block-title' }, title),
    meta ? h('span', { class: 'muted small' }, meta) : null,
    empty ? null : h('button', { type: 'button', class: 'btn sm ghost', onclick: (e) => { e.preventDefault(); copyText(jsonText(value), `${title} copied`); } }, 'Copy')));
  d.append(empty ? h('div', { class: 'muted pad-s' }, '(empty)') : jsonView(value));
  return d;
}
