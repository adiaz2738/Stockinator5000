import sql from './_db.js';
import { requireAuth } from './_auth.js';

// GET /api/prices?ticker=AAPL
// Daily OHLCV for any ticker from FMP's free tier (the same endpoint scripts/fetch-sample-prices.js uses), cached per
// user and ticker in Neon and refreshed once a day. Real data only: nothing is generated or filled in. A symbol the free
// plan refuses answers 404 { error: 'unavailable' } so the chart can say so; the page then falls back to the committed
// sample files when it has one.

const USER_ID = 'local';
const FMP_BASE_URL = 'https://financialmodelingprep.com/stable';
const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const CACHE_MS = 24 * 3600 * 1000;
const HISTORY_YEARS = 30; // the free tier caps a response at 5,000 rows (about 20 years of trading days), newest kept

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
}

const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);

// Rows -> [{ t (UTC midnight ms), o, h, l, c, v }] oldest first. Returns null if any row is unusable.
function normalise(rows) {
  const bars = [];
  for (const r of rows) {
    const t = Date.parse(`${r.date}T00:00:00Z`);
    const bar = { t, o: num(r.open), h: num(r.high), l: num(r.low), c: num(r.close), v: num(r.volume) };
    if (!Number.isFinite(t) || [bar.o, bar.h, bar.l, bar.c, bar.v].some((x) => !Number.isFinite(x))) return null;
    if (bar.h < Math.max(bar.o, bar.c) - 1e-9 || bar.l > Math.min(bar.o, bar.c) + 1e-9) return null;
    bars.push(bar);
  }
  bars.sort((a, b) => a.t - b.t);
  return bars.length ? bars : null;
}

// { available: true, bars } | { available: false } when the free plan refuses or has no data; throws on other failures
async function fetchFromFmp(ticker) {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) throw new Error('FMP_API_KEY is not configured');
  const to = new Date();
  const from = new Date(to.getTime() - HISTORY_YEARS * 365.25 * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  const url = `${FMP_BASE_URL}/historical-price-eod/full?symbol=${encodeURIComponent(ticker)}&from=${iso(from)}&to=${iso(to)}&apikey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (res.status === 402 || res.status === 403 || res.status === 400 || res.status === 404) return { available: false };
  if (!res.ok) throw new Error(`FMP price request failed with status ${res.status}`);
  const json = await res.json();
  const rows = Array.isArray(json) ? json : json?.historical;
  if (!Array.isArray(rows) || !rows.length) return { available: false };
  const bars = normalise(rows);
  if (!bars) throw new Error('FMP rows missing open/high/low/close/volume');
  return { available: true, bars };
}

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ticker = String(typeof req.query?.ticker === 'string' ? req.query.ticker : '').trim().toUpperCase();
  if (!TICKER_RE.test(ticker)) return res.status(400).json({ error: 'Enter a valid ticker' });

  try {
    await ensureTable();
    const rows = await sql`SELECT bars, fetched_at FROM price_history WHERE user_id = ${USER_ID} AND ticker = ${ticker}`;
    const cached = rows[0];
    const age = cached ? Date.now() - new Date(cached.fetched_at).getTime() : Infinity;
    if (cached && age < CACHE_MS) {
      return res.status(200).json({ ticker, source: 'fmp', cached: true, fetchedAt: new Date(cached.fetched_at).toISOString(), bars: cached.bars });
    }

    let result;
    try {
      result = await fetchFromFmp(ticker);
    } catch (err) {
      console.error('price fetch failed:', err);
      // A failed refresh serves yesterday's real data rather than nothing
      if (cached) return res.status(200).json({ ticker, source: 'fmp', cached: true, stale: true, fetchedAt: new Date(cached.fetched_at).toISOString(), bars: cached.bars });
      return res.status(502).json({ error: 'Price data could not be loaded' });
    }
    if (!result.available) return res.status(404).json({ error: 'unavailable' });

    const saved = await sql`
      INSERT INTO price_history (user_id, ticker, bars, fetched_at)
      VALUES (${USER_ID}, ${ticker}, ${JSON.stringify(result.bars)}::jsonb, NOW())
      ON CONFLICT (user_id, ticker) DO UPDATE SET bars = EXCLUDED.bars, fetched_at = NOW()
      RETURNING fetched_at
    `;
    return res.status(200).json({ ticker, source: 'fmp', cached: false, fetchedAt: new Date(saved[0].fetched_at).toISOString(), bars: result.bars });
  } catch (err) {
    console.error('prices handler failed:', err);
    return res.status(500).json({ error: 'Could not load price data' });
  }
}
