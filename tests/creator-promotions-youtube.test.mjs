import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createYouTubeDiscoveryClient,
  YouTubeDiscoveryError,
  youtubeDiscoveryContract,
} from '../lib/creator-promotions/youtube.mjs';

const FIXED_NOW = Date.parse('2026-10-05T05:00:00.000Z');
const CHANNEL = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';
const VIDEO_A = 'dQw4w9WgXcQ';
const VIDEO_B = 'a1b2c3d4e5F';

function response(body, { status = 200, mime = 'application/xml; charset=utf-8', headers = {} } = {}) {
  return new Response(body, { status, headers: { 'content-type': mime, ...headers } });
}

function entry({ videoId = VIDEO_A, channelId = CHANNEL, title = 'Summer collab pick',
  description = '광고 포함\n올영 공구 할인 쿠폰', published = '2026-10-04T12:30:00+00:00',
  author = 'Creator Example', link } = {}) {
  return `<entry><id>yt:video:${videoId}</id><yt:videoId>${videoId}</yt:videoId><yt:channelId>${channelId}</yt:channelId>` +
    `<title>${title}</title><link rel="alternate" href="${link ?? `https://www.youtube.com/watch?v=${videoId}`}"/>` +
    `<author><name>${author}</name><uri>https://www.youtube.com/channel/${channelId}</uri></author>` +
    `<published>${published}</published><updated>${published}</updated>` +
    `<media:group><media:description>${description}</media:description></media:group></entry>`;
}

function feed(entries = [entry()]) {
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015" ` +
    `xmlns:media="http://search.yahoo.com/mrss/"><title>YouTube video feed</title>${entries.join('')}</feed>`;
}

function searchResponse({ items = [], nextPageToken, totalResults = items.length } = {}) {
  return JSON.stringify({
    kind: 'youtube#searchListResponse',
    ...(nextPageToken ? { nextPageToken } : {}),
    pageInfo: { totalResults, resultsPerPage: items.length },
    items,
  });
}

function searchItem({ videoId = VIDEO_A, channelId = CHANNEL, title = 'Collab sale',
  description = 'Coupon discount and collaboration', publishedAt = '2026-10-04T12:30:00Z' } = {}) {
  return { id: { kind: 'youtube#video', videoId }, snippet: { title, description, channelId,
    channelTitle: 'Creator Example', publishedAt } };
}

function videoResource({ videoId = VIDEO_A, channelId = CHANNEL, title = 'Creator video',
  description = 'Official description', publishedAt = '2026-10-04T12:30:00Z' } = {}) {
  return { id: videoId, snippet: { title, description, channelId, channelTitle: 'Creator Example', publishedAt } };
}

function watchPage({ videoId = VIDEO_A, channelId = CHANNEL, author = 'Creator Example', title = 'Public creator video',
  description = 'This is an Olive Young collaboration coupon sale.', publishDate = '2026-10-04T12:30:00-07:00' } = {}) {
  const player = { videoDetails: { videoId, channelId, author, title, shortDescription: description },
    microformat: { playerMicroformatRenderer: { publishDate } } };
  return `<html><script>var ytInitialPlayerResponse = ${JSON.stringify(player)};</script></html>`;
}

function searchRenderer({ videoId = VIDEO_A, channelId = CHANNEL, channelTitle = 'Creator Example',
  title = 'Olive Young collaboration and discount', publishedLabel = '2 days ago',
  navigationVideoId = videoId, commandUrl = `/watch?v=${videoId}` } = {}) {
  return {
    videoId,
    title: { runs: [{ text: title }] },
    ownerText: { runs: [{ text: channelTitle, navigationEndpoint: { browseEndpoint: { browseId: channelId } } }] },
    publishedTimeText: { simpleText: publishedLabel },
    navigationEndpoint: {
      watchEndpoint: { videoId: navigationVideoId },
      commandMetadata: { webCommandMetadata: { url: commandUrl } },
    },
  };
}

function searchPage(renderers = [searchRenderer()]) {
  const data = { contents: { twoColumnSearchResultsRenderer: { primaryContents: {
    sectionListRenderer: { contents: [{ itemSectionRenderer: {
      contents: renderers.map(videoRenderer => ({ videoRenderer })),
    } }] },
  } } } };
  return `<html><script>var ytInitialData = ${JSON.stringify(data)};</script></html>`;
}

function makeClient(fetchImpl, options = {}) {
  return createYouTubeDiscoveryClient({ apiKey: 'test-api-key-never-return', fetchImpl,
    now: () => FIXED_NOW, timeoutMs: 1000, ...options });
}

test('channel feed is a no-login first-party Atom source and binds every item to the requested channel', async () => {
  let called;
  const client = makeClient(async (input, init) => {
    called = { url: new URL(input), init };
    return response(feed());
  }, { apiKey: undefined });

  const result = await client.getChannelFeed({ channelId: CHANNEL });
  assert.equal(called.url.origin, 'https://www.youtube.com');
  assert.equal(called.url.pathname, '/feeds/videos.xml');
  assert.equal(called.url.searchParams.get('channel_id'), CHANNEL);
  assert.equal(called.init.method, 'GET');
  assert.equal(called.init.redirect, 'manual');
  assert.equal(called.init.credentials, 'omit');
  assert.equal(called.init.headers.accept, 'application/xml,text/xml,application/atom+xml');
  assert.equal(result.videos.length, 1);
  assert.equal(result.videos[0].videoId, VIDEO_A);
  assert.equal(result.videos[0].channelId, CHANNEL);
  assert.equal(result.videos[0].title, 'Summer collab pick');
  assert.equal(result.videos[0].description, '광고 포함\n올영 공구 할인 쿠폰');
  assert.equal(result.videos[0].publishedAt, '2026-10-04T12:30:00+00:00');
  assert.equal(result.videos[0].url, `https://www.youtube.com/watch?v=${VIDEO_A}`);
  assert.equal(result.videos[0].creatorClaims.status, 'unverified_creator_claim');
  assert.deepEqual(result.videos[0].promotionHints.map(hint => hint.kind).sort(),
    ['collaboration', 'coupon', 'discount', 'group_buy', 'paid_disclosure'].sort());
  assert.equal(result.collection.complete, false);
  assert.equal(result.receipt.authenticated, false);
  assert.equal(result.receipt.credentialsUsed, false);
  assert.deepEqual(result.receipt.request.queryFieldNames, ['channel_id']);
  assert.equal(result.receipt.contractProvenance.kind, 'first_party_documented_feed');
  assert.equal(JSON.stringify(result).includes('test-api-key-never-return'), false);
});

test('feed rejects DTDs, entities, wrong channels, unexpected links, duplicate IDs and malformed XML', async t => {
  const invalidFeeds = [
    '<!DOCTYPE feed [<!ENTITY x "y">]>' + feed(),
    feed().replace('올영 공구 할인 쿠폰', '&outside;'),
    feed([entry({ channelId: 'UC0000000000000000000000' })]),
    feed([entry({ link: 'https://attacker.example.test/watch?v=' + VIDEO_A })]),
    feed([entry(), entry()]),
    feed().replace('</feed>', ''),
  ];
  for (const xml of invalidFeeds) {
    await t.test('reject malformed or unbound feed', async () => {
      const client = makeClient(async () => response(xml), { apiKey: undefined });
      await assert.rejects(() => client.getChannelFeed({ channelId: CHANNEL }), error =>
        error instanceof YouTubeDiscoveryError && error.code.startsWith('YOUTUBE_'));
    });
  }
});

test('feed errors carry only sanitized request metadata', async () => {
  const client = makeClient(async () => response('<html>not found</html>', { status: 404, mime: 'text/html' }),
    { apiKey: undefined });
  await assert.rejects(() => client.getChannelFeed({ channelId: CHANNEL }), error => {
    assert.equal(error.code, 'YOUTUBE_HTTP_ERROR');
    assert.equal(error.receipt.request.httpStatus, 404);
    assert.equal(JSON.stringify(error).includes(CHANNEL), false);
    return true;
  });
});

test('explicit watch-page method reads a single public video as SSR document metadata, never XHR', async () => {
  let called;
  const client = makeClient(async (input, init) => {
    called = { url: new URL(input), init };
    return response(watchPage(), { mime: 'text/html; charset=utf-8' });
  }, { apiKey: undefined });
  const result = await client.getVideoPageMetadata({ videoId: VIDEO_A });
  assert.equal(called.url.origin, 'https://www.youtube.com');
  assert.equal(called.url.pathname, '/watch');
  assert.equal(called.url.searchParams.get('v'), VIDEO_A);
  assert.equal(called.init.method, 'GET');
  assert.equal(called.init.credentials, 'omit');
  assert.equal(result.video.videoId, VIDEO_A);
  assert.equal(result.video.channelId, CHANNEL);
  assert.equal(result.video.title, 'Public creator video');
  assert.equal(result.video.description, 'This is an Olive Young collaboration coupon sale.');
  assert.equal(result.video.publishedAt, '2026-10-04T12:30:00-07:00');
  assert.equal(result.video.source.kind, 'first_party_public_document');
  assert.equal(result.extraction.isXhr, false);
  assert.equal(result.extraction.pageCodeExecuted, false);
  assert.equal(result.extraction.rawHtmlPersisted, false);
  assert.equal(result.receipt.request.path, '/watch');
  assert.equal(result.receipt.credentialsUsed, false);
  assert.deepEqual(result.receipt.request.queryFieldNames, ['v']);
  assert.equal(JSON.stringify(result).includes('test-api-key-never-return'), false);
});

test('watch-page parser rejects missing metadata and a response bound to another video ID', async () => {
  const noMetadata = makeClient(async () => response('<html>Sign in to confirm you are not a bot.</html>', { mime: 'text/html' }),
    { apiKey: undefined });
  await assert.rejects(() => noMetadata.getVideoPageMetadata({ videoId: VIDEO_A }), error =>
    error.code === 'YOUTUBE_VIDEO_PAGE_BOOTSTRAP_UNVERIFIED');
  const mismatch = makeClient(async () => response(watchPage({ videoId: VIDEO_B }), { mime: 'text/html' }),
    { apiKey: undefined });
  await assert.rejects(() => mismatch.getVideoPageMetadata({ videoId: VIDEO_A }), error =>
    error.code === 'YOUTUBE_VIDEO_ID_MISMATCH');
});

test('explicit search-page read parses bounded first-party videoRenderers and leaves detail hydration separate', async () => {
  let called;
  const html = searchPage([searchRenderer(), searchRenderer({ videoId: VIDEO_B, title: 'Another coupon sale' }),
    searchRenderer()]);
  const client = makeClient(async (input, init) => {
    called = { url: new URL(input), init };
    return response(`<script>globalThis.__ytPageExecuted = true;</script>${html}`, { mime: 'text/html; charset=utf-8' });
  }, { apiKey: undefined });
  delete globalThis.__ytPageExecuted;
  const result = await client.getSearchPageVideos({ query: '올리브영 콜라보 할인', maxItems: 1 });
  assert.equal(called.url.origin, 'https://www.youtube.com');
  assert.equal(called.url.pathname, '/results');
  assert.equal(called.url.searchParams.get('search_query'), '올리브영 콜라보 할인');
  assert.equal(called.init.method, 'GET');
  assert.equal(called.init.redirect, 'manual');
  assert.equal(called.init.credentials, 'omit');
  assert.equal(globalThis.__ytPageExecuted, undefined);
  assert.equal(result.videos.length, 1);
  assert.equal(result.videos[0].videoId, VIDEO_A);
  assert.equal(result.videos[0].channelId, CHANNEL);
  assert.equal(result.videos[0].channelTitle, 'Creator Example');
  assert.equal(result.videos[0].publishedLabel, '2 days ago');
  assert.equal(result.videos[0].source.kind, 'first_party_public_document');
  assert.equal(Object.hasOwn(result.videos[0], 'description'), false);
  assert.equal(result.page.uniqueVideoIds, 2);
  assert.equal(result.page.duplicatesRemoved, 1);
  assert.equal(result.page.complete, false);
  assert.equal(result.detailRead.performed, false);
  assert.equal(result.receipt.request.path, '/results');
  assert.equal(result.receipt.credentialsUsed, false);
  assert.deepEqual(result.receipt.request.queryFieldNames, ['search_query']);
  assert.equal(JSON.stringify(result.receipt).includes('올리브영 콜라보 할인'), false);
});

test('search-page parser rejects invalid, mismatched and missing video links', async t => {
  const invalid = [
    searchPage([searchRenderer({ navigationVideoId: VIDEO_B })]),
    searchPage([searchRenderer({ commandUrl: `/watch?v=${VIDEO_B}` })]),
    searchPage([searchRenderer({ commandUrl: 'https://attacker.example.test/watch?v=' + VIDEO_A })]),
    searchPage([{ ...searchRenderer(), navigationEndpoint: {} }]),
  ];
  for (const html of invalid) {
    await t.test('reject mismatched or missing search link', async () => {
      const client = makeClient(async () => response(html, { mime: 'text/html' }), { apiKey: undefined });
      await assert.rejects(() => client.getSearchPageVideos({ query: 'collab' }), error =>
        error.code === 'YOUTUBE_SEARCH_PAGE_LINK_MISMATCH' || error.code === 'YOUTUBE_SEARCH_PAGE_LINK_MISSING');
    });
  }
});

test('documented search sends exact bounded fields and omits API key from receipts and output', async () => {
  let called;
  const client = makeClient(async (input, init) => {
    called = { url: new URL(input), init };
    return response(searchResponse({ items: [searchItem()], nextPageToken: 'opaque-next-page', totalResults: 920 }),
      { mime: 'application/json; charset=UTF-8' });
  });
  const result = await client.searchVideos({ query: '올리브영 유튜버 콜라보 할인', pageToken: 'opaque-prev-page', maxResults: 17 });
  assert.equal(called.url.origin, 'https://www.googleapis.com');
  assert.equal(called.url.pathname, '/youtube/v3/search');
  assert.equal(called.url.searchParams.get('part'), 'snippet');
  assert.equal(called.url.searchParams.get('q'), '올리브영 유튜버 콜라보 할인');
  assert.equal(called.url.searchParams.get('type'), 'video');
  assert.equal(called.url.searchParams.get('maxResults'), '17');
  assert.equal(called.url.searchParams.get('pageToken'), 'opaque-prev-page');
  assert.equal(called.url.searchParams.get('key'), 'test-api-key-never-return');
  assert.equal(called.init.credentials, 'omit');
  assert.equal(result.videos[0].description, 'Coupon discount and collaboration');
  assert.deepEqual(result.pagination, { nextPageToken: 'opaque-next-page', hasMore: true,
    totalResultsApprox: 920, pageSize: 1, complete: false,
    providerExhausted: false,
    completenessMeaning: 'search_results_are_relevance_limited_and_totalResults_is_approximate' });
  assert.equal(result.receipt.credentialsUsed, true);
  assert.equal(result.receipt.credentialBinding.source, 'process-memory');
  assert.equal(JSON.stringify(result).includes('test-api-key-never-return'), false);
  assert.equal(JSON.stringify(result.receipt).includes('올리브영 유튜버 콜라보 할인'), false);
  assert.equal(JSON.stringify(result.receipt).includes('opaque-prev-page'), false);
  assert.equal(JSON.stringify(result.receipt).includes('key='), false);
});

test('search without a key fails closed without making an HTTP request', async () => {
  let calls = 0;
  const client = makeClient(async () => { calls += 1; return response('{}', { mime: 'application/json' }); }, { apiKey: undefined });
  await assert.rejects(() => client.searchVideos({ query: 'olive young' }), error => error.code === 'YOUTUBE_API_KEY_REQUIRED');
  await assert.rejects(() => client.getVideos({ videoIds: [VIDEO_A] }), error => error.code === 'YOUTUBE_API_KEY_REQUIRED');
  assert.equal(calls, 0);
  assert.deepEqual(client.credentialStatus(), { apiKeyConfigured: false, storage: 'process-memory' });
});

test('videos.list batches at fifty IDs and validates the returned ID set', async () => {
  const ids = Array.from({ length: 51 }, (_, index) => index.toString(36).padStart(10, '0') + 'x');
  let calls = 0;
  const client = makeClient(async input => {
    calls += 1;
    const url = new URL(input);
    const batch = url.searchParams.get('id').split(',');
    assert.ok(batch.length <= 50);
    return response(JSON.stringify({ kind: 'youtube#videoListResponse', items: batch.map(id => videoResource({ videoId: id })) }),
      { mime: 'application/json' });
  });
  const result = await client.getVideos({ videoIds: ids });
  assert.equal(calls, 2);
  assert.equal(result.videos.length, 51);
  assert.equal(result.collection.batchesRead, 2);
  assert.equal(result.collection.complete, true);
  assert.deepEqual(result.missingVideoIds, []);
  assert.equal(JSON.stringify(result).includes('test-api-key-never-return'), false);
});

test('videos.list records missing/private items and rejects an ID returned outside the requested batch', async () => {
  const client = makeClient(async () => response(JSON.stringify({ kind: 'youtube#videoListResponse',
    items: [videoResource()] }), { mime: 'application/json' }));
  const partial = await client.getVideos({ videoIds: [VIDEO_A, VIDEO_B] });
  assert.deepEqual(partial.missingVideoIds, [VIDEO_B]);
  assert.equal(partial.collection.complete, false);
  const invalid = makeClient(async () => response(JSON.stringify({ kind: 'youtube#videoListResponse',
    items: [videoResource({ videoId: VIDEO_B })] }), { mime: 'application/json' }));
  await assert.rejects(() => invalid.getVideos({ videoIds: [VIDEO_A] }), error => error.code === 'YOUTUBE_VIDEOS_ID_MISMATCH');
});

test('bounded search collector follows nextPageToken and stops at an explicit page bound', async () => {
  let calls = 0;
  const client = makeClient(async input => {
    calls += 1;
    const token = new URL(input).searchParams.get('pageToken');
    const pageIndex = token === 'cursor-1' ? 2 : token === 'cursor-2' ? 3 : 1;
    return response(searchResponse({ items: [searchItem({ videoId: pageIndex.toString().padStart(11, 'x') })],
      ...(pageIndex < 3 ? { nextPageToken: `cursor-${pageIndex}` } : {}), totalResults: 500 }),
    { mime: 'application/json' });
  });
  const result = await client.collectSearchVideos({ query: 'discount', maxPages: 2, maxItems: 10, maxResults: 1 });
  assert.equal(calls, 2);
  assert.equal(result.videos.length, 2);
  assert.equal(result.pagination.complete, false);
  assert.equal(result.pagination.termination, 'page_cap_reached');
});

test('transport exceptions and redirects never expose the API key', async () => {
  const failed = makeClient(async () => { throw new Error('secret test-api-key-never-return in rejected URL'); });
  await assert.rejects(() => failed.searchVideos({ query: 'deal' }), error => {
    assert.equal(error.code, 'YOUTUBE_TRANSPORT_ERROR');
    assert.equal(JSON.stringify(error).includes('test-api-key-never-return'), false);
    assert.equal(JSON.stringify(error).includes('rejected URL'), false);
    return true;
  });
  const redirected = makeClient(async () => response('', { status: 302, mime: 'text/plain', headers: { location: 'https://attacker.example.test/' } }));
  await assert.rejects(() => redirected.searchVideos({ query: 'deal' }), error => error.code === 'YOUTUBE_REDIRECT_REJECTED');
});

test('contract exposes official documented endpoints and public-feed boundary', () => {
  assert.equal(youtubeDiscoveryContract.methods.getChannelFeed.apiKeyRequired, false);
  assert.equal(youtubeDiscoveryContract.methods.searchVideos.apiKeyRequired, true);
  assert.equal(youtubeDiscoveryContract.methods.getVideos.apiKeyRequired, true);
  assert.equal(youtubeDiscoveryContract.policyBoundary.outboundLinks.includes('never requested'), true);
});
