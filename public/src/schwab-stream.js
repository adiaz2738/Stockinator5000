// Live quotes from Schwab's streaming API (WebSocket, LEVELONE_EQUITIES). One shared connection per page; every chart
// subscribes to the symbols it shows. Read-only market data. The access token comes from /api/schwab/stream and is
// only used to log in to the socket; on any disconnect a fresh token is fetched before reconnecting.
//
//   const off = subscribeQuotes('AAPL', (q) => { q.last, q.totalVolume, q.dayHigh, q.dayLow, q.prevClose, q.tradeTime })
//   off()
//   onStreamStatus((status) => ...)   // 'off' | 'connecting' | 'live' | 'unavailable' | 'error'

// LEVELONE_EQUITIES field numbers: 0 symbol, 3 last price, 8 total volume, 10 day high, 11 day low, 12 previous close,
// 35 trade time (ms)
const FIELDS = '0,3,8,10,11,12,35';
const MAP = { 3: 'last', 8: 'totalVolume', 10: 'dayHigh', 11: 'dayLow', 12: 'prevClose', 35: 'tradeTime' };
const IDLE_CLOSE_MS = 30000;

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
    if (ws === socket) { ws = null; loggedIn = false; }
    if (listeners.size) { setStatus('connecting'); scheduleRetry(); } else setStatus('off');
  });
  socket.addEventListener('error', () => { /* 'close' follows and handles the retry */ });
}

export function subscribeQuotes(symbol, fn) {
  const sym = String(symbol || '').toUpperCase();
  if (!sym) return () => {};
  clearTimeout(idleTimer);
  const isNew = !listeners.has(sym);
  if (isNew) listeners.set(sym, new Set());
  listeners.get(sym).add(fn);
  if (!ws) connect();
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
      idleTimer = setTimeout(() => { if (!listeners.size && ws) { ws.close(); ws = null; setStatus('off'); } }, IDLE_CLOSE_MS);
    }
  };
}
