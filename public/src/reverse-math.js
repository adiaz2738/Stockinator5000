// Pure maths for the Reverse DCF page (no DOM). Rates are decimals here (0.10 = 10%).
// Panel A reuses calculateDCF from the forward calculator, so both pages share one engine.
import { calculateDCF } from './dcf.js';

export const G_MIN = -0.2;
export const G_MAX = 0.6;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// Intrinsic value per share for a constant growth rate g over years 1-10 (net cash added undiscounted).
export function valueAtGrowth({ fcf, g, r, tg, netCash = 0 }) {
  return calculateDCF({
    fcfPerShare: fcf,
    growthRate1_5: g * 100,
    growthRate6_10: g * 100,
    discountRate: r * 100,
    terminalGrowth: tg * 100,
    marginOfSafety: 0,
    netCashPerShare: netCash,
  }).intrinsicValue;
}

// Constant annual growth that makes the DCF value equal `target`. Bisection over [-20%, +60%].
// Returns { ok: true, g } or { ok: false, reason } with a plain-English reason. Never a guessed number.
export function solveImpliedGrowth({ fcf, r, tg, netCash = 0, target }) {
  if (![fcf, r, tg, target].every(isNum) || !isNum(netCash)) return { ok: false, reason: 'A required input is missing or not a number.' };
  if (fcf <= 0) return { ok: false, reason: 'Starting FCF/share is zero or negative, so growth on it cannot explain a positive price.' };
  if (r <= tg) return { ok: false, reason: 'The discount rate must be greater than terminal growth.' };
  if (target <= 0) return { ok: false, reason: 'The target price is not positive.' };

  const f = (g) => valueAtGrowth({ fcf, g, r, tg, netCash });
  const vLo = f(G_MIN);
  const vHi = f(G_MAX);
  if (target < vLo) return { ok: false, reason: `No solution in range: even ${G_MIN * 100}% a year growth values the stock above this price.` };
  if (target > vHi) return { ok: false, reason: `No solution in range: even +${G_MAX * 100}% a year growth values the stock below this price.` };

  let lo = G_MIN;
  let hi = G_MAX;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < target) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-13) break;
  }
  return { ok: true, g: (lo + hi) / 2 };
}

export const SENSITIVITY_GROWTH = [0, 0.03, 0.05, 0.08, 0.10];
export const SENSITIVITY_DISCOUNT = [0.08, 0.10, 0.12];

// Everything Panel A shows for one starting FCF/share.
export function panelA({ fcf, price, netCash, r, tg, mos }) {
  const base = { r, tg, netCash, fcf };
  const atPrice = solveImpliedGrowth({ ...base, target: price });
  const mosTarget = isNum(price) && isNum(mos) && mos < 1 ? price / (1 - mos) : NaN;
  const forMos = solveImpliedGrowth({ ...base, target: mosTarget });
  const valid = isNum(fcf) && fcf > 0 && isNum(r) && isNum(tg) && r > tg;
  const values = SENSITIVITY_GROWTH.map((g) => ({ g, value: valid ? valueAtGrowth({ fcf, g, r, tg, netCash }) : null }));
  const byDiscount = SENSITIVITY_DISCOUNT.map((rate) => ({
    r: rate,
    solved: solveImpliedGrowth({ fcf, r: rate, tg, netCash, target: price }),
  }));
  return { atPrice, forMos, mosTarget, values, byDiscount };
}

// Panel B: every step, so the page can write each one out with its numbers.
// All dollar amounts and share counts must be in the same unit (the units selector only labels them).
export function panelB({ price, shares, debt, other, cash, g, r, tax, mos, revenue, operatingIncome, capex, depreciation }) {
  const need = [price, shares, debt, other, cash, g, r, tax];
  if (!need.every(isNum)) return { ok: false, reason: 'missing', message: 'Fill in price, shares, cash, debt, other obligations, growth, discount rate and tax rate.' };
  if (r <= g) return { ok: false, reason: 'rate', message: 'The discount rate must be greater than the growth input.' };
  if (tax >= 1) return { ok: false, reason: 'tax', message: 'Tax rate must be below 100%.' };

  const marketCap = price * shares;
  const ev = marketCap + debt + other - cash;
  const out = { ok: true, marketCap, ev, multiple: (1 + g) / (r - g) };

  const capexRatio = isNum(capex) && isNum(depreciation) && depreciation !== 0 ? Math.abs(capex) / Math.abs(depreciation) : null;
  out.capexRatio = capexRatio;
  out.capexWarning = capexRatio !== null && (capexRatio < 0.5 || capexRatio > 2.0);

  if (ev <= 0) return { ...out, evPositive: false };
  out.evPositive = true;
  out.requiredFcf = ev / out.multiple;
  out.requiredOperatingIncome = out.requiredFcf / (1 - tax);

  const haveRevenue = isNum(revenue) && revenue > 0;
  out.requiredMargin = haveRevenue ? out.requiredOperatingIncome / revenue : null;
  out.requiredMarginMos = out.requiredMargin !== null && isNum(mos) && mos < 1 ? out.requiredMargin / (1 - mos) : null;
  out.actualMargin = haveRevenue && isNum(operatingIncome) ? operatingIncome / revenue : null;

  if (out.actualMargin === null || out.requiredMargin === null) out.comparison = null;
  else if (out.requiredMarginMos !== null && out.actualMargin >= out.requiredMarginMos) out.comparison = 'cushion';
  else if (out.actualMargin >= out.requiredMargin) out.comparison = 'between';
  else out.comparison = 'below';
  return out;
}
