import sql from './_db.js';
import { requireAuth } from './_auth.js';

const USER_ID = 'local';
const MAX_JSON_CHARS = 20000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function ensureTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS reverse_dcf (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'local',
      ticker TEXT NOT NULL,
      company_name TEXT,
      price NUMERIC,
      price_date DATE,
      inputs JSONB NOT NULL,
      results JSONB NOT NULL,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function validDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    await ensureTable();

    if (req.method === 'GET') {
      const rows = await sql`
        SELECT id, ticker, company_name, price, price_date::text AS price_date, inputs, results, notes, created_at
        FROM reverse_dcf
        WHERE user_id = ${USER_ID}
        ORDER BY created_at DESC
      `;
      return res.status(200).json(rows);
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const ticker = typeof body.ticker === 'string' ? body.ticker.trim().slice(0, 20) : '';
      const companyName = typeof body.companyName === 'string' && body.companyName.trim() ? body.companyName.trim().slice(0, 200) : null;
      const notes = typeof body.notes === 'string' && body.notes.trim() ? body.notes.slice(0, 2000) : null;
      const price = Number(body.price);
      const priceDate = body.priceDate;

      if (!ticker || !Number.isFinite(price) || price <= 0 || !validDate(priceDate)) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      if (!isPlainObject(body.inputs) || !isPlainObject(body.results)) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      const inputsJson = JSON.stringify(body.inputs);
      const resultsJson = JSON.stringify(body.results);
      if (inputsJson.length > MAX_JSON_CHARS || resultsJson.length > MAX_JSON_CHARS) {
        return res.status(400).json({ error: 'Invalid input' });
      }

      const rows = await sql`
        INSERT INTO reverse_dcf (user_id, ticker, company_name, price, price_date, inputs, results, notes)
        VALUES (${USER_ID}, ${ticker}, ${companyName}, ${price}, ${priceDate}::date, ${inputsJson}::jsonb, ${resultsJson}::jsonb, ${notes})
        RETURNING id, ticker, company_name, price, price_date::text AS price_date, inputs, results, notes, created_at
      `;
      return res.status(201).json(rows[0]);
    }

    if (req.method === 'DELETE') {
      const id = Number(req.query?.id);
      if (!Number.isInteger(id)) {
        return res.status(400).json({ error: 'Invalid id' });
      }
      await sql`DELETE FROM reverse_dcf WHERE id = ${id} AND user_id = ${USER_ID}`;
      return res.status(204).end();
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('reverse api error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
