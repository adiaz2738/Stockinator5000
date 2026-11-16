import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Local development only: load .env.local into process.env so `vercel dev` works without renaming it to .env.
// Never overrides a variable that is already set, and does nothing on Vercel (.env.local is gitignored, so it
// isn't deployed). Values are taken literally: no `$VAR` expansion, so passwords may contain `$`.
// Imported first by _db.js and _auth.js, so every route gets it.

// Look next to the project root (this file's parent folder) and in the working directory.
const candidates = [
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env.local'),
  path.join(process.cwd(), '.env.local'),
];
const file = candidates.find((f) => fs.existsSync(f));
// `vercel dev` sets VERCEL_ENV=development (and VERCEL_URL=localhost), so only skip real deployments.
const deployed = process.env.VERCEL_ENV === 'production' || process.env.VERCEL_ENV === 'preview';

if (!deployed && file) {
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
    if (process.env[key] === undefined || process.env[key] === '') process.env[key] = value;
  }
}
