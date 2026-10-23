import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyMenu, situationTags, hasReviewIncentive, bayes, parseLocalBusiness, parseRemixReviews, splitReviews, normalizeShop, rankShops, groupPicks, defaultQueries, collect, writeRun } from '../research/content-store/place-brief.mjs';

const profile = (id, name, cat, rating, n, extra = {}) => ({
  id: String(id), name, category: { name: cat }, starRating: rating, reviewCount: n, followersCount: 1,
  roadAddress: `서울특별시 강서구 어딘가로 ${id}`, region: { name: '화곡동' }, operationStatus: 'OPEN',
  permalink: `/kr/local-profile/${id}/`, coordinates: { latitude: 37.5, longitude: 126.8 }, description: '', ...extra,
});

test('menu classification uses the 당근 category first, shop name second, else 기타', () => {
  assert.equal(classifyMenu('돼지고기', '고기가땡겨').id, 'grill');
  assert.equal(classifyMenu('족발/보쌈', 'x').id, 'korean');
  assert.equal(classifyMenu('초밥', 'x').id, 'japanese');
  assert.equal(classifyMenu('치킨/닭강정', '푸라닭').id, 'other');
  assert.equal(classifyMenu('', '스시 오마카세').id, 'japanese');
});

test('situation tags carry the matched snippet; review-incentive wording is detected', () => {
  const t = situationTags('아이와 함께 오기 좋은 푸짐한 집');
  assert.deepEqual(t.map(x => x.id).sort(), ['value', 'with_children']);
  assert.ok(t[0].matched.length > 0);
  assert.equal(hasReviewIncentive('단골 후기 써 주시면 음료수 서비스 드립니다'), true);
  assert.equal(hasReviewIncentive('리뷰 이벤트 진행중'), true);
  assert.equal(hasReviewIncentive('생삼겹 냉삼 식사합니다'), false);
});

test('ranking: out-of-area, closed, and thin-review shops are excluded; a review incentive lowers pickScore', () => {
  const shops = [
    normalizeShop(profile(1, 'A', '한식', 4.8, 200), '강서구'),
    normalizeShop(profile(2, 'B', '한식', 4.9, 5), '강서구'),
    normalizeShop(profile(3, 'C', '한식', 4.9, 300, { roadAddress: '서울특별시 양천구 x' , jibunAddress: '' }), '강서구'),
    normalizeShop(profile(4, 'D', '한식', 4.9, 300, { operationStatus: 'CLOSED' }), '강서구'),
    normalizeShop(profile(5, 'E', '한식', 4.8, 200, { description: '후기 이벤트 진행' }), '강서구'),
  ];
  const ranked = rankShops(shops, { minReviews: 15 });
  assert.deepEqual(ranked.map(s => s.id), ['1', '5']);
  assert.ok(ranked[0].pickScore > ranked[1].pickScore);
  assert.equal(ranked[1].reviewIncentive, true);
});

test('official cross-check matches by normalized name and picks group by menu and situation', () => {
  const shops = [
    normalizeShop(profile(1, '도화루', '일반중식점', 4.6, 40, { description: '가성비 좋은 중국집' }), '강서구'),
    normalizeShop(profile(2, '나들이김밥', '김밥', 4.5, 30), '강서구'),
  ];
  const ranked = rankShops(shops, { official: [{ name: '도화 루', source: '착한가격업소', url: 'https://www.goodprice.go.kr/x' }] });
  assert.equal(ranked.find(s => s.id === '1').official.source, '착한가격업소');
  assert.equal(ranked.find(s => s.id === '2').official, null);
  const picks = groupPicks(ranked);
  assert.deepEqual(picks.byMenu['중식'], ['1']);
  assert.deepEqual(picks.bySituation['가성비'], ['1']);
});

test('shop detail JSON-LD gives hours, phone and dated reviews', () => {
  const html = `<script type="application/ld+json">{"@type":"BreadcrumbList"}</script><script type="application/ld+json">${JSON.stringify({
    '@type': 'LocalBusiness', telephone: '0212345678', address: { streetAddress: '서울 강서구 x' },
    aggregateRating: { ratingValue: '4.9', reviewCount: 85 },
    openingHoursSpecification: [{ dayOfWeek: 'https://schema.org/Monday', opens: '09:00', closes: '23:50' }],
    review: [{ datePublished: '2026-03-31T12:47:16Z', reviewRating: { ratingValue: 5 }, reviewBody: '맛있어요' }],
  })}</script>`;
  const d = parseLocalBusiness(html);
  assert.equal(d.hours.Monday, '09:00-23:50');
  assert.equal(d.aggregateRating.count, 85);
  assert.equal(d.reviews[0].date, '2026-03-31');
  assert.equal(parseLocalBusiness('<html></html>'), null);
});

test('reviews split by rating and low ratings are kept verbatim, lowest first', () => {
  const s = splitReviews([{ rating: 5, text: 'a' }, { rating: 4.5, text: 'b' }, { rating: 3, text: 'c' }, { rating: 1, text: '불친절' }, { rating: null, text: 'd' }, { rating: 0, text: '옛 후기' }]);
  assert.deepEqual(s.split, { positive: 2, neutral: 1, negative: 1, unrated: 2 });
  assert.deepEqual(s.lowReviews.map(r => r.text), ['불친절', 'c']);
  assert.equal(s.sampleSize, 6);
});

test('customer review text comes from the remix context, not the JSON-LD owner reply', () => {
  const ctx = { state: { loaderData: { r: { reviews: [
    { __typename: 'BusinessReview', starRating: 1, content: '너무 짜요', createdAt: '2026-05-01T00:00:00Z', tags: [], comment: { content: '죄송합니다' } },
    { __typename: 'BusinessReview', starRating: 5, content: '맛있어요', createdAt: '2026-05-02T00:00:00Z', tags: [], comment: null },
  ] } } } };
  const html = `<script>window.__remixContext = ${JSON.stringify(ctx)};</script>`;
  const r = parseRemixReviews(html);
  assert.equal(r[0].text, '너무 짜요');
  assert.equal(r[0].ownerReply, '죄송합니다');
  assert.equal(r[1].ownerReply, null);
  const ld = `<script type="application/ld+json">${JSON.stringify({ '@type': 'LocalBusiness', priceRange: '₩3000~62000', review: [{ datePublished: '2026-01-01T00:00:00Z', reviewRating: { ratingValue: 3 }, reviewBody: '방문 감사합니다' }] })}</script>`;
  const d = parseLocalBusiness(ld);
  assert.equal(d.priceRange, '₩3000~62000');
  assert.equal(d.reviews[0].text, null);
  assert.equal(d.reviews[0].ownerReply, '방문 감사합니다');
  assert.equal(parseLocalBusiness(ld + html).reviews[0].text, '너무 짜요');
});

test('defaultQueries builds station and dong queries from aliases without doubling suffixes', () => {
  assert.deepEqual(defaultQueries(['마곡', '공항동']), ['마곡역 맛집', '마곡동 맛집', '공항동 맛집']);
});

test('bayes shrinks small samples toward the pool mean', () => {
  assert.ok(bayes(5, 3, 4.3) < bayes(4.8, 300, 4.3));
});

test('collect walks route -> search -> detail, records the served region, and writeRun saves raw captures', async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    const u = new URL(url);
    const ok = (body, type = 'json') => ({ status: 200, text: async () => (type === 'json' ? JSON.stringify(body) : body) });
    if (u.searchParams.get('_data')) {
      if (u.searchParams.get('q') === '없는역 맛집') return ok({});
      return ok({ searchRegion: { id: '6057', name: '화곡동' }, regionBounds: { west: 1, south: 2, east: 3, north: 4 } });
    }
    if (u.pathname.endsWith('/local-profiles/search')) {
      assert.equal(u.searchParams.get('region_id'), '6057');
      assert.equal(u.searchParams.get('topLeftLat'), '4');
      return ok({ searchRegion: { id: '6057', name: '화곡동' }, searchResult: { localProfiles: [profile(1, 'A', '한식', 4.8, 100), profile(2, 'B', '초밥', 4.6, 50)] } });
    }
    return ok('<html></html>', 'html');
  };
  const { brief, captures } = await collect('강서구', { queries: ['화곡역 맛집', '없는역 맛집'], fetchImpl, detail: 1, pauseMs: 0 });
  assert.equal(brief.candidateCount, 2);
  assert.equal(brief.requests[0].region.name, '화곡동');
  assert.match(brief.requests[1].note, /경계/);
  assert.equal(brief.picks.overall[0], '1');
  assert.ok(brief.gaps.some(g => /공식 목록/.test(g)));
  assert.deepEqual((await collect('강서구', { queries: ['화곡역 맛집'], fetchImpl, detail: 0, pauseMs: 0, official: [{ name: 'A' }, { name: 'ZZ' }] })).brief.officialCheck.map(o => [o.name, o.found]), [['A', true], ['ZZ', false]]);
  assert.equal(calls.filter(c => new URL(c).pathname.startsWith('/kr/local-profile/')).length, 1);
  const root = mkdtempSync(path.join(os.tmpdir(), 'pb-'));
  const dir = writeRun('강서구', { brief, captures }, root);
  const saved = JSON.parse(readFileSync(path.join(dir, 'place-brief.json'), 'utf8'));
  assert.equal(saved.captureFiles.length, captures.length);
  assert.ok(existsSync(path.join(dir, 'captures', saved.captureFiles[0].file)));
});
