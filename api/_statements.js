// Server-side only. As-filed financial statements from a company's latest annual filing.
// Order of attempts: XBRL "R pages" (FilingSummary.xml or R2..R9), then statement tables found in the filing's
// own documents. Cell text is kept exactly as filed (never parsed into numbers) and is rendered with
// textContent on the client; fetched HTML is never passed through.

import sql from './_db.js';
import { secFetch, listFilingDocuments, fiscalYearOf, DOC_NAME_RE } from './_sec.js';

export const PARSER_VERSION = 2;

const R_PAGE_RE = /^R\d{1,4}\.htm$/;
const MAX_ROWS = 400;
const MAX_LABEL = 300;
const MAX_VALUE = 60;
const MAX_DOC_BYTES = 30 * 1024 * 1024;
const MAX_FALLBACK_DOCS = 6;
const MAX_PROBE_PAGES = 9;

const STATEMENT_KEYS = ['balance', 'income', 'cashflow'];
const STATEMENT_NAMES = { balance: 'Balance Sheet', income: 'Income Statement', cashflow: 'Cash Flow Statement' };

// ---------- Text helpers ----------

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…', deg: '°', euro: '€', pound: '£' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
      } catch {
        return ' ';
      }
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

// Visible text of an HTML fragment. Footnote markers (<sup>) are dropped.
function cellText(html) {
  return decodeEntities(
    html.replace(/<sup\b[\s\S]*?<\/sup>/gi, '').replace(/<br\s*\/?>|<\/(?:p|div|td|th|tr|li|h[1-6])\s*>/gi, ' ').replace(/<[^>]*>/g, ''),
  ).replace(/[\s ]+/g, ' ').trim();
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function rowsOf(tableHtml) {
  return [...tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]);
}

function cellsOf(rowHtml) {
  return [...rowHtml.matchAll(/<(t[dh])\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi)].map((m) => ({
    tag: m[1].toLowerCase(),
    attrs: m[2],
    html: m[3],
    colspan: Math.min(parseInt(/colspan\s*=\s*["']?(\d+)/i.exec(m[2])?.[1] || '1', 10) || 1, 20),
    isTitle: /class\s*=\s*["'][^"']*\btl\b/i.test(m[2]),
  }));
}

// ---------- Statement classification ----------

const EXCLUDED_TITLE = /parenthetical|details?\b|narrative|polic(?:y|ies)|\btables?\b|schedule|reconciliation|\bnotes?\b/i;

// 'balance' | 'income' | 'cashflow' | null, plus a tier (higher = better match) for choosing between candidates.
export function classifyTitle(rawTitle) {
  const t = String(rawTitle || '').toLowerCase().replace(/\s+/g, ' ');
  if (!t || EXCLUDED_TITLE.test(t)) return null;
  if (/cash flows?/.test(t)) return { key: 'cashflow', tier: 2 };
  if (/changes in (?:stockholders|shareholders|equity)|statements? of (?:stockholders|shareholders|changes in|equity)|\bequity\b.*\b(?:statements?|changes)\b/.test(t) && !/balance sheet|financial position/.test(t)) return null;
  if (/balance sheets?|financial position|financial condition|assets and liabilities/.test(t)) return { key: 'balance', tier: 2 };
  if (/income|operations|earnings|profit|loss/.test(t)) {
    // A plain income statement beats a combined one, which beats a comprehensive-income-only statement
    if (/comprehensive/.test(t)) return { key: 'income', tier: /income and comprehensive|operations and comprehensive|earnings and comprehensive|profit or loss and|and other comprehensive/.test(t) ? 1 : 0 };
    return { key: 'income', tier: 2 };
  }
  return null;
}

function pickReports(reports) {
  // Prefer entries SEC categorises as statements, when it categorises at all
  const pool = reports.some((r) => /statement/i.test(r.category || '')) ? reports.filter((r) => /statement/i.test(r.category || '')) : reports;
  const best = {};
  for (const r of pool) {
    const c = classifyTitle(r.title);
    if (!c) continue;
    if (!best[c.key] || c.tier > best[c.key].tier) best[c.key] = { ...r, tier: c.tier };
  }
  return best;
}

// ---------- Row structure (indentation and totals) ----------

const TOTAL_LABEL = /^(?:total\b|net (?:income|loss|earnings|cash|increase|decrease|change|\(loss\))|gross (?:profit|margin)|operating (?:income|profit|loss)|income(?: \(loss\))?(?: from continuing operations)? before|cash and (?:cash equivalents|restricted).*(?:end|beginning) of|(?:net )?cash (?:provided|used|flows?|generated)|comprehensive income|profit\b|earnings before)/i;

// Section headers have a label and no values ("Current assets:"). Rows under a header are indented until a
// total row closes the section. Display heuristics only: the numbers are never touched.
function assignStructure(rows) {
  let level = 0;
  for (const row of rows) {
    if (row.header) {
      row.level = 0;
      level = 1;
    } else if (row.total) {
      row.level = 0;
      level = 0;
    } else {
      row.level = level;
    }
  }
}

// ---------- R pages ----------

function parseReportTitle(html) {
  // "Consolidated Balance Sheet - USD ($)<br> $ in Millions"
  const parts = html.replace(/<sup\b[\s\S]*?<\/sup>/gi, '').split(/<br\s*\/?>/i).map((p) => cellText(p)).filter(Boolean);
  const first = parts[0] || '';
  const dash = first.lastIndexOf(' - ');
  const title = dash > 0 ? first.slice(0, dash) : first;
  const currency = dash > 0 ? first.slice(dash + 3) : '';
  const units = [currency, ...parts.slice(1)].filter(Boolean).join(' · ');
  return { title: clip(title, 200), units: units ? clip(units, 200) : null };
}

export function parseRPage(html) {
  const tableMatch = /<table\b[^>]*class\s*=\s*["'][^"']*\breport\b[^"']*["'][^>]*>([\s\S]*?)<\/table>/i.exec(html);
  if (!tableMatch) return null;
  const trs = rowsOf(tableMatch[1]);

  const headerRows = [];
  const dataRows = [];
  for (const tr of trs) {
    const cells = cellsOf(tr);
    if (!cells.length) continue;
    if (!dataRows.length && cells.every((c) => c.tag === 'th')) headerRows.push(cells);
    else dataRows.push(cells);
  }
  if (!headerRows.length || !dataRows.length) return null;

  const titleCell = headerRows[0].find((c) => c.isTitle) || headerRows[0][0];
  const { title, units } = parseReportTitle(titleCell.html);

  const expand = (cells) => cells.filter((c) => !c.isTitle).flatMap((c) => Array(c.colspan).fill(cellText(c.html)));
  const dates = expand(headerRows[headerRows.length - 1]);
  const groups = headerRows.length >= 2 ? expand(headerRows[headerRows.length - 2]) : [];
  const periods = dates.map((d, i) => {
    const g = groups.length === dates.length ? groups[i] : '';
    return clip([g, d].filter(Boolean).join(' · '), 80);
  });

  const rows = [];
  for (const cells of dataRows) {
    // Some pages add a footnote column (class "th", only a <sup>) after the label; it is not a period column
    const [labelCell, ...rest] = cells;
    const valueCells = rest.filter((c) => !/class\s*=\s*["'][^"']*\bth\b/i.test(c.attrs));
    const label = cellText(labelCell.html);
    if (!label) continue;
    const values = valueCells.map((c) => clip(cellText(c.html), MAX_VALUE));
    const hasValue = values.some((v) => v !== '');
    // Long free-text cells (notes shown in a statement page) are not line items
    if (valueCells.some((c) => /\btext\b/i.test(c.attrs) && cellText(c.html).length > 80)) continue;
    rows.push({
      label: clip(label, MAX_LABEL),
      values: hasValue ? values : [],
      header: !hasValue,
      total: hasValue && TOTAL_LABEL.test(label),
      level: 0,
    });
    if (rows.length >= MAX_ROWS) break;
  }
  if (!rows.some((r) => !r.header)) return null;
  assignStructure(rows);
  return { title, units, periods, rows };
}

function parseFilingSummary(xml) {
  return [...xml.matchAll(/<Report\b[\s\S]*?<\/Report>/gi)].map((m) => {
    const pick = (tag) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(m[0])?.[1]?.trim() || '';
    const file = decodeEntities(pick('HtmlFileName'));
    const long = decodeEntities(pick('LongName'));
    const short = decodeEntities(pick('ShortName'));
    return { file, category: decodeEntities(pick('MenuCategory')), title: short || long.replace(/^\d+\s*-\s*\w+\s*-\s*/, '') };
  }).filter((r) => R_PAGE_RE.test(r.file));
}

async function fetchText(url, accept = 'text/html') {
  const res = await secFetch(url, accept);
  if (!res.ok) return null;
  return res.text();
}

async function statementsFromRPages(filing) {
  let reports = [];
  const summary = await fetchText(`${filing.baseUrl}/FilingSummary.xml`, 'text/xml');
  if (summary) reports = parseFilingSummary(summary);

  const chosen = {};
  const pages = new Map(); // file -> parsed page, to avoid fetching the same page twice

  const load = async (file) => {
    if (pages.has(file)) return pages.get(file);
    const html = await fetchText(`${filing.baseUrl}/${file}`);
    const parsed = html ? parseRPage(html) : null;
    pages.set(file, parsed);
    return parsed;
  };

  if (reports.length) {
    const picks = pickReports(reports);
    for (const key of STATEMENT_KEYS) {
      if (!picks[key]) continue;
      const page = await load(picks[key].file);
      if (page) chosen[key] = { ...page, file: picks[key].file };
    }
  } else {
    // No FilingSummary.xml: probe the first few R pages and classify them by their own titles
    const found = {};
    for (let n = 2; n <= MAX_PROBE_PAGES && Object.keys(found).length < 3; n++) {
      const file = `R${n}.htm`;
      const page = await load(file);
      if (!page) continue;
      const c = classifyTitle(page.title);
      if (c && (!found[c.key] || c.tier > found[c.key].tier)) found[c.key] = { tier: c.tier, page, file };
    }
    for (const [key, v] of Object.entries(found)) chosen[key] = { ...v.page, file: v.file };
  }
  return chosen;
}

// ---------- Fallback: statement tables inside the filing's documents ----------

const NUMERIC_CELL = /^\(?-?\$?\s*\(?\d[\d,]*(?:\.\d+)?\)?%?$|^[—–-]$/;
const PERIOD_CELL = /\b(?:19|20)\d\d\b/;
const UNITS_RE = /\(?\s*(?:expressed\s+)?(?:in|US\$|\$)\s+(?:millions|thousands|billions)(?:\s+of\s+[a-z .]{1,40}?(?:dollars|euros|pounds))?(?:,?\s*except\s+[a-z ,]{1,60})?\)?/i;

function indentOf(html) {
  const m = /(?:padding-left|margin-left|text-indent)\s*:\s*(-?[\d.]+)\s*(pt|px|em|in)/i.exec(html);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const f = { pt: 1.33, px: 1, em: 16, in: 96 }[m[2].toLowerCase()];
  return Math.max(0, n * f);
}

function parseDocumentTable(tableHtml) {
  const rows = [];
  const periodRows = [];
  const indents = [];
  const lead = [];
  for (const tr of rowsOf(tableHtml)) {
    const texts = cellsOf(tr).map((c) => ({ text: cellText(c.html), html: c.html }));
    // merge split closing parentheses and drop bare currency symbols
    const cells = [];
    for (const c of texts) {
      if (c.text === '' || c.text === '$') continue;
      if (/^\)%?$/.test(c.text) && cells.length) {
        cells[cells.length - 1].text += c.text;
        continue;
      }
      cells.push({ ...c });
    }
    if (!cells.length) continue;
    const labelled = !NUMERIC_CELL.test(cells[0].text) && !(cells.length > 1 && cells.every((c) => PERIOD_CELL.test(c.text)));
    if (!labelled) {
      // Before the first line item, a row of years or dates is the column header; elsewhere it is skipped
      if (!rows.some((r) => !r.header) && cells.every((c) => PERIOD_CELL.test(c.text))) {
        periodRows.push(cells.map((c) => c.text));
        lead.push(...rows.map((r) => r.label));
        rows.length = 0;
        indents.length = 0;
      }
      continue;
    }
    const label = cells[0].text;
    const values = cells.slice(1).map((c) => clip(c.text, MAX_VALUE));
    // A row of years/dates before the first line item is the column header. Title lines above it are dropped,
    // but kept as `lead` since the units note often sits there.
    if (!rows.some((r) => !r.header) && values.length > 1 && values.every((v) => PERIOD_CELL.test(v))) {
      periodRows.push(values);
      lead.push(label, ...rows.map((r) => r.label));
      rows.length = 0;
      indents.length = 0;
      continue;
    }
    const bold = /<(?:b|strong)\b|font-weight\s*:\s*(?:bold|[6-9]00)/i.test(texts.find((t) => t.text === label)?.html || '');
    indents.push(indentOf(texts[0]?.html || ''));
    rows.push({
      label: clip(label, MAX_LABEL),
      values,
      header: values.length === 0,
      total: values.length > 0 && (TOTAL_LABEL.test(label) || bold),
      level: 0,
    });
    if (rows.length >= MAX_ROWS) break;
  }
  return { rows, indents, lead, periods: periodRows.length ? periodRows[periodRows.length - 1] : [] };
}

function signature(rows) {
  const labels = rows.map((r) => r.label.toLowerCase());
  const has = (re) => labels.some((l) => re.test(l));
  const out = [];
  if (has(/^total assets\b/) && has(/^total liabilities\b|^total liabilities and/)) out.push('balance');
  if (has(/operating activities/) && has(/investing activities/) && has(/financing activities/)) out.push('cashflow');
  // A cash flow statement also mentions net income and income taxes, so it can never double as an income statement
  if (!out.includes('cashflow') && has(/\b(?:revenues?|sales)\b/) && has(/\bnet (?:income|earnings|loss)\b|\bprofit for the (?:year|period)\b/) && has(/per (?:common )?share|operating (?:income|profit)|income tax/)) out.push('income');
  return out;
}

function structureFromIndents(rows, indents) {
  const distinct = [...new Set(indents)].sort((a, b) => a - b);
  if (distinct.length < 2) {
    assignStructure(rows);
    return;
  }
  rows.forEach((row, i) => {
    row.level = Math.min(distinct.indexOf(indents[i]), 4);
  });
}

function findTablesInDocument(html, wanted) {
  const found = {};
  const re = /<table\b[\s\S]*?<\/table>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[0];
    if (raw.length < 600) continue;
    const lower = raw.toLowerCase();
    // cheap pre-filter before the table is parsed
    if (!(lower.includes('total assets') || lower.includes('operating activities') || lower.includes('net income') || lower.includes('net earnings') || lower.includes('net loss'))) continue;
    const parsed = parseDocumentTable(raw);
    const dataRows = parsed.rows.filter((r) => !r.header).length;
    if (dataRows < 8) continue;
    for (const key of signature(parsed.rows)) {
      if (!wanted.includes(key)) continue;
      // The full statement is the signature table with the most line items (MD&A holds condensed copies)
      if (found[key] && found[key].rowCount >= dataRows) continue;
      let chunk = html.slice(Math.max(0, m.index - 1200), m.index);
      // the slice may start inside a tag; drop that partial tag
      const gt = chunk.indexOf('>');
      const lt = chunk.indexOf('<');
      if (gt !== -1 && (lt === -1 || gt < lt)) chunk = chunk.slice(gt + 1);
      const before = cellText(chunk);
      // e.g. "58 Table of Contents VISA CONSOLIDATED BALANCE SHEETS" -> "CONSOLIDATED BALANCE SHEETS"
      const titles = [...before.slice(-400).matchAll(/(?:consolidated\s+)?(?:balance sheets?|statements? of [a-z ]{3,40}?(?:income|operations|earnings|cash flows?))\b/gi)];
      const heading = titles.length ? titles[titles.length - 1][0] : '';
      const units = UNITS_RE.exec(parsed.lead.join('  '))?.[0] || UNITS_RE.exec(before.slice(-700))?.[0] || UNITS_RE.exec(cellText(raw.slice(0, 2500)))?.[0] || null;
      found[key] = { rowCount: dataRows, parsed, before, heading, units };
    }
  }
  return found;
}

async function readLimited(url) {
  const res = await secFetch(url, 'text/html');
  if (!res.ok) return null;
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_DOC_BYTES) return null;
  return res.text();
}

export async function statementsFromDocuments(filing, wanted) {
  let docs = [];
  try {
    docs = await listFilingDocuments(filing);
  } catch (err) {
    console.error('filing document listing failed:', err);
  }
  const usable = docs.filter((d) => /\.html?$/i.test(d.name) && DOC_NAME_RE.test(d.name) && !R_PAGE_RE.test(d.name) && d.size <= MAX_DOC_BYTES);
  const rank = (d) => (d.name === filing.primaryDocument ? 0 : /EX-13/.test(d.type || '') ? 1 : /EX-99/.test(d.type || '') ? 2 : 3);
  usable.sort((a, b) => rank(a) - rank(b) || b.size - a.size);

  const chosen = {};
  let attempts = 0;
  for (const d of usable) {
    const stillWanted = wanted.filter((k) => !chosen[k]);
    if (!stillWanted.length || attempts >= MAX_FALLBACK_DOCS) break;
    // Exhibits that are neither the main document nor an annual-report/press exhibit rarely hold statements
    if (rank(d) === 3 && d.size < 50000) continue;
    attempts++;
    let html;
    try {
      html = await readLimited(`${filing.baseUrl}/${d.name}`);
    } catch (err) {
      console.error('statement fallback fetch failed:', err);
      continue;
    }
    if (!html) continue;
    const tables = findTablesInDocument(html, stillWanted);
    for (const [key, t] of Object.entries(tables)) {
      structureFromIndents(t.parsed.rows, t.parsed.indents);
      chosen[key] = {
        title: clip(t.heading || STATEMENT_NAMES[key], 200),
        units: t.units ? clip(t.units, 200) : null,
        periods: t.parsed.periods.map((p) => clip(p, 80)),
        rows: t.parsed.rows,
        file: d.name,
      };
    }
  }
  return chosen;
}

// ---------- Entry point ----------

function finish(key, page, method, filing) {
  const columns = Math.max(page.periods.length, ...page.rows.map((r) => r.values.length), 0);
  return {
    key,
    name: STATEMENT_NAMES[key],
    title: page.title,
    method,
    units: page.units,
    periods: page.periods,
    columns,
    rowCount: page.rows.filter((r) => !r.header).length,
    rows: page.rows,
    // validated file names only, so every link is built from values SEC returned
    sourceUrl: method === 'r-pages' && R_PAGE_RE.test(page.file) ? `${filing.baseUrl}/${page.file}` : DOC_NAME_RE.test(page.file || '') ? `${filing.baseUrl}/${page.file}` : null,
    sourceFile: page.file,
  };
}

// Returns { parserVersion, statements: { balance, income, cashflow } (each null when not found) }.
export async function fetchAsFiledStatements(filing) {
  const statements = { balance: null, income: null, cashflow: null };

  try {
    const fromR = await statementsFromRPages(filing);
    for (const [key, page] of Object.entries(fromR)) statements[key] = finish(key, page, 'r-pages', filing);
  } catch (err) {
    console.error('R page statements failed:', err);
  }

  const missing = STATEMENT_KEYS.filter((k) => !statements[k]);
  if (missing.length) {
    try {
      const fromDoc = await statementsFromDocuments(filing, missing);
      for (const [key, page] of Object.entries(fromDoc)) statements[key] = finish(key, page, 'document', filing);
    } catch (err) {
      console.error('document statements fallback failed:', err);
    }
  }
  return { parserVersion: PARSER_VERSION, statements };
}

// ---------- Cached loading (shared by /api/statements and /api/filings) ----------

const USER_ID = 'local';

async function ensureStatementsTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS company_statements (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'local',
      cik TEXT NOT NULL,
      accession TEXT NOT NULL,
      statements JSONB NOT NULL,
      fetched_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id, cik, accession)
    )
  `;
}

// A filing never changes once accepted, so a cached row is reused while the parser version matches.
// Nothing found is not cached, so a later parser fix or a transient SEC error isn't remembered.
export async function loadStatements(cik, filing) {
  await ensureStatementsTable();
  const existing = await sql`
    SELECT statements FROM company_statements
    WHERE user_id = ${USER_ID} AND cik = ${cik} AND accession = ${filing.accession}
  `;
  if (existing[0]?.statements?.parserVersion === PARSER_VERSION) {
    return { statements: existing[0].statements.statements, cached: true };
  }
  const result = await fetchAsFiledStatements(filing);
  if (Object.values(result.statements).some(Boolean)) {
    await sql`
      INSERT INTO company_statements (user_id, cik, accession, statements, fetched_at)
      VALUES (${USER_ID}, ${cik}, ${filing.accession}, ${JSON.stringify(result)}::jsonb, NOW())
      ON CONFLICT (user_id, cik, accession) DO UPDATE SET
        statements = EXCLUDED.statements,
        fetched_at = NOW()
    `;
  }
  return { statements: result.statements, cached: false };
}

// ---------- Figures derived from the as-filed cash flow statement ----------

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// Fiscal year of each value column, or null for columns that are not a 12-month period
function columnYears(statement) {
  return (statement.periods || []).map((p) => {
    const months = /(\d+)\s+months?\s+ended/i.exec(p);
    if (months && Number(months[1]) !== 12) return null;
    const d = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+((?:19|20)\d\d)/.exec(p);
    if (d && MONTHS[d[1].toLowerCase()] !== undefined) {
      const iso = `${d[3]}-${String(MONTHS[d[1].toLowerCase()] + 1).padStart(2, '0')}-${d[2].padStart(2, '0')}`;
      return fiscalYearOf(iso);
    }
    const y = /\b((?:19|20)\d\d)\b/.exec(p);
    return y ? Number(y[1]) : null;
  });
}

// Multiplier from the page's own units note; null when the page doesn't state one (then nothing is derived)
function unitScale(units) {
  const u = String(units || '').toLowerCase();
  if (/billions/.test(u)) return 1e9;
  if (/millions/.test(u)) return 1e6;
  if (/thousands/.test(u)) return 1e3;
  if (/\bin (?:usd|dollars)\b|^usd/.test(u) && !/(?:millions|thousands|billions)/.test(u)) return 1;
  return null;
}

// "$ (1,234)" -> -1234, "—" -> 0, anything else non-numeric -> null
function parseAmount(text) {
  const t = String(text || '').trim();
  if (/^[\u2014\u2013-]$/.test(t)) return 0;
  const m = /^\$?\s*(\()?\s*\$?\s*(-)?\s*([\d,]+(?:\.\d+)?)\s*\)?$/.exec(t);
  if (!m) return null;
  const n = parseFloat(m[3].replace(/,/g, ''));
  return m[1] || m[2] ? -n : n;
}

// Capital-type investing lines. Acquisitions of businesses, purchases of investments and loans never count.
const CAPITAL_LINE = /\b(?:property|plant|equipment|fixed assets?|capital expenditures?|capital spending|capital improvements?|leasehold|software|technology|patents?|intangibles?|trademarks?|licen[cs]es?|buildings?|land|furniture|vehicles|machinery|improvements?|mineral (?:properties|interests)|oil and gas properties|development costs?|capitalized)\b/i;
const NOT_CAPITAL_LINE = /acquisitions? of (?:businesses?|subsidiar|compan)|business(?:es)? acquisitions?|acquired businesses|net of cash acquired|acquire[sd]? (?:a |the )?businesses?|purchases? of (?:investments?|securities|marketable|short-term|available|held|treasury|bonds|certificates|deposits|notes)|investments? in (?:securities|affiliates|equity|marketable|unconsolidated|joint)|marketable|securit(?:y|ies)|\bloans?\b|notes? receivable|advances|proceeds|\bsales? of\b|disposals?|divest|maturit|redemption|collection|repayment|restricted cash|affiliate|joint venture|equity method|derivative|insurance|dividend/i;

function investingSection(rows) {
  const end = rows.findIndex((r) => !r.header && /investing activities/i.test(r.label));
  if (end < 0) return [];
  let start = -1;
  for (let i = end - 1; i >= 0; i--) {
    if (rows[i].header && /investing/i.test(rows[i].label)) { start = i; break; }
  }
  if (start < 0) {
    for (let i = end - 1; i >= 0; i--) {
      if (!rows[i].header && /operating activities/i.test(rows[i].label)) { start = i; break; }
    }
  }
  return start < 0 ? [] : rows.slice(start + 1, end).filter((r) => !r.header);
}

// Map(fiscalYear -> { value (positive outflow, in currency units), lines: [{ label, amount }] }).
// Never uses the "net cash used in investing" total.
export function capexFromStatement(cf) {
  const out = new Map();
  const scale = unitScale(cf?.units);
  if (!cf || scale === null) return out;
  const years = columnYears(cf);
  const lines = investingSection(cf.rows).filter((r) => CAPITAL_LINE.test(r.label) && !NOT_CAPITAL_LINE.test(r.label));
  if (!lines.length) return out;
  years.forEach((fy, col) => {
    if (fy === null) return;
    const used = [];
    for (const r of lines) {
      const v = parseAmount(r.values[col]);
      if (v !== null && v < 0) used.push({ label: r.label, amount: -v * scale });
    }
    if (used.length) out.set(fy, { value: used.reduce((s, l) => s + l.amount, 0), lines: used });
  });
  return out;
}

const NON_CASH_LINE = /impairment|write-?downs?|provision|\bdeferred income tax|depreciation|amortization|stock-based|share-based|non-cash/i;
const WORKING_CAPITAL_LINE = /receivable|inventor|payable|accrued|deferred revenue|deferred cogs|prepaid|other current|working capital|contract (?:assets|liabilities)|customer deposits|unearned|operating lease liabilit/i;

// Map(fiscalYear -> { label, amount }): the largest single working-capital line in operating activities
export function workingCapitalFromStatement(cf) {
  const out = new Map();
  const scale = unitScale(cf?.units);
  if (!cf || scale === null) return out;
  const end = cf.rows.findIndex((r) => !r.header && /operating activities/i.test(r.label) && /^(?:net )?cash|total/i.test(r.label));
  const operating = end < 0 ? cf.rows : cf.rows.slice(0, end);
  // Prefer the section the filer itself labels as changes in operating assets and liabilities
  const sectionAt = operating.findIndex((r) => r.header && /operating assets and liabilities|working capital|changes in (?:operating )?(?:assets|current)/i.test(r.label));
  const pool = sectionAt >= 0 ? operating.slice(sectionAt + 1) : operating;
  const rows = pool.filter((r) => !r.header && WORKING_CAPITAL_LINE.test(r.label) && !NON_CASH_LINE.test(r.label));
  columnYears(cf).forEach((fy, col) => {
    if (fy === null) return;
    let best = null;
    for (const r of rows) {
      const v = parseAmount(r.values[col]);
      if (v !== null && (!best || Math.abs(v) > Math.abs(best.amount))) best = { label: r.label, amount: v * scale };
    }
    if (best) out.set(fy, best);
  });
  return out;
}
