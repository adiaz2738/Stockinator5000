# ValueLens — Project Setup Instructions

---

## Prerequisites

Make sure these are installed before starting:
- Node.js (v18+): `node -v`
- npm: `npm -v`
- Git: `git --version`
- Vercel CLI: `npm install -g vercel`

---

## 1. Local Folder & Git Init

```bash
# Create the project folder
mkdir valuelens
cd valuelens

# Initialize git
git init

# Create a .gitignore immediately — before any other files
cat > .gitignore << 'EOF'
node_modules/
.env
.env.local
.vercel
.DS_Store
EOF
```

**Why `.gitignore` first:** Your `.env` file will contain your Neon connection string and FMP API key. If you create it before `.gitignore` exists, there's a risk of accidentally committing it. Create `.gitignore` before touching any env files.

---

## 2. Project Structure

```
valuelens/
├── .gitignore
├── .env.local          # never committed
├── package.json
├── vercel.json         # routing config
├── public/
│   └── index.html      # or your entry point
├── api/
│   ├── _db.js          # Neon connection (server-side only)
│   ├── _auth.js        # JWT verification (when auth is added)
│   ├── valuations.js   # GET/POST saved valuations
│   └── calculate.js    # DCF calculation endpoint (optional server-side)
└── src/
    ├── calculator.js
    ├── valuations.js
    └── styles.css
```

---

## 3. Initialize npm & Install Dependencies

```bash
npm init -y

# Database client
npm install @neondatabase/serverless

# For future: API routes on Vercel use Node runtime by default
# No framework needed unless you choose one
```

---

## 4. GitHub Repo

```bash
# On GitHub: create a new repo named "valuelens" (or your chosen name)
# Do NOT initialize with README (you already have local files)

# Back in terminal:
git remote add origin https://github.com/YOUR_USERNAME/valuelens.git
git branch -M main

# Stage and commit initial structure
git add .
git commit -m "initial project setup"
git push -u origin main
```

**Confirm your `.env.local` is NOT staged:**
```bash
git status
# .env.local should not appear in the list
```

---

## 5. Neon Database Setup

1. Go to [neon.tech](https://neon.tech) and sign in
2. Create a new project: "valuelens"
3. Create a database (default "neondb" is fine)
4. Copy the **connection string** — it looks like:
   ```
   postgresql://username:password@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```
5. Add to `.env.local`:
   ```
   DATABASE_URL=postgresql://username:password@...neon.tech/neondb?sslmode=require
   ```

### Run the schema

In Neon's SQL editor (or any Postgres client connected to your Neon DB):

```sql
CREATE TABLE valuations (
  id                SERIAL PRIMARY KEY,
  user_id           TEXT NOT NULL DEFAULT 'local',
  ticker            TEXT NOT NULL,
  company_name      TEXT,
  fcf_per_share     NUMERIC NOT NULL,
  growth_rate_1_5   NUMERIC NOT NULL,
  growth_rate_6_10  NUMERIC NOT NULL,
  discount_rate     NUMERIC NOT NULL,
  terminal_growth   NUMERIC NOT NULL,
  margin_of_safety  NUMERIC NOT NULL,
  intrinsic_value   NUMERIC NOT NULL,
  safety_price      NUMERIC NOT NULL,
  market_price      NUMERIC,
  verdict           TEXT,
  notes             TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast lookup by user
CREATE INDEX idx_valuations_user_id ON valuations(user_id);
```

*Note: `user_id` defaults to `'local'` for single-user mode. When auth is added, this will be populated from the JWT.*

---

## 6. Neon DB Connection File

Create `api/_db.js`:

```js
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
export default sql;
```

**Rule:** This file is server-side only. Never import it from frontend JS. Never expose `DATABASE_URL` to the client.

---

## 7. Vercel Setup

```bash
# Login to Vercel
vercel login

# Initialize Vercel in your project
vercel

# Follow prompts:
# - Link to existing project? No (first time)
# - Project name: valuelens
# - Directory: ./
# - Auto-detect framework: Yes (or No + configure manually)
```

### Add environment variables to Vercel

```bash
vercel env add DATABASE_URL
# Paste your Neon connection string when prompted
# Add to: Production, Preview, Development
```

Or add via Vercel dashboard: Settings → Environment Variables.

### Deploy

```bash
# Preview deploy (test before production)
vercel

# Production deploy
vercel --prod
```

---

## 8. vercel.json (Routing Config)

```json
{
  "rewrites": [
    { "source": "/api/(.*)", "destination": "/api/$1" },
    { "source": "/(.*)", "destination": "/public/index.html" }
  ]
}
```

Adjust paths based on your actual folder structure.

---

## 9. FMP API Key Setup

1. Go to [financialmodelingprep.com](https://financialmodelingprep.com)
2. Sign up for free tier (250 calls/day, 5 years of data)
3. Copy your API key
4. Add to `.env.local`:
   ```
   FMP_API_KEY=your_key_here
   ```
5. Add to Vercel environment variables (same as DATABASE_URL step above)

**Rule:** FMP API key is used server-side only, in `api/` routes. Never reference it in frontend JS or expose it in any client-side bundle.

---

## 10. Ongoing Workflow

```bash
# Normal development loop
git add .
git commit -m "describe what you built"
git push

# Vercel auto-deploys on push to main (once connected)
# Or deploy manually: vercel --prod
```

---

## 11. Security Checklist Before Adding Any Users

Run through this before opening the app to anyone else:

- [ ] `.env.local` is in `.gitignore` and never appears in `git status`
- [ ] `DATABASE_URL` and `FMP_API_KEY` are set as Vercel env vars, not hardcoded anywhere
- [ ] Every `api/` route that queries the DB filters `WHERE user_id = $1` using a server-derived value, not a client-supplied param
- [ ] All SQL uses `$1, $2` parameterized placeholders — grep for template literals in queries: `` `SELECT ... ${` `` should not appear
- [ ] Any user-entered text (ticker, notes) is rendered via `textContent` in JS, never `innerHTML`
- [ ] API error responses return generic messages to the client; detailed errors are `console.error` server-side only
- [ ] Run `npm audit` and address any high-severity findings
- [ ] Manually test: log in as a second test user and try to access the first user's saved valuations by manipulating IDs in requests

---

## 12. Useful Commands Reference

```bash
# Check what's staged for commit (confirm .env.local is absent)
git status

# View Vercel logs
vercel logs

# Pull remote env vars to local (useful after adding new vars in dashboard)
vercel env pull .env.local

# Run npm audit
npm audit

# Check Node version
node -v
```
