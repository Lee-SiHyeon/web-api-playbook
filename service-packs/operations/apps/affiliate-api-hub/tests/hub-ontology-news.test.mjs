import test from 'node:test';
import assert from 'node:assert/strict';
import { validateHubItem } from '../scripts/hub-ontology/contract.mjs';
import { mapVendorNews, mapNewsCollection, mapLeaderBrief, load } from '../scripts/hub-ontology/news.mjs';
import { finalize } from '../scripts/hub-ontology/trend-news-common.mjs';
import { parseAnthropicPage, parseDeepseekPage, hfOrgItems } from '../../naver-blog-api/research/content-store/vendor-releases.mjs';

const now = new Date('2026-10-11T03:00:00Z');
const at = '2026-10-10T07:00:00Z';
const check = items => { assert.ok(items.length); for (const item of items) assert.deepEqual(validateHubItem(item), [], item.id); };

test('official vendor fixture preserves Korean title, facts, date and public URL', () => {
  const item = { title: 'Model update', titleKo: '모델 업데이트', summary: '모델 업데이트를 공개했다. 추가 설명.',
    url: 'https://openai.com/index/model-update/', publishedAt: at };
  const items = mapVendorNews([item, { ...item, url: 'https://unofficial.example.org/1' }, { ...item, url: 'http://openai.com/1' },
    { ...item, publishedAt: null, collectedAt: at }, { ...item, publishedAt: '2026-09-01T00:00:00Z' }], 'official-ai-openai-rss', { now });
  check(items); assert.equal(items.length, 1);
  assert.equal(items[0].title, '모델 업데이트'); assert.equal(items[0].summary, '모델 업데이트를 공개했다.');
  assert.equal(items[0].sourceUrl, item.url); assert.equal(items[0].affiliateUrl, null); assert.equal(items[0].category, 'digital');
  assert.equal(mapVendorNews([item], 'creator-ai-x-openai', { now }).length, 0);
});

test('existing vendor parsers feed the mapper without reimplementing collection', () => {
  const html = '<title>Claude update | Anthropic</title><meta property="article:published_time" content="2026-10-09T12:00:00Z"><meta name="description" content="Claude update announced.">';
  check(mapVendorNews([parseAnthropicPage(html, 'https://www.anthropic.com/news/update', { now: now.getTime() })], 'official-ai-anthropic-sitemap', { now }));
  check(mapVendorNews([parseDeepseekPage('<title>DeepSeek update | DeepSeek API Docs</title>', { url: 'https://api-docs.deepseek.com/news/news261009', publishedAt: '2026-10-09T12:00:00Z' })], 'official-ai-deepseek-docs', { now }));
  const models = hfOrgItems([{ id: 'Qwen/Qwen3-New', createdAt: at, private: false }], { org: 'Qwen', family: /^qwen/i, publisher: 'Qwen' });
  check(mapVendorNews(models, 'official-ai-qwen-hf', { now }));
  assert.equal(mapVendorNews([{ ...models[0], url: 'https://huggingface.co/unofficial/Qwen3-New' }], 'official-ai-qwen-hf', { now }).length, 0);
});

test('ledger/run mapping selects official source IDs and requires a dated publication', () => {
  const rows = [
    { title: '공식 소식', urls: ['https://openai.com/index/update'], sourceIds: ['official-ai-openai-rss'], publishedAt: at, summary: '공식 발표 내용.' },
    { title: '커뮤니티 소식', urls: ['https://openai.com/index/other'], sourceIds: ['community-ai-hn'], publishedAt: at },
  ];
  const collection = mapNewsCollection({ candidates: rows }, { now }); check(collection); assert.equal(collection.length, 1);
  const ledger = mapNewsCollection({ entries: { one: rows[0] } }, { now }); check(ledger);
  assert.equal(ledger[0].id, collection[0].id);
});

test('world-leader fixture uses original official URLs and the answer rather than a reporter question', () => {
  const brief = {
    linked: [{ statement: { text: 'Trade discussions continued. Another sentence.', publishedAt: at,
      originalUrl: 'https://truthsocial.com/@realDonaldTrump/123', mirrorUrl: 'https://www.trumpstruth.org/statuses/1', issueKinds: ['tariff_trade'] }, jp: [], cn: [] },
    { statement: { text: 'Mirror-only statement', publishedAt: at, mirrorUrl: 'https://www.trumpstruth.org/statuses/2' } }],
    executiveOrders: [{ title: 'An Executive Order', publishedAt: '2026-10-09', url: 'https://www.federalregister.gov/documents/2026/10/09/1/order' }],
    unlinkedReactions: [{ country: 'cn', date: '2026-10-09', sourceTitle: 'Foreign Ministry press conference',
      sourceUrl: 'https://www.mfa.gov.cn/eng/xw/fyrbt/lxjzh/202610/t20261009_1.html', paragraph: 'Reporter: Is there an agreement?',
      answer: 'Guo Jiakun: Talks are continuing.', issueKinds: [{ id: 'tariff_trade' }] },
    { country: 'jp', date: '2026-10-09', sourceTitle: 'Question only', sourceUrl: 'https://www.mofa.go.jp/press/kaiken/kaikenwe_000001_1.html', paragraph: 'Reporter: A question?', answer: null }],
  };
  const items = mapLeaderBrief(brief, { now }); check(items); assert.equal(items.length, 3);
  assert.equal(items.find(item => item.source === 'trump').sourceUrl, brief.linked[0].statement.originalUrl);
  assert.equal(items.find(item => item.source === 'china_mfa').summary, 'Guo Jiakun: Talks are continuing.');
  assert.ok(items.every(item => !item.summary.includes('Reporter:')));
  assert.equal(mapLeaderBrief(brief, { now: new Date('2026-10-20T00:00:00Z') }).length, 0);
});

test('news output dedupes overlapping official feeds, omits ended/expired/future items, and caps at 200', () => {
  const rows = Array.from({ length: 230 }, (_, i) => ({ title: `News ${i}`, url: `https://openai.com/index/${i}`, publishedAt: at }));
  const mapped = mapVendorNews(rows, 'official-ai-openai-rss', { now }); check(mapped);
  const items = finalize([...mapped, mapped[0], { ...mapped[0], id: 'openai:ended', sourceUrl: 'https://openai.com/index/ended', ended: true },
    { ...mapped[0], id: 'openai:expired', sourceUrl: 'https://openai.com/index/expired', expiresAt: now.toISOString() }], { now, days: 30 });
  check(items); assert.equal(items.length, 200); assert.equal(new Set(items.map(item => item.sourceUrl)).size, 200);
  assert.equal(mapVendorNews([{ ...rows[0], publishedAt: '2026-10-12T00:00:00Z' }], 'official-ai-openai-rss', { now }).length, 0);
});

test('load reuses official feed adapter using anonymous GET only, without touching credentials or writes', async () => {
  const xml = `<rss version="2.0"><channel><title>OpenAI</title><item><title>Official update</title><link>https://openai.com/index/fixture</link><pubDate>${new Date(at).toUTCString()}</pubDate><description>An official update was announced.</description></item></channel></rss>`;
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push(String(url)); assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'omit');
    assert.ok(!Object.keys(options.headers ?? {}).some(key => /cookie|authorization/i.test(key)));
    return new Response(String(url) === 'https://openai.com/news/rss.xml' ? xml : '', { status: String(url) === 'https://openai.com/news/rss.xml' ? 200 : 404 });
  };
  const items = await load({ now, fetchImpl, fallbackRoots: [], ledgerFile: '/nonexistent-public-ledger.json', catalogFile: '/nonexistent-catalog.db' });
  check(items); assert.equal(items.length, 1); assert.equal(items[0].source, 'openai'); assert.ok(requests.includes('https://openai.com/news/rss.xml'));
});
