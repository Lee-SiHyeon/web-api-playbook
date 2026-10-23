// 당근 동네 커뮤니티(맛집 주제) 글·댓글 수집: 어떤 가게가 동네에서 실제로 언급되는지 센다.
// 관측 계약(2026-09-29, Codex daangn-xhr 리포트 + 직접 재현), 쿠키 없이 GET만:
//   GET /kr/search/community/?in={동}-{지역ID}&q=맛집&_data=routes/kr.search.community._index
//        → communityArticles(제목·본문·subject·댓글수·작성자), nearbyRegions(같은 구의 동 목록). 한 번에 전부, 페이징 없음.
//   GET {article.id}?_data=routes/kr.community.$community_agora_id
//        → communityArticle.comments.createdSortedComments/recentSortedComments: 글당 웹에는 최대 4건만 보인다.
// 글은 이용자 게시물이라 가게 후기 레코드가 아니다. 댓글이 실제 추천 가게 이름이 나오는 곳이다.

const BASE = 'https://www.daangn.com';
const COMMUNITY_ROUTE = 'routes/kr.search.community._index';
const ARTICLE_ROUTE = 'routes/kr.community.$community_agora_id';
const NEGATIVE = /별로|실망|비추|최악|불친절|위생|맛없|다신|후회|아쉬|기대\s*(?:이하|보단)|웨이팅.{0,4}(?:길|심)|짜다|비싸/;

export const normName = s => String(s ?? '').replace(/\s|[()·&\-_,.]/g, '').replace(/(본점|직영점|[가-힣]{1,4}점)$/u, '').toLowerCase();

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function nameRegex(name) {
  // 띄어 쓴 마지막 지점 토큰(‘마곡본점’, ‘마곡나루점’)만 떼고, 붙여 쓴 이름은 normName 규칙을 쓴다.
  const core = normName(/\s/.test(String(name).trim()) ? String(name).trim().replace(/\s+\S*점$/, '') : name);
  if (core.length < 3) return null;
  return new RegExp([...core].map(escapeRe).join('[\\s·.\\-_]*'), 'i');
}

export function flattenComments(article) {
  const seen = new Map();
  const walk = c => {
    if (!c || (c.status && c.status !== 'NORMAL')) return;
    const text = String(c.content ?? '').trim();
    if (text && !seen.has(String(c.id))) seen.set(String(c.id), { id: String(c.id), text, author: c.writer?.nickName ?? null, createdAt: c.createdAt ?? null });
    const subs = Array.isArray(c.subComments) ? c.subComments : (c.subComments?.comments ?? []);
    subs.forEach(walk);
  };
  const cm = article?.comments ?? {};
  [...(cm.createdSortedComments ?? []), ...(cm.recentSortedComments ?? [])].forEach(walk);
  return [...seen.values()];
}

const articleUrl = id => new URL(id, BASE).toString();

export async function collectCommunity({ area, seed, getJson, keyword = '맛집', posts = 60, maxDongs = 40, pauseMs = 250, regionFilter }) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const regionsLog = [];
  const articles = new Map();
  const listUrl = region => {
    const u = new URL('/kr/search/community/', BASE);
    u.searchParams.set('in', `${region.name}-${region.id}`); u.searchParams.set('q', keyword); u.searchParams.set('_data', COMMUNITY_ROUTE);
    return u.toString();
  };
  const addFrom = (res, region) => {
    const list = Array.isArray(res.body?.communityArticles) ? res.body.communityArticles : [];
    let added = 0;
    for (const a of list) if (a?.id && a.status === 'NORMAL' && a.subject === keyword && !articles.has(a.id)) { articles.set(a.id, a); added++; }
    regionsLog.push({ region: region.name, id: String(region.id), status: res.status, articles: list.length, newArticles: added });
  };
  const first = await getJson(listUrl(seed), `community:${seed.name}`);
  addFrom(first, seed);
  const nearby = (first.body?.nearbyRegions ?? []).filter(r => (regionFilter ? regionFilter(r) : r?.name2 === area) && String(r.id) !== String(seed.id))
    .map(r => ({ id: r.id, name: r.name })).slice(0, Math.max(0, maxDongs - 1));
  for (const region of nearby) {
    await sleep(pauseMs);
    addFrom(await getJson(listUrl(region), `community:${region.name}`), region);
  }
  const targets = [...articles.values()].filter(a => Number(a.commentsCount) > 0)
    .sort((a, b) => Number(b.commentsCount) - Number(a.commentsCount) || Number(b.emotionCount) - Number(a.emotionCount)).slice(0, posts);
  const detail = new Map();
  for (const a of targets) {
    await sleep(pauseMs);
    const u = new URL(a.id, BASE); u.searchParams.set('_data', ARTICLE_ROUTE);
    const res = await getJson(u.toString(), `post:${a.id.split('/').filter(Boolean).pop()}`);
    const ca = res.body?.data?.communityArticle;
    if (res.status === 200 && ca) detail.set(a.id, ca);
  }
  const threads = [...articles.values()].map(a => {
    const ca = detail.get(a.id);
    const comments = ca ? flattenComments(ca) : [];
    return { id: a.id, url: articleUrl(a.id), title: String(ca?.title ?? a.title ?? ''), content: String(ca?.content ?? a.content ?? ''),
      createdAt: a.createdAt ?? null, author: a.authorName ?? ca?.writer?.nickName ?? null, regionName: a.regionName ?? null,
      commentsCount: Number(a.commentsCount) || 0, emotionCount: Number(a.emotionCount) || 0, comments, commentsFetched: Boolean(ca) };
  });
  return { threads, stats: { seed, regions: regionsLog, articles: threads.length, postsFetched: detail.size,
    commentsSeen: threads.reduce((n, t) => n + t.comments.length, 0), commentsTotal: threads.reduce((n, t) => n + t.commentsCount, 0) } };
}

const snippet = (text, m) => text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 60).replace(/\s+/g, ' ').trim();

// voices = 서로 다른 작성자 수(같은 사람이 글과 댓글로 두 번 언급해도 1). 글 한 건이 아니라 여러 사람의 언급이어야 신호로 본다.
const PLACE_LIKE = /^[가-힣]{1,5}(?:동|역|구|로|길|시장|거리)$/u;

export function extractMentions(threads, shops, { skipNames = [] } = {}) {
  const out = new Map();
  const skip = new Set(skipNames.map(normName));
  for (const shop of shops) {
    const core = normName(shop.name);
    // 지역명 상호(예: ‘공항동’)는 글 본문의 지역 언급과 구분되지 않아 뺀다.
    if (skip.has(core) || PLACE_LIKE.test(core)) continue;
    const re = nameRegex(shop.name);
    if (!re) continue;
    const threadIds = new Set(); const voices = new Set(); const snippets = [];
    let postMentions = 0, commentMentions = 0, latest = null;
    const note = (kind, text, author, date, thread) => {
      const m = re.exec(text);
      if (!m) return;
      threadIds.add(thread.id); voices.add(author ?? `anon:${thread.id}:${kind}`);
      if (kind === 'post') postMentions++; else commentMentions++;
      if (date && (!latest || date > latest)) latest = date;
      snippets.push({ kind, date: date ? String(date).slice(0, 10) : null, url: thread.url, text: snippet(text, m), negativeCue: NEGATIVE.test(text) });
    };
    for (const t of threads) {
      note('post', `${t.title}\n${t.content}`, t.author, t.createdAt, t);
      for (const c of t.comments) note('comment', c.text, c.author, c.createdAt, t);
    }
    if (!threadIds.size) continue;
    snippets.sort((a, b) => Number(b.negativeCue) - Number(a.negativeCue) || String(b.date).localeCompare(String(a.date)));
    out.set(String(shop.id), { threads: threadIds.size, voices: voices.size, posts: postMentions, comments: commentMentions,
      latest: latest ? String(latest).slice(0, 10) : null, negativeMentions: snippets.filter(s => s.negativeCue).length, snippets: snippets.slice(0, 4) });
  }
  return out;
}

export const buzzBonus = community => Math.min(0.15, 0.05 * (community?.voices ?? 0));
