// One-time script: downloads ~2 years of REAL daily OHLCV for the Charts prototype and saves public/sample/{TICKER}.json.
// Run:  node --env-file=.env.local scripts/fetch-sample-prices.js
// Source order: Financial Modeling Prep (needs FMP_API_KEY, only accepted if rows carry open/high/low/close/volume),
// then Stooq's free CSV download. Prices are never generated or filled in: if neither source works the script stops.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TICKERS = ['AAPL', 'MSFT', 'V'];
const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sample');
const iso = (d) => d.toISOString().slice(0, 10);
const to = new Date();
const from = new Date(to.getTime() - 2 * 365 * 86400000);

const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);

// Validates and normalises rows to { t (UTC midnight, ms), o, h, l, c, v }, oldest first. Returns null if any row is unusable.
function normalise(rows) {
  const bars = [];
  for (const r of rows) {
    const t = Date.parse(`${r.date}T00:00:00Z`);
    const bar = { t, o: num(r.open), h: num(r.high), l: num(r.low), c: num(r.close), v: num(r.volume) };
    if (!Number.isFinite(t) || [bar.o, bar.h, bar.l, bar.c, bar.v].some((x) => !Number.isFinite(x))) return null;
    if (bar.h < Math.max(bar.o, bar.c) - 1e-9 || bar.l > Math.min(bar.o, bar.c) + 1e-9) return null; // not a real OHLC bar
    bars.push(bar);
  }
  bars.sort((a, b) => a.t - b.t);
  return bars.length > 200 ? bars : null;
}

async function fromFmp(ticker) {
  const key = process.env.FMP_API_KEY;
  if (!key) throw new Error('FMP_API_KEY not set');
  const url = `https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=${ticker}&from=${iso(from)}&to=${iso(to)}&apikey=${encodeURIComponent(key)}`;
  const res = await fetch(url);
  const body = await res.text();
  if (!res.ok) throw new Error(`FMP HTTP ${res.status}: ${body.slice(0, 120).replace(key, '***')}`);
  const json = JSON.parse(body);
  const rows = Array.isArray(json) ? json : json?.historical;
  if (!Array.isArray(rows)) throw new Error(`FMP unexpected response: ${body.slice(0, 120).replace(key, '***')}`);
  const bars = normalise(rows);
  if (!bars) throw new Error('FMP rows missing open/high/low/close/volume (or too few rows)');
  return bars;
}

async function fromStooq(ticker) {
  const url = `https://stooq.com/q/d/l/?s=${ticker.toLowerCase()}.us&i=d&d1=${iso(from).replace(/-/g, '')}&d2=${iso(to).replace(/-/g, '')}`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok || !/^Date,Open,High,Low,Close,Volume/i.test(text)) throw new Error(`Stooq unusable response: ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
  const rows = text.trim().split(/\r?\n/).slice(1).map((line) => {
    const [date, open, high, low, close, volume] = line.split(',');
    return { date, open, high, low, close, volume };
  });
  const bars = normalise(rows);
  if (!bars) throw new Error('Stooq rows incomplete');
  return bars;
}

const failures = [];
for (const ticker of TICKERS) {
  let bars = null;
  let source = null;
  for (const [name, fn] of [['FMP', fromFmp], ['Stooq', fromStooq]]) {
    try {
      bars = await fn(ticker);
      source = name;
      break;
    } catch (err) {
      console.error(`${ticker}: ${name} failed - ${err.message}`);
    }
  }
  if (!bars) { failures.push(ticker); continue; }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `${ticker}.json`), JSON.stringify({ ticker, source, interval: '1d', adjusted: source === 'Stooq', fetchedAt: new Date().toISOString(), bars }));
  console.log(`${ticker}: ${bars.length} daily bars from ${source}, ${iso(new Date(bars[0].t))} to ${iso(new Date(bars[bars.length - 1].t))}`);
}
if (failures.length) {
  console.error(`\nNo usable source for: ${failures.join(', ')}. Nothing was fabricated; stopping.`);
  process.exit(1);
}
