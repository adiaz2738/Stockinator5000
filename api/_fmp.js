const FMP_BASE_URL = 'https://financialmodelingprep.com/stable';

export async function fmpFetch(path) {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) {
    throw new Error('FMP_API_KEY is not configured');
  }

  const separator = path.includes('?') ? '&' : '?';
  const url = `${FMP_BASE_URL}${path}${separator}apikey=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`FMP request failed with status ${res.status}`);
  }
  return res.json();
}
