// Single right-hand drawer used for request details and document viewing.
import { h, replace, icon } from './dom.js';

let root; let titleEl; let bodyEl; let actionsEl; let backdrop;
let lastFocus = null; let onClose = null; let token = 0;

function ensure() {
  if (root) return;
  backdrop = h('div', { class: 'backdrop', hidden: true, onclick: () => closeDrawer() });
  titleEl = h('div', { class: 'drawer-title' });
  actionsEl = h('div', { class: 'drawer-actions' });
  bodyEl = h('div', { class: 'drawer-body' });
  root = h('aside', { class: 'drawer', role: 'dialog', 'aria-modal': 'false', 'aria-label': 'Details', hidden: true, tabindex: '-1' },
    h('header', { class: 'drawer-head' }, titleEl, actionsEl,
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close details', title: 'Close (Esc)', 'data-close': '', onclick: () => closeDrawer() }, icon('close'))),
    bodyEl);
  document.body.append(backdrop, root);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !root.hidden && !document.querySelector('dialog[open]')) { e.preventDefault(); closeDrawer(); }
  });
}

export const isDrawerOpen = () => !!root && !root.hidden;

/** Opens (or re-targets) the drawer. Returns a token; pass it to setDrawer to ignore stale async results. */
export function openDrawer({ label, title, actions, body, close }) {
  ensure();
  if (root.hidden) lastFocus = document.activeElement;
  onClose = close || null;
  root.setAttribute('aria-label', label || 'Details');
  replace(titleEl, title);
  replace(actionsEl, actions);
  replace(bodyEl, body);
  bodyEl.scrollTop = 0;
  root.hidden = false; backdrop.hidden = false;
  document.body.classList.add('drawer-open');
  if (!root.contains(document.activeElement)) root.querySelector('[data-close]')?.focus();
  return ++token;
}

export function setDrawer(tok, { title, actions, body }) {
  if (tok !== token || !root || root.hidden) return false;
  if (title !== undefined) replace(titleEl, title);
  if (actions !== undefined) replace(actionsEl, actions);
  if (body !== undefined) { const st = bodyEl.scrollTop; replace(bodyEl, body); bodyEl.scrollTop = st; }
  return true;
}

export function closeDrawer() {
  if (!root || root.hidden) return;
  root.hidden = true; backdrop.hidden = true;
  document.body.classList.remove('drawer-open');
  token++;
  const cb = onClose; onClose = null;
  cb?.();
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  lastFocus = null;
}
