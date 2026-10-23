import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normName, nameRegex, flattenComments, extractMentions, collectCommunity, buzzBonus } from '../research/content-store/place-community.mjs';
import { collect, writeRun, rankShops, groupPicks } from '../research/content-store/place-brief.mjs';

const art = (n, over = {}) => ({ id: `/kr/community/post-${n}/`, title: `글${n}`, content: '', subject: '맛집', createdAt: '2026-09-20T00:00:00Z', commentsCount: 0, emotionCount: 0, regionName: '마곡동', authorName: `u${n}`, status: 'NORMAL', ...over });
const comment = (id, content, nick, over = {}) => ({ id, content, status: 'NORMAL', createdAt: '2026-09-21T00:00:00Z', writer: { nickName: nick }, ...over });

test('nameRegex needs 3+ normalized characters and tolerates spacing inside the name', () => {
  assert.equal(nameRegex('김밥'), null);
  assert.equal(normName('에머이 마곡나루점'), '에머이');
  assert.ok(nameRegex('제주담돌 마곡본점').test('제주담돌 다녀왔어요'));
  assert.ok(!nameRegex('제주담돌 마곡본점').test('제주담 갔어요'));
  assert.ok(nameRegex('제주담돌 마곡본점').test('발산 제주 담돌 다녀왔어요'));
  assert.ok(!nameRegex('제주담돌').test('제주도 돌담'));
});

test('flattenComments merges both sort orders, drops non-NORMAL, and walks replies once', () => {
  const ca = { comments: {
    createdSortedComments: [comment(1, 'A집 추천', 'x', { subComments: [comment(3, '동의', 'y')] }), comment(2, '삭제됨', 'z', { status: 'DELETED' })],
    recentSortedComments: [comment(1, 'A집 추천', 'x'), comment(4, '나도', 'w')],
  } };
  assert.deepEqual(flattenComments(ca).map(c => c.id).sort(), ['1', '3', '4']);
});

test('extractMentions counts distinct voices, flags negative cues, and ignores short names', () => {
  const threads = [
    { id: 't1', url: 'u1', title: '점심 추천', content: '', author: 'asker', createdAt: '2026-09-20', comments: [
      { id: 'c1', text: '에머이 마곡나루 가세요', author: 'a', createdAt: '2026-09-21' },
      { id: 'c2', text: '에머이 마곡나루 별로였어요 실망', author: 'b', createdAt: '2026-09-22' },
      { id: 'c3', text: '에머이 마곡나루 또 갔어요', author: 'a', createdAt: '2026-09-23' }] },
    { id: 't2', url: 'u2', title: '김밥 어디', content: '김밥 맛집', author: 'c', createdAt: '2026-09-19', comments: [] },
  ];
  const m = extractMentions(threads, [{ id: '1', name: '에머이 마곡나루점' }, { id: '2', name: '김밥' }]);
  const e = m.get('1');
  assert.equal(e.voices, 2);
  assert.equal(e.comments, 3);
  assert.equal(e.negativeMentions, 1);
  assert.equal(e.snippets[0].negativeCue, true);
  assert.equal(m.has('2'), false);
  assert.equal(buzzBonus(e), 0.1);
  assert.equal(buzzBonus({ voices: 9 }), 0.15);
});

const NEARBY = [{ id: 6052, name: '마곡동', name2: '강서구' }, { id: 6053, name: '발산1동', name2: '강서구' }, { id: 9, name: '여의도동', name2: '영등포구' }];
const listBody = region => ({ nearbyRegions: NEARBY, communityArticles: region === '마곡동' ? [art(1, { commentsCount: 3 }), art(2, { subject: '동네질문' }), art(3, { status: 'HIDDEN' })] : [art(1, { commentsCount: 3 }), art(4, { commentsCount: 1 })] });
const jsonRes = (body, status = 200) => ({ status, text: async () => JSON.stringify(body) });

function mockFetch(calls) {
  return async url => {
    const u = new URL(url); calls.push(u.pathname + u.search);
    const data = u.searchParams.get('_data');
    if (data === 'routes/kr.search.community._index') return jsonRes(listBody(u.searchParams.get('in').split('-')[0]));
    if (data === 'routes/kr.community.$community_agora_id') return jsonRes({ data: { communityArticle: { title: '글', content: '본문', comments: { createdSortedComments: [comment(1, '에머이 마곡나루 추천', `n${u.pathname}`)], recentSortedComments: [] } } } });
    if (data === 'routes/kr.search.local-profile') return jsonRes({ searchRegion: { id: '6052', name: '마곡동' }, regionBounds: { north: 1, south: 0, east: 1, west: 0 } });
    if (u.pathname === '/kr/api/v1/local-profiles/search') return jsonRes({ searchResult: { localProfiles: [{ id: 'p1', name: '에머이 마곡나루점', starRating: 4.6, reviewCount: 80, roadAddress: '서울 강서구 마곡동', operationStatus: 'OPEN', category: { name: '베트남음식' } }, { id: 'p2', name: '다른가게', starRating: 4.6, reviewCount: 80, roadAddress: '서울 강서구 마곡동', operationStatus: 'OPEN' }] } });
    return { status: 200, text: async () => '<html></html>' };
  };
}

test('collectCommunity walks the 구 dongs only, dedupes articles, keeps NORMAL 맛집 posts, and fetches commented ones', async () => {
  const calls = []; const logged = [];
  const getJson = async (url, tag) => { const res = await mockFetch(calls)(url); const raw = await res.text(); logged.push(tag); return { status: res.status, body: JSON.parse(raw) }; };
  const { threads, stats } = await collectCommunity({ area: '강서구', seed: { id: 6052, name: '마곡동' }, getJson, pauseMs: 0 });
  assert.deepEqual(stats.regions.map(r => r.region), ['마곡동', '발산1동']);
  assert.deepEqual(threads.map(t => t.id).sort(), ['/kr/community/post-1/', '/kr/community/post-4/']);
  assert.equal(stats.postsFetched, 2);
  assert.ok(logged.includes('community:발산1동') && logged.some(t => t.startsWith('post:')));
  assert.ok(threads.every(t => t.commentsFetched && t.comments.length === 1));
});

test('collect attaches community mentions to shops, lifts pickScore, adds byBuzz, and saves community captures as json', async () => {
  const calls = [];
  const result = await collect('강서구', { queries: ['마곡역 맛집'], fetchImpl: mockFetch(calls), detail: 0, lowDetail: 0, pauseMs: 0, minReviews: 15 });
  const emai = result.brief.shops.find(s => s.id === 'p1');
  const other = result.brief.shops.find(s => s.id === 'p2');
  assert.ok(emai.community.voices >= 2);
  assert.equal(other.community, null);
  assert.ok(emai.pickScore > emai.bayesScore);
  assert.deepEqual(result.brief.picks.byBuzz, ['p1']);
  assert.equal(result.brief.community.mentionedShops, 1);
  const dir = writeRun('강서구', result, mkdtempSync(path.join(os.tmpdir(), 'pc-')));
  const files = readdirSync(path.join(dir, 'captures'));
  assert.ok(files.some(f => /community_/.test(f) && f.endsWith('.json')) && files.some(f => /post_/.test(f) && f.endsWith('.json')));
});

test('collect survives a community failure and --no-community skips it with a gap note', async () => {
  const base = mockFetch([]);
  const broken = async (url, o) => { if (String(url).includes('search/community')) throw new Error('boom'); return base(url, o); };
  const r1 = await collect('강서구', { queries: ['마곡역 맛집'], fetchImpl: broken, detail: 0, lowDetail: 0, pauseMs: 0 });
  assert.ok(r1.brief.shops.length === 2 && r1.brief.gaps.some(g => g.includes('커뮤니티 글 수집 실패')));
  const r2 = await collect('강서구', { queries: ['마곡역 맛집'], fetchImpl: base, detail: 0, lowDetail: 0, pauseMs: 0, community: false });
  assert.equal(r2.brief.community, null);
  assert.ok(r2.brief.gaps.some(g => g.includes('--no-community')));
});

test('extractMentions skips shops named like a place so region talk is not counted as a shop', () => {
  const threads = [{ id: 't', url: 'u', title: '공항동 근처 맛집', content: '', author: 'a', createdAt: '2026-09-20', comments: [{ id: 'c', text: '마곡나루역 쪽도 좋아요', author: 'b', createdAt: null }] }];
  const m = extractMentions(threads, [{ id: '1', name: '공항동' }, { id: '2', name: '마곡나루역' }, { id: '3', name: '초록식당' }], { skipNames: ['공항동'] });
  assert.equal(m.size, 0);
});

test('rankShops without community data behaves as before', () => {
  const shops = [{ id: 'a', name: '가나다식당', inArea: true, operationStatus: 'OPEN', rating: 4.5, reviewCount: 30, category: null, description: '', sampleReview: null, reviewIncentive: false }];
  const [s] = rankShops(shops);
  assert.equal(s.buzzBonus, 0);
  assert.equal(s.pickScore, s.bayesScore);
  assert.deepEqual(groupPicks([s]).byBuzz, []);
});
