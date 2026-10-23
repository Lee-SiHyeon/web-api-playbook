import test from 'node:test';
import assert from 'node:assert/strict';
import { flightText, parseCategoryCafes, parseCafePosts, parsePost, postFeatures, postKind, rankPosts, pickCafes, styleCard, styleCardsMarkdown, hotPosts } from '../research/content-store/daangn-reference-scout.mjs';

// Pages carry their data as Next.js flight chunks: self.__next_f.push([1,"<JSON-encoded string>"]) (observed 2026-09-26).
const page = payload => `<html><script>self.__next_f.push([1,${JSON.stringify('66:["$","$L75",null,')}])</script><script>self.__next_f.push([1,${JSON.stringify(payload)}])</script></html>`;
const CATEGORY = page(JSON.stringify({ state: { queries: [{ state: { data: { pages: [{ items: [
  { id: '1', name: '대한민국 자영업 커뮤니티 ', description: '사장님들의 고민', location: '인천시', memberCount: '11,160', category: '경제/소비', slug: 'x6idgz' },
  { id: '2', name: '특공 :: 특가정보 공유카페', description: '핫딜 공유', location: '경기도', memberCount: '580', category: '경제/소비', slug: 'teuggong' },
], pagination: { endCursor: 'c', hasNext: true } }] } } }] } }));
const CAFE = page(JSON.stringify({ state: { queries: [{ state: { data: { pages: [{ items: [
  { id: 1, title: '이런 알바생 어떻게 대처하시나요', createdAt: '2026-09-20T01:00:00Z', boardName: '✅️ 자유게시판', viewCount: 6875, likeCount: 3, commentCount: 35, href: '/x6idgz/posts/이런-알바생-어떻게-대처하시나요-dz9EkWyP', isPinned: false, publishType: 'public' },
  { id: 2, title: '대자커 이용안내', createdAt: '2026-06-01T01:00:00Z', boardName: '📢 공지', viewCount: 90000, likeCount: 0, commentCount: 0, href: '/x6idgz/posts/대자커-이용안내-jvN09NLj', isPinned: true, publishType: 'public' },
  { id: 3, title: '오늘 장사', createdAt: '2026-08-01T01:00:00Z', boardName: '자유', viewCount: 9999, likeCount: 1, commentCount: 2, href: '/x6idgz/posts/오늘-장사-jvq4EVmd', isPinned: false, publishType: 'public' },
] }] } } }] } }));
const POST = page(JSON.stringify({ cafeSlug: 'silpae', cafeId: 1, postId: 9, title: '1박 8만원대 양옆 계곡이 흐르는 글램핑장 💖', author: { nickname: '숨김' }, cafeName: '실패없는 여행', memberCount: '420',
  blocks: [{ type: 'video', id: 'v' }, { type: 'paragraph', id: 'a', text: '양 옆이 계곡인데 1박 8만원대..?! 💦', segments: [{ text: '양 옆이 계곡인데 1박 8만원대..?! 💦' }] },
    { type: 'paragraph', id: 'b', text: '💡 방문 전 꿀팁', segments: [{ text: '💡 방문 전 꿀팁', bold: true }] },
    { type: 'paragraph', id: 'c', text: '- 수영장은 어른용/아이용 2개 운영', segments: [{ text: '- 수영장은 어른용/아이용 2개 운영' }] },
    { type: 'paragraph', id: 'd', text: '- 반려동물 동반 가능 객실 보유 🐶', segments: [{ text: '- 반려동물 동반 가능 객실 보유 🐶' }] },
    { type: 'paragraph', id: 'e', text: '여러분은 어디로 가세요?', segments: [{ text: '여러분은 어디로 가세요?' }] }],
  createdAt: '2026-09-20T01:00:00Z', likeCount: 2, commentCount: 3, viewCount: 1688, comments: [{ author: { nickname: '댓글러' }, content: '좋아요' }] }));

test('flight chunks decode and category pages list cafes with numeric member counts', () => {
  assert.match(flightText(CATEGORY), /"memberCount":"11,160"/);
  const cafes = parseCategoryCafes(CATEGORY);
  assert.deepEqual(cafes.map(c => [c.slug, c.name, c.members]), [['x6idgz', '대한민국 자영업 커뮤니티', 11160], ['teuggong', '특공 :: 특가정보 공유카페', 580]]);
  assert.deepEqual(pickCafes(cafes, { minMembers: 1000 }).map(c => c.slug), ['x6idgz']);
  assert.deepEqual(pickCafes(cafes, { cafeKeywords: ['핫딜'], minMembers: 300 }).map(c => c.slug), ['teuggong']);
});

test('cafe posts keep counts and encoded links; ranking skips pinned and notice boards and honours the window', () => {
  const posts = parseCafePosts(CAFE, 'x6idgz');
  assert.equal(posts.length, 3);
  assert.equal(posts[0].url, `https://cafe.daangn.com/x6idgz/posts/${encodeURIComponent('이런-알바생-어떻게-대처하시나요-dz9EkWyP')}`);
  const ranked = rankPosts(posts, { now: new Date('2026-09-26T00:00:00Z'), excludeBoards: ['공지'] });
  assert.deepEqual(ranked.map(p => p.postId), [3, 1]);
  const week = rankPosts(posts, { now: new Date('2026-09-26T00:00:00Z'), days: 7, excludeBoards: ['공지'] });
  assert.deepEqual(week.map(p => [p.postId, p.ageDays, p.viewsPerDay]), [[1, 6, 1146]]);
});

test('a post page yields its shape: one line per paragraph, media first, list lines, no names kept', () => {
  const post = parsePost(POST);
  const f = postFeatures(post);
  assert.equal(f.mediaFirst, true);
  assert.equal(f.videos, 1);
  assert.equal(f.paragraphs, 5);
  assert.equal(f.linesPerParagraph, 1);
  assert.equal(f.urls, 0);
  assert.equal(f.listLines, 3);
  assert.equal(f.boldSegments, 1);
  assert.equal(f.endsWithQuestion, true);
  assert.equal(f.titleEmoji, true);
  assert.ok(!JSON.stringify(f).includes('숨김') && !JSON.stringify(f).includes('댓글러'));
  assert.equal(postKind(post.title, f), 'info');
  assert.equal(postKind('이런 알바생 어떻게 대처하시나요', null), 'talk');
  assert.throws(() => parsePost(page('{"nothing":1}')), /DAANGN_POST_SCHEMA/);
});

test('a long comment arrives as a text row and is resolved in the post', () => {
  const long = '📚 정보 안내 $2 입력 $10 출력\n' + '가격 확인 '.repeat(200);
  const bytes = Buffer.byteLength(long, 'utf8').toString(16);
  const json = JSON.stringify({ cafeSlug: 'c', blocks: [{ type: 'paragraph', text: 'q' }], comments: [{ content: '$1f', author: { nickname: 'a' } }, { content: '$ab' }, { content: '$$x' }] });
  const html = `<html><script>self.__next_f.push([1,${JSON.stringify(`1f:T${bytes},${long}\n0:${json}\n`)}])</script></html>`;
  const post = parsePost(html);
  assert.equal(post.comments[0].content, long);
  assert.equal(post.comments[1].content, '$ab', 'a reference without a text row stays as is');
  assert.equal(post.comments[2].content, '$$x');
});

test('style card turns top posts into rules and compares our cafe', () => {
  const f = postFeatures(parsePost(POST));
  const top = [1, 2, 3].map(i => ({ title: `글 ${i}`, views: 1000 * i, comments: i, kind: 'info', url: `u${i}`, features: f }));
  const own = [{ views: 3, features: { ...f, paragraphs: 7, linesPerParagraph: 4.7, charsPerLine: 55, urls: 3, images: 0, videos: 0 } }];
  const card = styleCard({ id: 'travel', label: '여행', daangnBoardId: 2186663 }, top, { own });
  assert.equal(card.stats.basis, 'info');
  assert.equal(card.stats.mediaFirstPct, 100);
  assert.match(card.rules.join('\n'), /한 문단에 한 줄/);
  assert.match(card.rules.join('\n'), /본문 링크는 거의 쓰지 않는다/);
  assert.equal(card.own.linesPerParagraph, 4.7);
  const md = styleCardsMarkdown([card], { generatedAt: '2026-09-25T20:00:00Z' });
  assert.match(md, /2026-09-26/);
  assert.match(md, /우리 카페 현재: 문단 7개/);
});

test('hot posts: most viewed recent posts across categories, each cafe read once', async () => {
  const seen = [];
  const fetchImpl = async url => { seen.push(url); return { status: 200, text: async () => (url.includes('/categories/') ? CATEGORY : url.includes('/posts/') ? POST : CAFE) }; };
  const r = await hotPosts({ categories: ['economy-finance', 'life-talk'], minMembers: 1000, days: 7, top: 5, excludeBoards: ['공지'], fetchImpl, delayMs: 0, now: () => new Date('2026-09-26T00:00:00Z') });
  assert.equal(r.cafesScanned, 1);
  assert.equal(seen.filter(u => u === 'https://cafe.daangn.com/x6idgz').length, 1);
  assert.deepEqual(r.top.map(p => p.postId), [1]);
  assert.ok(r.top[0].features);
});
