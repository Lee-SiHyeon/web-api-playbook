import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOntology, validateOntology, limitsFrom, spillPosts, toneErrors, followUpText } from '../scripts/sns/writing.mjs';
import { buildVersions, LIMITS, xWeight } from '../scripts/sns/versions.mjs';

const BLOG = 'https://blog.naver.com/aicandoanything/224000000002';

test('the SNS writing ontology is well formed and its hard limits match the platforms\' web code', () => {
  const o = loadOntology();
  assert.deepEqual(validateOntology(o), []);
  const l = limitsFrom(o);
  assert.equal(l.xWeighted, 280);
  assert.equal(l.threadsChars, 500);
  assert.equal(l.threadsLinks, 5);
  assert.equal(l.igCaption, 2200);
  assert.equal(l.igHashtags, 5);
  assert.equal(LIMITS.threadsChars, 500);
});

test('the ontology check catches an unverified limit, an unknown role and a link that is not last', () => {
  const o = loadOntology();
  o.platforms.threads.surfaces.post.limits.chars.verification = 'made_up';
  o.structures.price_compare.x = ['hook', 'link', 'teaser'];
  const errors = validateOntology(o);
  assert.ok(errors.includes('LIMIT_EVIDENCE_UNKNOWN:threads.post.chars'));
  assert.ok(errors.includes('ROLE_UNKNOWN:price_compare.x.teaser'));
  assert.ok(errors.includes('STRUCTURE_LINK_LAST:price_compare.x'));
});

test('an overlong post spills into the next self-reply at sentence or line boundaries instead of being cut', () => {
  const fits = t => [...t].length <= 20;
  assert.deepEqual(spillPosts(['짧은 글'], fits, 3), ['짧은 글']);
  const out = spillPosts(['첫째 줄은 열두 글자예요\n둘째 줄도 열두 글자예요\n셋째 줄'], fits, 4);
  assert.ok(out.length >= 2 && out.every(fits));
  assert.equal(out.join('\n').replace(/\s+/g, ''), '첫째줄은열두글자예요둘째줄도열두글자예요셋째줄');
  assert.throws(() => spillPosts(['가'.repeat(100)], fits, 2), /SNS_CHAIN_TOO_LONG/);
});

test('tone rules reject excuses, hedging, hype and affiliate wording but allow the blog link notice', () => {
  assert.deepEqual(toneErrors(['확인하지 못했어요']), ['SNS_TONE_EXCUSE']);
  assert.deepEqual(toneErrors(['이게 제일 싼 것 같아요']), ['SNS_TONE_HEDGE']);
  assert.deepEqual(toneErrors(['역대급 가격']), ['SNS_TONE_HYPE']);
  assert.deepEqual(toneErrors(['쿠팡 파트너스 활동']), ['SNS_TONE_AFFILIATE_TEXT']);
  assert.deepEqual(toneErrors(['자세한 표와 링크는 블로그에(제휴 링크 포함 글)']), []);
});

test('follow-up replies come from the ontology templates and respect the per-post caps', () => {
  assert.equal(followUpText('price_change', { date: '9월 29일', item: '호박고구마 10kg', old: '19,900원', new: '18,900원' }), '📌 9월 29일 다시 보니 호박고구마 10kg 19,900원 → 18,900원');
  assert.throws(() => followUpText('sold_out', { item: '홍로' }), /SNS_FOLLOWUP_VAR_MISSING:alternative/);
  assert.throws(() => followUpText('deadline', { item: '레고' }, { sent: ['deadline'] }), /SNS_FOLLOWUP_LIMIT/);
  assert.throws(() => followUpText('price_change', { date: 'a', item: 'b', old: 'c', new: 'd' }, { sent: ['price_change', 'sold_out', 'deadline'] }), /SNS_FOLLOWUP_LIMIT/);
});

// A long price-compare article: five points with long lines, like the 제철 과일 post whose Threads version failed.
const long = '가'.repeat(80);
const document = {
  title: '제철 고구마·사과 박스 최저가｜100g당 198원부터',
  blocks: [
    { type: 'notice', text: '2026년 9월 28일 새벽 기준입니다.' },
    ...[1, 2, 3, 4, 5].flatMap(i => [{ type: 'heading', text: `${i}번 상품 비교 ${long}` }, { type: 'paragraph', text: `${i}번은 100g당 198원이고 ${long}입니다.` }]),
  ],
};

test('a long article keeps every point on Threads by spilling into self-replies, and Instagram moves the list to the first comment', () => {
  const { versions: v } = buildVersions({ document, blogUrl: BLOG, tags: ['고구마', '사과', '제철과일', '최저가', '박스', '감귤'] });
  assert.ok(v.threads.posts.length >= 4 && v.threads.posts.length <= LIMITS.threadsPosts);
  assert.ok(v.threads.posts.every(p => [...p].length <= 500));
  // Feed order: the body (hook + first points when they fit) is post 1, the blog link is the first reply.
  assert.ok(v.threads.posts[1].endsWith(BLOG) && v.threads.posts.filter((_, i) => i !== 1).every(p => !p.includes('http')));
  for (const i of [1, 2, 3, 4, 5]) assert.ok(v.threads.posts.join('\n').includes(`${i}번 상품 비교`));
  assert.ok(v.instagram.caption.length <= LIMITS.igCaptionTarget);
  assert.match(v.instagram.caption, /첫 댓글/);
  assert.match(v.instagram.firstComment, /^1\. 1번 상품 비교/);
  assert.equal(v.instagram.hashtags.length, 5);
  assert.ok(v.x.posts.every(p => xWeight(p) <= 280));
});

test('an agent-written Threads post over 500 characters spills into the next reply instead of failing', () => {
  const sns = { threads: { posts: ['고구마 박스, 가격표만 보고 고르면 안 되는 이유', `${'고구마는 100g당 198원이야. '.repeat(30)}`.trim()] } };
  const { versions: v } = buildVersions({ document, blogUrl: BLOG, snsVersion: sns });
  assert.ok(v.threads.posts.length >= 4);
  assert.ok(v.threads.posts.every(p => [...p].length <= 500));
  assert.equal(v.threads.posts[0], '고구마 박스, 가격표만 보고 고르면 안 되는 이유');
  assert.throws(() => buildVersions({ document, blogUrl: BLOG, snsVersion: { threads: { posts: ['이게 제일 싼 것 같아요'] } } }), /SNS_TONE_HEDGE/);
});

test('hook gate: a drafted opener must use a feed-preferred hook pattern from the hook ontology (owner 2026-09-28)', async () => {
  const { hookCheck } = await import('../scripts/sns/writing.mjs');
  assert.deepEqual(hookCheck('고구마·사과 박스로 살 때 박스 가격만 보면 헷갈려요').patterns, ['timing_insight']);
  assert.equal(hookCheck('고구마·사과 박스로 살 때 박스 가격만 보면 헷갈려요').ok, false);
  assert.equal(hookCheck('고구마 박스, 가격표만 보고 고르면 안 되는 이유 🧵').ok, true);
  // Owner 2026-10-06 "훅때문에 왜멈춤": a missed hook no longer stops the post. The passing channel's first line is used
  // when it fits; otherwise the miss is a warning.
  const repaired = buildVersions({ document, blogUrl: BLOG, snsVersion: {
    x: { posts: ['고구마 박스 살 때 보는 법'] }, threads: { posts: ['고구마 박스, 가격표만 보고 고르면 안 되는 이유'] } } }).versions;
  assert.equal(repaired.hooks.x.repairedFrom, 'threads');
  assert.equal(repaired.hooks.x.ok, true);
  assert.match(repaired.x.posts[0], /^고구마 박스, 가격표만 보고 고르면 안 되는 이유/);
  const warned = buildVersions({ document, blogUrl: BLOG, snsVersion: {
    x: { posts: ['고구마 박스 살 때 보는 법'] }, threads: { posts: ['고구마 박스 살 때 보는 법'] } } }).versions;
  assert.match(warned.hooks.x.warning, /SNS_HOOK_NOT_FEED_PREFERRED:x:timing_insight/);
  assert.equal(warned.x.posts[0].split('\n')[0], '고구마 박스 살 때 보는 법', 'posted as drafted');
  const { versions: v } = buildVersions({ document, blogUrl: BLOG });
  assert.ok('ok' in v.hooks.x && 'ok' in v.hooks.threads, 'converted versions report the hook check');
});

test('affiliate reply: registered network only, disclosure first, marker on the first post, links from the article (owner 2026-09-28)', () => {
  const TOSS = 'https://toss.shopping/_m/zDJ2I2cb';
  const plan = { affiliate: { links: [{ url: TOSS, network: 'toss_sharelink' }] } };
  const disclosure = '이 글은 토스쇼핑 쉐어링크 활동의 일환으로, 링크를 통한 구매가 발생하면 일정 수수료를 지급받습니다.';
  const first = '고구마 박스, 가격표만 보고 고르면 안 되는 이유 (제휴 링크 포함)';
  const ok = { threads: { posts: [first], affiliateReply: `토스쇼핑에서 바로 보기 👇\n${disclosure}\n1번 100g당 198원\n${TOSS}` } };
  const { versions: v } = buildVersions({ document, blogUrl: BLOG, plan, snsVersion: ok });
  // Feed order (owner 2026-09-28): the disclosure and links are the first reply under the body, with the blog link.
  assert.equal(v.threads.affiliateReply, null);
  assert.match(v.threads.posts[1], /^토스쇼핑에서 바로 보기 👇\n이 글은 토스쇼핑 쉐어링크/);
  assert.ok(v.threads.posts[1].includes(TOSS) && v.threads.posts[1].includes(BLOG));
  assert.ok(!v.threads.posts[0].includes('toss.shopping'), 'the body post carries no link');
  const bad = (reply, firstPost = first, p = plan) => () => buildVersions({ document, blogUrl: BLOG, plan: p, snsVersion: { threads: { posts: [firstPost], affiliateReply: reply } } });
  assert.throws(bad(`${disclosure}\n${TOSS}`, '고구마 박스, 가격표만 보고 고르면 안 되는 이유'), /SNS_AFFILIATE_MARKER_MISSING/);
  assert.throws(bad(`토스 👇\n1번 100g당 198원\n${TOSS}\n${disclosure}`), /SNS_AFFILIATE_DISCLOSURE_NOT_FIRST/);
  assert.throws(bad(`${disclosure}\n${TOSS}`, first, { affiliate: { links: [] } }), /SNS_AFFILIATE_LINK_NOT_IN_ARTICLE/);
  assert.throws(bad(`${disclosure}\nhttps://naver.me/abc`), /SNS_AFFILIATE_NETWORK_NOT_REGISTERED:threads/);
  assert.throws(bad(`${disclosure}\n1번 100g당 99원\n${TOSS}`), /SNS_NUMBER_NOT_IN_DOCUMENT:99/);
  // A partner link anywhere else in the version is still refused.
  assert.throws(() => buildVersions({ document, blogUrl: BLOG, plan, snsVersion: { threads: { posts: [first, TOSS] } } }), /SNS_LINK_NOT_BLOG/);
});

test('sns-publish sends the affiliate reply under the last post of the chain', async () => {
  const { runSnsPublish } = await import('../scripts/sns-publish.mjs');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sns-aff-'));
  fs.mkdirSync(path.join(dir, 'sns'));
  const cover = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(cover, 0);
  cover.writeUInt32BE(1080, 16);
  cover.writeUInt32BE(1350, 20);
  fs.writeFileSync(path.join(dir, 'sns', 'instagram-01.png'), cover);
  fs.writeFileSync(path.join(dir, 'final-verification.json'), JSON.stringify({ status: 'published_verified' }));
  fs.writeFileSync(path.join(dir, 'sns', 'sns-manifest.json'), JSON.stringify({ outputs: {} }));
  fs.writeFileSync(path.join(dir, 'sns', 'versions.json'), JSON.stringify({ threads: { posts: ['a', 'b'], affiliateReply: 'r' }, x: { posts: ['a', 'b'], affiliateReply: 'r' } }));
  const calls = [];
  const writers = {
    publishChain: async (posts, o) => { calls.push(['threads', posts, o.replyId ?? null]); return { ids: posts.map((_, i) => `t${calls.length}${i}`) }; },
    publishThread: async (posts, o) => { calls.push(['x', posts, o.replyToId ?? null]); return { ids: posts.map((_, i) => `x${calls.length}${i}`) }; },
  };
  await runSnsPublish({ runDir: dir, channel: 'threads', approvalId: 'test', writers, journalDir: dir });
  await runSnsPublish({ runDir: dir, channel: 'x', approvalId: 'test', writers, journalDir: dir });
  assert.deepEqual(calls, [['threads', ['a', 'b'], null], ['threads', ['r'], 't11'], ['x', ['a', 'b'], null], ['x', ['r'], 'x31']]);
  fs.rmSync(dir, { recursive: true, force: true });
});
