/**
 * Authentication for the web UI (NOT for the dummy eMAG API, which keeps its own Basic-auth behaviour).
 *
 *  - Registration is open only while the `users` table is empty: the FIRST account wins, after that
 *    registration is closed for good (enforced atomically in SQL, so two simultaneous sign-ups cannot both succeed).
 *  - Passwords: scrypt with a random salt. Sessions: random 256-bit token in an HttpOnly, SameSite=Strict cookie;
 *    only the SHA-256 of the token is stored.
 *  - Failed logins are throttled per client address.
 */
import crypto from 'node:crypto';
import { clientIp, isHttps } from '../core/net.js';

const COOKIE = 'dummy_emag_sid';
const SESSION_MS = 14 * 24 * 3600 * 1000;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const MAX_FAILS = 5;
const LOCK_MS = 60_000;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${dk.toString('base64')}`;
}
function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const dk = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
}

export class AuthError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createAuth(db) {
  const q = {
    count: db.prepare('SELECT COUNT(*) AS n FROM users'),
    firstUser: db.prepare('INSERT INTO users (username, password_hash, created_at) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)'),
    byName: db.prepare('SELECT * FROM users WHERE username = ?'),
    byId: db.prepare('SELECT * FROM users WHERE id = ?'),
    setPw: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
    addSession: db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)'),
    session: db.prepare('SELECT s.token_hash, s.expires_at, u.id AS user_id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?'),
    touch: db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?'),
    delSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    delUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?'),
    purge: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
  };
  const attempts = new Map(); // ip -> { fails, lockedUntil }

  const registrationOpen = () => q.count.get().n === 0;

  function validateNewCredentials(username, password) {
    if (typeof username !== 'string' || username.trim().length < 3) throw new AuthError(400, 'Username must be at least 3 characters');
    if (username.trim().length > 64) throw new AuthError(400, 'Username is too long');
    if (typeof password !== 'string' || password.length < 8) throw new AuthError(400, 'Password must be at least 8 characters');
    if (password.length > 256) throw new AuthError(400, 'Password is too long');
  }

  function createSession(userId, userAgent) {
    q.purge.run(Date.now());
    const token = crypto.randomBytes(32).toString('hex');
    q.addSession.run(sha256(token), userId, Date.now(), Date.now() + SESSION_MS, String(userAgent || '').slice(0, 200));
    return token;
  }

  function cookieHeader(token, req, maxAgeSec = SESSION_MS / 1000) {
    const secure = isHttps(req) || process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
    return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}${secure}`;
  }

  /** Returns { userId, username, token } for a valid session cookie, else null. */
  function sessionFrom(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
    const row = q.session.get(sha256(token));
    if (!row || row.expires_at < Date.now()) return null;
    if (row.expires_at - Date.now() < SESSION_MS - 24 * 3600 * 1000) q.touch.run(Date.now() + SESSION_MS, row.token_hash); // slide once a day
    return { userId: row.user_id, username: row.username, token };
  }

  function throttle(ip) {
    const a = attempts.get(ip);
    if (a?.lockedUntil > Date.now()) throw new AuthError(429, 'Too many failed attempts. Try again later.', { retryAfter: Math.ceil((a.lockedUntil - Date.now()) / 1000) });
  }
  const fail = (ip) => {
    const a = attempts.get(ip) || { fails: 0, lockedUntil: 0, at: 0 };
    a.fails += 1;
    a.at = Date.now();
    if (a.fails >= MAX_FAILS) { a.lockedUntil = Date.now() + LOCK_MS; a.fails = 0; }
    attempts.set(ip, a);
    if (attempts.size > 10_000) for (const [k, v] of attempts) if (Date.now() - v.at > LOCK_MS) attempts.delete(k); // bounded memory
  };

  return {
    registrationOpen,
    sessionFrom,
    status(req) {
      const s = sessionFrom(req);
      return { registrationOpen: registrationOpen(), authenticated: !!s, username: s?.username ?? null };
    },
    register(req, { username, password }) {
      validateNewCredentials(username, password);
      if (!registrationOpen()) throw new AuthError(403, 'Registration is closed: an account already exists');
      const name = username.trim();
      const r = q.firstUser.run(name, hashPassword(password), new Date().toISOString());
      if (r.changes !== 1) throw new AuthError(403, 'Registration is closed: an account already exists');
      const user = q.byName.get(name);
      return { token: createSession(user.id, req.headers['user-agent']), username: user.username };
    },
    login(req, { username, password }) {
      const ip = clientIp(req);
      throttle(ip);
      const user = typeof username === 'string' && typeof password === 'string' ? q.byName.get(username.trim()) : null;
      // always run a hash comparison so the response time does not reveal whether the user exists
      const ok = verifyPassword(typeof password === 'string' ? password : '', user?.password_hash ?? hashPassword('x'));
      if (!user || !ok) { fail(ip); throw new AuthError(401, 'Invalid username or password'); }
      attempts.delete(ip);
      return { token: createSession(user.id, req.headers['user-agent']), username: user.username };
    },
    logout(req) {
      const s = sessionFrom(req);
      if (s) q.delSession.run(sha256(s.token));
    },
    changePassword(req, { current, next }) {
      const s = sessionFrom(req);
      if (!s) throw new AuthError(401, 'Unauthorized');
      validateNewCredentials('xxx', next);
      const user = q.byId.get(s.userId);
      if (typeof current !== 'string' || !verifyPassword(current, user.password_hash)) throw new AuthError(401, 'Current password is incorrect');
      q.setPw.run(hashPassword(next), user.id);
      q.delUserSessions.run(user.id, sha256(s.token)); // sign out everywhere else
    },
    cookieHeader,
    clearCookie: (req) => cookieHeader('', req, 0),
  };
}
