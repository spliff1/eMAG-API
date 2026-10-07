// "Import from real eMAG API" screen.
// SECURITY: the real-account credentials live only in the two <input> values (page memory). They are never put in
// storage, URLs, DOM attributes, toasts or the console. They stay in the fields while you remain on this screen
// (so several imports can be run in a row) and are wiped when you leave it, sign out, lose the session or reload.
import { h, replace, toast, paramForm, fmtFull, fmtNum, emptyState } from './dom.js';
import { api, on, loadMeta } from './api.js';

const GROUPS = [['reference', 'Reference data'], ['catalog', 'Catalogue'], ['operations', 'Operations']];
const STATUS_TXT = { running: 'Running', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };
const importedOf = (j) => (j.steps || []).reduce((n, s) => n + (s.imported || 0), 0);

export function renderImport(root, ctx) {
  let sources = null; let job = null; let jobs = []; let liveUp = true; let poll = null;
  const sourceBoxes = new Map(); // id -> { box, opts }
  let gone = false; const openJobs = new Set();
  const dead = () => gone;

  // ---- form ---------------------------------------------------------------------------------
  const platform = h('select', { id: 'imp-platform', onchange: () => refreshStart() });
  // names/autocomplete chosen so browsers do not offer to save or autofill these as a login
  const user = h('input', { id: 'imp-a', name: 'emag-acct-a', type: 'text', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', 'data-lpignore': 'true', 'data-1p-ignore': '', oninput: () => refreshStart() });
  const pass = h('input', { id: 'imp-b', name: 'emag-acct-b', type: 'password', autocomplete: 'new-password', 'data-lpignore': 'true', 'data-1p-ignore': '', oninput: () => refreshStart() });
  let mode = 'merge';
  const modeBox = h('div', { class: 'mode-opts', role: 'radiogroup', 'aria-label': 'Import mode' }, [
    ['merge', 'Merge', 'upsert by id and keep everything else already in the dummy.'],
    ['replace', 'Replace', 'overwrite the dummy\'s local data for the selected sources.'],
  ].map(([v, l, d]) => h('label', { class: 'radio' }, h('input', { type: 'radio', name: 'imp-mode', value: v, checked: v === mode, onchange: () => { mode = v; } }), h('span', h('strong', l), ' - ', d))));
  const sourcesBox = h('div', { class: 'src-groups' }, h('p', { class: 'muted' }, 'Loading sources...'));
  const formErr = h('div', { class: 'form-err', role: 'alert' });
  const startBtn = h('button', { type: 'button', class: 'btn primary', disabled: true, onclick: () => start() }, 'Start import');

  const selectedIds = () => [...sourceBoxes].filter(([, v]) => v.cb.checked).map(([id]) => id);
  function refreshStart() {
    const running = job?.status === 'running';
    startBtn.disabled = running || !(platform.value && user.value.trim() && pass.value && selectedIds().length);
    startBtn.title = running ? 'An import is already running' : '';
  }
  const clearCreds = () => { user.value = ''; pass.value = ''; refreshStart(); };

  function buildSources() {
    sourceBoxes.clear();
    replace(platform, (sources.platforms || []).map((p) => h('option', { value: p.id }, `${p.label}${p.baseUrl ? ` (${p.baseUrl})` : ''}`)));
    const groups = GROUPS.map(([id, label]) => [id, label, (sources.sources || []).filter((s) => (s.group || 'reference') === id)]);
    const known = new Set(GROUPS.map((g) => g[0]));
    const other = (sources.sources || []).filter((s) => !known.has(s.group));
    if (other.length) groups.push(['other', 'Other', other]);
    replace(sourcesBox, groups.filter((g) => g[2].length).map(([, label, list]) => h('div', { class: 'src-group' },
      h('h3', label), h('div', { class: 'src-grid' }, list.map(sourceCard)))));
    refreshStart();
  }
  function sourceCard(s) {
    const form = paramForm(s.options || [], { idPrefix: `imp-${s.id}` });
    const optsEl = h('div', { class: 'src-opts', hidden: true }, form.el);
    const cb = h('input', { type: 'checkbox', id: `src-${s.id}`, checked: !!s.defaultSelected && !s.pii, // personal-data sources must be ticked explicitly
      onchange: () => { optsEl.hidden = !cb.checked || !(s.options || []).length; box.classList.toggle('on', cb.checked); refreshStart(); } });
    const box = h('div', { class: 'src-card' },
      h('div', { class: 'src-head' }, cb, h('label', { for: cb.id }, h('strong', s.label || s.id),
        s.slow ? h('span', { class: 'chip warn', title: 'May take a long time and many API calls' }, 'slow') : null,
        s.pii ? h('span', { class: 'chip err', title: 'Contains customer personal data' }, 'personal data') : null)),
      s.description ? h('div', { class: 'muted small src-desc' }, s.description) : null,
      s.pii ? h('div', { class: 'small pii-warn' }, 'Imports real customers\' personal data (names, addresses, phone numbers) into this local dummy. Only tick this if you are allowed to copy it.') : null,
      optsEl);
    box.classList.toggle('on', cb.checked);
    optsEl.hidden = !cb.checked || !(s.options || []).length;
    sourceBoxes.set(s.id, { cb, form });
    return box;
  }

  async function start() {
    formErr.textContent = '';
    const ids = selectedIds();
    const options = {};
    for (const id of ids) { const v = sourceBoxes.get(id).form.values(); if (Object.keys(v).length) options[id] = v; }
    const body = { platform: platform.value, username: user.value.trim(), password: pass.value, sources: ids, mode, options };
    startBtn.disabled = true;
    const req = api('POST', '/import/start', body, { quiet: true }); // body is serialised synchronously inside api()
    body.username = ''; body.password = '';                          // drop the extra in-memory copy (the inputs keep the values)
    try {
      const r = await req;
      job = { id: r.jobId, status: 'running', steps: [], log: [], startedAt: new Date().toISOString() };
      paintJob(); loadJob(r.jobId); loadJobs();
      toast('Import started');
    } catch (e) {
      if (!e.authLost) formErr.textContent = e.message || 'Could not start the import.';
    } finally { refreshStart(); }
  }

  // ---- progress -------------------------------------------------------------------------------
  const progressBox = h('div', { class: 'card', hidden: true });
  const logPre = h('pre', { class: 'joblog', 'aria-label': 'Import log', tabindex: '0' });
  function stepIcon(st) {
    const map = { pending: 'pending', running: 'running', done: 'done', skipped: 'skipped', failed: 'failed' };
    return h('span', { class: `sico ${map[st] || 'pending'}`, title: st, role: 'img', 'aria-label': st }, st === 'done' ? '✓' : st === 'failed' ? '✕' : st === 'skipped' ? '–' : '');
  }
  function stepRow(s) {
    const known = s.total != null && s.total > 0;
    const pct = s.status === 'done' ? 100 : known ? Math.min(100, Math.round((s.done / s.total) * 100)) : 0;
    const indet = s.status === 'running' && !known;
    return h('div', { class: `step ${s.status}` },
      stepIcon(s.status),
      h('div', { class: 'step-main' },
        h('div', { class: 'step-top' }, h('strong', s.label || s.id),
          h('span', { class: 'muted small' }, known ? `${fmtNum(s.done)} / ${fmtNum(s.total)}` : s.done ? fmtNum(s.done) : ''),
          h('span', { class: 'spacer' }), h('span', { class: 'small' }, `imported ${fmtNum(s.imported || 0)}`)),
        h('div', { class: `bar${indet ? ' indet' : ''}`, role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': indet ? null : pct }, h('i', { style: { width: `${pct}%` } })),
        s.message ? h('div', { class: `small ${s.status === 'failed' ? 'err-text' : 'muted'}` }, s.message) : null));
  }
  function paintJob() {
    if (!job) { progressBox.hidden = true; return; }
    progressBox.hidden = false;
    const st = job.status;
    const logLines = (job.log || []).slice(-200);
    const nearBottom = logPre.scrollHeight - logPre.scrollTop - logPre.clientHeight < 40;
    const keepTop = logPre.scrollTop;
    replace(progressBox,
      h('div', { class: 'card-head' }, h('h2', 'Import progress'),
        h('span', { class: `badge ${st === 'done' ? 's-ok' : st === 'running' ? 'neutral' : st === 'failed' ? 's-err' : 's-warn'}` }, STATUS_TXT[st] || st),
        h('span', { class: 'muted small' }, `${job.platform ? `${String(job.platform).toUpperCase()} - ` : ''}${job.mode || ''}${job.startedAt ? ` - started ${fmtFull(job.startedAt)}` : ''}`),
        h('span', { class: 'spacer' }),
        st === 'running' ? h('button', { type: 'button', class: 'btn danger-ghost', onclick: cancel }, 'Cancel') : null),
      job.error ? h('div', { class: 'note-box warn' }, job.error) : null,
      h('div', { class: 'steps' }, (job.steps || []).length ? job.steps.map(stepRow) : h('div', { class: 'muted small' }, 'Waiting for the first step...')),
      h('details', { class: 'block', open: true }, h('summary', h('span', { class: 'block-title' }, 'Log'), h('span', { class: 'muted small' }, `${logLines.length} lines`)), logPre));
    logPre.textContent = logLines.join('\n');
    logPre.scrollTop = nearBottom ? logPre.scrollHeight : keepTop;
    refreshStart();
  }
  async function cancel() {
    if (!job) return;
    try { await api('POST', `/import/jobs/${encodeURIComponent(job.id)}/cancel`); toast('Cancelling...'); } catch { /* toast shown */ }
  }

  // ---- state updates ---------------------------------------------------------------------------
  function applyJob(j) {
    if (!j || !j.id) return;
    const prev = jobs.find((x) => x.id === j.id);
    const was = (job && job.id === j.id ? job : prev)?.status;
    const i = jobs.findIndex((x) => x.id === j.id);
    if (i >= 0) jobs[i] = j; else jobs.unshift(j);
    if (!job || job.id === j.id || j.status === 'running') job = j;
    if (job.id === j.id) paintJob();
    paintJobs();
    if (was === 'running' && j.status !== 'running') finished(j);
  }
  function finished(j) {
    const n = importedOf(j);
    if (j.status === 'done') toast(`Import finished: ${fmtNum(n)} records imported`);
    else if (j.status === 'cancelled') toast(`Import cancelled (${fmtNum(n)} records imported before stopping)`, 'info');
    else toast(`Import failed${j.error ? `: ${j.error}` : ''}`, 'err');
    loadMeta().catch(() => {});
  }
  async function loadJob(id) {
    try { const j = await api('GET', `/import/jobs/${encodeURIComponent(id)}`, undefined, { quiet: true }); if (!dead()) applyJob(j); } catch { /* ignore */ }
  }
  async function loadJobs() {
    try {
      const r = await api('GET', '/import/jobs', undefined, { quiet: true });
      if (dead()) return;
      jobs = r.items || [];
      paintJobs();
      const running = jobs.find((j) => j.status === 'running');
      const pick = job ? jobs.find((j) => j.id === job.id) : (running || jobs[0]);
      if (pick) { job = pick; paintJob(); loadJob(pick.id); }
    } catch { /* ignore */ }
  }

  // ---- previous imports -------------------------------------------------------------------------
  const histBox = h('div', { class: 'card' });
  function paintJobs() {
    replace(histBox, h('div', { class: 'card-head' }, h('h2', 'Previous imports')),
      jobs.length ? h('div', { class: 'hist' }, jobs.map((j) => {
        const d = h('details', { class: 'hist-item', open: openJobs.has(j.id), ontoggle: async () => {
          if (d.open) openJobs.add(j.id); else openJobs.delete(j.id);
          if (d.open && !(j.steps && j.steps.length)) {
            try { const full = await api('GET', `/import/jobs/${encodeURIComponent(j.id)}`, undefined, { quiet: true }); Object.assign(j, full); d.replaceChildren(...histInner(j)); } catch { /* ignore */ }
          }
        } }, histInner(j));
        return d;
      })) : emptyState('No imports yet', 'Fill in the form above to pull real data into the dummy.'));
  }
  function histInner(j) {
    return [h('summary', h('span', { class: 'mono small' }, fmtFull(j.startedAt).slice(0, 19)),
      h('span', { class: 'chip' }, String(j.platform || '').toUpperCase()), h('span', { class: 'chip' }, j.mode || ''),
      h('span', { class: `badge ${j.status === 'done' ? 's-ok' : j.status === 'failed' ? 's-err' : 'neutral'}` }, STATUS_TXT[j.status] || j.status),
      h('span', { class: 'spacer' }), h('span', { class: 'small muted' }, `${fmtNum(importedOf(j))} imported`)),
    h('div', { class: 'steps pad-s' }, (j.steps || []).map(stepRow)),
    j.error ? h('div', { class: 'note-box warn' }, j.error) : null];
  }

  // ---- layout ---------------------------------------------------------------------------------
  replace(root, h('section', { class: 'page' },
    h('div', { class: 'page-head' }, h('h1', 'Import from real eMAG API'),
      h('p', { class: 'muted' }, 'Pull real reference data and catalogue from your marketplace account into this dummy, so your tests use real ids.')),
    h('div', { class: 'note-box ro-box' }, h('strong', 'Strictly read-only. '),
      'Only an allow-list of read endpoints is ever called on the real API. Nothing on your real account is created, changed or deleted.'),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', 'Source account')),
      h('form', { class: 'imp-form', autocomplete: 'off', onsubmit: (e) => e.preventDefault() },
        h('div', { class: 'form-grid' },
          h('div', { class: 'field' }, h('label', { for: 'imp-platform' }, 'Platform'), platform),
          h('div', { class: 'field' }, h('label', { for: 'imp-a' }, 'Marketplace API username'), user),
          h('div', { class: 'field' }, h('label', { for: 'imp-b' }, 'Marketplace API password'), pass)),
        h('p', { class: 'small muted cred-note' }, 'Credentials are sent to this local server only when you press Start, used in memory during the import and never stored (not in the database, logs or browser). They stay in these fields while you are on this page, so you can run more imports, and are cleared when you leave the page, sign out or reload.'),
        h('div', { class: 'field' }, h('label', 'Mode'), modeBox),
        h('div', { class: 'field' }, h('label', 'What to import'), sourcesBox),
        formErr,
        h('div', { class: 'card-foot' }, startBtn))),
    progressBox, histBox));
  paintJobs();

  // ---- wiring -----------------------------------------------------------------------------------
  ctx.onCleanup(on('import', (j) => applyJob(j)));
  ctx.onCleanup(on('live', (l) => { liveUp = l.up; if (l.reconnected && job) loadJob(job.id); }));
  poll = setInterval(() => { if (!liveUp && job?.status === 'running') loadJob(job.id); }, 1500);
  ctx.onCleanup(() => { gone = true; clearInterval(poll); clearCreds(); });

  api('GET', '/import/sources', undefined, { quiet: true }).then((r) => { if (dead()) return; sources = r; buildSources(); loadJobs(); })
    .catch((e) => { if (!e.authLost) replace(sourcesBox, emptyState('Could not load import sources', e.message)); });
}
