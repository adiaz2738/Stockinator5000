import crypto from 'node:crypto';
import sql from './_db.js';
import { createSessionToken, buildSessionCookie, isAuthenticated, SESSION_MAX_AGE_S } from './_auth.js';

const MAX_FAILURES = 5;
const MAX_FIELD_LENGTH = 200;

async function ensureTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS login_attempts (
      id SERIAL PRIMARY KEY,
      ip TEXT NOT NULL,
      attempted_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(ip, attempted_at)`;
}

// First x-forwarded-for value (set by Vercel's edge); falls back to the socket address.
function clientIp(req) {
  const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return (forwarded || req.socket?.remoteAddress || 'unknown').slice(0, 64);
}

// Hash both sides with SHA-256 so lengths match, then compare in constant time.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const action = req.method === 'GET' ? req.query?.action : req.body?.action;

  try {
    if (req.method === 'GET' && action === 'me') {
      return res.status(200).json({ authenticated: isAuthenticated(req) });
    }

    if (req.method === 'POST' && action === 'logout') {
      res.setHeader('Set-Cookie', buildSessionCookie(req, '', 0));
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'POST' && action === 'login') {
      const expectedUser = process.env.APP_USERNAME;
      const expectedPass = process.env.APP_PASSWORD;
      if (!expectedUser || !expectedPass) {
        console.error('APP_USERNAME or APP_PASSWORD is not configured');
        return res.status(500).json({ error: 'Internal server error' });
      }

      await ensureTable();
      const ip = clientIp(req);

      const recent = await sql`
        SELECT COUNT(*)::int AS failures FROM login_attempts
        WHERE ip = ${ip} AND attempted_at > NOW() - INTERVAL '15 minutes'
      `;
      if (recent[0].failures >= MAX_FAILURES) {
        console.error('login locked out for ip', ip);
        return res.status(429).json({ error: 'Too many attempts. Try again later.' });
      }

      const username = typeof req.body?.username === 'string' ? req.body.username.slice(0, MAX_FIELD_LENGTH) : '';
      const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, MAX_FIELD_LENGTH) : '';
      // Evaluate both so a wrong username costs the same as a wrong password
      const userOk = safeEqual(username, expectedUser);
      const passOk = safeEqual(password, expectedPass);

      if (!(userOk && passOk)) {
        await sql`INSERT INTO login_attempts (ip) VALUES (${ip})`;
        await sql`DELETE FROM login_attempts WHERE attempted_at < NOW() - INTERVAL '1 day'`;
        return res.status(401).json({ error: 'Invalid username or password' });
      }

      const token = createSessionToken();
      if (!token) return res.status(500).json({ error: 'Internal server error' });
      await sql`DELETE FROM login_attempts WHERE ip = ${ip}`;
      res.setHeader('Set-Cookie', buildSessionCookie(req, token, SESSION_MAX_AGE_S));
      return res.status(200).json({ authenticated: true });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('auth api error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
