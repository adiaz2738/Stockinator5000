# ValueLens — Project Roadmap & Full Context

---

## What This Is

A personal investment research web app built for a value investing workflow inspired by Warren Buffett and Mary Buffett's *The Interpretation of Financial Statements*. The goal is to replace the friction of spreadsheets and paywalled data sites with a clean, purpose-built tool that matches an existing budget tracker's design system.

This is a research tool — no payments flow through it. It is initially single-user (the builder), with optional multi-user support later.

---

## Core Philosophy

- **Buffett-style value investing**: moat analysis, consistent earnings, low debt, high margins, DCF-based intrinsic value
- **Learning as you build**: the app should make the math visible and educational, not just produce an answer
- **Replaces**: Excel/Google Sheets for DCF calculations, Morningstar/Macrotrends for historical data, Finviz for screening (screening across companies is still ahead)
- **Compounding investment**: building the tool reinforces what's being learned about investing
- **Never fabricate a number**: if a figure can't be found in the source data, the app shows N/A. AI-written text is always labeled as AI-generated and separated into fact vs. interpretation

---

## User Context

- One weekly investing block: Wednesday ~10:30am–12:30pm (1.5–2 hours)
- ADHD — needs clear session goals, not open-ended exploration
- Existing design system: Financinator 5000 (dark navy/blue/green finance dashboard)
- Stack familiarity: Claude Code, Neon (Postgres), Vercel, vanilla JS or lightweight frontend
- Note-taking: Notion (primary), Obsidian (secondary)
- Brokerage platforms (TD Ameritrade, Fidelity) handle live pricing — this app does not need to replicate that

---

## Status

| Area | State |
|---|---|
| **Phase 1 — DCF Calculator** | **Done.** Calculator, step-by-step breakdown, saved valuations (Neon), FMP ticker auto-fill for company name, logo/branding |
| **Filings tab** (was Phase 2/3) | **Done.** SEC EDGAR XBRL data, 10-year metrics table, screener scorecard, trend charts, Send to Calculator, Neon cache |
| **Story sub-tab** | **Done.** AI narrative from the latest annual filing, access-key protected |
| Auth | Not built. Single user via a shared access key and a hardcoded `'local'` user_id |
| Cross-company screener | Not built (see Next Up) |

### Phase 1 — DCF Calculator (done)

- Input form: Ticker, Company Name, FCF/Share, Growth Rate Y1–5, Growth Rate Y6–10, Discount Rate, Terminal Growth Rate, Margin of Safety %, optional market price
- Live output: Intrinsic Value Per Share, Margin of Safety Price, Verdict (Undervalued / Overvalued / Fairly Valued)
- Step-by-step breakdown: year-by-year projected cash flows, discount factors, present values, terminal value
- Save every valuation to Neon with inputs, outputs, notes, and timestamp
- Saved Valuations page: sortable table, reload into calculator, delete with 5s undo
- Ticker blur auto-fills the company name via FMP (free tier, `/api/ticker`)

### Filings tab (done)

Free, server-side data from SEC EDGAR's XBRL `companyfacts` API. Entirely separate from the calculator, except for one hand-off.

- **Input:** a ticker or a pasted EDGAR URL, validated server-side. Tickers map to a CIK through SEC's `company_tickers.json`
- **Extraction (`api/sec.js`):** `us-gaap` and `ifrs-full` taxonomies, annual forms only (10-K, 40-F, 20-F), deduped by fiscal year keeping the latest filing. Each metric uses an ordered fallback list of tag names, merged per year so companies that changed tags mid-decade still get a full series. Anything not found is `null` and shown as N/A
- **Metrics:** revenue, cost of revenue, gross profit, SG&A, R&D, depreciation, operating income, interest expense, net income, diluted EPS and shares, current assets/liabilities, total liabilities, equity, long-term debt, retained earnings, net receivables, operating cash flow, capex
- **Derived per year:** gross margin, net margin, SG&A % of gross profit, interest % of operating income, debt-to-equity (total liabilities / equity), long-term debt vs. years of earnings, current ratio, ROE, FCF, FCF/share, EPS growth. Also a 10-year FCF CAGR used as a suggested growth input
- **Screener scorecard:** each core rule shows the latest value, a PASS / FAIL / N/A pill, and how many of the last 10 years passed. Optional rules (ROE, current ratio, retained earnings) sit in a secondary section
- **10-year table** with sticky first column, and gradient-area SVG **trend charts** for gross margin, net margin, EPS, FCF/share, and D/E
- **Send to Calculator:** passes ticker, company name, latest FCF/share, and the suggested growth rate through `sessionStorage`; the calculator pre-fills them (still editable) and does not auto-calculate
- **Cache:** `company_financials` in Neon, reused for 7 days. A Refresh button forces a refetch (limited to once per minute per company to protect SEC's rate limit)
- **Etiquette:** every SEC request carries the `SEC_USER_AGENT` header and is throttled to roughly 5 requests/second

### Story sub-tab (done)

An AI-written narrative of the business, generated from the latest annual filing text plus the stored metrics.

- **Filing text extraction:** finds the most recent 10-K / 40-F / 20-F via SEC's submissions API. For 10-Ks it pulls Item 1, Item 1A, Item 7, and the segment/concentration note. For 40-F/20-F filers, where the main document is a wrapper, it reads the EX-99/EX-13 exhibits and matches heading keywords. Each section is length-capped and flagged truncated; sections it can't find are reported as missing, never guessed
- **Nine sections**, each item tagged with its source (e.g. "Item 1A", "MD&A", "Metrics") and labeled fact or interpretation: business summary, revenue sources, where the money goes, capital management, moat assessment, screener context, top risks, red flags, questions to research
- **Per-section generation** driven from the client with a progress indicator, so no single serverless call approaches the timeout. The shared filing text is sent as an **Anthropic prompt-cached** block, so after the first call each section only pays full price for its own instruction
- **Guardrails:** filing text is treated as untrusted data in the system prompt; the model may use only the supplied metrics and text, writes "Not disclosed in the provided sections" when something is missing, and gives no buy/sell recommendation. All output is rendered with `textContent`
- **Cache:** `company_narratives` in Neon. A story is reused until a newer filing appears or Regenerate is clicked
- **Protection:** requests need an `x-access-key` header matching `APP_ACCESS_KEY`, and generations are capped per day (default 5, set with `DAILY_STORY_LIMIT`; tracked in `narrative_usage`)

---

## Data Strategy

**SEC EDGAR is the free primary source for fundamentals.** It provides 10+ years of annual history and covers foreign filers (40-F / 20-F, IFRS) that free price-data APIs usually skip. It needs no key, only a descriptive User-Agent.

**FMP free tier is now used only for ticker lookups** (company-name auto-fill in the calculator). Fundamentals no longer depend on it.

**FMP paid (~$20/mo) is an optional later upgrade**, not a prerequisite. It would buy cleaner, normalized data and faster screening across many tickers. Alpha Vantage remains the wrong fit (thin fundamentals; better for price streaming, which this app doesn't need).

### Known EDGAR limitations

- **Per-share-class companies** (e.g. Visa) report EPS and diluted shares per class; the `companyfacts` API omits those dimensional facts, so EPS, EPS growth, and FCF/share come back N/A. Send to Calculator then has no FCF/share to pass
- **IFRS filers** (e.g. Barrick) usually lack SG&A and R&D lines, and often operating income, which makes the SG&A and interest-coverage rules N/A
- **Companies that don't tag a line** show N/A for it (e.g. Coca-Cola has no total liabilities, so D/E is N/A; Visa has no cost of revenue, so gross margin is N/A). Gross profit is computed as revenue minus cost of revenue only when the reported figure is absent and both inputs exist
- **Tag fallbacks are heuristic.** The ordered tag lists cover common cases but can miss a company's idiosyncratic tag or, rarely, pick a near-synonym
- **Fiscal-year labels** use the year of the period end (shifted 20 days so 52/53-week years land correctly), so retailers with January year-ends are labeled by that January's year
- **Filing text extraction is heuristic.** 10-K sections are located by "Item N" headings; 40-F/20-F exhibits have no clean section boundaries, so those sections run from the best heading to the length cap and may include neighboring topics (the Story prompt tells the model to stay within each section's subject)

---

## Next Up

In this order:

### 1. Clerk auth

- Replace the shared access key and the hardcoded `'local'` user_id with Clerk
- Sign-ups locked to the owner's email
- Derive `user_id` from the verified session server-side, never from the client
- Migrate existing rows (`valuations`, `company_financials`, `company_narratives`, `narrative_usage`) from `'local'` to the real user id
- Before opening to anyone else: run the IDOR test from the security checklist

### 2. News-context section ("why is the stock moving")

- A section that summarizes recent news around a ticker
- Clearly labeled as separate from filing data, with its own sources and dates, so news context is never mistaken for facts from the filing

### 3. In-app AI chat

- Ask questions about a company inside the app
- Reuses the stored metrics and narratives as context instead of re-fetching, keeping cost and latency low

### 4. Metric refinements

- **Attributable FCF** after minority interests
- **Non-recurring gain adjustment** (e.g. gains on asset sales) when judging earnings consistency
- **Derived operating income for IFRS filers** where it isn't reported
- **FCF/share from cover-page share counts** (the `dei` share count), to fill the gap for per-share-class companies like Visa
- **Debt-to-equity on attributable equity** rather than total equity including non-controlling interests

### 5. Screener across cached companies

- Run the core and optional rules across every company already in `company_financials`
- Filter panel with a toggle and threshold per rule; results table with the metric values and Pass/Fail per rule
- Click any ticker to open it in Filings or send it to the calculator

---

## Later / Optional

- **User-written moat notes** per company, saved to the DB (the Story tab's moat assessment is AI-generated; personal notes are not built)
- **Public access (formerly Phase 4):** a public calculator with no login and no save, plus saved valuations and notes for logged-in users, on top of the Clerk work above. Ties into the personal finance website concept (separate project)
- **FMP paid upgrade** if EDGAR's coverage or speed becomes the bottleneck for screening

---

## Data Model (Neon / Postgres)

All tables carry a `user_id`. Today it is the constant `'local'`, set server-side and never read from the client; it becomes the Clerk-derived id with the auth work above.

```sql
-- Saved DCF valuations
CREATE TABLE valuations (
  id            SERIAL PRIMARY KEY,
  user_id       TEXT NOT NULL DEFAULT 'local',  -- server-derived, never client-supplied
  ticker        TEXT NOT NULL,
  company_name  TEXT,
  fcf_per_share NUMERIC NOT NULL,
  growth_rate_1_5   NUMERIC NOT NULL,
  growth_rate_6_10  NUMERIC NOT NULL,
  discount_rate     NUMERIC NOT NULL,
  terminal_growth   NUMERIC NOT NULL,
  margin_of_safety  NUMERIC NOT NULL,
  intrinsic_value   NUMERIC NOT NULL,
  safety_price      NUMERIC NOT NULL,
  market_price      NUMERIC,
  verdict           TEXT,                       -- 'UNDERVALUED' | 'OVERVALUED' | 'FAIRLY VALUED'
  notes             TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Cached SEC EDGAR metrics (Filings tab). Reused for 7 days.
CREATE TABLE company_financials (
  id           SERIAL PRIMARY KEY,
  user_id      TEXT NOT NULL DEFAULT 'local',
  cik          TEXT NOT NULL,                   -- zero-padded to 10 digits
  ticker       TEXT,
  company_name TEXT,
  taxonomy     TEXT,                            -- 'us-gaap' | 'ifrs-full'
  metrics      JSONB NOT NULL,                  -- years, raw series, derived ratios, FCF CAGR, coverage
  fetched_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, cik)
);

-- AI narratives (Story sub-tab). One row per company per annual filing.
CREATE TABLE company_narratives (
  id         SERIAL PRIMARY KEY,
  user_id    TEXT NOT NULL DEFAULT 'local',
  cik        TEXT NOT NULL,
  accession  TEXT NOT NULL,                     -- the filing the story was written from
  model      TEXT,
  narrative  JSONB NOT NULL,                    -- status, meta, extracted source text, per-section output
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, cik, accession)
);

-- Daily cap on story generations (default 5/day, DAILY_STORY_LIMIT)
CREATE TABLE narrative_usage (
  user_id TEXT NOT NULL,
  day     DATE NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- Row-level: always filter WHERE user_id = $1 using the server-derived value.
-- The three new tables are created on first request, matching how `valuations` is created.
```

---

## Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend | Vanilla JS (ES modules) | Matches Financinator 5000 patterns; all user and model text rendered via `textContent` |
| Hosting | Vercel | Serverless `api/` routes; `api/narrative.js` has `maxDuration` 300 |
| Database | Neon (Postgres) | Free tier, more projects than Supabase |
| Auth | Shared access key (Story only) for now | **Clerk (planned)** replaces it, with sign-ups locked to the owner's email |
| Fundamentals data | SEC EDGAR (XBRL `companyfacts`, submissions, filing documents) | Free, no key; needs `SEC_USER_AGENT`; throttled to ~5 req/s |
| AI | Anthropic API (Messages) | Default model `claude-sonnet-5-5`, overridable via `ANTHROPIC_MODEL`; prompt caching on the shared filing text |
| Ticker lookup | FMP free tier | Company-name auto-fill only. Paid tier is an optional later upgrade |
| Design system | Financinator 5000 tokens | Exact hex values, same fonts |

Environment variables (server-side only, never in frontend JS): `NEON_DATABASE_URL`, `FMP_API_KEY`, `SEC_USER_AGENT`, `ANTHROPIC_API_KEY`, `APP_ACCESS_KEY`, optional `ANTHROPIC_MODEL` and `DAILY_STORY_LIMIT` (default 5).

---

## Build Order

Done:

1. DCF Calculator (frontend only) — Phase 1a
2. Neon DB + save/load valuations — Phase 1b
3. FMP ticker auto-fill and branding
4. Filings tab: SEC EDGAR metrics, scorecard, charts, Send to Calculator
5. Story sub-tab: filing text extraction, then per-section AI generation

Next (see Next Up above):

6. Clerk auth
7. News-context section
8. In-app AI chat
9. Metric refinements
10. Screener across cached companies

---

## Wednesday Study Session Integration

Each Wednesday block should end with either:
- A new saved valuation in the app (applied learning), or
- A screener run that surfaces a candidate stock for next week

The app and the study plan should compound: studying a company → loading it in Filings and reading its Story → checking the scorecard → valuing it in the calculator → saving the verdict creates a repeatable research loop. Once the cross-company screener exists, it becomes the candidate-finding step at the front of that loop.

---

## What This Does NOT Do

- Live stock price streaming (user has TD Ameritrade and Fidelity for that)
- Handle payment information of any kind
- Replace brokerage platforms
- Auto-trade or make buy/sell decisions — the AI Story is explicitly instructed to give no buy/sell recommendation, and every Story carries an "AI-generated from SEC filings. Verify against the filing. Not financial advice." disclaimer
