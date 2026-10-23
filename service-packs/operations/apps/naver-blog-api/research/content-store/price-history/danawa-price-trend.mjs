// 다나와 최저가 추이: the XHR behind the 상품 상세 "최저가 추이" graph (1/3/6/12/24개월).
// Observed 2026-10-05 with anonymous plain HTTP (no cookies, no login, non-Korean egress, HTTP 200):
//   prod.danawa.com/info/js/common.min.js getPriceGraph():
//     GET https://prod.danawa.com/info/ajax/getProductPriceList.ajax.php?productCode=<pcode>   -> JSON (served as text/html)
//   {"1":{count,result:[{Fulldate:"26-09-08",date:"09-08",minPrice}],minPrice,maxPrice},"3":{…weekly…},
//    "6":{result:[{date:"26-04",minPrice}]…monthly…},"12":…,"24":…}; a pcode without data answers {"1":{"count":0},…}.
// prod.danawa.com/robots.txt disallows /info/ajax/; shopping-sources.v1.json keeps robots as a reference record only,
// and danawa-prices.mjs already calls the sibling /info/ajax/ mall-list endpoint, so this follows the same policy.
// Never follows a challenge/403/429: ACCESS_BLOCKED stops the caller.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36';
export const TREND_URL = 'https://prod.danawa.com/info/ajax/getProductPriceList.ajax.php';
export const PRODUCT_URL = 'https://prod.danawa.com/info/';
export const TREND_PERIODS = Object.freeze([1, 3, 6, 12, 24]);
const WEEKLY = new Set([1, 3]);
const MAX_BYTES = 3 * 1024 * 1024;
const DAY = 86400e3;

const fail = (code, details = {}) => Object.assign(new Error(code), { code, ...details });
const positiveWon = v => { const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[^\d]/g, '')); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const ymd = ms => new Date(ms).toISOString().slice(0, 10);
const year = yy => 2000 + Number(yy);

export const trendUrl = pcode => `${TREND_URL}?productCode=${encodeURIComponent(String(pcode))}`;
export const productUrl = pcode => `${PRODUCT_URL}?pcode=${encodeURIComponent(String(pcode))}`;

// "26-09-08" -> day point; "26-04" -> month point (min over that month); "현재" -> the fetch moment.
function parsePoint(raw, period, fetchedAtMs) {
  const price = positiveWon(raw?.minPrice);
  if (price === null) return null;
  const label = String(raw?.Fulldate ?? raw?.date ?? '');
  if (label === '현재') return { from: fetchedAtMs, to: fetchedAtMs, resolutionDays: 1, price, label, current: true };
  const day = /^(\d{2})-(\d{2})-(\d{2})$/.exec(label);
  if (day) {
    const t = Date.UTC(year(day[1]), Number(day[2]) - 1, Number(day[3]));
    return Number.isNaN(t) ? null : { from: t, to: t, resolutionDays: WEEKLY.has(period) ? 7 : 1, price, label, current: false };
  }
  const month = /^(\d{2})-(\d{2})$/.exec(label);
  if (month && !WEEKLY.has(period)) {
    const start = Date.UTC(year(month[1]), Number(month[2]) - 1, 1);
    const end = Date.UTC(year(month[1]), Number(month[2]), 0);
    return Number.isNaN(start) ? null : { from: start, to: Math.min(end, fetchedAtMs), resolutionDays: 30, price, label, current: false };
  }
  return null;
}

/** Parse the XHR body (string or object). Throws SCHEMA / ACCESS_BLOCKED; never returns guessed data. */
export function parseDanawaPriceTrend(body, { pcode = null, fetchedAt = new Date().toISOString() } = {}) {
  const fetchedAtMs = Date.parse(fetchedAt);
  if (Number.isNaN(fetchedAtMs)) throw fail('BAD_FETCHED_AT');
  let data = body;
  if (typeof body === 'string') {
    const text = body.trim();
    if (text.startsWith('<')) throw fail(/captcha|robot|비정상|차단|access denied|forbidden/i.test(text) ? 'ACCESS_BLOCKED' : 'SCHEMA');
    try { data = JSON.parse(text); } catch { throw fail('SCHEMA'); }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !TREND_PERIODS.some(p => String(p) in data)) throw fail('SCHEMA');
  const periods = {};
  let dropped = 0;
  for (const p of TREND_PERIODS) {
    const entry = data[String(p)];
    if (!entry || typeof entry !== 'object') continue;
    const rows = Array.isArray(entry.result) ? entry.result : [];
    const points = [];
    for (const raw of rows) { const pt = parsePoint(raw, p, fetchedAtMs); if (pt) points.push(pt); else dropped++; }
    // Top-level minPrice/maxPrice can include values outside the returned points (102459416), so they are kept for reference only.
    periods[p] = { count: Number(entry.count) || 0, points, reportedMin: positiveWon(entry.minPrice), reportedMax: positiveWon(entry.maxPrice) };
  }
  const total = Object.values(periods).reduce((n, x) => n + x.points.length, 0);
  return { source: 'danawa_price_trend', pcode: pcode === null ? null : String(pcode), fetchedAt: new Date(fetchedAtMs).toISOString(), periods, empty: total === 0, dropped,
    // 24개월 요청의 지점 수가 24 미만이면 다나와 등록 이후 이력이 전부 들어 있다.
    historyComplete: periods[24] ? periods[24].count > 0 && periods[24].count < 24 : false };
}

/**
 * One de-duplicated series: weekly points (3개월) for the recent part, monthly points (24개월) for the older part.
 * A monthly point is kept only for months at or before the first weekly point's month (it still describes days before the
 * weekly series starts); later months are already covered by the finer weekly points.
 */
export function mergeTrendPoints(trend) {
  const weekly = trend.periods?.[3]?.points?.length ? trend.periods[3].points : trend.periods?.[1]?.points ?? [];
  const monthlyRaw = trend.periods?.[24]?.points?.length ? trend.periods[24].points : trend.periods?.[12]?.points?.length ? trend.periods[12].points : trend.periods?.[6]?.points ?? [];
  const firstWeekly = weekly.reduce((m, p) => Math.min(m, p.from), Infinity);
  const monthly = monthlyRaw.filter(p => p.from <= firstWeekly);
  return [...monthly, ...weekly].map(p => ({ from: p.from, to: p.to, resolutionDays: p.resolutionDays, price: p.price, label: p.label,
    fromDate: ymd(p.from), toDate: ymd(p.to) })).sort((a, b) => a.from - b.from || a.resolutionDays - b.resolutionDays);
}

const inlineValue = (html, name, key) => {
  const block = new RegExp(`var ${name}\\s*=\\s*\\{([\\s\\S]*?)\\};`).exec(String(html))?.[1];
  const m = block && new RegExp(`\\b${key}\\s*:\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|(\\d+))`).exec(block);
  if (!m) return null;
  return m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : m[2];
};

/** Header facts from the product page (oGlobalSetting): current 최저가 for the cross-check, 출시가, name. */
export function parseDanawaProductHeader(html) {
  const pcode = inlineValue(html, 'oGlobalSetting', 'nProductCode');
  if (!pcode) throw fail('SCHEMA');
  const launch = positiveWon(inlineValue(html, 'oGlobalSetting', 'nInitialPrice'));
  return { pcode: String(pcode), name: inlineValue(html, 'oGlobalSetting', 'sProductName') ?? /<title>([^<]*?)\s*:\s*다나와/.exec(String(html))?.[1] ?? '',
    currentMinPrice: positiveWon(inlineValue(html, 'oGlobalSetting', 'nMinPrice')), launchPrice: launch, categoryCode: inlineValue(html, 'oGlobalSetting', 'nCategoryCode') };
}

/**
 * The graph's last point against the page's current 최저가. 94699838 showed 16,050 on the page and 9,120 on the graph, so a
 * mismatch beyond tolerance marks the trend untrusted instead of silently feeding a "역대 최저".
 */
export function crossCheckCurrent(trend, header, { tolerance = 0.1 } = {}) {
  const points = mergeTrendPoints(trend);
  const last = points.at(-1) ?? null;
  if (!last || !header?.currentMinPrice) return { checked: false, ok: null, reason: !last ? 'no_trend_points' : 'no_header_price' };
  const gap = Math.abs(last.price - header.currentMinPrice) / header.currentMinPrice;
  return { checked: true, ok: gap <= tolerance, lastPoint: { date: last.toDate, price: last.price }, headerPrice: header.currentMinPrice, gapPct: Math.round(gap * 1000) / 10, tolerance };
}

/** Plain observation objects (price-store schema v1) so the caller can append them with appendObservations(). */
export function trendToObservations(trend, { key, aliases = [], identity = 'strong', title = null } = {}) {
  if (!key) throw fail('KEY_REQUIRED');
  return mergeTrendPoints(trend).map(p => ({
    key, aliases, identity, title, seller: '다나와 최저가', channel: 'danawa_trend', price: p.price, shipping: null,
    flags: {}, observedAt: trend.fetchedAt, pointFrom: `${p.fromDate}T00:00:00.000Z`, pointTo: `${p.toDate}T23:59:59.999Z`, resolutionDays: p.resolutionDays,
    source: 'danawa_price_trend', sourceRef: productUrl(trend.pcode),
  }));
}

async function readText(response) {
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_BYTES) throw fail('TOO_LARGE');
  return buffer.toString('utf8');
}
const guardStatus = response => {
  if ([403, 418, 429].includes(response.status)) throw fail('ACCESS_BLOCKED', { status: response.status });
  if (!response.ok) throw fail('HTTP', { status: response.status });
};

export async function fetchDanawaPriceTrend(pcode, { fetchImpl = globalThis.fetch, now = () => new Date(), header = false, sleep = ms => new Promise(r => setTimeout(r, ms)), delayMs = 1500 } = {}) {
  if (!/^\d{3,12}$/.test(String(pcode))) throw fail('BAD_PCODE');
  const response = await fetchImpl(trendUrl(pcode), { headers: { 'user-agent': UA, accept: 'application/json, text/javascript, */*; q=0.01',
    referer: productUrl(pcode), 'x-requested-with': 'XMLHttpRequest' } });
  guardStatus(response);
  const trend = parseDanawaPriceTrend(await readText(response), { pcode, fetchedAt: now().toISOString() });
  if (!header) return { trend, header: null, crossCheck: null };
  await sleep(delayMs);
  const page = await fetchImpl(productUrl(pcode), { headers: { 'user-agent': UA, accept: 'text/html' } });
  guardStatus(page);
  const parsed = parseDanawaProductHeader(await readText(page));
  return { trend, header: parsed, crossCheck: crossCheckCurrent(trend, parsed) };
}
