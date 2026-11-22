import sql from '../_db.js';
import { requireAuth } from '../_auth.js';
import { MARKET_BASE, SchwabNotConnected, schwabGet } from '../_schwab.js';

// Watchlist (Schwab's API has no watchlists, so the list lives here).
//   GET    /api/watchlist            rows with the latest saved valuation per ticker and current Schwab quotes
//   POST   /api/watchlist            { tickers: ['AAPL', 'MCD'] } or { tickers: 'AAPL, MCD V' }  (adds; duplicates ignored)
//   DELETE /api/watchlist?ticker=X   removes one ticker
// Quotes are null when Schwab isn't connected; the page then says so. Real data only.

const USER_ID = 'local';
const TICKER_RE = /^[A-Z][A-Z0-9.\-\/]{0,9}$/;
const MAX_ITEMS = 200;

async function ensureTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS watchlist (
      user_id  TEXT NOT NULL DEFAULT 'local',
      ticker   TEXT NOT NULL,
      added_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, ticker)
    )
  `;
}

function parseTickers(input) {
  const list = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[\s,;]+/) : [];
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const t = raw.trim().toUpperCase().replace(/^\$/, '');
    if (TICKER_RE.test(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

const num = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

export async function fetchQuotes(tickers) {
  if (!tickers.length) return { quotes: {}, schwab: 'ok' };
  const quotes = {};
  try {
    // Schwab accepts a comma-separated batch
    for (let i = 0; i < tickers.length; i += 100) {
      const batch = tickers.slice(i, i + 100);
      const qs = new URLSearchParams({ symbols: batch.join(','), fields: 'quote,reference,fundamental' });
      const data = await schwabGet(`${MARKET_BASE}/quotes?${qs}`);
      for (const [sym, item] of Object.entries(data || {})) {
        const q = item?.quote || {};
        quotes[sym.toUpperCase()] = {
          last: num(q.lastPrice) ?? num(q.mark),
          prevClose: num(q.closePrice),
          changePct: num(q.netPercentChange),
          high52: num(q['52WeekHigh']),
          low52: num(q['52WeekLow']),
          divYield: num(item?.fundamental?.divYield), // percent, as Schwab reports it
          description: typeof item?.reference?.description === 'string' ? item.reference.description.slice(0, 200) : null,
        };
      }
    }
    return { quotes, schwab: 'ok' };
  } catch (err) {
    if (err instanceof SchwabNotConnected) return { quotes: {}, schwab: 'not_connected' };
    console.error('watchlist quotes failed:', err.message);
    return { quotes: {}, schwab: 'error' };
  }
}

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  try {
    await ensureTable();

    if (req.method === 'GET') {
      const rows = await sql`
        SELECT w.ticker, w.added_at, v.company_name, v.intrinsic_value, v.safety_price, v.margin_of_safety,
               v.created_at AS valued_at, v.id AS valuation_id
        FROM watchlist w
        LEFT JOIN LATERAL (
          SELECT * FROM valuations
          WHERE user_id = ${USER_ID} AND UPPER(ticker) = w.ticker
          ORDER BY created_at DESC LIMIT 1
        ) v ON TRUE
        WHERE w.user_id = ${USER_ID}
        ORDER BY w.added_at
      `;
      const { quotes, schwab } = await fetchQuotes(rows.map((r) => r.ticker));
      const items = rows.map((r) => ({
        ticker: r.ticker,
        companyName: r.company_name || quotes[r.ticker]?.description || null,
        addedAt: r.added_at,
        valuation: r.valuation_id ? {
          intrinsicValue: num(r.intrinsic_value),
          buyBelow: num(r.safety_price),
          marginOfSafety: num(r.margin_of_safety),
          valuedAt: r.valued_at,
        } : null,
        quote: quotes[r.ticker] || null,
      }));
      return res.status(200).json({ items, schwab, fetchedAt: new Date().toISOString() });
    }

    if (req.method === 'POST') {
      const tickers = parseTickers(req.body?.tickers);
      if (!tickers.length) return res.status(400).json({ error: 'Enter at least one valid ticker' });
      const count = await sql`SELECT COUNT(*)::int AS n FROM watchlist WHERE user_id = ${USER_ID}`;
      if (count[0].n + tickers.length > MAX_ITEMS) return res.status(400).json({ error: `The watchlist holds up to ${MAX_ITEMS} tickers` });
      for (const t of tickers) {
        await sql`INSERT INTO watchlist (user_id, ticker) VALUES (${USER_ID}, ${t}) ON CONFLICT DO NOTHING`;
      }
      return res.status(200).json({ added: tickers });
    }

    if (req.method === 'DELETE') {
      const t = parseTickers(String(req.query?.ticker || ''))[0];
      if (!t) return res.status(400).json({ error: 'Invalid ticker' });
      await sql`DELETE FROM watchlist WHERE user_id = ${USER_ID} AND ticker = ${t}`;
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('watchlist handler failed:', err);
    return res.status(500).json({ error: 'Watchlist request failed' });
  }
}
