import test from 'node:test';
import assert from 'node:assert/strict';
import { sitemapEntries, anthropicCandidates, parseAnthropicPage, deepseekNewsPages, parseDeepseekPage, hfOrgItems,
  fetchAnthropicSitemap, fetchDeepseekDocsNews, fetchHfQwenModels } from '../research/content-store/vendor-releases.mjs';

const SITEMAP = `<?xml version="1.0"?><urlset>
<url><loc>https://www.anthropic.com/claude-sonnet-5-5</loc></url>
<url><loc>https://www.anthropic.com/claude-corps</loc></url>
<url><loc>https://www.anthropic.com/news/older-post</loc><lastmod>2026-08-01T00:00:00.000Z</lastmod></url>
<url><loc>https://www.anthropic.com/news/newer-post</loc><lastmod>2026-09-20T00:00:00.000Z</lastmod></url>
<url><loc>https://www.anthropic.com/research/no-date</loc></url>
<url><loc>https://www.anthropic.com/careers/x</loc><lastmod>2026-09-28T00:00:00.000Z</lastmod></url>
</urlset>`;
const NOW = Date.parse('2026-09-29T00:00:00Z');
const page = (head, body = '') => `<html><head>${head}</head><body>${body}</body></html>`;
const reply = (status, text, headers = {}) => ({ status, headers: new Headers(headers), text: async () => text });

test('sitemap entries keep loc and lastmod and refuse anything that is not a urlset', () => {
  const entries = sitemapEntries(SITEMAP);
  assert.equal(entries.length, 6);
  assert.deepEqual(entries[2], { loc: 'https://www.anthropic.com/news/older-post', lastmod: '2026-08-01T00:00:00.000Z' });
  assert.equal(entries[0].lastmod, null);
  assert.throws(() => sitemapEntries('<html></html>'), /SITEMAP_SCHEMA/);
  assert.throws(() => sitemapEntries('<!DOCTYPE x [<!ENTITY a "b">]><urlset></urlset>'), /SITEMAP_SCHEMA/);
});

test('anthropic candidates: versioned launch pages first, then news and research newest first; undated and off-topic pages are dropped', () => {
  const urls = anthropicCandidates(sitemapEntries(SITEMAP), 10);
  assert.deepEqual(urls, ['https://www.anthropic.com/claude-sonnet-5-5', 'https://www.anthropic.com/news/newer-post', 'https://www.anthropic.com/news/older-post']);
  assert.deepEqual(anthropicCandidates(sitemapEntries(SITEMAP), 2), urls.slice(0, 2));
});

test('anthropic page: og:title, instant date, eyebrow date, running-text date, future date and undated pages', () => {
  const url = 'https://www.anthropic.com/claude-sonnet-5-5';
  const og = parseAnthropicPage(page('<meta property="og:title" content="Introducing Claude Sonnet 5.5 &amp; more | Anthropic"><meta property="article:published_time" content="2026-09-28T16:00:00.000Z"><meta name="description" content="Faster &amp; cheaper.">'), url, { now: NOW });
  assert.deepEqual([og.title, og.publishedAt, og.publishedAtPrecision, og.summary], ['Introducing Claude Sonnet 5.5 & more', '2026-09-28T16:00:00.000Z', 'instant', 'Faster & cheaper.']);
  const eyebrow = parseAnthropicPage(page('<title>Claude Opus 5.5 \\ Anthropic</title>', '<p class="eyebrow">September 22, 2026</p><p>See August 1, 2026 for context</p>'), url, { now: NOW });
  assert.deepEqual([eyebrow.title, eyebrow.publishedAt, eyebrow.publishedAtPrecision], ['Claude Opus 5.5', '2026-09-22T12:00:00.000Z', 'day']);
  const running = parseAnthropicPage(page('<title>Claude Mythos | Anthropic</title>', '<p>Posted on August 2, 2026 by the team</p>'), url, { now: NOW });
  assert.equal(running.publishedAt, '2026-08-02T12:00:00.000Z');
  const future = parseAnthropicPage(page('<title>Claude 9 | Anthropic</title><meta property="article:published_time" content="2027-01-01T00:00:00Z">'), url, { now: NOW });
  assert.equal(future.publishedAt, null, 'a future date must not look fresh');
  const undated = parseAnthropicPage(page('<title>Claude Fable | Anthropic</title>', '<p>no date here</p>'), url, { now: NOW });
  assert.deepEqual([undated.publishedAt, undated.publishedAtPrecision], [null, null]);
  const invalid = parseAnthropicPage(page('<title>Claude X | Anthropic</title>', '<p>February 31, 2026</p>'), url, { now: NOW });
  assert.equal(invalid.publishedAt, null, 'an impossible calendar date is not a date');
  assert.throws(() => parseAnthropicPage(page(''), url, { now: NOW }), /ANTHROPIC_PAGE_SCHEMA/);
});

test('deepseek news pages: the date comes from the slug, newest first, bad dates dropped', () => {
  const entries = ['news260910', 'news260728', 'news261345', 'news260910x', 'index'].map(s => ({ loc: `https://api-docs.deepseek.com/news/${s}`, lastmod: null }));
  const pages = deepseekNewsPages(entries, 10);
  assert.deepEqual(pages.map(p => [p.url.split('/').pop(), p.publishedAt]), [['news260910', '2026-09-10T12:00:00.000Z'], ['news260728', '2026-07-28T12:00:00.000Z']]);
  assert.equal(deepseekNewsPages(entries, 1).length, 1);
  const item = parseDeepseekPage(page('<title>DeepSeek-V4.1-Flash: Smarter | DeepSeek API Docs</title><meta name="description" content="V4.1 Flash">'), pages[0]);
  assert.deepEqual([item.title, item.publishedAt, item.publisher, item.summary], ['DeepSeek-V4.1-Flash: Smarter', '2026-09-10T12:00:00.000Z', 'DeepSeek', 'V4.1 Flash']);
});

test('hugging face org items: family filter, repackaged copies, private repos, duplicates and other authors are skipped', () => {
  const m = (id, createdAt, extra) => ({ id, createdAt, downloads: 5, likes: 2, ...extra });
  const items = hfOrgItems([
    m('Qwen/Qwen3.8-2.4T-A95B', '2026-08-15T10:00:00.000Z'),
    m('Qwen/Qwen3.8-2.4T-A95B-GGUF', '2026-08-16T10:00:00.000Z'),
    m('Qwen/Qwen3.8-FP8', '2026-08-16T11:00:00.000Z'),
    m('Qwen/Qwen3.9-mini', '2026-09-01T10:00:00.000Z'),
    m('Qwen/Qwen3.9-mini', '2026-09-02T10:00:00.000Z'),
    m('Qwen/secret', '2026-09-03T10:00:00.000Z', { private: true }),
    m('Qwen/Wan2.2-video', '2026-09-04T10:00:00.000Z'),
    m('someone/Qwen3.9-copy', '2026-09-05T10:00:00.000Z'),
  ], { org: 'Qwen', family: /^qwen/i, publisher: 'Qwen' });
  assert.deepEqual(items.map(i => i.title), ['Qwen3.9-mini released', 'Qwen3.8-2.4T-A95B released']);
  assert.equal(items[0].url, 'https://huggingface.co/Qwen/Qwen3.9-mini');
  assert.deepEqual(items[0].engagement, { downloads: 5, likes: 2 });
  assert.throws(() => hfOrgItems({}, { org: 'Qwen', family: /^qwen/i }), /SCHEMA/);
  assert.throws(() => hfOrgItems([{ id: 1 }], { org: 'Qwen', family: /^qwen/i }), /SCHEMA/);
});

test('anthropic sitemap fetch: launch pages and news pages become dated items; an undated page is counted, not returned', async () => {
  const pages = {
    'https://www.anthropic.com/sitemap.xml': SITEMAP,
    'https://www.anthropic.com/claude-sonnet-5-5': page('<meta property="og:title" content="Claude Sonnet 5.5"><meta property="article:published_time" content="2026-09-28T16:00:00.000Z">'),
    'https://www.anthropic.com/news/newer-post': page('<title>Newer post | Anthropic</title>', '<p>nothing dated</p>'),
    'https://www.anthropic.com/news/older-post': page('<title>Older post | Anthropic</title><meta property="article:published_time" content="2026-08-01T00:00:00Z">'),
  };
  const seen = [];
  const fetchImpl = async url => { seen.push(url); return pages[url] ? reply(200, pages[url]) : reply(404, ''); };
  const { items, receipt } = await fetchAnthropicSitemap(5, { fetchImpl });
  assert.deepEqual(items.map(i => i.title), ['Claude Sonnet 5.5', 'Older post']);
  assert.deepEqual([receipt.observedItems, receipt.pagesFetched, receipt.undated, receipt.failures.length, receipt.credentialsUsed], [3, 3, 1, 0, false]);
  assert.equal(receipt.responseSha256.length, 64);
  await assert.rejects(() => fetchAnthropicSitemap(0, { fetchImpl }), /SOURCE_LIMIT/);
});

test('deepseek docs fetch follows a same-origin redirect and refuses a cross-origin one', async () => {
  const sitemap = `<urlset><url><loc>https://api-docs.deepseek.com/news/news260910</loc></url><url><loc>https://api-docs.deepseek.com/news/news260728</loc></url></urlset>`;
  const fetchImpl = async url => {
    if (url.endsWith('/sitemap.xml')) return reply(200, sitemap);
    if (url.endsWith('news260910')) return reply(302, '', { location: '/news/news260910/' });
    if (url.endsWith('news260910/')) return reply(200, page('<title>DeepSeek-V4.1-Flash | DeepSeek API Docs</title>'));
    return reply(302, '', { location: 'https://evil.example/news260728' });
  };
  const { items, receipt } = await fetchDeepseekDocsNews(5, { fetchImpl });
  assert.deepEqual(items.map(i => i.title), ['DeepSeek-V4.1-Flash']);
  assert.deepEqual(receipt.failures, [{ url: 'https://api-docs.deepseek.com/news/news260728', code: 'REDIRECT' }]);
});

test('hugging face fetch returns newest first within the limit and rejects a non-JSON reply', async () => {
  const body = JSON.stringify([{ id: 'Qwen/Qwen3.8', createdAt: '2026-08-15T10:00:00Z' }, { id: 'Qwen/Qwen3.9', createdAt: '2026-09-01T10:00:00Z' }]);
  const ok = await fetchHfQwenModels(1, { fetchImpl: async () => reply(200, body) });
  assert.deepEqual(ok.items.map(i => i.title), ['Qwen3.9 released']);
  assert.equal(ok.receipt.observedItems, 2);
  await assert.rejects(() => fetchHfQwenModels(1, { fetchImpl: async () => reply(200, '<html>') }), /NOT_JSON/);
});
