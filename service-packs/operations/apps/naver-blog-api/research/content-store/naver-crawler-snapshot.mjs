// 네이버 쇼핑·여행 스냅숏: Lee-SiHyeon/naver-shopping-travel-crawler의 공개 HTTP 읽기를
// service-capabilities.v1.json이 live_replay_verified로 둔 기능만 골라 돌리고, 카탈로그용 행으로 정리합니다.
// Usage: node naver-crawler-snapshot.mjs --out=path.json [--shopping-queries=a,b] [--routes=GMP-CJU,PUS-CJU]
//        [--hotel-regions=제주,부산] [--days-ahead=14] [--nights=2] [--deal-market-limit=40] [--no-market]
// Crawler location: NAVER_CRAWLER_DIR or ../../../../../naver-shopping-travel-crawler (sibling GitHub checkout, npm ci done).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REGISTRY_FILE = path.join(HERE, 'service-capabilities.v1.json');
export const DEFAULT_CRAWLER_DIR = path.resolve(HERE, '../../../../../naver-shopping-travel-crawler');

// operation id in service-capabilities → crawler script. Only these are ever called.
export const OPERATIONS = Object.freeze({
  'naver_shopping.today-deals': 'scripts/naver-shopping-deals.mjs',
  'naver_shopping.promotion-feed': 'scripts/naver-shopping.mjs',
  'naver_shopping.integrated-search': 'scripts/naver-shopping.mjs',
  'naver_travel.flight-search-domestic': 'scripts/naver-travel.mjs',
  'naver_travel.flight-cards': 'scripts/naver-travel.mjs',
  'naver_travel.hotel-search': 'scripts/naver-travel.mjs',
  'naver_travel.hotel-rates': 'scripts/naver-travel.mjs',
  'naver_travel.travel-products': 'scripts/naver-travel.mjs',
});

export function verifiedOperations(registry) {
  const levels = new Map();
  for (const s of registry.services ?? []) for (const o of s.operations ?? []) levels.set(`${s.id}.${o.id}`, o.level);
  const allowed = new Set(), skipped = [];
  for (const op of Object.keys(OPERATIONS)) {
    const level = levels.get(op) ?? 'unregistered';
    if (level === 'live_replay_verified') allowed.add(op); else skipped.push({ op, level });
  }
  return { allowed, skipped };
}

const int = v => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.round(Number(v)) : null);
const ymd = d => d.toISOString().slice(0, 10);
export function stayDates(now, daysAhead, nights) {
  const kst = new Date(now.getTime() + 9 * 3600e3);
  const start = new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate() + daysAhead));
  const end = new Date(start.getTime() + nights * 86400e3);
  return { checkIn: ymd(start), checkOut: ymd(end) };
}

// Normalizers: the crawler's own semantics (display price, price scope) are kept; nothing is upgraded to a payable price.
export function dealRows(result) {
  return (result.products ?? []).filter(p => p && p.productId).map(p => ({
    source: 'today_deal', productKey: `naver:${p.productId}`, query: '', title: p.title ?? null, seller: null, url: p.url ?? null,
    listPrice: int(p.salePrice), price: int(p.discountedPrice ?? p.salePrice), discountPercent: int(p.displayDiscountPercent),
    status: p.status ?? null, saleEnd: p.saleEndAt ?? p.campaignEndAt ?? null, rating: null, reviewCount: null, sellersCount: null,
  }));
}
function safeSearchProductId(value) {
  if (typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value)) return value;
  if (Number.isSafeInteger(value) && value > 0 && String(value).length <= 16) return value;
  return null;
}
export function searchRows(result, query) {
  return (result.items ?? []).filter(i => i && safeSearchProductId(i.productId) !== null).map(i => ({
    source: 'integrated_search', productKey: `naver:${i.productId}`, productId: i.productId,
    idKind: i.idKind === 'nv_mid' ? 'nv_mid' : null, query, title: i.title ?? null, seller: i.seller ?? null,
    url: typeof i.url === 'string' ? i.url : null,
    productUrlVerified: i.productUrlVerified === true,
    listPrice: int(i.listPriceKrw), price: int(i.listingPriceKrw), couponPrice: int(i.conditionalCouponPriceKrw),
    couponEligibilityVerified: i.couponEligibilityVerified === true,
    payablePriceVerified: i.payablePriceVerified === true,
    optionsVerified: i.optionsVerified === true,
    shipping: i.deliveryFeeKrw === undefined ? null : int(i.deliveryFeeKrw), rewardMax: int(i.membershipRewardMaxKrw), discountPercent: null, status: i.listingKind ?? null, saleEnd: null,
    rating: i.averageRating ?? null, reviewCount: int(i.reviewCount), sellersCount: int(i.sellersCount),
  }));
}
export function feedRows(result) {
  return (result.items ?? []).filter(i => i && i.productId && i.listingPriceKrw != null).map(i => ({
    source: 'promotion_feed', productKey: `naver:${i.productId}`, query: '', title: i.title ?? null, seller: i.seller ?? null, url: i.url ?? null,
    listPrice: int(i.basePriceKrw), price: int(i.listingPriceKrw), discountPercent: null, status: i.recordType ?? null, saleEnd: null,
    rating: i.averageRating ?? null, reviewCount: int(i.reviewCount), sellersCount: null,
  }));
}
export function flightRows(result, route) {
  return (result.items ?? []).filter(i => i && i.itineraryId && i.listingPriceKrw != null).map(i => ({
    kind: 'flight_domestic', itemKey: i.itineraryId, context: `${route}:${i.legType ?? ''}`, title: `${i.airlineName ?? ''} ${i.flightNumber ?? ''} ${i.departureAirport}→${i.arrivalAirport} ${i.departureTime ?? ''}`.trim(),
    provider: i.airlineName ?? null, price: int(i.listingPriceKrw), priceScope: i.priceScope ?? null, date: i.departureDate ?? null,
    detail: { seatCount: i.seatCount ?? null, seatClass: i.seatClass ?? null, durationMinutes: i.durationMinutes ?? null },
  }));
}
export function hotelRows(result, region) {
  return (result.items ?? []).filter(i => i && i.hotelId).map(i => ({
    kind: 'hotel_indicative', itemKey: String(i.hotelId), context: region, title: i.title ?? null, provider: null, price: int(i.listingPriceKrw),
    priceScope: i.priceScope ?? null, date: null, detail: { star: i.starCount ?? null, rating: i.rating ?? null },
  }));
}
export function hotelRateRows(result, hotel, stay) {
  const rates = (result.rates ?? result.items ?? []).map(r => int(r.listingPriceKrw)).filter(v => v !== null);
  if (!rates.length) return [];
  return [{ kind: 'hotel_rate_min', itemKey: hotel.itemKey, context: `${hotel.context}:${stay.checkIn}~${stay.checkOut}`, title: hotel.title,
    provider: null, price: Math.min(...rates), priceScope: 'quoted_listing_rate_min', date: stay.checkIn, detail: { quotes: rates.length } }];
}
export function tourRows(result) {
  return (result.items ?? []).filter(i => i && i.productId).map(i => ({
    kind: i.recordType === 'hotelProduct' ? 'travel_feed_hotel' : 'travel_feed_tour', itemKey: String(i.productId), context: 'travel.naver.com/domestic',
    title: i.title ?? null, provider: i.agencyName ?? null, price: int(i.listingPriceKrw), priceScope: i.priceScope ?? null, date: null,
    detail: { days: i.dayPeriod ?? null, nights: i.nightPeriod ?? null, rewardRate: i.rewardRate ?? null },
  }));
}

// 통합검색 쇼핑 카드 for one query, only while the registry keeps integrated-search at live_replay_verified.
export function naverSearchCards({ crawlerDir = process.env.NAVER_CRAWLER_DIR || DEFAULT_CRAWLER_DIR, registry = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8')), run } = {}) {
  if (!verifiedOperations(registry).allowed.has('naver_shopping.integrated-search')) return null;
  if (!run && !existsSync(path.join(crawlerDir, OPERATIONS['naver_shopping.integrated-search']))) return null;
  const exec = run ?? makeRunner(crawlerDir);
  return async query => {
    const r = exec(OPERATIONS['naver_shopping.integrated-search'], ['integrated-search', '--query', query]);
    if (!r.ok) throw Object.assign(new Error(r.code), { code: `NAVER_${r.code}` });
    return searchRows(r.result, query);
  };
}

export function makeRunner(crawlerDir) {
  return (script, args) => {
    let text;
    try { text = execFileSync(process.execPath, [script, ...args], { cwd: crawlerDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000, maxBuffer: 64 << 20, windowsHide: true }); }
    catch (error) { text = `${error.stdout ?? ''}`.trim() || `${error.stderr ?? ''}`.trim(); }
    let json; try { json = JSON.parse(text); } catch { return { ok: false, code: 'NON_JSON_OUTPUT' }; }
    if (json.error) return { ok: false, code: json.error.code ?? 'ERROR' };
    return { ok: true, result: json.result ?? json };
  };
}

export async function collectSnapshot({ registry, run, now = new Date(), shoppingQueries = [], routes = ['GMP-CJU', 'PUS-CJU'],
  hotelRegions = ['제주', '부산', '서울', '강릉'], hotelsPerRegion = 10, ratedHotelsPerRegion = 2, daysAhead = 14, nights = 2,
  marketCheck = null, dealMarketLimit = 40 }) {
  const { allowed, skipped } = verifiedOperations(registry);
  const errors = [], shopping = [], travel = [], cards = [];
  let marketChecks = [];
  const call = (op, script, args, onOk) => {
    if (!allowed.has(op)) return;
    const r = run(script, args);
    if (!r.ok) { errors.push({ op, args: args.filter(a => !a.startsWith('--')).join(' '), code: r.code }); return; }
    onOk(r.result);
  };
  const stay = stayDates(now, daysAhead, nights);
  let deals = [];
  call('naver_shopping.today-deals', OPERATIONS['naver_shopping.today-deals'], [], r => { deals = dealRows(r); shopping.push(...deals); });
  call('naver_shopping.promotion-feed', OPERATIONS['naver_shopping.promotion-feed'], ['feed', '--section', 'promotion', '--limit', '40'], r => shopping.push(...feedRows(r)));
  for (const q of shoppingQueries) call('naver_shopping.integrated-search', OPERATIONS['naver_shopping.integrated-search'], ['integrated-search', '--query', q], r => shopping.push(...searchRows(r, q)));
  for (const route of routes) {
    const [from, to] = route.split('-');
    call('naver_travel.flight-search-domestic', OPERATIONS['naver_travel.flight-search-domestic'], ['flight-search', '--type', 'domestic', '--departure', from, '--arrival', to,
      '--departure-date', stay.checkIn.replaceAll('-', ''), '--return-date', stay.checkOut.replaceAll('-', '')], r => travel.push(...flightRows(r, route)));
  }
  for (const region of hotelRegions) {
    let hotels = [];
    call('naver_travel.hotel-search', OPERATIONS['naver_travel.hotel-search'], ['hotel-search', '--query', region, '--size', String(hotelsPerRegion)], r => { hotels = hotelRows(r, region); travel.push(...hotels); });
    for (const hotel of hotels.slice(0, ratedHotelsPerRegion)) {
      call('naver_travel.hotel-rates', OPERATIONS['naver_travel.hotel-rates'], ['hotel-rates', '--hotel-id', hotel.itemKey, '--check-in', stay.checkIn, '--check-out', stay.checkOut, '--adult', '2'],
        r => travel.push(...hotelRateRows(r, hotel, stay)));
    }
  }
  call('naver_travel.travel-products', OPERATIONS['naver_travel.travel-products'], ['travel-products', '--category', 'all', '--limit', '40'], r => travel.push(...tourRows(r)));
  call('naver_travel.flight-cards', OPERATIONS['naver_travel.flight-cards'], ['flight-cards'], r => cards.push(...(r.cards ?? []).map(c => ({ code: c.code, name: c.name, category: c.category }))));

  if (marketCheck && deals.length) {
    const candidates = deals.filter(d => d.status === 'listed_active' && d.price !== null).slice(0, dealMarketLimit);
    const rows = await marketCheck(candidates.map(d => ({ title: d.title, url: d.url, deal: { salePrice: d.price, eventEnd: d.saleEnd } })));
    marketChecks = rows.map((row, i) => ({ ...row, productKey: candidates[i]?.productKey ?? null, source: 'naver_today_deal' }));
  }
  return { kind: 'naver-crawler', schemaVersion: 1, checkedAt: now.toISOString(), stay, gate: { registry: 'service-capabilities.v1.json', ran: [...allowed], skipped },
    shopping, travel, flightCards: cards, marketChecks, errors };
}

async function main() {
  const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  const list = (v, d) => (v === undefined ? d : v.split(',').map(s => s.trim()).filter(Boolean));
  const crawlerDir = process.env.NAVER_CRAWLER_DIR || DEFAULT_CRAWLER_DIR;
  if (!existsSync(path.join(crawlerDir, 'scripts', 'naver-travel.mjs'))) { console.error(JSON.stringify({ ok: false, code: 'NAVER_CRAWLER_MISSING', crawlerDir })); process.exitCode = 2; return; }
  const registry = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8'));
  let marketCheck = null;
  if (!process.argv.includes('--no-market')) {
    const { checkGoldboxAgainstMarket } = await import(pathToFileURL(path.join(HERE, 'goldbox-market-check.mjs')).href);
    marketCheck = items => checkGoldboxAgainstMarket(items, { excludeMall: null });
  }
  const snap = await collectSnapshot({ registry, run: makeRunner(crawlerDir), shoppingQueries: list(arg('shopping-queries'), []),
    routes: list(arg('routes'), undefined), hotelRegions: list(arg('hotel-regions'), undefined),
    daysAhead: Number(arg('days-ahead') ?? 14), nights: Number(arg('nights') ?? 2), dealMarketLimit: Number(arg('deal-market-limit') ?? 40), marketCheck });
  if (arg('out')) writeFileSync(arg('out'), JSON.stringify(snap, null, 2));
  const count = (rows, key) => rows.reduce((acc, r) => ({ ...acc, [r[key]]: (acc[r[key]] ?? 0) + 1 }), {});
  for (const r of snap.marketChecks.filter(r => r.status === 'beats_market')) {
    console.log(`beats_market ${r.salePrice} vs ${r.market?.lowestOther?.mall} ${r.market?.lowestOtherTotal} (offers ${r.market?.offersCompared})  ${r.title}`);
  }
  console.log(JSON.stringify({ checkedAt: snap.checkedAt, stay: snap.stay, shopping: count(snap.shopping, 'source'), travel: count(snap.travel, 'kind'),
    flightCards: snap.flightCards.length, market: count(snap.marketChecks, 'status'), skipped: snap.gate.skipped, errors: snap.errors }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.code ?? error.message); process.exitCode = 1; });
