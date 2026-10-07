import { ApiError } from './response.js';

const MAX_BODY = 25 * 1024 * 1024;

/** Set TRUST_PROXY=1 only when the app sits behind a reverse proxy that overwrites X-Forwarded-For / X-Forwarded-Proto. */
export const TRUST_PROXY = process.env.TRUST_PROXY === '1';

/** Client address used for throttling and logging. Header values are only honoured when TRUST_PROXY is set. */
export function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    const first = (Array.isArray(xff) ? xff[0] : xff || '').split(',')[0].trim();
    if (first) return first.slice(0, 64);
  }
  return req.socket.remoteAddress || 'unknown';
}

/** True when the request arrived over TLS (directly, or at a trusted proxy). */
export const isHttps = (req) => !!req.socket.encrypted || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');

/** Browser hardening headers for the UI (static files + /__ui/api). The dummy API keeps its permissive CORS. */
export const UI_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
};

export function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new ApiError(413, ['Request body too large'])); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

export const sendJson = (res, status, obj, extra = {}) =>
  send(res, status, { 'Content-Type': 'application/json; charset=utf-8', ...extra }, JSON.stringify(obj));
