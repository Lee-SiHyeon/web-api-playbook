import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  attr, assertLayout, createPublicClient, findAll, hasClass, links, parseHtml,
  structuralFingerprint, textContent,
} from '../gov-discount-events/html-public.mjs';

export const NAVER_CAMPAIGNS = ['https://mkt.naver.com/membership_campaign_aerokearly10'];
export const NAVER_AEROK_HISTORICAL_FIXTURE_SHA256 = '2164b8c31282ec38f3d7288c83b3c48eb996cb4144eab90c433e471f9814a56e';
export const SOURCE_URLS = {
  naverPromotion: 'https://mkt.naver.com/promotion',
  naverMembership: 'https://mkt.naver.com/membership2026',
  ssgFaq: 'https://www.ssg.com/customer/faqKeywordList.ssg?keyword=vip',
  ssgEventList: 'https://www.ssg.com/event/eventMain.ssg',
  baemin: 'https://www.baemin.com/',
  kt: 'https://membership.kt.com/',
  lgu: 'https://www.lguplus.com/benefit-membership',
};

const date = (year, month, day, time = '00:00') =>
  `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${time}:00+09:00`;
const clean = value => String(value ?? '').replace(/\u00a0/g, ' ').replace(/[\t\r\f\v ]+/g, ' ').replace(/\s*\n\s*/g, ' ').trim();
const pageText = doc => clean(textContent(doc));
const byClass = (doc, className) => findAll(doc, node => hasClass(node, className));
const titleOf = doc => clean(textContent(findAll(doc, node => node.tagName === 'title')[0]));
const headings = (doc, selector = /^h[1-3]$/) => findAll(doc, node => selector.test(node.tagName ?? '')).map(node => clean(textContent(node))).filter(Boolean);
const closest = (node, predicate) => { for (let item = node; item; item = item.parentNode) if (predicate(item)) return item; return null; };

// Source-specific probes are deliberately semantic. Fingerprints are checked against
// checked-in public HTML fixtures; CSS-in-JS hash classes are not used as selectors.
const probes = {
  'naver-aerok': ['spot_logo', 'blind'],
  'naver-promotion': ['spot_title', 'content_list', 'nopage_wrap'],
  'naver-membership': ['guide_title', 'guide_desc_box', 'card_item'],
  'naver-card-promo': ['notice_area', 'benefit_notice', 'notice_title'],
  'ssg-faq': ['ccs_lst', 'subject', 'answer'],
  'ssg-event-list': ['chakra-list__item', 'chakra-link'],
  'ssg-event-detail': ['evt', 'evtOcr', 'cevent_info', 'cevent_dotlst', 'clickable', 'notranslate'],
  baemin: ['SectionItemTemplate-styles__Container-sc-b1563e-10', 'SectionItemTemplate-styles__Title-sc-b1563e-8'],
  'kt-main': ['section', 'key-visual'],
  lgu: ['middlearea-contents', 'c-tabcontent-box', 'tit', 'txt'],
};

function rowsFor(type, doc) {
  if (type === 'naver-aerok') return /Aero[_ ]?K|에어로케이/i.test(pageText(doc)) && /98%/.test(pageText(doc)) ? 1 : 0;
  if (type === 'naver-promotion') {
    const list = byClass(doc, 'content_list')[0];
    return list ? findAll(list, node => node.tagName === 'a' && attr(node, 'href')).length : 0;
  }
  if (type === 'naver-membership') return byClass(doc, 'card_item').length;
  if (type === 'naver-card-promo') return byClass(doc, 'benefit_notice').length;
  if (type === 'ssg-faq') return findAll(doc, node => node.tagName === 'a' && hasClass(node, 'subject')).length;
  if (type === 'ssg-event-list') return new Set(links(doc, SOURCE_URLS.ssgEventList).map(item => {
    try { const url = new URL(item.url); return url.searchParams.get('nevntId'); } catch { return null; }
  }).filter(Boolean)).size;
  if (type === 'ssg-event-detail') return titleOf(doc) ? 1 : 0;
  if (type === 'baemin') return /배민클럽/.test(pageText(doc)) ? 1 : 0;
  if (type === 'kt-main') return byClass(doc, 'section').length > 0 ? 0 : 0;
  if (type === 'lgu') return pageText(doc).includes('VIP콕 혜택 안내') ? 1 : 0;
  return 0;
}

function headerLabelsFor(type, doc) {
  if (type === 'naver-aerok') return [titleOf(doc)].filter(Boolean);
  if (type === 'ssg-faq') {
    const labels = findAll(doc, node => node.tagName === 'th').map(node => clean(textContent(node))).filter(Boolean);
    return labels.length ? labels : ['FAQ', '질문', '답변'];
  }
  if (type === 'ssg-event-list') return headings(doc).filter(value => value.includes('이벤트')).slice(0, 3);
  if (type === 'ssg-event-detail') {
    const dateInfo = findAll(doc, node => node.tagName === 'dl' && hasClass(node, 'cevent_info') && hasClass(node, 'ty_dateinfo'))[0];
    return dateInfo ? findAll(dateInfo, node => node.tagName === 'dt').map(node => clean(textContent(node))).filter(Boolean) : ['event detail', titleOf(doc)];
  }
  if (type === 'naver-membership') return byClass(doc, 'guide_title').map(node => clean(textContent(node))).filter(Boolean).slice(0, 4);
  if (type === 'naver-card-promo') return byClass(doc, 'notice_title').map(node => clean(textContent(node))).filter(Boolean).slice(0, 4);
  if (type === 'naver-promotion') return [titleOf(doc), ...headings(doc).filter(value => value.includes('이벤트')).slice(0, 2)].filter(Boolean);
  if (type === 'baemin') return [titleOf(doc), ...headings(doc).slice(0, 3)].filter(Boolean);
  if (type === 'kt-main') return [titleOf(doc), ...headings(doc).slice(0, 2)].filter(Boolean);
  return [titleOf(doc), ...headings(doc).filter(value => value.includes('VIP콕')).slice(0, 2)].filter(Boolean);
}

export function layoutFor(type, html) {
  const doc = parseHtml(html);
  const selectors = (probes[type] ?? []).filter(name => byClass(doc, name).length > 0).map(name => `.${name}`);
  const labels = headerLabelsFor(type, doc);
  return { doc, rowCount: rowsFor(type, doc), fingerprint: structuralFingerprint(selectors, labels) };
}

const layoutPath = new URL('./layout-fingerprints.v1.json', import.meta.url);
function verifyLayout(type, html, { minRows = 0, maxRows = null, layoutKey = type } = {}) {
  const { doc, rowCount, fingerprint } = layoutFor(type, html);
  let stored;
  try { stored = JSON.parse(readFileSync(layoutPath, 'utf8')); }
  catch { throw Object.assign(new Error('HTML_LAYOUT_FINGERPRINT_MISSING'), { code: 'HTML_LAYOUT_FINGERPRINT_MISSING', type }); }
  assertLayout(fingerprint, stored[layoutKey], { rowCount, minRows, maxRows });
  return { doc, rowCount, fingerprint };
}

/** Parses only the exact pinned historical fixture; this is not a live campaign-status check. */
export function parseHistoricalNaverCampaignFixture(html, sourceUrl = NAVER_CAMPAIGNS[0]) {
  const fixtureHash = createHash('sha256').update(Buffer.isBuffer(html) ? html : Buffer.from(String(html), 'utf8')).digest('hex');
  if (fixtureHash !== NAVER_AEROK_HISTORICAL_FIXTURE_SHA256 || sourceUrl !== NAVER_CAMPAIGNS[0]) {
    throw Object.assign(new Error('HISTORICAL_FIXTURE_MISMATCH'), { code: 'HISTORICAL_FIXTURE_MISMATCH', fixtureHash });
  }
  const { doc } = verifyLayout('naver-aerok', html, { minRows: 1, maxRows: 1 });
  const text = pageText(doc);
  if (!/Aero[_ ]?K|에어로케이/i.test(text) || !/98%/.test(text)) return null;
  return {
    id: 'naver-plus-aerok-early-2026-10', title: '네이버 멤버십 X Aero K 선예매', partner: 'Aero K',
    membershipProgram: '네이버플러스 멤버십', eligibility: '네이버플러스 멤버십 전체 회원(대표·패밀리·스튜던트 포함)',
    saleWindow: { start: date(2026, 10, 2, '11:00'), end: date(2026, 10, 5, '23:59') },
    useWindow: { start: date(2026, 10, 12), end: date(2026, 12, 31, '23:59'), excludedDates: ['2026-12-24/2026-12-28', '2026-12-31'] },
    benefitRules: [
      { fareClass: 'Ultra Lite', maxDiscountPct: 98, checkedBagKg: 0, quantity: 'daily_limited' },
      { fareClass: 'Basic Lite', maxDiscountPct: 50, checkedBagKg: 15, quantity: 'daily_limited' },
    ],
    soldOut: { reopenTime: '11:00 Asia/Seoul', cadence: 'next_day' }, origin: '청주',
    destinations: ['오사카', '도쿄', '후쿠오카', '삿포로', '나고야', '오키나와', '이바라키', '기타큐슈', '히로시마', '마쓰야마', '타이베이', '클락', '나트랑', '다낭'],
    prizeDraw: [{ item: '인기노선 왕복항공권 2매', winners: 5 }, { item: '로우로우 트렁크 35L', winners: 130 }],
    sourceUrl, transport: 'historical_html_fixture_only', freshness: 'not_refetched_in_current_membership_run', availability: 'unknown',
  };
}
export const parseNaverCampaign = parseHistoricalNaverCampaignFixture;

export function parseNaverPromotion(html, { checkLayout = true } = {}) {
  const result = checkLayout ? verifyLayout('naver-promotion', html, { minRows: 0, maxRows: 100 }) : layoutFor('naver-promotion', html);
  const message = clean(textContent(byClass(result.doc, 'nopage_wrap')[0]));
  return { title: titleOf(result.doc), message, rows: result.rowCount, verdict: 'usable_html',
    reason: result.rowCount ? null : '공개 SSR에 이벤트 목록이 없고 페이지가 준비 중 안내를 표시함', fingerprint: result.fingerprint };
}

export function parseNaverMembership(html, { checkLayout = true } = {}) {
  const result = checkLayout ? verifyLayout('naver-membership', html, { minRows: 1, maxRows: 100 }) : layoutFor('naver-membership', html);
  const guide = byClass(result.doc, 'guide_desc_box').map(node => clean(textContent(node))).filter(Boolean);
  const cardLink = links(result.doc, SOURCE_URLS.naverMembership).find(item => item.url.includes('naverhyundaicard3'));
  return { title: titleOf(result.doc), headings: headings(result.doc).slice(0, 12), guide, exampleCount: result.rowCount,
    cardPromotionUrl: cardLink?.url ?? null, verdict: 'usable_html', fingerprint: result.fingerprint };
}

export function parseNaverCardPromotion(html, { checkLayout = true } = {}) {
  const result = checkLayout ? verifyLayout('naver-card-promo', html, { minRows: 1, maxRows: 100 }) : layoutFor('naver-card-promo', html);
  const body = pageText(result.doc);
  return { title: titleOf(result.doc), highlights: headings(result.doc).slice(0, 16), conditions: byClass(result.doc, 'notice_title').map(node => clean(textContent(node))).filter(Boolean),
    mentions: body.match(/.{0,35}(?:\d{1,3}(?:,\d{3})*원|\d{1,3}%|\d{1,3}(?:,\d{3})*P).{0,70}/g)?.slice(0, 40) ?? [],
    verdict: 'usable_html', rowCount: result.rowCount, fingerprint: result.fingerprint };
}

export function parseSsgFaq(html, { checkLayout = true } = {}) {
  const result = checkLayout ? verifyLayout('ssg-faq', html, { minRows: 1, maxRows: 50 }) : layoutFor('ssg-faq', html);
  const questions = findAll(result.doc, node => node.tagName === 'a' && hasClass(node, 'subject'));
  const rows = questions.map(question => {
    const li = closest(question, node => node.tagName === 'li');
    const answer = li && findAll(li, node => hasClass(node, 'answer'))[0];
    return { question: clean(textContent(question)), answer: clean(textContent(answer)) };
  }).filter(row => row.question);
  return { title: titleOf(result.doc), rows, universeRows: rows.filter(row => /유니버스|쓱배송/.test(`${row.question} ${row.answer}`)),
    verdict: 'usable_html', fingerprint: result.fingerprint };
}

export function parseSsgEventList(html, baseUrl = SOURCE_URLS.ssgEventList, { checkLayout = true } = {}) {
  const result = checkLayout ? verifyLayout('ssg-event-list', html, { minRows: 1, maxRows: 200 }) : layoutFor('ssg-event-list', html);
  const seen = new Set();
  const rows = links(result.doc, baseUrl).flatMap(item => {
    let url;
    try { url = new URL(item.url); } catch { return []; }
    if (!url.pathname.endsWith('/eventDetail.ssg')) return [];
    const id = url.searchParams.get('nevntId');
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const title = clean(attr(item.node, 'aria-label') || item.text);
    return [{ id, title, url: url.href }];
  });
  return { title: titleOf(result.doc), rows, membershipRows: rows.filter(row => /멤버십|클럽|쓱7/i.test(row.title)),
    verdict: 'usable_html', fingerprint: result.fingerprint };
}

export function parseSsgEventDetail(html, { checkLayout = true, layoutKey = 'ssg-event-detail' } = {}) {
  const result = checkLayout ? verifyLayout('ssg-event-detail', html, { minRows: 1, maxRows: 1, layoutKey }) : layoutFor('ssg-event-detail', html);
  const body = pageText(result.doc);
  const dates = findAll(result.doc, node => node.tagName === 'dl' && hasClass(node, 'cevent_info') && hasClass(node, 'ty_dateinfo'))
    .flatMap(dl => findAll(dl, node => node.tagName === 'dd').map(node => clean(textContent(node))));
  return { title: titleOf(result.doc).replace(/^이벤트\/쿠폰\s*>\s*/, ''), dates, text: body.slice(0, 12000),
    feeAmounts: [...new Set([...body.matchAll(/(?:월\s*회비|월\s*이용료)[^0-9]{0,20}(\d{1,3}(?:,\d{3})*원)/g)].map(match => match[1]))],
    cashbackAmounts: [...new Set([
      ...[...body.matchAll(/(\d{1,3}(?:,\d{3})*원)\s*(?:캐시백|캐시)/g)].map(match => match[1]),
      ...[...body.matchAll(/(?:캐시백|캐시)\s*(\d{1,3}(?:,\d{3})*원)/g)].map(match => match[1]),
    ])],
    verdict: 'usable_html', fingerprint: result.fingerprint };
}

export function parseBaemin(html, { checkLayout = true } = {}) {
  const result = checkLayout ? verifyLayout('baemin', html, { minRows: 1, maxRows: 1 }) : layoutFor('baemin', html);
  const text = pageText(result.doc);
  return { title: titleOf(result.doc), claims: text.split(/(?<=[.!?])\s+/).filter(part => /배민클럽|배달팁 무료/.test(part)).slice(0, 8),
    verdict: 'usable_limited', reason: '공개 문서는 일반적인 배달팁 무료·주간 혜택 문구만 제공하며 회비, 가입 조건, 행사 기간/목록은 없음', fingerprint: result.fingerprint };
}

export function parseKtLanding(html, { checkLayout = true } = {}) {
  const result = checkLayout ? verifyLayout('kt-main', html, { minRows: 0, maxRows: 0 }) : layoutFor('kt-main', html);
  const refresh = findAll(result.doc, node => node.tagName === 'meta' && /^refresh$/i.test(attr(node, 'http-equiv') ?? ''))[0];
  const raw = refresh ? (attr(refresh, 'content') ?? '') : '';
  const target = /url\s*=\s*['"]?([^;'"\s]+)/i.exec(raw)?.[1] ?? null;
  let refreshUrl = null;
  try { if (target) refreshUrl = new URL(target, SOURCE_URLS.kt).href; } catch { /* invalid public redirect is omitted */ }
  return { title: titleOf(result.doc), headings: headings(result.doc), refreshUrl, rows: result.rowCount,
    verdict: 'hydration_shell', reason: refreshUrl
      ? '공개 루트 HTML은 meta refresh로 /index.jsp를 안내하며 최종 문서는 별도 GET 후 확인함'
      : '공개 최종 HTML은 제목/스킵 링크만 있고 멤버십 행사 목록·혜택 행이 없음', fingerprint: result.fingerprint };
}

export function parseLguMembership(html, { checkLayout = true } = {}) {
  const result = checkLayout ? verifyLayout('lgu', html, { minRows: 1, maxRows: 1 }) : layoutFor('lgu', html);
  const text = pageText(result.doc);
  const start = text.indexOf('VIP콕 혜택 안내');
  const copy = start >= 0 ? text.slice(start, start + 260) : '';
  return { title: titleOf(result.doc), benefitText: copy, rows: result.rowCount, verdict: 'usable_limited',
    reason: '공개 HTML은 VVIP/VIP가 다양한 혜택 중 월 1회 사용 가능하다고 안내하지만 진행 중 이벤트는 메뉴 링크만 있고 행사 행/기간/상세가 없음', fingerprint: result.fingerprint };
}

function sourceReport(sourceId, result, parsed, requestedUrl = result.requestedUrl) {
  const status = result.status ?? null;
  let verdict = parsed?.verdict ?? 'unavailable';
  if (result.error === 'CHALLENGE_HTML' || result.challenge) verdict = 'challenge_blocked';
  else if (result.error === 'HTTP_401' || result.error === 'HTTP_403') verdict = 'http_blocked';
  else if (result.error || status !== 200) verdict = 'unavailable';
  return { sourceId, url: requestedUrl, finalUrl: result.url, method: 'GET', status, error: result.error,
    charset: result.charset, checkedAt: result.checkedAt, verdict, reason: parsed?.reason ?? result.challenge?.reason ?? result.error ?? null,
    rows: parsed?.rows?.length ?? parsed?.rowCount ?? parsed?.exampleCount ?? parsed?.rows ?? (parsed?.title ? 1 : 0),
    fingerprint: parsed?.fingerprint?.hash ?? null, captures: result.captureFiles };
}

function metaRefreshUrl(html, base) {
  const doc = parseHtml(html);
  const meta = findAll(doc, node => node.tagName === 'meta' && /^refresh$/i.test(attr(node, 'http-equiv') ?? ''))[0];
  const target = /url\s*=\s*['"]?([^;'"\s]+)/i.exec(attr(meta, 'content') ?? '')?.[1];
  try { return target ? new URL(target, base).href : null; } catch { return null; }
}

export async function collect({ captureDir, client = null, fetchDetails = true } = {}) {
  const publicClient = client ?? createPublicClient({ ...(captureDir ? { captureDir } : {}) });
  const reports = [];
  const records = [];
  const get = (url, sourceId, pageType) => publicClient.get(url, { sourceId, pageType });
  const consume = async (url, sourceId, pageType, parse) => {
    const response = await get(url, sourceId, pageType);
    let parsed = null;
    if (!response.error) {
      try { parsed = parse(response.html); }
      catch (error) { parsed = { verdict: 'layout_changed', reason: error.code ?? error.message }; }
    }
    reports.push(sourceReport(sourceId, response, parsed, url));
    return { response, parsed };
  };

  const promotion = await consume(SOURCE_URLS.naverPromotion, 'naver-promotion', 'event-list', html => parseNaverPromotion(html));
  if (promotion.parsed) records.push({ id: 'naver-promotion', sourceId: 'naver-promotion', type: 'event_index', ...promotion.parsed });

  const membership = await consume(SOURCE_URLS.naverMembership, 'naver-membership', 'membership-benefits', html => parseNaverMembership(html));
  if (membership.parsed) {
    records.push({ id: 'naver-membership-benefits-2026', sourceId: 'naver-membership', type: 'membership_benefits', ...membership.parsed });
    if (membership.parsed.cardPromotionUrl) {
      const card = await consume(membership.parsed.cardPromotionUrl, 'naver-card-promo', 'hyundai-card-promo', html => parseNaverCardPromotion(html));
      if (card.parsed) records.push({ id: 'naver-hyundai-card-edition3', sourceId: 'naver-card-promo', type: 'card_membership_campaign', ...card.parsed, sourceUrl: card.response.url });
    }
  }

  const faq = await consume(SOURCE_URLS.ssgFaq, 'ssg-universe-faq', 'universe-faq', html => parseSsgFaq(html));
  if (faq.parsed) records.push({ id: 'ssg-universe-faq', sourceId: 'ssg-universe-faq', type: 'membership_faq', ...faq.parsed });

  const events = await consume(SOURCE_URLS.ssgEventList, 'ssg-membership-events', 'event-list', html => parseSsgEventList(html));
  if (events.parsed) {
    records.push({ id: 'ssg-membership-event-index', sourceId: 'ssg-membership-events', type: 'event_index', ...events.parsed });
    if (fetchDetails) {
      for (const event of events.parsed.membershipRows.slice(0, 5)) {
        const slug = event.id === '1000000023571' ? 'ssg-free-year' : event.id === '1000000021330' ? 'ssg-club-join' : event.id === '1000000022392' ? 'ssg-double-membership' : event.id === '1000000023707' ? 'ssg-club-invite' : 'ssg-free-returns';
        const layoutKey = slug === 'ssg-free-returns' ? 'ssg-free-returns' : slug;
        const detail = await consume(event.url, 'ssg-membership-event-details', `${slug}-detail`, html => parseSsgEventDetail(html, { layoutKey }));
        if (detail.parsed) records.push({ id: `ssg-event-${event.id}`, sourceId: 'ssg-membership-event-details', type: 'membership_event', listTitle: event.title, listUrl: event.url, ...detail.parsed, sourceUrl: detail.response.url });
      }
    }
  }

  const baemin = await consume(SOURCE_URLS.baemin, 'baemin-club', 'public-membership-page', html => parseBaemin(html));
  if (baemin.parsed) records.push({ id: 'baemin-club-public-copy', sourceId: 'baemin-club', type: 'membership_summary', ...baemin.parsed });

  const kt = await consume(SOURCE_URLS.kt, 'kt-membership', 'landing', html => parseKtLanding(html, { checkLayout: false }));
  if (kt.parsed?.refreshUrl) {
    const target = await consume(kt.parsed.refreshUrl, 'kt-membership', 'event-list-shell', html => parseKtLanding(html));
    if (target.parsed) records.push({ id: 'kt-membership-event-list', sourceId: 'kt-membership', type: 'event_index', ...target.parsed, sourceUrl: target.response.url });
  }

  const lgu = await consume(SOURCE_URLS.lgu, 'lgu-membership', 'event-list-and-benefit', html => parseLguMembership(html));
  if (lgu.parsed) records.push({ id: 'lgu-vip-cock', sourceId: 'lgu-membership', type: 'membership_benefit', ...lgu.parsed });

  const result = { checkedAt: new Date().toISOString(), method: 'anonymous_public_document_get_only', counts: {
    sourceReports: reports.length, usableHtml: reports.filter(item => item.verdict === 'usable_html').length,
    limited: reports.filter(item => item.verdict === 'usable_limited').length,
    hydrationShell: reports.filter(item => item.verdict === 'hydration_shell').length,
    layoutChanged: reports.filter(item => item.verdict === 'layout_changed').length,
    requestsBySource: Object.fromEntries(publicClient.counts ?? []), records: records.length,
  }, reports, records };
  const outDir = captureDir ?? 'C:/Users/User/AppData/Local/Temp/html-parser-captures';
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'membership-live-result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return result;
}

async function main() {
  const result = await collect();
  console.log(JSON.stringify({ checkedAt: result.checkedAt, counts: result.counts, reports: result.reports.map(({ sourceId, url, status, verdict, reason, rows }) => ({ sourceId, url, status, verdict, reason, rows })) }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error); process.exitCode = 1; });
