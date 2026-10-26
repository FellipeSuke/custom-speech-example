const crypto = require('node:crypto');

const COOKIE_NAME = 'speech_admin_session';
const SESSION_TTL_SECONDS = 8 * 60 * 60;

const sign = (value, secret) => crypto.createHmac('sha256', secret).update(value).digest('base64url');

const createSession = (username, secret, now = Math.floor(Date.now() / 1000)) => {
  const payload = Buffer.from(JSON.stringify({username, exp: now + SESSION_TTL_SECONDS})).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
};

const readSession = (value, secret, now = Math.floor(Date.now() / 1000)) => {
  if (typeof value !== 'string') return null;
  const [payload, signature] = value.split('.');
  if (!payload || !signature) return null;
  const expected = sign(payload, secret);
  const actual = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actual.length !== expectedBuffer.length || !crypto.timingSafeEqual(actual, expectedBuffer)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return session && typeof session.username === 'string' && Number(session.exp) > now ? session : null;
  } catch {
    return null;
  }
};

const getSessionSecret = () => process.env.ADMIN_SESSION_SECRET || '';

const getCookie = (header, name) => {
  if (typeof header !== 'string') return undefined;
  const prefix = `${name}=`;
  const item = header.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
  return item ? decodeURIComponent(item.slice(prefix.length)) : undefined;
};

const setSessionCookie = (res, value) => {
  const secure = process.env.ADMIN_COOKIE_SECURE !== 'false';
  const flags = [`${COOKIE_NAME}=${encodeURIComponent(value)}`, 'Path=/admin', 'HttpOnly', 'SameSite=Strict', `Max-Age=${SESSION_TTL_SECONDS}`];
  if (secure) flags.push('Secure');
  res.append('Set-Cookie', flags.join('; '));
};

const clearSessionCookie = (res) => res.append('Set-Cookie', `${COOKIE_NAME}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0`);

const requireAdmin = (req, res, next) => {
  const secret = getSessionSecret();
  const session = secret ? readSession(getCookie(req.headers.cookie, COOKIE_NAME), secret) : null;
  if (!session) return res.status(401).json({error: 'Authentication required'});
  req.adminSession = session;
  return next();
};

module.exports = {COOKIE_NAME, createSession, readSession, setSessionCookie, clearSessionCookie, requireAdmin, getSessionSecret, getCookie};
