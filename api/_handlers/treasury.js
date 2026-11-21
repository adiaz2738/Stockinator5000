import sql from '../_db.js';
import { requireAuth } from '../_auth.js';

// GET /api/treasury -> { rate: 4.31, asOf: '2026-11-19', source } : the 10-year Treasury par yield (percent), from the
// U.S. Treasury's free daily yield-curve CSV. Stored once a day for the app (public data, not per user).
const CSV = (year) => `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&page&_format=csv`;
const MAX_AGE_MS = 12 * 3600 * 1000;

async function ensureTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS treasury_rate (
      id         INTEGER PRIMARY KEY,
      rate       NUMERIC NOT NULL,
      as_of      DATE NOT NULL,
      fetched_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
}

// Newest row first; the "10 Yr" column is found by its header, not a fixed position
async function latestTenYear() {
  const thisYear = new Date().getUTCFullYear();
  for (const year of [thisYear, thisYear - 1]) {
    const res = await fetch(CSV(year), { headers: { Accept: 'text/csv' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) continue;
    const lines = (await res.text()).trim().split(/\r?\n/);
    if (lines.length < 2) continue;
    const header = lines[0].split(',').map((h) => h.replace(/"/g, '').trim());
    const col = header.indexOf('10 Yr');
    if (col < 0) continue;
    for (const line of lines.slice(1)) {
      const cells = line.split(',');
      const rate = Number(cells[col]);
      const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(cells[0]?.trim() || '');
      if (m && Number.isFinite(rate) && rate > 0 && rate < 30) return { rate, asOf: `${m[3]}-${m[1]}-${m[2]}` };
    }
  }
  return null;
}

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    await ensureTable();
    const rows = await sql`SELECT rate, as_of, fetched_at FROM treasury_rate WHERE id = 1`;
    const cached = rows[0];
    if (cached && Date.now() - new Date(cached.fetched_at).getTime() < MAX_AGE_MS) {
      return res.status(200).json({ rate: Number(cached.rate), asOf: new Date(cached.as_of).toISOString().slice(0, 10), source: 'U.S. Treasury', cached: true });
    }
    let latest = null;
    try {
      latest = await latestTenYear();
    } catch (err) {
      console.error('treasury fetch failed:', err.message);
    }
    if (!latest) {
      // a failed refresh serves the last stored rate rather than nothing
      if (cached) return res.status(200).json({ rate: Number(cached.rate), asOf: new Date(cached.as_of).toISOString().slice(0, 10), source: 'U.S. Treasury', stale: true });
      return res.status(502).json({ error: 'Treasury rate unavailable' });
    }
    await sql`
      INSERT INTO treasury_rate (id, rate, as_of, fetched_at) VALUES (1, ${latest.rate}, ${latest.asOf}, NOW())
      ON CONFLICT (id) DO UPDATE SET rate = EXCLUDED.rate, as_of = EXCLUDED.as_of, fetched_at = NOW()
    `;
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.status(200).json({ rate: latest.rate, asOf: latest.asOf, source: 'U.S. Treasury' });
  } catch (err) {
    console.error('treasury handler failed:', err);
    return res.status(502).json({ error: 'Treasury rate unavailable' });
  }
}
