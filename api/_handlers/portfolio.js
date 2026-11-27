import sql from '../_db.js';
import { requireAuth } from '../_auth.js';
import { TRADER_BASE, SchwabNotConnected, schwabGet, slimAccount } from '../_schwab.js';
import { fetchQuotes } from './watchlist.js';
import { parsePositionsCsv } from '../_portfolio.js';

// Portfolio: live Schwab accounts plus accounts imported from a positions CSV (Fidelity, including accounts linked
// into Fidelity from other brokers). Read-only; nothing here places orders.
//   GET    /api/portfolio                         everything the page needs (accounts, quotes, buy-below prices)
//   GET    /api/portfolio?action=costs        average cost per ticker across all accounts (for the chart's cost line)
//   POST   /api/portfolio  { csv }                import a positions file (each account in it replaces its old snapshot)
//   POST   /api/portfolio?action=label  { key, label }          rename an account (imported, or Schwab "schwab:1234"); blank resets
//   POST   /api/portfolio?action=cash   { key, cash }           correct an imported account's cash (the next upload replaces it)
//   POST   /api/portfolio?action=ticker { description, symbol } set the ticker for a holding the file has none for
//   POST   /api/portfolio?action=cost   { key, total, quantity } set (or clear, total null) a holding's total cost by hand
//   DELETE /api/portfolio?key=csv:1234            remove an imported account
// Only the last 4 digits of an account number are stored; owner names are stripped from account names.

const USER_ID = 'local';
const TICKER_RE = /^[A-Z][A-Z0-9.\-\/]{0,9}$/;
const MAX_CSV = 500000;

async function ensureTables() {
  await sql`
    CREATE TABLE IF NOT EXISTS portfolio_accounts (
      user_id      TEXT NOT NULL DEFAULT 'local',
      key          TEXT NOT NULL,
      source       TEXT NOT NULL,
      label        TEXT NOT NULL,
      custom_label TEXT,
      last4        TEXT,
      linked       BOOLEAN DEFAULT FALSE,
      cash         NUMERIC DEFAULT 0,
      holdings     JSONB NOT NULL,
      imported_at  TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, key)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS portfolio_settings (
      user_id    TEXT PRIMARY KEY,
      ticker_map JSONB NOT NULL DEFAULT '{}'::jsonb
    )
  `;
  await sql`ALTER TABLE portfolio_settings ADD COLUMN IF NOT EXISTS cost_map JSONB NOT NULL DEFAULT '{}'::jsonb`;
  // Names for Schwab accounts (Schwab's API only says CASH or MARGIN, not that an account is a Roth IRA): "schwab:1234" -> name
  await sql`ALTER TABLE portfolio_settings ADD COLUMN IF NOT EXISTS label_map JSONB NOT NULL DEFAULT '{}'::jsonb`;
}

const descKey = (d) => String(d || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 120);

// Hand-entered cost: "<account key>|<symbol or d:description>" -> { total, quantity }. Used only while the share count
// still matches, so a later buy or sell never leaves a stale cost behind.
async function costMap() {
  const r = await sql`SELECT cost_map FROM portfolio_settings WHERE user_id = ${USER_ID}`;
  return r[0]?.cost_map || {};
}

async function labelMap() {
  const r = await sql`SELECT label_map FROM portfolio_settings WHERE user_id = ${USER_ID}`;
  return r[0]?.label_map || {};
}

async function tickerMap() {
  const r = await sql`SELECT ticker_map FROM portfolio_settings WHERE user_id = ${USER_ID}`;
  return r[0]?.ticker_map || {};
}

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  const action = String(req.query?.action || '');
  try {
    await ensureTables();

    if (req.method === 'GET' && action === 'costs') {
      // Same cost rules as the Portfolio page: broker cost, unless a hand-entered cost matches the share count.
      // A ticker gets an average only when every account holding it has a cost; otherwise it is left out (no guess).
      const [map, cmap, imported] = await Promise.all([
        tickerMap(), costMap(),
        sql`SELECT key, holdings FROM portfolio_accounts WHERE user_id = ${USER_ID}`,
      ]);
      const lots = [];
      for (const a of imported) {
        for (const h of a.holdings || []) {
          const symbol = h.symbol || map[descKey(h.description)];
          if (!symbol || !(h.quantity > 0)) continue;
          lots.push({ acct: a.key, symbol, desc: h.description, quantity: h.quantity, cost: Number.isFinite(h.costBasis) ? h.costBasis : null });
        }
      }
      try {
        const data = await schwabGet(`${TRADER_BASE}/accounts?fields=positions`);
        for (const a of (Array.isArray(data) ? data : []).map(slimAccount)) {
          const key = `schwab:${a.last4 || ''}`;
          for (const p of a.positions || []) {
            const qty = (p.longQuantity || 0) - (p.shortQuantity || 0);
            if (!p.symbol || p.assetType === 'CASH_EQUIVALENT' || qty <= 0) continue;
            lots.push({ acct: key, symbol: p.symbol, quantity: qty, cost: Number.isFinite(p.averagePrice) && p.averagePrice > 0 ? p.averagePrice * qty : null }); // 0 = no basis on file
          }
        }
      } catch (err) {
        if (!(err instanceof SchwabNotConnected)) console.error('portfolio costs: schwab failed:', err.message);
      }
      const costs = {};
      for (const l of lots) {
        const o = cmap[`${l.acct}|${l.symbol}`];
        if (o && Number.isFinite(o.total) && Math.abs(o.quantity - l.quantity) < 0.001) l.cost = o.total;
        const sym = String(l.symbol).toUpperCase();
        const c = costs[sym] || (costs[sym] = { shares: 0, cost: 0, complete: true });
        c.shares += l.quantity;
        if (Number.isFinite(l.cost)) c.cost += l.cost; else c.complete = false;
      }
      const out = {};
      for (const [sym, c] of Object.entries(costs)) {
        out[sym] = { shares: Math.round(c.shares * 1000) / 1000, avgCost: c.complete && c.shares > 0 ? Math.round((c.cost / c.shares) * 100) / 100 : null };
      }
      return res.status(200).json({ costs: out });
    }

    if (req.method === 'GET') {
      const imported = await sql`SELECT key, source, label, custom_label, last4, linked, cash, holdings, imported_at FROM portfolio_accounts WHERE user_id = ${USER_ID} ORDER BY imported_at`;
      const map = await tickerMap();
      let schwab = { status: 'ok', accounts: [] };
      try {
        const data = await schwabGet(`${TRADER_BASE}/accounts?fields=positions`);
        schwab.accounts = (Array.isArray(data) ? data : []).map(slimAccount);
      } catch (err) {
        schwab = { status: err instanceof SchwabNotConnected ? 'not_connected' : 'error', accounts: [] };
        if (schwab.status === 'error') console.error('portfolio schwab accounts failed:', err.message);
      }
      const symbols = new Set();
      for (const a of imported) for (const h of a.holdings || []) { const s = h.symbol || map[descKey(h.description)]; if (s) symbols.add(s); }
      for (const a of schwab.accounts) for (const p of a.positions || []) if (p.symbol && TICKER_RE.test(p.symbol)) symbols.add(p.symbol);
      const { quotes, schwab: quoteStatus } = await fetchQuotes([...symbols]);
      let buyBelow = {};
      let intrinsic = {};
      try {
        const rows = await sql`
          SELECT DISTINCT ON (UPPER(ticker)) UPPER(ticker) AS ticker, safety_price, intrinsic_value
          FROM valuations WHERE user_id = ${USER_ID}
          ORDER BY UPPER(ticker), created_at DESC
        `;
        for (const r of rows) {
          if (Number.isFinite(Number(r.safety_price))) buyBelow[r.ticker] = Number(r.safety_price);
          if (Number.isFinite(Number(r.intrinsic_value))) intrinsic[r.ticker] = Number(r.intrinsic_value);
        }
      } catch (err) {
        if (!/does not exist/.test(err.message)) throw err;
      }
      return res.status(200).json({
        schwab,
        imported: imported.map((a) => ({
          key: a.key, source: a.source, label: a.custom_label || a.label, defaultLabel: a.label, last4: a.last4, linked: a.linked,
          cash: Number(a.cash) || 0, holdings: a.holdings || [], importedAt: a.imported_at,
        })),
        tickerMap: map,
        costMap: await costMap(),
        labelMap: await labelMap(),
        quotes,
        quoteStatus,
        buyBelow,
        intrinsic,
        fetchedAt: new Date().toISOString(),
      });
    }

    if (req.method === 'POST' && action === 'label') {
      const key = String(req.body?.key || '').slice(0, 80);
      const label = String(req.body?.label || '').trim().replace(/\s+/g, ' ').slice(0, 60);
      if (/^schwab:\w{0,8}$/.test(key)) {
        const map = await labelMap();
        if (label) map[key] = label; else delete map[key];
        await sql`
          INSERT INTO portfolio_settings (user_id, label_map) VALUES (${USER_ID}, ${JSON.stringify(map)}::jsonb)
          ON CONFLICT (user_id) DO UPDATE SET label_map = EXCLUDED.label_map
        `;
        return res.status(200).json({ ok: true });
      }
      await sql`UPDATE portfolio_accounts SET custom_label = ${label || null} WHERE user_id = ${USER_ID} AND key = ${key}`;
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'POST' && action === 'cash') {
      const key = String(req.body?.key || '').slice(0, 80);
      const cash = Number(req.body?.cash);
      if (!Number.isFinite(cash) || cash < 0 || cash > 1e10) return res.status(400).json({ error: 'Enter a dollar amount' });
      const r = await sql`UPDATE portfolio_accounts SET cash = ${Math.round(cash * 100) / 100} WHERE user_id = ${USER_ID} AND key = ${key} RETURNING key`;
      if (!r.length) return res.status(404).json({ error: 'Account not found' });
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'POST' && action === 'cost') {
      const key = String(req.body?.key || '').slice(0, 200);
      const total = req.body?.total === null || req.body?.total === '' ? null : Number(req.body?.total);
      const quantity = Number(req.body?.quantity);
      if (!key.includes('|')) return res.status(400).json({ error: 'Missing holding' });
      if (total !== null && (!Number.isFinite(total) || total < 0 || total > 1e10)) return res.status(400).json({ error: 'Enter a dollar amount' });
      if (total !== null && (!Number.isFinite(quantity) || quantity <= 0)) return res.status(400).json({ error: 'Missing share count' });
      const map = await costMap();
      if (total === null) delete map[key]; else map[key] = { total: Math.round(total * 100) / 100, quantity };
      await sql`
        INSERT INTO portfolio_settings (user_id, cost_map) VALUES (${USER_ID}, ${JSON.stringify(map)}::jsonb)
        ON CONFLICT (user_id) DO UPDATE SET cost_map = EXCLUDED.cost_map
      `;
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'POST' && action === 'ticker') {
      const d = descKey(req.body?.description);
      const symbol = String(req.body?.symbol || '').trim().toUpperCase();
      if (!d) return res.status(400).json({ error: 'Missing holding' });
      if (symbol && !TICKER_RE.test(symbol)) return res.status(400).json({ error: 'Enter a valid ticker' });
      const map = await tickerMap();
      if (symbol) map[d] = symbol; else delete map[d];
      await sql`
        INSERT INTO portfolio_settings (user_id, ticker_map) VALUES (${USER_ID}, ${JSON.stringify(map)}::jsonb)
        ON CONFLICT (user_id) DO UPDATE SET ticker_map = EXCLUDED.ticker_map
      `;
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'POST') {
      const csv = typeof req.body?.csv === 'string' ? req.body.csv : '';
      if (!csv) return res.status(400).json({ error: 'No file content' });
      if (csv.length > MAX_CSV) return res.status(400).json({ error: 'That file is too large for a positions export' });
      let parsed;
      try {
        parsed = parsePositionsCsv(csv);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
      // Vanguard's file has no cost basis: keep the previous snapshot's cost for a holding whose share count hasn't changed
      if (parsed.accounts.some((a) => a.source === 'vanguard')) {
        const map = await tickerMap();
        const prev = await sql`SELECT key, holdings FROM portfolio_accounts WHERE user_id = ${USER_ID}`;
        for (const a of parsed.accounts) {
          if (a.source !== 'vanguard') continue;
          const old = prev.find((p) => p.key === a.key)?.holdings || [];
          for (const h of a.holdings) {
            if (h.costBasis !== null) continue;
            const match = old.find((o) => (o.symbol || map[descKey(o.description)]) === h.symbol && Math.abs(o.quantity - h.quantity) < 0.001);
            if (match && Number.isFinite(match.costBasis)) h.costBasis = match.costBasis;
          }
        }
      }
      for (const a of parsed.accounts) {
        await sql`
          INSERT INTO portfolio_accounts (user_id, key, source, label, last4, linked, cash, holdings, imported_at)
          VALUES (${USER_ID}, ${a.key}, ${a.source}, ${a.label}, ${a.last4}, ${a.linked}, ${a.cash}, ${JSON.stringify(a.holdings)}::jsonb, NOW())
          ON CONFLICT (user_id, key) DO UPDATE SET
            source = EXCLUDED.source,
            label = CASE WHEN EXCLUDED.source = 'vanguard' THEN portfolio_accounts.label ELSE EXCLUDED.label END, last4 = EXCLUDED.last4, linked = EXCLUDED.linked,
            cash = EXCLUDED.cash, holdings = EXCLUDED.holdings, imported_at = NOW()
          WHERE NOT (portfolio_accounts.source = 'vanguard' AND EXCLUDED.source = 'linked') -- Vanguard's own file is fresher than Fidelity's linked copy
        `;
      }
      return res.status(200).json({ ok: true, accounts: parsed.accounts.map((a) => ({ key: a.key, label: a.label, holdings: a.holdings.length })), skipped: parsed.skipped });
    }

    if (req.method === 'DELETE') {
      const key = String(req.query?.key || '').slice(0, 80);
      await sql`DELETE FROM portfolio_accounts WHERE user_id = ${USER_ID} AND key = ${key}`;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('portfolio failed:', err);
    return res.status(502).json({ error: 'Portfolio request failed' });
  }
}
