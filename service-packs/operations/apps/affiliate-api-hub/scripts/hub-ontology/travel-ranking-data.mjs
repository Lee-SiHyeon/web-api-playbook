// Read-only support for travel/ranking. Never imports an authenticated client.
import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isHttpsUrl, validateHubItem } from './contract.mjs';

export const REPO = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
export const LOCAL = join(process.env.LOCALAPPDATA ?? join(REPO, '.unavailable-local-data'), 'affiliate-content-operations');
const USER = process.env.LOCALAPPDATA ? resolve(process.env.LOCALAPPDATA, '../..') : null;
export const CODEX = USER ? join(USER, 'Documents', 'Codex') : null;
export const DRIVE = 'G:/내 드라이브/생활이득AI연구소-data';
const SENSITIVE = /credential|cookie|token|secret|session|dpapi|auth|capture|netlog|profile|browser/i;
const SKIP_DIR = /^(?:node_modules|\.git|fixtures|tests|images|renders|superseded.*|.*backup.*)$/i;
const NAMES = {
  travel: /^(?:travel-deals.*|check-travel.*|flight(?:s|-deals|-check|-prices).*|hotdeals?.*|myrealtrip(?:-products)?|tna-search.*|naver-connect|seller-deals|naver-crawler|travel-price.*|ttang.*)\.json$/i,
  ranking: /^(?:oy-ranking|ranking(?:s|-.*)?|beauty-rank.*|toss-(?:openapi-)?best.*|coupang-best.*|best-selling.*|hwahae-ranking.*|oliveyoung-ranking.*)\.json$/i,
};

export const text = (value, max) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
export function https(value) { return isHttpsUrl(value) ? value : null; }
export function integer(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = typeof value === 'string' && /^\d[\d,]*$/.test(value) ? Number(value.replaceAll(',', '')) : value;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
export function iso(value, { endOfDay = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let s = value.trim();
  if (/^\d{8}$/.test(s)) s = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += endOfDay ? 'T23:59:59.999+09:00' : 'T00:00:00+09:00';
  else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(s)) s = s.replace(' ', 'T') + '+09:00';
  else if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(s)) return null;
  const time = Date.parse(s);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
export function observation(row = {}, fallback) {
  return iso(row.checkedAt) ?? iso(row.observedAt) ?? iso(row.collectedAt) ?? iso(row.fetchedAt) ?? iso(row.generatedAt) ?? iso(fallback);
}
export function recent(at, now, hours) {
  const age = now.getTime() - Date.parse(at);
  return Number.isFinite(age) && age >= -300_000 && age <= hours * 3600_000;
}
export function stableId(source, value) {
  const key = String(value ?? '');
  return `${source}:${key && key.length <= 160 && !/\s/.test(key) ? key : createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
}
export function tags(values) { return [...new Set(values.map(v => text(v, 30)).filter(Boolean))].slice(0, 12); }
export function currentItems(items, now, limit = 200) {
  const seen = new Set();
  return items.filter(Boolean).sort((a, b) => Date.parse(b.postedAt) - Date.parse(a.postedAt))
    .filter(item => !item.ended && (!item.expiresAt || Date.parse(item.expiresAt) > now.getTime())
      && validateHubItem(item).length === 0 && !seen.has(item.id) && seen.add(item.id)).slice(0, Math.min(limit, 200));
}

// No cookie jar, authorization headers, login, redirects to auth, or GraphQL mutations.
// CLI collectors are GET-only, including requests injected into existing readers.
export function publicFetch(fetchImpl = globalThis.fetch, receipts = []) {
  return async (input, init = {}) => {
    const url = new URL(String(input));
    const method = String(init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    if (url.protocol !== 'https:' || url.username || url.password || headers.has('cookie') || headers.has('authorization')
      || [...url.searchParams.keys()].some(k => /token|secret|password|api[-_]?key/i.test(k))) throw Object.assign(new Error('PUBLIC_READ_ONLY'), { code: 'PUBLIC_READ_ONLY' });
    if (method !== 'GET') throw Object.assign(new Error('PUBLIC_READ_ONLY'), { code: 'PUBLIC_READ_ONLY' });
    const receipt = { endpoint: url.href, method, checkedAt: new Date().toISOString(), status: null };
    receipts.push(receipt);
    const response = await fetchImpl(input, { ...init, credentials: 'omit', signal: AbortSignal.any([AbortSignal.timeout(25_000), ...(init.signal ? [init.signal] : [])]) });
    receipt.status = response.status;
    return response;
  };
}

async function directories(root, pattern) {
  if (!root) return [];
  try { return (await readdir(root, { withFileTypes: true })).filter(e => e.isDirectory() && pattern.test(e.name)).map(e => join(root, e.name)).sort().reverse().slice(0, 16); }
  catch { return []; }
}
export async function defaultRoots(vertical) {
  return [
    ...[vertical, 'quick-fact', 'x-quickfact-workspace', ...(vertical === 'ranking' ? ['oy-top5', 'toss-openapi', 'coupang-partners'] : ['travel-price'])].map(d => join(LOCAL, d)),
    DRIVE,
    ...await directories(CODEX, /^\d{4}-\d{2}-\d{2}$/),
    ...await directories(join(REPO, 'apps/naver-blog-api/workflow-runs'), /^(?:scan-|daily-|content-store-)/),
  ];
}
export async function readSnapshots(vertical, roots = null) {
  const files = [];
  async function walk(dir, depth = 0) {
    if (depth > 6) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SENSITIVE.test(e.name)) continue;
      const file = join(dir, e.name);
      if (e.isDirectory() && !SKIP_DIR.test(e.name)) await walk(file, depth + 1);
      else if (e.isFile() && NAMES[vertical].test(e.name)) {
        const info = await stat(file);
        if (info.size <= 16 * 1024 * 1024) files.push({ file, mtime: info.mtime.toISOString() });
      }
    }
  }
  for (const root of roots ?? await defaultRoots(vertical)) await walk(root);
  const docs = [];
  for (const entry of files.sort((a, b) => b.mtime.localeCompare(a.mtime)).slice(0, 80)) {
    try { docs.push({ ...entry, name: basename(entry.file), data: JSON.parse((await readFile(entry.file, 'utf8')).replace(/^\uFEFF/, '')) }); } catch { /* incomplete output is not a source */ }
  }
  return docs;
}
export async function issuedTravelLinks() {
  const file = join(LOCAL, 'travel-links', 'links.json');
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    const links = {};
    for (const [target, entry] of Object.entries(data.links ?? {})) if (https(target) && https(entry.url) && entry.state !== 'uncertain' && observation({ checkedAt: entry.createdAt })) links[target] = entry.url;
    return { links, file };
  } catch { return { links: {}, file: null }; }
}
export function dryRun(vertical, items, diagnostics) {
  console.log(JSON.stringify({ vertical, count: items.length, samples: items.slice(0, 3), ...diagnostics }, null, 2));
}
