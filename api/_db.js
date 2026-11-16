import './_env.js'; // must stay first: loads .env.local for vercel dev
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.NEON_DATABASE_URL);
export default sql;