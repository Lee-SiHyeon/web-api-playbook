// 다나와 가격비교: search -> product page -> the product page's own per-mall price list XHR.
// Observed 2026-09-24 with anonymous plain HTTP (no cookies, no login):
//   GET  https://search.danawa.com/dsearch.php?query=..  (ld+json ItemList + hidden min_price_<pcode>)
//   GET  https://prod.danawa.com/info/?pcode=..          (oGlobalSetting / oPriceCompareSetting)
//   POST https://prod.danawa.com/info/ajax/getAllPriceCompareMallList.ajax.php  (form = aParamaterList + oPriceCompareSetting,
//        exactly what common.min.js sends) -> HTML rows: .diff_item[data-linkProduct], img alt = mall, em.prc_c, span.ship
// Mall item pages (G마켓 etc.) answer bots with 403; nothing here opens them. Prices are Danawa's listing snapshot.
import { createHash } from 'node:crypto';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36';
// 2026-10-16: dsearch.php now answers 307 → /?query=… (a Next.js page) for most requests, which the old client counted
// as HTTP_STATUS (21/21 Toss comparisons on the box). The new page is requested directly; dsearch.php is gone from use.
const SEARCH = 'https://search.danawa.com/';
const PRODUCT = 'https://prod.danawa.com/info/';
const MALL_LIST = 'https://prod.danawa.com/info/ajax/getAllPriceCompareMallList.ajax.php';
const MAX_BYTES = 3 * 1024 * 1024;

const fail = (code, details = {}) => Object.assign(new Error(code), { code, ...details });
const won = value => { const n = Number(String(value ?? '').replace(/[^\d]/g, '')); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const text = html => String(html ?? '').replace(/<\/?(b|strong|em)>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const sha = s => createHash('sha256').update(s).digest('hex');

// One row per priced option. A search item (li#productItem<pcode>) lists its options as li#productInfoDetail_<pcode>,
// each with its own pcode, price (p.price_sect strong) and label (p.memory_sect .text: "1개", "2개", "75ml" ...).
// The page's ld+json ItemList, when present, carries cleaner names with the size ("… EDT (75ml)").
export function parseDanawaSearch(html) {
  const src = String(html);
  const ldName = new Map();
  for (const m of src.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let data; try { data = JSON.parse(m[1]); } catch { continue; }
    if (data?.['@type'] !== 'ItemList' || !Array.isArray(data.itemListElement)) continue;
    for (const el of data.itemListElement) {
      const pcode = /[?&]pcode=(\d+)/.exec(String(el?.url ?? ''))?.[1];
      if (pcode && typeof el.name === 'string') ldName.set(pcode, el.name.trim());
    }
  }
  const out = [];
  const items = [...src.matchAll(/id="productItem(\d+)"/g)];
  if (!items.length) return parseDanawaSearchNext(src, ldName);
  items.forEach((m, i) => {
    const base = m[1];
    const block = src.slice(m.index, items[i + 1]?.index ?? src.length);
    const name = ldName.get(base) ?? text(/<p class="prod_name">([\s\S]*?)<\/p>/.exec(block)?.[1]);
    if (!name) return;
    const options = [...block.matchAll(/<li id="productInfoDetail_(\d+)"[\s\S]*?(?=<li id="productInfoDetail_|<\/ul>)/g)];
    if (!options.length) {
      const minPrice = Number(new RegExp(`id="min_price_${base}"\\s*value="(\\d+)"`).exec(block)?.[1]) || null;
      out.push({ pcode: base, basePcode: base, name, label: null, url: `${PRODUCT}?pcode=${base}`, minPrice });
      return;
    }
    for (const [opt, pcode] of options) {
      const label = text(/<p class="memory_sect">[\s\S]*?<span class="text">([\s\S]*?)<\/span>/.exec(opt)?.[1]) || null;
      out.push({ pcode, basePcode: base, name, label, url: `${PRODUCT}?pcode=${pcode}`,
        minPrice: won(/<p class="price_sect">[\s\S]*?<strong>([\d,]+)<\/strong>/.exec(opt)?.[1]) });
    }
  });
  return out;
}

// The Next.js search page (2026-10-16) carries its result list in the React flight data (self.__next_f) as the
// dehydrated query's `products` array; options ("6개", "12개" …) are products[].bundleList with their own pcode/minPrice.
export function danawaFlightProducts(html) {
  let flight = '';
  for (const m of String(html).matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)) {
    try { flight += JSON.parse(`"${m[1]}"`); } catch { /* a malformed chunk only loses its own part */ }
  }
  const start = flight.indexOf('"products":[');
  if (start < 0) return [];
  let depth = 0, j = start + 11;
  for (; j < flight.length; j++) {
    const c = flight[j];
    if (c === '"') { j++; while (j < flight.length && flight[j] !== '"') { if (flight[j] === '\\') j++; j++; } continue; }
    if (c === '[') depth++;
    else if (c === ']' && --depth === 0) break;
  }
  try { const list = JSON.parse(flight.slice(start + 11, j + 1)); return Array.isArray(list) ? list : []; } catch { return []; }
}

export function parseDanawaSearchNext(html, ldName = new Map()) {
  const out = [];
  for (const p of danawaFlightProducts(html)) {
    const base = /^\d+$/.test(String(p?.productSeq ?? '')) ? String(p.productSeq) : null;
    const name = base ? ldName.get(base) ?? text(p.productName) : null;
    if (!name) continue;
    const bundles = Array.isArray(p.bundleList) ? p.bundleList.filter(b => /^\d+$/.test(String(b?.productSeq ?? ''))) : [];
    if (!bundles.length) {
      out.push({ pcode: base, basePcode: base, name, label: text(p.bundleName) || null, url: `${PRODUCT}?pcode=${base}`, minPrice: won(p.minPrice) });
      continue;
    }
    // The ld+json name carries the default option's count ("… 210g (24개)"); each option row has its own label.
    const optionName = name.replace(/\s*\(\d+\s*개\)\s*$/, '');
    for (const b of bundles) {
      out.push({ pcode: String(b.productSeq), basePcode: base, name: optionName, label: text(b.bundleName) || null,
        url: `${PRODUCT}?pcode=${b.productSeq}`, minPrice: won(b.minPrice) });
    }
  }
  return out;
}

// Pull `key: "value"` pairs out of the inline `var <name> = { ... };` object the page scripts use.
function inlineObject(html, name) {
  const m = new RegExp(`var ${name}\\s*=\\s*\\{([\\s\\S]*?)\\};`).exec(String(html));
  if (!m) return null;
  const obj = {};
  for (const p of m[1].matchAll(/(\w+)\s*:\s*"((?:[^"\\]|\\.)*)"/g)) obj[p[1]] = JSON.parse(`"${p[2]}"`);
  for (const p of m[1].matchAll(/(\w+)\s*:\s*(\d+)\s*[,\n]/g)) obj[p[1]] ??= p[2];
  return obj;
}

export function parseDanawaProductPage(html) {
  const g = inlineObject(html, 'oGlobalSetting');
  const s = inlineObject(html, 'oPriceCompareSetting');
  if (!g?.nProductCode || !s) throw fail('SCHEMA');
  // Same field set common.min.js builds: aParamaterList + oPriceCompareSetting + maker fields.
  const form = {
    pcode: g.nProductCode, cate1: g.nCategoryCode1 ?? '', cate2: g.nCategoryCode2 ?? '', cate3: g.nCategoryCode3 ?? '', cate4: g.nCategoryCode4 ?? '',
    UICategoryCode: g.nCategoryCode || 0, powerLinkKeyword: g.powerLinkKeyword ?? '', minPrice: g.nMinPrice ?? '', keyword: g.sKeyword ?? '', NaPm: g.sNaPm ?? '',
    ...Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'sLoginUrl' && k !== 'sProductFullName')),
    makerCode: g.makerCode ?? '', makerName: g.makerName ?? '',
  };
  return { pcode: String(g.nProductCode), name: g.sProductName ?? s.sProductFullName ?? '', minPrice: won(g.nMinPrice), form };
}

export function parseDanawaMallList(html) {
  const src = String(html);
  const offers = [];
  const seen = new Set();
  const heads = [...src.matchAll(/<h4>([^<]*)<\/h4>/g)].map(m => ({ at: m.index, section: m[1].trim() }));
  for (const m of src.matchAll(/<div class="diff_item[^"]*"\s+data-linkProduct="([^"]+)"[^>]*>([\s\S]*?)(?=<div class="diff_item|<input type="hidden"|$)/g)) {
    const [, linkProduct, block] = m;
    const price = won(/<em class="prc_c">([^<]*)<\/em>/.exec(block)?.[1]);
    if (price === null) continue;
    const mall = (/<div class="d_mall">[\s\S]*?<img[^>]*alt="([^"]*)"/.exec(block)?.[1] ?? text(/<div class="d_mall">([\s\S]*?)<div class="report">/.exec(block)?.[1])).trim();
    const shipText = text(/<span class="ship">([\s\S]*?)<\/span>/.exec(block)?.[1]);
    const shipping = /무료/.test(shipText) ? 0 : won(/배송비\s*([\d,]+)/.exec(shipText)?.[1]);
    const title = text(/<div class="info_line">([\s\S]*?)<\/div>/.exec(block)?.[1]);
    const key = `${linkProduct}:${price}`;
    if (seen.has(key)) continue; // warranty-mall section repeats the same listing
    seen.add(key);
    const section = heads.filter(h => h.at < m.index).at(-1)?.section ?? null;
    offers.push({ mall, mallCode: linkProduct.split('_')[0], price, shipping, total: shipping === null ? null : price + shipping,
      shippingText: shipText || null, title, section, couponRequired: /쿠폰/.test(block), warranty: /class="[^"]*warranty|>보증</.test(block) });
  }
  return offers;
}

// Compare one seller's price to the rest of the market (the seller's own listings excluded by mall name).
export function compareToMarket(price, offers, { excludeMall = null } = {}) {
  const others = offers.filter(o => !excludeMall || !o.mall.includes(excludeMall));
  const byPrice = others.map(o => o.price).sort((a, b) => a - b);
  const byTotal = others.filter(o => o.total !== null).sort((a, b) => a.total - b.total);
  const lowest = byTotal[0] ?? null;
  // Cheapest shipped offer per mall (G마켓, 옥션, 11번가, SSG.COM, 롯데ON, 쿠팡 ...), cheapest first.
  const lowestByMall = [...byTotal.reduce((acc, o) => (acc.has(o.mall) ? acc : acc.set(o.mall, o)), new Map()).values()]
    .map(o => ({ mall: o.mall, price: o.price, shipping: o.shipping, total: o.total, couponRequired: o.couponRequired, title: o.title }));
  return {
    lowestByMall,
    offersCompared: others.length,
    lowestOtherPrice: byPrice[0] ?? null,
    lowestOtherTotal: lowest?.total ?? null,
    lowestOther: lowest ? { mall: lowest.mall, price: lowest.price, shipping: lowest.shipping, title: lowest.title } : null,
    cheaperOffers: others.filter(o => o.total !== null && o.total < price).length,
    deltaVsLowestTotal: lowest ? price - lowest.total : null,
    beatsMarket: lowest ? price < lowest.total && (byPrice[0] === undefined || price <= byPrice[0]) : null,
  };
}

// ── Run-scoped Danawa session (web-api-playbook session pattern) ──────────────────────────────────────────────────────
// One per process/run: Chrome-like navigation headers, a warm-up visit to the home page before the first read, a cookie
// jar carried across every Danawa request of the run, strictly sequential requests at least `gapMs` apart, and a hard
// stop after a block (403/418/429 or a challenge page): no retry, every later call fails fast with ACCESS_BLOCKED.
// TLS impersonation (curl_cffi) is not used: Node's TLS is accepted by Danawa (2026-10-16 batch of 30/30 complete).
const DANAWA_HOME = 'https://www.danawa.com/';
const CHROME_HEADERS = Object.freeze({
  'user-agent': UA,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
  'sec-ch-ua': '"Chromium";v="153", "Google Chrome";v="153", "Not.A/Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'upgrade-insecure-requests': '1',
});
const CHALLENGE = /captcha|보안 ?문자|자동입력 ?방지|비정상적인 접근|Access Denied|cf-chl|challenge-platform/i;
const isDanawa = url => { try { return /(^|\.)danawa\.com$/.test(new URL(url).hostname); } catch { return false; } };

export function createDanawaSession({ fetchImpl = (url, init) => globalThis.fetch(url, init), gapMs = 1200, warmUp = true,
  sleep = ms => new Promise(r => setTimeout(r, ms)), now = () => Date.now() } = {}) {
  const jar = new Map();
  let last = -Infinity, warmed = !warmUp, blocked = null, chain = Promise.resolve();
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const remember = res => {
    const list = typeof res?.headers?.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of list) {
      const [pair, ...attrs] = String(c).split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim(), value = pair.slice(eq + 1).trim();
      const expired = attrs.some(a => /^\s*max-age\s*=\s*0\s*$/i.test(a)) || value === '';
      if (expired) jar.delete(name); else jar.set(name, value);
    }
  };
  const raw = async (url, init = {}) => {
    const wait = last + gapMs - now();
    if (wait > 0) await sleep(wait);
    last = now();
    const headers = { ...CHROME_HEADERS, ...(init.headers ?? {}) };
    if (jar.size) headers.cookie = cookieHeader();
    const nav = !headers['x-requested-with'];
    headers['sec-fetch-mode'] = nav ? 'navigate' : 'cors';
    headers['sec-fetch-dest'] = nav ? 'document' : 'empty';
    headers['sec-fetch-site'] = headers.referer ? 'same-origin' : 'none';
    const res = await fetchImpl(url, { ...init, headers });
    last = now();
    remember(res);
    if ([403, 418, 429].includes(res.status)) blocked = `HTTP_${res.status}`;
    return res;
  };
  const request = async (url, init = {}) => {
    if (blocked) throw fail('ACCESS_BLOCKED', { url, reason: blocked });
    if (!isDanawa(url)) return fetchImpl(url, init);
    if (!warmed) {
      warmed = true;
      try { await raw(DANAWA_HOME, { redirect: 'manual' }); } catch { /* the warm-up is best effort */ }
      if (blocked) throw fail('ACCESS_BLOCKED', { url, reason: blocked });
    }
    const res = await raw(url, init);
    if (res.status !== 200 || typeof res.text !== 'function') return res;
    // A 200 challenge page is a block too: read once, check, and hand the same body back.
    const body = await res.text();
    if (CHALLENGE.test(body.slice(0, 20000)) && !/productItem|__next_f|oGlobalSetting|diff_item/.test(body)) { blocked = 'CHALLENGE'; return { status: 403, headers: res.headers, text: async () => '' }; }
    return { status: res.status, headers: res.headers, text: async () => body };
  };
  // Strictly sequential, even when callers overlap.
  const fetchLike = (url, init) => { const p = chain.then(() => request(url, init)); chain = p.catch(() => {}); return p; };
  fetchLike.state = () => ({ cookies: [...jar.keys()], blocked, warmed });
  return fetchLike;
}
let defaultSession = null;
export const danawaSession = () => (defaultSession ??= createDanawaSession());

async function get(fetchImpl, url, init = {}, hops = 0) {
  let r;
  try {
    r = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(20000), ...init,
      headers: { 'user-agent': UA, 'accept-language': 'ko-KR,ko;q=0.9', ...(init.headers ?? {}) } });
  } catch (error) { if (error?.code === 'ACCESS_BLOCKED') throw error; throw fail('TRANSPORT', { url }); }
  // Blocks and challenges are final for this run: no retry (playbook rule), the caller skips Danawa afterwards.
  if (r.status === 403 || r.status === 418 || r.status === 429) throw fail('ACCESS_BLOCKED', { httpStatus: r.status, url });
  // One same-site redirect is followed for a GET (Danawa moved search pages on 2026-10-16); anything else stays an error.
  if ([301, 302, 303, 307, 308].includes(r.status) && hops === 0 && (init.method ?? 'GET') === 'GET') {
    let next = null;
    try { next = new URL(r.headers.get('location') ?? '', url); } catch { next = null; }
    if (next && next.protocol === 'https:' && /(^|\.)danawa\.com$/.test(next.hostname) && !/captcha|challenge|block/i.test(next.href)) return get(fetchImpl, next.href, init, 1);
  }
  if (r.status !== 200) throw fail('HTTP_STATUS', { httpStatus: r.status, url });
  const body = await r.text();
  if (Buffer.byteLength(body) > MAX_BYTES) throw fail('SOURCE_TOO_LARGE', { url });
  return body;
}

export async function searchDanawa(query, { fetchImpl = danawaSession() } = {}) {
  if (typeof query !== 'string' || !query.trim()) throw fail('QUERY');
  const url = `${SEARCH}?query=${encodeURIComponent(query.trim())}`;
  const html = await get(fetchImpl, url);
  return { url, results: parseDanawaSearch(html), responseSha256: sha(html) };
}

export async function fetchDanawaOffers(pcode, { fetchImpl = danawaSession() } = {}) {
  if (!/^\d+$/.test(String(pcode))) throw fail('PCODE');
  const pageUrl = `${PRODUCT}?pcode=${pcode}`;
  const page = parseDanawaProductPage(await get(fetchImpl, pageUrl));
  const body = new URLSearchParams(Object.entries(page.form).map(([k, v]) => [k, String(v)])).toString();
  const html = await get(fetchImpl, MALL_LIST, { method: 'POST', body,
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest', referer: pageUrl } });
  const cashOffers = parseDanawaMallList(html);
  if (!cashOffers.length) throw fail('NO_OFFERS', { pcode: String(pcode) });
  // Card rows (e.g. "삼성카드 14,120원") ride along as offers[].conditionalPrices (effective-price, 2026-10-05). The cash
  // price stays the comparison price; a card price is never the headline lowest (effective-price-ontology R1).
  let offers = cashOffers, cardRows = 0;
  try {
    const { parseDanawaCardRows, attachDanawaConditionals } = await import('./effective-price/danawa-card-rows.mjs');
    const rows = parseDanawaCardRows(html, { pageUrl, observedAt: new Date().toISOString() });
    cardRows = rows.length;
    offers = attachDanawaConditionals(cashOffers, rows).offers;
  } catch { offers = cashOffers; }
  return { pcode: page.pcode, name: page.name, pageUrl, minPrice: page.minPrice, offers, checkedAt: new Date().toISOString(),
    receipt: { sourceUrl: MALL_LIST, pageUrl, offers: offers.length, cardRows, responseSha256: sha(html), browserUsed: false, credentialsUsed: false } };
}

// Sizes/counts that must agree between a seller title and a Danawa product name ("75ml", "370ml", "2kg", "30매").
const SIZE = /(\d+(?:\.\d+)?)\s*(ml|l|g|kg|매|정|캡슐|롤|입|개입|ea|mm|cm|인치|gb|tb)(?![a-z가-힣])/gi;
export const sizeTokens = s => [...String(s).toLowerCase().matchAll(SIZE)].map(m => `${Number(m[1])}${m[2].toLowerCase()}`);
// Spelled-out forms Korean sellers use for the abbreviations Danawa names carry.
const SYNONYMS = [[/오\s*드\s*뚜왈렛|오드뚜왈렛|뚜왈렛/g, 'edt'], [/오\s*드\s*퍼퓸|오드퍼퓸|퍼퓸/g, 'edp'], [/오\s*드\s*코롱|오드코롱/g, 'edc']];
const normalize = s => SYNONYMS.reduce((acc, [re, to]) => acc.replace(re, ` ${to} `), String(s).toLowerCase());
const words = s => normalize(s).replace(/[(),\[\]/+]/g, ' ').split(/\s+/).filter(w => w.length > 1);

// Conservative match: same brand word, every size token of the seller title in the Danawa name, and the best
// word score must be unique (a variant such as "블루"/"블랙" that the seller title lacks costs a point).
// The pack count ("…, 24개") must equal the Danawa option's count ("24개"; a missing count means 1).
const COUNT = /(\d+)\s*개(?!입)/;
export function matchDanawaResult(sellerTitle, results) {
  const t = String(sellerTitle);
  const sizes = sizeTokens(t);
  const count = Number(/,\s*(\d+)\s*개\s*$/.exec(t)?.[1] ?? 1);
  const tw = words(t.replace(/,\s*\d+\s*개\s*$/, ''));
  const brand = tw[0];
  if (!brand || !sizes.length) return null;
  const squash = s => normalize(s).replace(/\s+/g, '');
  const scored = results.map(r => {
    const full = `${r.name} ${r.label ?? ''}`;
    const nw = words(r.name);
    const flat = squash(r.name); // "제주 삼다수" still contains the seller's "제주삼다수"
    const rs = sizeTokens(full);
    const rc = Number(COUNT.exec(r.label ?? '')?.[1] ?? COUNT.exec(r.name)?.[1] ?? 1);
    // Sizes must agree both ways: an extra size ("200ml+80ml") is a bundle, not the same product.
    if (r.minPrice === null || rc !== count || !flat.includes(brand) || !sizes.every(s => rs.includes(s)) || !rs.every(s => sizes.includes(s))) return null;
    const score = tw.filter(w => flat.includes(w)).length - nw.filter(w => !squash(t).includes(w)).length;
    return { ...r, score };
  }).filter(Boolean).sort((a, b) => b.score - a.score || a.minPrice - b.minPrice);
  if (!scored.length) return null;
  // A tie is only acceptable between listings of the same product name (keep the cheaper one); otherwise ambiguous.
  const tied = scored.filter(r => r.score === scored[0].score);
  if (tied.some(r => squash(r.name) !== squash(scored[0].name))) return null;
  return scored[0];
}

export const danawaQuery = title => String(title).replace(/,\s*\d+\s*개\s*$/, '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
