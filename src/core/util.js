import crypto from 'node:crypto';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const clone = (o) => (o === undefined ? undefined : structuredClone(o));
export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const round = (n, d = 4) => {
  const f = 10 ** d;
  return Math.round((n + Number.EPSILON) * f) / f;
};
export const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
export const uid = (n = 8) => crypto.randomBytes(n).toString('hex');
export const md5 = (s) => crypto.createHash('md5').update(String(s)).digest('hex');
export const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));

/** Stable hash -> int, handy for deterministic "random" attributes per entity. */
export const hashInt = (s) => parseInt(md5(s).slice(0, 8), 16);

export const rnd = {
  int: (a, b) => Math.floor(Math.random() * (b - a + 1)) + a,
  float: (a, b, d = 2) => round(Math.random() * (b - a) + a, d),
  pick: (arr) => arr[Math.floor(Math.random() * arr.length)],
  chance: (p = 0.5) => Math.random() < p,
  sample(arr, n) {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, n);
  },
  digits: (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join(''),
  alnum: (n) => Array.from({ length: n }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join(''),
  /** weighted([[value, weight], ...]) */
  weighted(entries) {
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let r = Math.random() * total;
    for (const [v, w] of entries) {
      if ((r -= w) <= 0) return v;
    }
    return entries[entries.length - 1][0];
  },
};

// ---- dates (eMAG works in Europe/Bucharest) -------------------------------
const TZ = 'Europe/Bucharest';
const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const offsetFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' });

function parts(d) {
  const o = {};
  for (const p of partsFmt.formatToParts(d)) o[p.type] = p.value;
  return o;
}
function offsetMinutes(d) {
  const v = offsetFmt.formatToParts(d).find((p) => p.type === 'timeZoneName')?.value || 'GMT';
  const m = v.match(/GMT([+-])(\d{1,2}):?(\d{2})?/);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
}

/** "YYYY-mm-dd HH:ii:ss" in Bucharest time — the format used all over the API. */
export function fmtDateTime(d = new Date()) {
  const p = parts(d);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
export const fmtDate = (d = new Date()) => fmtDateTime(d).slice(0, 10);

/** ISO 8601 with Bucharest offset, e.g. 2026-06-27T09:59:56+03:00 */
export function isoOffset(d = new Date()) {
  const off = offsetMinutes(d);
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return `${fmtDateTime(d).replace(' ', 'T')}${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

/** Parse "YYYY-mm-dd[ HH:ii:ss]" (Bucharest time) or any ISO string to a Date. Returns null if invalid. */
export function parseDateTime(s) {
  if (s instanceof Date) return s;
  if (typeof s !== 'string') return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?$/);
  if (m) {
    const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    return new Date(guess - offsetMinutes(new Date(guess)) * 60000);
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}
export const daysAgo = (n, jitter = 0) => new Date(Date.now() - n * 864e5 - Math.random() * jitter * 864e5);
export const addDays = (d, n) => new Date(d.getTime() + n * 864e5);

// ---- identifiers ----------------------------------------------------------
export function ean13(prefix = '59') {
  const base = prefix + rnd.digits(12 - prefix.length);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (i % 2 === 0 ? 1 : 3);
  return base + ((10 - (sum % 10)) % 10);
}

export function leafCount(v) {
  if (Array.isArray(v)) return v.reduce((s, x) => s + leafCount(x), 0);
  if (isObj(v)) return Object.values(v).reduce((s, x) => s + leafCount(x), 0);
  return 1;
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Recursive merge of plain objects. Keys that could reach Object.prototype are ignored (prototype pollution). */
export function deepMerge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (UNSAFE_KEYS.has(k)) continue;
    if (isObj(v) && isObj(target[k]) && Object.hasOwn(target, k)) deepMerge(target[k], v);
    else target[k] = clone(v);
  }
  return target;
}

/** Strips internal "_"-prefixed keys (used to keep generator hints on stored docs). */
export function publicView(doc) {
  if (Array.isArray(doc)) return doc.map(publicView);
  if (!isObj(doc)) return doc;
  const out = {};
  for (const [k, v] of Object.entries(doc)) if (!k.startsWith('_')) out[k] = publicView(v);
  return out;
}
