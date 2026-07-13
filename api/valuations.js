import sql from './_db.js';

const USER_ID = 'local';

async function ensureTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS valuations (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'local',
      ticker TEXT NOT NULL,
      company_name TEXT,
      fcf_per_share NUMERIC NOT NULL,
      growth_rate_1_5 NUMERIC NOT NULL,
      growth_rate_6_10 NUMERIC NOT NULL,
      discount_rate NUMERIC NOT NULL,
      terminal_growth NUMERIC NOT NULL,
      margin_of_safety NUMERIC NOT NULL,
      intrinsic_value NUMERIC NOT NULL,
      safety_price NUMERIC NOT NULL,
      market_price NUMERIC,
      verdict TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
}

export default async function handler(req, res) {
  try {
    await ensureTable();

    if (req.method === 'GET') {
      const rows = await sql`
        SELECT * FROM valuations
        WHERE user_id = ${USER_ID}
        ORDER BY created_at DESC
      `;
      return res.status(200).json(rows);
    }

    if (req.method === 'POST') {
      const body = req.body || {};

      const ticker = typeof body.ticker === 'string' ? body.ticker.trim().slice(0, 20) : '';
      const companyName = typeof body.companyName === 'string' ? body.companyName.trim().slice(0, 200) : null;
      const notes = typeof body.notes === 'string' ? body.notes.slice(0, 2000) : null;

      const fcfPerShare = Number(body.fcfPerShare);
      const growthRate1_5 = Number(body.growthRate1_5);
      const growthRate6_10 = Number(body.growthRate6_10);
      const discountRate = Number(body.discountRate);
      const terminalGrowth = Number(body.terminalGrowth);
      const marginOfSafety = Number(body.marginOfSafety);
      const intrinsicValue = Number(body.intrinsicValue);
      const safetyPrice = Number(body.safetyPrice);
      const marketPrice = body.marketPrice !== undefined && body.marketPrice !== null && body.marketPrice !== ''
        ? Number(body.marketPrice)
        : null;
      const verdict = typeof body.verdict === 'string' ? body.verdict.slice(0, 30) : null;

      const numericFields = [
        fcfPerShare, growthRate1_5, growthRate6_10, discountRate,
        terminalGrowth, marginOfSafety, intrinsicValue, safetyPrice,
      ];

      if (!ticker || numericFields.some((n) => !Number.isFinite(n))) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      if (marketPrice !== null && !Number.isFinite(marketPrice)) {
        return res.status(400).json({ error: 'Invalid input' });
      }

      const rows = await sql`
        INSERT INTO valuations (
          user_id, ticker, company_name, fcf_per_share,
          growth_rate_1_5, growth_rate_6_10, discount_rate,
          terminal_growth, margin_of_safety, intrinsic_value,
          safety_price, market_price, verdict, notes
        ) VALUES (
          ${USER_ID}, ${ticker}, ${companyName}, ${fcfPerShare},
          ${growthRate1_5}, ${growthRate6_10}, ${discountRate},
          ${terminalGrowth}, ${marginOfSafety}, ${intrinsicValue},
          ${safetyPrice}, ${marketPrice}, ${verdict}, ${notes}
        )
        RETURNING *
      `;
      return res.status(201).json(rows[0]);
    }

    if (req.method === 'DELETE') {
      const id = Number(req.query?.id);
      if (!Number.isInteger(id)) {
        return res.status(400).json({ error: 'Invalid id' });
      }
      await sql`DELETE FROM valuations WHERE id = ${id} AND user_id = ${USER_ID}`;
      return res.status(204).end();
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('valuations api error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
