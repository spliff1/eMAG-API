import crypto from 'node:crypto';
import { bus } from '../core/events.js';
import { createClient, ImportError, PLATFORM_LABELS, PLATFORM_URLS, resolveBaseUrl } from './client.js';
import { createAnonymizer } from './anonymize.js';
import { describeSources, sourceById, SOURCES } from './sources.js';

const LANG = { ro: 'ro', bg: 'bg', hu: 'hu', fd_ro: 'ro', fd_bg: 'bg' };
const COUNTRY = { ro: 'RO', bg: 'BG', hu: 'HU', fd_ro: 'RO', fd_bg: 'BG' };
const MAX_LOG = 500;

/**
 * Runs imports from the real marketplace. Credentials are used only to build the in-memory client
 * (client.js) and are NEVER copied into the job object, the database, the log or any error message.
 */
export function createImportManager(app) {
  const db = app.store.db;
  const jobs = new Map();
  const q = {
    upsert: db.prepare(`INSERT INTO import_runs (id, started_at, finished_at, status, data) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET finished_at = excluded.finished_at, status = excluded.status, data = excluded.data`),
    recent: db.prepare('SELECT data FROM import_runs ORDER BY started_at DESC LIMIT 50'),
    all: db.prepare('SELECT id, status, data FROM import_runs'),
    one: db.prepare('SELECT id, status, data FROM import_runs WHERE id = ?'),
    setData: db.prepare('UPDATE import_runs SET status = ?, finished_at = ?, data = ? WHERE id = ?'),
  };

  /** Marks a job that was running when the process stopped as failed/interrupted (status column AND the JSON the UI reads). */
  const interrupt = (job, reason) => {
    job.status = 'failed';
    job.error ||= reason;
    job.finishedAt ||= new Date().toISOString();
    for (const st of job.steps || []) {
      if (st.status === 'running') { st.status = 'failed'; st.message = reason; }
      else if (st.status === 'pending') { st.status = 'skipped'; st.message = 'Not started'; }
    }
    job.log = [...(job.log || []), reason];
    return job;
  };
  const STALE = 'Interrupted: the app was closed while this import was running';
  /** A stored job can only be genuinely running if THIS process owns it (jobs map); otherwise it is a leftover. */
  const reconcileRow = (row) => {
    let job;
    try { job = JSON.parse(row.data); } catch { job = { id: row.id, steps: [], log: [], startedAt: new Date().toISOString() }; }
    if (jobs.has(row.id) || (row.status !== 'running' && job.status !== 'running')) return job; // healthy
    interrupt(job, STALE);
    q.setData.run('failed', job.finishedAt, JSON.stringify(job), row.id);
    return job;
  };
  // Any job left "running" — in the status column OR only inside the JSON the UI reads — by a previous process is repaired at startup.
  for (const row of q.all.all()) reconcileRow(row);

  const view = (job) => ({
    id: job.id, status: job.status, platform: job.platform, mode: job.mode, startedAt: job.startedAt, finishedAt: job.finishedAt,
    error: job.error, steps: job.steps.map((s) => ({ ...s })), log: job.log.slice(-200),
  });
  const persist = (job) => q.upsert.run(job.id, job.startedAt, job.finishedAt, job.status, JSON.stringify(view(job)));
  let lastPublish = 0;
  const publish = (job, force = false) => {
    const now = Date.now();
    if (!force && now - lastPublish < 200) return;
    lastPublish = now;
    bus.emit('import', view(job));
  };

  async function execute(job, client, ctxBase, selected, signal) {
    try {
      for (const src of selected) {
        const step = job.steps.find((s) => s.id === src.id);
        if (signal.aborted) { step.status = 'skipped'; continue; }
        if (job.status === 'failed') { step.status = 'skipped'; step.message = 'Skipped after a fatal error'; continue; }
        step.status = 'running';
        console.log(`[import] ${src.label}: started`);
        publish(job, true);
        const stats = { skipped: 0 };
        const ctx = {
          ...ctxBase,
          stats,
          options: job.options[src.id] || {},
          step: { set: (patch) => { Object.assign(step, patch); publish(job); } },
          log: (msg) => { console.log(`[import] ${src.label}: ${msg}`); job.log.push(`[${src.label}] ${msg}`); if (job.log.length > MAX_LOG) job.log.shift(); publish(job); },
        };
        try {
          const n = await src.run(ctx);
          step.status = 'done';
          step.imported = n;
          step.done = n;
          if (step.total != null && step.total < n) step.total = n;
          step.message = `${n} imported${stats.skipped ? `, ${stats.skipped} skipped (see log)` : ''}`;
          console.log(`[import] ${src.label}: done, ${step.message}`);
          app.store.flush();
        } catch (e) {
          step.status = 'failed';
          if (signal.aborted) { step.message = 'Cancelled'; continue; }
          step.message = e instanceof ImportError ? e.message : `Unexpected error: ${e.message}`;
          job.log.push(`[${src.label}] FAILED: ${step.message}`);
          console.log(`[import] ${src.label}: FAILED - ${step.message}`);
          if (e.fatal) { job.status = 'failed'; job.error = step.message; }
        }
      }
    } finally {
      client.dispose(); // drop the credentials
      job.finishedAt = new Date().toISOString();
      if (signal.aborted) { job.status = 'cancelled'; }
      else if (job.status === 'running') job.status = job.steps.some((s) => s.status === 'failed') ? 'failed' : 'done';
      if (job.status === 'failed' && !job.error) job.error = 'Some steps failed';
      app.store.flush();
      persist(job);
      publish(job, true);
      job.abort = null;
    }
  }

  return {
    platforms: () => Object.entries(PLATFORM_URLS).map(([id, baseUrl]) => ({ id, label: PLATFORM_LABELS[id], baseUrl })),
    sources: describeSources,

    /** input: { platform, username, password, sources, mode, options, baseUrl? } — validated and verified before any job exists. */
    async start(input) {
      const { platform, username, password } = input;
      const mode = input.mode === 'merge' ? 'merge' : 'replace';
      if (!PLATFORM_URLS[platform]) throw new ImportError('Unknown platform', { status: 400 });
      if (typeof username !== 'string' || !username || typeof password !== 'string' || !password) throw new ImportError('Username and password are required', { status: 400 });
      const ids = Array.isArray(input.sources) ? [...new Set(input.sources)] : [];
      const selected = SOURCES.filter((s) => ids.includes(s.id));
      if (!selected.length || selected.length !== ids.length) throw new ImportError('Select at least one valid source', { status: 400 });
      if ([...jobs.values()].some((j) => j.status === 'running')) throw new ImportError('An import is already running', { status: 409 });

      const controller = new AbortController();
      let baseUrl;
      try { baseUrl = resolveBaseUrl(platform, input.baseUrl); } catch (e) { e.status = 400; throw e; }
      const client = createClient({ baseUrl, username, password, signal: controller.signal, throttle: !input.baseUrl });
      try {
        await client.post('/vat/read', {}); // cheap read that proves the credentials (and IP whitelisting) work
      } catch (e) {
        client.dispose();
        if (!(e instanceof ImportError)) throw e;
        e.status ??= 502;
        throw e;
      }

      const job = {
        id: crypto.randomUUID(), status: 'running', platform, mode, startedAt: new Date().toISOString(), finishedAt: null, error: null,
        steps: selected.map((s) => ({ id: s.id, label: s.label, status: 'pending', done: 0, total: null, imported: 0, message: '' })),
        log: [`Credentials verified against ${PLATFORM_LABELS[platform]}. Importing ${selected.length} source(s), mode: ${mode}.`],
        options: Object.fromEntries(selected.map((s) => [s.id, { ...(input.options?.[s.id] || {}) }])),
        abort: controller,
      };
      jobs.set(job.id, job);
      persist(job);
      publish(job, true);
      const ctxBase = {
        client, app, mode, signal: controller.signal, retryDelayMs: input.baseUrl ? 5 : 2000, anonymizer: createAnonymizer(), platform: { id: platform, lang: LANG[platform], country: COUNTRY[platform] },
      };
      execute(job, client, ctxBase, selected, controller.signal).catch((e) => console.error('[import] unexpected failure:', e.message));
      return { jobId: job.id };
    },

    get(id) {
      const live = jobs.get(id);
      if (live) return view(live);
      const row = q.one.get(id);
      return row ? reconcileRow(row) : null;
    },
    list() {
      const rows = q.all.all().map((r) => reconcileRow(r)).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).slice(0, 50);
      const live = [...jobs.values()].map(view);
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const j of live) byId.set(j.id, j);
      return [...byId.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    },
    /** Called on SIGINT/SIGTERM: records running jobs as interrupted and drops their credentials. */
    shutdown() {
      for (const job of jobs.values()) {
        if (job.status !== 'running') continue;
        interrupt(job, 'Interrupted: the app was closed while this import was running');
        persist(job);
        job.abort?.abort();
      }
    },
    cancel(id) {
      const job = jobs.get(id);
      if (job) {
        if (job.status !== 'running') return false;
        job.abort?.abort();
        return true;
      }
      // not owned by this process: a leftover row — settle it so it stops showing as running
      const row = q.one.get(id);
      if (!row) return false;
      const settled = reconcileRow(row);
      return settled.status !== 'running';
    },
  };
}
