const FMP_BASE_URL = 'https://financialmodelingprep.com/stable';

export async function fmpFetch(path) {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) {
    throw new Error('FMP_API_KEY is not configured');
  }

  const separator = path.includes('?') ? '&' : '?';
  const url = `${FMP_BASE_URL}${path}${separator}apikey=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`FMP request failed with status ${res.status}`);
  }
  return res.json();
}

const SYMBOL_RE = /^[A-Za-z.-]{1,10}$/;

// Last ~12 months of daily closes from FMP's current (stable) free endpoint, oldest first.
// Returns { available: true, closes: [{ date, close }] } or { available: false, reason }.
// A 402/403 means the symbol is outside the free plan, which is an expected, non-fatal outcome.
export async function fetchPriceHistory(symbol, days = 365) {
  if (!SYMBOL_RE.test(symbol || '')) return { available: false, reason: 'invalid_symbol' };
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) throw new Error('FMP_API_KEY is not configured');

  const to = new Date();
  const from = new Date(to.getTime() - days * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  const url = `${FMP_BASE_URL}/historical-price-eod/light?symbol=${encodeURIComponent(symbol)}`
    + `&from=${iso(from)}&to=${iso(to)}&apikey=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (res.status === 402 || res.status === 403) return { available: false, reason: 'not_in_plan' };
  if (!res.ok) throw new Error(`FMP price request failed with status ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) return { available: false, reason: 'no_data' };

  const closes = rows
    .filter((r) => typeof r.date === 'string' && Number.isFinite(r.price))
    .map((r) => ({ date: r.date, close: r.price }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  return closes.length >= 2 ? { available: true, closes } : { available: false, reason: 'no_data' };
}

const round2 = (n) => Math.round(n * 100) / 100;

// Computed here, never by the model: start/end, range, and the biggest close-to-close moves.
export function summarizePrices(closes, topMoves = 5) {
  const first = closes[0];
  const last = closes[closes.length - 1];
  let high = first;
  let low = first;
  const moves = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i].close > high.close) high = closes[i];
    if (closes[i].close < low.close) low = closes[i];
    moves.push({
      date: closes[i].date,
      previousClose: closes[i - 1].close,
      close: closes[i].close,
      changePct: round2(((closes[i].close - closes[i - 1].close) / closes[i - 1].close) * 100),
    });
  }
  moves.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
  return {
    start: { date: first.date, close: first.close },
    end: { date: last.date, close: last.close },
    changePct: round2(((last.close - first.close) / first.close) * 100),
    high: { date: high.date, close: high.close },
    low: { date: low.date, close: low.close },
    tradingDays: closes.length,
    largestDailyMoves: moves.slice(0, topMoves),
  };
}
