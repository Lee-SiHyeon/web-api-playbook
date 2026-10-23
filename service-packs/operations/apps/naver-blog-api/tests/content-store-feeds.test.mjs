import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchFeed, parseFeed } from '../research/content-store/feeds.mjs';

const rss = entries => `<rss version="2.0"><channel>${entries}</channel></rss>`;
const rssItem = ({ title = 'Headline', link = 'https://example.test/story', extra = '' } = {}) =>
  `<item><title>${title}</title><link>${link}</link>${extra}</item>`;
const okFetch = xml => async (_url, options) => {
  assert.equal(options.redirect, 'manual');
  return new Response(xml, { status: 200, headers: { 'content-type': 'application/rss+xml; charset=utf-8' } });
};

test('RSS parses CDATA, XML entities, publisher, summary and publication date', () => {
  const xml = rss(rssItem({
    title: '<![CDATA[A &amp; B &lt;News&gt;]]>',
    link: 'https://example.test/story?a=1&amp;b=2',
    extra: '<pubDate>Tue, 02 Jan 2024 03:04:05 GMT</pubDate><description><![CDATA[<p>Text &quot;quoted&quot; &#39;quoted&#39; &#65; &#x1F600;</p>]]></description><source>Publisher</source>',
  }));
  assert.deepEqual(parseFeed(xml), [{
    title: 'A & B <News>',
    url: 'https://example.test/story?a=1&b=2',
    publishedAt: '2024-01-02T03:04:05.000Z',
    publisher: 'Publisher',
    summary: 'Text "quoted" \'quoted\' A 😀',
  }]);
});

test('Atom selects rel=alternate and extracts entry metadata', () => {
  const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Atom &amp; News</title><link rel="self" href="https://example.test/api/1"/><link rel="alternate" href="https://example.test/story/1"/><updated>2025-03-04T05:06:07Z</updated><summary>Summary &amp; details</summary><author><name>Author</name></author></entry></feed>`;
  assert.deepEqual(parseFeed(xml), [{
    title: 'Atom & News', url: 'https://example.test/story/1', publishedAt: '2025-03-04T05:06:07.000Z',
    publisher: 'Author', summary: 'Summary & details',
  }]);
});

test('EUC-KR XML declaration decodes Korean bytes', async () => {
  const bytes = Buffer.concat([
    Buffer.from('<?xml version="1.0" encoding="EUC-KR"?><rss version="2.0"><channel><item><title>'),
    Buffer.from([0xc7, 0xd1, 0xb1, 0xb9]), // 한국 in EUC-KR
    Buffer.from('</title><link>https://example.test/korea</link></item></channel></rss>'),
  ]);
  const result = await fetchFeed('https://example.test/feed', { fetchImpl: async () => new Response(bytes) });
  assert.equal(result.items[0].title, '한국');
  assert.equal(result.receipt.charset, 'euc-kr');
});

test('HTTP content-type charset overrides the XML declaration', async () => {
  const xml = '<?xml version="1.0" encoding="ISO-8859-1"?><rss version="2.0"><channel>'
    + rssItem({ title: '한국' }) + '</channel></rss>';
  const result = await fetchFeed('https://example.test/feed', {
    fetchImpl: async () => new Response(Buffer.from(xml, 'utf8'), { headers: { 'content-type': 'application/rss+xml; charset="UTF-8"' } }),
  });
  assert.equal(result.items[0].title, '한국');
  assert.equal(result.receipt.charset, 'utf-8');
});

test('DOCTYPE and ENTITY declarations are rejected', () => {
  assert.throws(() => parseFeed('<!DOCTYPE rss [<!ENTITY x "bad">]><rss version="2.0"><channel/></rss>'), error => error.code === 'RSS_SCHEMA');
});

test('items without a title or an HTTPS URL are dropped', () => {
  const xml = rss(
    rssItem({ title: 'HTTP link', link: 'http://example.test/story' })
    + rssItem({ title: '', link: 'https://example.test/no-title' })
    + rssItem({ title: 'Good', link: 'https://example.test/good' }),
  );
  assert.deepEqual(parseFeed(xml).map(item => item.title), ['Good']);
});

test('HTTP redirect destinations are rejected without following them', async () => {
  let calls = 0;
  await assert.rejects(fetchFeed('https://example.test/feed', {
    fetchImpl: async () => { calls++; return new Response(null, { status: 302, headers: { location: 'http://example.test/feed' } }); },
  }), error => error.code === 'REDIRECT_PROTOCOL');
  assert.equal(calls, 1);
});

test('feed redirects are followed manually and receipt records source and final URLs', async () => {
  const calls = [];
  const result = await fetchFeed('https://example.test/feed', {
    fetchImpl: async (url, options) => {
      calls.push({ url, redirect: options.redirect });
      if (calls.length === 1) return new Response(null, { status: 301, headers: { location: '/latest.xml' } });
      return new Response(rss(rssItem()), { status: 200 });
    },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.redirect), ['manual', 'manual']);
  assert.equal(result.receipt.sourceUrl, 'https://example.test/feed');
  assert.equal(result.receipt.finalUrl, 'https://example.test/latest.xml');
  assert.equal(result.receipt.format, 'rss');
  assert.equal(result.receipt.browserUsed, false);
});

test('bodies larger than 2 MiB are rejected', async () => {
  const tooLarge = Buffer.alloc(2 * 1024 * 1024 + 1);
  await assert.rejects(fetchFeed('https://example.test/feed', { fetchImpl: async () => new Response(tooLarge) }), error => error.code === 'SOURCE_TOO_LARGE');
});

test('non-200 responses include HTTP_STATUS and the received status', async () => {
  await assert.rejects(fetchFeed('https://example.test/feed', {
    fetchImpl: async () => new Response('Not found', { status: 404 }),
  }), error => error.code === 'HTTP_STATUS' && error.status === 404);
});

test('fetchFeed limits returned items and records the parsed count', async () => {
  const xml = rss(rssItem({ title: 'One' }) + rssItem({ title: 'Two', link: 'https://example.test/2' }));
  const result = await fetchFeed('https://example.test/feed', { fetchImpl: okFetch(xml), limit: 1 });
  assert.equal(result.items.length, 1);
  assert.equal(result.receipt.observedItems, 2);
});

test('same-host http item links are upgraded only when requested and only for the feed host', async () => {
  const xml = rss(rssItem({ title: 'Own host', link: 'http://feed.example/view?no=1' }) + rssItem({ title: 'Other host', link: 'http://other.example/x' }));
  assert.deepEqual((await fetchFeed('https://feed.example/rss', { fetchImpl: okFetch(xml) })).items, []);
  const upgraded = await fetchFeed('https://feed.example/rss', { fetchImpl: okFetch(xml), upgradeSameHostHttp: true });
  assert.deepEqual(upgraded.items.map(item => item.url), ['https://feed.example/view?no=1']);
  assert.deepEqual(parseFeed(xml, { upgradeHost: 'feed.example' }).map(item => item.title), ['Own host']);
});