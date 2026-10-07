// Section pages: header + endpoints, generators, data browser (with document drawer), recent requests.
import { h, replace, clear, icon, methodBadge, copyText, toast, confirmBox, askParams, paramForm, debounce, getPath, fmtNum, emptyState } from './dom.js';
import { api, qs, on, loadMeta, moduleById } from './api.js';
import { jsonView, jsonText } from './json.js';
import { openDrawer, setDrawer, closeDrawer } from './drawer.js';
import { recentRequests } from './requests.js';

const PAGE_SIZE = 25;
const activeTab = new Map(); // module id -> collection name (remembered while navigating)

export function renderSection(root, ctx, mod, { top } = {}) {
  const page = h('section', { class: 'page' }, [
    h('div', { class: 'page-head' }, h('h1', mod.title), mod.description ? h('p', { class: 'muted' }, mod.description) : null),
    top || null,
    endpointsCard(mod),
    generatorsCard(mod),
    (mod.collections || []).length ? dataBrowser(ctx, mod) : null,
    recentRequests(ctx, mod.title)]);
  replace(root, page);
}

// ---------------------------------------------------------------------------------------------
function endpointsCard(mod) {
  const eps = mod.endpoints || [];
  if (!eps.length) return null;
  return h('details', { class: 'card collapsible' },
    h('summary', h('h2', `Endpoints`), h('span', { class: 'count' }, eps.length)),
    h('div', { class: 'ep-list' }, eps.map((e) => h('div', { class: 'ep' },
      methodBadge(e.method),
      h('span', { class: 'mono ep-path' }, e.path),
      h('span', { class: 'muted ep-sum' }, e.summary || e.name),
      h('span', { class: 'chip', title: 'Rate limit group' }, e.rateGroup || 'default'),
      h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': `Copy URL of ${e.method} ${e.path}`, title: 'Copy URL', onclick: () => copyText(location.origin + e.path, 'URL copied') }, icon('copy', 14))))));
}

// ---------------------------------------------------------------------------------------------
function generatorsCard(mod) {
  const gens = mod.generators || [];
  if (!gens.length) return null;
  const refresh = debounce(() => loadMeta().catch(() => {}), 400);
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', 'Generate dummy data')),
    h('div', { class: 'gens' }, gens.map((g) => {
      const form = paramForm(g.params || [], { idPrefix: `g-${g.id}` });
      const btn = h('button', { type: 'submit', class: 'btn primary' }, 'Generate');
      return h('form', { class: 'gen', onsubmit: async (e) => {
        e.preventDefault();
        btn.disabled = true;
        try {
          const r = await api('POST', `/generate/${mod.id}/${g.id}`, form.values());
          toast(r?.message || `Generated${r?.created != null ? ` ${r.created}` : ''}`);
          refresh();
        } catch { /* toast shown by api() */ } finally { btn.disabled = false; }
      } },
      h('div', { class: 'gen-title' }, h('strong', g.label || g.id), g.description ? h('span', { class: 'muted small' }, g.description) : null),
      form.el, btn);
    })));
}

// ---------------------------------------------------------------------------------------------
// Data browser
// ---------------------------------------------------------------------------------------------
function colSpec(c) { // column may be 'a.b' or {key|path|field, label}
  if (typeof c === 'string') return { path: c, label: c };
  const path = c.path || c.key || c.field || c.name;
  return { path, label: c.label || path };
}

function cell(v) {
  if (v === undefined || v === null || v === '') return h('span', { class: 'muted' }, '-');
  if (typeof v === 'boolean') return h('span', { class: `badge ${v ? 's-ok' : 'neutral'}` }, String(v));
  if (typeof v === 'object') {
    const s = JSON.stringify(v);
    return h('span', { class: 'mono small', title: s.length > 200 ? s.slice(0, 200) + '…' : s }, s.length > 48 ? s.slice(0, 48) + '…' : s);
  }
  const s = String(v);
  return h('span', { title: s.length > 60 ? s : null }, s.length > 60 ? s.slice(0, 60) + '…' : s);
}

function autoColumns(items, idField) {
  const keys = [];
  for (const d of items.slice(0, 20)) {
    for (const [k, v] of Object.entries(d)) {
      if (k.startsWith('_') || keys.includes(k) || (v !== null && typeof v === 'object')) continue;
      keys.push(k);
    }
  }
  const ordered = keys.includes(idField) ? [idField, ...keys.filter((k) => k !== idField)] : keys;
  return ordered.slice(0, 6);
}

function dataBrowser(ctx, mod) {
  const cols = mod.collections;
  let current = cols.find((c) => c.name === activeTab.get(mod.id)) || cols[0];
  let page = 1; let q = ''; let sort = 'desc'; let data = null; let seq = 0;

  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const tableWrap = h('div', { class: 'table-wrap' });
  const pager = h('div', { class: 'pager' });
  const info = h('span', { class: 'muted small' });
  const search = h('input', { type: 'search', placeholder: 'Search documents...', 'aria-label': 'Search documents', oninput: debounce(() => { q = search.value.trim(); page = 1; load(); }, 250) });
  const sortBtn = h('button', { type: 'button', class: 'btn sm ghost', title: 'Toggle sort order', onclick: () => { sort = sort === 'desc' ? 'asc' : 'desc'; sortBtn.textContent = sort === 'desc' ? 'Newest first' : 'Oldest first'; load(); } }, 'Newest first');
  const clearBtn = h('button', { type: 'button', class: 'btn danger-ghost', onclick: async () => {
    if (!(await confirmBox(`Delete all ${fmtNum(current.count)} document(s) in "${current.label}"? This cannot be undone.`, { danger: true, okLabel: 'Clear collection' }))) return;
    try { const r = await api('DELETE', `/collections/${current.name}`); toast(`Cleared ${r?.cleared ?? ''} document(s) from ${current.label}`); load(); } catch { /* toast */ }
  } }, icon('trash', 14), 'Clear collection');
  const refreshBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Refresh', title: 'Refresh', onclick: () => load() }, icon('refresh', 15));

  function paintTabs() {
    replace(tabs, cols.map((c) => h('button', {
      type: 'button', role: 'tab', class: `tab${c === current ? ' active' : ''}`, 'aria-selected': String(c === current),
      title: c.virtual ? `${c.description || 'Computed view'} (read-only)` : null,
      onclick: () => { current = c; activeTab.set(mod.id, c.name); page = 1; q = ''; search.value = ''; paintTabs(); load(); },
    }, c.label, h('span', { class: 'count' }, fmtNum(c.count)))));
    clearBtn.hidden = !!current.virtual;
  }

  async function load() {
    const my = ++seq;
    try {
      const r = await api('GET', `/collections/${encodeURIComponent(current.name)}${qs({ page, limit: PAGE_SIZE, q, sort })}`, undefined, { quiet: true });
      if (my !== seq) return;
      data = r;
      if (page > 1 && !r.items.length && r.total > 0) { page = Math.max(1, Math.ceil(r.total / PAGE_SIZE)); return load(); }
      if (current.virtual && !q) { // computed views get no count events: take the count from the listing
        current.count = r.total;
        const badge = tabs.children[cols.indexOf(current)]?.querySelector('.count');
        if (badge) badge.textContent = fmtNum(r.total);
      }
      paintTable();
    } catch (e) { replace(tableWrap, h('div', { class: 'pad' }, emptyState('Could not load documents', e.message))); }
  }

  function paintTable() {
    const items = data?.items || [];
    const idField = data?.idField || current.idField || 'id';
    let specs = (data?.columns?.length ? data.columns : current.columns || []).map(colSpec).filter((s) => s.path);
    if (!specs.length) specs = autoColumns(items, idField).map((k) => ({ path: k, label: k }));
    if (!specs.length) specs = [{ path: idField, label: idField }];
    if (!items.length) {
      replace(tableWrap, h('div', { class: 'pad' }, q
        ? emptyState('No documents match your search', 'Try a different term.')
        : current.virtual
          ? emptyState(`No ${current.label.toLowerCase()}`, current.description || 'Computed from the other collections: use a generator above.')
          : emptyState(`No ${current.label.toLowerCase()} yet`, 'Use a generator above or call the API to create some.')));
    } else {
      replace(tableWrap, h('table', { class: 'tbl data-tbl' },
        h('thead', h('tr', specs.map((s) => h('th', s.label)))),
        h('tbody', items.map((d) => h('tr', { tabindex: '0', onclick: () => openDoc(d[idField]), onkeydown: (e) => { if (e.key === 'Enter') openDoc(d[idField]); } },
          specs.map((s) => h('td', cell(getPath(d, s.path)))))))));
    }
    const total = data?.total ?? 0; const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    info.textContent = total ? `${(page - 1) * PAGE_SIZE + 1}-${Math.min(page * PAGE_SIZE, total)} of ${fmtNum(total)}` : '0 documents';
    replace(pager, info, h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn sm', disabled: page <= 1, onclick: () => { page--; load(); } }, 'Prev'),
      h('span', { class: 'small muted' }, `Page ${page} / ${pages}`),
      h('button', { type: 'button', class: 'btn sm', disabled: page >= pages, onclick: () => { page++; load(); } }, 'Next'));
  }

  // ---- document drawer ----
  async function openDoc(id) {
    const col = current;
    const actions = (mod.rowActions || []).filter((a) => !a.collection || a.collection === col.name);
    const links = (mod.rowLinks || []).filter((l) => !l.collection || l.collection === col.name);
    const title = h('div', { class: 'req-title' }, h('span', { class: 'chip' }, col.label), h('span', { class: 'mono path' }, `#${id}`));
    const tok = openDrawer({ label: `${col.label} document ${id}`, title, body: h('p', { class: 'muted pad' }, 'Loading...') });
    const show = async () => {
      let doc;
      try { doc = await api('GET', `/collections/${encodeURIComponent(col.name)}/${encodeURIComponent(id)}`, undefined, { quiet: true }); } catch (e) {
        setDrawer(tok, { actions: null, body: h('div', { class: 'pad' }, emptyState('Document not found', e.message)) }); return;
      }
      const view = h('div', { class: 'detail' });
      const toolbar = h('div', { class: 'doc-actions' });
      const renderView = () => {
        replace(view, jsonView(doc));
        replace(toolbar,
          col.virtual ? null : h('button', { type: 'button', class: 'btn sm', onclick: () => edit() }, 'Edit'),
          h('button', { type: 'button', class: 'btn sm', onclick: () => copyText(jsonText(doc), 'JSON copied') }, icon('copy', 14), 'Copy JSON'),
          actions.map((a) => h('button', { type: 'button', class: `btn sm ${a.danger ? 'danger' : ''}`, onclick: () => runAction(a) }, a.label || a.id)),
          links.map((l) => h('a', { class: 'btn sm', href: l.href.replace('{id}', encodeURIComponent(id)), target: '_blank', rel: 'noopener', onclick: () => setTimeout(() => { load(); }, 1500) }, icon('download', 14), l.label || l.id)),
          h('span', { class: 'spacer' }),
          col.virtual ? null : h('button', { type: 'button', class: 'btn sm danger-ghost', onclick: () => del() }, icon('trash', 14), 'Delete'));
      };
      const edit = () => {
        const ta = h('textarea', { class: 'editor mono', spellcheck: 'false', 'aria-label': 'Document JSON', rows: 20 });
        ta.value = JSON.stringify(doc, null, 2);
        const err = h('div', { class: 'form-err', role: 'alert' });
        ta.addEventListener('input', () => { try { JSON.parse(ta.value); err.textContent = ''; } catch (e) { err.textContent = e.message; } });
        replace(view, ta, err);
        replace(toolbar,
          h('button', { type: 'button', class: 'btn sm primary', onclick: async () => {
            let parsed;
            try { parsed = JSON.parse(ta.value); } catch (e) { err.textContent = `Invalid JSON: ${e.message}`; return; }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { err.textContent = 'Document must be a JSON object'; return; }
            try { await api('PUT', `/collections/${encodeURIComponent(col.name)}/${encodeURIComponent(id)}`, parsed); toast('Document saved'); load(); show(); } catch { /* toast */ }
          } }, 'Save'),
          h('button', { type: 'button', class: 'btn sm', onclick: renderView }, 'Cancel'));
        ta.focus();
      };
      const del = async () => {
        if (!(await confirmBox(`Delete ${col.label} #${id}?`, { danger: true, okLabel: 'Delete' }))) return;
        try { await api('DELETE', `/collections/${encodeURIComponent(col.name)}/${encodeURIComponent(id)}`); toast('Document deleted'); closeDrawer(); load(); } catch { /* toast */ }
      };
      const runAction = async (a) => {
        let params = {};
        if (a.params?.length) { params = await askParams(a.label || a.id, a.params, a.label || 'Run', a.danger); if (!params) return; }
        else if (a.danger && !(await confirmBox(`${a.label || a.id} on ${col.label} #${id}?`, { danger: true, okLabel: a.label || 'Run' }))) return;
        try {
          const r = await api('POST', `/action/${mod.id}/${a.id}`, { collection: col.name, id, params });
          toast(r?.message || 'Done'); load(); show();
        } catch { /* toast */ }
      };
      renderView();
      setDrawer(tok, { body: h('div', {}, h('div', { class: 'doc-bar' }, toolbar), view) });
    };
    show();
  }

  // ---- live updates ----
  const reload = debounce(load, 300);
  ctx.onCleanup(on('data', (p) => { if (p.collection === current.name || current.dependsOn?.includes(p.collection)) reload(); }));
  ctx.onCleanup(on('counts', () => paintTabsCounts()));
  ctx.onCleanup(on('meta', () => paintTabsCounts()));
  ctx.onCleanup(on('live', (l) => { if (l.reconnected) load(); }));
  ctx.onCleanup(() => { reload.cancel(); closeDrawer(); });
  function paintTabsCounts() {
    const fresh = moduleById(mod.id)?.collections || cols; // meta objects are replaced on reload, SSE updates the newest ones
    [...tabs.children].forEach((b, i) => {
      const c = b.querySelector('.count');
      if (c && fresh[i] && !fresh[i].virtual) { c.textContent = fmtNum(fresh[i].count); cols[i].count = fresh[i].count; }
    });
  }

  paintTabs(); load();
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', 'Data'), h('span', { class: 'spacer' }), refreshBtn),
    tabs,
    h('div', { class: 'toolbar' }, search, sortBtn, h('span', { class: 'spacer' }), clearBtn),
    tableWrap, pager);
}
