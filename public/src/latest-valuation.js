// The latest saved valuation for a ticker (from /api/valuations?ticker=X), shared by the Filings header and the
// chart's buy-below / intrinsic value lines. Cached briefly so both don't fetch it twice.

const cache = new Map(); // ticker -> { at, promise }
const TTL_MS = 15000;
const num = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

export function latestValuation(ticker) {
  const t = String(ticker || '').trim().toUpperCase();
  if (!t) return Promise.resolve(null);
  const hit = cache.get(t);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;
  const promise = fetch(`/api/valuations?ticker=${encodeURIComponent(t)}`)
    .then((res) => (res.ok ? res.json() : null))
    .then((body) => {
      const v = body?.valuation;
      if (!v) return null;
      return {
        id: v.id,
        ticker: t,
        intrinsicValue: num(v.intrinsic_value),
        buyBelow: num(v.safety_price),
        marginOfSafety: num(v.margin_of_safety),
        marketPrice: num(v.market_price),
        verdict: typeof v.verdict === 'string' ? v.verdict : null,
        createdAt: v.created_at,
      };
    })
    .catch((err) => { console.error(err); cache.delete(t); return null; });
  cache.set(t, { at: Date.now(), promise });
  return promise;
}
