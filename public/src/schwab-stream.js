// Live quotes from Schwab. First choice: the streaming API (WebSocket, LEVELONE_EQUITIES), one shared connection per
// page. If the browser's WebSocket is refused (Schwab may only accept the stream from servers, or an ad blocker may
// block it), it falls back to polling /api/schwab/quotes every few seconds. Every chart/watchlist subscribes to the
// symbols it shows; listeners don't need to know which mode is running. Read-only market data.
//
//   const off = subscribeQuotes('AAPL', (q) => { q.last, q.totalVolume, q.dayHigh, q.dayLow, q.prevClose, q.tradeTime })
//   off()
//   onStreamStatus((status) => ...)   // 'off' | 'connecting' | 'live' (WebSocket) | 'polling' | 'unavailable' | 'error'

// LEVELONE_EQUITIES field numbers: 0 symbol, 3 last price, 8 total volume, 10 day high, 11 day low, 12 previous close,
// 35 trade time (ms)
const FIELDS = '0,3,8,10,11,12,35';
const MAP = { 3: 'last', 8: 'totalVolume', 10: 'dayHigh', 11: 'dayLow', 12: 'prevClose', 35: 'tradeTime' };
const IDLE_CLOSE_MS = 30000;
export const POLL_MS = 5000; // polling interval while the market (incl. extended hours) is open and the tab is visible
const POLL_IDLE_MS = 5 * 60000; // otherwise
const WS_FAILURES_BEFORE_POLLING = 2;

const listeners = new Map(); // symbol -> Set(fn)
const latest = new Map(); // symbol -> merged quote (Schwab only sends fields that changed)
const statusListeners = new Set();
let ws = null;
let creds = null;
let status = 'off';
let loggedIn = false;
let requestId = 0;
let retryMs = 5000;
let retryTimer = 0;
let idleTimer = 0;
// Remember for a day that the WebSocket was refused, so later page loads go straight to polling (no slow retries)
const MODE_KEY = 'vl.stream.pollUntil';
const POLL_MEMORY_MS = 24 * 3600 * 1000;
function rememberedPoll() {
  try { return Number(localStorage.getItem(MODE_KEY) || 0) > Date.now(); } catch (err) { return false; }
}
let mode = rememberedPoll() ? 'poll' : 'ws'; // 'ws' | 'poll'
let wsFailures = 0;
let pollTimer = 0;
let polling = false;

function setStatus(s) {
  if (s === status) return;
  status = s;
  for (const fn of statusListeners) { try { fn(s); } catch (err) { console.error(err); } }
}
export const streamStatus = () => status;
export function onStreamStatus(fn) {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

function send(service, command, parameters) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !creds) return;
  ws.send(JSON.stringify({ requests: [{ requestid: String(++requestId), service, command, SchwabClientCustomerId: creds.customerId, SchwabClientCorrelId: creds.correlId, parameters }] }));
}

function syncSubscriptions() {
  if (!loggedIn) return;
  const keys = [...listeners.keys()];
  if (keys.length) send('LEVELONE_EQUITIES', 'SUBS', { keys: keys.join(','), fields: FIELDS });
  else send('LEVELONE_EQUITIES', 'UNSUBS', { keys: '' });
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  if (!listeners.size) { setStatus('off'); return; }
  retryTimer = setTimeout(connect, retryMs);
  retryMs = Math.min(retryMs * 2, 60000);
}

async function connect() {
  clearTimeout(retryTimer);
  if (mode === 'poll') { startPolling(); return; }
  if (ws || !listeners.size) return;
  setStatus('connecting');
  try {
    const res = await fetch('/api/schwab/stream');
    if (res.status === 409) { setStatus('unavailable'); creds = null; retryTimer = setTimeout(connect, 5 * 60000); return; }
    if (!res.ok) throw new Error(`stream credentials ${res.status}`);
    creds = await res.json();
  } catch (err) {
    console.error('Schwab stream:', err);
    setStatus('error');
    scheduleRetry();
    return;
  }
  if (!listeners.size) { setStatus('off'); return; }

  const socket = new WebSocket(creds.url);
  ws = socket;
  loggedIn = false;
  socket.addEventListener('open', () => {
    send('ADMIN', 'LOGIN', { Authorization: creds.accessToken, SchwabClientChannel: creds.channel, SchwabClientFunctionId: creds.functionId });
  });
  socket.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (err) { return; }
    for (const r of msg.response || []) {
      if (r.service === 'ADMIN' && r.command === 'LOGIN') {
        if (r.content?.code === 0) {
          loggedIn = true;
          wsFailures = 0;
          retryMs = 5000;
          setStatus('live');
          syncSubscriptions();
        } else {
          console.error('Schwab stream login failed:', r.content?.code, r.content?.msg);
          setStatus('error');
          socket.close();
        }
      }
    }
    for (const d of msg.data || []) {
      if (d.service !== 'LEVELONE_EQUITIES' || !Array.isArray(d.content)) continue;
      for (const item of d.content) {
        const sym = item.key;
        if (!listeners.has(sym)) continue;
        const q = { ...(latest.get(sym) || { symbol: sym }) };
        for (const [field, name] of Object.entries(MAP)) {
          const v = item[field];
          if (typeof v === 'number' && Number.isFinite(v)) q[name] = v;
        }
        latest.set(sym, q);
        for (const fn of listeners.get(sym) || []) { try { fn(q); } catch (err) { console.error(err); } }
      }
    }
  });
  socket.addEventListener('close', () => {
    const wasLoggedIn = loggedIn;
    if (ws === socket) { ws = null; loggedIn = false; }
    if (!wasLoggedIn) wsFailures++;
    if (!listeners.size) { setStatus('off'); return; }
    if (wsFailures >= WS_FAILURES_BEFORE_POLLING) {
      console.info('Schwab stream: WebSocket refused; using quote polling instead');
      mode = 'poll';
      try { localStorage.setItem(MODE_KEY, String(Date.now() + POLL_MEMORY_MS)); } catch (err) { /* ignore */ }
      startPolling();
      return;
    }
    setStatus('connecting');
    retryMs = 1000;
    scheduleRetry();
  });
  socket.addEventListener('error', () => { /* 'close' follows and handles the retry */ });
}

// ---------- Polling fallback ----------

const nyClock = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function marketOpenNow() {
  const p = Object.fromEntries(nyClock.formatToParts(new Date()).map((x) => [x.type, x.value]));
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return false;
  const mins = Number(p.hour) * 60 + Number(p.minute);
  return mins >= 4 * 60 && mins < 20 * 60; // 4:00 to 20:00 ET (pre-market through after-hours)
}

function emit(sym, fields) {
  if (!listeners.has(sym)) return;
  const q = { ...(latest.get(sym) || { symbol: sym }) };
  for (const [k, v] of Object.entries(fields)) if (typeof v === 'number' && Number.isFinite(v)) q[k] = v;
  latest.set(sym, q);
  for (const fn of listeners.get(sym) || []) { try { fn(q); } catch (err) { console.error(err); } }
}

async function pollOnce() {
  const syms = [...listeners.keys()];
  if (!syms.length) return 'idle';
  const res = await fetch(`/api/schwab/quotes?symbols=${encodeURIComponent(syms.join(','))}`);
  if (res.status === 409) return 'unavailable';
  if (!res.ok) throw new Error(`quotes ${res.status}`);
  const body = await res.json();
  for (const [sym, q] of Object.entries(body.quotes || {})) emit(sym, q);
  return 'ok';
}

function startPolling() {
  if (polling) return;
  polling = true;
  clearTimeout(pollTimer);
  const tick = async () => {
    if (!polling) return;
    if (!listeners.size) { polling = false; setStatus('off'); return; }
    let next = marketOpenNow() && document.visibilityState === 'visible' ? POLL_MS : POLL_IDLE_MS;
    try {
      const r = await pollOnce();
      if (r === 'unavailable') { setStatus('unavailable'); next = POLL_IDLE_MS; } else setStatus('polling');
    } catch (err) {
      console.error('Schwab quotes:', err);
      setStatus('error');
      next = 15000;
    }
    if (polling) pollTimer = setTimeout(tick, next);
  };
  tick();
}
function stopPolling() {
  polling = false;
  clearTimeout(pollTimer);
}
// Back to fast polling as soon as the tab is visible again
document.addEventListener('visibilitychange', () => {
  if (mode === 'poll' && polling && document.visibilityState === 'visible') { stopPolling(); startPolling(); }
});

export function subscribeQuotes(symbol, fn) {
  const sym = String(symbol || '').toUpperCase();
  if (!sym) return () => {};
  clearTimeout(idleTimer);
  const isNew = !listeners.has(sym);
  if (isNew) listeners.set(sym, new Set());
  listeners.get(sym).add(fn);
  if (mode === 'poll') {
    // Fetch right away so a newly shown ticker doesn't wait for the next poll
    if (!polling) startPolling(); else if (isNew) pollOnce().catch(() => {});
  } else if (!ws) connect();
  else if (isNew) syncSubscriptions();
  return () => {
    const set = listeners.get(sym);
    if (!set) return;
    set.delete(fn);
    if (set.size) return;
    listeners.delete(sym);
    latest.delete(sym);
    syncSubscriptions();
    if (!listeners.size) {
      // Close the socket when nothing has been watched for a while (switching charts reuses it)
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (listeners.size) return;
        if (ws) { ws.close(); ws = null; }
        stopPolling();
        setStatus('off');
      }, IDLE_CLOSE_MS);
    }
  };
}
