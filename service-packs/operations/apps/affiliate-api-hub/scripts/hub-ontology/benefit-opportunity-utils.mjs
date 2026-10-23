// Read-only support for benefit/opportunity. Never open credential/session stores.
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { isHttpsUrl, validateHubItem } from './contract.mjs';

export const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
export const contentRoot = path.join(repoRoot, 'apps/naver-blog-api/research/content-store');
export const clean = (value, max = 400) => typeof value === 'string' ? value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
export const https = value => isHttpsUrl(value) && !/[{}]/.test(value) ? value : null;
export const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
export const hashId = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
export const isCli = url => Boolean(process.argv[1]) && url === pathToFileURL(path.resolve(process.argv[1])).href;

// Date-only deadlines cover the entire Korean calendar day. Never interpret a
// work/contract/use period as an application deadline.
export function isoTime(value, { end = false } = {}) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/^(\d{4})\.(\d{2})\.(\d{2})\.?$/, '$1-$2-$3');
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    const midnight = new Date(`${normalized}T00:00:00Z`);
    if (!Number.isFinite(midnight.valueOf()) || midnight.toISOString().slice(0, 10) !== normalized) return null;
    return new Date(`${normalized}T${end ? '23:59:59.999' : '00:00:00.000'}+09:00`).toISOString();
  }
  // Zone-less timestamps are ambiguous; explicit offsets are required.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(normalized)) return null;
  const calendar = new Date(`${normalized.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(calendar.valueOf()) || calendar.toISOString().slice(0, 10) !== normalized.slice(0, 10)) return null;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function makeItem({ source, stableId, kind, category = 'etc', title, store, shippingNote,
  sourceUrl, postedAt, expiresAt, imageUrl, tags = [], summary = '' }) {
  if (!https(sourceUrl) || !clean(title, 300) || !isoTime(postedAt)) return null;
  const key = String(stableId ?? '');
  const item = {
    id: `${source}:${key && key.length <= 160 && !/\s/.test(key) ? key : hashId(sourceUrl)}`,
    kind, category, title: clean(title, 300), store: clean(store, 60) || null,
    priceKrw: null, shippingNote: clean(shippingNote, 60) || null,
    imageUrl: https(imageUrl), source, sourceUrl, affiliateUrl: null,
    postedAt: isoTime(postedAt), expiresAt: isoTime(expiresAt, { end: true }),
    comments: null, votes: null, views: null,
    tags: [...new Set(tags.filter(t => typeof t === 'string').map(t => clean(t, 30)).filter(Boolean))].slice(0, 12),
    summary: clean(summary, 400), ended: false,
  };
  return validateHubItem(item).length ? null : item;
}

export function finish(items, now) {
  const clock = new Date(now).valueOf();
  if (!Number.isFinite(clock)) throw new TypeError('NOW_INVALID');
  const seenId = new Set(), seenUrl = new Set();
  return items.filter(Boolean).filter(item => !item.ended && item.expiresAt && Date.parse(item.expiresAt) > clock)
    .sort((a, b) => Date.parse(b.postedAt) - Date.parse(a.postedAt) || a.id.localeCompare(b.id))
    .filter(item => {
      // Government lists legitimately use one endpoint for multiple distinct events.
      const urlKey = `${item.sourceUrl}\n${item.title}`;
      if (seenId.has(item.id) || seenUrl.has(urlKey)) return false;
      seenId.add(item.id); seenUrl.add(urlKey); return true;
    }).slice(0, 200);
}

export function anonymousFetch(report, fetchImpl = globalThis.fetch) {
  return async (input, options = {}) => {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password ||
        (options.method && options.method.toUpperCase() !== 'GET') ||
        Object.keys(options.headers ?? {}).some(k => /authorization|cookie|token/i.test(k)) ||
        [...url.searchParams.keys()].some(k => /token|key|cookie|session|password/i.test(k))) throw new Error('PUBLIC_GET_ONLY');
    const entry = { type: 'endpoint', location: url.href, checkedAt: new Date().toISOString() };
    report.push(entry);
    const response = await fetchImpl(url, { ...options, method: 'GET', credentials: 'omit', redirect: 'manual',
      signal: options.signal ?? AbortSignal.timeout(15000) });
    entry.status = response.status;
    if (response.status >= 300 && response.status < 400) throw new Error('REDIRECT_STOPPED');
    if ([401, 403, 418, 429, 503].includes(response.status)) throw new Error(`PUBLIC_HTTP_${response.status}`);
    return response;
  };
}

export async function readJson(file) {
  return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}

// Inject this transport into existing collectors whose default transport saves
// captures outside the task scope. HTML parsing remains in the existing modules.
export async function publicDocumentClient(sources, fetchImpl = globalThis.fetch) {
  const { decodeHtml } = await import('../../../naver-blog-api/research/content-store/gov-discount-events/html-public.mjs');
  const request = anonymousFetch(sources, fetchImpl);
  const counts = new Map(), last = new Map();
  return { counts, async get(url, { sourceId = 'public', pageType = 'detail' } = {}) {
    const host = new URL(url).hostname;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, 2000 - (Date.now() - (last.get(host) ?? 0)))));
    last.set(host, Date.now());
    counts.set(sourceId, (counts.get(sourceId) ?? 0) + 1);
    try {
      const response = await request(url, { headers: { 'user-agent': 'Mozilla/5.0', 'accept-language': 'ko-KR' } });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      const { html } = decodeHtml(await response.arrayBuffer(), response.headers.get('content-type'));
      if (/<title[^>]*>\s*(?:Just a moment|Access denied|Attention required|Verify you are human)/i.test(html)) throw new Error('CHALLENGE_STOPPED');
      return { status: response.status, html, url: response.url || url, requestedUrl: url, checkedAt: new Date().toISOString(), error: null };
    } catch (error) { return { url, requestedUrl: url, checkedAt: new Date().toISOString(), error: error.code ?? error.message, html: null }; }
  } };
}

// Narrow file discovery: only public-domain snapshots, never arbitrary JSON or
// credential directories. Compare the timestamp IN data, not copied-file mtime.
export async function snapshots(family, diagnostics = []) {
  const local = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'affiliate-content-operations');
  const docs = path.join(homedir(), 'Documents/Codex');
  const roots = [path.join(repoRoot, 'apps/naver-blog-api/workflow-runs'),
    ...[local, 'G:/내 드라이브/생활이득AI연구소-data', docs].filter(Boolean)];
  const names = family === 'life' ? /^(life-benefits|benefits-snapshot)\.json$/i
    : /^(opportunities|apply-opportunities)\.json$/i;
  const found = [];
  const ignored = /^(?:node_modules|\.git|\.config|\.codex|\.agents|\.aws|auth|sessions?|credentials?|.*sanitized|.*remote.*|.*integration.*|.*backup.*|captures|fixtures)$/i;
  for (const root of roots) {
    let visited = 0;
    async function walk(dir, depth) {
      if (depth > 7 || ++visited > 4000) return;
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); }
      catch (e) { if (dir === root && !['ENOENT', 'ENOTDIR'].includes(e.code)) diagnostics.push({ location: root, code: e.code }); return; }
      for (const entry of entries) {
        if (entry.isSymbolicLink() || ignored.test(entry.name) || /cookie|credential|dpapi|token|session/i.test(entry.name)) continue;
        const file = path.join(dir, entry.name);
        if (entry.isFile() && names.test(entry.name)) {
          try {
            if ((await stat(file)).size > 16 * 1024 * 1024) continue;
            const data = await readJson(file);
            const stamp = isoTime(data.checkedAt);
            if (stamp) found.push({ file, data, checkedAt: stamp });
          } catch { diagnostics.push({ location: file, code: 'SNAPSHOT_UNREADABLE' }); }
        } else if (entry.isDirectory()) {
          if (dir === docs && !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
          // Date folders contain domain jobs, not arbitrary unrelated documents.
          if (path.dirname(dir) === docs && !/benefit|opportunit|gov-discount|rental|membership|content|ontology|workflow/i.test(entry.name)) continue;
          if (dir === local && !/benefit|opportunit|research|rental|membership|content|workflow/i.test(entry.name)) continue;
          await walk(file, depth + 1);
        }
      }
    }
    await walk(root, 0);
  }
  return found.sort((a, b) => b.checkedAt.localeCompare(a.checkedAt));
}

export async function catalogRows(table) {
  if (!['housing_notices', 'benefit_programs', 'apply_opportunities'].includes(table)) throw new Error('TABLE_INVALID');
  const file = path.join(repoRoot, 'apps/content-catalog/data/catalog.db');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return { file, rows: db.prepare(`SELECT * FROM ${table} WHERE checked_at = (SELECT max(checked_at) FROM ${table})`).all() };
  } finally { db.close(); }
}

export function cliReport(kind, result) {
  console.log(JSON.stringify({ kind, count: result.items.length, samples: result.items.slice(0, 3),
    sources: result.sources, diagnostics: result.diagnostics }, null, 2));
}
