import crypto from 'node:crypto';

// Server-side only. Single-user HMAC session cookie helpers.

export const COOKIE_NAME = 'session';
export const SESSION_MAX_AGE_S = 30 * 24 * 3600;
const MIN_SECRET_LENGTH = 32;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function getSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    console.error(`SESSION_SECRET is missing or shorter than ${MIN_SECRET_LENGTH} characters`);
    return null;
  }
  return secret;
}

const DOMAIN_RE = /^\.?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

// Optional COOKIE_DOMAIN. An invalid value is ignored (host-only cookie is the safe fallback).
function cookieDomain() {
  const domain = process.env.COOKIE_DOMAIN?.trim();
  if (!domain) return null;
  if (!DOMAIN_RE.test(domain)) {
    console.error('COOKIE_DOMAIN is not a valid domain; ignoring it');
    return null;
  }
  return domain;
}

function signature(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest();
}

// Token = "<expiry epoch ms>.<base64url HMAC-SHA256 of the expiry>"
export function createSessionToken(now = Date.now()) {
  const secret = getSecret();
  if (!secret) return null;
  const payload = String(now + SESSION_MAX_AGE_S * 1000);
  return `${payload}.${signature(payload, secret).toString('base64url')}`;
}

export function verifySessionToken(token, now = Date.now()) {
  const secret = getSecret();
  if (!secret || typeof token !== 'string' || token.length > 200) return false;
  const parts = token.split('.');
  if (parts.length !== 2 || !/^\d{1,15}$/.test(parts[0])) return false;

  const given = Buffer.from(parts[1], 'base64url');
  const expected = signature(parts[0], secret);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return false;

  return Number(parts[0]) > now;
}

function readCookie(req, name) {
  const header = req.headers?.cookie;
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0 && part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

export function isAuthenticated(req) {
  return verifySessionToken(readCookie(req, COOKIE_NAME));
}

// Set-Cookie value. Secure everywhere except localhost so `vercel dev` works.
export function buildSessionCookie(req, token, maxAgeSeconds) {
  const host = String(req.headers?.host || '').toLowerCase().replace(/:\d+$/, '');
  const attrs = [`${COOKIE_NAME}=${token}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${maxAgeSeconds}`];
  if (!LOCAL_HOSTS.has(host)) {
    attrs.push('Secure');
    // Host-only unless COOKIE_DOMAIN is set (e.g. ".example.com" shares the login across subdomains)
    const domain = cookieDomain();
    if (domain) attrs.push(`Domain=${domain}`);
  }
  return attrs.join('; ');
}

// Call at the top of every route handler: `if (!requireAuth(req, res)) return;`
export function requireAuth(req, res) {
  if (isAuthenticated(req)) return true;
  res.status(401).json({ error: 'Unauthorized' });
  return false;
}
