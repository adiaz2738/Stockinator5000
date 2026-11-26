// Your average cost per ticker across every account (from /api/portfolio?action=costs), for the chart's cost line.
// One request covers every ticker; cached for a minute so several charts don't each ask.

let cached = null; // { at, promise }
const TTL_MS = 60000;

export function positionCost(ticker) {
  const t = String(ticker || '').trim().toUpperCase();
  if (!t) return Promise.resolve(null);
  if (!cached || Date.now() - cached.at > TTL_MS) {
    const promise = fetch('/api/portfolio?action=costs')
      .then((res) => (res.ok ? res.json() : { costs: {} }))
      .then((body) => body.costs || {})
      .catch(() => { cached = null; return {}; });
    cached = { at: Date.now(), promise };
  }
  return cached.promise.then((costs) => costs[t] || null);
}
