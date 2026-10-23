import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateHubItem } from './contract.mjs';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export const CONTENT_STORE = path.join(REPO, 'apps/naver-blog-api/research/content-store');
export const LOCAL_ROOT = path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData/Local'), 'affiliate-content-operations');
export const CODEX_ROOT = path.join(homedir(), 'Documents/Codex');
export const DRIVE_ROOT = 'G:/내 드라이브/생활이득AI연구소-data';
export const DAY = 864e5;

export const text = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
export const hash = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
export const iso = value => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
};
export function publicUrl(value) {
  const url = text(value).replace(/&amp;/g, '&');
  if (!url || /\s/.test(url)) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname && !parsed.username && !parsed.password ? url : null;
  } catch { return null; }
}
export function oneLine(value, fallback = '') {
  const line = text(value || fallback).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return text(line).match(/^.*?[.!?。](?=\s|$)/)?.[0]?.slice(0, 400) ?? text(line).slice(0, 400);
}
export function recent(value, now, days) {
  const at = iso(value);
  return at !== null && Date.parse(at) <= now.getTime() && Date.parse(at) >= now.getTime() - days * DAY;
}
export function hubItem({ source, stableId, kind, title, sourceUrl, postedAt, expiresAt = null,
  store = null, summary = '', shippingNote = null, imageUrl = null, category = 'etc', tags = [], ended = false }) {
  sourceUrl = publicUrl(sourceUrl);
  postedAt = iso(postedAt);
  const deadline = expiresAt === null ? null : iso(expiresAt);
  if (!sourceUrl || !postedAt || !text(title) || (expiresAt !== null && !deadline)) return null;
  const item = {
    id: `${source}:${hash(stableId ?? sourceUrl)}`, kind, category, title: text(title).slice(0, 300),
    store: text(store).slice(0, 60) || null, priceKrw: null, shippingNote: text(shippingNote).slice(0, 60) || null,
    imageUrl: publicUrl(imageUrl), source, sourceUrl, affiliateUrl: null, postedAt, expiresAt: deadline,
    comments: null, votes: null, views: null,
    tags: [...new Set(tags.filter(tag => typeof tag === 'string').map(tag => text(tag).slice(0, 30)).filter(Boolean))].slice(0, 12),
    summary: oneLine(summary, title), ended: Boolean(ended),
  };
  return validateHubItem(item).length ? null : item;
}
export function finalize(items, { now, days, dedupeTopics = false }) {
  const ids = new Set(), urls = new Set(), topics = new Set();
  return items.filter(Boolean).filter(item => !validateHubItem(item).length && !item.ended
    && (item.expiresAt === null || Date.parse(item.expiresAt) > now.getTime())
    && recent(item.postedAt, now, days))
    .sort((a, b) => Date.parse(b.postedAt) - Date.parse(a.postedAt) || a.id.localeCompare(b.id))
    .filter(item => {
      const topic = item.title.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
      if (ids.has(item.id) || urls.has(item.sourceUrl) || (dedupeTopics && topics.has(topic))) return false;
      ids.add(item.id); urls.add(item.sourceUrl); topics.add(topic); return true;
    }).slice(0, 200);
}
export function newest(values) {
  return values.map(iso).filter(Boolean).sort().at(-1) ?? null;
}
export async function readData(file) {
  if (typeof file !== 'string' || !/\.(?:json|jsonl|ndjson)$/i.test(file)
    || /(?:^|[\\/])[^\\/]*(?:protected|credential|cookie|token|session|dpapi)[^\\/]*(?:[\\/]|$)/i.test(file)) return null;
  try {
    if (/\.(jsonl|ndjson)$/i.test(file)) {
      // Public ledgers only; retain a bounded tail and tolerate a partial last line.
      const { open } = await import('node:fs/promises');
      const handle = await open(file, 'r');
      try {
        const size = (await handle.stat()).size, length = Math.min(size, 4_000_000), bytes = Buffer.alloc(length);
        await handle.read(bytes, 0, length, size - length);
        const lines = bytes.toString('utf8').split('\n');
        if (size > length) lines.shift();
        return lines.filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      } finally { await handle.close(); }
    }
    if ((await stat(file)).size > 8_000_000) return null;
    return JSON.parse(await readFile(file, 'utf8'));
  } catch { return null; }
}
// Discovery lists names only. Only explicitly selected public data files are opened by callers.
export async function dataFiles(root, accepts, { depth = 4, limit = 60 } = {}) {
  const found = [];
  async function walk(dir, remaining) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (/node_modules|^\.git$|protected|credential|cookie|token|session|dpapi|browser|profile|deps/i.test(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && remaining > 0) await walk(file, remaining - 1);
      else if (entry.isFile() && accepts(file)) {
        try { found.push({ file, mtime: (await stat(file)).mtime.toISOString() }); } catch { /* inaccessible file */ }
      }
    }
  }
  await walk(root, depth);
  return found.sort((a, b) => b.mtime.localeCompare(a.mtime)).slice(0, limit);
}
export function readOnlyFetch(fetchImpl = globalThis.fetch) {
  return async (url, options = {}) => {
    if (!publicUrl(String(url)) || (options.method && options.method !== 'GET')) throw Object.assign(new Error('PUBLIC_GET_ONLY'), { code: 'PUBLIC_GET_ONLY' });
    if ([...new Headers(options.headers).keys()].some(key => /cookie|authorization/i.test(key))) throw Object.assign(new Error('NO_AUTH_HEADERS'), { code: 'NO_AUTH_HEADERS' });
    const timeout = AbortSignal.timeout(15000);
    return fetchImpl(url, { ...options, method: 'GET', credentials: 'omit', signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout });
  };
}
export const errorCode = error => /^[A-Z_0-9:-]+$/.test(error?.code ?? '') ? error.code : 'PUBLIC_READ_FAILED';
export function cliReport(result) {
  return { count: result.items.length, samples: result.items.slice(0, 3), sources: result.sources,
    newestTimestamp: newest(result.items.map(item => item.postedAt)), warnings: result.warnings };
}
