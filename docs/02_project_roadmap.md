# ValueLens — Project Roadmap & Full Context

---

## What This Is

A personal investment research web app built for a value investing workflow inspired by Warren Buffett and Mary Buffett's *The Interpretation of Financial Statements*. The goal is to replace the friction of spreadsheets and paywalled data sites with a clean, purpose-built tool that matches an existing budget tracker's design system.

This is a research tool — no payments flow through it. It is initially single-user (the builder), with optional multi-user support later.

---

## Core Philosophy

- **Buffett-style value investing**: moat analysis, consistent earnings, low debt, high margins, DCF-based intrinsic value
- **Learning as you build**: the app should make the math visible and educational, not just produce an answer
- **Replaces**: Excel/Google Sheets for DCF calculations, Morningstar/Macrotrends for historical data, Finviz for screening (screening across companies is still ahead), and — planned — everyday charting in thinkorswim/TradingView
- **All-in-one goal (added Nov 2026)**: minimize the number of sites, apps and tabs needed day to day. Research, charts, screening, portfolio, options and (eventually) order entry in one place, with only the everyday features actually used — no bloat
- **Compounding investment**: building the tool reinforces what's being learned about investing
- **Never fabricate a number**: if a figure can't be found in the source data, the app shows N/A. AI-written text is always labeled as AI-generated and separated into fact vs. interpretation

---

## User Context

- One weekly investing block: Wednesday ~10:30am–12:30pm (1.5–2 hours)
- ADHD — needs clear session goals, not open-ended exploration
- Existing design system: Financinator 5000 (dark navy/blue/green finance dashboard)
- Stack familiarity: Claude Code, Neon (Postgres), Vercel, vanilla JS or lightweight frontend
- Note-taking: Notion (primary), Obsidian (secondary)
- Brokerages: **Schwab** (thinkorswim) will hold active stock picking, including a planned new **Roth IRA** there; **Fidelity** existing account; **Vanguard** Roth stays as-is and is not part of this app
- Fidelity has no public trading API (read-only data sharing via aggregators only), so Fidelity holdings come in by CSV export. Schwab has a Trader API for individuals (positions, quotes, price history, option chains, orders), which is the planned integration
- Does not day trade. Learning options (goal: identify underpriced options; cash-secured puts at or below the DCF buy-below price)
- Market opens 6:30am Pacific — automation should remove the need to be at a screen at the open

---

## Status

| Area | State |
|---|---|
| **Phase 1 — DCF Calculator** | **Done.** Calculator, step-by-step breakdown, saved valuations (Neon), FMP ticker auto-fill for company name, logo/branding |
| **Reverse DCF page** | **Done.** "What is the price assuming?" Separate from the forward calculator: implied growth (Panel A) and required operating margin (Panel B). Saved to the `reverse_dcf` table |
| **Filings tab** (was Phase 2/3) | **Done.** SEC EDGAR XBRL data, 10-year metrics table, screener scorecard, trend charts, Send to Calculator, Neon cache |
| **Story sub-tab** | **Done.** AI narrative from the latest annual filing |
| **News sub-tab** | **Done.** "Why is the stock moving": web-search news context plus recent 8-K/6-K filings, labeled amber "NEWS CONTEXT, NOT FROM FILINGS" |
| Auth | **Single-user login done** (username/password, signed session cookie, DB-backed lockout). Multi-user auth (Clerk) not built; `user_id` is still the hardcoded `'local'` |
| **Screener** (Round A) | **Done.** `/screener` page + `api/_handlers/screener.js` (served by `company.js`, URL `/api/screener`). Data from SEC XBRL frames (one line item for every filer per calendar year; 14 metrics × tag fallbacks × 5 years), refreshed on demand one metric per call with a progress bar, stored in `screener_metrics`, compacted into `screener_dataset` (ratios per company per year). Rules engine in `public/src/screener-rules.js`: 7 core + 3 optional rules with editable thresholds, "pass at least N", missing data skip/fail, "rule must hold N of 5 years"; must be measurable on 60% of active rules. Results sortable, value history popup, row opens Filings, + watchlist. Round B: industry toggles (biotech off by default), price/P/E/market cap, buy-zone tag, saved screens; weekly auto-refresh with the alerts cron |
| **Charts** (All-in-One B) | **Prototype done.** KLineChart 10.1.0, full-viewport Charts page and interactive Price card on Filings (in-place expand/minimize), drawing tools, EMA/SMA, compare. Daily prices from FMP free tier via `api/prices.js` (cached in `price_history`); FMP free doesn't cover every symbol (e.g. small caps) — Schwab data replaces it next |
| **Schwab connection** (All-in-One A) | **Done (read-only).** OAuth via `api/schwab.js` (`/api/schwab/connect`, `/callback`, `/status`, `/accounts`, `/disconnect`, routed by a `vercel.json` rewrite), encrypted tokens in `schwab_tokens`, 30-min auto-refresh, 7-day reconnect, nav status button and `/schwab` accounts/positions page. Connect on the live site (Schwab requires the https callback); localhost uses the same Neon tokens |
| **Charts on Schwab data** | **Done.** `api/prices.js` uses Schwab price history when connected (FMP, then sample files, as fallbacks); intraday 1m/5m/15m/30m from Schwab, 1h/4h built from 30m (session-anchored at 9:30 ET); intraday times in Pacific; extended-hours toggle (gear → Session); live candles via the Schwab streamer (`public/src/schwab-stream.js`, LEVELONE_EQUITIES) with a LIVE dot and a data-source label |
| **Watchlist** (All-in-One D, part 1) | **Done.** `/watchlist` page + `api/watchlist.js` (`watchlist` table). Schwab's API has no watchlists, so tickers are added here (paste a list to import). Live Schwab prices, today's change, intrinsic value and buy-below from the latest saved valuation, distance to buy-below, BUY ZONE / NEAR flags, sorted closest first; "+ Watchlist" on Filings; rows open Filings. Email alerts not built yet |

### Phase 1 — DCF Calculator (done)

- Input form: Ticker, Company Name, FCF/Share, Growth Rate Y1–5, Growth Rate Y6–10, Discount Rate, Terminal Growth Rate, Margin of Safety %, optional market price
- Live output: Intrinsic Value Per Share, Margin of Safety Price, Verdict (Undervalued / Overvalued / Fairly Valued)
- Step-by-step breakdown: year-by-year projected cash flows, discount factors, present values, terminal value
- Save every valuation to Neon with inputs, outputs, notes, and timestamp
- Saved Valuations page: sortable table, reload into calculator, delete with 5s undo
- Ticker blur auto-fills the company name via FMP (free tier, `/api/ticker`)
- **Optional Net Cash / Share input:** when filled, it is added to intrinsic value undiscounted and shown as its own row in the breakdown table. The margin-of-safety price is applied to the total including net cash. Blank by default, so results and old saved valuations are unchanged. Saved in `valuations.net_cash_per_share`

### Reverse DCF page (done)

A nav tab right after Calculator. Where the calculator asks "what is it worth?", this asks "what is the current price assuming?". Wording is descriptive only, with no buy/sell language.

- **Shared inputs (all editable):** ticker, company name, current price with a required price date, diluted shares, cash, total debt, other debt-like obligations (e.g. deferred purchase consideration), discount rate (10%), terminal growth (3%), margin of safety (20%), tax rate (21%). A units selector (dollars / thousands / millions) labels the dollar amounts and share counts; per-share values are always dollars. Net cash per share = (cash − debt − other) ÷ shares; enterprise value = price × shares + debt + other − cash
- **Panel A, implied growth:** solves by bisection (range −20% to +60%) for the constant annual growth over years 1 to 10 that makes the DCF value equal the price. It calls the same `calculateDCF` engine as the forward calculator (net cash included, undiscounted). Shows the implied growth at the current price and at price ÷ (1 − margin of safety), a table of value per share at 0/3/5/8/10% growth, and implied growth at 8/10/12% discount rates. An optional second "normalized" FCF/share is shown side by side. When Filings data was sent over, the company's 10-year FCF CAGR is shown next to the implied figure. Zero/negative FCF or no solution in range is stated plainly, never a made-up number
- **Panel B, required operating margin:** written step by step with the formula and substituted numbers: market cap, EV, multiple = (1 + g) ÷ (r − g) (own growth input, defaults to terminal growth), required FCF = EV ÷ multiple, required operating income = required FCF ÷ (1 − tax), required margin = that ÷ revenue, and the same with margin of safety (÷ (1 − MoS)). Compares with the actual margin (and the last 5 fiscal years from Filings) in words. Shows a warning when capex ÷ depreciation is outside 0.5 to 2.0 (the method assumes capex ≈ depreciation), and "Enterprise value is not positive; this method isn't meaningful here." when EV ≤ 0. Missing revenue or operating income shows N/A
- **Send to Reverse DCF →** (Filings header): hands over ticker, company name, revenue, operating income, depreciation, capex, FCF/share, latest diluted shares, cash, long-term debt, the last 5 years of operating margins and the FCF CAGR through `sessionStorage`. N/A fields stay blank, price is never prefilled, each prefilled field is labeled with its source (e.g. "FY2025 10-K"), and a note says annual figures can be out of date and cash, debt, shares and trailing figures should be overwritten from the latest 10-Q. Debt is long-term debt only
- **Saving:** `reverse_dcf` table (below), created on first use, via `api/reverse.js` (GET, POST, DELETE). Saved Valuations has a **Forward | Reverse** toggle; each reverse row has Load and Delete (5-second undo)

### Filings tab (done)

Free, server-side data from SEC EDGAR's XBRL `companyfacts` API. Entirely separate from the calculator, except for one hand-off.

- **Input:** a ticker or a pasted EDGAR URL, validated server-side. Tickers map to a CIK through SEC's `company_tickers.json`
- **Extraction (`api/_sec.js`):** `us-gaap` and `ifrs-full` taxonomies, annual forms only (10-K, 40-F, 20-F), deduped by fiscal year keeping the latest filing. Each metric uses an ordered fallback list of tag names, merged per year so companies that changed tags mid-decade still get a full series. Anything not found is `null` and shown as N/A
- **Metrics:** revenue, cost of revenue, gross profit, SG&A, R&D, depreciation, operating income, interest expense, net income, diluted EPS and shares, current assets/liabilities, total liabilities, equity, long-term debt, retained earnings, net receivables, operating cash flow, capex
- **Derived per year:** gross margin, net margin, SG&A % of gross profit, interest % of operating income, debt-to-equity (total liabilities / equity), long-term debt vs. years of earnings, current ratio, ROE, FCF, FCF/share, EPS growth. Also a 10-year FCF CAGR used as a suggested growth input
- **Screener scorecard:** each core rule shows the latest value, a PASS / FAIL / N/A pill, and how many of the last 10 years passed. Optional rules (ROE, current ratio, retained earnings) sit in a secondary section
- **10-year table** with sticky first column, and gradient-area SVG **trend charts** for gross margin, net margin, EPS, FCF/share, and D/E
- **Send to Calculator:** passes ticker, company name, latest FCF/share, and the suggested growth rate through `sessionStorage`; the calculator pre-fills them (still editable) and does not auto-calculate
- **Derived from the as-filed income statement (data version 6):** when no tag supplies cost of revenue or SG&A, fixed label rules read the filing's own income statement (`incomeFromStatement` in `api/_statements.js`). Cost of revenue = commissions, voyage expenses, vessel operating expenses and dry-docking only (commissions listed above a "net revenue" subtotal are not deducted twice); SG&A = general and administrative plus management fees. Depreciation, gains and impairments are never included. Only the three years in the latest filing can be derived, and a value with a real tag is never replaced. Each derived cell says so and lists the exact rows used on hover
- **One-time gains:** gains/losses on asset sales come from XBRL tags (`GainLossOnSaleOfPropertyPlantEquipment`, `GainLossOnDispositionOfAssets`, related) or an as-filed "gain on sale" row. Table rows show operating income, net income, net margin, ROE and total debt/earnings **ex-gains** (simple subtraction, no tax adjustment). The scorecard judges the ex-gains value whenever a gain or loss was found and shows the as-reported value underneath. XBRL gain tags are not signed consistently across filers, so a tag-based gain is used only when an as-filed row confirms it for that fiscal year: an income statement row labeled as a gain/loss on sale, or a cash flow reconciliation row (a gain is a negative adjustment, a loss a positive one), with the same sign and an amount within 1%. An unconfirmed tag makes no adjustment: ex-gains cells show N/A ("Gain/loss tag found but not confirmed by the as-filed statement") and the scorecard uses the reported value and says so. Only the years in the latest filing can be confirmed
- **Total debt:** long-term debt plus the current portion (when reported). The debt-vs-earnings rule uses it
- **EPS consistency:** any loss year (EPS of zero or less) in the window fails the rule; EPS growth from a zero or negative base shows "n/m". A reported diluted share count of 0 is treated as not reported, and `BasicAndDiluted` EPS and share tags are accepted
- **Cache:** `company_financials` in Neon, reused for 7 days. A Refresh button forces a refetch (limited to once per minute per company to protect SEC's rate limit)
- **Etiquette:** every SEC request carries the `SEC_USER_AGENT` header and is throttled to roughly 5 requests/second

### Story sub-tab (done)

An AI-written narrative of the business, generated from the latest annual filing text plus the stored metrics.

- **Filing text extraction:** finds the most recent 10-K / 40-F / 20-F via SEC's submissions API. For 10-Ks it pulls Item 1, Item 1A, Item 7, and the segment/concentration note. For 40-F/20-F filers, where the main document is a wrapper, it reads the EX-99/EX-13 exhibits and matches heading keywords. Each section is length-capped and flagged truncated; sections it can't find are reported as missing, never guessed
- **Nine sections**, each item tagged with its source (e.g. "Item 1A", "MD&A", "Metrics") and labeled fact or interpretation: business summary, revenue sources, where the money goes, capital management, moat assessment, screener context, top risks, red flags, questions to research
- **Per-section generation** driven from the client with a progress indicator, so no single serverless call approaches the timeout. The shared filing text is sent as an **Anthropic prompt-cached** block, so after the first call each section only pays full price for its own instruction
- **Guardrails:** filing text is treated as untrusted data in the system prompt; the model may use only the supplied metrics and text, writes "Not disclosed in the provided sections" when something is missing, and gives no buy/sell recommendation. All output is rendered with `textContent`
- **Cache:** `company_narratives` in Neon. A story is reused until a newer filing appears or Regenerate is clicked
- **Protection:** requests need a valid login session like every other route, and generations are capped per day (default 5, set with `DAILY_STORY_LIMIT`; tracked in `narrative_usage`)

### News sub-tab (done)

News context for why a stock has been moving. It is kept visually and textually separate from filing-derived data: every card carries an amber "News context" tag.

- **Inputs (`api/news.js`):** company name and ticker, a few key metrics from `company_financials`, the company's 8-K filings (6-K for foreign filers) from the last 120 days with item codes, and a server-computed price summary (start, end, high, low, largest daily moves) when available. For 6-K filers, the top of each of the 6 most recent press-release exhibits is read as a headline, since 6-Ks have no item codes
- **Price data:** FMP's current free `historical-price-eod/light` endpoint, which covers some symbols (V, KO, AAPL, XOM, JPM, TSM) but not others (B, NEM, BRK-B, SHEL return 402). When it isn't available the model is told so explicitly, price context must come from a cited source or read "Not available", and the UI says so
- **Model run:** the Anthropic Messages API with the web search server tool, capped at 5 searches, default model `claude-sonnet-5-5`. The basic `web_search_20250305` tool is used, not the newer dynamic-filtering variant: on Barrick the newer one ran 5 searches and surfaced one readable article, while the basic one used 2 searches and returned drivers, analyst actions and catalysts at the same cost
- **Output:** structured JSON (summary, price context, 1 to 3 external drivers, company events, analyst actions, upcoming catalysts, unknowns), each item tagged fact or interpretation, with a confidence on every interpretation. The model first identifies the stock's main external drivers (gold for a miner, crude for an oil company, rates for a bank) and searches those as well as the company
- **Source checking:** a cited URL is kept only if it appeared in the search results the model actually received (or is a supplied SEC filing URL). Fabricated URLs are dropped, and any item left with no verifiable source is dropped rather than shown
- **Cache and limits:** `company_news` in Neon, reused for 12 hours until Refresh is clicked. Runs are capped per day (default 10, `DAILY_NEWS_LIMIT`; tracked in `news_usage`)
- **Cost:** measured at about $0.10 per run on Barrick (two runs: $0.103 and $0.105 estimated, 21 to 36 seconds). The cost is estimated from logged token counts and a per-search fee, and is stored with each run

---

## Data Strategy

**SEC EDGAR is the free primary source for fundamentals.** It provides 10+ years of annual history and covers foreign filers (40-F / 20-F, IFRS) that free price-data APIs usually skip. It needs no key, only a descriptive User-Agent.

**FMP free tier is now used only for ticker lookups** (company-name auto-fill in the calculator). Fundamentals no longer depend on it.

**FMP paid (~$20/mo) is an optional later upgrade**, not a prerequisite, and is now **likely unnecessary**: the full-market screener can be built on EDGAR's `frames` API plus Schwab quotes (see "All-in-One Platform" below). Alpha Vantage remains the wrong fit.

**Schwab Trader API (planned)** — Individual tier, for the account holder's own accounts. Covers all accounts under the Schwab login (the planned Roth IRA appears automatically). Provides:
- Market data: quotes (batched), price history (daily and intraday candles), option chains and expirations, movers
- Trader: accounts, positions, cost basis, orders (stocks, options, ETFs only), transactions
- Streaming (WebSocket): level-one quotes, chart bars, Level 2 books (`NYSE_BOOK`, `NASDAQ_BOOK`, `OPTIONS_BOOK`), account activity. **No time & sales feed found** in the current Schwab streamer (the old TD Ameritrade `TIMESALE_*` services don't appear) — verify in the developer docs once approved
- **Auth caveat:** OAuth refresh token expires after **7 days**, so the app needs a weekly re-authorize flow and must clearly show "Schwab disconnected" rather than failing silently
- Streaming must connect from the **browser**, not Vercel (serverless functions can't hold a WebSocket open); the server only hands the browser a short-lived token

**SEC EDGAR `frames` API (planned, for the screener)** — `data.sec.gov/api/xbrl/frames/{taxonomy}/{tag}/{unit}/{period}.json` returns one line item for **every filer** for a period in one request. A handful of calls (revenue, cost of revenue, SG&A, operating income, interest, net income, debt, equity, EPS…) give a whole-market dataset for the Buffett rules, including the three Finviz can't filter. Free. SIC codes (for industry filters) come from the submissions API.

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

### 1. In-app AI chat

- Ask questions about a company inside the app
- Reuses the stored metrics and narratives as context instead of re-fetching, keeping cost and latency low
- **Message cap** per day (like `DAILY_STORY_LIMIT`), since chat is the costliest feature: every turn re-reads the context and replies are open-ended

### 2. Metric refinements

- **Attributable FCF** after minority interests
- **Non-recurring gain adjustment** (e.g. gains on asset sales) when judging earnings consistency
- **Derived operating income for IFRS filers** where it isn't reported
- **FCF/share from cover-page share counts** (the `dei` share count), to fill the gap for per-share-class companies like Visa
- **Debt-to-equity on attributable equity** rather than total equity including non-controlling interests

### 3. Screener (expanded: full market, not just cached companies)

- Run the core and optional rules across the **whole market** using EDGAR `frames` data (see Data Strategy), with current prices from Schwab quotes for P/E and similar. Companies already in `company_financials` keep their richer 10-year data
- Filter panel with a toggle and threshold per rule; results table with the metric values and Pass/Fail per rule
- **Industry/sector exclusion toggles** (a paywalled feature on Finviz). Biotech is a toggle, **off by default — never excluded automatically**. Based on SIC codes (e.g. biotech/pharma 2834, 2836, 8731), so other industries can be toggled the same way
- Saved screens (name + rule set) so a screen can be re-run in one click
- Click any ticker to open it in Filings, the chart, or send it to the calculator

### 4. Managed auth provider (only if multi-user happens)

- Optional. The single-user login is enough for personal use; see "If This Is Ever Productized" below for what moving to a managed provider involves

---

## All-in-One Platform (planned, Nov 2026)

Goal: make Stockinator the one place for research → decide → execute → monitor, replacing day-to-day use of thinkorswim, TradingView and Finviz. Only the features actually used; no bloat. Priority relative to "Next Up" above is still to be decided.

### Prerequisites (do first — approval takes time)

1. Open the Schwab Roth IRA
2. Register at developer.schwab.com, request **Trader API – Individual**, wait for approval, then create an app (callback URL on stocks.financinator.online)
3. Check the Roth's options approval level (cash-secured puts and covered calls are usually allowed in an IRA; no margin)

### A. Schwab connection (read-only first)

- OAuth connect flow, tokens stored server-side in Neon, weekly re-authorize prompt (7-day refresh token), visible connection status
- Positions, balances and cost basis across all Schwab accounts
- Quotes and price history for charts; option chains for later
- No order placement in this step

### B. Charts

**Library:** prototype **KLineChart** (Apache 2.0, drawing tools built in) first; fall back to TradingView **Lightweight Charts** (Apache 2.0, attribution required, but no built-in indicators or drawing tools) if KLineChart's editing doesn't feel right. TradingView's Advanced Charts library is not licensed for personal projects. Optional quick win: embed the free TradingView widget meanwhile (TradingView's data only; can't show our own overlays).

**Prototype status:** a KLineChart prototype is live: a full-viewport Charts tab (`/charts`, `/chart/TICKER`) and an interactive Price card at the top of the Filings company view. Both use one component (`public/src/chart-view.js`; page shell `charts.js`, data and settings `chart-data.js`, drawing tools and indicators `chart-overlays.js`). **Price data for any ticker** comes from `api/prices.js` (FMP free tier, up to the 5,000-row cap, about 20 years of daily bars; cached in the `price_history` table and refreshed once a day); a symbol the free plan refuses shows "Price data for this ticker isn't available on the free data source yet. It will be once Schwab is connected." The committed files in `public/sample/` (AAPL, MSFT, V) are the fallback. Daily opens on the last ~2 years with a Fit all button. The Price card can **Expand in place** (a full-viewport overlay, no navigation; Minimize or Esc returns to the same scroll position and chart state) and has an "Open in Charts" link. Drawings and indicator settings are shared per ticker across every chart; timeframe, zoom, volume options and compare tickers are independent per location. Drawings and settings are in localStorage for now; Neon persistence is a TODO in `chart-data.js`.

**Must have (everyday features):**
- **Candlesticks only** (no line/bar/other chart types needed)
- Zoom in/out and scroll; timeframes (intraday through weekly/monthly)
- Indicators: **50 and 200 day EMA and SMA** (computed in-app). No MACD etc. needed
- **Volume bars** at the bottom, customizable (color, opacity, height) so they look clean and stay out of the way
- Drawing tools: trend lines, horizontal lines, vertical lines (important dates), parallel channels, Fibonacci retracement
- Line editing: solid/dashed/dotted, color, width; **endpoints infinite or fixed on either or both ends**; text labels on lines; price labels; choose which data shows on a line (e.g. price, % change, number of days/bars spanned)
- Drawings saved per ticker in Neon and restored on reload
- **Multiple charts**, open a chart in a new tab (each chart has its own URL, e.g. `/chart/MSFT`), and full-screen view
- **Compare tickers**: overlay other symbols as % change lines

**Value overlays (things thinkorswim/TradingView can't show):**
- DCF buy-below price line (from saved valuations)
- Cost basis and positions (from Schwab)
- Option strikes and expirations for held or candidate options
- Earnings and 10-K filing date markers, linked to Filings/News
- Later: implied volatility history pane

### C. Screener

See Next Up #3 (full market via EDGAR `frames`, industry toggles with biotech off by default).

### D. Portfolio, watchlist and alerts

- Portfolio view: Schwab positions (live) + Fidelity positions (CSV import), each compared to its saved DCF value and buy-below price
- Watchlist with buy-below prices
- Daily Vercel cron checks prices and emails an alert when something is near or below its buy-below price

### E. Morning digest / Wednesday brief

- ~6am Pacific email: positions, overnight fills, anything near a trigger, News tab highlights
- Wednesday pre-study brief: watchlist vs. buy-below, a screener run, 1–2 things worth looking at

### F. Options chain view (after options study Sections 3–5)

- Filtered to the strategy: cash-secured puts with strikes at or below the DCF buy-below price, ~30–45 days out, minimum open interest, maximum bid-ask spread
- Shows annualized return on cash secured, and flags any option that expires after an earnings date

### G. Order entry (levels of automation)

| Level | What | Status |
|---|---|---|
| 0 | Alerts only | Part of D |
| 1 | **Pre-filled order ticket** — app builds the order, user reviews and clicks Send | Planned |
| 2 | **Broker-side orders**: GTC limit entries plus OCO brackets (e.g. close a short put at 50% of max profit) held at Schwab, so they execute without a device or the app being up | Planned |
| 3 | Fully automated bot | Later, only with guardrails: dry-run mode first, max position size, daily loss limit, kill switch |

Practice in thinkorswim paperMoney or with small positions before relying on Levels 1–2.

### H. Trade journal

- Fills pulled automatically from Schwab transactions; add thesis/notes per trade; review later

### Deferred

- **Level 2 and time & sales** — dropped for now. Schwab streams Level 2 books but appears to have no time & sales feed, and Level 2 alone isn't worth the WebSocket work yet

---

## Hosting

The app will live at **stocks.financinator.online**, a subdomain of the existing Financinator domain.

- The login cookie is **host-only** for now: the browser sends it only to `stocks.financinator.online`, so it is never shared with Financinator
- An optional **`COOKIE_DOMAIN`** env var (unset by default) adds a `Domain=` attribute to the session cookie. Setting it to `.financinator.online` would share one login across subdomains later, as a config change rather than a code change
- Sharing a login is not free: Financinator is in production, so it would have to be changed to accept the same cookie, both apps would then share **one `SESSION_SECRET`**, and a leak or misconfiguration in either app would expose both (one shared failure point). Keep the cookie host-only unless that trade is clearly worth it
- **Route grouping (Vercel Hobby allows 12 functions per deployment; every non-underscore file in `api/` is one):** endpoints live in `api/_handlers/` and are served by 5 grouped functions: `auth.js`, `company.js` (filings, statements, narrative, news), `saved.js` (valuations, reverse), `market.js` (prices, ticker, watchlist), `schwab.js`. `vercel.json` rewrites the public URLs (e.g. `/api/filings` → `/api/company?resource=filings`), so browser code uses the same URLs as before. New endpoints go into an existing group
- Helper modules in `api/` must be **prefixed with an underscore** (`_db.js`, `_auth.js`, `_sec.js`, `_fmp.js`). Vercel deploys every other file in `api/` as a public endpoint, so an un-prefixed helper would become one

---

## Cost Notes

- One Story generation costs about **$0.33**: roughly $0.13 is the one-time cache write of the filing text, and each of the 9 sections adds about $0.03
- Stories are cached per filing in `company_narratives`, so **reloads are free**. Only a new story (first generation, or a newer filing) and Regenerate cost money
- A **section picker was considered and rejected**: it would save only about $0.13, and adding a section later pays the cache write again
- Use **Sonnet, not Haiku**, for narrative quality; the savings are small next to a worse story
- The **daily limit** is set with `DAILY_STORY_LIMIT` (default 5), which caps worst-case daily spend
- SEC EDGAR is free, so the Story's model calls are the only variable cost

---

## If This Is Ever Productized

Not planned, but if the app is ever sold or opened to other users:

- **Auth:** replace the single-user login with a managed provider such as Clerk rather than hand-rolling multi-user auth. Derive `user_id` from the verified session, never from the client, and migrate the existing `'local'` rows to the real user id
- **Money:** add per-user cost limits and a paid plan. Today `narrative_usage` is keyed by `user_id`, so per-user caps are a small step, but nothing bills anyone
- **Shared data:** make `company_financials` and `company_narratives` **global**, not per-user. SEC filings are the same for everyone, so each story is paid for once and every user reads it free
- **Before opening signups:** add rate limiting beyond the login lockout, error monitoring, and a pen test, including IDOR checks with a second account
- **Legal:** add terms of service and a "not financial advice" page, and check licensing before redistributing any paid data source (EDGAR itself is public, but a paid provider such as FMP's paid tier may restrict redistribution)
- **Keep the groundwork in place:** keep every query filtered by `user_id`, keep the login code isolated in `api/_auth.js` so it can be swapped, and keep all secrets in env vars

---

## Later / Optional

- **Charts: fix Fib label overlap at dense zoom** (level labels collide with each other and with the lines when the retracement is small on screen)
- **User-written moat notes** per company, saved to the DB (the Story tab's moat assessment is AI-generated; personal notes are not built)
- **Public access (formerly Phase 4):** a public calculator with no login and no save, plus saved valuations and notes for logged-in users, which would need the managed auth provider from "If This Is Ever Productized". Ties into the personal finance website concept (separate project)
- **FMP paid upgrade** if EDGAR's coverage or speed becomes the bottleneck for screening

---

## Data Model (Neon / Postgres)

All tables carry a `user_id`. Today it is the constant `'local'`, set server-side and never read from the client; it would become the managed provider's session-derived id if the app ever goes multi-user.

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

-- Net cash is added later by ALTER TABLE valuations ADD COLUMN IF NOT EXISTS net_cash_per_share NUMERIC;
-- (nullable: blank means none, and old rows are unchanged)

-- Saved Reverse DCFs (Reverse DCF page). Created on first use.
CREATE TABLE reverse_dcf (
  id           SERIAL PRIMARY KEY,
  user_id      TEXT NOT NULL DEFAULT 'local',  -- server-derived, never client-supplied
  ticker       TEXT NOT NULL,
  company_name TEXT,
  price        NUMERIC,
  price_date   DATE,
  inputs       JSONB NOT NULL,                  -- units, every input box, sources, margin history
  results      JSONB NOT NULL,                  -- implied growth, required margins, EV, net cash/share
  notes        TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
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

-- Daily OHLCV from FMP's free tier for the Charts (api/prices.js). Refreshed once a day; real data only.
CREATE TABLE price_history (
  user_id    TEXT NOT NULL DEFAULT 'local',
  ticker     TEXT NOT NULL,
  bars       JSONB NOT NULL,                      -- [{ t (UTC midnight ms), o, h, l, c, v }], oldest first, up to 5,000 rows
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, ticker)
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

-- News context (News sub-tab). One row per company, refreshed after 12 hours.
CREATE TABLE company_news (
  id             SERIAL PRIMARY KEY,
  user_id        TEXT NOT NULL DEFAULT 'local',
  cik            TEXT NOT NULL,
  ticker         TEXT,
  result         JSONB NOT NULL,
  model          TEXT,
  searches_used  INT,
  cost_estimate  NUMERIC,                       -- estimated USD for the run
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, cik)
);

-- Daily cap on news runs (default 10/day, DAILY_NEWS_LIMIT)
CREATE TABLE news_usage (
  user_id TEXT NOT NULL,
  day     DATE NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- Daily cap on story generations (default 5/day, DAILY_STORY_LIMIT)
CREATE TABLE narrative_usage (
  user_id TEXT NOT NULL,
  day     DATE NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- Failed login attempts, for the per-IP lockout (5 failures / 15 minutes). Cleared on success.
CREATE TABLE login_attempts (
  id           SERIAL PRIMARY KEY,
  ip           TEXT NOT NULL,
  attempted_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_login_attempts_ip ON login_attempts(ip, attempted_at);

-- Row-level: always filter WHERE user_id = $1 using the server-derived value.
-- The new tables are created on first request, matching how `valuations` is created.
```

---

## Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend | Vanilla JS (ES modules) | Matches Financinator 5000 patterns; all user and model text rendered via `textContent` |
| Hosting | Vercel, at stocks.financinator.online | Serverless `api/` routes; `api/narrative.js` has `maxDuration` 300; helpers in `api/` are underscore-prefixed |
| Database | Neon (Postgres) | Free tier, more projects than Supabase |
| Auth | Single-user login: `APP_USERNAME`/`APP_PASSWORD`, HMAC-signed 30-day session cookie (`HttpOnly`, `SameSite=Strict`), Neon-backed lockout (5 failures / 15 min / IP); every `api/` route calls `requireAuth`; cookie is host-only unless `COOKIE_DOMAIN` is set | A managed provider (e.g. Clerk) only if multi-user happens |
| Fundamentals data | SEC EDGAR (XBRL `companyfacts`, submissions, filing documents) | Free, no key; needs `SEC_USER_AGENT`; throttled to ~5 req/s |
| AI | Anthropic API (Messages) | Default model `claude-sonnet-5-5`, overridable via `ANTHROPIC_MODEL`; prompt caching on the shared filing text |
| Ticker lookup | FMP free tier | Company-name auto-fill only. Paid tier is an optional later upgrade |
| Design system | Financinator 5000 tokens | Exact hex values, same fonts |
| Brokerage/market data (planned) | Schwab Trader API – Individual | OAuth, 7-day refresh token; streaming from the browser only |
| Charts (planned) | KLineChart (prototype) or TradingView Lightweight Charts | Both Apache 2.0 |

Environment variables (server-side only, never in frontend JS): `NEON_DATABASE_URL`, `FMP_API_KEY`, `SEC_USER_AGENT`, `ANTHROPIC_API_KEY`, `APP_USERNAME`, `APP_PASSWORD`, `SESSION_SECRET`, optional `ANTHROPIC_MODEL`, `DAILY_STORY_LIMIT` (default 5), `DAILY_NEWS_LIMIT` (default 10), and `COOKIE_DOMAIN` (unset = host-only cookie). Schwab: `SCHWAB_APP_KEY` (Client ID), `SCHWAB_APP_SECRET` (Client Secret), `SCHWAB_CALLBACK_URL` (`https://stockinator5000.vercel.app/api/schwab/callback`). Locally, `api/_env.js` loads `.env.local` for `vercel dev` (no rename to `.env` needed; values are read literally).

---

## Build Order

Done:

1. DCF Calculator (frontend only) — Phase 1a
2. Neon DB + save/load valuations — Phase 1b
3. FMP ticker auto-fill and branding
4. Filings tab: SEC EDGAR metrics, scorecard, charts, Send to Calculator
5. Story sub-tab: filing text extraction, then per-section AI generation
6. News sub-tab: recent SEC 8-K/6-K filings, price history where available, and web-search news context

Also done since: operating margin on the Filings tab (ratio row, chart, informational scorecard line) and the Reverse DCF page with net cash in the forward calculator.

Next (see Next Up above):

7. In-app AI chat (with a message cap)
8. Metric refinements
9. Screener (full market, industry toggles)
10. Managed auth provider, only if multi-user happens

All-in-One Platform (order vs. the list above to be decided): prerequisites (Schwab Roth + developer approval) → A. Schwab connection → B. Charts → C. Screener → D. Portfolio and alerts → E. Morning digest → F. Options chain view → G. Order ticket and broker-side brackets → H. Journal. Level 2 / time & sales deferred.

---

## Wednesday Study Session Integration

Each Wednesday block should end with either:
- A new saved valuation in the app (applied learning), or
- A screener run that surfaces a candidate stock for next week

The app and the study plan should compound: studying a company → loading it in Filings and reading its Story → checking the scorecard → valuing it in the calculator → saving the verdict creates a repeatable research loop. Once the cross-company screener exists, it becomes the candidate-finding step at the front of that loop.

---

## What This Does NOT Do

- Handle payment information of any kind
- Hold money or replace the broker's own confirmations: orders always go through Schwab, and Fidelity is read-only (CSV)
- Level 2 / time & sales (deferred, see All-in-One Platform)
- Make buy/sell decisions or trade fully automatically — order entry is human-confirmed (Level 1) or pre-placed broker-side orders (Level 2); a fully automated bot is not planned without guardrails. The AI Story is explicitly instructed to give no buy/sell recommendation, and every Story carries an "AI-generated from SEC filings. Verify against the filing. Not financial advice." disclaimer
