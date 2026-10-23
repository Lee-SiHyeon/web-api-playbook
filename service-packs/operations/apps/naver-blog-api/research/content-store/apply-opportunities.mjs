// 신청형 기회 (체험단·공모전·서포터즈): collect public listings, normalize them to apply-opportunities-ontology.v1.json,
// judge fit against apply-opportunities-profile.json and build a Telegram digest. Owner 2026-09-26: "정보 수집은 자동,
// 신청은 사람이" — this never logs in, applies, or submits anything.
//
//   node apply-opportunities.mjs collect [--write]     fetch sources → opportunities (+ workflow-runs snapshot with --write)
//   node apply-opportunities.mjs digest [--new-only] [--mark-seen]
//                                                     collect, judge, print {text, counts} for the bot to send
//
// Sources and their limits live in the ontology (sources[]): 레뷰 public campaign lists (the category lists need login and
// are not used) and 위비티 contest pages (3 s between requests, detail pages capped per run).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ONTOLOGY = path.join(HERE, 'apply-opportunities-ontology.v1.json');
const PROFILE = path.join(HERE, 'apply-opportunities-profile.json');
const RUNS = path.resolve(HERE, '..', '..', 'workflow-runs');
const SEEN = path.join(os.homedir(), '.config', 'affiliate-content-operations', 'apply-opportunities-seen.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const readJson = f => JSON.parse(readFileSync(f, 'utf8').replace(/^﻿/, ''));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const kstToday = (t = Date.now()) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);
const daysUntil = (ymd, today) => (ymd ? Math.round((Date.parse(ymd) - Date.parse(today)) / 864e5) : null);
const clean = s => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

export const loadOntology = () => readJson(ONTOLOGY);
export const loadProfile = () => readJson(PROFILE);

async function get(url, { fetchImpl = fetch, json = false, headers = {} } = {}) {
  const res = await fetchImpl(url, { headers: { 'user-agent': UA, accept: json ? 'application/json' : 'text/html', ...headers } });
  if (res.status !== 200) { const e = new Error(`HTTP_${res.status}`); e.code = `HTTP_${res.status}`; throw e; }
  return json ? res.json() : res.text();
}

// ── 레뷰: public lists only (api.weble.net robots allow all; category lists answer 401 without login).
const REVU_LISTS = ['deadline', 'high-selection', 'premier', 'trending'];
export function fromRevu(c, checkedAt) {
  const cats = Array.isArray(c.category) ? c.category : [];
  // Category labels vary ('기자단형', '기자단_제품', '배송형', '방문형'), so match by substring.
  const catText = cats.join(' ');
  const deliveryMode = /배송/.test(catText) ? 'delivery' : /방문/.test(catText) ? 'visit' : /기자단/.test(catText) ? 'reporter' : 'unknown';
  const reward = c.campaignData ?? {};
  const rewardType = Number(reward.point) > 0 ? 'point' : deliveryMode === 'visit' && /숙박/.test(reward.reward ?? '') ? 'lodging'
    : deliveryMode === 'visit' ? 'service' : deliveryMode === 'delivery' ? 'product' : 'unknown';
  const minInfluence = c.campaignOptions?.minimumInfluenceCount ?? null;
  return {
    id: `revu:${c.id}`, source: 'revu', kind: 'review_campaign', title: clean(c.item || c.title), url: `https://www.revu.net/campaign/${c.id}`, checkedAt,
    host: clean(c.venue?.name) || null, categories: cats, media: c.media ?? null, deliveryMode,
    location: c.venue?.addressFirst ? { address: clean(c.venue.addressFirst), region: clean(c.venue.addressFirst).split(' ').slice(0, 2).join(' '), tags: c.localTag ?? [] } : (c.localTag?.length ? { address: null, region: null, tags: c.localTag } : null),
    reward: { type: rewardType, raw: clean(reward.reward) || null, point: Number(reward.point) || 0, amount: null },
    obligations: [{ type: c.media === 'blog' ? 'blog_post' : c.media ? 'sns_post' : 'unknown', count: c.requiredPostCount ?? null, from: c.postingStartedOn ?? null, to: c.postingEndedOn ?? null },
      ...(deliveryMode === 'visit' ? [{ type: 'attendance' }] : []), { type: 'disclosure_required' }],
    eligibility: [...(minInfluence ? [{ flag: 'influence_min', value: minInfluence }] : []), { flag: 'login_required_to_apply' }],
    schedule: { applyEnd: c.requestEndedOn ?? null, announce: c.entryAnnouncedOn ?? null, workFrom: c.postingStartedOn ?? null, workTo: c.postingEndedOn ?? null },
    competition: Number.isFinite(c.campaignStats?.requestCount) && Number.isFinite(c.reviewerLimit) ? { applicants: c.campaignStats.requestCount, slots: c.reviewerLimit } : null,
    open: c.status === 'REQUEST' && c.enableRequest !== false && c.active !== false,
    risks: [],
  };
}
export async function collectRevu({ fetchImpl = fetch, checkedAt = new Date().toISOString() } = {}) {
  const byId = new Map(), lists = {};
  for (const seg of REVU_LISTS) {
    try {
      const j = await get(`https://api.weble.net/v1/campaigns/${seg}?limit=50&page=1`, { fetchImpl, json: true, headers: { origin: 'https://www.revu.net', referer: 'https://www.revu.net/' } });
      const items = Array.isArray(j) ? j : j.items ?? [];
      lists[seg] = items.length;
      for (const c of items) if (c?.id && !byId.has(c.id)) byId.set(c.id, { ...fromRevu(c, checkedAt), lists: [seg] }); else if (c?.id) byId.get(c.id).lists.push(seg);
    } catch (e) { lists[seg] = e.code || 'FAILED'; }
    await sleep(1000);
  }
  return { source: 'revu', lists, opportunities: [...byId.values()] };
}

// ── 위비티: list pages, then detail pages (gbn=viewok) for the ones that could fit, 3 s apart.
export function parseWevityList(html) {
  const out = [];
  for (const li of html.split(/<li[ >]/).slice(1)) {
    const a = li.match(/href="\?c=find&s=1&gbn=view&gp=\d+&ix=(\d+)">([\s\S]*?)<\/a>/);
    if (!a) continue;
    const fields = clean(li.match(/<div class="sub-tit">([\s\S]*?)<\/div>/)?.[1]).replace(/^분야\s*:\s*/, '');
    out.push({ ix: a[1], title: clean(a[2].replace(/<span[\s\S]*?<\/span>/g, '')), fields: fields ? fields.split(/\s*,\s*/) : [],
      host: clean(li.match(/<div class="organ">([\s\S]*?)<\/div>/)?.[1]) || null, dday: clean(li.match(/<div class="day">([\s\S]*?)<span/)?.[1]) || null,
      status: clean(li.match(/<span class="dday[^"]*">([\s\S]*?)<\/span>/)?.[1]) || null, views: Number(clean(li.match(/<div class="read">([\s\S]*?)<\/div>/)?.[1]).replace(/,/g, '')) || null });
  }
  return out;
}
export function parseWevityDetail(html) {
  const info = {};
  for (const m of html.matchAll(/<li[^>]*>\s*<span class="tit">([^<]*)<\/span>([\s\S]*?)<\/li>/g)) info[clean(m[1])] = clean(m[2]);
  const period = info['접수기간']?.match(/(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})/);
  const bodyStart = html.indexOf('상세내용');
  const body = bodyStart > 0 ? clean(html.slice(bodyStart, bodyStart + 12000)).slice(0, 3000) : '';
  return { fields: info['분야'] ? info['분야'].split(/\s*,\s*/) : [], target: info['응모대상'] ?? null, host: info['주최/주관'] || null,
    applyStart: period?.[1] ?? null, applyEnd: period?.[2] ?? null, applyRaw: info['접수기간'] ?? null,
    prizeTotal: info['총 상금'] || null, prizeFirst: info['1등 상금'] || null, homepage: html.match(/<span class="tit">홈페이지<\/span>\s*<a href="([^"]+)"/)?.[1] ?? null, body };
}
// Eligibility and risks read from the target line and the detail text (Korean contest boilerplate).
export function wevityEligibility(d) {
  const t = `${d.target ?? ''} ${d.body ?? ''}`, flags = [];
  const target = d.target ?? '';
  if (/대학생|대학원생|재학생|휴학생/.test(target) && !/일반인|누구나|제한없음|전체/.test(target)) flags.push({ flag: 'students_only' });
  const age = t.match(/만\s*(\d{2})\s*세\s*(?:이상)?\s*(?:~|-|부터)?\s*(?:만\s*)?(\d{2})\s*세\s*(?:이하|까지)/);
  if (age) flags.push({ flag: 'age_limited', min: Number(age[1]), max: Number(age[2]) });
  if (/팀\s*\(?\s*\d\s*~\s*\d\s*명|\d\s*~\s*\d\s*명(?:으로)?\s*구성된\s*팀|팀\s*단위\s*(?:참가|지원)만/.test(t)) flags.push({ flag: 'team_required' });
  if (/사업자\s*등록|법인만|기업만\s*참여/.test(t)) flags.push({ flag: 'business_only' });
  if (/청소년|초등|중학생|고등학생|초·중·고|초중고/.test(target)) flags.push({ flag: 'age_limited', min: null, max: 18, basis: 'youth' });
  if (/거주자|주민만|지역\s*소재/.test(target) || /(?:시민|도민|구민|군민|주민)(?:\s*누구나|만|을\s*대상|이면)/.test(d.body ?? '')) flags.push({ flag: 'region_limited' });
  if (!flags.length) flags.push({ flag: /일반인|누구나|제한없음|전체/.test(target) ? 'anyone' : 'unknown' });
  const risks = [];
  if (/참가비|응모비|참가\s*신청비|등록비/.test(t) && !/참가비\s*(?:없음|무료)|무료\s*참가/.test(t)) risks.push('participation_fee');
  if (/저작권.{0,20}(?:주최|주관).{0,10}(?:에게\s*)?(?:귀속|양도)/.test(t)) risks.push('rights_transfer');
  if (/주민등록번호/.test(t)) risks.push('excessive_personal_data');
  return { flags, risks };
}
const ACTIVITY = /서포터즈|기자단|대외활동|홍보대사|앰버서더/;
export async function collectWevity(profile, { fetchImpl = fetch, pages = 3, maxDetails = 12, delayMs = 3000, checkedAt = new Date().toISOString() } = {}) {
  const list = [];
  for (let gp = 1; gp <= pages; gp++) {
    try { list.push(...parseWevityList(await get(`https://www.wevity.com/?c=find&s=1&gp=${gp}`, { fetchImpl }))); } catch (e) { if (gp === 1) return { source: 'wevity', error: e.code || 'FAILED', opportunities: [] }; break; }
    await sleep(delayMs);
  }
  const unique = [...new Map(list.map(x => [x.ix, x])).values()];
  // Detail pages only for listings whose fields touch the owner's topics or that are activities, soonest first.
  const topical = unique.filter(x => x.fields.some(f => profile.topics.includes(f)) || ACTIVITY.test(x.title + x.fields.join(' ')));
  const dnum = x => Number(x.dday?.match(/D-(\d+)/)?.[1] ?? 999);
  const picked = topical.sort((a, b) => dnum(a) - dnum(b)).slice(0, maxDetails);
  const out = [];
  for (const x of picked) {
    let d = null;
    try { d = parseWevityDetail(await get(`https://www.wevity.com/?c=find&s=1&gbn=viewok&gp=1&ix=${x.ix}`, { fetchImpl, headers: { referer: 'https://www.wevity.com/?c=find&s=1' } })); } catch { /* list data only */ }
    await sleep(delayMs);
    const el = d ? wevityEligibility(d) : { flags: [{ flag: 'unknown' }], risks: [] };
    const activity = ACTIVITY.test(x.title + (d?.fields ?? x.fields).join(' '));
    out.push({
      id: `wevity:${x.ix}`, source: 'wevity', kind: activity ? 'activity' : 'contest', title: x.title, url: `https://www.wevity.com/?c=find&s=1&gbn=view&ix=${x.ix}`, checkedAt,
      host: d?.host ?? x.host, categories: d?.fields?.length ? d.fields : x.fields, media: null, deliveryMode: 'online', location: null,
      reward: { type: activity ? 'benefit' : 'prize_money', raw: [d?.prizeTotal && `총 상금 ${d.prizeTotal}`, d?.prizeFirst && `1등 ${d.prizeFirst}`].filter(Boolean).join(', ') || null, amount: null },
      obligations: [{ type: activity ? 'activity_period' : 'submission' }],
      eligibility: el.flags, schedule: { applyStart: d?.applyStart ?? null, applyEnd: d?.applyEnd ?? null, applyEndRaw: d?.applyEnd ? null : (d?.applyRaw ?? x.dday) },
      // '마감임박' is still open; only a plain '마감'/'접수마감'/'종료' is closed.
      competition: null, open: !/^마감$|접수\s*마감|종료/.test(x.status ?? ''), risks: el.risks, homepage: d?.homepage ?? null, target: d?.target ?? null, views: x.views,
    });
  }
  return { source: 'wevity', listed: unique.length, topical: topical.length, detailed: out.length, opportunities: out };
}

// ── 링커리어: public Next.js pages. The list page's Apollo state carries title/organizer/deadline; the detail page adds the
// prize (tenThousandUnitOfReward, in 만원), target, benefits and the organizer's apply link. Same 3 s pacing as 위비티.
export function linkareerState(html) {
  const raw = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1];
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
const lkRef = (state, v) => (v && typeof v === 'object' && '__ref' in v ? state[v.__ref] : v);
const lkNames = (state, v) => (Array.isArray(v) ? v : v == null ? [] : [v]).map(x => lkRef(state, x)?.name).filter(Boolean);
const lkDate = ms => (Number.isFinite(Number(ms)) && Number(ms) > 0 ? kstToday(Number(ms)) : null);
export function parseLinkareerList(html) {
  const next = linkareerState(html);
  if (!next) return [];
  const state = next.props?.pageProps?.__APOLLO_STATE__ ?? {};
  const out = [];
  for (const it of next.props?.pageProps?.activityItems ?? []) {
    const id = it.url?.match(/\/activity\/(\d+)/)?.[1];
    const a = id ? state[`Activity:${id}`] : null;
    if (!a) continue;
    out.push({ id, title: clean(a.title || it.name), org: clean(a.organizationName) || null, typeId: a.activityTypeID ?? a.type ?? null, closeAt: lkDate(a.recruitCloseAt) });
  }
  return out;
}
export function parseLinkareerDetail(html, id) {
  const next = linkareerState(html);
  const state = next?.props?.pageProps?.__APOLLO_STATE__;
  const a = state?.[`Activity:${id}`];
  if (!a) return null;
  const text = lkRef(state, a.detailText)?.text;
  return { title: clean(a.title), org: clean(a.organizationName) || null, status: a.status ?? null, typeId: a.activityTypeID ?? a.type ?? null,
    prizeTotalMan: Number(a.tenThousandUnitOfReward) > 0 ? Number(a.tenThousandUnitOfReward) : null, targets: lkNames(state, a.targets), benefits: lkNames(state, a.benefits),
    categories: [...lkNames(state, a.categories), ...lkNames(state, a.interests)], applyStart: lkDate(a.recruitStartAt), applyEnd: lkDate(a.recruitCloseAt),
    applyUrl: /^https?:\/\//.test(a.applyDetail ?? '') ? a.applyDetail : /^https?:\/\//.test(a.homepageURL ?? '') ? a.homepageURL : null, body: clean(text).slice(0, 3000) };
}
export function fromLinkareer(id, d, checkedAt, today = kstToday()) {
  const activity = d.typeId === 1;
  const el = wevityEligibility({ target: d.targets.join(', ').replace(/\s+/g, ''), body: d.body });
  const cash = d.prizeTotalMan ? `총 상금 ${d.prizeTotalMan.toLocaleString('ko-KR')}만원 (링커리어 표기)` : null;
  const extra = d.benefits.length ? `혜택 ${d.benefits.join(', ')}` : null;
  return {
    id: `linkareer:${id}`, source: 'linkareer', kind: activity ? 'activity' : 'contest', title: d.title, url: `https://linkareer.com/activity/${id}`, checkedAt,
    host: d.org, categories: d.categories, media: null, deliveryMode: 'online', location: null,
    reward: { type: d.prizeTotalMan ? (activity ? 'cash' : 'prize_money') : d.benefits.length ? 'benefit' : 'unknown', raw: [cash, extra].filter(Boolean).join(', ') || null, amount: d.prizeTotalMan ? d.prizeTotalMan * 10000 : null },
    obligations: [{ type: activity ? 'activity_period' : 'submission' }], eligibility: el.flags,
    schedule: { applyStart: d.applyStart, applyEnd: d.applyEnd, applyEndRaw: null }, competition: null,
    open: d.status === 'OPEN' && (d.applyEnd ? d.applyEnd >= today : true), risks: el.risks, homepage: d.applyUrl, target: d.targets.join(', ') || null, views: null,
  };
}
const LK_LISTS = [['contest', 2], ['activity', 1]];
export async function collectLinkareer({ fetchImpl = fetch, maxDetails = 20, delayMs = 3000, checkedAt = new Date().toISOString() } = {}) {
  const today = kstToday(), list = [];
  for (const [seg, pages] of LK_LISTS) for (let page = 1; page <= pages; page++) {
    try { list.push(...parseLinkareerList(await get(`https://linkareer.com/list/${seg}?filterBy_status=OPEN&orderBy_field=RECENT&page=${page}`, { fetchImpl, headers: { 'accept-language': 'ko-KR' } }))); } catch (e) { if (!list.length) return { source: 'linkareer', error: e.code || 'FAILED', opportunities: [] }; break; }
    await sleep(delayMs);
  }
  const unique = [...new Map(list.map(x => [x.id, x])).values()].filter(x => !x.closeAt || x.closeAt >= today);
  // The prize is only on the detail page, so look at the soonest deadlines first (contests before activities within a tie).
  const picked = unique.sort((a, b) => (a.closeAt ?? '9999') < (b.closeAt ?? '9999') ? -1 : (a.closeAt ?? '9999') > (b.closeAt ?? '9999') ? 1 : 0).slice(0, maxDetails);
  const out = [];
  for (const x of picked) {
    let d = null;
    try { d = parseLinkareerDetail(await get(`https://linkareer.com/activity/${x.id}`, { fetchImpl, headers: { 'accept-language': 'ko-KR' } }), x.id); } catch { /* skip: no detail, no prize to report */ }
    await sleep(delayMs);
    // A contest without a stated prize, or an activity without pay, is not a money opportunity; leave it out.
    if (d && (d.prizeTotalMan || (d.typeId === 1 && d.benefits.some(b => /활동비|지원금|상금/.test(b))))) out.push(fromLinkareer(x.id, d, checkedAt, today));
  }
  return { source: 'linkareer', listed: unique.length, detailed: picked.length, opportunities: out };
}

// ── 네이버 브랜드커넥트 캠페인 제휴: the owner's own creator session (web-api-playbook brandconnect.mjs campaign-search,
// read-only). Applying stays manual in the Brand Connect UI.
const BC_PLAYBOOK = process.env.WEB_API_PLAYBOOK || 'C:/Users/User/Documents/GitHub/web-api-playbook';
const BC_SPACE = '997881506414144';
const BC_CHANNEL = { NBLOG: 'blog', INSTAGRAM: 'instagram', YOUTUBE: 'youtube', NCLIP: 'clip' };
export function fromBrandconnect(c, checkedAt) {
  const contents = Array.isArray(c.contents) ? c.contents : [];
  const required = contents.filter(x => x.submissionType === 'REQUIRED').map(x => BC_CHANNEL[x.contentChannelType] ?? String(x.contentChannelType).toLowerCase());
  const optional = contents.filter(x => x.submissionType !== 'REQUIRED').map(x => BC_CHANNEL[x.contentChannelType] ?? String(x.contentChannelType).toLowerCase());
  // A campaign is blog work when a blog post is required, or when only optional channels are listed and blog is one of them.
  const media = required.length ? (required.every(x => x === 'blog') ? 'blog' : required.find(x => x !== 'blog')) : optional.includes('blog') ? 'blog' : optional[0] ?? null;
  const cash = contents.reduce((s, x) => s + (Number(x.cashReward) || 0), 0);
  const products = Array.isArray(c.products) ? c.products : [];
  const productValue = products.reduce((s, p) => s + (Number(p.price) || 0) * (Number(p.amount) || 1), 0);
  const raw = [cash ? `원고료 ${cash.toLocaleString('ko-KR')}원` : null, productValue ? `상품 ${productValue.toLocaleString('ko-KR')}원 상당` : null].filter(Boolean).join(' + ') || null;
  const end = String(c.recruitmentEndAt ?? '').slice(0, 10) || null;
  const firstContent = contents[0] ?? {};
  // Stays and shop visits ride on "provided products" too ([경주] 지지호텔); they are visits, placed by the [지역] tag.
  const name = clean(c.name);
  const visit = /호텔|펜션|리조트|숙박|풀빌라|방문|매장|맛집|식당|레스토랑|스파|클래스/.test(name);
  const regionTag = /^\[([가-힣]{2,6})\]/.exec(name)?.[1] ?? null;
  return {
    id: `brandconnect:${c.id}`, source: 'brandconnect', kind: 'review_campaign', title: name,
    url: `https://brandconnect.naver.com/${BC_SPACE}/campaign/search`, checkedAt, host: null, categories: [], media,
    deliveryMode: visit ? 'visit' : products.length ? 'delivery' : 'online',
    location: visit ? { address: null, region: regionTag, tags: regionTag ? [regionTag] : [] } : null, reward: { type: cash ? 'cash' : products.length ? 'product' : 'unknown', raw, point: 0, amount: cash || null, productValue: productValue || null },
    obligations: [{ type: media === 'blog' ? 'blog_post' : media ? 'sns_post' : 'unknown', count: 1, from: firstContent.submissionStartAt ?? null, to: firstContent.submissionEndAt ?? null },
      ...(visit ? [{ type: 'attendance' }] : []), { type: 'disclosure_required' }],
    eligibility: [{ flag: 'login_required_to_apply' }],
    schedule: { applyEnd: /^\d{4}-\d{2}-\d{2}$/.test(end ?? '') ? end : null, announce: null, workFrom: firstContent.submissionStartAt ?? null, workTo: firstContent.submissionEndAt ?? null },
    competition: Number.isFinite(c.recruitmentApplyCount) && Number.isFinite(c.recruitmentTargetCount) ? { applicants: c.recruitmentApplyCount, slots: c.recruitmentTargetCount } : null,
    open: c.campaignType === 'RECRUITMENT' && (end ? end >= kstToday() : true), channels: { required, optional }, risks: [],
  };
}
export function collectBrandconnect({ pages = 3, pageSize = 50, run = null, checkedAt = new Date().toISOString() } = {}) {
  const exec = run ?? (input => {
    const r = spawnSync(process.execPath, [path.join(BC_PLAYBOOK, 'scripts', 'brandconnect.mjs'), 'campaign-search'], { cwd: BC_PLAYBOOK, input: JSON.stringify(input), encoding: 'utf8', timeout: 120000, windowsHide: true });
    try { return JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { return { ok: false, code: 'NON_JSON_OUTPUT' }; }
  });
  const out = [];
  let total = null;
  for (let page = 1; page <= pages; page++) {
    const j = exec({ page, pageSize });
    if (!j?.ok) return { source: 'brandconnect', error: j?.code ?? 'FAILED', total, opportunities: out };
    total = j.data.paging.total;
    out.push(...j.data.data.map(c => fromBrandconnect(c, checkedAt)));
    if (!j.data.paging.nextCursor) break;
  }
  return { source: 'brandconnect', total, opportunities: out };
}

// ── Validation against the ontology.
export function validateOpportunity(o, ontology) {
  const cv = ontology.controlledValues, problems = [];
  if (!o.id || !o.title || !/^https:\/\//.test(o.url ?? '') || !o.checkedAt) problems.push('id/title/url/checkedAt');
  if (!ontology.sources.some(s => s.id === o.source)) problems.push(`source ${o.source}`);
  if (!ontology.kinds.some(k => k.id === o.kind)) problems.push(`kind ${o.kind}`);
  if (!cv.deliveryMode.includes(o.deliveryMode)) problems.push(`deliveryMode ${o.deliveryMode}`);
  if (!cv.rewardType.includes(o.reward?.type)) problems.push(`rewardType ${o.reward?.type}`);
  for (const ob of o.obligations ?? []) if (!cv.obligationType.includes(ob.type)) problems.push(`obligation ${ob.type}`);
  for (const e of o.eligibility ?? []) if (!cv.eligibilityFlag.includes(e.flag)) problems.push(`eligibility ${e.flag}`);
  for (const r of o.risks ?? []) if (!cv.riskSignal.includes(r)) problems.push(`risk ${r}`);
  if (o.schedule?.applyEnd != null && !/^\d{4}-\d{2}-\d{2}$/.test(o.schedule.applyEnd)) problems.push('applyEnd format');
  if (o.kind === 'review_campaign' && !(o.obligations ?? []).some(ob => ob.type === 'disclosure_required')) problems.push('review_campaign needs disclosure_required');
  return problems;
}

// ── Fit against the owner profile: one value per axis, never one merged score.
const SIDO = ['서울', '경기', '인천', '부산', '대구', '광주', '대전', '울산', '세종', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주'];
const sidoOf = s => SIDO.find(x => String(s ?? '').startsWith(x) || String(s ?? '').includes(x)) ?? null;
export function assessFit(o, profile, { today = kstToday() } = {}) {
  const axes = {}, reasons = [];
  const channels = new Set(profile.channels.map(c => c.id));
  axes.channel = o.kind !== 'review_campaign' ? 'match' : o.media === 'blog' ? (channels.has('blog') ? 'match' : 'mismatch') : o.media ? 'mismatch' : 'unknown';
  if (axes.channel === 'mismatch') reasons.push(`채널 ${o.media}`);
  const text = `${o.title} ${(o.categories ?? []).join(' ')}`;
  const hits = profile.topics.filter(t => text.includes(t));
  axes.topic = hits.length >= 2 ? 'match' : hits.length === 1 ? 'partial' : o.kind === 'review_campaign' ? 'partial' : 'mismatch';
  if (axes.topic === 'mismatch') reasons.push('주제 무관');
  if (o.deliveryMode !== 'visit') axes.location = 'match';
  else if (!profile.region) { axes.location = 'unknown'; reasons.push('방문형: 지역 미설정'); }
  else { axes.location = sidoOf(o.location?.region ?? o.location?.address) === sidoOf(profile.region) ? 'match' : 'mismatch'; if (axes.location === 'mismatch') reasons.push(`방문 지역 ${o.location?.region}`); }
  const flags = (o.eligibility ?? []).map(e => e.flag);
  const el = [];
  if (flags.includes('students_only')) el.push(profile.isStudent === true ? 'match' : profile.isStudent === false ? 'mismatch' : 'unknown');
  const age = (o.eligibility ?? []).find(e => e.flag === 'age_limited');
  if (age) el.push(profile.ageGroup == null ? 'unknown' : ((age.min == null || profile.ageGroup >= age.min) && profile.ageGroup <= age.max ? 'match' : 'mismatch'));
  if (flags.includes('region_limited') || flags.includes('unknown')) el.push('unknown');
  if (flags.includes('team_required')) el.push(profile.teamAvailable === true ? 'match' : profile.teamAvailable === false ? 'mismatch' : 'unknown');
  if (flags.includes('business_only')) el.push(profile.hasBusiness === true ? 'match' : profile.hasBusiness === false ? 'mismatch' : 'unknown');
  axes.eligibility = el.includes('mismatch') ? 'mismatch' : el.includes('unknown') ? 'unknown' : 'match';
  if (axes.eligibility === 'mismatch') reasons.push('자격 불일치');
  const FLAG_KO = { students_only: '학생 대상', age_limited: age?.basis === 'youth' ? '청소년 대상' : `만 ${age?.min ?? ''}~${age?.max ?? ''}세`, team_required: '팀 참가',
    business_only: '사업자 대상', region_limited: '지역 주민 대상', influence_min: '영향력 조건', unknown: '대상 불명확' };
  if (axes.eligibility === 'unknown') reasons.push(`확인 필요: ${flags.filter(f => FLAG_KO[f]).map(f => FLAG_KO[f]).join(', ')}`);
  const d = daysUntil(o.schedule?.applyEnd, today);
  axes.deadline = d == null ? 'unknown' : d < 0 ? (o.open ? 'unknown' : 'closed') : d <= 3 ? 'urgent' : 'open';
  if (d != null && d < 0 && o.open) o.risks = [...new Set([...(o.risks ?? []), 'deadline_date_past_but_open'])];
  axes.competition = o.competition ? (o.competition.slots ? Math.round((o.competition.applicants / o.competition.slots) * 10) / 10 : null) : null;
  axes.risk = (o.risks ?? []).filter(r => r !== 'deadline_date_past_but_open');
  const hardRisk = axes.risk.some(r => ['participation_fee', 'excessive_personal_data'].includes(r));
  const mismatch = ['channel', 'topic', 'location', 'eligibility'].some(k => axes[k] === 'mismatch');
  const decision = !o.open || axes.deadline === 'closed' || mismatch || hardRisk ? 'skip' : ['location', 'eligibility'].some(k => axes[k] === 'unknown') ? 'watch' : 'notify';
  if (hardRisk) reasons.push(`위험: ${axes.risk.join(',')}`);
  return { decision, axes, reasons, daysLeft: d };
}

// ── Digest text for Telegram (plain text; links as bare URLs).
const REWARD = o => o.reward?.raw ? o.reward.raw.slice(0, 60) : o.reward?.point ? `${o.reward.point.toLocaleString('ko-KR')}P` : '';
const line = (o, f) => {
  const dl = f.daysLeft == null ? (o.schedule?.applyEndRaw ?? '마감 미상') : f.daysLeft === 0 ? '오늘 마감' : `D-${f.daysLeft}`;
  const comp = o.competition ? ` · ${o.competition.slots}명 모집에 ${o.competition.applicants}명 신청 (${f.axes.competition}:1)` : '';
  const where = o.deliveryMode === 'visit' ? ` · 방문 ${o.location?.region ?? o.location?.tags?.join('/') ?? ''}` : o.deliveryMode === 'delivery' ? ' · 배송형' : o.deliveryMode === 'reporter' ? ' · 기자단' : '';
  const RISK_KO = { participation_fee: '참가비', excessive_personal_data: '주민번호 요구', rights_transfer: '저작권 양도', unclear_host: '주최 불명확' };
  const warn = [...(f.axes.risk ?? []).map(r => RISK_KO[r] ?? r), ...f.reasons.filter(r => /확인 필요|미설정/.test(r))];
  return `• ${o.title.slice(0, 50)}\n  ${[REWARD(o), dl].filter(Boolean).join(' · ')}${comp}${where}${warn.length ? `\n  ⚠️ ${warn.join(' / ')}` : ''}\n  ${o.url}`;
};
export function buildDigest(items, { today = kstToday(), max = 8 } = {}) {
  const pick = kinds => items.filter(x => kinds.includes(x.o.kind) && x.f.decision !== 'skip')
    // Recommended first, then the least crowded (applicants per slot), then the nearest deadline.
    .sort((a, b) => (a.f.decision === 'notify' ? 0 : 1) - (b.f.decision === 'notify' ? 0 : 1) || (a.f.axes.competition ?? 50) - (b.f.axes.competition ?? 50)
      || (a.f.daysLeft ?? 99) - (b.f.daysLeft ?? 99)).slice(0, max);
  const camp = pick(['review_campaign']), cont = pick(['contest', 'activity']);
  if (!camp.length && !cont.length) return null;
  return [`🎯 신청형 기회 ${today} (신청은 직접, 원문에서 조건 확인)`,
    camp.length ? `\n📦 체험단 (블로그)\n${camp.map(x => line(x.o, x.f)).join('\n')}\n※ 선정되면 후기에 "제품·서비스를 제공받아 작성" 표시가 필요합니다.` : '',
    cont.length ? `\n🏆 공모전·서포터즈\n${cont.map(x => line(x.o, x.f)).join('\n')}` : ''].filter(Boolean).join('\n');
}

export async function collectAll({ fetchImpl = fetch } = {}) {
  const ontology = loadOntology(), profile = loadProfile(), checkedAt = new Date().toISOString();
  const results = [await collectRevu({ fetchImpl, checkedAt }), await collectWevity(profile, { fetchImpl, checkedAt }), await collectLinkareer({ fetchImpl, checkedAt }), collectBrandconnect({ checkedAt })];
  const opportunities = [], rejected = [], seenTitles = new Set();
  // The same contest is often listed on 위비티 and 링커리어; keep the first copy (위비티 comes first and states the 1등 prize).
  const titleKey = o => (o.kind === 'review_campaign' ? '' : o.title.toLowerCase().replace(/[^0-9a-z가-힣]/g, ''));
  for (const r of results) for (const o of r.opportunities) {
    const p = validateOpportunity(o, ontology);
    if (p.length) { rejected.push({ id: o.id, problems: p }); continue; }
    const key = titleKey(o);
    if (key && seenTitles.has(key)) continue;
    if (key) seenTitles.add(key);
    opportunities.push(o);
  }
  const today = kstToday();
  const assessed = opportunities.map(o => ({ o, f: assessFit(o, profile, { today }) }));
  return { checkedAt, today, sources: results.map(({ opportunities: _, ...r }) => ({ ...r, count: _.length })), assessed, rejected };
}

async function main() {
  const [cmd] = process.argv.slice(2);
  if (!['collect', 'digest'].includes(cmd)) { console.log(JSON.stringify({ ok: false, code: 'COMMAND_INVALID' })); process.exitCode = 2; return; }
  const r = await collectAll();
  const counts = { total: r.assessed.length, notify: r.assessed.filter(x => x.f.decision === 'notify').length, watch: r.assessed.filter(x => x.f.decision === 'watch').length,
    skip: r.assessed.filter(x => x.f.decision === 'skip').length, rejected: r.rejected.length };
  if (process.argv.includes('--write')) {
    const dir = path.join(RUNS, `apply-opportunities-${r.checkedAt.replace(/[-:]/g, '').slice(0, 15)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'opportunities.json'), JSON.stringify({ schemaVersion: 1, kind: 'apply-opportunities', checkedAt: r.checkedAt, today: r.today, sources: r.sources,
      opportunities: r.assessed.map(({ o, f }) => ({ ...o, fit: f })), rejected: r.rejected }, null, 2) + '\n');
    counts.dir = dir;
  }
  if (cmd === 'collect') { console.log(JSON.stringify({ ok: true, sources: r.sources, counts })); return; }
  let seen = {};
  try { seen = readJson(SEEN); } catch { /* first run */ }
  const items = process.argv.includes('--new-only') ? r.assessed.filter(x => !seen[x.o.id]) : r.assessed;
  const text = buildDigest(items, { today: r.today });
  if (process.argv.includes('--mark-seen')) {
    for (const x of r.assessed) seen[x.o.id] ??= r.today;
    mkdirSync(path.dirname(SEEN), { recursive: true });
    writeFileSync(SEEN, JSON.stringify(seen, null, 2) + '\n');
  }
  console.log(JSON.stringify({ ok: true, text, counts, sources: r.sources }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.log(JSON.stringify({ ok: false, code: e.code || e.message })); process.exitCode = 1; });
