/**
 * Read-only client for the REAL eMAG Marketplace API, used by the importer.
 *
 * SECURITY: the credentials exist only inside the closure created by createClient(). They are
 *   - never written to disk, the database, logs, job state or error messages,
 *   - dropped by dispose() as soon as the import ends,
 *   - sent only to the resolved base URL (official eMAG/FD hosts, or a loopback address for local testing).
 * Only endpoints in READ_ONLY can be called, so an import can never modify the real account.
 */
export const PLATFORM_URLS = {
  ro: 'https://marketplace-api.emag.ro/api-3',
  bg: 'https://marketplace-api.emag.bg/api-3',
  hu: 'https://marketplace-api.emag.hu/api-3',
  fd_ro: 'https://marketplace-ro-api.fashiondays.com/api-3',
  fd_bg: 'https://marketplace-bg-api.fashiondays.com/api-3',
};
export const PLATFORM_LABELS = { ro: 'eMAG Romania', bg: 'eMAG Bulgaria', hu: 'eMAG Hungary', fd_ro: 'Fashion Days Romania', fd_bg: 'Fashion Days Bulgaria' };

export const READ_ONLY = new Set([
  '/vat/read', '/handling_time/read', '/category/read', '/category/count', '/product_offer/read', '/product_offer/count',
  '/order/read', '/order/count', '/rma/read', '/rma/count', '/courier_accounts/read', '/addresses/read', '/awb/package/read',
  '/locality/read', '/locality/count', '/campaigns/read', '/campaign_categories/read',
]);

const DEBUG = process.env.IMPORT_DEBUG === '1';
const PII_PATHS = /^\/(order|rma)\//;

export class ImportError extends Error {
  constructor(message, { fatal = false, status } = {}) { super(message); this.name = 'ImportError'; this.fatal = fatal; this.status = status; }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new ImportError('Import cancelled', { fatal: true })); }, { once: true });
});

/** Official hosts only; plain http is accepted solely for loopback (used by the automated tests). */
export function resolveBaseUrl(platform, customBaseUrl) {
  if (customBaseUrl) {
    let u;
    try { u = new URL(customBaseUrl); } catch { throw new ImportError('Invalid baseUrl', { fatal: true }); }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    if (!loopback) throw new ImportError('A custom baseUrl is only accepted for loopback addresses', { fatal: true });
    return customBaseUrl.replace(/\/+$/, '');
  }
  const url = PLATFORM_URLS[platform];
  if (!url) throw new ImportError(`Unknown platform "${platform}"`, { fatal: true });
  return url;
}

export function createClient({ baseUrl, username, password, signal, throttle: pace = true }) {
  let auth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const lastCall = { orders: 0, other: 0 };

  async function throttle(path) {
    if (!pace) return; // loopback (tests): no real rate limits to respect
    // documented limits: orders 12 req/s, everything else 3 req/s cumulated -> stay a little below
    const bucket = path.startsWith('/order') ? 'orders' : 'other';
    const gap = bucket === 'orders' ? 100 : 400;
    const wait = lastCall[bucket] + gap - Date.now();
    if (wait > 0) await sleep(wait, signal);
    lastCall[bucket] = Date.now();
  }

  return {
    async post(path, body = {}, { query } = {}) {
      if (!READ_ONLY.has(path)) throw new ImportError(`Refusing to call ${path}: the importer is read-only`, { fatal: true });
      if (!auth) throw new ImportError('Import already finished', { fatal: true });
      const url = `${baseUrl}${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
      let lastErr;
      for (let attempt = 1; attempt <= 6; attempt++) {
        await throttle(path);
        let res;
        try {
          res = await fetch(url, {
            method: 'POST',
            headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'dummy-emag-importer/1.0' },
            body: JSON.stringify(body),
            signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]),
            redirect: 'error',
          });
        } catch (e) {
          if (signal?.aborted) throw new ImportError('Import cancelled', { fatal: true });
          lastErr = new ImportError(`Network error calling ${path}: ${e.cause?.code || e.name}`);
          await sleep(1000 * attempt, signal);
          continue;
        }
        if (res.status === 429) {
          const wait = Number(res.headers.get('retry-after')) * 1000 || 1500 * attempt;
          console.log(`[import] ${path}: rate limited (HTTP 429), waiting ${(wait / 1000).toFixed(1)}s (attempt ${attempt}/6)`);
          await sleep(wait, signal);
          lastErr = new ImportError('Rate limit exceeded (HTTP 429)');
          continue;
        }
        if (res.status === 401) throw new ImportError('The marketplace rejected the credentials (HTTP 401). Check the username/password and that the account has API access.', { fatal: true, status: 401 });
        if (res.status === 403) throw new ImportError('The marketplace refused the request (HTTP 403). Your public IP address is probably not whitelisted for API access.', { fatal: true, status: 403 });
        if (res.status >= 500) { lastErr = new ImportError(`The marketplace answered HTTP ${res.status} on ${path}`); await sleep(1000 * attempt, signal); continue; }
        let data;
        try { data = await res.json(); } catch { throw new ImportError(`Unexpected (non-JSON) response from ${path} (HTTP ${res.status})`); }
        if (!res.ok || data?.isError) {
          // `messages` is documented as an array of strings but the real API also answers with a string or an object
          const raw = data?.messages;
          const list = Array.isArray(raw) ? raw : raw == null || raw === '' ? [] : [raw];
          const msgs = list.map((m) => (typeof m === 'string' ? m : JSON.stringify(m))).join('; ');
          if (!PII_PATHS.test(path)) console.log(`[import:error] ${path} ${JSON.stringify(body).slice(0, 300)} -> HTTP ${res.status}\n${JSON.stringify(data).slice(0, 2000)}`);
          throw new ImportError(`${path}: ${msgs || `HTTP ${res.status}`}`);
        }
        if (DEBUG && !PII_PATHS.test(path)) {
          // response bodies only (never headers/credentials); orders & returns contain personal data and are never printed
          console.log(`[import:debug] POST ${path} ${JSON.stringify(body).slice(0, 300)} -> HTTP ${res.status}\n${JSON.stringify(data).slice(0, 2000)}`);
        }
        return data;
      }
      throw lastErr || new ImportError(`Failed calling ${path}`);
    },
    dispose() { auth = null; },
  };
}
