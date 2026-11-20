// Server-side only. As-filed financial statements from a company's latest annual filing.
// Order of attempts: XBRL "R pages" (FilingSummary.xml or R2..R9), then statement tables found in the filing's
// own documents. Cell text is kept exactly as filed (never parsed into numbers) and is rendered with
// textContent on the client; fetched HTML is never passed through.

import sql from './_db.js';
import { secFetch, listFilingDocuments, fiscalYearOf, DOC_NAME_RE } from './_sec.js';

export const PARSER_VERSION = 6; // 6: group headers ("Year Ended" / "Six Months Ended" / "As of") above the year row; interim columns // 5: join pages that repeat the statement heading, skip parent-company-only schedules, keep unlabeled subtotals

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
// Column-group headers above the year row ("Year Ended December 31,", "Six Months Ended June 30,", "As of June 30,")
const GROUP_CELL = /^(?:\(?unaudited\)?|as of\b|at\b|(?:fiscal )?years? ended\b|(?:three|six|nine|twelve|\d+)[- ]months? ended\b|for the (?:fiscal )?(?:years?|periods?|(?:three|six|nine|twelve) months)\b|(?:\d+|fifty-(?:two|three))[- ]weeks? ended\b|(?:january|february|march|april|may|june|july|august|september|october|november|december)\b)/i;
const NUM_WORDS = { one: 1, three: 3, six: 6, nine: 9, twelve: 12 };

// Prefixes each year/date column with its group header. Groups are matched to columns by where the years restart
// (2023 2024 2025 | 2025 2026); with one fewer run than groups, the last group takes only the last column
// (2024 2025 | 2026 under "As of December 31," and "As of June 30,").
function labelPeriods(groups, periods) {
  const gs = groups.map((g) => g.replace(/[\s,:]+$/, '')).filter((g) => !/^\(?unaudited\)?$/i.test(g));
  if (!gs.length || !periods.length) return periods;
  const yearOf = (p) => Number(/\b((?:19|20)\d\d)\b/.exec(p)?.[1] || 0);
  const runs = [[0]];
  for (let i = 1; i < periods.length; i++) {
    if (yearOf(periods[i]) <= yearOf(periods[i - 1])) runs.push([i]);
    else runs[runs.length - 1].push(i);
  }
  const owner = new Array(periods.length);
  if (runs.length === gs.length) runs.forEach((run, g) => run.forEach((i) => { owner[i] = gs[g]; }));
  else if (runs.length === 1 && gs.length === 2 && periods.length >= 2) periods.forEach((_, i) => { owner[i] = i === periods.length - 1 ? gs[1] : gs[0]; });
  else if (gs.length === 1) periods.forEach((_, i) => { owner[i] = gs[0]; });
  else return periods;
  // a year-only cell takes the group's date; a full date keeps its own
  return periods.map((p, i) => (/[a-z]/i.test(p) && !/^\s*\d{4}\s*$/.test(p) ? `${owner[i]} | ${p}` : `${owner[i]} ${p.trim()}`));
}
const UNITS_RE = /\(?\s*(?:expressed\s+)?(?:in|US\$|\$)\s+(?:millions|thousands|billions)(?:\s+of\s+[a-z .]{1,40}?(?:dollars|euros|pounds))?(?:,?\s*except\s+[a-z ,]{1,60})?\)?/i;

const UNIT_PX = { pt: 1.33, px: 1, em: 16, in: 96 };
const toPx = (v) => {
  const m = /^(-?[\d.]+)\s*(pt|px|em|in)?$/i.exec(String(v).trim());
  return m ? parseFloat(m[1]) * (UNIT_PX[(m[2] || 'px').toLowerCase()] || 1) : 0;
};
// Left indent of a label cell, from its own style or the elements inside it: padding-left / margin-left /
// text-indent, or the left value of a "padding: top right bottom left" shorthand (Apollo's 10-K uses that)
function indentOf(html) {
  let px = 0;
  for (const m of html.matchAll(/(?:padding-left|margin-left|text-indent)\s*:\s*(-?[\d.]+\s*(?:pt|px|em|in)?)/gi)) px += Math.max(0, toPx(m[1]));
  for (const m of html.matchAll(/(?:^|[;"'\s])padding\s*:\s*([^;"']+)/gi)) {
    const parts = m[1].trim().split(/\s+/);
    const left = parts.length === 4 ? parts[3] : parts.length >= 2 ? parts[1] : parts[0];
    px += Math.max(0, toPx(left));
  }
  return px;
}

function parseDocumentTable(tableHtml) {
  const rows = [];
  const periodRows = [];
  const groups = [];
  const indents = [];
  const lead = [];
  for (const tr of rowsOf(tableHtml)) {
    const texts = cellsOf(tr).map((c) => ({ text: cellText(c.html), html: `<td ${c.attrs}>${c.html}` }));
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
    // Before the first line item: column-group headers ("Year Ended December 31," / "Six Months Ended June 30,")
    if (!rows.some((r) => !r.header) && cells.every((c) => GROUP_CELL.test(c.text) && !PERIOD_CELL.test(c.text.replace(/\b(?:19|20)\d\d\b/g, '')) ) && !cells.every((c) => /^\s*(?:19|20)\d\d\s*$/.test(c.text))) {
      const texts2 = cells.map((c) => c.text).filter((t) => !/^\(?unaudited\)?$/i.test(t));
      if (texts2.length) { groups.length = 0; groups.push(...texts2); }
      continue;
    }
    const labelled = !NUMERIC_CELL.test(cells[0].text) && !(cells.length > 1 && cells.every((c) => PERIOD_CELL.test(c.text)));
    if (!labelled) {
      // Before the first line item, a row of years or dates is the column header
      if (!rows.some((r) => !r.header) && cells.every((c) => PERIOD_CELL.test(c.text))) {
        periodRows.push(cells.map((c) => c.text));
        lead.push(...rows.map((r) => r.label));
        rows.length = 0;
        indents.length = 0;
      } else if (rows.some((r) => !r.header) && cells.every((c) => NUMERIC_CELL.test(c.text))) {
        // An unlabeled subtotal under a block of line items (the 10-K shows just the numbers)
        indents.push(0);
        rows.push({ label: '', values: cells.map((c) => clip(c.text, MAX_VALUE)), header: false, total: true, subtotal: true, level: 0 });
        if (rows.length >= MAX_ROWS) break;
      }
      continue;
    }
    const label = cells[0].text;
    // Page footers inside statement tables ("(Continued)", "See accompanying notes...") are not line items
    if (cells.length === 1 && /^\((?:continued|concluded)\)$|^see (?:the )?accompanying notes/i.test(label)) continue;
    const values = cells.slice(1).map((c) => clip(c.text, MAX_VALUE));
    // MD&A tables repeat the statement as "% of revenue" below the dollar rows: that part is not a statement
    if (rows.some((r) => !r.header) && values.length && values.every((v) => /%\)?$/.test(v))) break;
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
  const periods = periodRows.length ? periodRows[periodRows.length - 1] : [];
  return { rows, indents, lead, periods: groups.length ? labelPeriods(groups, periods) : periods };
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

// The statement heading a table must sit under to stand in for an R page
const HEADING_FOR = {
  balance: /balance sheets?|statements? of financial (?:condition|position)/i,
  income: /statements? of (?:consolidated )?(?:income|operations|earnings|comprehensive income)/i,
  cashflow: /statements? of (?:consolidated )?cash flows?/i,
};
const STATEMENT_TITLE = /(?:consolidated\s+)?(?:balance sheets?|statements? of financial (?:condition|position)|statements? of [a-z ]{0,40}?(?:income|operations|earnings|cash flows?))\b/gi;

// Real statements have date/year columns ("December 31, 2025"), unlike note tables ("Level 1", "Level 2", "NAV")
const hasPeriodColumns = (parsed) => parsed.periods.length >= 1 && parsed.periods.every((p) => PERIOD_CELL.test(p));

function textBefore(html, index, span) {
  let chunk = html.slice(Math.max(0, index - span), index);
  // the slice may start inside a tag; drop that partial tag
  const gt = chunk.indexOf('>');
  const lt = chunk.indexOf('<');
  if (gt !== -1 && (lt === -1 || gt < lt)) chunk = chunk.slice(gt + 1);
  return cellText(chunk);
}

function findTablesInDocument(html, wanted) {
  const found = {};
  const re = /<table\b[\s\S]*?<\/table>/gi;
  let m;
  let prev = null; // the previous statement-like table, for joining a "(Continued)" statement split across pages
  while ((m = re.exec(html)) !== null) {
    const raw = m[0];
    if (raw.length < 600) continue;
    const lower = raw.toLowerCase();
    // cheap pre-filter before the table is parsed
    if (!(lower.includes('total assets') || lower.includes('total liabilities') || lower.includes('operating activities') || lower.includes('investing activities') || lower.includes('financing activities') || lower.includes('net income') || lower.includes('net earnings') || lower.includes('net loss'))) continue;
    let parsed = parseDocumentTable(raw);
    const before = textBefore(html, m.index, 1200);

    // Parent-company-only schedules ("Schedule I — Condensed Financial Information of Registrant") are not the
    // consolidated statements, even though they carry the same titles
    if (/parent company only|condensed financial information of (?:the )?registrant|\bschedule i\b/i.test(before.slice(-600))) { prev = null; continue; }
    const titlesHere = [...before.slice(-400).matchAll(STATEMENT_TITLE)];
    const titleHere = titlesHere.length ? titlesHere[titlesHere.length - 1][0] : '';

    // A statement continued on the next page: "(Continued)" between the tables, or the next page repeats the same
    // statement heading (Apollo: "CONSOLIDATED STATEMENTS OF FINANCIAL CONDITION" on both pages)
    let heading = '';
    if (prev && m.index - prev.end < 60000) {
      const between = cellText(html.slice(prev.end, m.index));
      const sameHeading = titleHere && prev.heading && titleHere.toLowerCase() === prev.heading.toLowerCase();
      if (sameHeading || /\(?continued\)?/i.test(between) || /\(?continued\)?/i.test(cellText(raw.slice(0, 1500)))) {
        parsed = {
          rows: [...prev.parsed.rows, ...parsed.rows],
          indents: [...prev.parsed.indents, ...parsed.indents],
          lead: prev.parsed.lead,
          periods: prev.parsed.periods.length ? prev.parsed.periods : parsed.periods,
        };
        heading = prev.heading;
      }
    }
    if (!heading) heading = titleHere;
    const dataRows = parsed.rows.filter((r) => !r.header).length;
    if (hasPeriodColumns(parsed) && dataRows >= 5) prev = { parsed, heading, end: m.index + raw.length };
    else prev = null;
    if (dataRows < 8) continue;

    for (const key of signature(parsed.rows)) {
      if (!wanted.includes(key)) continue;
      const headingMatched = HEADING_FOR[key].test(heading);
      const periodsOk = hasPeriodColumns(parsed);
      // Rank: under the statement's own heading first, then real date columns, then the most line items
      // (MD&A holds condensed copies; notes hold fair-value tables with "Total assets" rows)
      // The statements themselves end with "The accompanying notes are an integral part..."; MD&A copies don't
      const footer = /accompanying notes/i.test(cellText(html.slice(m.index + raw.length, m.index + raw.length + 6000)).slice(0, 400));
      const rank = (headingMatched ? 4 : 0) + (/consolidated/i.test(heading) ? 2 : 0) + (periodsOk ? 1 : 0) + (footer ? 3 : 0);
      const cur = found[key];
      if (cur && (cur.rank > rank || (cur.rank === rank && cur.rowCount >= dataRows))) continue;
      const units = UNITS_RE.exec(parsed.lead.join('  '))?.[0] || UNITS_RE.exec(before.slice(-700))?.[0] || UNITS_RE.exec(cellText(raw.slice(0, 2500)))?.[0] || null;
      found[key] = { rowCount: dataRows, parsed, before, heading, units, rank, headingMatched, periodsOk };
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
        headingMatched: t.headingMatched,
        periodsOk: t.periodsOk,
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

// SEC's R page re-orders a statement when the company reports it by segment or with other XBRL dimensions
// (consolidated rows first, then blocks labelled like "Asset Management | VIE, Primary Beneficiary"), so it no
// longer matches the 10-K. Signs: "|" in labels, or the same section header ("Assets", "Liabilities") repeated.
export function isDimensionalPage(page) {
  if (!page?.rows?.length) return false;
  if (page.rows.some((r) => / \| /.test(r.label))) return true;
  const seen = new Set();
  for (const r of page.rows) {
    if (!r.header) continue;
    const k = r.label.toLowerCase().replace(/[:\s]+$/, '');
    if (seen.has(k)) return true;
    seen.add(k);
  }
  return false;
}

// A document table is only used in place of an R page when it sits under the statement's own heading, has
// date columns and looks complete; otherwise SEC's (re-ordered but correct) R page is kept
function plausibleDocTable(page) {
  const dataRows = page?.rows?.filter((r) => !r.header && r.values?.some((v) => v !== '')) || [];
  return page.headingMatched === true && page.periodsOk === true && dataRows.length >= 8 && dataRows.some((r) => r.total);
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

  // Segment-split R pages: try the statement table in the 10-K document itself, so the layout matches the filing
  const dimensional = STATEMENT_KEYS.filter((k) => statements[k] && isDimensionalPage(statements[k]));
  if (dimensional.length) {
    try {
      const fromDoc = await statementsFromDocuments(filing, dimensional);
      for (const [key, page] of Object.entries(fromDoc)) {
        if (plausibleDocTable(page)) statements[key] = { ...finish(key, page, 'document', filing), replacedSegmentView: true };
      }
    } catch (err) {
      console.error('document statements (segment layout) failed:', err);
    }
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
  const periods = statement.periods || [];
  // An interim column (a balance at June 30 next to December 31 years) is not a fiscal-year column: any dated
  // column more than 3 weeks of the calendar away from the first column's month-day is left out
  const mdOf = (p) => { const d = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:19|20)\d\d/.exec(p); return d && MONTHS[d[1].toLowerCase()] !== undefined ? MONTHS[d[1].toLowerCase()] * 30.5 + Number(d[2]) : null; };
  const ref = periods.map(mdOf).find((v) => v !== null);
  return periods.map((p) => {
    const months = /(\d+|one|three|six|nine|twelve)[- ]months?\s+ended/i.exec(p);
    if (months && (NUM_WORDS[months[1].toLowerCase()] ?? Number(months[1])) !== 12) return null;
    const md = mdOf(p);
    if (md !== null && ref !== undefined && ref !== null) { const gap = Math.abs(md - ref); if (Math.min(gap, 366 - gap) > 21) return null; }
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
const CAPITAL_LINE = /\b(?:property|plant|equipment|fixed assets?|capital expenditures?|capital spending|capital improvements?|leasehold|software|technology|patents?|intangibles?|trademarks?|licen[cs]es?|buildings?|land|furniture|vehicles|machinery|improvements?|mineral (?:properties|interests)|oil and gas properties|development costs?|capitalized|vessels?|aircraft|under construction|construction in progress)\b/i;
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
  const investing = investingSection(cf.rows);
  const lines = investing.filter((r) => CAPITAL_LINE.test(r.label) && !NOT_CAPITAL_LINE.test(r.label));
  if (!lines.length) {
    // A real investing section (3+ lines with amounts) and not one property/equipment line: the company reports no capex.
    // buildMetrics only uses this when no capex tag or component exists in any year.
    const withAmounts = investing.filter((r) => r.values.some((v) => parseAmount(v) !== null));
    if (withAmounts.length >= 3) out.noCapitalLines = { years: years.filter((y) => y !== null), lineCount: withAmounts.length };
    return out;
  }
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

// ---------- Figures derived from the as-filed income statement ----------
// Fixed label rules (not tuned to any company). They only run for years where no XBRL tag supplies the figure.

// Direct operating lines. Depreciation, management fees, G&A, impairments and gains are never cost of revenue.
const COST_LINE = /\bcommissions?\b|voyage expenses?|vessel operating expenses?|dry-?\s?dock/i;
const COST_EXCLUDE = /depreciation|amortization|management fees?|general and administrative|\bgains?\b|impairment|revenues?\b/i;
// G&A plus management fees (related-party fees included)
const SGA_LINE = /general and administrative|management fees?/i;
const SGA_EXCLUDE = /\bgains?\b|impairment|depreciation|amortization/i;
// A subtotal that is already net of commissions. Commissions listed above it are not deducted a second time.
const NET_REVENUE_ROW = /^(?:total )?net (?:revenues?|sales)\b|^(?:total )?revenues?,? net\b/i;
// Whole-statement totals (exact labels only)
const TOTAL_REVENUE_ROW = /^total (?:net )?revenues?(?:,? net)?$/i;
const TOTAL_EXPENSE_ROW = /^total (?:costs and |operating costs and |benefits and )?expenses$/i;
const GAIN_WORD = /\bgains?\b/i;
const LOSS_WORD = /\bloss(?:es)?\b/i;
const SALE_WORD = /\b(?:sale|sales|disposal|disposals|disposition|disposed)\b/i;
const CF_GAIN_EXCLUDE = /currency|translation|exchange|unrealized|derivative|hedg|extinguish|equity (?:income|method)|equity \(income\)|pension|fair value|impairment|investment securities/i;

// Map(fiscalYear -> { cost?, sga?, gain? }), each { value, lines: [{ label, amount }], skipped?: [...] } in currency units.
// cost: positive total of direct operating lines. sga: positive total. gain: positive gain / negative loss on asset sales
// (rows with both words, like "gain/(loss) on sale", are skipped because their sign cannot be told from the label).
export function incomeFromStatement(income) {
  const out = new Map();
  const scale = unitScale(income?.units);
  if (!income || scale === null) return out;
  const years = columnYears(income);
  const rows = income.rows;
  const netRevenueAt = rows.findIndex((r) => !r.header && NET_REVENUE_ROW.test(r.label));
  const isLine = (r) => !r.header && !r.total;

  const costRows = rows.map((r, idx) => ({ r, idx })).filter(({ r }) => isLine(r) && COST_LINE.test(r.label) && !COST_EXCLUDE.test(r.label));
  // Lines above the total revenues row are revenue (an asset manager's "Management fees" is income, not SG&A)
  const totalRevAt = rows.findIndex((r) => !r.header && TOTAL_REVENUE_ROW.test(r.label.trim()));
  const sgaRows = rows.filter((r, idx) => isLine(r) && idx > totalRevAt && SGA_LINE.test(r.label) && !SGA_EXCLUDE.test(r.label));
  const gainRows = rows.filter((r) => isLine(r) && SALE_WORD.test(r.label) && (GAIN_WORD.test(r.label) !== LOSS_WORD.test(r.label)));

  years.forEach((fy, col) => {
    if (fy === null) return;
    const entry = {};
    const amount = (r) => { const v = parseAmount(r.values[col]); return v === null ? null : v * scale; };

    const used = [];
    const skipped = [];
    for (const { r, idx } of costRows) {
      const v = amount(r);
      if (v === null) continue;
      const line = { label: r.label, amount: Math.abs(v) };
      if (/\bcommissions?\b/i.test(r.label) && netRevenueAt >= 0 && idx < netRevenueAt) skipped.push(line);
      else used.push(line);
    }
    if (used.length) entry.cost = { value: used.reduce((s, l) => s + l.amount, 0), lines: used, skipped };

    const sgaUsed = [];
    for (const r of sgaRows) {
      const v = amount(r);
      if (v !== null) sgaUsed.push({ label: r.label, amount: Math.abs(v) });
    }
    if (sgaUsed.length) entry.sga = { value: sgaUsed.reduce((s, l) => s + l.amount, 0), lines: sgaUsed };

    const gainUsed = [];
    for (const r of gainRows) {
      const v = amount(r);
      if (v === null || v === 0) continue;
      gainUsed.push({ label: r.label, amount: GAIN_WORD.test(r.label) ? Math.abs(v) : -Math.abs(v) });
    }
    if (gainUsed.length) entry.gain = { value: gainUsed.reduce((s, l) => s + l.amount, 0), lines: gainUsed };

    // Total revenues and total expenses, for operating income when no operating income tag exists (financial filers)
    const revRow = rows.find((r) => !r.header && TOTAL_REVENUE_ROW.test(r.label.trim()));
    const expRow = rows.find((r) => !r.header && TOTAL_EXPENSE_ROW.test(r.label.trim()));
    const rev = revRow ? amount(revRow) : null;
    const exp = expRow ? amount(expRow) : null;
    if (rev !== null && exp !== null) {
      entry.opIncome = { value: rev - Math.abs(exp), lines: [{ label: revRow.label, amount: rev }, { label: expRow.label, amount: Math.abs(exp) }] };
    }

    if (Object.keys(entry).length) out.set(fy, entry);
  });
  return out;
}

// Evidence used to confirm a tag-based gain/loss on asset sales. Map(fiscalYear -> { income?, cashflow? }), each
// { value (positive gain / negative loss, currency units), lines: [{ label, amount }] } with the amounts signed as a gain (+) or loss (-).
//  - Income statement: a row labeled as a gain or loss on sale/disposal. A one-word label (gain OR loss) fixes the sign;
//    a "gain/(loss)" label takes the sign the row shows, since an income statement row shows its effect on income.
//  - Cash flow reconciliation (operating section): a gain row is a NEGATIVE adjustment and a loss row a POSITIVE one, so
//    the gain is the negated cash flow value whatever the label says.
export function gainEvidenceFromStatements(income, cashflow) {
  const out = new Map();
  const put = (fy, kind, lines) => {
    if (!lines.length) return;
    const e = out.get(fy) || {};
    e[kind] = { value: lines.reduce((s, l) => s + l.amount, 0), lines };
    out.set(fy, e);
  };
  const labeled = (r) => !r.header && !r.total && SALE_WORD.test(r.label) && (GAIN_WORD.test(r.label) || LOSS_WORD.test(r.label));

  const iScale = unitScale(income?.units);
  if (income && iScale !== null) {
    const rows = income.rows.filter(labeled);
    columnYears(income).forEach((fy, col) => {
      if (fy === null) return;
      const lines = [];
      for (const r of rows) {
        const raw = parseAmount(r.values[col]);
        if (raw === null || raw === 0) continue;
        const g = GAIN_WORD.test(r.label), l = LOSS_WORD.test(r.label);
        lines.push({ label: r.label, amount: (g && l ? raw : g ? Math.abs(raw) : -Math.abs(raw)) * iScale });
      }
      put(fy, 'income', lines);
    });
  }

  const cScale = unitScale(cashflow?.units);
  if (cashflow && cScale !== null) {
    const end = cashflow.rows.findIndex((r) => !r.header && /operating activities/i.test(r.label) && /^(?:net )?cash|total/i.test(r.label));
    // Reconciliation rows are often labeled just "(gains) losses, net", so a sale/disposal word is not required here:
    // the 1% amount match and the sign test do the identifying. Currency, equity-method, fair-value and similar lines are left out.
    const rows = (end < 0 ? cashflow.rows : cashflow.rows.slice(0, end))
      .filter((r) => !r.header && !r.total && (GAIN_WORD.test(r.label) || LOSS_WORD.test(r.label)) && !CF_GAIN_EXCLUDE.test(r.label));
    columnYears(cashflow).forEach((fy, col) => {
      if (fy === null) return;
      const lines = [];
      for (const r of rows) {
        const raw = parseAmount(r.values[col]);
        if (raw === null || raw === 0) continue;
        lines.push({ label: r.label, amount: -raw * cScale });
      }
      put(fy, 'cashflow', lines);
    });
  }
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

// ---------- IPO prospectus (S-1 / 424B4): numbers read from the as-filed statements ----------
// A registration statement for an IPO carries no XBRL, so SEC has no companyfacts for the company until its first
// periodic report. These helpers turn the prospectus's own statement tables into the same facts shape buildMetrics
// reads, by fixed label rules (not tuned to any company). Only lines whose label clearly names the figure are used.

const clean = (label) => String(label || '').replace(/\s*\(\d\)\s*$/g, '').replace(/[’']/g, "'").trim();
const PROSPECTUS_LINES = {
  income: [
    ['Revenues', /^(?:total )?(?:net )?(?:revenues?|sales)(?:,? net)?$/i],
    ['CostOfRevenue', /^(?:total )?cost of (?:revenues?|sales|goods sold)$/i],
    ['GrossProfit', /^gross (?:profit|margin)(?: \((?:loss|profit)\))?$/i],
    ['SellingGeneralAndAdministrativeExpense', /^(?:total )?selling, general,? and administrative(?: expenses?)?$/i],
    ['ResearchAndDevelopmentExpense', /^research and development(?: expenses?)?$/i],
    ['CostsAndExpenses', /^total (?:operating )?(?:costs and )?expenses$/i],
    ['OperatingIncomeLoss', /^(?:total )?(?:operating (?:income|loss|profit)(?: \((?:loss|income)\))?|(?:income|loss)(?: \((?:loss|income)\))? from operations)$/i],
    ['InterestExpense', /^interest expense(?:, net)?$/i],
    ['NetIncomeLoss', /^net (?:income|loss|earnings)(?: \((?:loss|income)\))?$/i],
    ['EarningsPerShareDiluted', /per share.*diluted|diluted.*per share/i, 'perShare'],
    ['WeightedAverageNumberOfDilutedSharesOutstanding', /^weighted[- ]average.*diluted/i, 'shares'],
  ],
  balance: [
    ['CashAndCashEquivalentsAtCarryingValue', /^cash and cash equivalents$/i],
    ['ShortTermInvestments', /^short-term investments$/i],
    ['AccountsReceivableNetCurrent', /^accounts receivable(?:, net)?$/i],
    ['AssetsCurrent', /^total current assets$/i],
    ['Assets', /^total assets$/i],
    ['LiabilitiesCurrent', /^total current liabilities$/i],
    ['Liabilities', /^total liabilities$/i],
    ['StockholdersEquity', /^total (?:stockholders|shareholders)'? ?(?:equity|deficit|\(deficit\) equity|equity \(deficit\))$/i],
    ['RetainedEarningsAccumulatedDeficit', /^(?:retained earnings(?: \(accumulated deficit\))?|accumulated deficit)$/i],
    ['LongTermDebtNoncurrent', /^(?:long-term debt|term loans?|(?:senior )?notes payable)(?:, net)?(?:, (?:noncurrent|non-current|net of current portion|less current portion))?$/i],
    ['LongTermDebtCurrent', /^(?:current portion of long-term debt|short-term (?:debt|borrowings))$/i],
    // Convertible notes: only recorded as "debt exists"; they are not counted as long-term debt (see the note)
    ['ConvertibleNotesPayable', /convertible (?:promissory )?notes? payable|^convertible debt/i],
  ],
  cashflow: [
    ['NetCashProvidedByUsedInOperatingActivities', /^net cash (?:provided by|used in|provided by \(used in\)|\(used in\) provided by|used in \(provided by\)) operating activities$/i],
    ['PaymentsToAcquirePropertyPlantAndEquipment', /^(?:purchases? of|payments for|capital expenditures for) property(?:,| and) (?:plant,? and )?equipment$|^capital expenditures$/i, 'abs'],
    ['DepreciationDepletionAndAmortization', /^depreciation(?: and amortization)?$/i, 'abs'],
  ],
};

// Share counts are often stated in thousands while dollars are in millions ("except share amounts which are in thousands")
function shareScaleOf(units) {
  const u = String(units || '').toLowerCase();
  const m = /shares?(?: amounts)?(?: which are| are)? in (thousands|millions)/.exec(u);
  return m ? (m[1] === 'thousands' ? 1e3 : 1e6) : 1;
}

function columnEnd(period, fy) {
  const d = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+((?:19|20)\d\d)/.exec(period || '');
  if (d && MONTHS[d[1].toLowerCase()] !== undefined) return `${d[3]}-${String(MONTHS[d[1].toLowerCase()] + 1).padStart(2, '0')}-${d[2].padStart(2, '0')}`;
  return `${fy}-12-31`;
}

// companyfacts-shaped object from the prospectus statements (fiscal-year columns only)
export function factsFromStatements(statements, { filed, entityName } = {}) {
  const facts = {};
  const add = (tag, unit, fact) => {
    facts[tag] = facts[tag] || { label: tag, units: {} };
    (facts[tag].units[unit] = facts[tag].units[unit] || []).push(fact);
  };
  for (const key of ['income', 'balance', 'cashflow']) {
    const st = statements[key];
    const scale = unitScale(st?.units);
    if (!st || scale === null) continue;
    const years = columnYears(st);
    const shareScale = shareScaleOf(st.units);
    for (const [tag, re, kind] of PROSPECTUS_LINES[key]) {
      const row = st.rows.find((r) => !r.header && r.values?.length && re.test(clean(r.label)));
      if (!row) continue;
      years.forEach((fy, col) => {
        if (fy === null) return;
        let v = parseAmount(row.values[col]);
        if (v === null) return;
        if (kind === 'perShare') { /* dollars per share as filed */ } else if (kind === 'shares') v *= shareScale; else v *= scale;
        if (kind === 'abs') v = Math.abs(v);
        const end = columnEnd(st.periods[col], fy);
        const start = new Date(Date.parse(`${end}T00:00:00Z`) - 364 * 86400000).toISOString().slice(0, 10);
        const fact = { val: v, end, fy, fp: 'FY', form: '10-K', filed: filed || end };
        if (key !== 'balance') fact.start = start;
        add(tag, kind === 'perShare' ? 'USD/shares' : kind === 'shares' ? 'shares' : 'USD', fact);
      });
    }
  }
  return { entityName, facts: { 'us-gaap': facts }, synthetic: true };
}

// Columns that are not fiscal years (six months ended June 30, a June 30 balance): the latest interim picture
export function interimFromStatements(statements) {
  const pick = (st, re, col, kind) => {
    const row = st?.rows.find((r) => !r.header && r.values?.length && re.test(clean(r.label)));
    const v = row ? parseAmount(row.values[col]) : null;
    if (v === null) return null;
    const scale = kind === 'perShare' ? 1 : kind === 'shares' ? shareScaleOf(st.units) : unitScale(st.units);
    return scale === null ? null : v * scale;
  };
  const lines = Object.fromEntries(Object.entries(PROSPECTUS_LINES).map(([k, list]) => [k, Object.fromEntries(list.map(([tag, re, kind]) => [tag, { re, kind }]))]));
  const columns = [];
  for (const key of ['income', 'cashflow']) {
    const st = statements[key];
    if (!st) continue;
    columnYears(st).forEach((fy, col) => {
      if (fy !== null) return;
      const label = st.periods[col];
      let c = columns.find((x) => x.label === label);
      if (!c) { c = { label }; columns.push(c); }
      for (const [tag, { re, kind }] of Object.entries(lines[key])) {
        const v = pick(st, re, col, kind);
        if (v !== null) c[tag] = kind === 'abs' ? Math.abs(v) : v;
      }
    });
  }
  for (const c of columns) {
    const ocf = c.NetCashProvidedByUsedInOperatingActivities;
    const capex = c.PaymentsToAcquirePropertyPlantAndEquipment;
    if (Number.isFinite(ocf) && Number.isFinite(capex)) c.fcf = ocf - capex;
  }
  let balance = null;
  const bs = statements.balance;
  if (bs) {
    const col = columnYears(bs).findIndex((fy) => fy === null);
    if (col >= 0) {
      balance = { label: bs.periods[col] };
      for (const [tag, { re, kind }] of Object.entries(lines.balance)) {
        const v = pick(bs, re, col, kind);
        if (v !== null) balance[tag] = v;
      }
    }
  }
  return columns.length || balance ? { columns, balance } : null;
}

// Operating expenses as filed, when the company groups costs by nature (no cost of revenue line):
// every line between revenue and total operating expenses, per column
export function expenseLinesFromStatement(income) {
  if (!income) return null;
  const scale = unitScale(income.units);
  if (scale === null) return null;
  const rows = income.rows;
  if (rows.some((r) => /^(?:total )?cost of (?:revenues?|sales|goods sold)/i.test(clean(r.label)))) return null;
  const revAt = rows.findIndex((r) => !r.header && PROSPECTUS_LINES.income[0][1].test(clean(r.label)));
  const endAt = rows.findIndex((r, i) => i > revAt && !r.header && (/^total (?:operating )?(?:costs and )?expenses$/i.test(clean(r.label)) || PROSPECTUS_LINES.income[6][1].test(clean(r.label))));
  if (revAt < 0 || endAt < 0) return null;
  const amounts = (r) => r.values.map((v) => { const n = parseAmount(v); return n === null ? null : n * scale; });
  const lines = rows.slice(revAt + 1, endAt).filter((r) => !r.header && r.values?.length).map((r) => ({ label: clean(r.label), values: amounts(r) }));
  if (lines.length < 2) return null;
  return { periods: income.periods, years: columnYears(income), revenue: amounts(rows[revAt]), total: amounts(rows[endAt]), totalLabel: clean(rows[endAt].label), lines };
}
