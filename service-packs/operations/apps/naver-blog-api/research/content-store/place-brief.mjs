// 지역 맛집 브리프: 당근 웹의 익명 GET(가게 검색 API + 가게 상세 JSON-LD)로 후보를 모아 메뉴·상황별로 묶는다.
// 관측 계약(2026-09-29, Codex daangn-xhr 리포트 + 직접 재현):
//   GET /kr/search/local-profile/?q=…&_data=routes/kr.search.local-profile  → searchRegion, regionBounds
//   GET /kr/api/v1/local-profiles/search?…region_id&bounds&search=…         → 최대 20곳(페이징 없음)
//   GET /kr/local-profile/{slug}-{id}/ (SSR HTML)                          → LocalBusiness JSON-LD(영업시간·전화·후기)
// 쿠키·세션 없음, GET만. 후기 수·별점은 이용자 자기신고이며 사장님이 후기 이벤트를 걸기도 해서 표시한다.
//
//   node place-brief.mjs collect <구이름> [--queries="마곡나루역 맛집,화곡역 맛집"] [--official=path.json]
//                        [--detail=12] [--min-reviews=15] [--no-community] [--seed=마곡동-6052] [--posts=60] [--write]
// 커뮤니티 언급(당근 동네생활 맛집 글·댓글)은 place-community.mjs가 수집하며, 실패해도 가게 랭킹은 그대로 나온다.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normName, collectCommunity, extractMentions, buzzBonus } from './place-community.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNS = path.resolve(HERE, '..', '..', 'workflow-runs');
const BASE = 'https://www.daangn.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const kstDate = (t = Date.now()) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);

const MENU_RULES = [
  ['cafe', '카페', /카페|커피|디저트|아이스크림|와플|찻집/],
  ['bakery', '베이커리', /베이커리|빵|제과|도넛|케이크/],
  ['grill', '고깃집', /돼지고기|소고기|양고기|갈비|삼겹|곱창|막창|양꼬치|오리|바비큐|구이|정육|고기/],
  ['chinese', '중식', /중식|중국|마라|짬뽕|짜장|딤섬|훠궈/],
  ['japanese', '일식', /초밥|스시|라멘|우동|일식|돈까스|돈카츠|회|오마카세|소바|덮밥전문|이자카야/],
  ['western', '양식', /양식|스테이크|파스타|이탈리|피자|햄버거|패스트푸드|브런치|샌드위치/],
  ['snack', '분식', /분식|떡볶이|김밥|토스트|튀김|순대/],
  ['bar', '술집', /술집|주점|포차|호프|이자카야|와인|맥주|막걸리|바$/],
  ['korean', '한식', /한식|국밥|해장국|백반|냉면|국수|칼국수|족발|보쌈|쌈밥|찌개|탕|전골|아구|해물|생선|죽|삼계|닭갈비|찜|국/],
];
const SITUATION_RULES = [
  ['with_children', '아이와 함께', /아이(?!스)|아기|키즈|어린이|유아/],
  ['date', '데이트', /데이트|분위기|커플|기념일/],
  ['solo', '혼밥', /혼밥|혼자|1인\s*(?:석|메뉴|식사)/],
  ['family', '가족모임', /가족|부모님|상견례|돌잔치|모임/],
  ['company', '회식', /회식|단체|룸|워크샵/],
  ['value', '가성비', /가성비|저렴|착한\s*가격|가격\s*대비|푸짐|양\s*많/],
  ['late', '야식', /야식|새벽|24시|심야/],
];
const INCENTIVE = /(?:후기|리뷰).{0,15}(?:써|작성|남겨|남기|이벤트).{0,25}(?:서비스|증정|드립|보답|무료|사은|음료|추가|할인)|(?:후기|리뷰)\s*이벤트|별점\s*5/;

export const classifyMenu = (categoryName = '', shopName = '') => {
  const byCat = MENU_RULES.find(([, , re]) => re.test(categoryName));
  const hit = byCat ?? MENU_RULES.find(([, , re]) => re.test(shopName));
  return hit ? { id: hit[0], label: hit[1] } : { id: 'other', label: '기타' };
};

export const situationTags = (...texts) => {
  const blob = texts.filter(Boolean).join('\n');
  const tags = [];
  for (const [id, label, re] of SITUATION_RULES) {
    const m = blob.match(re);
    if (m) tags.push({ id, label, matched: blob.slice(Math.max(0, m.index - 12), m.index + m[0].length + 12).replace(/\s+/g, ' ') });
  }
  return tags;
};

export const hasReviewIncentive = text => INCENTIVE.test(String(text ?? ''));

export const bayes = (rating, n, prior, m = 15) => (rating * n + prior * m) / (n + m);

const ratingBucket = r => (r >= 4 ? 'positive' : r >= 3 ? 'neutral' : 'negative');

export function splitReviews(reviews) {
  const split = { positive: 0, neutral: 0, negative: 0, unrated: 0 };
  for (const r of reviews) { const n = Number(r.rating); if (r.rating == null || !Number.isFinite(n) || n <= 0) split.unrated++; else split[ratingBucket(n)]++; }
  const negatives = reviews.filter(r => r.rating != null && Number(r.rating) > 0 && ratingBucket(Number(r.rating)) !== 'positive').sort((a, b) => Number(a.rating) - Number(b.rating));
  return { sampleSize: reviews.length, split, lowReviews: negatives };
}

function findBusinessReviews(node, out = []) {
  if (Array.isArray(node)) {
    if (node.length && node[0]?.__typename === 'BusinessReview') out.push(node);
    else node.forEach(v => findBusinessReviews(v, out));
  } else if (node && typeof node === 'object') Object.values(node).forEach(v => findBusinessReviews(v, out));
  return out;
}

// Customer review text lives in window.__remixContext (BusinessReview.content). The JSON-LD reviewBody is the OWNER's reply.
export function parseRemixReviews(html) {
  const m = String(html).match(/window\.__remixContext = (\{[\s\S]*?\});<\/script>/);
  if (!m) return null;
  let ctx; try { ctx = JSON.parse(m[1]); } catch { return null; }
  const list = findBusinessReviews(ctx)[0];
  if (!list) return null;
  return list.map(r => ({
    date: String(r.createdAt ?? '').slice(0, 10),
    rating: r.starRating ?? null,
    text: String(r.content ?? '').trim().slice(0, 400),
    tags: Array.isArray(r.tags) ? r.tags.map(t => (typeof t === 'string' ? t : t?.name ?? t?.label ?? null)).filter(Boolean) : [],
    ownerReply: r.comment?.content ? String(r.comment.content).trim().slice(0, 300) : null,
  }));
}

export function parseLocalBusiness(html) {
  for (const m of String(html).matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    let d; try { d = JSON.parse(m[1]); } catch { continue; }
    if (d?.['@type'] !== 'LocalBusiness') continue;
    const days = {};
    for (const s of d.openingHoursSpecification ?? []) days[String(s.dayOfWeek).split('/').pop()] = `${s.opens}-${s.closes}`;
    const reviews = parseRemixReviews(html)
      ?? (d.review ?? []).map(r => ({ date: String(r.datePublished ?? '').slice(0, 10), rating: r.reviewRating?.ratingValue ?? null, text: null, tags: [], ownerReply: String(r.reviewBody ?? '').slice(0, 300) || null }));
    return {
      telephone: d.telephone ?? null,
      address: d.address?.streetAddress ?? null,
      priceRange: d.priceRange ?? null,
      hours: days,
      aggregateRating: d.aggregateRating ? { value: Number(d.aggregateRating.ratingValue), count: Number(d.aggregateRating.reviewCount) } : null,
      reviews, ...splitReviews(reviews),
    };
  }
  return null;
}

const shopUrl = p => (p.permalink ? new URL(p.permalink, BASE).toString() : null);

export function normalizeShop(p, areaName) {
  const address = p.roadAddress || p.jibunAddress || '';
  return {
    id: String(p.id),
    name: p.name,
    url: shopUrl(p),
    category: p.category?.name ?? null,
    dong: p.region?.name ?? null,
    roadAddress: p.roadAddress ?? null,
    jibunAddress: p.jibunAddress ?? null,
    inArea: !areaName || address.includes(areaName),
    operationStatus: p.operationStatus ?? null,
    rating: Number(p.starRating) || 0,
    reviewCount: Number(p.reviewCount) || 0,
    followers: Number(p.followersCount) || 0,
    coordinates: p.coordinates ? { lat: p.coordinates.latitude, lng: p.coordinates.longitude } : null,
    description: String(p.description ?? '').slice(0, 400),
    sampleReview: p.review ? { text: String(p.review).replace(/\s+/g, ' ').slice(0, 300), rating: p.reviewRating ?? null, date: p.reviewCreatedAt ?? null } : null,
    reviewIncentive: hasReviewIncentive(p.description),
  };
}

export function rankShops(shops, { minReviews = 15, official = [], community = new Map() } = {}) {
  const pool = shops.filter(s => s.inArea && s.operationStatus !== 'CLOSED' && s.reviewCount >= minReviews);
  const prior = pool.length ? pool.reduce((a, s) => a + s.rating, 0) / pool.length : 4.3;
  const officialByName = new Map(official.map(o => [normName(o.name), o]));
  return pool.map(s => {
    const menu = classifyMenu(s.category ?? '', s.name);
    const score = bayes(s.rating, s.reviewCount, prior);
    const off = officialByName.get(normName(s.name));
    const mentions = community.get(s.id) ?? null;
    const buzz = buzzBonus(mentions);
    return {
      ...s, menu, community: mentions,
      situations: situationTags(s.description, s.sampleReview?.text),
      bayesScore: Number(score.toFixed(3)),
      buzzBonus: Number(buzz.toFixed(3)),
      pickScore: Number((score - (s.reviewIncentive ? 0.15 : 0) + buzz).toFixed(3)),
      official: off ? { source: off.source ?? null, url: off.url ?? null, note: off.note ?? null } : null,
    };
  }).sort((a, b) => b.pickScore - a.pickScore || b.reviewCount - a.reviewCount);
}

export function groupPicks(ranked, perGroup = 3) {
  const byMenu = {};
  for (const s of ranked) (byMenu[s.menu.label] ??= []).push(s.id);
  for (const k of Object.keys(byMenu)) byMenu[k] = byMenu[k].slice(0, perGroup);
  const bySituation = {};
  for (const s of ranked) for (const t of s.situations) (bySituation[t.label] ??= []).push(s.id);
  for (const k of Object.keys(bySituation)) bySituation[k] = bySituation[k].slice(0, perGroup);
  const byBuzz = ranked.filter(s => s.community?.voices >= 2).sort((a, b) => b.community.voices - a.community.voices || b.pickScore - a.pickScore).slice(0, 10).map(s => s.id);
  return { overall: ranked.slice(0, 10).map(s => s.id), byMenu, bySituation, byBuzz };
}

export function defaultQueries(areaAliases = []) {
  const out = [];
  for (const a of areaAliases) {
    if (/[동역]$/.test(a)) out.push(`${a} 맛집`);
    else out.push(`${a}역 맛집`, `${a}동 맛집`);
  }
  return [...new Set(out)];
}

async function getJson(fetchImpl, url, log, tag) {
  const startedAt = new Date().toISOString();
  const res = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json', 'accept-language': 'ko-KR', 'user-agent': UA }, redirect: 'manual' });
  const raw = await res.text();
  let body = null; try { body = JSON.parse(raw); } catch { /* non-JSON */ }
  log.push({ tag, url, status: res.status, at: startedAt, raw });
  return { status: res.status, body };
}

export async function collect(areaName, { queries, aliases = [], fetchImpl = fetch, detail = 12, lowDetail = 6, minReviews = 15, official = [], pauseMs = 250, community = true, seed, posts = 60, shops: preShops, requests: preRequests, regionFilter } = {}) {
  const qs = preShops ? [] : (queries?.length ? queries : defaultQueries(aliases));
  const captures = [];
  const seen = new Map(preShops ? preShops.map(s => [String(s.id), s]) : []);
  const requests = preRequests ? [...preRequests] : [];
  for (const q of qs) {
    const route = new URL('/kr/search/local-profile/', BASE);
    route.searchParams.set('q', q); route.searchParams.set('_data', 'routes/kr.search.local-profile');
    const r = await getJson(fetchImpl, route.toString(), captures, `route:${q}`);
    const bounds = r.body?.regionBounds; const region = r.body?.searchRegion;
    if (r.status !== 200 || !bounds || !region?.id) { requests.push({ query: q, status: r.status, region: region ?? null, shops: 0, note: 'route 응답에 지역 경계가 없어 건너뜀' }); await sleep(pauseMs); continue; }
    const api = new URL('/kr/api/v1/local-profiles/search', BASE);
    for (const [k, v] of Object.entries({ bottomRightLat: bounds.south, bottomRightLng: bounds.east, region_id: region.id, restrict_to_focus_viewport: 'false', search: q, topLeftLat: bounds.north, topLeftLng: bounds.west })) api.searchParams.set(k, String(v));
    const s = await getJson(fetchImpl, api.toString(), captures, `search:${q}`);
    const list = s.body?.searchResult?.localProfiles ?? s.body?.localProfiles ?? [];
    let added = 0;
    for (const p of list) if (!seen.has(String(p.id))) { seen.set(String(p.id), normalizeShop(p, areaName)); added++; }
    requests.push({ query: q, status: s.status, region: s.body?.searchRegion ?? region, shops: list.length, newShops: added });
    await sleep(pauseMs);
  }
  const shops = [...seen.values()];
  let communityRun = null; let communityError = null; let mentions = new Map();
  const seedRegion = seed ?? requests.find(r => r.region?.id)?.region;
  if (community && seedRegion?.id) {
    try {
      communityRun = await collectCommunity({ area: areaName, seed: { id: seedRegion.id, name: seedRegion.name }, posts, pauseMs, regionFilter,
        getJson: (url, tag) => getJson(fetchImpl, url, captures, tag) });
      mentions = extractMentions(communityRun.threads, shops.filter(s => s.inArea && s.operationStatus !== 'CLOSED'), { skipNames: [areaName, ...communityRun.stats.regions.map(r => r.region)] });
    } catch (e) { communityError = String(e?.message ?? e); }
  }
  const ranked = rankShops(shops, { minReviews, official, community: mentions });
  const fetchDetail = async shop => {
    if (!shop.url) return;
    const res = await fetchImpl(shop.url, { method: 'GET', headers: { accept: 'text/html', 'accept-language': 'ko-KR', 'user-agent': UA }, redirect: 'manual' });
    const html = await res.text();
    captures.push({ tag: `detail:${shop.id}`, url: shop.url, status: res.status, at: new Date().toISOString(), raw: html });
    shop.detail = res.status === 200 ? parseLocalBusiness(html) : null;
    shop.detailStatus = res.status;
    await sleep(pauseMs);
  };
  const top = ranked.slice(0, detail);
  for (const shop of top) await fetchDetail(shop);
  const watch = ranked.filter(x => !top.includes(x) && x.rating < 4.5).sort((x, y) => x.rating - y.rating || y.reviewCount - x.reviewCount).slice(0, lowDetail);
  for (const shop of watch) { shop.watchlist = true; await fetchDetail(shop); }
  const collectedAt = new Date().toISOString();
  const officialCheck = official.map(o => {
    const hit = shops.find(x => x.inArea && normName(x.name) === normName(o.name));
    return { name: o.name, source: o.source ?? null, found: Boolean(hit), shopId: hit?.id ?? null, reviewCount: hit?.reviewCount ?? null, inRanking: Boolean(hit && ranked.some(r => r.id === hit.id)) };
  });
  const gaps = [];
  if (!requests.some(r => r.shops > 0)) gaps.push('당근 가게 검색 응답이 비어 있음');
  const capped = requests.filter(r => r.shops >= 20).length;
  if (capped) gaps.push(`검색 ${capped}건이 20곳 상한(페이징 없음)이라 동 전체 목록이 아님`);
  const outside = shops.filter(s => !s.inArea).length;
  if (outside) gaps.push(`${areaName} 밖 주소 ${outside}곳은 제외`);
  if (communityError) gaps.push(`커뮤니티 글 수집 실패: ${communityError}`);
  else if (!community) gaps.push('커뮤니티 글 수집 생략(--no-community)');
  else if (!communityRun) gaps.push('커뮤니티 글 수집 생략: 검색 응답에서 지역을 못 찾음');
  else if (!communityRun.stats.articles) gaps.push('커뮤니티 맛집 글 0건');
  if (!official.length) gaps.push('공식 목록(착한가격업소·모범음식점) 대조 미실시');
  const brief = {
    schemaVersion: 1, kind: 'place_brief', area: areaName, collectedAt, minReviews,
    method: '당근 웹 익명 GET(가게 검색 API + 가게 상세 JSON-LD). 후기 수·별점은 이용자 자기신고이며 검증된 미식 평가가 아님.',
    requests, candidateCount: shops.length, rankedCount: ranked.length,
    ranking: { score: '(별점×후기수 + 풀 평균×15)/(후기수+15); 후기 이벤트 문구가 있으면 pickScore에서 0.15 차감; 당근 동네생활 맛집 글·댓글에서 서로 다른 작성자가 언급하면 1명당 +0.05(최대 +0.15)', pool: `주소에 ${areaName} 포함, 폐업 아님, 후기 ${minReviews}건 이상` },
    community: communityRun ? { ...communityRun.stats, mentionedShops: mentions.size, threads: communityRun.threads.map(({ id, url, title, createdAt, regionName, commentsCount, comments, commentsFetched }) => ({ id, url, title, createdAt, regionName, commentsCount, commentsFetched, commentsSeen: comments.length })) } : null,
    picks: groupPicks(ranked), shops: ranked, officialCheck, gaps,
    mustVerify: ['가격·대표 메뉴는 당근 가게 페이지가 제공하지 않으면 업소 공식 채널로 확인하고 확인일 표기', '영업시간·휴무는 발행 직전 재확인(당근 상세 JSON-LD 기준 수집일 표기)', '후기 별점 구분은 가게 페이지가 주는 최근 약 10건 표본이며 전체 분포가 아님; 별점 0은 별점 도입 전 옛 후기라 미평가로 셈; 낮은 별점 후기는 lowReviews 원문 그대로 인용하고 표본 규모를 함께 밝힘; watchlist=true는 별점이 낮아 따로 상세를 본 가게', '커뮤니티 언급은 이용자 게시물이지 후기 레코드가 아님; 글당 웹에 보이는 댓글은 최대 4건이라 언급 수는 하한이며, 질문글이 많아 추천 근거는 댓글 원문(community.snippets)으로 확인; negativeCue는 키워드 탐지라 원문 확인 후 인용', '가게 이름이 3자 미만이면 언급 매칭에서 제외(오탐 방지)'],
  };
  return { brief, captures };
}

export function writeRun(area, { brief, captures }, root = RUNS, label = area) {
  const dir = path.join(root, 'place-brief', `${kstDate()}-${label.replace(/[^\p{L}\p{N}]+/gu, '-')}`);
  const capDir = path.join(dir, 'captures');
  mkdirSync(capDir, { recursive: true });
  captures.forEach((c, i) => {
    const file = `${String(i + 1).padStart(2, '0')}-${c.tag.replace(/[^\p{L}\p{N}]+/gu, '_').slice(0, 60)}.${/^detail/.test(c.tag) ? 'html' : 'json'}`;
    writeFileSync(path.join(capDir, file), c.raw, 'utf8');
    c.file = file;
  });
  brief.captureFiles = captures.map(c => ({ tag: c.tag, url: c.url, status: c.status, at: c.at, file: c.file }));
  writeFileSync(path.join(dir, 'place-brief.json'), JSON.stringify(brief, null, 2) + '\n', 'utf8');
  return dir;
}

function loadAliases(area) {
  const f = path.join(HERE, 'place-area-ontology.v1.json');
  if (!existsSync(f)) return [];
  const areas = JSON.parse(readFileSync(f, 'utf8')).areas ?? [];
  return (areas.find(a => a.name === area || a.name.endsWith(` ${area}`) || a.id.endsWith(`_${area}`)) ?? {}).aliases ?? [];
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [cmd, area, ...rest] = process.argv.slice(2);
  const flag = (k, d) => (rest.find(a => a.startsWith(`--${k}=`)) ?? '').split('=').slice(1).join('=') || d;
  if (cmd !== 'collect' || !area) { console.error('usage: place-brief.mjs collect <구이름> [--queries=a,b] [--official=file.json] [--detail=8] [--min-reviews=15] [--no-community] [--seed=동이름-ID] [--posts=60] [--write]'); process.exit(2); }
  const officialFile = flag('official');
  const official = officialFile ? JSON.parse(readFileSync(officialFile, 'utf8')) : [];
  const result = await collect(area, {
    queries: flag('queries') ? flag('queries').split(',').map(s => s.trim()).filter(Boolean) : undefined,
    aliases: loadAliases(area), official, detail: Number(flag('detail', 12)), lowDetail: Number(flag('low-detail', 6)), minReviews: Number(flag('min-reviews', 15)),
    community: !rest.includes('--no-community'), posts: Number(flag('posts', 60)),
    seed: flag('seed') ? { name: flag('seed').replace(/-\d+$/, ''), id: flag('seed').match(/-(\d+)$/)?.[1] } : undefined,
  });
  const dir = rest.includes('--write') ? writeRun(area, result) : null;
  const { brief } = result;
  console.log(JSON.stringify({ area: brief.area, candidates: brief.candidateCount, ranked: brief.rankedCount, community: brief.community && { articles: brief.community.articles, postsFetched: brief.community.postsFetched, mentionedShops: brief.community.mentionedShops }, picks: brief.picks, gaps: brief.gaps, dir }, null, 2));
}
