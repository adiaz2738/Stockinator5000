# ValueLens — Project Roadmap & Full Context

---

## What This Is

A personal investment research web app built for a value investing workflow inspired by Warren Buffett and Mary Buffett's *The Interpretation of Financial Statements*. The goal is to replace the friction of spreadsheets and paywalled data sites with a clean, purpose-built tool that matches an existing budget tracker's design system.

This is a research tool — no payments flow through it. It is initially single-user (the builder), with optional multi-user support later.

---

## Core Philosophy

- **Buffett-style value investing**: moat analysis, consistent earnings, low debt, high margins, DCF-based intrinsic value
- **Learning as you build**: the app should make the math visible and educational, not just produce an answer
- **Replaces**: Excel/Google Sheets for DCF calculations, Morningstar/Macrotrends for historical data (eventually), Finviz for screening (eventually)
- **Compounding investment**: building the tool reinforces what's being learned about investing

---

## User Context

- One weekly investing block: Wednesday ~10:30am–12:30pm (1.5–2 hours)
- ADHD — needs clear session goals, not open-ended exploration
- Existing design system: Financinator 5000 (dark navy/blue/green finance dashboard)
- Stack familiarity: Claude Code, Neon (Postgres), Vercel, vanilla JS or lightweight frontend
- Note-taking: Notion (primary), Obsidian (secondary)
- Brokerage platforms (TD Ameritrade, Fidelity) handle live pricing — this app does not need to replicate that

---

## Phase 1 — DCF Calculator (Build First)

**Goal:** A clean, usable intrinsic value calculator that saves every calculation to a database.

### Features
- Input form: Ticker, Company Name, FCF/Share, Growth Rate Y1–5, Growth Rate Y6–10, Discount Rate, Terminal Growth Rate, Margin of Safety %
- Live calculation output: Intrinsic Value Per Share, Margin of Safety Price, Verdict (Undervalued / Overvalued / Fairly Valued)
- Step-by-step breakdown: year-by-year projected cash flows, discount factors, present values, terminal value — all visible in a table
- Save to Neon DB: every valuation saved with all inputs + outputs + optional notes field + timestamp
- Saved Valuations page: table of all saved valuations, sortable, with ability to reload into calculator or delete (5s undo)

### No external API needed for Phase 1
FCF/Share is entered manually by the user, pulled from Macrotrends or Stock Analysis.

---

## Phase 2 — Stock Screener

**Goal:** Run the Buffett-style core screener against a list of tickers.

### Screener Rules (Core, Max 5–7)
- Gross margin ≥ 40%
- Net margin ≥ 20%
- SG&A ≤ 30% of gross profit
- Interest expense ≤ 15% of operating income
- Debt-to-equity ≤ 0.80
- Long-term debt ≤ 3–4 years of earnings
- Consistent EPS growth (no major drops)

### Optional Rules
- ROE ≥ 25–30%
- Current ratio > 1
- Retained earnings consistently increasing
- Low depreciation
- Net receivables not growing faster than revenue

### Data Source
- **Financial Modeling Prep (FMP) free tier** to start: 250 calls/day, 5 years of financial statement data
- FMP free is enough to check core screener rules
- Upgrade path: FMP paid (~$20/mo) unlocks 10+ years of data — the target for full Buffett-style consistency analysis
- Alpha Vantage is not the right fit here (free tier lacks the fundamental data depth needed; better suited for price streaming, which this app doesn't need)

### UI
- Filter panel: toggle each screener rule on/off with threshold inputs
- Results table: Ticker | each metric | Pass/Fail per rule | overall Pass/Fail
- Click any ticker → load into DCF calculator

---

## Phase 3 — Financial Research Dashboard

**Goal:** Pull up a company's full financial history the way Macrotrends or Stock Analysis does — but inside this tool, with no paywall.

### Data
- Income statement: Gross Margin, Net Margin, SG&A, R&D, Interest Expense, EPS (10-year trend)
- Balance sheet: Debt/Equity, Long-term Debt, Retained Earnings, ROE
- Cash flow: Free Cash Flow per share (the key DCF input)
- All sourced from FMP (paid tier when ready)

### UI
- Search by ticker
- 10-year trend charts for every key metric
- Moat analysis notes section (user-written, saved to DB)
- One-click "Load into Calculator" from any company's research page

---

## Phase 4 — Website & Public Access (Optional)

**Goal:** Make the DCF calculator publicly accessible, potentially as a shareable tool.

- Auth system (likely Clerk) for multi-user saved valuations
- Public calculator (no login required, no save)
- Logged-in users get saved valuations + notes
- Ties into personal finance website concept (separate project)

---

## Data Model (Neon / Postgres)

```sql
-- Saved DCF valuations
CREATE TABLE valuations (
  id            SERIAL PRIMARY KEY,
  user_id       TEXT NOT NULL,                  -- from JWT, never client-supplied
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
  verdict           TEXT,                       -- 'undervalued' | 'overvalued' | 'fairly_valued'
  notes             TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Row-level: always filter WHERE user_id = $1 using JWT-derived value
```

---

## Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend | Vanilla JS or lightweight framework | Match Financinator 5000 patterns |
| Hosting | Vercel | Already familiar, free tier |
| Database | Neon (Postgres) | Free tier, more projects than Supabase |
| Auth | None initially (single user) | Add Clerk when going multi-user |
| Data API | FMP free tier | Upgrade to paid for 10yr data |
| Design system | Financinator 5000 tokens | Exact hex values, same fonts |

---

## Build Order

1. DCF Calculator (frontend only, no API) — Phase 1a
2. Neon DB + save/load valuations — Phase 1b
3. Screener UI (static, manual inputs) — Phase 2a
4. FMP integration for screener data — Phase 2b
5. Research dashboard (financial history charts) — Phase 3
6. Auth + public access — Phase 4

---

## Wednesday Study Session Integration

Each Wednesday block should end with either:
- A new saved valuation in the app (applied learning), or
- A screener run that surfaces a candidate stock for next week

The app and the study plan should compound: studying a company → running it through the screener → valuing it → saving the verdict creates a repeatable research loop.

---

## What This Does NOT Do

- Live stock price streaming (user has TD Ameritrade and Fidelity for that)
- Handle payment information of any kind
- Replace brokerage platforms
- Auto-trade or make buy/sell decisions
