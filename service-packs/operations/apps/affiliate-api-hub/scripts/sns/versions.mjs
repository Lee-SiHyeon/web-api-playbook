// SNS versions of one verified Naver article (owner 2026-09-27: "한번 글쓰면 다른곳도 다 퍼지게할거야" — X, 스레드,
// 인스타그램, 틱톡, 유튜브). One source revision, one version per platform:
//   x         thread of posts, each ≤ 280 weighted characters (twitter-text: Hangul and other CJK count 2, a URL 23)
//   threads   thread of posts, each ≤ 500 code points and ≤ 5 links, the blog link in the last post
//   instagram carousel cards (2–10) + caption ≤ 2,200 characters with ≤ 5 hashtags (links in captions are not clickable);
//             points that do not fit the readable caption go to the first comment
//   shorts    one vertical-video script shared by TikTok, YouTube Shorts and Instagram Reels: 4–8 scenes, each with the
//             on-screen text and the narration read by TTS, plus title (≤ 100) / description / hashtags
// <run>/sns.json, written by the drafting agent (like daangn.json), is validated and preferred: no new numbers (every
// number must be in document.json), no affiliate links, within limits. Otherwise the article is converted: the hook
// (brief hook candidate or title), up to 5 points (summary items, else section headings with their first sentence), the
// blog link. SNS posts link only to the blog; when the article carries affiliate links the link post says so.
import { CONNECT_DISCLOSURE, documentText } from '../mirror-daangn.mjs';
import { limitsFrom, spillPosts, toneErrors, hookCheck, affiliateReplyErrors } from './writing.mjs';

// Platform limits come from the SNS writing ontology (sns-writing-ontology.v1.json, owner 2026-09-28): X 280 weighted and
// Threads 500 code points / 5 links per post are hard limits read from their web code; the Instagram hashtag cap (5) and
// the caption target (900, the rest goes to the first comment) are policy. Overlong posts spill into self-replies.
const W = limitsFrom();
export const LIMITS = { xWeighted: W.xWeighted, xPosts: W.xPosts, threadsChars: W.threadsChars, threadsLinks: W.threadsLinks, threadsPosts: W.threadsPosts,
  threadsHookChars: W.threadsHookChars, igCaption: W.igCaption, igCaptionTarget: W.igCaptionTarget, igComment: W.igComment, igCards: [2, 10],
  igHashtags: W.igHashtags, shortsScenes: [4, 8], shortsTitle: 100, sceneText: 40, narrationChars: 120, points: 5 };
const threadsLen = s => Array.from(String(s)).length;
const xFits = t => xWeight(t) <= LIMITS.xWeighted;
const threadsFits = t => threadsLen(t) <= LIMITS.threadsChars && (String(t).match(/https?:\/\//g) || []).length <= LIMITS.threadsLinks;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const plain = s => String(s ?? '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/==(.+?)==/g, '$1').replace(/\r/g, '').trim();
const AFFILIATE = /https?:\/\/(?:[\w-]+\.)*(?:naver\.me|myrealt\.rip|link\.coupang\.com|coupa\.ng|linkprice\.com|lpweb\.kr)\b/i;
const numbersIn = s => (String(s).replace(/https?:\/\/\S+/g, ' ').match(/\d[\d,.]*/g) || []).map(n => n.replace(/[,.]+$/, '').replace(/,/g, ''));

// twitter-text weighting: code points in these ranges weigh 1, everything else (Hangul, CJK, emoji) 2; URLs 23.
const LIGHT = [[0x0000, 0x10ff], [0x2000, 0x200d], [0x2010, 0x201f], [0x2032, 0x2037]];
export function xWeight(text) {
  let n = 0;
  const rest = String(text).replace(/https?:\/\/\S+/g, () => { n += 23; return ''; });
  for (const ch of rest) { const c = ch.codePointAt(0); n += LIGHT.some(([a, b]) => c >= a && c <= b) ? 1 : 2; }
  return n;
}
// Cut at a sentence (or word) boundary so the text fits `fits`, adding "…" only when something was cut.
export function fitText(text, fits) {
  const t = plain(text);
  if (fits(t)) return t;
  const sentences = t.split(/(?<=[.!?。])\s+/);
  let out = '';
  for (const s of sentences) { const next = out ? `${out} ${s}` : s; if (!fits(next)) break; out = next; }
  if (out) return out;
  const words = t.split(/\s+/);
  for (const w of words) { const next = out ? `${out} ${w}` : w; if (!fits(`${next}…`)) break; out = next; }
  return out ? `${out}…` : '';
}
const firstSentence = s => plain(s).split(/(?<=[.!?。])\s+/)[0] ?? '';
const hashtag = t => `#${String(t).replace(/[^\p{L}\p{N}_]/gu, '')}`;

// Hook, points and link from the article (and its brief, when it came from an event).
export function articleParts(document, { blogUrl, brief = null, plan = null } = {}) {
  const blocks = document.blocks || [];
  const summary = blocks.find(b => b.type === 'summary');
  let points = (summary?.items || []).map(plain).filter(Boolean);
  if (points.length < 3) {
    points = [];
    blocks.forEach((b, i) => {
      if (b.type !== 'heading') return;
      const next = blocks.slice(i + 1).find(x => x.type === 'paragraph' && x.presentation !== 'caption');
      points.push({ heading: plain(b.text).replace(/^[^\p{L}\p{N}]+/u, ''), line: next ? firstSentence(next.text) : '' });
    });
    points = points.filter(p => p.heading && !/영상 소개|마무리|정리|요약|FAQ|자주 묻는/.test(p.heading));
  } else points = points.map(p => ({ heading: p, line: '' }));
  const hook = plain(brief?.hooks?.candidates?.[0]?.title || document.title);
  const affiliate = Boolean(plan?.affiliate?.links?.length) || blocks.some(b => CONNECT_DISCLOSURE.test(String(b.text || '')));
  return { title: plain(document.title), hook, points: points.slice(0, LIMITS.points), blogUrl, affiliate, tags: [] };
}

export function convert(parts, { tags = [] } = {}) {
  const { hook, points, blogUrl, affiliate } = parts;
  const linkLine = `자세한 표와 링크는 블로그에${affiliate ? '(제휴 링크 포함 글)' : ''}`;
  const pointText = p => (p.line ? `${p.heading} — ${p.line}` : p.heading);
  const x = [fitText(`${hook} 🧵`, t => xWeight(t) <= LIMITS.xWeighted),
    ...points.slice(0, LIMITS.xPosts - 2).map((p, i) => fitText(`${i + 1}/ ${pointText(p)}`, t => xWeight(t) <= LIMITS.xWeighted)),
    `${linkLine} 👇\n${blogUrl}`].filter(Boolean);
  // Threads (platform-styles.mjs): the points post ends with a casual question — replies travel further than likes.
  // The hook post stays short (ontology policy); the points spill into as many self-replies as they need, never cut.
  const threadsBody = spillPosts([`${points.map((p, i) => `${i + 1}. ${pointText(p)}`).join('\n')}\n\n여러분은 어떤 걸 고르실 거예요? 댓글로 알려주세요`],
    threadsFits, LIMITS.threadsPosts - 2, 'SNS_THREADS_LIMIT');
  const threads = [fitText(hook, t => threadsLen(t) <= LIMITS.threadsHookChars), ...threadsBody, `${linkLine}\n${blogUrl}`].filter(Boolean);
  // A Naver title "head｜rest" becomes a short cover title and a subtitle on cards and the first scene.
  const [head, ...rest] = hook.split('｜');
  const sub = rest.join(' ').trim();
  // Instagram carousels reach more with more slides and save-worthy summaries (platform-styles.mjs): cover, points,
  // a one-slide summary, then the save/profile-link slide.
  const cards = [{ kind: 'cover', title: head.trim(), body: sub }, ...points.map((p, i) => ({ kind: 'point', index: i + 1, title: p.heading, body: p.line })),
    { kind: 'point', index: points.length + 1, title: '한 장 요약', body: points.map(p => `· ${p.heading}`).join('\n') },
    { kind: 'cta', title: '저장해두고 필요할 때 보세요', body: '전체 글은 프로필 링크에서' }].slice(0, LIMITS.igCards[1]);
  const hashtags = [...new Set(tags.map(hashtag).filter(h => h.length > 1))].slice(0, LIMITS.igHashtags);
  // The caption stays within the readable target; when the numbered points do not fit, they go to the first comment.
  const fullCaption = [hook, '', ...points.map((p, i) => `${i + 1}. ${pointText(p)}`), '', `${linkLine}: 프로필 링크`, hashtags.join(' ')].join('\n');
  const captionFits = fullCaption.length <= LIMITS.igCaptionTarget;
  const caption = captionFits ? fullCaption
    : [hook, '', points.map(p => p.heading).join(' · '), '', '자세한 목록은 첫 댓글에 👇', `${linkLine}: 프로필 링크`, hashtags.join(' ')].join('\n');
  const firstComment = captionFits ? null : fitText(points.map((p, i) => `${i + 1}. ${pointText(p)}`).join('\n'), t => t.length <= LIMITS.igComment);
  const scenes = [{ text: fitText(head.trim(), t => t.length <= LIMITS.sceneText), sub: sub || null, narration: fitText(hook.replace('｜', '. '), t => t.length <= LIMITS.narrationChars) },
    ...points.slice(0, LIMITS.shortsScenes[1] - 2).map(p => ({ text: fitText(p.heading, t => t.length <= LIMITS.sceneText),
      narration: fitText(p.line ? `${p.heading}. ${p.line}` : p.heading, t => t.length <= LIMITS.narrationChars) })),
    { text: '자세한 건 블로그에서', narration: '자세한 표와 링크는 프로필의 블로그 링크에서 확인하세요.' }];
  // One video, different wrappers: TikTok wants the keyword in the caption's first sentence and 3–5 hashtags; YouTube
  // the keyword in title and first description line with the blog link; 네이버 클립 a search-style title and info tags.
  const keyword = head.trim().split(/\s+/)[0];
  const few = hashtags.slice(0, 5);
  const platforms = {
    tiktok: { caption: fitText(`${keyword} ${points[0]?.heading ?? ''}. ${linkLine}: 프로필 링크 ${few.join(' ')}`.replace(/\s+/g, ' ').trim(), t => t.length <= 2200) },
    youtube: { title: fitText(hook, t => t.length <= LIMITS.shortsTitle), description: `${keyword} ${points[0]?.heading ?? ''}\n\n${linkLine}: ${blogUrl}\n${few.join(' ')}` },
    naverClip: { title: fitText(head.trim(), t => t.length <= 40), description: `${points.map(p => p.heading).join(' · ')}\n${linkLine}: ${blogUrl}`, hashtags: few },
  };
  return { x: { posts: x }, threads: { posts: threads }, instagram: { cards, caption, hashtags, firstComment }, platforms,
    shorts: { title: fitText(hook, t => t.length <= LIMITS.shortsTitle), scenes, description: `${hook}\n\n${linkLine}: ${blogUrl}\n${hashtags.join(' ')}`, hashtags } };
}

// Checks shared by converted and agent-written versions.
export function validateVersions(v, document) {
  const errors = [];
  const all = [...v.x.posts, ...v.threads.posts, v.instagram.caption, v.instagram.firstComment ?? '', ...v.instagram.cards.flatMap(c => [c.title, c.body]),
    v.shorts.title, v.shorts.description, ...v.shorts.scenes.flatMap(s => [s.text, s.narration])].join('\n');
  if (AFFILIATE.test(all)) errors.push('SNS_AFFILIATE_LINK');
  if (CONNECT_DISCLOSURE.test(all)) errors.push('SNS_AFFILIATE_TEXT');
  const known = new Set(numbersIn(documentText(document)));
  const unknown = [...new Set(numbersIn(all))].filter(n => !known.has(n) && !/^\d$/.test(n));
  if (unknown.length) errors.push(`SNS_NUMBER_NOT_IN_DOCUMENT:${unknown.slice(0, 5).join(',')}`);
  // The blog link post appended to a full drafted chain is allowed on top of the limit, as feedOrder allows it (+1).
  const tooLong = (posts, max) => posts.filter(p => !/https?:\/\//.test(p)).length > max || posts.length > max + 1;
  if (!v.x.posts.length || tooLong(v.x.posts, LIMITS.xPosts) || v.x.posts.some(p => !p || xWeight(p) > LIMITS.xWeighted)) errors.push('SNS_X_LIMIT');
  // X cuts the reach of posts with outside links: never in post 1 (the body); links go in the first reply (feed order)
  // or, before ordering, the closing post (platform-styles.mjs).
  const linkOutOfPlace = posts => /https?:\/\//.test(posts[0] ?? '') || posts.some((p, i) => /https?:\/\//.test(p) && i !== 1 && i !== posts.length - 1);
  if (linkOutOfPlace(v.x.posts)) errors.push('SNS_X_LINK_BEFORE_LAST');
  if (!v.threads.posts.length || tooLong(v.threads.posts, LIMITS.threadsPosts) ||v.threads.posts.some(p => !p || !threadsFits(p))) errors.push('SNS_THREADS_LIMIT');
  if (linkOutOfPlace(v.threads.posts)) errors.push('SNS_THREADS_LINK_BEFORE_LAST');
  if ((v.instagram.firstComment ?? '').length > LIMITS.igComment) errors.push('SNS_INSTAGRAM_COMMENT_LIMIT');
  errors.push(...toneErrors([...v.x.posts, ...v.threads.posts, v.x.affiliateReply, v.threads.affiliateReply, v.instagram.caption, v.instagram.firstComment]));
  const replyNumbers = [v.x.affiliateReply, v.threads.affiliateReply].filter(Boolean).join('\n');
  const unknownReply = [...new Set(numbersIn(replyNumbers))].filter(n => !known.has(n) && !/^\d$/.test(n));
  if (unknownReply.length) errors.push(`SNS_NUMBER_NOT_IN_DOCUMENT:${unknownReply.slice(0, 5).join(',')}`);
  const [minC, maxC] = LIMITS.igCards;
  if (v.instagram.cards.length < minC || v.instagram.cards.length > maxC || v.instagram.caption.length > LIMITS.igCaption || v.instagram.hashtags.length > LIMITS.igHashtags) errors.push('SNS_INSTAGRAM_LIMIT');
  const [minS, maxS] = LIMITS.shortsScenes;
  if (v.shorts.scenes.length < minS || v.shorts.scenes.length > maxS || [...v.shorts.title].length > LIMITS.shortsTitle
    || v.shorts.scenes.some(s => !s.text || !s.narration || s.text.length > LIMITS.sceneText || s.narration.length > LIMITS.narrationChars)) errors.push('SNS_SHORTS_LIMIT');
  return errors;
}

// <run>/sns.json from the drafting agent, filled with the defaults it may leave out (blog link, hashtags).
export function fromSnsVersion(version, parts, { tags = [] } = {}) {
  const base = convert(parts, { tags });
  const v = {
    // An overlong post spills into the next self-reply instead of failing (ontology replyPolicy.atPublish.overflow).
    x: { posts: spillPosts((version.x?.posts ?? base.x.posts).map(plain), xFits, LIMITS.xPosts, 'SNS_X_LIMIT') },
    threads: { posts: spillPosts((version.threads?.posts ?? base.threads.posts).map(plain), threadsFits, LIMITS.threadsPosts, 'SNS_THREADS_LIMIT') },
    instagram: { cards: version.instagram?.cards ?? base.instagram.cards, caption: plain(version.instagram?.caption ?? base.instagram.caption),
      hashtags: (version.instagram?.hashtags ?? base.instagram.hashtags).slice(0, LIMITS.igHashtags),
      firstComment: version.instagram?.firstComment != null ? plain(version.instagram.firstComment) : version.instagram?.caption ? null : base.instagram.firstComment },
    shorts: { ...base.shorts, ...(version.shorts || {}), scenes: version.shorts?.scenes ?? base.shorts.scenes },
    platforms: { ...base.platforms, ...(version.platforms || {}) },
  };
  // The blog link is always the last X/Threads post, so an agent version cannot drop or change it.
  // A drafted version is written before the URL exists, so its last post is often a link teaser ("블로그에 정리했어요 👇",
  // 2026-10-04): the URL joins that post when it fits instead of adding a post past the chain limit.
  for (const k of ['x', 'threads']) {
    if (v[k].posts.at(-1)?.includes(parts.blogUrl)) continue;
    const fits = k === 'x' ? xFits : threadsFits;
    const posts = v[k].posts.filter(p => !/https?:\/\//.test(p));
    const teaser = posts.at(-1), joined = `${teaser}\n${parts.blogUrl}`;
    v[k].posts = teaser && /👇|블로그/.test(teaser) && fits(joined) ? [...posts.slice(0, -1), joined] : [...posts, base[k].posts.at(-1)];
  }
  // Optional affiliate reply after the chain (registered networks only; checked in buildVersions).
  for (const k of ['x', 'threads']) if (version[k]?.affiliateReply != null) v[k].affiliateReply = String(version[k].affiliateReply).replace(/\r/g, '').trim();
  return v;
}

// Feed order (owner 2026-09-28: "본문이 제일 많은 조회수를 얻어. 본문다음 바로 첫번째 댓글에 수익고지및 링크부터 넣고 이후
// 글 써내려가는식으로 해"): post 1 is the body (the hook merged with the next post when both fit), post 2 — the first reply
// under it — carries the disclosure and links (the registered-network affiliate reply, with the blog link when it fits),
// and the rest of the chain follows. The separate affiliate reply after the chain is folded into post 2.
export function feedOrder(posts, { blogUrl, affiliateReply = null, fits }) {
  const isLink = p => String(p).includes(blogUrl);
  const linkPost = posts.find(isLink) ?? null;
  let body = posts.filter(p => !isLink(p));
  if (body.length > 1 && fits(`${body[0]}\n\n${body[1]}`)) body = [`${body[0]}\n\n${body[1]}`, ...body.slice(2)];
  let first = linkPost, tail = [];
  if (affiliateReply) {
    const merged = linkPost ? `${affiliateReply}\n\n${linkPost}` : affiliateReply;
    if (fits(merged)) first = merged; else { first = affiliateReply; if (linkPost) tail = [linkPost]; }
  }
  return [body[0], ...(first ? [first] : []), ...body.slice(1), ...tail].filter(Boolean);
}

export function buildVersions({ document, blogUrl, brief = null, plan = null, tags = [], snsVersion = null }) {
  if (!/^https:\/\/blog\.naver\.com\/[\w-]+\/\d+$/.test(String(blogUrl))) fail('SNS_BLOG_URL_INVALID');
  const parts = articleParts(document, { blogUrl, brief, plan });
  if (parts.points.length < 2) fail('SNS_TOO_FEW_POINTS');
  // An agent version is checked as written, before the link post is normalized: an affiliate or outside link is an
  // error to report, not something to drop silently.
  if (snsVersion) {
    // The affiliate replies are checked on their own below; everything else may link only to the blog.
    const rest = { ...snsVersion, x: { ...snsVersion.x, affiliateReply: undefined }, threads: { ...snsVersion.threads, affiliateReply: undefined } };
    const raw = JSON.stringify(rest);
    if (AFFILIATE.test(raw)) fail('SNS_AFFILIATE_LINK');
    if ((raw.match(/https?:\/\/[^\s"\\]+/g) || []).some(u => u !== blogUrl)) fail('SNS_LINK_NOT_BLOG');
  }
  const versions = snsVersion ? fromSnsVersion(snsVersion, parts, { tags }) : convert(parts, { tags });
  const errors = validateVersions(versions, document);
  const articleLinks = (plan?.affiliate?.links || []).map(a => a.url);
  errors.push(...affiliateReplyErrors('x', versions.x.affiliateReply, { firstPost: versions.x.posts[0], articleLinks, fits: xFits }),
    ...affiliateReplyErrors('threads', versions.threads.affiliateReply, { firstPost: versions.threads.posts[0], articleLinks, fits: threadsFits }));
  if (errors.length) fail(errors[0]);
  for (const [k, fits] of [['x', xFits], ['threads', threadsFits]]) {
    versions[k].posts = feedOrder(versions[k].posts, { blogUrl, affiliateReply: versions[k].affiliateReply ?? null, fits });
    if (versions[k].posts.length > (k === 'x' ? LIMITS.xPosts : LIMITS.threadsPosts) + 1) fail(k === 'x' ? 'SNS_X_LIMIT' : 'SNS_THREADS_LIMIT');
    versions[k].firstComment = versions[k].posts[1] ?? null;
    versions[k].affiliateReply = null;
  }
  // Hook check: an X/Threads opener should use a feed-preferred hook pattern and no avoided one. It no longer stops the
  // post (owner 2026-10-06 "훅때문에 왜멈춤..? 게이트를 수정해야할거아냐"): when one channel's drafted opener misses and the
  // other's passes, the passing first line replaces the missing one if the post still fits; otherwise the post goes out
  // as drafted and the miss is reported in versions.hooks (warning) for the sns-performance loop.
  versions.hooks = { x: hookCheck(versions.x.posts[0]), threads: hookCheck(versions.threads.posts[0]) };
  for (const [k, other, fits] of [['x', 'threads', xFits], ['threads', 'x', threadsFits]]) {
    if (!snsVersion?.[k]?.posts || versions.hooks[k].ok) continue;
    const miss = versions.hooks[k].patterns.join('+') || 'none';
    const donor = versions.hooks[other].ok ? String(versions[other].posts[0]).split('\n')[0] : null;
    const [, ...rest] = String(versions[k].posts[0]).split('\n');
    const repaired = donor ? [donor, ...rest].join('\n') : null;
    if (repaired && fits(repaired) && hookCheck(repaired).ok) {
      versions[k].posts[0] = repaired;
      versions.hooks[k] = { ...hookCheck(repaired), repairedFrom: other, replacedPatterns: miss };
    } else versions.hooks[k] = { ...versions.hooks[k], warning: `SNS_HOOK_NOT_FEED_PREFERRED:${k}:${miss}` };
  }
  return { source: snsVersion ? 'sns.json' : 'converted', parts, versions };
}
