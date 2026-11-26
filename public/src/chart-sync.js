// Keeps chart drawings and settings in Neon so they follow you between devices (PC, phone, installed app).
// The charts still read and write localStorage synchronously (fast, works offline); this module mirrors those keys:
//  - once per page load, before the first chart mounts: send any unsent local changes, then pull every saved key
//    from the server into localStorage (the server copy wins unless this device has a newer, unsent change)
//  - after each save: mark the key as unsent and push it a moment later (batched), and again when the page is hidden
// Only keys that start with "vl.charts." are synced. Values are the same JSON the charts already store.

const PREFIX = 'vl.charts.';
const META_KEY = 'vl.chartsync.meta'; // { [key]: { t: ms of last local change, pending: true } }
const FLUSH_MS = 1500;
const READY_TIMEOUT_MS = 4000;

let readyPromise = null;
let timer = 0;

function readMeta() {
  try { return JSON.parse(localStorage.getItem(META_KEY) || 'null') || {}; } catch (err) { return {}; }
}
function writeMeta(m) {
  try { localStorage.setItem(META_KEY, JSON.stringify(m)); } catch (err) { /* ignore */ }
}
function readValue(key) {
  try { const raw = localStorage.getItem(key); return raw === null ? null : JSON.parse(raw); } catch (err) { return null; }
}

async function push(keepalive = false) {
  clearTimeout(timer);
  const meta = readMeta();
  const keys = Object.keys(meta).filter((k) => meta[k]?.pending).slice(0, 50);
  if (!keys.length) return true;
  const items = keys.map((key) => ({ key, data: readValue(key), t: meta[key].t }));
  try {
    const res = await fetch('/api/chartstate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }), keepalive });
    if (!res.ok) return false;
    const now = readMeta();
    for (const it of items) if (now[it.key] && now[it.key].t === it.t) delete now[it.key].pending; // unchanged since we sent it
    writeMeta(now);
    if (Object.values(now).some((m) => m?.pending)) schedule();
    return true;
  } catch (err) {
    return false;
  }
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => { push(); }, FLUSH_MS);
}

// Call after writing a vl.charts.* key to localStorage
export function markChartKeyChanged(key) {
  if (!String(key).startsWith(PREFIX)) return;
  const meta = readMeta();
  meta[key] = { t: Date.now(), pending: true };
  writeMeta(meta);
  schedule();
}

// First run on a device: queue what is already saved here (drawings made before syncing existed) with the oldest
// possible time, so it reaches the server when the server has nothing, but never replaces a copy from another device.
function seedOnce() {
  try {
    if (localStorage.getItem('vl.chartsync.seeded')) return;
    const meta = readMeta();
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(PREFIX) && !meta[key]) meta[key] = { t: 1, pending: true };
    }
    writeMeta(meta);
    localStorage.setItem('vl.chartsync.seeded', '1');
  } catch (err) { /* ignore */ }
}

async function pullAll() {
  seedOnce();
  await push();
  const res = await fetch('/api/chartstate');
  if (!res.ok) return;
  const body = await res.json();
  const meta = readMeta();
  for (const [key, item] of Object.entries(body.items || {})) {
    if (!key.startsWith(PREFIX)) continue;
    const local = meta[key];
    if (local?.pending && local.t > (item.t || 0)) continue; // newer unsent change on this device: keep it
    try { localStorage.setItem(key, JSON.stringify(item.data)); } catch (err) { /* storage full: keep going */ }
    if (local) delete meta[key].pending;
  }
  writeMeta(meta);
}

// Resolves once the server copy is in localStorage (or after a short timeout, so charts never wait long offline)
export function chartSyncReady() {
  if (!readyPromise) {
    const work = pullAll().catch(() => {});
    readyPromise = Promise.race([work, new Promise((r) => setTimeout(r, READY_TIMEOUT_MS))]);
  }
  return readyPromise;
}

// Send unsent changes when the page is hidden or closed (phones rarely fire unload)
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') push(true); });
window.addEventListener('pagehide', () => { push(true); });
