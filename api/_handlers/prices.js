import sql from '../_db.js';
import { requireAuth } from '../_auth.js';
import { MARKET_BASE, SchwabNotConnected, schwabGet, toSchwabSymbol } from '../_schwab.js';

// GET /api/prices?ticker=AAPL                 daily OHLCV (Schwab when connected, otherwise FMP's free tier)
// GET /api/prices?ticker=AAPL&freq=5&ext=1    intraday minute bars from Schwab (freq 1, 5, 15 or 30; ext=1 adds pre/after-hours)
// Daily bars are cached per ticker in Neon (`price_history`): Schwab data for 1 hour, FMP data for 24 hours, and an FMP
// cache is replaced by Schwab data as soon as Schwab is connected. Intraday bars aren't stored (the browser keeps them
// briefly). Real data only: nothing is generated or filled in.
// Responses: 200 { ticker, source: 'schwab' | 'fmp', bars: [{ t, o, h, l, c, v }] }, 404 { error: 'unavailable' },
// 409 { error: 'schwab_needed' } for intraday without a Schwab connection.

const USER_ID = 'local';
const FMP_BASE_URL = 'https://financialmodelingprep.com/stable';
const TICKER_RE = /^[A-Z][A-Z0-9.\-\/]{0,9}$/;
const MINUTE_FREQS = new Set([1, 5, 15, 30]);
const TTL_MS = { schwab: 3600 * 1000, fmp: 24 * 3600 * 1000 };
const HISTORY_YEARS = 30; // FMP's free tier caps a response at 5,000 rows (about 20 years), newest kept
const DAY = 86400000;

async function ensureTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS price_history (
      user_id TEXT NOT NULL DEFAULT 'local',
      ticker TEXT NOT NULL,
      bars JSONB NOT NULL,
      fetched_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, ticker)
    )
  `;
  await sql`ALTER TABLE price_history ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'fmp'`;
}

const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const validBar = (b) => [b.t, b.o, b.h, b.l, b.c, b.v].every(Number.isFinite) && b.h >= Math.max(b.o, b.c) - 1e-6 && b.l <= Math.min(b.o, b.c) + 1e-6;

// ---------- FMP (free tier, daily only) ----------

// FMP rows -> [{ t (UTC midnight ms), o, h, l, c, v }] oldest first. Returns null if any row is unusable.
function normaliseFmp(rows) {
  const bars = [];
  for (const r of rows) {
    const b = { t: Date.parse(`${r.date}T00:00:00Z`), o: num(r.open), h: num(r.high), l: num(r.low), c: num(r.close), v: num(r.volume) };
    if (!validBar(b)) return null;
    bars.push(b);
  }
  bars.sort((a, b) => a.t - b.t);
  return bars.length ? bars : null;
}

async function fetchFromFmp(ticker) {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) throw new Error('FMP_API_KEY is not configured');
  const to = new Date();
  const from = new Date(to.getTime() - HISTORY_YEARS * 365.25 * DAY);
  const iso = (d) => d.toISOString().slice(0, 10);
  const url = `${FMP_BASE_URL}/historical-price-eod/full?symbol=${encodeURIComponent(ticker.replace(/^([A-Z]+)[./]([A-Z])$/, '$1-$2'))}&from=${iso(from)}&to=${iso(to)}&apikey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if ([400, 402, 403, 404].includes(res.status)) return null;
  if (!res.ok) throw new Error(`FMP price request failed with status ${res.status}`);
  const json = await res.json();
  const rows = Array.isArray(json) ? json : json?.historical;
  if (!Array.isArray(rows) || !rows.length) return null;
  const bars = normaliseFmp(rows);
  if (!bars) throw new Error('FMP rows missing open/high/low/close/volume');
  return bars;
}

// ---------- Schwab ----------

// The calendar date of an instant in New York, as UTC midnight (daily bars use UTC-midnight timestamps app-wide).
const nyDate = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
function utcMidnightOfNyDate(ms) {
  const p = Object.fromEntries(nyDate.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day));
}

// Schwab candles -> bars. Unusable rows are skipped (not invented). Daily candles are stamped at midnight Central time,
// so they're re-stamped to UTC midnight of their trading date.
function normaliseSchwab(candles, daily) {
  const out = new Map();
  for (const k of Array.isArray(candles) ? candles : []) {
    const t = daily ? utcMidnightOfNyDate(num(k.datetime) + 6 * 3600 * 1000) : num(k.datetime);
    const b = { t, o: num(k.open), h: num(k.high), l: num(k.low), c: num(k.close), v: num(k.volume) };
    if (validBar(b)) out.set(b.t, b);
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}

async function schwabHistory(ticker, params) {
  const qs = new URLSearchParams({ symbol: toSchwabSymbol(ticker), ...params });
  try {
    return await schwabGet(`${MARKET_BASE}/pricehistory?${qs}`);
  } catch (err) {
    if (err.status === 400 || err.status === 404) return null; // bad symbol or unsupported range
    throw err;
  }
}

async function schwabDaily(ticker) {
  const now = Date.now();
  // Full history; if Schwab rejects the long range, ask for its 20-year period instead
  let json = await schwabHistory(ticker, { periodType: 'year', frequencyType: 'daily', frequency: '1', startDate: String(Date.UTC(1980, 0, 1)), endDate: String(now), needExtendedHoursData: 'false' });
  if (!json?.candles?.length) json = await schwabHistory(ticker, { periodType: 'year', period: '20', frequencyType: 'daily', frequency: '1', needExtendedHoursData: 'false' });
  const bars = normaliseSchwab(json?.candles, true);
  return bars.length ? bars : null;
}

// How far back each minute frequency asks for. Schwab returns what it has, so a shorter history is fine.
const INTRADAY_DAYS = { 1: 45, 5: 270, 15: 270, 30: 270 };
async function schwabIntraday(ticker, freq, ext) {
  const now = Date.now();
  let json = await schwabHistory(ticker, { periodType: 'day', frequencyType: 'minute', frequency: String(freq), startDate: String(now - INTRADAY_DAYS[freq] * DAY), endDate: String(now), needExtendedHoursData: String(ext) });
  if (!json?.candles?.length) json = await schwabHistory(ticker, { periodType: 'day', period: '10', frequencyType: 'minute', frequency: String(freq), needExtendedHoursData: String(ext) });
  const bars = normaliseSchwab(json?.candles, false);
  return bars.length ? bars : null;
}

// ---------- Route ----------

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ticker = String(typeof req.query?.ticker === 'string' ? req.query.ticker : '').trim().toUpperCase();
  if (!TICKER_RE.test(ticker)) return res.status(400).json({ error: 'Enter a valid ticker' });
  const freq = req.query?.freq === undefined ? null : Number(req.query.freq);
  const ext = req.query?.ext === '1';

  try {
    // ----- intraday: Schwab only, not stored -----
    if (freq !== null) {
      if (!MINUTE_FREQS.has(freq)) return res.status(400).json({ error: 'freq must be 1, 5, 15 or 30' });
      let bars;
      try {
        bars = await schwabIntraday(ticker, freq, ext);
      } catch (err) {
        if (err instanceof SchwabNotConnected) return res.status(409).json({ error: 'schwab_needed', reason: err.reason });
        console.error('Schwab intraday failed:', err.message);
        return res.status(502).json({ error: 'Price data could not be loaded' });
      }
      if (!bars) return res.status(404).json({ error: 'unavailable' });
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).json({ ticker, source: 'schwab', freq, ext, bars });
    }

    // ----- daily: Schwab when connected, else FMP; cached in Neon -----
    await ensureTable();
    const rows = await sql`SELECT bars, fetched_at, source FROM price_history WHERE user_id = ${USER_ID} AND ticker = ${ticker}`;
    const cached = rows[0];
    const cachedSource = cached?.source || 'fmp';
    const age = cached ? Date.now() - new Date(cached.fetched_at).getTime() : Infinity;

    let schwabState = 'unknown'; // 'ok' | 'not_connected' | 'error'
    let bars = null;
    let source = null;

    // A fresh Schwab cache is used as-is. A fresh FMP cache is used only if Schwab can't give us anything better.
    if (cached && cachedSource === 'schwab' && age < TTL_MS.schwab) {
      return res.status(200).json({ ticker, source: 'schwab', cached: true, fetchedAt: new Date(cached.fetched_at).toISOString(), bars: cached.bars });
    }
    try {
      bars = await schwabDaily(ticker);
      schwabState = 'ok';
      if (bars) source = 'schwab';
    } catch (err) {
      schwabState = err instanceof SchwabNotConnected ? 'not_connected' : 'error';
      if (schwabState === 'error') console.error('Schwab daily failed:', err.message);
    }

    if (!bars) {
      if (cached && cachedSource === 'fmp' && age < TTL_MS.fmp) {
        return res.status(200).json({ ticker, source: 'fmp', cached: true, fetchedAt: new Date(cached.fetched_at).toISOString(), bars: cached.bars });
      }
      try {
        bars = await fetchFromFmp(ticker);
        if (bars) source = 'fmp';
      } catch (err) {
        console.error('FMP price fetch failed:', err.message);
      }
    }

    if (!bars) {
      // A failed refresh serves the last real data rather than nothing
      if (cached) return res.status(200).json({ ticker, source: cachedSource, cached: true, stale: true, fetchedAt: new Date(cached.fetched_at).toISOString(), bars: cached.bars });
      if (schwabState === 'error') return res.status(502).json({ error: 'Price data could not be loaded' });
      return res.status(404).json({ error: 'unavailable', schwab: schwabState });
    }

    const saved = await sql`
      INSERT INTO price_history (user_id, ticker, bars, fetched_at, source)
      VALUES (${USER_ID}, ${ticker}, ${JSON.stringify(bars)}::jsonb, NOW(), ${source})
      ON CONFLICT (user_id, ticker) DO UPDATE SET bars = EXCLUDED.bars, fetched_at = NOW(), source = EXCLUDED.source
      RETURNING fetched_at
    `;
    return res.status(200).json({ ticker, source, cached: false, fetchedAt: new Date(saved[0].fetched_at).toISOString(), bars });
  } catch (err) {
    console.error('prices handler failed:', err);
    return res.status(500).json({ error: 'Could not load price data' });
  }
}
