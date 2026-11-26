import { markChartKeyChanged } from './chart-sync.js';
// Data, settings and storage for the Charts component. Daily bars for any ticker come from /api/prices (Schwab when
// connected, otherwise FMP's free tier; cached in Neon); the committed files in public/sample/ (real data from
// scripts/fetch-sample-prices.js) are the last fallback. Weekly and monthly bars are aggregated from the daily ones.
// Intraday bars (1m/5m/15m/30m) come from Schwab; 1h and 4h are built from 30m bars. Live updates: schwab-stream.js.

export const SAMPLE_TICKERS = ['AAPL', 'MSFT', 'V'];
export const NO_DATA_MESSAGE = "Price data for this ticker isn't available on the free data source. Connect Schwab (button in the nav) to load it.";
export const NOT_FOUND_MESSAGE = 'No price data found for this ticker.';
export const NEEDS_SCHWAB_MESSAGE = 'Intraday charts need Schwab connected. Use the Schwab button in the nav to connect.';
export const NO_INTRADAY_MESSAGE = 'Schwab has no intraday data for this ticker.';
export const LOAD_FAILED_MESSAGE = 'Price data could not be loaded. Try again in a moment.';
export const MAX_COMPARE = 3;
const DAY = 86400000;
const LS_PREFIX = 'vl.charts.v1.';
const LS_GLOBAL = 'vl.charts.global';
const LS_LAYOUT = 'vl.charts.layout';

// ---------- Design tokens (read from CSS so the chart follows the app theme) ----------

export function tokens() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  return {
    bg: v('--bg', '#080c12'), surface: v('--surface', '#0d1219'), card: v('--card', '#111720'), border: v('--border', '#1c2535'), borderHi: v('--border-hi', '#253045'),
    blue: v('--blue', '#3b9eff'), green: v('--green', '#00e5a0'), red: v('--red', '#ff4d6a'), yellow: v('--yellow', '#ffc940'),
    text: v('--text', '#e8edf5'), text2: v('--text-2', '#8a96a8'), text3: v('--text-3', '#4a5568'),
    compare: [v('--compare-1', '#ff9f43'), v('--compare-2', '#b48cff'), v('--compare-3', '#5ad1e6')],
    mono: "'JetBrains Mono', monospace", sans: "'Inter', sans-serif",
  };
}

// ---------- Timeframes ----------

export const PERIODS = {
  '1m': { type: 'minute', span: 1 }, '5m': { type: 'minute', span: 5 }, '15m': { type: 'minute', span: 15 }, '30m': { type: 'minute', span: 30 },
  '1h': { type: 'hour', span: 1 }, '4h': { type: 'hour', span: 4 },
  D: { type: 'day', span: 1 }, W: { type: 'week', span: 1 }, M: { type: 'month', span: 1 },
};
export const tfOfPeriod = (p) => Object.keys(PERIODS).find((k) => PERIODS[k].type === p?.type && PERIODS[k].span === p?.span) || 'D';
// Intraday: `base` is the Schwab minute frequency fetched, `size` the bar length in minutes (1h/4h are built from 30m bars)
export const INTRADAY = { '1m': { base: 1, size: 1 }, '5m': { base: 5, size: 5 }, '15m': { base: 15, size: 15 }, '30m': { base: 30, size: 30 }, '1h': { base: 30, size: 60 }, '4h': { base: 30, size: 240 } };
export const isIntraday = (tf) => Object.prototype.hasOwnProperty.call(INTRADAY, tf);
export const TF_GROUPS = [
  { label: 'Minutes', items: [{ id: '1m', label: '1m' }, { id: '5m', label: '5m' }, { id: '15m', label: '15m' }, { id: '30m', label: '30m' }] },
  { label: 'Hours', items: [{ id: '1h', label: '1h' }, { id: '4h', label: '4h' }] },
  { label: 'Days', items: [{ id: 'D', label: 'D', title: 'Daily' }, { id: 'W', label: 'W', title: 'Weekly' }, { id: 'M', label: 'M', title: 'Monthly' }] },
];
export const TF_ENABLED = new Set(Object.keys(PERIODS));

// ---------- Sample data and aggregation ----------

const dailyCache = new Map();
const failure = (kind) => Object.assign(new Error(kind), { kind });
const mapBars = (j, source) => {
  if (!Array.isArray(j?.bars) || !j.bars.length) throw failure('unavailable');
  const bars = j.bars.map((b) => ({ timestamp: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }));
  bars.source = source || j.source || null; // 'schwab' | 'fmp' | 'sample'
  return bars;
};

// kind 'unavailable': the free data source refuses the symbol. kind 'network': anything else went wrong.
async function fetchFromApi(ticker) {
  let res;
  try { res = await fetch(`/api/prices?ticker=${encodeURIComponent(ticker)}`); } catch (err) { throw failure('network'); }
  if (res.ok) {
    try { return mapBars(await res.json()); } catch (err) { throw failure(err.kind || 'network'); }
  }
  if (res.status === 404) {
    // When Schwab answered and still had nothing, the ticker most likely doesn't exist
    let body = null;
    try { body = await res.json(); } catch (err) { /* ignore */ }
    throw failure(body?.schwab === 'ok' ? 'notfound' : 'unavailable');
  }
  throw failure(res.status === 400 ? 'notfound' : 'network');
}

// A missing file can come back as the app's index.html (SPA rewrite), so any parse failure also means "no sample"
async function fetchSample(ticker) {
  const r = await fetch(`/sample/${encodeURIComponent(ticker)}.json`);
  if (!r.ok) throw failure('unavailable');
  try { return mapBars(await r.json(), 'sample'); } catch (err) { throw failure('unavailable'); }
}

export function loadDaily(ticker) {
  if (!dailyCache.has(ticker)) {
    dailyCache.set(ticker, fetchFromApi(ticker).catch(async (apiErr) => {
      // Fallback: the committed sample file, when this ticker has one
      try { return await fetchSample(ticker); } catch (sampleErr) { throw apiErr; }
    }).catch((err) => { dailyCache.delete(ticker); throw err; }));
  }
  return dailyCache.get(ticker);
}

// ---------- Intraday (Schwab) ----------

// Minutes since 9:30 in New York (negative before the open), so bars line up with the trading session like TradingView/thinkorswim
const nyParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function nyClock(ts) {
  const p = Object.fromEntries(nyParts.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), mins: Number(p.hour) * 60 + Number(p.minute) };
}
export const SESSION_OPEN = 570; // 9:30
export const SESSION_CLOSE = 960; // 16:00
export function inRegularSession(ts) {
  const { mins } = nyClock(ts);
  return mins >= SESSION_OPEN && mins < SESSION_CLOSE;
}
// Start of the `size`-minute bar containing ts, anchored to the 9:30 open
export function bucketStart(ts, size) {
  const minuteStart = Math.floor(ts / 60000) * 60000;
  const since = nyClock(ts).mins - SESSION_OPEN;
  const off = ((since % size) + size) % size;
  return minuteStart - off * 60000;
}
// Daily bars use UTC midnight of the New York trading date
export function tradingDayKey(ts) {
  const { y, m, d } = nyClock(ts);
  return Date.UTC(y, m - 1, d);
}
// The bar a daily-type timeframe (D/W/M) puts this trading day in
export function periodKey(dayKey, tf) {
  if (tf === 'D') return dayKey;
  const d = new Date(dayKey);
  if (tf === 'W') return dayKey - ((d.getUTCDay() + 6) % 7) * DAY;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

const intradayCache = new Map(); // key -> { at, promise }
const INTRADAY_TTL = 60000;

async function fetchIntraday(ticker, base, ext) {
  let res;
  try { res = await fetch(`/api/prices?ticker=${encodeURIComponent(ticker)}&freq=${base}&ext=${ext ? 1 : 0}`); } catch (err) { throw failure('network'); }
  if (res.status === 409) throw failure('needs_schwab');
  if (res.status === 404) throw failure('no_intraday');
  if (res.status === 400) throw failure('notfound');
  if (!res.ok) throw failure('network');
  try { return mapBars(await res.json(), 'schwab'); } catch (err) { throw failure(err.kind === 'unavailable' ? 'no_intraday' : 'network'); }
}

function aggregateMinutes(bars, size) {
  const out = [];
  for (const b of bars) {
    const k = bucketStart(b.timestamp, size);
    const last = out[out.length - 1];
    if (!last || last.timestamp !== k) { out.push({ ...b, timestamp: k }); continue; }
    last.high = Math.max(last.high, b.high);
    last.low = Math.min(last.low, b.low);
    last.close = b.close;
    last.volume += b.volume;
  }
  out.source = bars.source;
  return out;
}

export async function loadIntraday(ticker, tf, ext) {
  const { base, size } = INTRADAY[tf];
  const key = `${ticker}|${base}|${ext ? 1 : 0}`;
  const hit = intradayCache.get(key);
  if (!hit || Date.now() - hit.at > INTRADAY_TTL) {
    const promise = fetchIntraday(ticker, base, ext).catch((err) => { intradayCache.delete(key); throw err; });
    intradayCache.set(key, { at: Date.now(), promise });
  }
  const bars = await intradayCache.get(key).promise;
  return size === base ? bars : aggregateMinutes(bars, size);
}

// Bars for any timeframe. The returned array carries `.source` ('schwab' | 'fmp' | 'sample').
export async function loadBars(ticker, tf, { ext = false } = {}) {
  if (isIntraday(tf)) return loadIntraday(ticker, tf, ext);
  const daily = await loadDaily(ticker);
  const bars = aggregate(daily, tf);
  bars.source = daily.source;
  return bars;
}

// The message for a failed load
export function failureMessage(err) {
  switch (err?.kind) {
    case 'network': return LOAD_FAILED_MESSAGE;
    case 'needs_schwab': return NEEDS_SCHWAB_MESSAGE;
    case 'no_intraday': return NO_INTRADAY_MESSAGE;
    case 'notfound': return NOT_FOUND_MESSAGE;
    default: return NO_DATA_MESSAGE;
  }
}

// Weekly (Monday-based) and monthly bars from daily ones. A bar's timestamp is its first trading day.
export function aggregate(daily, tf) {
  if (tf === 'D') return daily;
  const keyOf = (t) => {
    const d = new Date(t);
    if (tf === 'W') return t - ((d.getUTCDay() + 6) % 7) * DAY;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  };
  const out = [];
  let curKey = null;
  for (const b of daily) {
    const k = keyOf(b.timestamp);
    if (k !== curKey) { out.push({ ...b }); curKey = k; continue; }
    const last = out[out.length - 1];
    last.high = Math.max(last.high, b.high);
    last.low = Math.min(last.low, b.low);
    last.close = b.close;
    last.volume += b.volume;
  }
  return out;
}

// ---------- Settings (localStorage, every access wrapped in try/catch) ----------
// Every save below is also mirrored to Neon (chart-sync.js), so drawings and settings follow you between devices.

export const IND_KEYS = ['ema50', 'ema200', 'sma50', 'sma200'];
const IND_DEFAULTS = (c) => ({
  ema50: { on: true, color: c.blue, type: 'ema', period: 50, label: 'EMA 50' },
  ema200: { on: true, color: c.yellow, type: 'ema', period: 200, label: 'EMA 200' },
  sma50: { on: false, color: c.text, type: 'sma', period: 50, label: 'SMA 50' },
  sma200: { on: false, color: c.text2, type: 'sma', period: 200, label: 'SMA 200' },
});

const HEX = /^#[0-9a-f]{6}$/i;

export function defaultSettings(c) {
  return { tf: 'D', ind: IND_DEFAULTS(c), vol: { on: true, mode: 'direction', color: c.blue, opacity: 0.35, height: 90 }, compare: [], drawings: [] };
}

function pickVol(v) {
  const o = {};
  if (typeof v.on === 'boolean') o.on = v.on;
  if (v.mode === 'single' || v.mode === 'direction') o.mode = v.mode;
  if (typeof v.color === 'string' && HEX.test(v.color)) o.color = v.color;
  if (Number.isFinite(v.opacity)) o.opacity = Math.min(1, Math.max(0.05, v.opacity));
  if (Number.isFinite(v.height)) o.height = Math.min(300, Math.max(40, v.height));
  return o;
}

// Shared per ticker, by every chart showing it: drawings and indicator settings (key LS_PREFIX + ticker).
// Independent per location ('page-0', 'page-1', 'card'): timeframe, volume options and compare tickers (key vl.charts.loc.*).
// Older saves kept everything under the per-ticker key, so those values are the defaults for a location with no save yet.
const localKey = (loc, ticker) => `vl.charts.loc.${loc}.${ticker}`;
const readJson = (key) => { try { return JSON.parse(localStorage.getItem(key) || 'null') || {}; } catch (err) { return {}; } };

export function loadSettings(ticker, c, validTools, loc = 'page-0') {
  const d = defaultSettings(c);
  const shared = readJson(LS_PREFIX + ticker);
  const local = readJson(localKey(loc, ticker));
  const out = { ...d };
  const tf = local.tf ?? shared.tf;
  if (TF_ENABLED.has(tf)) out.tf = tf;
  for (const k of IND_KEYS) if (shared.ind?.[k]) out.ind[k] = { ...d.ind[k], on: !!shared.ind[k].on, color: HEX.test(shared.ind[k].color) ? shared.ind[k].color : d.ind[k].color };
  const vol = local.vol ?? shared.vol;
  if (vol && typeof vol === 'object') out.vol = { ...d.vol, ...pickVol(vol) };
  const compare = local.compare ?? shared.compare;
  if (Array.isArray(compare)) out.compare = compare.filter((t) => typeof t === 'string' && /^[A-Z][A-Z0-9.\-]{0,9}$/.test(t) && t !== ticker).slice(0, MAX_COMPARE);
  if (Array.isArray(shared.drawings)) out.drawings = shared.drawings.filter((x) => x && validTools.includes(x.name) && Array.isArray(x.points) && x.points.every((p) => Number.isFinite(p.timestamp) && Number.isFinite(p.value)));
  return out;
}

export function saveSettings(ticker, s, loc = 'page-0') {
  try {
    localStorage.setItem(LS_PREFIX + ticker, JSON.stringify({ ind: s.ind, drawings: s.drawings }));
    localStorage.setItem(localKey(loc, ticker), JSON.stringify({ tf: s.tf, vol: s.vol, compare: s.compare }));
  } catch (err) { /* storage unavailable: nothing persists */ }
  markChartKeyChanged(LS_PREFIX + ticker);
  markChartKeyChanged(localKey(loc, ticker));
}
export const settingsKey = (ticker) => LS_PREFIX + ticker;

// Preferences shared by every chart: favorite timeframes, candle colors, last-used tool per group, keep-drawing lock
export function loadGlobal(c) {
  const d = { favTfs: ['D', 'W', 'M'], candle: { up: c.green, down: c.red }, lastTool: {}, keepDrawing: false, ext: false, valLines: true, events: true };
  try {
    const g = JSON.parse(localStorage.getItem(LS_GLOBAL) || 'null');
    if (!g) return d;
    if (Array.isArray(g.favTfs)) d.favTfs = g.favTfs.filter((t) => TF_GROUPS.some((grp) => grp.items.some((i) => i.id === t)));
    if (g.candle && HEX.test(g.candle.up)) d.candle.up = g.candle.up;
    if (g.candle && HEX.test(g.candle.down)) d.candle.down = g.candle.down;
    if (g.lastTool && typeof g.lastTool === 'object') for (const [k, v] of Object.entries(g.lastTool)) if (typeof v === 'string') d.lastTool[k] = v;
    d.keepDrawing = g.keepDrawing === true;
    d.ext = g.ext === true;
    d.valLines = g.valLines !== false;
    d.events = g.events !== false;
  } catch (err) { /* defaults */ }
  return d;
}
export function saveGlobal(g) {
  try { localStorage.setItem(LS_GLOBAL, JSON.stringify(g)); } catch (err) { /* ignore */ }
  markChartKeyChanged(LS_GLOBAL);
}

export function loadLayout() {
  try {
    const l = JSON.parse(localStorage.getItem(LS_LAYOUT) || 'null');
    if (l && (l.count === 1 || l.count === 2) && Array.isArray(l.tickers)) return { count: l.count, tickers: l.tickers.map((t, i) => (typeof t === 'string' && /^[A-Z][A-Z0-9.\-]{0,9}$/.test(t) ? t : SAMPLE_TICKERS[i % 3])) };
  } catch (err) { /* ignore */ }
  return { count: 1, tickers: ['AAPL', 'MSFT'] };
}
export function saveLayout(l) {
  try { localStorage.setItem(LS_LAYOUT, JSON.stringify(l)); } catch (err) { /* ignore */ }
  markChartKeyChanged(LS_LAYOUT);
}

