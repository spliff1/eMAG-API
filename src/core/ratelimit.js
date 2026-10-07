/**
 * Sliding-window rate limiter mirroring the documented eMAG limits:
 *   orders          12 req/s,  720 req/min
 *   everything else  3 req/s,  180 req/min (cumulated)
 *   find_by_eans     5 req/s,  200 req/min
 */
export const LIMITS = {
  orders: { perSec: 12, perMin: 720 },
  ean: { perSec: 5, perMin: 200 },
  default: { perSec: 3, perMin: 180 },
};

/** Sliding window per key; stale keys are pruned so the map cannot grow without bound. */
function createWindow() {
  const hits = new Map(); // key -> number[] (timestamps, ms)
  let calls = 0;
  const prune = (now) => { for (const [k, arr] of hits) if (now - arr[arr.length - 1] >= 60_000) hits.delete(k); };
  return function check(key, perSec, perMin) {
    const now = Date.now();
    if (++calls % 1000 === 0) prune(now);
    const arr = (hits.get(key) || []).filter((t) => now - t < 60_000);
    const inLastSec = arr.filter((t) => now - t < 1000).length;
    const allowed = inLastSec < perSec && arr.length < perMin;
    // Invalid / rejected requests count toward the limit too (as documented).
    arr.push(now);
    hits.set(key, arr);
    return { allowed, inLastSec };
  };
}

/** The documented eMAG limits, tracked per client address AND API username (the username is attacker-chosen in "any" auth mode). */
export function createRateLimiter() {
  const win = createWindow();
  return function check(ip, user, group = 'default') {
    const limit = LIMITS[group] || LIMITS.default;
    const { allowed, inLastSec } = win(`${ip}|${user}|${group}`, limit.perSec, limit.perMin);
    return { allowed, limit: limit.perSec, remaining: Math.max(0, limit.perSec - inLastSec - 1) };
  };
}

/**
 * Hard per-address ceiling for the public API that cannot be switched off from the UI (abuse / flooding guard).
 * Env: ABUSE_LIMIT_PER_SEC (default 100), ABUSE_LIMIT_PER_MIN (default 3000); 0 disables.
 */
export const ABUSE_LIMITS = {
  perSec: Number(process.env.ABUSE_LIMIT_PER_SEC ?? 100),
  perMin: Number(process.env.ABUSE_LIMIT_PER_MIN ?? 3000),
};
export function createAbuseGuard() {
  const win = createWindow();
  return function check(ip) {
    if (!(ABUSE_LIMITS.perSec > 0) && !(ABUSE_LIMITS.perMin > 0)) return true;
    return win(`ip|${ip}`, ABUSE_LIMITS.perSec > 0 ? ABUSE_LIMITS.perSec : Infinity, ABUSE_LIMITS.perMin > 0 ? ABUSE_LIMITS.perMin : Infinity).allowed;
  };
}
