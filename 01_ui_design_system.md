# Investment Research Tool — UI Design System & Build Spec
*Extends Financinator 5000 design language. All new components must match this system exactly.*

---

## Visual Identity

**Product name (working title):** ValueLens (or your choice — placeholder throughout)
**Vibe:** Same dark finance dashboard as Financinator 5000. Navy/black base, electric blue + green accents. Data-dense but calm. Numbers always feel precise, never chaotic.
**Design rule:** If a new component looks like it belongs in a different app, it's wrong.

---

## Color Palette

Carry over the exact Financinator 5000 tokens — no reinterpretation.

```css
:root {
  --bg:               #080c12;
  --surface:          #0d1219;
  --card:             #111720;
  --border:           #1c2535;
  --border-hi:        #253045;
  --blue:             #3b9eff;
  --blue-dim:         #1a4a7a;
  --blue-glow:        rgba(59,158,255,0.12);
  --blue-glow-strong: rgba(59,158,255,0.22);
  --green:            #00e5a0;
  --green-dim:        rgba(0,229,160,0.12);
  --red:              #ff4d6a;
  --red-dim:          rgba(255,77,106,0.12);
  --yellow:           #ffc940;
  --text:             #e8edf5;
  --text-2:           #8a96a8;
  --text-3:           #4a5568;
  --mono:             'JetBrains Mono', monospace;
  --sans:             'Inter', sans-serif;
}
```

**Semantic pairing for this tool:**
- Blue (`--blue`) = Valuation / calculated figures / intrinsic value
- Green (`--green`) = Positive signals / undervalued / pass criteria
- Red (`--red`) = Negative signals / overvalued / fail criteria
- Yellow (`--yellow`) = Margin of safety zone / neutral / watch

---

## Typography

Same rules as Financinator 5000, no exceptions:
- **UI text, labels, copy:** Inter
- **Every numeric value:** JetBrains Mono — dollar amounts, percentages, ratios, years, share counts, all of it
- This is a design signature. Numbers always look distinct from prose.

```css
font-family: var(--sans);   /* default */
font-family: var(--mono);   /* all numbers */
```

---

## Layout

**Max content width:** 1100px, centered, `padding: 28px 24px`
**Card structure:** Every widget lives in a card — `background: var(--card)`, `border: 1px solid var(--border)`, `border-radius: 10px`
**Three-tier surfaces:** `--bg` (page) → `--surface` (nav, section backgrounds) → `--card` (widgets)

### Navigation
- Sticky top nav, `height: 56px`, `background: var(--surface)`, `border-bottom: 1px solid var(--border)`
- Brand mark on left: blue dot glow + "VALUELENS" in small caps (or chosen name)
- Nav tabs: Calculator / Saved Valuations / Screener (disabled/dimmed until built) / Research (future)
- Active tab: `color: var(--blue)`, `background: var(--blue-glow)`
- Right side: utility actions (e.g. Export, Sign Out when auth is added)
- Mobile: hamburger collapses tabs below 375px

---

## Pages & Components

### 1. DCF Calculator Page (`/calculator`)

**Layout:** Two-column on desktop (inputs left, results right), single-column stacked on mobile.

**Left panel — Inputs card:**
- Section label: "Inputs" in small caps, `--text-2`
- Fields: Ticker (text), Company Name (text, auto-fill later), FCF/Share, Growth Rate Y1–5, Growth Rate Y6–10, Discount Rate, Terminal Growth Rate, Margin of Safety %
- All numeric inputs: JetBrains Mono, right-aligned
- Input style: `background: var(--surface)`, `border: 1px solid var(--border)`, rounded, focus ring in `--blue`
- Inputs must NOT lose focus on keystroke (guard against re-render bugs)
- CTA button: "Calculate Intrinsic Value" — full width, `background: var(--blue)`, white text
- Secondary: "Save Valuation" — ghost button, only active after a calculation has run

**Right panel — Results card:**
- Top stat: Intrinsic Value Per Share — large, JetBrains Mono, `--blue`
- Margin of Safety Price — slightly smaller, `--green` if current price is below it, `--red` if above
- Current Market Price (user-entered or later pulled from API) — `--text`
- Verdict badge: "UNDERVALUED" (`--green` bg), "OVERVALUED" (`--red` bg), or "FAIRLY VALUED" (`--yellow` bg) — pill shape
- Divider, then the step-by-step breakdown (see below)

**Step-by-step calculation breakdown (collapsible, open by default):**
- Section label: "How This Was Calculated"
- Year-by-year table: Year | Projected FCF | Discount Factor | Present Value
  - All numbers: JetBrains Mono
  - Alternating row shading: `--card` / `--surface`
  - Horizontal scroll on mobile with sticky Year column
- Below the table: Terminal Value row (highlighted, `border-top: 1px solid var(--border-hi)`)
- Sum row: Total PV of Cash Flows + Discounted Terminal Value = Intrinsic Value
- This section is the learning tool — make the math visible and readable, not buried

---

### 2. Saved Valuations Page (`/valuations`)

- Summary row cards at top: Total Saved, Undervalued Count, Overvalued Count
- Table below: Ticker | Company | Intrinsic Value | Market Price (at save time) | Verdict | Date Saved | Notes (truncated) | Actions
- Clicking a row opens a slide-in detail panel (or navigates to detail page) showing the full step-by-step breakdown and saved notes
- Sort: default newest first
- Each row has Edit (reload inputs into calculator) and Delete (5-second undo affordance, no confirmation dialog)
- Verdict badges use same pill style as calculator page

---

### 3. Screener Page (`/screener`) — Phase 2, stub now

- Nav tab visible but dimmed with "Coming Soon" tooltip
- When built: filter panel on left, results table on right
- Filters map directly to the CORE SCREENER rules (gross margin ≥ 40%, net margin ≥ 20%, etc.)
- Results table: Ticker | Gross Margin | Net Margin | Debt/Equity | ROE | Pass/Fail per rule
- Each ticker is clickable → loads into calculator

---

### 4. Research Page (`/research`) — Phase 3, stub now

- Same stub treatment as Screener
- Will house financial statement data pulled from FMP API
- 10-year trend charts for: Gross Margin, Net Margin, EPS, Debt/Equity, ROE
- Chart style: area/line with gradient fill, styled dots, subtle grid, `viewBox`-based responsive SVGs

---

## Charts (when implemented)

Carry over all Financinator 5000 chart conventions:
- Area/line: gradient fill under line, filled dots at data points, subtle grid
- Bar: rounded caps, subtle glow accent
- Donut: hollow center with total in center
- All SVGs: `viewBox` + `width="100%"` — never hardcoded pixel widths
- Multi-series: support overlaying multiple metrics for comparison

---

## Interaction Patterns

- **No focus loss on keystroke** in numeric inputs — explicitly guard against this in any React state update
- **5-second undo** on delete actions — no confirmation dialogs
- **Live recalculation** — results update as inputs change (debounced, not on every keystroke)
- **Drill-down** — clicking a saved valuation opens full detail
- **Verdict badge** — always visible, always semantic color-coded

---

## Security Constraints
*(Applies even though no payment data flows through this app)*

- Never read `user_id` from request body/query params — always derive from verified JWT server-side
- Every DB query must `WHERE user_id = $1` using the JWT-derived value, never a client-supplied value
- All SQL via parameterized queries — no string interpolation or template literals into queries
- No secrets in frontend JS — all API keys (FMP, etc.) server-side only via `process.env`
- Rate limit auth-adjacent endpoints
- All user-entered text (ticker names, notes) rendered via `textContent` or sanitized — never `innerHTML`
- Generic error messages to client; detailed errors logged server-side only
- CORS: never `Access-Control-Allow-Origin: *` on authenticated routes
- Before opening to other users: manually test IDOR by logging in as a second test account and attempting to read/edit the first account's saved valuations by manipulating IDs

---

## Fonts Import

```html
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
```
