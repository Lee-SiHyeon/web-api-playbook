import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBlogSearch, parseDaumBlog, parseNaverWeb, parseTistoryVisitors, siteOf, parseVisitorXml, blogInfoFields, scoreBlogs, rankSns, scout } from '../research/content-store/reference-scout.mjs';

// Trimmed from the 2026-09-25 blog-tab markup: profile link (nickname, age, Keep), title link, snippet link, image link.
const result = (id, logNo, blogName, nick, title, snippet) => `
<a href="https://blog.naver.com/${id}">${blogName}<span>새 창 열림</span></a>
<a href="https://blog.naver.com/${id}/${logNo}"><span>${nick}</span><span>2주 전</span>Keep에 저장</a>
<a href="https://blog.naver.com/${id}/${logNo}"><span>${title}</span><span>새 창 열림</span></a>
<a href="https://blog.naver.com/${id}/${logNo}">${snippet}</a>
<a href="https://blog.naver.com/${id}/${logNo}"><img src="x.png"></a>`;
const SEARCH = result('travelA', '224400000001', '여행 블로그 A', '에이', '10월 연휴 여행지 추천 BEST 5', '가을 연휴에 가기 좋은 여행지를 가격과 함께 정리했습니다. 짧게 다녀오기 좋은 곳 위주입니다.')
  + result('travelB', '224400000002', '여행 블로그 B', '비', '항공권 특가 총정리', '이번 주 항공권 특가를 항공사별로 모았습니다. 할인코드와 탑승 기간을 확인하세요.');

test('blog search results keep rank order and separate title, snippet and blog name', () => {
  const rows = parseBlogSearch(SEARCH);
  assert.deepEqual(rows.map(r => [r.rank, r.blogId, r.logNo]), [[1, 'travelA', '224400000001'], [2, 'travelB', '224400000002']]);
  assert.equal(rows[0].title, '10월 연휴 여행지 추천 BEST 5');
  assert.equal(rows[0].blogName, '여행 블로그 A');
  assert.match(rows[0].snippet, /가을 연휴에/);
  assert.throws(() => parseBlogSearch('<html>자동입력 방지 문자를 입력하세요</html>'), /SEARCH_CHALLENGE/);
});

test('visitor XML and blog info map to numbers; a hidden widget is an empty series', () => {
  assert.deepEqual(parseVisitorXml('<visitorcnts><visitorcnt id="20260924" cnt="1310" /><visitorcnt id="20260925" cnt="310" /></visitorcnts>'),
    [{ date: '20260924', count: 1310 }, { date: '20260925', count: 310 }]);
  assert.deepEqual(parseVisitorXml(''), []);
  assert.deepEqual(blogInfoFields({ isSuccess: true, result: { blogId: 'b', blogName: 'B', dayVisitorCount: 310, totalVisitorCount: 434466, subscriberCount: 3814, powerBlog: false } }),
    { blogId: 'b', blogName: 'B', dayVisitorCount: 310, totalVisitorCount: 434466, subscriberCount: 3814, powerBlog: false, officialBlog: false });
  assert.throws(() => blogInfoFields({}), /BLOG_INFO_SCHEMA/);
});

test('scores favour breadth across keywords, then rank, then audience; today is excluded from the average', () => {
  const rankings = [
    { keyword: 'k1', rank: 5, blogId: 'wide', logNo: '1', url: 'u1', title: 't1' }, { keyword: 'k2', rank: 6, blogId: 'wide', logNo: '2', url: 'u2', title: 't2' },
    { keyword: 'k1', rank: 1, blogId: 'narrow', logNo: '3', url: 'u3', title: 't3' }, { keyword: 'k1', rank: 2, blogId: 'self', logNo: '4', url: 'u4', title: 't4' }];
  const infos = new Map([['wide', { visitorSeries: [{ count: 100 }, { count: 300 }, { count: 5 }], subscriberCount: 10 }],
    ['narrow', { visitorSeries: [{ count: 99999 }, { count: 1 }], subscriberCount: 50000 }]]);
  const scored = scoreBlogs(rankings, infos, { exclude: ['self'] });
  assert.deepEqual(scored.map(b => b.blogId), ['wide', 'narrow']);
  assert.equal(scored[0].avgDailyVisitors, 200); assert.equal(scored[0].appearances, 2);
});

test('SNS creators rank by average likes from collected posts', () => {
  const sns = rankSns({ candidates: [
    { sourceKind: 'public_social_post', publisher: 'a', field: 'ai', engagement: { likes: 30, reposts: 2 }, urls: ['https://x/1'], title: 'p1', sourceIds: ['s-a'] },
    { sourceKind: 'public_social_post', publisher: 'a', field: 'ai', engagement: { likes: 10 }, urls: ['https://x/2'], title: 'p2', sourceIds: ['s-a'] },
    { sourceKind: 'public_social_post', publisher: 'b', field: 'ai', engagement: { likes: 50 }, urls: ['https://x/3'], title: 'p3', sourceIds: ['s-b'] },
    { sourceKind: 'headline_only', publisher: 'c', engagement: { likes: 999 } }] });
  assert.deepEqual(sns.map(s => [s.publisher, s.avgLikes, s.posts]), [['b', 50, 1], ['a', 20, 2]]);
});

test('scout stops at the first block and records it instead of retrying', async () => {
  let calls = 0;
  const fetchImpl = async url => { calls++; return url.startsWith('https://search.naver.com') ? new Response('', { status: 429 }) : new Response('{}'); };
  const r = await scout({ genres: { g: ['k1', 'k2', 'k3'] }, fetchImpl, delayMs: 0 });
  assert.equal(calls, 1); assert.equal(r.coverage.blocked, true); assert.deepEqual(r.failures, [{ step: 'search', source: 'naver_blog', keyword: 'k1', code: 'ACCESS_BLOCKED' }]);
});

test('site ids: Naver blog id, Tistory host, Brunch author, bare web host; portals are dropped', () => {
  assert.deepEqual(siteOf('https://m.blog.naver.com/abc/224400000001?x=1'), { platform: 'naver', blogId: 'abc', logNo: '224400000001', url: 'https://blog.naver.com/abc/224400000001' });
  assert.equal(siteOf('https://hoony88.tistory.com/125').blogId, 'hoony88.tistory.com');
  assert.equal(siteOf('https://hoony88.tistory.com/entry/%ED%81%B4').logNo, 'entry/클');
  assert.equal(siteOf('https://hoony88.tistory.com/'), null, 'a blog home is not a post');
  assert.equal(siteOf('https://brunch.co.kr/@writer/12').blogId, 'brunch.co.kr/@writer');
  assert.equal(siteOf('https://www.sireal.co/blog/x').blogId, 'sireal.co');
  assert.equal(siteOf('https://velog.io/@dev/ai-tools').blogId, 'velog.io/@dev');
  assert.equal(siteOf('https://shopping.naver.com/x'), null);
});

// Trimmed from the 2026-09-25 Daum blog results: one card per result, link and title in the share JSON.
const card = (docid, link, host, name, title, desc) => `<c-card data-docid="${docid}"><c-header-item data-href="https://${host}/"><c-breadcrumb><c-frag>${host}</c-frag><c-frag>${name}</c-frag></c-breadcrumb>
<q-share-sns><script slot="data" type="application/json">{"link": "${link}", "prefix": "${title}", "service_name": "블로그"}</script></q-share-sns></c-header-item>
<c-contents-desc slot="contents">${desc}</c-contents-desc></c-card>`;

test('Daum blog cards keep order across Tistory and Naver and skip non-post links', () => {
  const html = card('tstory-1_125', 'https://hoony88.tistory.com/125', 'hoony88.tistory.com', 'Hoony AI Lab', '[코딩에이전트] 클로드 아티팩트 사용법', '클로드 <b>사용법</b> 정리')
    + card('nvblg_x', 'https://blog.naver.com/design-_/224359706194', 'blog.naver.com', 'design', '바이브코딩 뜻 클로드 사용법', 'd')
    + card('etc', 'https://daumsearch.tistory.com', 'daumsearch.tistory.com', 'x', 'x', 'x');
  const rows = parseDaumBlog(html);
  assert.deepEqual(rows.map(r => [r.rank, r.platform, r.blogId, r.title]), [[1, 'tistory', 'hoony88.tistory.com', '[코딩에이전트] 클로드 아티팩트 사용법'], [2, 'naver', 'design-_', '바이브코딩 뜻 클로드 사용법']]);
  assert.equal(rows[0].blogName, 'Hoony AI Lab');
  assert.equal(rows[0].snippet, '클로드 사용법 정리');
});

test('Naver web results take the headline as title and drop excluded hosts', () => {
  const r = (url, site, title, desc) => `<a class="a" nocr="1" href="${url}" target="_blank" data-heatmap-target=".link"><div>${site} › guide</div></a>
<a href="${url}" data-heatmap-target=".simg"><img></a>
<a class="c" nocr="1" href="${url}" target="_blank" data-heatmap-target=".link"><span class="sds-comps-text-type-headline1">${title}</span></a>
<a class="d" nocr="1" href="${url}" target="_blank" data-heatmap-target=".link"><span>${desc}</span></a>`;
  const html = r('https://code.claude.com/docs/ko/quickstart', 'claude.com', '빠른 시작', 'x') + r('https://easynjobs.net/claude-ai-guide-2026/', 'easynjobs.net', '클로드 Claude 사용법 완벽 가이드', '설명')
    + r('https://hoony88.tistory.com/63', 'hoony88.tistory.com', '클로드 코드 입문', '설명2');
  const rows = parseNaverWeb(html, { excludeHosts: ['(^|\.)claude\.(ai|com)$'] });
  assert.deepEqual(rows.map(x => [x.rank, x.platform, x.blogId, x.title]), [[1, 'web', 'easynjobs.net', '클로드 Claude 사용법 완벽 가이드'], [2, 'tistory', 'hoony88.tistory.com', '클로드 코드 입문']]);
  assert.equal(rows[0].snippet, '설명');
});

test('Tistory visitor widgets in two skin layouts; a skin without one yields nulls', () => {
  assert.deepEqual(parseTistoryVisitors('<meta property="og:site_name" content="Hoony AI Lab"><div class="widget widget-visitor"><h3>Visitors</h3><span class="visitor-label">Yesterday</span><span class="visitor-count">30</span><span class="visitor-label">Today</span><span class="visitor-count today">12</span><span class="visitor-label">Total</span><span class="visitor-count">680</span></div>'),
    { blogName: 'Hoony AI Lab', today: 12, yesterday: 30, total: 680 });
  assert.deepEqual(parseTistoryVisitors('<title>말양 뉴스</title><div class="box-visit"><h3 class="title-sidebar">Total</h3><p class="text-total">2,378</p><ul><li class="item-visit">Today : 30</li><li class="item-visit">Yesterday : 145</li></ul></div>'),
    { blogName: '말양 뉴스', today: 30, yesterday: 145, total: 2378 });
  assert.deepEqual(parseTistoryVisitors('<title>t</title><p>no widget</p>'), { blogName: 't', today: null, yesterday: null, total: null });
});

test('mixed-source scout: web sites are ranked but not measured, Tistory is measured from its home page', async () => {
  const calls = [];
  const fetchImpl = async url => { calls.push(url);
    if (url.startsWith('https://search.daum.net')) return new Response(card('t', 'https://hoony88.tistory.com/125', 'hoony88.tistory.com', 'Hoony', '클로드 사용법', 'd'));
    if (url.includes('tab.web.all')) return new Response('<a class="c" href="https://easynjobs.net/a/" data-heatmap-target=".link"><span class="headline1">가이드 글</span></a>');
    if (url === 'https://hoony88.tistory.com/') return new Response('<div class="box-visit">Total 2,378 Today : 30 Yesterday : 145</div>');
    return new Response('', { status: 500 }); };
  const r = await scout({ genres: { ai: { keywords: ['k'], sources: ['daum_blog', 'naver_web'] } }, fetchImpl, delayMs: 0 });
  assert.equal(r.coverage.searches, 2); assert.equal(r.failures.length, 0);
  assert.ok(!calls.some(u => u.includes('easynjobs')), 'web sites are not fetched');
  const byId = Object.fromEntries(r.genres.ai.blogs.map(b => [b.blogId, b]));
  assert.equal(byId['hoony88.tistory.com'].avgDailyVisitors, 145);
  assert.equal(byId['easynjobs.net'].platform, 'web'); assert.equal(byId['easynjobs.net'].avgDailyVisitors, null);
});

test('rescore drops excluded web hosts by group and re-ranks without new requests', async () => {
  const { rescore } = await import('../research/content-store/reference-scout.mjs');
  const row = (blogId, platform, keyword, rank) => ({ genre: 'hotdeal', keyword, source: platform === 'naver' ? 'naver_blog' : 'naver_web', platform, rank, blogId, logNo: '1', url: `https://${blogId}/1`, title: 't' });
  const earlier = { coverage: { searches: 2 }, genres: { hotdeal: { keywords: ['a', 'b'], blogs: [] } }, blogs: [{ blogId: 'naverA', dayVisitorCount: 100, visitorSeries: [] }],
    rankings: [row('hotdealview.com', 'web', 'a', 1), row('hotdealview.com', 'web', 'b', 1), row('naverA', 'naver', 'a', 2), row('jkhotdeal.com', 'web', 'b', 3)] };
  const r = rescore(earlier, { excludeHosts: { price_tools: ['hotdealview\.com$'] } });
  assert.deepEqual(r.genres.hotdeal.blogs.map(b => b.blogId), ['naverA', 'jkhotdeal.com']);
  assert.equal(r.genres.hotdeal.blogs[0].avgDailyVisitors, 100);
  assert.equal(r.coverage.excludedRankings, 2);
});

test('Tistory subscribers come from /m/api/blog/info; minSubscribers drops known small blogs but keeps web sites', async () => {
  const { tistoryInfoFields, enrichTistory, rescore } = await import('../research/content-store/reference-scout.mjs');
  assert.deepEqual(tistoryInfoFields({ data: { blogTitle: '코딩팩토리', blogFollowerCount: 1319 } }), { blogName: '코딩팩토리', followers: 1319 });
  const row = (blogId, platform, rank) => ({ genre: 'ai', keyword: 'k', source: 's', platform, rank, blogId, logNo: '1', url: platform === 'web' ? 'https://' + blogId + '/a' : 'https://' + blogId + '/1', title: 't' });
  const earlier = { genres: { ai: { keywords: ['k'], blogs: [] } }, coverage: {}, failures: [],
    rankings: [row('big.tistory.com', 'tistory', 1), row('small.tistory.com', 'tistory', 2), row('site.example', 'web', 3), row('tinyNaver', 'naver', 4)],
    blogs: [{ blogId: 'tinyNaver', platform: 'naver', subscriberCount: 125, visitorSeries: [] }] };
  const fetchImpl = async url => url.endsWith('/m/api/blog/info')
    ? new Response(JSON.stringify({ data: { blogTitle: url.includes('big') ? 'Big' : 'Small', blogFollowerCount: url.includes('big') ? 1319 : 40 } }))
    : new Response('<div class="box-visit">Total 10 Today : 1 Yesterday : 2</div>');
  const enriched = await enrichTistory(earlier, { fetchImpl, delayMs: 0 });
  const r = rescore(enriched, { minSubscribers: 1000 });
  assert.deepEqual(r.genres.ai.blogs.map(b => b.blogId), ['big.tistory.com', 'site.example']);
  assert.equal(r.genres.ai.blogs[0].subscribers, 1319);
});
