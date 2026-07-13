export function calculateDCF(inputs) {
  const {
    fcfPerShare,
    growthRate1_5,
    growthRate6_10,
    discountRate,
    terminalGrowth,
    marginOfSafety,
  } = inputs;

  const g1 = growthRate1_5 / 100;
  const g2 = growthRate6_10 / 100;
  const r = discountRate / 100;
  const tg = terminalGrowth / 100;
  const mos = marginOfSafety / 100;

  const rows = [];
  let fcf = fcfPerShare;
  let totalPV = 0;

  for (let year = 1; year <= 10; year++) {
    const growth = year <= 5 ? g1 : g2;
    fcf = fcf * (1 + growth);
    const discountFactor = 1 / Math.pow(1 + r, year);
    const pv = fcf * discountFactor;
    totalPV += pv;
    rows.push({ year, fcf, discountFactor, pv });
  }

  const year10FCF = rows[9].fcf;
  const terminalValue = (year10FCF * (1 + tg)) / (r - tg);
  const discountedTerminalValue = terminalValue / Math.pow(1 + r, 10);

  const intrinsicValue = totalPV + discountedTerminalValue;
  const safetyPrice = intrinsicValue * (1 - mos);

  let verdict = 'FAIRLY VALUED';
  const marketPrice = inputs.marketPrice;
  if (Number.isFinite(marketPrice)) {
    if (marketPrice < safetyPrice) verdict = 'UNDERVALUED';
    else if (marketPrice > intrinsicValue) verdict = 'OVERVALUED';
    else verdict = 'FAIRLY VALUED';
  }

  return {
    rows,
    totalPV,
    terminalValue,
    discountedTerminalValue,
    intrinsicValue,
    safetyPrice,
    verdict,
  };
}
