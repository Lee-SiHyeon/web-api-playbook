import { createHash } from 'node:crypto';
import { assertStatus, fetchText } from '../trend-radar/lib/http.mjs';

// First-party release sources for the frontier model families whose vendors publish no RSS feed.
// Each adapter is config-free: `async (limit, { fetchImpl }) -> { items, receipt }` (see collect.mjs ADAPTERS).
//   anthropic_sitemap    anthropic.com sitemap: versioned top-level launch pages (/claude-sonnet-5-5, no lastmod) and /news, /research by lastmod
//   deepseek_docs_news   api-docs.deepseek.com sitemap: /news/newsYYMMDD pages, the date is in the slug
//   hf_qwen_models       huggingface.co/api/models?author=Qwen (x.ai is Cloudflare-blocked and Qwen's blog feed is stale)
//   hf_deepseek_models   huggingface.co/api/models?author=deepseek-ai
const MAX_SITEMAP_BYTES = 2_000_000;
const MAX_PAGE_BYTES = 3_000_000;
const MAX_PAGES = 8;
const PAGE_CONCURRENCY = 4;
const fail = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });
const sha = text => createHash('sha256').update(text).digest('hex');
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

const decode = text => String(text ?? '')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();

function validateLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1) throw fail('SOURCE_LIMIT');
}

// Docs sites redirect to a trailing slash; follow at most two redirects and only within the same https origin.
async function getText(url, fetchImpl, { accept, maxBytes }) {
  let current = new URL(url);
  for (let hops = 0; ; hops++) {
    const { response, text } = await fetchText(current.href, { fetchImpl, attempts: 1, timeoutMs: 12000, headers: { accept } });
    if ([301, 302, 307, 308].includes(response.status)) {
      const location = response.headers?.get?.('location');
      const next = location ? new URL(location, current) : null;
      if (!next || hops >= 2 || next.origin !== current.origin || next.protocol !== 'https:') throw fail('REDIRECT');
      current = next;
      continue;
    }
    assertStatus(response);
    if (Buffer.byteLength(text) > maxBytes) throw fail('SOURCE_TOO_LARGE');
    return { response, text };
  }
}

export function sitemapEntries(xml) {
  if (typeof xml !== 'string' || !/<urlset[\s>]/i.test(xml) || /<!ENTITY/i.test(xml)) throw fail('SITEMAP_SCHEMA');
  return [...xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)].map(m => ({
    loc: decode(m[1].match(/<loc>([^<]*)<\/loc>/i)?.[1]),
    lastmod: decode(m[1].match(/<lastmod>([^<]*)<\/lastmod>/i)?.[1]) || null,
  })).filter(e => e.loc);
}

function metaContent(html, attribute, name) {
  const tag = html.match(new RegExp(`<meta\\s[^>]*${attribute}=["']${name}["'][^>]*>`, 'i'))?.[0];
  const value = tag?.match(/content=(?:"([^"]*)"|'([^']*)')/i);
  return decode(value?.[1] ?? value?.[2] ?? '');
}

function pageTitle(html, suffix) {
  const og = metaContent(html, 'property', 'og:title');
  if (og) return og.replace(suffix, '').trim();
  return decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]).replace(suffix, '').trim();
}

// A day without a time of day sits at noon UTC, so it is off by at most half a day either way.
const noonUtc = (year, month, day) => {
  const at = Date.UTC(year, month - 1, day, 12);
  const date = new Date(at);
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.toISOString() : null;
};

const ANTHROPIC_HOST = 'https://www.anthropic.com';
const ANTHROPIC_SITEMAP = `${ANTHROPIC_HOST}/sitemap.xml`;

export function anthropicCandidates(entries, limit) {
  const under = pattern => entries.filter(e => pattern.test(e.loc));
  // Launch pages carry a version and no lastmod; /claude-corps and the like have no digit.
  const launches = under(/^https:\/\/www\.anthropic\.com\/claude-[a-z0-9-]*\d[a-z0-9-]*$/);
  const dated = under(/^https:\/\/www\.anthropic\.com\/(news|research)\/[a-z0-9-]+$/)
    .filter(e => Number.isFinite(Date.parse(e.lastmod)))
    .sort((a, b) => Date.parse(b.lastmod) - Date.parse(a.lastmod));
  return [...launches, ...dated].slice(0, Math.min(limit, MAX_PAGES)).map(e => e.loc);
}

const DATE_TEXT = /\b(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (\d{4})\b/;
const dateText = match => {
  const month = match ? MONTHS.indexOf(match[1].toLowerCase()) + 1 : 0;
  return month ? noonUtc(Number(match[3]), month, Number(match[2])) : null;
};

export function parseAnthropicPage(html, url, { now = Date.now() } = {}) {
  const title = pageTitle(html, /\s*[\\|]\s*Anthropic\s*$/i);
  if (!title) throw fail('ANTHROPIC_PAGE_SCHEMA');
  let publishedAt = null; let precision = null;
  const instant = Date.parse(metaContent(html, 'property', 'article:published_time'));
  if (Number.isFinite(instant)) { publishedAt = new Date(instant).toISOString(); precision = 'instant'; }
  else {
    // Launch pages print the date in an eyebrow line; the older template only has it in the running text.
    const eyebrow = html.match(/class="eyebrow"[^>]*>\s*([A-Za-z]+ \d{1,2}, \d{4})\s*</)?.[1];
    publishedAt = dateText(eyebrow?.match(DATE_TEXT)) ?? dateText(html.match(DATE_TEXT));
    precision = publishedAt ? 'day' : null;
  }
  // A page whose date is in the future must not look fresh.
  if (publishedAt && Date.parse(publishedAt) > now + 864e5) { publishedAt = null; precision = null; }
  return { title, url, publishedAt, publishedAtPrecision: precision, publisher: 'Anthropic',
    summary: (metaContent(html, 'name', 'description') || metaContent(html, 'property', 'og:description')).slice(0, 1500) };
}

async function fetchPages(urls, parse, fetchImpl) {
  const items = []; const failures = []; let pageBytes = 0;
  for (let i = 0; i < urls.length; i += PAGE_CONCURRENCY) {
    await Promise.all(urls.slice(i, i + PAGE_CONCURRENCY).map(async url => {
      try {
        const { text } = await getText(url, fetchImpl, { accept: 'text/html', maxBytes: MAX_PAGE_BYTES });
        pageBytes += Buffer.byteLength(text);
        items.push(parse(text, url));
      } catch (error) { failures.push({ url, code: error.details?.httpStatus ? `HTTP_${error.details.httpStatus}` : error.code || 'PAGE_FAILED' }); }
    }));
  }
  // The collector treats an undated item as collected now, which would re-announce an old release on every scan.
  const dated = items.filter(item => item.publishedAt);
  dated.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  return { items: dated, undated: items.length - dated.length, failures: failures.slice(0, 5), pageBytes };
}

function sitemapReceipt({ response, sourceUrl, text, observedItems, pages }) {
  return { httpStatus: response.status, sourceUrl, responseSha256: sha(text), observedItems, pagesFetched: pages.items.length + pages.undated,
    undated: pages.undated, failures: pages.failures, browserUsed: false, credentialsUsed: false };
}

export async function fetchAnthropicSitemap(limit, { fetchImpl = globalThis.fetch } = {}) {
  validateLimit(limit);
  const sitemap = await getText(ANTHROPIC_SITEMAP, fetchImpl, { accept: 'application/xml', maxBytes: MAX_SITEMAP_BYTES });
  const urls = anthropicCandidates(sitemapEntries(sitemap.text), limit);
  const pages = await fetchPages(urls, parseAnthropicPage, fetchImpl);
  return { items: pages.items.slice(0, limit), receipt: sitemapReceipt({ ...sitemap, sourceUrl: ANTHROPIC_SITEMAP, observedItems: urls.length, pages }) };
}

const DEEPSEEK_HOST = 'https://api-docs.deepseek.com';
const DEEPSEEK_SITEMAP = `${DEEPSEEK_HOST}/sitemap.xml`;

export function deepseekNewsPages(entries, limit) {
  return entries.map(e => {
    const m = e.loc.match(/^https:\/\/api-docs\.deepseek\.com\/news\/news(\d\d)(\d\d)(\d\d)$/);
    return m ? { url: e.loc, publishedAt: noonUtc(2000 + Number(m[1]), Number(m[2]), Number(m[3])) } : null;
  }).filter(e => e?.publishedAt).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, Math.min(limit, MAX_PAGES));
}

export function parseDeepseekPage(html, page) {
  const title = pageTitle(html, /\s*\|\s*DeepSeek API Docs\s*$/i);
  if (!title) throw fail('DEEPSEEK_PAGE_SCHEMA');
  return { title, url: page.url, publishedAt: page.publishedAt, publishedAtPrecision: 'day', publisher: 'DeepSeek',
    summary: (metaContent(html, 'name', 'description') || metaContent(html, 'property', 'og:description')).slice(0, 1500) };
}

export async function fetchDeepseekDocsNews(limit, { fetchImpl = globalThis.fetch } = {}) {
  validateLimit(limit);
  const sitemap = await getText(DEEPSEEK_SITEMAP, fetchImpl, { accept: 'application/xml', maxBytes: MAX_SITEMAP_BYTES });
  const pages = deepseekNewsPages(sitemapEntries(sitemap.text), limit);
  const byUrl = new Map(pages.map(p => [p.url, p]));
  const fetched = await fetchPages(pages.map(p => p.url), (html, url) => parseDeepseekPage(html, byUrl.get(url)), fetchImpl);
  return { items: fetched.items.slice(0, limit), receipt: sitemapReceipt({ ...sitemap, sourceUrl: DEEPSEEK_SITEMAP, observedItems: pages.length, pages: fetched }) };
}

// Quantised and repackaged copies of a release are not new releases.
const REPACKAGED = /(?:^|[-_.])(gguf|awq|gptq|fp8|fp4|nvfp4|int4|int8|4bit|8bit|mlx|bnb|exl2|onnx|hf)(?:$|[-_.])/i;

export function hfOrgItems(models, { org, family, publisher }) {
  if (!Array.isArray(models)) throw fail('SCHEMA');
  const seen = new Set();
  const items = [];
  for (const model of models) {
    if (model === null || typeof model !== 'object' || typeof model.id !== 'string' || typeof model.createdAt !== 'string') throw fail('SCHEMA');
    const [author, name] = model.id.split('/');
    if (model.private === true || author !== org || !name || !family.test(name) || REPACKAGED.test(name) || seen.has(name.toLowerCase())) continue;
    const createdAt = Date.parse(model.createdAt);
    if (!Number.isFinite(createdAt)) continue;
    seen.add(name.toLowerCase());
    items.push({ title: `${name} released`, url: `https://huggingface.co/${model.id}`, publishedAt: new Date(createdAt).toISOString(),
      publishedAtPrecision: 'instant', publisher, summary: '', engagement: { downloads: model.downloads ?? null, likes: model.likes ?? null } });
  }
  return items.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

function hfOrgFetcher(config) {
  const sourceUrl = `https://huggingface.co/api/models?author=${encodeURIComponent(config.org)}&sort=createdAt&direction=-1&limit=50`;
  return async function fetchHfOrgModels(limit, { fetchImpl = globalThis.fetch } = {}) {
    validateLimit(limit);
    const { response, text } = await getText(sourceUrl, fetchImpl, { accept: 'application/json', maxBytes: MAX_SITEMAP_BYTES });
    let data;
    try { data = JSON.parse(text); } catch { throw fail('NOT_JSON'); }
    const items = hfOrgItems(data, config);
    return { items: items.slice(0, limit), receipt: { httpStatus: response.status, sourceUrl, responseSha256: sha(text), observedItems: items.length,
      browserUsed: false, credentialsUsed: false } };
  };
}

export const fetchHfQwenModels = hfOrgFetcher({ org: 'Qwen', family: /^qwen/i, publisher: 'Qwen' });
export const fetchHfDeepseekModels = hfOrgFetcher({ org: 'deepseek-ai', family: /^deepseek/i, publisher: 'DeepSeek' });
