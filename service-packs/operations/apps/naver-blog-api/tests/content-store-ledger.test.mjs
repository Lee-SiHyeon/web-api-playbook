import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseBlogRss, fetchExistingPosts, logNoFrom } from '../research/content-store/existing-posts.mjs';
import { enrichSignals, isSearchSignal } from '../research/content-store/enrich-signals.mjs';
import { updateLedger, ledgerIdFor, canonicalUrl, deltaMarkdown, groupEvidenceKinds, buildIdMap } from '../research/content-store/candidate-ledger.mjs';
import { syncRun, scanRun } from '../research/content-store/drive-sync.mjs';

const rss = items => `<rss><channel>${items.map(([title, link, date]) => `<item><title><![CDATA[${title}]]></title><link>${link}</link><pubDate>${date || 'Mon, 21 Sep 2026 10:00:00 +0900'}</pubDate><source>Pub</source></item>`).join('')}</channel></rss>`;
const signal = { id: 'abc', field: 'ai', title: '코딩AI 비교', urls: [], sourceIds: ['seed:코딩AI:rank:2'], sourceKind: 'search_signal', evidenceLevel: 'autocomplete_query' };
const headline = { id: 'def', field: 'ai', title: 'OpenAI 발표', urls: ['https://openai.com/index/a?utm_source=x'], sourceIds: ['official-ai-openai'], sourceKind: 'headline_only', publishedAt: '2026-09-23T00:00:00.000Z' };

test('own-blog RSS yields logNo per post and rejects other blogs or malformed links', async () => {
  const xml = rss([['첫 글', 'https://blog.naver.com/aicandoanything/224421728060'], ['둘째 글', 'https://blog.naver.com/PostView.naver?blogId=aicandoanything&logNo=224419454535'],
    ['남의 글', 'https://blog.naver.com/other/224400000000'], ['중복', 'https://blog.naver.com/aicandoanything/224421728060'], ['잘못', 'https://blog.naver.com/aicandoanything/about']]);
  const posts = parseBlogRss(xml, 'aicandoanything');
  assert.deepEqual(posts.map(p => p.logNo), ['224421728060', '224419454535']);
  assert.equal(posts[0].url, 'https://blog.naver.com/aicandoanything/224421728060');
  assert.equal(logNoFrom('https://evil.example/aicandoanything/224421728060', 'aicandoanything'), null);
  const record = await fetchExistingPosts('aicandoanything', { fetchImpl: async () => new Response(xml) });
  assert.deepEqual(record.titles, ['첫 글', '둘째 글']); assert.equal(record.coverage, 'rss_recent_only'); assert.equal(record.receipt.credentialsUsed, false);
  await assert.rejects(fetchExistingPosts('aicandoanything', { fetchImpl: async () => new Response('', { status: 500 }) }));
});

test('search signals gain discovery headlines while other candidates and empty feeds stay untouched', async () => {
  const feed = rss([['코딩 AI 도구 비교 기사', 'https://news.example/1'], ['두 번째', 'https://news.example/2']]);
  const record = await enrichSignals({ checkedAt: '2026-09-24T00:00:00.000Z', candidates: [signal, headline] }, { fetchImpl: async () => new Response(feed) });
  const [enriched, untouched] = record.candidates;
  assert.deepEqual(enriched.urls, ['https://news.example/1', 'https://news.example/2']);
  assert.equal(enriched.evidenceLevel, 'feed_headline_via_query'); assert.equal(enriched.enrichment.status, 'enriched');
  assert.ok(enriched.sourceKinds.includes('search_signal') && enriched.sourceKinds.includes('headline_enrichment'));
  assert.equal(untouched.enrichment, undefined); assert.equal(record.summary.requested, 1); assert.equal(record.policy.publicationReady, false);
  const empty = await enrichSignals([signal], { fetchImpl: async () => new Response(rss([])) });
  assert.equal(empty.candidates[0].enrichment.status, 'empty'); assert.deepEqual(empty.candidates[0].urls, []);
  const blocked = await enrichSignals([signal], { fetchImpl: async () => new Response('no', { status: 403 }) });
  assert.equal(blocked.candidates[0].enrichment.status, 'failed'); assert.equal(blocked.summary.failed, 1);
  assert.equal(isSearchSignal(headline), false);
  assert.equal(ledgerIdFor(signal), ledgerIdFor(enriched), 'enrichment must not fork the keyword identity');
});

test('ledger accumulates observations across runs, records dispositions and flags existing-post collisions', () => {
  const day1 = { checkedAt: '2026-09-22T00:00:00.000Z', candidates: [signal, headline] };
  const enriched = { checkedAt: '2026-09-22T00:00:30.000Z', inputCheckedAt: day1.checkedAt, candidates: [{ ...signal, urls: ['https://news.example/1'] }, headline] };
  const first = updateLedger(null, { collection: day1, enriched, runId: 'run-1' }, { now: new Date('2026-09-22T01:00:00Z') });
  assert.equal(first.delta.added.length, 2); assert.equal(first.delta.recurring.length, 0);
  assert.equal(first.ledger.entries[ledgerIdFor(signal)].seenCount, 1, 'enrichment of the same batch is not a second observation');
  assert.ok(first.ledger.entries[ledgerIdFor(headline)].priority.score > first.ledger.entries[ledgerIdFor(signal)].priority.score, 'official source with URL outranks a keyword');
  assert.ok(first.ledger.entries[ledgerIdFor(headline)].priority.reasons.includes('official_source'));
  assert.equal(canonicalUrl(headline.urls[0]), 'https://openai.com/index/a');
  const day2 = { checkedAt: '2026-09-23T00:00:00.000Z', candidates: [{ ...headline, urls: ['https://openai.com/index/a'] }, { ...signal, title: '새 키워드', id: 'zzz' }] };
  const report = { checkedAt: '2026-09-23T00:10:00.000Z', results: [{ ...headline, disposition: 'needs_research', category: 'unknown', suggestedCategory: 'ai', reasons: ['classification_unavailable_or_uncertain'] }] };
  const existingPosts = { posts: [{ logNo: '224421728060', title: 'OpenAI 발표' }] };
  const second = updateLedger(first.ledger, { collection: day2, report, existingPosts, runId: 'run-2' }, { now: new Date('2026-09-23T01:00:00Z') });
  const entry = second.ledger.entries[ledgerIdFor(headline)];
  assert.equal(entry.seenCount, 2); assert.equal(entry.status, 'recurring'); assert.deepEqual(entry.linkedRunIds, ['run-1', 'run-2']);
  assert.equal(entry.lastDisposition, 'needs_research'); assert.equal(entry.dispositions[0].suggestedCategory, 'ai');
  assert.equal(entry.possibleExistingPostLogNo, '224421728060');
  assert.ok(entry.priority.reasons.includes('existing_post_collision_review_first') && entry.priority.advisoryOnly);
  assert.equal(second.delta.added.length, 1); assert.deepEqual(second.delta.recurring, [entry.ledgerId]); assert.deepEqual(second.delta.collidingWithExisting, [entry.ledgerId]);
  assert.equal(first.ledger.entries[entry.ledgerId].seenCount, 1, 'previous ledger object is not mutated');
  const later = updateLedger(second.ledger, { collection: { checkedAt: '2026-10-20T00:00:00.000Z', candidates: [signal] } }, { now: new Date('2026-10-20T01:00:00Z') });
  assert.equal(later.ledger.entries[entry.ledgerId].status, 'dormant'); assert.ok(!later.delta.top.includes(entry.ledgerId));
  const md = deltaMarkdown(later.ledger, later.delta);
  assert.match(md, /발행 승인이나 검색량이 아닙니다/); assert.match(md, /코딩AI 비교/);
  assert.throws(() => updateLedger({ schemaVersion: 2 }, { collection: day1 }), /LEDGER_SCHEMA/);
  assert.throws(() => updateLedger(null, {}), /LEDGER_INPUT_REQUIRED/);
});

test('queue rows with a known existing post make aliases collide and never count as observations', () => {
  const queue = { createdAt: '2026-09-24T00:00:00.000Z', candidates: [{ candidateId: 'q1', title: 'Grok 새 모델 발표', urls: ['https://x.ai/news'], sourceKinds: ['manual_outline'], existingPostLogNo: '224419454535', aliases: ['grok 4.7'] }] };
  const collection = { checkedAt: '2026-09-24T00:05:00.000Z', candidates: [{ ...signal, title: 'Grok 4.7', id: 'g' }] };
  const { ledger } = updateLedger(null, { queue, collection }, { now: new Date('2026-09-24T01:00:00Z') });
  const manual = Object.values(ledger.entries).find(e => e.existingPostLogNo === '224419454535');
  assert.equal(manual.seenCount, 0); assert.ok(manual.aliases.includes('q1'));
  const grok = ledger.entries[ledgerIdFor({ ...signal, title: 'Grok 4.7' })];
  assert.equal(grok.possibleExistingPostLogNo, '224419454535'); assert.equal(grok.status, 'new');
});

test('ledger reports convergence across news and search signals without inventing demand', () => {
  const now = new Date('2026-09-24T00:00:00.000Z');
  const search = { title: 'Cross source candidate', field: 'ai', urls: [], sourceIds: ['seed:query'], sourceKind: 'search_signal' };
  const news = { title: 'Cross source candidate', field: 'ai', urls: [], sourceIds: ['news-rss'], sourceKind: 'news' };
  const { ledger, delta } = updateLedger(null, {
    collection: { checkedAt: '2026-09-23T12:00:00.000Z', candidates: [search, news] },
  }, { now });
  const entry = ledger.entries[ledgerIdFor(search)];
  assert.equal(entry.sourceKindCount, 2);
  assert.equal(entry.convergence, true);
  assert.equal(entry.newInWindow, true);
  assert.equal(entry.velocity, null);
  assert.deepEqual(entry.demand, { searchTrend: null, source: null });
  assert.ok(entry.priority.reasons.includes('cross_source_convergence'));
  assert.equal(entry.priority.advisoryOnly, true);
  assert.match(deltaMarkdown(ledger, delta), /\| Cross source candidate \| cross_source_convergence \| 2 \| - \|/);
  assert.deepEqual(groupEvidenceKinds(
    ['official-a', 'watch-b', 'creator-a', 'news-a', 'intent-a', 'seed:a', 'community-a', 'papers-a', 'realtime-a'],
    ['search_signal', 'community'],
  ).sort(), ['official', 'creator', 'news', 'search_signal', 'community', 'papers', 'realtime'].sort());
});

test('ledger links the strongest normalized trend to titles or aliases and keeps demand priority advisory', () => {
  const now = new Date('2026-09-24T01:00:00.000Z');
  const candidate = { id: 'trend-candidate', title: '여행 준비 도구', urls: [], aliases: ['신혼 여행, 준비물'], sourceKind: 'search_signal' };
  const collection = { checkedAt: '2026-09-24T00:00:00.000Z', candidates: [candidate] };
  const trends = {
    checkedAt: '2026-09-23T23:00:00.000Z',
    shoppingTrends: [{ keyword: '신혼여행-준비물', score: 78, categories: [{ horizons: {
      date: { score: 80 }, week: { score: 85 }, month: { score: 70 },
    } }] }],
    seedExpansions: [{ seed: '신혼여행', suggestions: [{ keyword: '신혼 여행 준비물', opportunityScore: 90 }] }],
    longTailOpportunities: [{ keyword: '기내용 캐리어', opportunityScore: 88 }],
    googleTrending: [{ keyword: '여행 준비 도구', approxTraffic: 1000 }],
  };
  const withoutDemand = updateLedger(null, { collection }, { now });
  const withDemand = updateLedger(null, { collection, trends, trendSource: 'research/trend-radar/latest.json' }, { now });
  const entry = withDemand.ledger.entries[ledgerIdFor(candidate)];
  assert.deepEqual(entry.demand, {
    searchTrend: { keyword: '여행 준비 도구', score: 1000, source: 'google_trending', horizon: null, checkedAt: trends.checkedAt },
    source: 'research/trend-radar/latest.json',
  });
  assert.equal(entry.priority.score, withoutDemand.ledger.entries[entry.ledgerId].priority.score + 3);
  assert.ok(entry.priority.reasons.includes('search_demand_signal'));
  assert.equal(entry.priority.advisoryOnly, true);
  assert.ok(withDemand.delta.rows.added.some(row => row.ledgerId === entry.ledgerId));
  assert.match(deltaMarkdown(withDemand.ledger, withDemand.delta), new RegExp(`\\| ${entry.ledgerId} \\|`));

  const aliasEntry = updateLedger(null, { collection, trends: {
    checkedAt: trends.checkedAt, shoppingTrends: trends.shoppingTrends,
  }, trendSource: 'trends.json' }, { now }).ledger.entries[ledgerIdFor(candidate)];
  assert.deepEqual(aliasEntry.demand.searchTrend, {
    keyword: '신혼여행-준비물', score: 78, source: 'naver_shopping_insight', horizon: 'week', checkedAt: trends.checkedAt,
  });

  const unmatched = updateLedger(null, { collection, trends: {
    checkedAt: trends.checkedAt, shoppingTrends: [{ keyword: '비데', score: 85 }],
  } }, { now }).ledger.entries[ledgerIdFor(candidate)];
  assert.deepEqual(unmatched.demand, { searchTrend: null, source: null });
  assert.ok(!unmatched.priority.reasons.includes('search_demand_signal'));
});

test('ledger id map preserves queue and collection ids beside the canonical identity', () => {
  const queueRow = { candidateId: 'queue-123', title: 'Queue candidate', urls: ['https://example.com/q'], sourceKinds: ['news'] };
  const collectionRow = { id: 'source-456', title: 'Collected candidate', urls: [], sourceKind: 'search_signal' };
  const itemRow = { id: 'item-789', title: 'Collected item', urls: ['https://example.com/i'] };
  const idMap = buildIdMap({ queue: { candidates: [queueRow] }, collection: { candidates: [collectionRow], items: [itemRow] } }, new Date('2026-09-24T01:00:00Z'));
  assert.equal(idMap.queueCandidateIds[queueRow.candidateId], ledgerIdFor(queueRow));
  assert.equal(idMap.collectionItemIds[collectionRow.id], ledgerIdFor(collectionRow));
  assert.equal(idMap.collectionItemIds[itemRow.id], ledgerIdFor(itemRow));
  assert.equal(idMap.mappings.length, 3);
});

test('ledger velocity compares three recent observations with one earlier observation', () => {
  const now = new Date('2026-09-24T00:00:00.000Z');
  const candidate = { title: 'Velocity candidate', field: 'ai', urls: [], sourceIds: ['news-velocity'], sourceKind: 'news' };
  let ledger = null;
  let delta;
  for (const checkedAt of [
    '2026-09-19T20:00:00.000Z',
    '2026-09-21T12:00:00.000Z',
    '2026-09-22T12:00:00.000Z',
    '2026-09-23T12:00:00.000Z',
  ]) {
    const updated = updateLedger(ledger, { collection: { checkedAt, candidates: [candidate] } }, { now });
    ledger = updated.ledger;
    delta = updated.delta;
  }
  const entry = ledger.entries[ledgerIdFor(candidate)];
  assert.equal(entry.seenCount, 4);
  assert.equal(entry.velocity, 3);
  assert.equal(entry.newInWindow, false);
  assert.ok(entry.priority.reasons.includes('accelerating'));
  assert.equal(entry.priority.advisoryOnly, true);
  assert.match(deltaMarkdown(ledger, delta), /\| Velocity candidate \| accelerating \| 1 \| 3 \|/);
});

test('ledger recomputes trend fields when loading an older ledger without them', () => {
  const candidate = { title: 'Legacy candidate', field: 'ai', urls: [], sourceIds: ['news-legacy', 'seed:legacy'], sourceKind: 'search_signal' };
  const first = updateLedger(null, { collection: { checkedAt: '2026-09-21T00:00:00.000Z', candidates: [candidate] } },
    { now: new Date('2026-09-21T00:05:00.000Z') });
  const older = structuredClone(first.ledger);
  const oldEntry = older.entries[ledgerIdFor(candidate)];
  delete oldEntry.sourceKindCount;
  delete oldEntry.convergence;
  delete oldEntry.velocity;
  delete oldEntry.newInWindow;
  delete oldEntry.demand;
  const updated = updateLedger(older, { collection: { checkedAt: '2026-09-23T00:00:00.000Z', candidates: [candidate] } },
    { now: new Date('2026-09-23T00:05:00.000Z') });
  const entry = updated.ledger.entries[ledgerIdFor(candidate)];
  assert.equal(entry.seenCount, 2);
  assert.equal(entry.sourceKindCount, 2);
  assert.equal(entry.convergence, true);
  assert.equal(entry.velocity, null);
  assert.equal(entry.newInWindow, true);
  assert.deepEqual(entry.demand, { searchTrend: null, source: null });
});

test('drive sync copies with byte readback, skips denied names and refuses credential-looking content or overwrites', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'ledger-sync-'));
  const root = path.join(base, 'drive'); const run = path.join(base, 'daily-20260924-0730');
  await mkdir(root); await mkdir(path.join(run, 'ledger'), { recursive: true });
  await writeFile(path.join(run, 'collection.json'), JSON.stringify({ candidates: [signal] }));
  await writeFile(path.join(run, 'ledger', 'delta.md'), '# 변화\n');
  await writeFile(path.join(run, 'session-cache.json'), '{}');
  const receipt = await syncRun(run, { root, now: new Date('2026-09-24T00:00:00Z') });
  assert.deepEqual(receipt.files.map(f => f.relativePath), ['collection.json', 'ledger/delta.md']);
  assert.ok(receipt.files.every(f => f.readbackVerified)); assert.equal(receipt.cloudSyncVerified, false);
  assert.deepEqual(receipt.skipped, [{ relativePath: 'session-cache.json', reason: 'denied_name' }]);
  assert.equal((await readFile(path.join(root, 'daily-20260924-0730', 'collection.json'), 'utf8')), JSON.stringify({ candidates: [signal] }));
  await assert.rejects(syncRun(run, { root }), /TARGET_EXISTS/);
  await assert.rejects(syncRun(run, { root: path.join(base, 'missing') }), /DRIVE_ROOT_UNAVAILABLE/);
  const leaky = path.join(base, 'leaky-run'); await mkdir(leaky);
  await writeFile(path.join(leaky, 'receipt.json'), JSON.stringify({ header: 'NID_AUT=abc' }));
  await assert.rejects(scanRun(leaky), /SECRET_PATTERN_DETECTED/);
  await assert.rejects(syncRun(leaky, { root, name: 'leaky' }), /SECRET_PATTERN_DETECTED/);
  assert.ok(!(await readdir(root)).includes('leaky'), 'nothing is written when the scan fails');
});

test('one source is never counted as two evidence kinds', async () => {
  const { groupEvidenceKinds } = await import('../research/content-store/candidate-ledger.mjs');
  assert.deepEqual(groupEvidenceKinds(['realtime-kr-signal'], ['search_signal']), ['realtime']);
  assert.deepEqual(groupEvidenceKinds(['realtime-kr-signal', 'news-kr-tech'], ['search_signal', 'headline_only']).sort(), ['news', 'realtime']);
  assert.deepEqual(groupEvidenceKinds(['unknown-source'], ['search_signal']), ['search_signal']);
});
