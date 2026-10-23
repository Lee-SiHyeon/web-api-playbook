// 장보기 가격·리뷰 비교: one keyword (e.g. 삼겹살) across sites with an observed public search-data contract,
// normalized to price per 100 g with origin (국내산/수입), storage (냉장/냉동), cut and reviews. Owner 2026-09-26:
// "삼겹살 어디서 사는게 제일 리뷰좋고 쌀까? … 블로그 글쓸거 준비해".
//
//   node grocery-compare.mjs collect <keyword> [--write]   offers + segment picks (+ workflow-runs snapshot)
//   node grocery-compare.mjs brief <keyword> [--write]     collect, then an article brief (eventKind grocery_compare)
//   --gmarket                                        force one protected-session Gmarket attempt
//   --no-gmarket                                     skip Gmarket; otherwise include it when a scoped session is ready
//   --market-reference                               optional Danawa catalog marketplace candidates (never picks)
//   --coupang-partners                                explicitly include the authenticated Partners web search
//   --no-coupang-partners                             keep the Partners web search disabled (default)
//   [--no-coupang-danawa] [--coupang-limit=N]         optional Danawa catalog price reference
//
// Current routine sources: 홈플러스, 이마트몰(SSG), 롯데ON, 11번가, 컬리. SSG's and 11st's first-party
// product-list XHRs were captured from their normal consumer search pages and replayed as JSON without cookies.
// Coupang's normal consumer page uses a Next.js RSC
// fetch for sorted results, but its direct Node replay currently returns HTTP 403. Gmarket's protected
// Document GET is included automatically when the current user's scoped DPAPI handoff is ready.
// Auction search HTML is visible in Chrome, but direct GET returns HTTP 403 before product markup arrives.
// Coupang Partners' observed web search is a separate opt-in; session availability never enables it by default.
// No cart, ordering or affiliate-link generation is performed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readGmarketProducts } from '../../../affiliate-api-hub/adapters/gmarket-products.mjs';
import { shoppingSessionStatus } from '../../../affiliate-api-hub/lib/shopping-session-store.mjs';
import { readCoupangProducts } from '../../../affiliate-api-hub/adapters/coupang-products.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNS = path.resolve(HERE, '..', '..', 'workflow-runs');
const CODEX_ROOT = 'C:/Users/User/Documents/Codex';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const kstDate = (t = Date.now()) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);
const num = v => { const n = Number(String(v ?? '').replace(/[^\d.]/g, '')); return Number.isFinite(n) && String(v ?? '').match(/\d/) ? n : null; };
const observedBoolean = value => value === true || value === 'Y' || value === 1 ? true : value === false || value === 'N' || value === 0 ? false : null;
const anyObserved = values => values.includes(true) ? true : values.includes(false) ? false : null;

export const SOURCES = {
  homeplus: { label: '홈플러스', robots: 'mfront.homeplus.co.kr: Disallow /favorite, /mypage only', checkedAt: '2026-09-26' },
  ssg: { label: '이마트몰(SSG)', contract: 'POST https://search.ssg.com/api/item/all; captured from normal consumer search UI; siteNo=6005, target=pc_item, count=40, sort=prcasc; browserless replay HTTP 200 JSON without cookies on 2026-09-26', checkedAt: '2026-09-26' },
  lotteon: { label: '롯데ON', robots: 'www.lotteon.com: Allow /csearch/, /p/product/', checkedAt: '2026-09-26' },
  kurly: { label: '컬리', robots: 'www.kurly.com: Allow / (except /mypage/, /order/ …)', checkedAt: '2026-09-26' },
  elevenst: { label: '11번가', contract: 'GET https://apis.11st.co.kr/search/api/tab?kwd=…&tabId=TOTAL_SEARCH&_={timestamp}; captured from normal consumer search UI; browserless replay HTTP 200 without cookies on 2026-09-26', checkedAt: '2026-09-26' },
  gmarket: { label: 'G마켓', contract: 'GET https://www.gmarket.co.kr/n/search?keyword=…; organic products in __NEXT_DATA__; current-user scoped DPAPI session required', checkedAt: '2026-09-27' },
  // Consumer search direct HTTP was refused with 403. Danawa offers are price-only; Partners search is a separate explicit opt-in.
  coupang: { label: '쿠팡 가격 참고', contract: 'Consumer search direct HTTP 403; optional Danawa catalog offers are price-only; Partners web search requires an explicit opt-in and is not consumer search', checkedAt: '2026-09-27' },
};
export const EXCLUDED = [
  { site: '네이버쇼핑', reason: '소비자 검색 직접 HTTP는 418, 브랜드 리뷰는 429, 카탈로그 리뷰는 418. 기획전 단일 레이아웃은 최근 200이지만 상품 0개이며 키워드 전체 검색이 아님' },
  { site: '쿠팡 일반 쇼핑몰', reason: '로그인 브라우저의 /np/search RSC는 200이지만 선별한 쿠팡 세션 쿠키를 보호 전달한 독립 Node GET은 HTTP 403' },
  { site: 'G마켓', reason: '현재 사용자 보호 세션이 준비되면 자동 수집; 이번 실행에서는 세션이 준비되지 않았거나 --no-gmarket으로 제외' },
  { site: '옥션', reason: '검색 상품은 HTML 문서에 있으나 직접 GET은 403이고 허용된 가격 수집 경로가 확인되지 않음. 사진 리뷰만 상품 URL 수동 입력 시 별도 사용 가능' },
];

const MARKETPLACE_NAMES = new Set(['G마켓', '옥션']);

// ── Name parsing: weight, pack count, origin, storage, cut.
// Checked before DOMESTIC: "중국산" also contains "국산" (2026-09-28: [중국산]목이버섯 was read as domestic).
const IMPORT = /수입|중국|베트남|태국|인도네시아|필리핀|인도|러시아|페루|호주|뉴질랜드|일본|스페인|독일|덴마크|칠레|네덜란드|미국|캐나다|멕시코|브라질|오스트리아|프랑스|벨기에|이베리코|포르투갈|헝가리|폴란드|핀란드/;
const DOMESTIC = /한돈|국내산|국산|제주|지리산|한돈팩|도드람|하이포크|포크밸리|보먹돼|일품포크|무항생제\s*한돈/;
export function parseName(name) {
  const n = String(name ?? '');
  const m = [...n.matchAll(/(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(kg|g)(?![a-z])/gi)];
  let grams = null, ambiguous = false;
  if (m.length) {
    const g = x => Number(x[1].replace(/,/g, '')) * (x[2].toLowerCase() === 'kg' ? 1000 : 1);
    grams = g(m[0]);
    // "600g/1kg" or "300g, 500g" lists options: the shown price is for one of them, so mark it.
    if (m.length > 1) {
      const between = n.slice(m[0].index + m[0][0].length, m.at(-1).index);
      if (/\/|,|~|～|또는|택/.test(between)) ambiguous = true;
      else if (/[+＋]/.test(between)) grams = m.reduce((sum, x) => sum + g(x), 0);
    }
    const pack = n.match(/(?:x|X|×|\*)\s*(\d+)\s*(?:팩|개|봉|입)?|(\d+)\s*(?:팩|봉)(?!\s*당)/);
    const count = pack ? Number(pack[1] ?? pack[2]) : 1;
    if (count > 1 && count <= 20 && !ambiguous) grams *= count;
  }
  return {
    grams, weightAmbiguous: ambiguous,
    origin: IMPORT.test(n) ? 'imported' : DOMESTIC.test(n) ? 'domestic' : 'unknown',
    storage: /냉동/.test(n) ? 'frozen' : /냉장/.test(n) ? 'chilled' : 'unknown',
    cut: /대패/.test(n) ? 'thin_sliced' : /수육|통삼겹|보쌈/.test(n) ? 'whole' : /구이|칼집|오겹|벌집/.test(n) ? 'grill' : 'unknown',
  };
}
const per100 = (price, grams) => (price && grams ? Math.round((price / grams) * 100) : null);
// Listing titles write the keyword with or without spaces and put the storage anywhere ("냉동 삼겹살", "삼겹살(냉동)"):
// match with spaces removed, and a storage-prefixed keyword ("냉동삼겹살") by its cut plus the parsed storage.
export function matchesKeyword(name, keyword) {
  const flat = s => String(s ?? '').replace(/\s+/g, '');
  const n = flat(name), k = flat(keyword);
  if (n.includes(k)) return true;
  const m = /^(냉동|냉장)(.+)$/.exec(k);
  return Boolean(m) && n.includes(m[2]) && parseName(name).storage === (m[1] === '냉동' ? 'frozen' : 'chilled');
}
// Raw meat only: seasoned, smoked, cooked or meal-kit items are a different product.
export const PROCESSED = /양념|훈제|구운|볶음|김치|찌개|덮밥|도시락|과자|스낵|소스|밀키트|간장|고추장|떡|만두|꼬치|튀김|가스|스테이크\s*소스|수제|반찬|조림|장조림|편육|족발/;
// A listing that offers several cuts as options ("삼겹살/목살/항정살") has no single price per 100 g.
const CUTS = ['목살', '목심', '항정', '앞다리', '뒷다리', '갈비', '등심', '안심', '가브리', '꼬들', '특수부위'];
export const multiCut = (name, keyword) => CUTS.filter(c => !keyword.includes(c) && name.includes(c)).length > 0 && /\/|,|[+＋]|택\s*1|골라/.test(name);

async function getJson(url, headers = {}, fetchImpl = fetch) {
  const res = await fetchImpl(url, { headers: { 'user-agent': UA, accept: 'application/json', ...headers } });
  if (res.status !== 200) { const e = new Error(`HTTP_${res.status}`); e.code = `HTTP_${res.status}`; throw e; }
  return res.json();
}

async function postJson(url, body, headers = {}, fetchImpl = fetch) {
  const res = await fetchImpl(url, { method: 'POST', headers: {
    'user-agent': UA, accept: 'application/json, text/plain, */*', 'content-type': 'application/json; charset=UTF-8', ...headers,
  }, body: JSON.stringify(body) });
  if (res.status !== 200) { const e = new Error('HTTP_' + res.status); e.code = 'HTTP_' + res.status; throw e; }
  const contentType = res.headers?.get?.('content-type') ?? '';
  if (contentType && !/application\/json/i.test(contentType)) { const e = new Error('CONTENT_TYPE'); e.code = 'CONTENT_TYPE'; throw e; }
  return res.json();
}

export function fromHomeplus(it, checkedAt) {
  const p = parseName(it.itemNm);
  const unitGrams = it.unitMeasure === 'G' ? Number(it.totalUnitQty) : it.unitMeasure === 'KG' ? Number(it.totalUnitQty) * 1000 : null;
  // Card discounts are excluded from the comparison price (they need a specific card); item discounts count.
  const itemDc = Number(it.dcTooltip?.itemDcPrice) < 0 ? Number(it.dcTooltip.itemDcPrice) : 0;
  const cardDc = Number(it.dcTooltip?.cardDcPrice) < 0 ? Number(it.dcTooltip.cardDcPrice) : 0;
  const salePrice = num(it.salePrice);
  const price = salePrice == null ? null : salePrice + itemDc;
  const grams = unitGrams || p.grams;
  return { mall: 'homeplus', id: `homeplus:${it.itemNo}`, name: it.itemNm, url: `https://mfront.homeplus.co.kr/item?itemNo=${it.itemNo}&storeType=${it.storeType ?? 'HYPER'}`, checkedAt,
    price, currency: 'KRW', listPrice: salePrice, discountKind: it.dcType ?? null, cardOnly: false,
    cardPrice: cardDc ? price + cardDc : null, cardBenefit: cardDc ? `${it.dcTooltip.dcCardText ?? '카드할인'} ${it.dcTooltip.dcDateText ?? ''}`.trim() : null,
    grams, per100g: per100(price, grams), minQty: Number(it.purchaseMinQty) || 1, minOrderGrams: grams && it.purchaseMinQty ? grams * Number(it.purchaseMinQty) : grams,
    shipping: (it.deliveryLabelList ?? []).join(', ') || null, rating: num(it.grade), reviews: num(it.reviewCnt), reviewsCapped: false,
    soldOut: observedBoolean(it.soldOutYn), ...p, grams };
}
export function fromLotteon(it, checkedAt) {
  const b = it.brazeData ?? {}, p = parseName(it.pdName);
  const price = num(it.priceInfo?.finalPrice) ?? num(b.discountPrice);
  const fee = (it.additionalFlagList ?? []).find(f => f.type === 'DF')?.name ?? b.dvCst ?? null;
  const cardPct = it.promotionInfo?.type === 'card' ? num(it.promotionInfo.value) : null;
  const origin = /수입/.test(b.categoryName ?? '') ? 'imported' : /국내|국산/.test(b.categoryName ?? '') ? 'domestic' : p.origin;
  let url = null;
  try { url = new URL(it.pdLink ?? `/p/product/${it.pdId}`, 'https://www.lotteon.com').href; } catch {}
  return { mall: 'lotteon', id: `lotteon:${it.sitmId ?? it.pdId}`, name: it.pdName, url, checkedAt,
    price, currency: 'KRW', listPrice: num(it.priceInfo?.original), discountKind: it.promotionInfo?.type ?? null, cardOnly: false, cardBenefit: it.promotionInfo?.type === 'card' ? `${it.promotionInfo.text} ${it.promotionInfo.value}%` : null,
    cardPrice: cardPct > 0 && cardPct < 100 && price ? Math.round(price * (1 - cardPct / 100)) : null, cardPriceApprox: cardPct > 0,
    grams: p.grams, per100g: p.weightAmbiguous ? null : per100(price, p.grams), minQty: 1, minOrderGrams: p.grams,
    shipping: fee == null ? null : Number(String(fee).replace(/,/g, '')) === 0 ? '무료배송' : `배송비 ${fee}원`, rating: num(b.reviewScore) ?? num(it.reviewInfo?.score),
    reviews: num(b.reviewCount) ?? num(it.reviewInfo?.count), reviewsCapped: false, soldOut: observedBoolean(it.soldOutYn), seller: it.storeName || b.brandName || null,
    ...p, origin };
}
export function fromKurly(it, checkedAt) {
  const p = parseName(it.name);
  const price = num(it.discountedPrice) ?? num(it.salesPrice);
  const capped = /\+/.test(String(it.reviewCount ?? ''));
  return { mall: 'kurly', id: `kurly:${it.no}`, name: it.name, url: `https://www.kurly.com/goods/${it.no}`, checkedAt,
    price, currency: 'KRW', listPrice: num(it.salesPrice), discountKind: it.discountRate ? 'item_discount' : null, cardOnly: false,
    firstOrderPrice: num(it.firstOrderBenefit?.price),
    grams: p.grams, per100g: p.weightAmbiguous || it.isMultiplePrice ? null : per100(price, p.grams), minQty: 1, minOrderGrams: p.grams,
    multipleOptions: Boolean(it.isMultiplePrice), shipping: (it.deliveryTypeNames ?? []).join(', ') || null, rating: null,
    reviews: num(it.reviewCount), reviewsCapped: capped, soldOut: observedBoolean(it.isSoldOut), ...p };
}

export function fromElevenst(it, checkedAt) {
  const name = it.title ?? it.prdNm ?? '';
  const p = parseName(name);
  // finalPrc/maxDiscountInfo.finalPrice reflects the product's direct discount; card/point benefits stay separate.
  const price = num(it.maxDiscountInfo?.finalPrice) ?? num(it.finalPrc) ?? num(it.selPrc);
  const reviewText = String(it.reviewCountText ?? '');
  const reviewsCapped = /\+/.test(reviewText);
  const delivery = String(it.deliveryDescription ?? '').trim();
  const shippingFee = /무료/.test(delivery) ? 0 : num(delivery);
  const shipping = shippingFee === 0 ? '무료배송' : shippingFee != null ? `배송비 ${shippingFee}원` : delivery || null;
  const rawUrl = it.sellerLogBody?.link_url ?? it.linkUrl ?? '';
  let url = null;
  try {
    const u = new URL(rawUrl);
    if (u.origin === 'https://www.11st.co.kr' && /^\/products\/\d+$/.test(u.pathname)) url = `${u.origin}${u.pathname}`;
  } catch {}
  return { mall: 'elevenst', id: `elevenst:${it.id}`, name, url, checkedAt,
    price, currency: 'KRW', listPrice: num(it.selPrc), discountKind: num(it.maxDiscountInfo?.directDiscountAmount) ? 'item_discount' : null,
    cardOnly: false, pointBack: num((it.benefitText ?? []).find(b => b.type === '11pay')?.value),
    grams: p.grams, per100g: p.weightAmbiguous ? null : per100(price, p.grams), minQty: 1, minOrderGrams: p.grams,
    shipping, shippingFee, rating: num(it.satisfactionScore), reviews: num(reviewText), reviewsCapped,
    soldOut: observedBoolean(it.soldOut), seller: it.sellerNickName ?? null, ...p };
}

export function fromGmarket(it, checkedAt) {
  const p = parseName(it.title);
  const price = it.currentPriceKRW;
  return { mall: 'gmarket', id: `gmarket:${it.productId}`, name: it.title, url: it.url, checkedAt,
    price, listPrice: it.originalPriceKRW, discountKind: it.priceRequiresCoupon ? 'coupon' : null,
    priceRequiresCoupon: it.priceRequiresCoupon, cardOnly: false,
    grams: p.grams, per100g: p.weightAmbiguous ? null : per100(price, p.grams),
    minQty: 1, minOrderGrams: p.grams, shipping: it.shippingText, shippingFee: it.shippingFeeKRW,
    rating: it.rating, reviews: it.reviewCount ?? null, reviewsMissing: it.reviewCount == null,
    reviewsCapped: false, soldOut: it.soldOut, sponsored: it.sponsored,
    seller: it.seller, placement: it.placement, dataOrigin: it.dataOrigin, ...p };
}

export function fromCoupang(it, checkedAt) {
  const p = parseName(it.title);
  // Coupang's title suffix names the selected pack ("1kg, 2개" or "2개, 1kg").
  const weightFirst = /,\s*(\d+(?:\.\d+)?)\s*(kg|g)\s*,\s*(\d+)\s*(?:개(?:입)?|팩|봉)\s*$/i.exec(it.title);
  const countFirst = /,\s*(\d+)\s*(?:개(?:입)?|팩|봉)\s*,\s*(\d+(?:\.\d+)?)\s*(kg|g)\s*$/i.exec(it.title);
  let grams = p.grams, weightAmbiguous = p.weightAmbiguous;
  if (weightFirst || countFirst) {
    const amount = Number(weightFirst?.[1] ?? countFirst[2]);
    const unit = weightFirst?.[2] ?? countFirst[3];
    const count = Number(weightFirst?.[3] ?? countFirst[1]);
    grams = amount * (unit.toLowerCase() === 'kg' ? 1000 : 1) * count;
    weightAmbiguous = !(grams > 0 && Number.isFinite(grams) && count > 0 && count <= 100);
  } else if (/\d+\s*개/.test(it.title)) weightAmbiguous = true;
  return { ...p, mall: 'coupang', id: `coupang:${it.productId}:${it.itemId}:${it.vendorItemId}`,
    name: it.title, url: it.url, checkedAt, price: it.price, listPrice: it.listPrice,
    currency: it.currency, priceBasis: it.priceBasis, grams, weightAmbiguous,
    per100g: weightAmbiguous ? null : per100(it.price, grams), minQty: 1, minOrderGrams: grams,
    shipping: it.freeShipping === true ? '무료배송' : null, shippingFee: it.freeShipping === true ? 0 : null,
    rating: it.rating, reviews: null, reviewsCapped: false, reviewsMissing: true,
    partnerMetadata: { reviewCount: it.reviewCount ?? null },
    soldOut: it.soldOut, via: 'partners_web_search', sourceScope: 'partners_web_catalog_first_page' };
}

export function fromSsg(it, checkedAt) {
  const name = it.itemNm ?? '';
  const p = parseName(name);
  const priceInfo = it.priceInfo ?? {};
  const price = num(it.displayPrc) ?? num(priceInfo.raw?.displayPrc) ?? num(priceInfo.summary?.priceTxt);
  const grams = p.grams ?? parseName(it.sellCapaUnitNmWithUnitCapa).grams;
  const minQty = Math.max(1, num(it.minOnetOrdPsblQty) ?? num(it.mltSellQty) ?? 1);
  const shippingLines = (it.shppcstInfo ?? []).map(x => String(x.dispTxt ?? x.infoTxt ?? '').trim()).filter(Boolean);
  const feeMatch = shippingLines.map(s => s.match(/배송비\s*([\d,]+)\s*원/)).find(Boolean);
  const shippingFee = shippingLines.some(s => /^무료배송$/.test(s)) ? 0 : feeMatch ? num(feeMatch[1]) : null;
  const rawUrl = it.itemLnkd ?? it.cartItemLnkd ?? '';
  let url = null;
  try {
    const u = new URL(rawUrl, 'https://www.ssg.com');
    if (u.origin === 'https://www.ssg.com' && ['/item/itemView.ssg', '/item/dealItemView.ssg'].includes(u.pathname)) url = u.href;
  } catch {}
  const listPriceCandidate = num(priceInfo.raw?.firstPrc) ?? num(priceInfo.summary?.strikeOutPrcTxt);
  const listPrice = listPriceCandidate > 0 ? listPriceCandidate : null;
  return { mall: 'ssg', id: 'ssg:' + it.itemId, name, url, checkedAt,
    price, currency: 'KRW', listPrice, discountKind: num(priceInfo.raw?.discountRate) > 0 ? 'item_discount' : null, cardOnly: false,
    memberBenefit: num(Object.keys(it).filter(k => /^benefitGrp/.test(k)).flatMap(k => it[k] ?? []).find(b => b.type === 'membership_benefit')?.txt),
    grams, per100g: p.weightAmbiguous ? null : per100(price, grams), minQty, minOrderGrams: grams ? grams * minQty : null,
    shipping: shippingLines.join(' · ') || null, shippingFee, rating: num(it.recompPoint),
    reviews: num(it.recomRegCnt), reviewsCapped: false,
    soldOut: anyObserved([observedBoolean(it.soldOutYn), observedBoolean(it.stoppedSellingYn), num(it.usablInvQty) == null ? null : num(it.usablInvQty) === 0]),
    seller: it.brandNm || null, ...p, grams };
}

async function getText(url, fetchImpl = fetch) {
  const res = await fetchImpl(url, { headers: { 'user-agent': UA, accept: 'text/html' } });
  if (res.status !== 200) { const e = new Error(`HTTP_${res.status}`); e.code = `HTTP_${res.status}`; throw e; }
  return res.text();
}
// One offer per purchasable option; price is the option's base price (item discount, no coupon or first-order price).
export function kurlyOptions(html, base) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  const product = m ? JSON.parse(m[1]).props?.pageProps?.product : null;
  const deals = (product?.dealProducts ?? []).filter(d => !d.isSoldOut);
  if (!deals.length) return [base];
  const reviews = Number(product.reviewCount) || base.reviews;
  return deals.map(d => {
    const p = parseName(d.name);
    const price = Number(d.discountedPrice) || Number(d.basePrice) || null;
    return { ...base, id: `kurly:${base.id.split(':')[1]}:${d.no}`, name: d.name, price, listPrice: Number(d.retailPrice) || null, grams: p.grams,
      per100g: p.weightAmbiguous ? null : per100(price, p.grams), minOrderGrams: p.grams, multipleOptions: false, reviews, reviewsCapped: false,
      unitPriceText: d.unitPriceText ?? null, origin: p.origin !== 'unknown' ? p.origin : base.origin, storage: p.storage !== 'unknown' ? p.storage : base.storage };
  });
}

export async function collectMarketplaceReference(keyword, { search, read, fetchImpl = fetch, limit = 3, sleepImpl = sleep } = {}) {
  if (!search || !read) {
    const danawa = await import('./danawa-prices.mjs');
    search ??= q => danawa.searchDanawa(q, { fetchImpl });
    read ??= pcode => danawa.fetchDanawaOffers(pcode, { fetchImpl });
  }
  const catalog = await search(keyword);
  const selected = catalog.results.filter(x => matchesKeyword(x.name, keyword) && parseName(x.name).grams &&
    !PROCESSED.test(x.name) && !multiCut(x.name, keyword)).slice(0, Math.min(5, Math.max(1, limit)));
  const candidates = []; const products = [];
  for (const item of selected) {
    if (products.length) await sleepImpl(1000);
    try {
      const result = await read(item.pcode);
      products.push({ pcode: item.pcode, status: 'ok', offers: result.offers.length });
      const catalogGrams = parseName(result.name).grams ?? parseName(item.name).grams;
      for (const offer of result.offers.filter(x => MARKETPLACE_NAMES.has(x.mall))) {
        const listingGrams = parseName(offer.title).grams;
        candidates.push({ marketplace: offer.mall, source: 'danawa_mall_list', pcode: item.pcode,
          catalogName: result.name, listingTitle: offer.title, catalogUrl: result.pageUrl,
          price: offer.price, shipping: offer.shipping, total: offer.total, couponRequired: offer.couponRequired,
          catalogGrams, listingGrams, sizeMatches: catalogGrams != null && listingGrams === catalogGrams,
          sameProductVerified: false, eligibleForPicks: false, checkedAt: result.checkedAt });
      }
    } catch (error) { products.push({ pcode: item.pcode, status: 'error', error: error.code ?? 'FAILED' });
      if (['ACCESS_BLOCKED', 'RATE_LIMITED'].includes(error.code)) break; }
  }
  return { source: 'danawa', scope: 'catalog_marketplace_candidates', searchResults: catalog.results.length,
    products, candidates, marketplaceCounts: Object.fromEntries([...MARKETPLACE_NAMES].map(name => [name, candidates.filter(x => x.marketplace === name).length])),
    note: '다나와 카탈로그의 판매처 후보. 판매처 상품 동일성과 최종 결제가는 확인되지 않았으며 추천·최저가 계산에 사용하지 않음.' };
}

// 쿠팡 prices through Danawa: for catalog products whose name matches the keyword and states a weight, the cheapest
// 쿠팡 offer on the product's mall list. The offer is the catalog product as sold on 쿠팡 (Danawa's product matching),
// priced like the other malls (displayed price per 100 g, shipping kept apart). Danawa has no 쿠팡 review counts, so
// these offers never pass the review threshold for picks; they appear as the 쿠팡 price in each segment.
export async function collectCoupangViaDanawa(keyword, { search, read, fetchImpl = fetch, limit = 8, sleepImpl = sleep } = {}) {
  if (!search || !read) {
    const danawa = await import('./danawa-prices.mjs');
    search ??= q => danawa.searchDanawa(q, { fetchImpl });
    read ??= pcode => danawa.fetchDanawaOffers(pcode, { fetchImpl });
  }
  // Few fresh-meat catalogs list a 쿠팡 offer (냉동삼겹살 2026-09-27: 2 of 20), and each origin/cut query surfaces
  // different catalogs, so the keyword is searched with origin prefixes (and 대패 for 삼겹살) and catalogs deduplicated.
  const pork = /삼겹|목살|목심|항정|앞다리|뒷다리|갈비|등심|안심/.test(keyword);
  const queries = [...new Set([keyword, `${pork ? '한돈' : '국내산'} ${keyword}`, `수입 ${keyword}`,
    ...(/삼겹살/.test(keyword) && !/대패/.test(keyword) ? [keyword.replace('삼겹살', ' 대패삼겹살').trim()] : [])])];
  const seenPcode = new Set(), pool = [];
  let searchResults = 0;
  for (const [i, q] of queries.entries()) {
    if (i) await sleepImpl(1000);
    const catalog = await search(q);
    searchResults += catalog.results.length;
    for (const x of catalog.results) if (!seenPcode.has(String(x.pcode)) && matchesKeyword(x.name, keyword) && parseName(x.name).grams && !parseName(x.name).weightAmbiguous &&
      !PROCESSED.test(x.name) && !multiCut(x.name, keyword)) { seenPcode.add(String(x.pcode)); pool.push(x); }
  }
  const catalog = { results: { length: searchResults } };
  const selected = pool.slice(0, limit);
  const offers = [], products = [];
  for (const item of selected) {
    if (products.length) await sleepImpl(1000);
    try {
      const result = await read(item.pcode);
      const coupang = result.offers.filter(o => /쿠팡/.test(o.mall) && Number.isFinite(o.price)).sort((a, b) => a.price - b.price);
      products.push({ pcode: String(item.pcode), status: 'ok', offers: result.offers.length, coupangOffers: coupang.length });
      if (!coupang.length) continue;
      const o = coupang[0], p = parseName(result.name || item.name);
      offers.push({ mall: 'coupang', id: `coupang-danawa:${item.pcode}`, name: result.name || item.name, url: result.pageUrl, checkedAt: result.checkedAt,
        price: o.price, listPrice: null, discountKind: null, cardOnly: false, grams: p.grams, per100g: per100(o.price, p.grams), minQty: 1, minOrderGrams: p.grams,
        shipping: o.shipping === 0 ? '무료배송' : o.shipping == null ? (o.shippingText || null) : `배송비 ${o.shipping}원`, rating: null, reviews: null, reviewsCapped: false,
        soldOut: false, sponsored: false, priceRequiresCoupon: o.couponRequired === true, seller: o.mall, via: 'danawa', danawaPcode: String(item.pcode), listingTitle: o.title || null,
        ...p });
    } catch (error) {
      products.push({ pcode: String(item.pcode), status: 'error', error: error.code ?? 'FAILED' });
      if (['ACCESS_BLOCKED', 'RATE_LIMITED'].includes(error.code)) break;
    }
  }
  return { source: 'danawa', queries, searchResults: catalog.results.length, candidates: pool.length, selected: selected.length, products, offers };
}

export async function collect(keyword, { fetchImpl = fetch, perSite = 60, kurlyDetails = 12,
  includeGmarket = null, gmarketRead = readGmarketProducts,
  includeCoupangPartners = false, coupangPartnersRead = readCoupangProducts,
  includeMarketReference = false, marketSearch, marketRead, marketCatalogLimit = 3,
  includeCoupangDanawa = false, coupangSearch, coupangRead, coupangCatalogLimit = 8, sleepImpl = sleep, onlySources = null, filterMode = null } = {}) {
  const effectiveFilter = filterMode ?? (onlySources === null ? 'grocery' : 'catalog');
  if (!['grocery', 'catalog'].includes(effectiveFilter)) throw Object.assign(new Error('FILTER_MODE_INVALID'), { code: 'FILTER_MODE_INVALID' });
  if (onlySources !== null) {
    const allowedSources = new Set(['homeplus', 'lotteon', 'ssg', 'elevenst', 'kurly']);
    if (!Array.isArray(onlySources) || !onlySources.length || onlySources.length > allowedSources.size ||
        onlySources.some(source => !allowedSources.has(source)) || includeGmarket === true || includeCoupangPartners === true || includeMarketReference || includeCoupangDanawa)
      throw Object.assign(new Error('SOURCE_SCOPE_INVALID'), { code: 'SOURCE_SCOPE_INVALID' });
    const hostRoots = {
      homeplus: ['mfront.homeplus.co.kr'], lotteon: ['lotteon.com'], ssg: ['search.ssg.com'],
      elevenst: ['apis.11st.co.kr'], kurly: ['api.kurly.com', 'www.kurly.com'],
    };
    const permittedHosts = new Set(onlySources.flatMap(source => hostRoots[source]));
    const baseFetch = fetchImpl;
    fetchImpl = async (input, init = {}) => {
      let url;
      try { url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); }
      catch { throw Object.assign(new Error('SOURCE_URL_INVALID'), { code: 'SOURCE_URL_INVALID' }); }
      if (![...permittedHosts].some(host => url.hostname === host || url.hostname.endsWith('.' + host)))
        throw Object.assign(new Error('SOURCE_NOT_SELECTED'), { code: 'SOURCE_NOT_SELECTED' });
      const headers = new Headers(init.headers ?? {});
      if (headers.has('cookie') || headers.has('authorization'))
        throw Object.assign(new Error('SOURCE_CREDENTIALS_NOT_ALLOWED'), { code: 'SOURCE_CREDENTIALS_NOT_ALLOWED' });
      return baseFetch(url, { ...init, headers, credentials: 'omit', redirect: 'manual', cache: 'no-store' });
    };
    includeGmarket = false;
    includeCoupangPartners = false;
    includeMarketReference = false;
    includeCoupangDanawa = false;
  }
  const q = encodeURIComponent(keyword), checkedAt = new Date().toISOString(), offers = [], sites = {};
  const useGmarket = includeGmarket ?? (fetchImpl === fetch && gmarketRead === readGmarketProducts &&
    shoppingSessionStatus('gmarket-search').usableForAttempt);
  const useCoupangPartners = includeCoupangPartners === true;
  if (onlySources === null || onlySources.includes('homeplus')) try {
    const j = await getJson(`https://mfront.homeplus.co.kr/totalsearch/total/search/item.json?inputKeyword=${q}&page=1&perPage=${perSite}&searchKeyword=${q}&searchType=NONE&sort=RANK`,
      { referer: `https://mfront.homeplus.co.kr/search?keyword=${q}` }, fetchImpl);
    const list = j.data?.dataList ?? []; sites.homeplus = { listed: list.length, total: j.data?.totalCount ?? null };
    offers.push(...list.map(x => fromHomeplus(x, checkedAt)));
  } catch (e) { sites.homeplus = { error: e.code || 'FAILED' }; }
  if (onlySources === null || onlySources.includes('lotteon')) {
  await sleepImpl(1500);
  try {
    const j = await getJson(`https://www.lotteon.com/csearch/search/search?&u2=0&u3=${perSite}&u16=ranking.desc&u37=true&u39=4&render=qapi&platform=pc&collection_id=9&q=${q}`, { referer: 'https://www.lotteon.com/' }, fetchImpl);
    const list = j.itemList ?? []; sites.lotteon = { listed: list.length, total: j.total ?? null };
    offers.push(...list.map(x => fromLotteon(x, checkedAt)));
  } catch (e) { sites.lotteon = { error: e.code || 'FAILED' }; }
  }
  if (onlySources === null || onlySources.includes('ssg')) {
  await sleepImpl(1500);
  try {
    const body = { siteNo: '6005', query: keyword, page: 1, target: 'pc_item', aplTgtMediaCd: '10',
      count: String(Math.max(1, Math.min(40, Number(perSite) || 40))), directYn: 'N', sort: 'prcasc', recomSortYn: 'recom_prcasc' };
    const referer = 'https://www.ssg.com/search.ssg?query=' + q + '&page=1&sort=prcasc&recomSortYn=recom_prcasc';
    const j = await postJson('https://search.ssg.com/api/item/all', body,
      { origin: 'https://www.ssg.com', referer }, fetchImpl);
    const units = j.data?.dataList ?? [];
    const listUnit = units.find(x => x.unitType === 'ITEM_UNIT_LIST');
    const pageUnit = units.find(x => x.unitType === 'PAGING_UNIT');
    if (j.res_code !== '200' || !Array.isArray(listUnit?.dataList)) { const e = new Error('SCHEMA'); e.code = 'SCHEMA'; throw e; }
    const list = listUnit.dataList.slice(0, perSite);
    sites.ssg = { listed: list.length, total: num(pageUnit?.itemCount), page: num(pageUnit?.activePage),
      sort: body.sort, browserUsed: false, authenticated: false };
    offers.push(...list.map(x => fromSsg(x, checkedAt)));
  } catch (e) { sites.ssg = { error: e.code || 'FAILED', browserUsed: false, authenticated: false }; }
  }
  if (onlySources === null || onlySources.includes('elevenst')) {
  await sleepImpl(1500);
  try {
    const searchUrl = new URL('https://apis.11st.co.kr/search/api/tab');
    searchUrl.searchParams.set('kwd', keyword);
    searchUrl.searchParams.set('tabId', 'TOTAL_SEARCH');
    searchUrl.searchParams.set('_', String(Date.now()));
    const referer = `https://search.11st.co.kr/pc/total-search?kwd=${encodeURIComponent(keyword)}&tabId=TOTAL_SEARCH`;
    const j = await getJson(searchUrl, { origin: 'https://search.11st.co.kr', referer }, fetchImpl);
    if (!Array.isArray(j.data)) throw Object.assign(new Error('SCHEMA'), { code: 'SCHEMA' });
    const seen = new Set();
    const list = (j.data ?? []).filter(g => g.groupName === 'list').flatMap(g => g.items ?? []).filter(it => {
      const id = String(it.id ?? '');
      if (!id || seen.has(id) || it.adProduct || effectiveFilter === 'grocery' && it.soldOut) return false;
      seen.add(id);
      return true;
    });
    const mapped = list.map(x => fromElevenst(x, checkedAt)).filter(x => x.url).slice(0, perSite);
    sites.elevenst = { listed: mapped.length, total: j.totalCount ?? j.commonTotalCount ?? null, groups: j.data?.length ?? 0, browserUsed: false, authenticated: false };
    offers.push(...mapped);
  } catch (e) { sites.elevenst = { error: e.code || 'FAILED', browserUsed: false, authenticated: false }; }
  }
  if (onlySources === null || onlySources.includes('kurly')) {
  await sleepImpl(1500);
  try {
    const j = await getJson(`https://api.kurly.com/search/v4/sites/market/normal-search?keyword=${q}&sortType=4&page=1&isFirstOrder=true`, { referer: 'https://www.kurly.com/' }, fetchImpl);
    const list = (j.data?.listSections ?? []).flatMap(s => s.data?.items ?? []).slice(0, perSite); sites.kurly = { listed: list.length, detailed: 0 };
    // Option listings ("600g/1kg") and capped review counts ("9,999+") are resolved on the product page
    // (__NEXT_DATA__ dealProducts: one price per option), for the first few relevant ones, 2 s apart.
    let details = 0;
    for (const x of list) {
      const base = fromKurly(x, checkedAt);
      const needsPage = (base.multipleOptions || base.reviewsCapped) &&
        (effectiveFilter === 'catalog' || base.name.includes(keyword) && !PROCESSED.test(base.name)) && details < kurlyDetails;
      if (!needsPage) { offers.push(base); continue; }
      details++; await sleepImpl(2000);
      try { offers.push(...kurlyOptions(await getText(`https://www.kurly.com/goods/${x.no}`, fetchImpl), base)); } catch { offers.push(base); }
    }
    sites.kurly.detailed = details;
  } catch (e) { sites.kurly = { error: e.code || 'FAILED' }; }
  }
  if (useGmarket) {
    try {
      const result = await gmarketRead({ query: keyword, count: Math.min(40, perSite) });
      if (!result.state?.credential_propagated && gmarketRead === readGmarketProducts) throw Object.assign(Error(), { code: 'SESSION_NOT_PROPAGATED' });
      sites.gmarket = { listed: result.productCount, page: result.pagination?.page ?? 1,
        couponApplied: result.products.filter(p => p.priceRequiresCoupon).length,
        credentialPropagated: result.state?.credential_propagated === true,
        liveReplay: result.state?.live_replay === true, browserUsed: result.browserUsed === true };
      offers.push(...result.products.map(x => fromGmarket(x, checkedAt)));
    } catch (e) { sites.gmarket = { error: e.code || 'FAILED', browserUsed: false }; }
  }
  if (useCoupangPartners) {
    try {
      const result = await coupangPartnersRead({ query: keyword, limit: Math.min(36, perSite) });
      sites.coupang = { via: 'partners_web_search', listed: result.products.length, total: result.total,
        credentialPropagated: result.receipt.credentialPropagated === true,
        liveReplay: result.products.length > 0, browserUsed: false, receipt: result.receipt };
      offers.push(...result.products.map(product => fromCoupang(product, result.receipt.checkedAt)));
    } catch (error) { sites.coupang = { via: 'partners_web_search', error: error.code ?? 'FAILED', browserUsed: false }; }
  }
  if (includeCoupangDanawa && !(sites.coupang?.listed > 0)) {
    try {
      const c = await collectCoupangViaDanawa(keyword, { search: coupangSearch, read: coupangRead, fetchImpl, limit: coupangCatalogLimit, sleepImpl });
      offers.push(...c.offers);
      sites.coupang = { via: 'danawa', primaryAttempt: sites.coupang ?? null, searchResults: c.searchResults, catalogProducts: c.selected, withCoupangOffer: c.offers.length, products: c.products };
    } catch (error) { sites.coupang = { via: 'danawa', primaryAttempt: sites.coupang ?? null, error: error.code ?? 'FAILED' }; }
  }
  const relevant = effectiveFilter === 'catalog' ? offers : offers.filter(o => matchesKeyword(o.name, keyword) && !o.soldOut && !PROCESSED.test(o.name) && !multiCut(o.name, keyword));
  let marketReference = null;
  if (includeMarketReference) {
    try { marketReference = await collectMarketplaceReference(keyword, { search: marketSearch, read: marketRead,
      fetchImpl, limit: marketCatalogLimit, sleepImpl }); }
    catch (error) { marketReference = { source: 'danawa', scope: 'catalog_marketplace_candidates', error: error.code ?? 'FAILED', candidates: [] }; }
  }
  const excluded = useGmarket && sites.gmarket?.listed > 0 ? EXCLUDED.filter(x => x.site !== 'G마켓') :
    useGmarket ? EXCLUDED.map(x => x.site === 'G마켓' ? { ...x, reason: `보호 세션 직접 수집 실패: ${sites.gmarket?.error ?? 'UNKNOWN'}` } : x) : EXCLUDED;
  // With 쿠팡 priced through Danawa, 쿠팡 is compared (prices only), so the exclusion becomes a scope note.
  const coupangCompared = relevant.some(o => o.mall === 'coupang');
  const scoped = excluded.map(x => x.site === '쿠팡 일반 쇼핑몰' && coupangCompared
    ? sites.coupang?.via === 'partners_web_search'
      ? { ...x, site: '쿠팡 일반 쇼핑몰 전체 검색', reason: '파트너스 웹 검색 첫 페이지의 표시가격·평점을 수집했다. reviewCount는 별도 파트너 메타데이터로 보존하며 소비자 리뷰 수로 사용하지 않는다. www.coupang.com 전체 검색과 리뷰 본문은 수집 범위가 아니다' }
      : { ...x, site: '쿠팡 리뷰', reason: '다나와 카탈로그의 쿠팡 판매가만 비교. 리뷰 수·평점은 없음' } : x);
  return { keyword, checkedAt, filterMode: effectiveFilter, sites, offers: relevant, marketReference, excluded: scoped };
}

// Segments a buyer actually compares; within each: cheapest per 100 g among well-reviewed offers, and best reviewed.
export const SEGMENTS = [
  { id: 'domestic_chilled', label: '국내산 냉장', test: o => o.origin === 'domestic' && o.storage !== 'frozen' && o.cut !== 'thin_sliced' },
  { id: 'domestic_frozen', label: '국내산 냉동', test: o => o.origin === 'domestic' && o.storage === 'frozen' && o.cut !== 'thin_sliced' },
  { id: 'imported', label: '수입 (냉장·냉동)', test: o => o.origin === 'imported' && o.cut !== 'thin_sliced' },
  { id: 'thin_sliced', label: '대패삼겹살', test: o => o.cut === 'thin_sliced' },
];
export function summarize(offers, { minReviews = 30, minRating = 4.5 } = {}) {
  const eligible = offers.filter(o => !o.sponsored && !o.priceRequiresCoupon);
  const priced = eligible.filter(o => o.per100g && o.per100g >= 300 && o.per100g <= 20000);
  const trusted = o => o.reviews >= minReviews && (o.rating == null || o.rating >= minRating);
  const bySeg = SEGMENTS.map(s => {
    const all = priced.filter(s.test).sort((a, b) => a.per100g - b.per100g);
    const good = all.filter(trusted);
    const malls = [...new Set(all.map(o => o.mall))];
    const mallBest = Object.fromEntries(malls.map(m => [m, all.filter(o => o.mall === m && trusted(o))[0] ?? all.find(o => o.mall === m)]));
    return { id: s.id, label: s.label, offers: all.length, cheapestTrusted: good[0] ?? null, cheapestAny: all[0] ?? null,
      bestReviewed: [...good].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.reviews - a.reviews)[0] ?? null, mallBest,
      medianPer100g: all.length ? all[Math.floor(all.length / 2)].per100g : null };
  });
  return { priced: priced.length, unpriced: eligible.length - priced.length,
    sponsoredExcluded: offers.filter(o => o.sponsored).length,
    couponPriceExcluded: offers.filter(o => o.priceRequiresCoupon).length,
    criteria: { minReviews, minRating }, segments: bySeg };
}

export function briefFrom(r, s, { now = Date.now() } = {}) {
  const hash = createHash('sha256').update(`grocery:${r.keyword}:${kstDate(now)}`).digest('hex').slice(0, 8);
  const brief = seg => seg.cheapestTrusted && `${seg.label}: ${SOURCES[seg.cheapestTrusted.mall].label} ${seg.cheapestTrusted.name} ${seg.cheapestTrusted.per100g}원/100g (리뷰 ${seg.cheapestTrusted.reviews}${seg.cheapestTrusted.reviewsCapped ? '+' : ''}${seg.cheapestTrusted.rating ? `, ${seg.cheapestTrusted.rating}점` : ''})`;
  const compared = Object.keys(SOURCES).filter(mall => r.offers.some(o => o.mall === mall && !o.sponsored && !o.priceRequiresCoupon && o.per100g !== null));
  const comparedNames = compared.map(mall => SOURCES[mall].label).join('·') || '확인된 판매처';
  const segmentNames = s.segments.filter(seg => seg.cheapestTrusted || seg.bestReviewed).map(seg => seg.label).join('/') || '확인된 구간';
  return {
    schemaVersion: 1, briefId: `auto-${kstDate(now)}-${hash}`, origin: `grocery-compare:${r.keyword}`, eventKind: 'grocery_compare', topicKey: `grocery_compare:${r.keyword}:${kstDate(now)}`,
    genre: 'deal_roundup', field: 'shopping',
    readerQuestion: `${r.keyword}, 어디서 사야 싸고 리뷰도 좋을까? ${comparedNames} 100g당 표시가 비교`,
    headline: `${r.keyword} 어디서 살까? 100g당 가격·리뷰로 비교한 ${comparedNames}`,
    status: 'awaiting_draft', createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 36 * 3600e3).toISOString(),
    draftingNotes: [
      `카테고리 '쇼핑 가이드'(11), 장르 deal_roundup. 첫 문단에 실제 추천이 나온 구간(${segmentNames})과 100g당 가격을 바로 쓴다.`,
      '비교 단위는 상품 표시가의 100g당 가격이며 배송비는 별도다. 원산지·보관 방식·부위가 다르면 차이를 명시하고, 부위·용도(구이/수육/대패)를 같이 적는다.',
      '각 상품 페이지를 로그인 없이 다시 열어 판매가·중량·배송비·최소 구매 수량·리뷰 수·평점을 저장하고, 저장한 값만 쓴다. 현재 비교값은 표시가 기준이다. 배송비 포함 총액은 상품 페이지에서 조건을 재확인한 뒤 별도 계산하고, 카드·쿠폰·첫구매·회원가를 제외한다.',
      '홈플러스 100G 단위 상품은 최소 구매 수량(예: 6개=600g)이 있다. 최소 주문 기준 총액과 무료배송 조건(예: 4만원 이상)을 같이 쓴다.',
      '컬리 리뷰 수는 "9,999+"처럼 상한 표시가 있고 평점은 목록에 없다. 평점이 없는 곳은 리뷰 수만 쓴다. 옵션이 여러 개인 컬리 상품은 옵션별 가격을 상품 페이지에서 확인한 뒤 100g당 가격을 계산한다.',
      `비교하지 않은 곳: ${r.excluded.map(x => `${x.site}(${x.reason})`).join(', ')}. 글에는 실제 비교한 ${comparedNames}만 범위로 밝히고, 빠진 곳이 더 비싸다/싸다고 쓰지 않는다.`,
      '다나와의 G마켓·옥션 판매처 후보는 상품 동일성과 최종 결제가 확인되지 않은 별도 참고자료다. 비교 추천·최저가 주장에 섞지 않는다.',
      '리뷰 내용 인용은 하지 않는다. 리뷰 수와 평점만 쓴다.',
      'deal_roundup의 공식 자료: KAMIS(www.kamis.or.kr) 돼지고기 삼겹살(국산 냉장) 100g 소매가격 평균은 국내산 냉장 상품에만 조건을 맞춘 참고값으로 쓰고 냉동·수입 상품의 전국 평균으로 부르지 않는다. 국내산 표시 확인 방법으로 축산물이력제(www.mtrace.go.kr) 이력번호 조회를 안내한다.',
      '제휴 링크 없음. 상품 페이지 원문 링크만.',
      ...(r.offers.some(o => o.mall === 'coupang' && o.via === 'partners_web_search') ? ['쿠팡은 현재 계정의 파트너스 웹 검색 목록에서 표시가격·평점을 읽었다. 파트너 메타데이터의 reviewCount는 소비자 리뷰 수로 검증되지 않아 리뷰 수에 따른 추천 판단에서 제외한다. 일반 쇼핑몰 전체 검색 결과나 리뷰 본문 수집으로 설명하지 않는다. 상품 옵션·배송·회원 조건은 최종 비교 전에 다시 확인한다.'] : []),
      ...(r.offers.some(o => o.mall === 'coupang' && o.via === 'danawa') ? [`쿠팡은 다나와 상품 페이지의 쿠팡 판매가로만 비교한다(쿠팡 직접 조회 불가, 리뷰 수 없음): ${s.segments.filter(seg => seg.mallBest.coupang)
        .map(seg => `${seg.label} ${seg.mallBest.coupang.name} ${seg.mallBest.coupang.per100g}원/100g${seg.cheapestTrusted ? ` vs 추천 ${SOURCES[seg.cheapestTrusted.mall].label} ${seg.cheapestTrusted.per100g}원` : ''}`).join('; ')}. 출처는 다나와 페이지로 밝히고 링크도 다나와 페이지로 건다.`] : []),
    ],
    mustVerify: s.segments.flatMap(seg => [seg.cheapestTrusted, seg.bestReviewed].filter(Boolean)).map(o => `${o.url} — 가격·중량·배송비·리뷰 재확인`),
    evidence: { urls: [...new Set(s.segments.flatMap(seg => [seg.cheapestTrusted, seg.bestReviewed, ...Object.values(seg.mallBest)].filter(Boolean).map(o => o.url)))],
      data: { keyword: r.keyword, checkedAt: r.checkedAt, sites: r.sites, sources: SOURCES, excluded: r.excluded,
        marketReference: r.marketReference, summary: s,
        picks: s.segments.map(brief).filter(Boolean) } },
    candidateLedgerIds: [],
  };
}

async function main() {
  const args = process.argv.slice(2);
  const [cmd, keyword] = args.filter(a => !a.startsWith('--'));
  if (!['collect', 'brief'].includes(cmd) || !keyword) { console.log(JSON.stringify({ ok: false, code: 'USAGE collect|brief <keyword>' })); process.exitCode = 2; return; }
  const gmarketFlags = args;
  if (gmarketFlags.includes('--gmarket') && gmarketFlags.includes('--no-gmarket')) { console.log(JSON.stringify({ ok: false, code: 'GMARKET_FLAGS_CONFLICT' })); process.exitCode = 2; return; }
  if (gmarketFlags.includes('--coupang-partners') && gmarketFlags.includes('--no-coupang-partners')) {
    console.log(JSON.stringify({ ok: false, code: 'COUPANG_PARTNERS_FLAGS_CONFLICT' })); process.exitCode = 2; return;
  }
  const includeGmarket = gmarketFlags.includes('--gmarket') ||
    (!gmarketFlags.includes('--no-gmarket') && shoppingSessionStatus('gmarket-search').usableForAttempt);
  const r = await collect(keyword, { includeGmarket,
    includeCoupangPartners: gmarketFlags.includes('--coupang-partners'),
    includeMarketReference: process.argv.includes('--market-reference'), includeCoupangDanawa: !process.argv.includes('--no-coupang-danawa'),
    coupangCatalogLimit: Number(process.argv.find(a => a.startsWith('--coupang-limit='))?.slice(16)) || 8 });
  const s = summarize(r.offers);
  const write = process.argv.includes('--write');
  let dir = null;
  if (write) {
    dir = path.join(RUNS, `grocery-compare-${r.checkedAt.replace(/[-:]/g, '').slice(0, 15)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'grocery-compare.json'), JSON.stringify({ schemaVersion: 1, kind: 'grocery-compare', ...r, summary: s }, null, 2) + '\n');
  }
  if (cmd === 'collect') {
    const pick = o => o && { mall: o.mall, name: o.name.slice(0, 40), per100g: o.per100g, reviews: o.reviews, rating: o.rating };
    const marketReference = r.marketReference && { source: r.marketReference.source, scope: r.marketReference.scope,
      error: r.marketReference.error ?? null, searchResults: r.marketReference.searchResults ?? null,
      products: r.marketReference.products ?? [], marketplaceCounts: r.marketReference.marketplaceCounts ?? {},
      candidates: r.marketReference.candidates?.length ?? 0, eligibleForPicks: 0 };
    console.log(JSON.stringify({ ok: true, dir, sites: r.sites, offers: r.offers.length, priced: s.priced, marketReference,
      segments: s.segments.map(x => ({ seg: x.label, n: x.offers, median: x.medianPer100g, cheapestTrusted: pick(x.cheapestTrusted), bestReviewed: pick(x.bestReviewed) })) }, null, 1));
    return;
  }
  const b = briefFrom(r, s);
  if (write) {
    const bdir = path.join(CODEX_ROOT, kstDate(), 'auto-briefs', `grocery-${createHash('sha256').update(keyword).digest('hex').slice(0, 6)}`);
    mkdirSync(bdir, { recursive: true });
    writeFileSync(path.join(bdir, 'article-brief.json'), JSON.stringify(b, null, 2) + '\n');
    console.log(JSON.stringify({ ok: true, dir, briefDir: bdir, headline: b.headline, picks: b.evidence.data.picks }));
    return;
  }
  console.log(JSON.stringify(b, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.log(JSON.stringify({ ok: false, code: e.code || e.message })); process.exitCode = 1; });
