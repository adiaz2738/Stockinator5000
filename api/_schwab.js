import crypto from 'node:crypto';
import sql from './_db.js';

// Server-side only. Schwab Trader API (Individual) OAuth + authenticated requests.
// Tokens are stored encrypted in Neon. Access tokens last 30 minutes and are refreshed automatically;
// the refresh token lasts 7 days, after which the user must reconnect (Schwab's rule, not ours).

const USER_ID = 'local';
export const AUTHORIZE_URL = 'https://api.schwabapi.com/v1/oauth/authorize';
const TOKEN_URL = 'https://api.schwabapi.com/v1/oauth/token';
export const TRADER_BASE = 'https://api.schwabapi.com/trader/v1';
export const MARKET_BASE = 'https://api.schwabapi.com/marketdata/v1';
const REFRESH_TOKEN_DAYS = 7;
const STATE_MAX_AGE_MIN = 10;

// Thrown when there is no usable connection; routes answer 409 (never 401, which would log the user out of the app).
export class SchwabNotConnected extends Error {
  constructor(reason = 'not_connected') {
    super(reason);
    this.reason = reason;
  }
}

export function schwabConfig() {
  const appKey = process.env.SCHWAB_APP_KEY;
  const appSecret = process.env.SCHWAB_APP_SECRET;
  const callbackUrl = process.env.SCHWAB_CALLBACK_URL;
  if (!appKey || !appSecret || !callbackUrl) return null;
  return { appKey, appSecret, callbackUrl };
}

export async function ensureSchwabTables() {
  await sql`
    CREATE TABLE IF NOT EXISTS schwab_tokens (
      user_id            TEXT PRIMARY KEY,
      access_enc         TEXT NOT NULL,
      refresh_enc        TEXT NOT NULL,
      access_expires_at  TIMESTAMPTZ NOT NULL,
      refresh_expires_at TIMESTAMPTZ NOT NULL,
      connected_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at         TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS schwab_oauth_state (
      state      TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
}

// ---------- Encryption (AES-256-GCM, key derived from SESSION_SECRET) ----------

function encryptionKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not configured');
  return Buffer.from(crypto.hkdfSync('sha256', secret, 'stockinator5000', 'schwab-tokens', 32));
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

function decrypt(payload) {
  const [iv, tag, data] = String(payload).split('.').map((p) => Buffer.from(p, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

// ---------- OAuth state (proves the login was started from a logged-in session) ----------

export async function createOAuthState() {
  await ensureSchwabTables();
  const state = crypto.randomBytes(24).toString('base64url');
  await sql`DELETE FROM schwab_oauth_state WHERE created_at < NOW() - make_interval(mins => ${STATE_MAX_AGE_MIN})`;
  await sql`INSERT INTO schwab_oauth_state (state) VALUES (${state})`;
  return state;
}

// Single use: returns true only if the state existed and was fresh, and deletes it either way.
export async function consumeOAuthState(state) {
  if (typeof state !== 'string' || state.length < 16 || state.length > 100) return false;
  await ensureSchwabTables();
  const rows = await sql`
    DELETE FROM schwab_oauth_state WHERE state = ${state}
    RETURNING created_at > NOW() - make_interval(mins => ${STATE_MAX_AGE_MIN}) AS fresh
  `;
  return rows.length === 1 && rows[0].fresh === true;
}

// ---------- Tokens ----------

async function tokenRequest(params) {
  const cfg = schwabConfig();
  if (!cfg) throw new Error('Schwab env vars are not configured');
  const basic = Buffer.from(`${cfg.appKey}:${cfg.appSecret}`).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) {
    // Log Schwab's error body (it never contains our secret) to help debugging in Vercel logs
    console.error(`Schwab token request failed (${res.status}):`, text.slice(0, 300));
    const err = new Error(`token_request_failed_${res.status}`);
    err.status = res.status;
    throw err;
  }
  const json = JSON.parse(text);
  if (!json.access_token || !json.refresh_token) throw new Error('token_response_incomplete');
  return json;
}

// Called once from the OAuth callback. Starts the 7-day refresh-token window.
export async function exchangeCodeForTokens(code) {
  const cfg = schwabConfig();
  const json = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: cfg.callbackUrl });
  await ensureSchwabTables();
  const accessExpires = new Date(Date.now() + (Number(json.expires_in) || 1800) * 1000);
  const refreshExpires = new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 3600 * 1000);
  await sql`
    INSERT INTO schwab_tokens (user_id, access_enc, refresh_enc, access_expires_at, refresh_expires_at, connected_at, updated_at)
    VALUES (${USER_ID}, ${encrypt(json.access_token)}, ${encrypt(json.refresh_token)}, ${accessExpires.toISOString()}, ${refreshExpires.toISOString()}, NOW(), NOW())
    ON CONFLICT (user_id) DO UPDATE SET
      access_enc = EXCLUDED.access_enc, refresh_enc = EXCLUDED.refresh_enc,
      access_expires_at = EXCLUDED.access_expires_at, refresh_expires_at = EXCLUDED.refresh_expires_at,
      connected_at = NOW(), updated_at = NOW()
  `;
}

async function loadTokens() {
  await ensureSchwabTables();
  const rows = await sql`SELECT * FROM schwab_tokens WHERE user_id = ${USER_ID}`;
  return rows[0] || null;
}

// Refresh the access token. The refresh token's 7-day expiry is NOT extended by refreshing.
async function refreshAccessToken(row) {
  let json;
  try {
    json = await tokenRequest({ grant_type: 'refresh_token', refresh_token: decrypt(row.refresh_enc) });
  } catch (err) {
    if (err.status === 400 || err.status === 401) throw new SchwabNotConnected('expired');
    throw err;
  }
  const accessExpires = new Date(Date.now() + (Number(json.expires_in) || 1800) * 1000);
  await sql`
    UPDATE schwab_tokens SET
      access_enc = ${encrypt(json.access_token)},
      refresh_enc = ${encrypt(json.refresh_token)},
      access_expires_at = ${accessExpires.toISOString()},
      updated_at = NOW()
    WHERE user_id = ${USER_ID}
  `;
  return json.access_token;
}

export async function getAccessToken({ forceRefresh = false } = {}) {
  if (!schwabConfig()) throw new SchwabNotConnected('not_configured');
  const row = await loadTokens();
  if (!row) throw new SchwabNotConnected('not_connected');
  if (new Date(row.refresh_expires_at).getTime() <= Date.now()) throw new SchwabNotConnected('expired');
  const accessValid = new Date(row.access_expires_at).getTime() - Date.now() > 60 * 1000;
  if (accessValid && !forceRefresh) return decrypt(row.access_enc);
  return refreshAccessToken(row);
}

export async function connectionStatus() {
  if (!schwabConfig()) return { configured: false, connected: false };
  const row = await loadTokens();
  if (!row) return { configured: true, connected: false, reason: 'not_connected' };
  const expiresAt = new Date(row.refresh_expires_at);
  const msLeft = expiresAt.getTime() - Date.now();
  if (msLeft <= 0) return { configured: true, connected: false, reason: 'expired', expiredAt: expiresAt.toISOString() };
  return {
    configured: true,
    connected: true,
    connectedAt: new Date(row.connected_at).toISOString(),
    expiresAt: expiresAt.toISOString(),
    daysLeft: Math.floor(msLeft / (24 * 3600 * 1000)),
    hoursLeft: Math.floor(msLeft / (3600 * 1000)),
  };
}

export async function disconnect() {
  await ensureSchwabTables();
  await sql`DELETE FROM schwab_tokens WHERE user_id = ${USER_ID}`;
}

// GET a Schwab API URL with the current access token. Retries once with a fresh token on 401.
export async function schwabGet(url) {
  let token = await getAccessToken();
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 401 && attempt === 0) {
      token = await getAccessToken({ forceRefresh: true });
      continue;
    }
    if (!res.ok) {
      const body = await res.text();
      console.error(`Schwab GET failed (${res.status}) ${url.split('?')[0]}:`, body.slice(0, 300));
      const err = new Error(`schwab_request_failed_${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }
  throw new SchwabNotConnected('expired');
}

// Everything the browser needs to open Schwab's live data WebSocket: the socket URL and client ids from the user's
// preferences, plus a current access token (valid up to 30 minutes; the browser asks again when reconnecting).
export async function streamerCredentials() {
  const prefs = await schwabGet(`${TRADER_BASE}/userPreference`);
  const info = Array.isArray(prefs?.streamerInfo) ? prefs.streamerInfo[0] : null;
  if (!info?.streamerSocketUrl) throw new Error('streamer_info_missing');
  return {
    url: info.streamerSocketUrl,
    customerId: info.schwabClientCustomerId,
    correlId: info.schwabClientCorrelId,
    channel: info.schwabClientChannel,
    functionId: info.schwabClientFunctionId,
    accessToken: await getAccessToken(),
  };
}
