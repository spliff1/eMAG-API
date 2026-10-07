// Callbacks section: config card bound to settings.callbacks + the generic section parts.
import { h, replace, toast, fmtNum } from './dom.js';
import { api, state, setSettings } from './api.js';
import { renderSection } from './section.js';

export function renderCallbacks(root, ctx, mod) {
  renderSection(root, ctx, mod, { top: configCard() });
}

function configCard() {
  const cfg = state.settings?.callbacks || {};
  const events = state.meta?.callbackEvents || [];
  const rows = events.map((ev) => {
    const cur = cfg.events?.[ev.id] || { enabled: false, url: '' };
    const enabled = h('input', { type: 'checkbox', id: `cb-en-${ev.id}`, checked: !!cur.enabled, 'aria-label': `Enable ${ev.label}` });
    const url = h('input', { type: 'url', id: `cb-url-${ev.id}`, placeholder: 'https://your-erp.example/hooks/emag', value: cur.url || '', 'aria-label': `URL for ${ev.label}`, autocomplete: 'off' });
    const result = h('div', { class: 'cb-result small', role: 'status' });
    const testBtn = h('button', { type: 'button', class: 'btn sm', title: 'Saves the configuration, then POSTs a sample payload', onclick: async () => {
      testBtn.disabled = true; replace(result, h('span', { class: 'muted' }, 'Sending...'));
      try {
        await save(true);
        const r = await api('POST', '/callbacks/test', { event: ev.id });
        const ok = r?.ok !== false && !r?.error;
        replace(result, h('span', { class: `badge ${ok ? 's-ok' : 's-err'}` }, ok ? 'ok' : 'failed'),
          r?.status != null ? h('span', { class: 'mono' }, ` HTTP ${r.status}`) : null,
          r?.durationMs != null ? h('span', { class: 'muted' }, ` ${r.durationMs} ms`) : null,
          r?.error ? h('span', { class: 'err-text' }, ` ${r.error}`) : null,
          h('details', { class: 'small' }, h('summary', 'raw result'), h('pre', { class: 'raw' }, JSON.stringify(r, null, 2))));
      } catch (e) { replace(result, h('span', { class: 'badge s-err' }, 'failed'), h('span', { class: 'err-text' }, ` ${e.message}`)); } finally { testBtn.disabled = false; }
    } }, 'Send test');
    return { ev, enabled, url, el: h('div', { class: 'cb-row' },
      h('div', { class: 'cb-ev' }, h('label', { class: 'switch' }, enabled, h('span', { class: 'track' })), h('label', { for: `cb-en-${ev.id}` }, h('strong', ev.label), h('span', { class: 'mono muted small' }, ev.id))),
      url, testBtn, result) };
  });

  const timeout = h('input', { type: 'number', id: 'cb-timeout', min: 100, step: 100, value: cfg.timeoutMs ?? 10000 });
  const user = h('input', { type: 'text', id: 'cb-user', autocomplete: 'off', value: cfg.basicAuth?.username || '' });
  const pass = h('input', { type: 'password', id: 'cb-pass', autocomplete: 'new-password', value: cfg.basicAuth?.password || '' });

  async function save(quiet) {
    const body = { callbacks: {
      timeoutMs: Number(timeout.value) || 10000,
      basicAuth: { username: user.value, password: pass.value },
      events: Object.fromEntries(rows.map((r) => [r.ev.id, { enabled: r.enabled.checked, url: r.url.value.trim() }])),
    } };
    const s = await api('PUT', '/settings', body);
    setSettings(s);
    if (!quiet) toast('Callback settings saved');
  }

  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', 'Callback configuration')),
    h('p', { class: 'muted' }, 'When something happens (e.g. an order is generated), the dummy POSTs the entity JSON to the URLs enabled below. Deliveries are listed in the callback log underneath.'),
    h('div', { class: 'cb-list' }, rows.map((r) => r.el)),
    h('div', { class: 'cb-global' },
      h('div', { class: 'field' }, h('label', { for: 'cb-timeout' }, 'Timeout (ms)'), timeout),
      h('div', { class: 'field' }, h('label', { for: 'cb-user' }, 'Basic auth username (optional)'), user),
      h('div', { class: 'field' }, h('label', { for: 'cb-pass' }, 'Basic auth password'), pass)),
    h('div', { class: 'card-foot' }, h('button', { type: 'button', class: 'btn primary', onclick: () => save(false).catch(() => {}) }, 'Save callback settings')));
}
