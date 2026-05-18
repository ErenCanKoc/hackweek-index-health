import crypto from 'node:crypto';

const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'gclid',
  'fbclid',
  'msclkid',
  'yclid',
  '_hsenc',
  '_hsmi'
]);

export function nowIso() {
  return new Date().toISOString();
}

export function dateKey(value = new Date()) {
  return new Date(value).toISOString().slice(0, 10);
}

export function addDays(value, days) {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

export function addHours(value, hours) {
  const date = new Date(value);
  date.setUTCHours(date.getUTCHours() + hours);
  return date.toISOString();
}

export function daysBetween(start, end = new Date()) {
  return Math.floor((new Date(end) - new Date(start)) / 86400000);
}

export function stableHash(input) {
  return crypto.createHash('sha1').update(String(input)).digest('hex');
}

export function hashNumber(input) {
  return Number.parseInt(stableHash(input).slice(0, 8), 16);
}

export function monthBucketDay(input) {
  return (hashNumber(input) % 30) + 1;
}

export function normalizeUrl(input) {
  if (!input || typeof input !== 'string') {
    throw new Error('URL is required');
  }

  const candidate = input.trim();
  const withProtocol = candidate.startsWith('http://') || candidate.startsWith('https://')
    ? candidate
    : `https://${candidate}`;
  const url = new URL(withProtocol);

  url.protocol = 'https:';
  url.hostname = url.hostname.toLowerCase();
  url.hash = '';

  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase()) || key.toLowerCase().startsWith('utm_')) {
      url.searchParams.delete(key);
    }
  }

  const sortedParams = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  url.search = '';
  for (const [key, value] of sortedParams) {
    url.searchParams.append(key, value);
  }

  url.pathname = url.pathname.replace(/\/{2,}/g, '/');

  return url.toString();
}

export function pathFromUrl(input) {
  if (!input) return '/';
  return new URL(normalizeUrl(input)).pathname || '/';
}

export function urlFromPath(path) {
  if (!path) return 'https://www.jotform.com/';
  if (path.startsWith('http://') || path.startsWith('https://')) return normalizeUrl(path);
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return normalizeUrl(`https://www.jotform.com${normalizedPath}`);
}

export function parseCsv(text) {
  const rows = [];
  let current = '';
  let row = [];
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      row.push(current.trim());
      current = '';
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(current.trim());
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      current = '';
    } else {
      current += char;
    }
  }

  if (current || row.length) {
    row.push(current.trim());
    if (row.some((value) => value !== '')) rows.push(row);
  }

  const [headers, ...records] = rows;
  if (!headers) return [];
  return records.map((record) => Object.fromEntries(headers.map((header, index) => [header, record[index] ?? ''])));
}

export function pickPercentile(values, percentile) {
  const numeric = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!numeric.length) return 0;
  const index = Math.min(numeric.length - 1, Math.ceil((percentile / 100) * numeric.length) - 1);
  return numeric[index];
}

export function trimmedMean(values, trimRatio = 0.1) {
  const numeric = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!numeric.length) return 0;
  const trim = Math.floor(numeric.length * trimRatio);
  const trimmed = numeric.slice(trim, numeric.length - trim || numeric.length);
  return trimmed.reduce((sum, value) => sum + value, 0) / trimmed.length;
}

export function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}
