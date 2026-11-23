// Positions CSV parsing (pure functions, no I/O). Supports Vanguard's OfxDownload.csv and Fidelity's "Portfolio Positions" download, which also lists
// accounts linked into Fidelity from other brokers (they show a long id instead of a Fidelity account number).
// Privacy: full account numbers and owner names are never kept. An account is identified by its last 4 digits.

// RFC 4180 CSV: quoted fields, doubled quotes, commas and line breaks inside quotes
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// "$11,490.74" / "+$3.66" / "-$5.13" / "43.20%" / "--" -> number or null
export function money(v) {
  const t = String(v ?? '').replace(/[$,%\s+]/g, '');
  if (!t || /^-+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const TICKER_RE = /^[A-Z][A-Z0-9.\-\/]{0,9}$/;
const MONEY_MARKET = /money market|held in money market|core position|cash reserves/i;
const FUND = /\bfund\b|\betf\b|index|admiral|investor shares|\btrust\b/i;

function last4Of(accountNumber, accountName) {
  const fromName = /(\d{4,})\s*$/.exec(String(accountName || ''));
  if (/^[A-Za-z]?\d{5,}$/.test(String(accountNumber || '').trim())) return String(accountNumber).trim().slice(-4);
  return fromName ? fromName[1].slice(-4) : null;
}

// "Owner Name - Roth IRA Brokerage Account - 12345678" -> "Roth IRA Brokerage Account"; "Long-Term Investments" stays
function cleanAccountName(name) {
  const parts = String(name || '').split(/\s+-\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 3) return parts.slice(1, /^\d+$/.test(parts[parts.length - 1]) ? -1 : undefined).join(' - ');
  if (parts.length === 2 && /^\d+$/.test(parts[1])) return parts[0];
  return parts.join(' - ') || 'Account';
}

// Vanguard's "OfxDownload.csv": a positions section (Account Number, Investment Name, Symbol, Shares, Share Price, Total
// Value), a blank gap, then a transactions section. Vanguard gives no cost basis, so a holding's cost is filled in only
// when every one of its shares can be traced to a Buy or Reinvestment in the file (otherwise null, shown as N/A).
function parseVanguard(rows, headerAt) {
  const head = rows[headerAt].map((c) => c.trim().toLowerCase());
  const col = (n) => head.indexOf(n);
  const C = { acct: col('account number'), name: col('investment name'), sym: col('symbol'), qty: col('shares'), price: col('share price'), value: col('total value') };
  if (C.sym < 0 || C.qty < 0 || C.value < 0) throw new Error('The Vanguard file is missing the Symbol, Shares or Total Value column.');
  // Transactions: shares and dollars bought per account + symbol
  const bought = new Map();
  const txAt = rows.findIndex((r, i) => i > headerAt && r.some((c) => /^transaction type$/i.test(c.trim())));
  if (txAt > 0) {
    const th = rows[txAt].map((c) => c.trim().toLowerCase());
    const T = { acct: th.indexOf('account number'), type: th.indexOf('transaction type'), sym: th.indexOf('symbol'), qty: th.indexOf('shares'), amt: th.indexOf('principal amount') };
    for (const r of rows.slice(txAt + 1)) {
      if (!r.length || r.every((c) => !c.trim())) break;
      if (!/^(buy|reinvestment)$/i.test((r[T.type] || '').trim())) continue;
      const q = money(r[T.qty]);
      const a = money(r[T.amt]);
      if (!q || q <= 0 || a === null) continue;
      const k = `${(r[T.acct] || '').trim()}|${(r[T.sym] || '').trim().toUpperCase()}`;
      const b = bought.get(k) || { qty: 0, cost: 0 };
      b.qty += q; b.cost += Math.abs(a);
      bought.set(k, b);
    }
  }
  const accounts = new Map();
  let skipped = 0;
  for (const r of rows.slice(headerAt + 1)) {
    if (!r.length || r.every((c) => !c.trim())) break;
    if (r.length < head.length - 2) { skipped++; continue; }
    const acctNo = (r[C.acct] || '').trim();
    const last4 = /\d{4,}$/.test(acctNo) ? acctNo.slice(-4) : null;
    const key = `csv:${last4 || 'vanguard'}`;
    if (!accounts.has(key)) accounts.set(key, { key, source: 'vanguard', label: 'Vanguard account', last4, linked: false, cash: 0, holdings: [] });
    const acct = accounts.get(key);
    const rawSym = (r[C.sym] || '').trim().toUpperCase();
    let symbol = rawSym.replace(/^([A-Z]+)[ /]([A-Z])$/, '$1.$2'); // "BRK B" -> BRK.B
    const description = (r[C.name] || '').trim().slice(0, 120);
    const quantity = money(r[C.qty]);
    const value = money(r[C.value]);
    if (MONEY_MARKET.test(description) || /^VMFXX$|^VMRXX$|^VMMXX$|^VUSXX$/.test(symbol)) { acct.cash += value ?? 0; continue; }
    if (!quantity || quantity <= 0) continue;
    if (symbol && !TICKER_RE.test(symbol)) symbol = '';
    const b = bought.get(`${acctNo}|${rawSym}`);
    const fullyTraced = b && Math.abs(b.qty - quantity) < 0.001;
    acct.holdings.push({
      symbol: symbol || null, description, quantity, lastPrice: money(r[C.price]), value,
      costBasis: fullyTraced ? Math.round(b.cost * 100) / 100 : null,
      kind: FUND.test(description) ? 'fund' : 'stock',
    });
  }
  const list = [...accounts.values()].filter((a) => a.holdings.length || a.cash > 0);
  if (!list.length) throw new Error('No positions found in this file.');
  return { accounts: list, skipped };
}

// Returns { accounts: [{ key, source, label, last4, linked, cash, holdings: [...] }], skipped } or throws with a reason
export function parsePositionsCsv(text) {
  const rows = parseCsv(String(text || '').replace(/^﻿/, ''));
  const vgAt = rows.findIndex((r) => r.some((c) => /^investment name$/i.test(c.trim())) && r.some((c) => /^total value$/i.test(c.trim())));
  if (vgAt >= 0) return parseVanguard(rows, vgAt);
  const headerAt = rows.findIndex((r) => r.some((c) => /^account number$/i.test(c.trim())) && r.some((c) => /^symbol$/i.test(c.trim())));
  if (headerAt < 0) throw new Error("This doesn't look like a Fidelity or Vanguard positions file (no Account Number / Symbol header).");
  const head = rows[headerAt].map((c) => c.trim().toLowerCase());
  const col = (name) => head.indexOf(name);
  const C = {
    acct: col('account number'), name: col('account name'), sym: col('symbol'), desc: col('description'), qty: col('quantity'),
    price: col('last price'), value: col('current value'), cost: col('cost basis total'), avg: col('average cost basis'),
  };
  if (C.sym < 0 || C.qty < 0 || C.value < 0) throw new Error('The positions file is missing the Symbol, Quantity or Current Value column.');
  const accounts = new Map();
  let skipped = 0;
  for (const r of rows.slice(headerAt + 1)) {
    if (!r.length || r.every((c) => !c.trim())) break; // the disclaimer section starts after a blank line
    if (r.length < head.length - 2) { skipped++; continue; }
    const acctNo = (r[C.acct] || '').trim();
    const rawName = C.name >= 0 ? r[C.name] : '';
    const last4 = last4Of(acctNo, rawName);
    const linked = !/^[A-Za-z]?\d{5,}$/.test(acctNo); // linked from another broker: Fidelity shows a long id
    const label = cleanAccountName(rawName);
    const key = `csv:${last4 || label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    if (!accounts.has(key)) accounts.set(key, { key, source: linked ? 'linked' : 'fidelity', label, last4, linked, cash: 0, holdings: [] });
    const acct = accounts.get(key);
    let symbol = (r[C.sym] || '').trim().toUpperCase().replace(/\*+$/, '');
    const description = (r[C.desc] || '').trim().slice(0, 120);
    const quantity = money(r[C.qty]);
    const value = money(r[C.value]);
    if (MONEY_MARKET.test(description) || /\*\*$/.test((r[C.sym] || '').trim())) { acct.cash += value ?? 0; continue; }
    if (!quantity || quantity <= 0) continue; // empty positions
    if (symbol && !TICKER_RE.test(symbol)) symbol = '';
    acct.holdings.push({
      symbol: symbol || null, // missing in some linked accounts (e.g. "Berkshire Hathaway Inc"): set by the user
      description,
      quantity,
      lastPrice: money(r[C.price]),
      value,
      costBasis: C.cost >= 0 ? money(r[C.cost]) : null,
      kind: FUND.test(description) ? 'fund' : 'stock',
    });
  }
  const list = [...accounts.values()].filter((a) => a.holdings.length || a.cash > 0);
  // A linked account holding Vanguard funds is most likely at Vanguard: say so in the default name (editable)
  for (const a of list) {
    if (a.linked && a.holdings.some((h) => /^vanguard\b/i.test(h.description))) a.label = `Vanguard ${a.label.replace(/\s+brokerage account$/i, '')}`;
  }
  if (!list.length) throw new Error('No positions found in this file.');
  return { accounts: list, skipped };
}
