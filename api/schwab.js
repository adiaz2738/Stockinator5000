import { requireAuth } from './_auth.js';
import {
  AUTHORIZE_URL, TRADER_BASE, MARKET_BASE, SchwabNotConnected, schwabConfig, createOAuthState, consumeOAuthState,
  exchangeCodeForTokens, connectionStatus, disconnect, schwabGet, streamerCredentials,
} from './_schwab.js';

// One function for every Schwab action (keeps the Vercel function count low). vercel.json rewrites
// /api/schwab/<action> to /api/schwab?action=<action>:
//   GET  /api/schwab/connect     start the Schwab login (needs an app session)
//   GET  /api/schwab/callback    Schwab sends the user back here (no app cookie: SameSite=Strict isn't sent
//                                on a cross-site redirect, so the one-time `state` proves who started it)
//   GET  /api/schwab/status      connection status for the nav
//   GET  /api/schwab/accounts    read-only accounts, balances and positions
//   GET  /api/schwab/stream      live-data WebSocket details + a current access token (for the browser's streamer)
//   GET  /api/schwab/quotes?symbols=AAPL,MCD   current quotes (the browser polls this when the WebSocket is refused)
//   POST /api/schwab/disconnect  forget the saved tokens
// Read-only: nothing here places, changes or cancels orders.

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function redirect(res, location) {
  res.setHeader('Cache-Control', 'no-store');
  res.writeHead(302, { Location: location });
  res.end();
}

function slimAccount(entry) {
  const a = entry?.securitiesAccount || {};
  const bal = a.currentBalances || {};
  const number = String(a.accountNumber || '');
  const positions = (Array.isArray(a.positions) ? a.positions : []).map((p) => ({
    symbol: p.instrument?.symbol || null,
    description: p.instrument?.description || null,
    assetType: p.instrument?.assetType || null,
    longQuantity: num(p.longQuantity),
    shortQuantity: num(p.shortQuantity),
    averagePrice: num(p.averagePrice),
    marketValue: num(p.marketValue),
    dayProfitLoss: num(p.currentDayProfitLoss),
    dayProfitLossPct: num(p.currentDayProfitLossPercentage),
    openProfitLoss: num(p.longOpenProfitLoss ?? p.shortOpenProfitLoss),
  }));
  positions.sort((x, y) => (y.marketValue ?? 0) - (x.marketValue ?? 0));
  return {
    last4: number ? number.slice(-4) : null, // never send the full account number to the browser
    type: a.type || null,
    liquidationValue: num(bal.liquidationValue) ?? num(entry?.aggregatedBalance?.liquidationValue),
    cash: num(bal.cashBalance) ?? num(bal.totalCash) ?? num(bal.cashAvailableForTrading),
    positions,
  };
}

export default async function handler(req, res) {
  const action = String(req.query?.action || '');
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (action === 'callback' && req.method === 'GET') {
      if (req.query?.error) return redirect(res, '/schwab?error=denied');
      const ok = await consumeOAuthState(req.query?.state);
      if (!ok) return redirect(res, '/schwab?error=state');
      const code = typeof req.query?.code === 'string' ? req.query.code : '';
      if (!code || code.length > 2000) return redirect(res, '/schwab?error=code');
      try {
        await exchangeCodeForTokens(code);
      } catch (err) {
        console.error('Schwab code exchange failed:', err.message);
        return redirect(res, '/schwab?error=exchange');
      }
      return redirect(res, '/schwab?connected=1');
    }

    if (!requireAuth(req, res)) return;

    if (action === 'connect' && req.method === 'GET') {
      const cfg = schwabConfig();
      if (!cfg) return redirect(res, '/schwab?error=config');
      const state = await createOAuthState();
      const url = `${AUTHORIZE_URL}?${new URLSearchParams({ client_id: cfg.appKey, redirect_uri: cfg.callbackUrl, state })}`;
      return redirect(res, url);
    }

    if (action === 'status' && req.method === 'GET') {
      return res.status(200).json(await connectionStatus());
    }

    if (action === 'accounts' && req.method === 'GET') {
      const data = await schwabGet(`${TRADER_BASE}/accounts?fields=positions`);
      const accounts = (Array.isArray(data) ? data : []).map(slimAccount);
      return res.status(200).json({ accounts, fetchedAt: new Date().toISOString() });
    }

    if (action === 'quotes' && req.method === 'GET') {
      const symbols = [...new Set(String(req.query?.symbols || '').toUpperCase().split(',').map((s) => s.trim()).filter((s) => /^[A-Z][A-Z0-9.\-\/]{0,9}$/.test(s)))].slice(0, 100);
      if (!symbols.length) return res.status(400).json({ error: 'symbols required' });
      const data = await schwabGet(`${MARKET_BASE}/quotes?${new URLSearchParams({ symbols: symbols.join(','), fields: 'quote' })}`);
      const out = {};
      for (const [sym, item] of Object.entries(data || {})) {
        const q = item?.quote || {};
        out[sym.toUpperCase()] = {
          last: num(q.lastPrice), totalVolume: num(q.totalVolume), dayHigh: num(q.highPrice), dayLow: num(q.lowPrice),
          prevClose: num(q.closePrice), tradeTime: num(q.tradeTime),
        };
      }
      return res.status(200).json({ quotes: out, at: Date.now() });
    }

    if (action === 'stream' && req.method === 'GET') {
      return res.status(200).json(await streamerCredentials());
    }

    if (action === 'disconnect' && req.method === 'POST') {
      await disconnect();
      return res.status(200).json({ ok: true });
    }

    return res.status(404).json({ error: 'Not found' });
  } catch (err) {
    if (err instanceof SchwabNotConnected) return res.status(409).json({ error: 'schwab_not_connected', reason: err.reason });
    console.error('schwab handler failed:', err);
    return res.status(502).json({ error: 'Schwab request failed' });
  }
}
