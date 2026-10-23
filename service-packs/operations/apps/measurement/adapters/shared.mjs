import { createHash } from 'node:crypto';

export const SCHEDULE = Object.freeze([
  Object.freeze({ window: '1h', offsetMs: 60 * 60 * 1000 }),
  Object.freeze({ window: '24h', offsetMs: 24 * 60 * 60 * 1000 }),
  Object.freeze({ window: '72h', offsetMs: 72 * 60 * 60 * 1000 }),
  Object.freeze({ window: '7d', offsetMs: 7 * 24 * 60 * 60 * 1000 }),
]);

export const CHANNEL_METRICS = Object.freeze({
  naver: Object.freeze(['views', 'conversions']),
  threads: Object.freeze(['impressions', 'likes', 'replies', 'reposts', 'quotes']),
  x: Object.freeze(['views', 'impressions', 'likes', 'replies', 'reposts']),
  telegram: Object.freeze(['views']),
  coupang: Object.freeze(['clicks', 'orders', 'commission']),
});

const CHANNEL_ALIASES = new Map([
  ['naver', 'naver'], ['naverblog', 'naver'], ['nblog', 'naver'], ['blog.naver.com', 'naver'],
  ['threads', 'threads'], ['threads.net', 'threads'], ['threads.com', 'threads'],
  ['x', 'x'], ['twitter', 'x'], ['t.co', 'x'], ['telegram', 'telegram'], ['t.me', 'telegram'],
  ['coupang', 'coupang'], ['coupangpartners', 'coupang'],
]);

export function normalizedChannel(value) {
  const name = String(value ?? '').trim().toLowerCase().replace(/[ _-]/g, '');
  return CHANNEL_ALIASES.get(name) ?? name;
}

export function itemIdOf(item) {
  const value = item?.itemId ?? item?.id;
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

export function publishedAtOf(item) {
  const candidates = [item?.publishedAt, item?.published_at, item?.published?.at, item?.published?.date];
  const value = candidates.find(candidate => candidate !== undefined && candidate !== null && candidate !== '');
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function dateOnly(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

export function postIdOf(item, channel = normalizedChannel(item?.channel)) {
  const refs = item?.refs && typeof item.refs === 'object' ? item.refs : {};
  const ref = refs[channel] ?? refs[channel === 'x' ? 'twitter' : channel];
  const direct = item?.postId ?? item?.post_id ?? ref?.postId ?? ref?.id ?? ref?.code;
  if (direct !== undefined && direct !== null && String(direct).trim()) return String(direct).trim();
  const rawUrl = typeof ref?.url === 'string' ? ref.url : typeof item?.url === 'string' ? item.url : '';
  try {
    const url = new URL(rawUrl);
    if (channel === 'naver') return url.searchParams.get('logNo') ?? url.pathname.match(/\/(\d{1,20})\/?$/)?.[1] ?? null;
    if (channel === 'threads') return url.pathname.match(/\/post\/([A-Za-z0-9_-]{1,64})\/?$/)?.[1] ?? null;
    if (channel === 'x') return url.pathname.match(/\/status\/(\d{1,25})\/?$/)?.[1] ?? null;
  } catch { /* A missing or relative URL does not identify a post. */ }
  return null;
}

export function finiteCount(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : null;
  }
  return null;
}

export function idempotencyKeyFor(itemId, window, metric) {
  const hash = createHash('sha256').update(`${itemId}\u0000${window}\u0000${metric}`).digest('hex');
  return `metric:${hash}`;
}

export function revenueIdempotencyKey(network, from, to, key, status, amount) {
  const hash = createHash('sha256').update([network, from, to, key ?? '', status ?? '', amount ?? ''].join('\u0000')).digest('hex');
  return `revenue:${hash}`;
}

export function safeCode(error, fallback = 'MEASUREMENT_READ_FAILED') {
  const code = error?.code ?? error?.message;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : fallback;
}

export function metric(value, { source, reason } = {}) {
  const count = finiteCount(value);
  return { value: count, source, ...(count === null && reason ? { reason } : {}) };
}

export function itemNetworks(items, deps = {}) {
  const enabled = new Set(Array.isArray(deps.revenueNetworks) ? deps.revenueNetworks.map(v => String(v).toLowerCase()) : []);
  const known = ['myrealtrip', 'linkprice', 'coupang'];
  const addFrom = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const row of value) {
        if (typeof row === 'string' && known.includes(row.toLowerCase())) enabled.add(row.toLowerCase());
        else if (row && typeof row === 'object') addFrom(row);
      }
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      const name = key.toLowerCase().replace(/[^a-z]/g, '');
      if (known.some(network => name.includes(network))) enabled.add(known.find(network => name.includes(network)));
      if (typeof child === 'string' && known.includes(child.toLowerCase())) enabled.add(child.toLowerCase());
      if (child && typeof child === 'object') addFrom(child);
    }
  };
  for (const item of items) {
    addFrom(item?.refs);
    addFrom(item?.affiliateNetworks);
    addFrom(item?.affiliateLinks);
    if (known.includes(String(item?.network ?? '').toLowerCase())) enabled.add(String(item.network).toLowerCase());
  }
  return [...enabled].filter(network => known.includes(network)).sort();
}
