// 중고 시세 (호가) + '새로 사서 ○개월 쓰고 팔면 실제 비용'. Pure functions plus anonymous one-page-per-query collectors.
//
//   parseBunjangSearch(json)        -> listings   (find_v2.json list)
//   parseJoongnaSearch(html)        -> listings   (RSC stream items)
//   parseHellomarketSearch(html)    -> listings   (__NEXT_DATA__ searchData.itemData)
//   parseDaangnSearch(html)         -> listings   (JSON-LD ItemList; saved/manual pages only by default)
//   filterListings(listings, spec)  -> { kept, dropped }   model-token filter + 매입/고장/다모델 미끼 제거
//   usedPrice(model, listings, opts)-> { model, median, p25, p75, sampleSize, window, sources, priceKind, ... }
//   realCost(newPrice, used, months, opts) -> { realCost, perMonth, resaleValue, assumptions, ... } | { error }
//   realCostLine(result)            -> one Korean line with the assumptions
//   fetchUsedListings(query, opts)  -> normalized listings from Bunjang, Joongna, Hello Market (Daangn only with includeDaangn)
//
// Listing shape: { source, id, title, price, kind: 'asking'|'sold', status, listedAt (ISO|null), conditionRaw, url }
import { loadOntology } from './deep-discount-sources.mjs';

const fail = code => Object.assign(new Error(code), { code });
const num = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : null; };

// ---- parsers ----------------------------------------------------------------------------------------------------------
export function parseBunjangSearch(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  if (data?.result !== 'success' || !Array.isArray(data.list)) throw fail('BUNJANG_SCHEMA');
  return data.list.filter(x => !x.ad).map(x => ({
    source: 'bunjang', id: String(x.pid), title: String(x.name ?? ''), price: num(x.price), kind: 'asking',
    status: String(x.status) === '0' ? 'selling' : 'other',
    listedAt: Number.isFinite(Number(x.update_time)) ? new Date(Number(x.update_time) * 1000).toISOString() : null,
    conditionRaw: x.used === undefined ? null : `used:${x.used}`, bizseller: x.bizseller === true,
    url: `https://m.bunjang.co.kr/products/${x.pid}`,
  })).filter(x => x.price);
}

// Joongna streams React Server Component chunks: self.__next_f.push([1,"<json-string>"]). The items array is inside.
export function parseJoongnaSearch(html) {
  const chunks = [...String(html).matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)];
  let text = '';
  for (const c of chunks) { try { text += JSON.parse(c[1]); } catch { /* skip a broken chunk */ } }
  const at = text.indexOf('"items":[');
  if (at < 0) throw fail('JOONGNA_SCHEMA');
  let items;
  try { items = new JSONDecoderLike(text.slice(at + 8)).parse(); } catch { throw fail('JOONGNA_SCHEMA'); }
  if (!Array.isArray(items)) throw fail('JOONGNA_SCHEMA');
  return items.filter(x => x && x.seq).map(x => ({
    source: 'joongna', id: String(x.seq), title: String(x.title ?? ''), price: num(x.price), kind: 'asking',
    status: x.state === 0 ? 'selling' : 'other',
    listedAt: x.sortDate ? new Date(`${x.sortDate.replace(' ', 'T')}+09:00`).toISOString() : null,
    conditionRaw: null, url: `https://web.joongna.com/product/${x.seq}`,
  })).filter(x => x.price);
}

// Reads exactly one JSON value from the start of a string (the array after "items":).
class JSONDecoderLike {
  constructor(s) { this.s = s; }
  parse() {
    let depth = 0, inStr = false, esc = false;
    for (let i = 0; i < this.s.length; i++) {
      const ch = this.s[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '[' || ch === '{') depth++;
      else if (ch === ']' || ch === '}') { depth--; if (depth === 0) return JSON.parse(this.s.slice(0, i + 1)); }
    }
    throw fail('JSON_UNTERMINATED');
  }
}

export function parseHellomarketSearch(html) {
  const m = String(html).match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw fail('HELLOMARKET_SCHEMA');
  let items;
  try { items = JSON.parse(m[1])?.props?.initialState?.searchData?.itemData; } catch { throw fail('HELLOMARKET_SCHEMA'); }
  if (!Array.isArray(items)) throw fail('HELLOMARKET_SCHEMA');
  return items.map(x => ({
    source: 'hellomarket', id: String(x.itemIdx), title: String(x.title ?? ''), price: num(x.price), kind: 'asking',
    status: x.sellState?.code === 'ForSale' ? 'selling' : 'other',
    listedAt: Number.isFinite(x.timestamp) ? new Date(x.timestamp).toISOString() : null,
    conditionRaw: x.usedType?.name ?? null, url: `https://www.hellomarket.com/item/${x.itemIdx}`,
  })).filter(x => x.price);
}

export function parseDaangnSearch(html) {
  for (const m of String(html).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let o; try { o = JSON.parse(m[1]); } catch { continue; }
    if (o?.['@type'] !== 'ItemList' || !Array.isArray(o.itemListElement)) continue;
    return o.itemListElement.map(e => e.item).filter(Boolean).map(x => ({
      source: 'daangn', id: String(x.url ?? '').split('/').filter(Boolean).at(-1) ?? '', title: String(x.name ?? ''),
      price: num(x.offers?.price), kind: 'asking',
      status: /InStock/.test(x.offers?.availability ?? '') ? 'selling' : 'other', listedAt: null,
      conditionRaw: String(x.offers?.itemCondition ?? '').replace('https://schema.org/', '') || null, url: x.url ?? null,
    })).filter(x => x.price);
  }
  throw fail('DAANGN_SCHEMA');
}

// ---- model filtering --------------------------------------------------------------------------------------------------
const norm = s => String(s).toLowerCase().replace(/\s+/g, '');
const MULTI_MODEL = /\d{1,2}\s*[/,+]\s*\d{1,2}\s*[/,+]\s*\d{1,2}/;

// spec: { include: ['아이폰15','256'] (every term must appear, spaces ignored; use arrays for alternatives: [['프로','pro']]),
//         exclude: ['프로맥스','플러스'] (extra terms to reject, e.g. sibling models) }
export function filterListings(listings, spec = {}, ontology = loadOntology()) {
  const kept = [], dropped = [];
  const always = ontology.usedPrice.excludeTitleSignals.map(norm);
  for (const l of listings) {
    const t = norm(l.title);
    let why = null;
    if (!l.price) why = 'no_price';
    else if (l.status && l.status !== 'selling' && l.kind !== 'sold') why = 'not_selling';
    else if (always.some(s => t.includes(s))) why = 'excluded_signal';
    else if (MULTI_MODEL.test(l.title)) why = 'multi_model_bait';
    else if ((spec.include ?? []).some(term => !(Array.isArray(term) ? term : [term]).some(alt => t.includes(norm(alt))))) why = 'model_mismatch';
    else if ((spec.exclude ?? []).some(term => t.includes(norm(term)))) why = 'excluded_model';
    (why ? dropped : kept).push(why ? { ...l, dropReason: why } : l);
  }
  return { kept, dropped };
}

// ---- statistics -------------------------------------------------------------------------------------------------------
// Linear interpolation between order statistics (Hyndman & Fan type 7, the R/NumPy default).
export function quantile(sorted, p) {
  if (!sorted.length) return null;
  const h = (sorted.length - 1) * p, lo = Math.floor(h), hi = Math.ceil(h);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (h - lo);
}
export const tukeyFence = (sorted, k = 1.5) => {
  const q1 = quantile(sorted, 0.25), q3 = quantile(sorted, 0.75), iqr = q3 - q1;
  return { low: q1 - k * iqr, high: q3 + k * iqr };
};
// P(distribution-free [x(1), x(n)] covers the population median) = 1 - 2 * 0.5^n   (ontology R7)
export const medianCoverage = n => (n >= 1 ? 1 - 2 * 0.5 ** n : 0);

// maxAgeDays (optional, off by default): drop listings whose listedAt is older than N days; undated listings stay. Stale asks are usually
// overpriced and unsold, so callers should pass about 90 (an assumption, not a cited figure).
export function usedPrice(model, listings, { spec = null, ontology = loadOntology(), now = new Date(), maxAgeDays = null } = {}) {
  const cfg = ontology.usedPrice;
  const cutoff = Number.isFinite(maxAgeDays) ? now.getTime() - maxAgeDays * 86_400_000 : null;
  const fresh = cutoff === null ? listings : listings.filter(l => !l.listedAt || Date.parse(l.listedAt) >= cutoff);
  const filtered = spec ? filterListings(fresh, spec, ontology) : { kept: fresh.filter(l => l.price), dropped: [] };
  const prices = filtered.kept.map(l => l.price).sort((a, b) => a - b);
  const result = { model, median: null, p25: null, p75: null, sampleSize: 0, rawSampleSize: listings.length, maxAgeDays, droppedOutliers: 0,
    window: null, sources: {}, priceKind: null, label: null, status: 'insufficient_sample', minSample: cfg.minSample,
    medianCoverage: null, ruleRef: 'R6_ho_ga_not_sold_price/R7_used_price_minimum_sample' };
  if (!prices.length) return result;
  const fence = prices.length >= 4 ? tukeyFence(prices, cfg.outlierFence) : { low: -Infinity, high: Infinity };
  const kept = filtered.kept.filter(l => l.price >= fence.low && l.price <= fence.high);
  const sorted = kept.map(l => l.price).sort((a, b) => a - b);
  result.droppedOutliers = prices.length - sorted.length;
  result.sampleSize = sorted.length;
  for (const l of kept) result.sources[l.source] = (result.sources[l.source] ?? 0) + 1;
  const dates = kept.map(l => l.listedAt).filter(Boolean).sort();
  result.window = { from: dates[0] ?? null, to: dates.at(-1) ?? null, collectedAt: now.toISOString() };
  const sold = kept.length > 0 && kept.every(l => l.kind === 'sold');
  result.priceKind = sold ? 'sold' : 'asking';
  result.label = sold ? '거래완료가' : '호가';
  result.medianCoverage = Math.round(medianCoverage(sorted.length) * 1000) / 1000;
  if (sorted.length < cfg.minSample) return result;
  result.median = Math.round(quantile(sorted, 0.5));
  result.status = 'median_only';
  if (sorted.length >= cfg.quartileSample) {
    result.p25 = Math.round(quantile(sorted, 0.25));
    result.p75 = Math.round(quantile(sorted, 0.75));
    result.status = 'ok';
  }
  return result;
}

// ---- real cost --------------------------------------------------------------------------------------------------------
// resale = p25 (conservative: the lower end of today's asking prices) * (1 - negotiation haircut) * (1 - seller fee).
// Defaults come from the ontology and are UNCITED assumptions (R9); the caller overrides them.
export function realCost(newPrice, used, months, { negotiationHaircut, sellerFeeRate, resaleBasis, ontology = loadOntology() } = {}) {
  const d = ontology.usedPrice.realCostDefaults;
  const haircut = negotiationHaircut ?? d.negotiationHaircut, fee = sellerFeeRate ?? d.sellerFeeRate, basis = resaleBasis ?? d.resaleBasis;
  if (!Number.isFinite(newPrice) || newPrice <= 0) return { error: 'NEW_PRICE_INVALID' };
  if (!Number.isInteger(months) || months < 1 || months > 120) return { error: 'MONTHS_INVALID' };
  if (![haircut, fee].every(v => Number.isFinite(v) && v >= 0 && v < 1)) return { error: 'ASSUMPTION_INVALID' };
  if (!['p25', 'median'].includes(basis)) return { error: 'BASIS_INVALID' };
  const base = used?.[basis];
  if (!Number.isFinite(base)) return { error: 'USED_PRICE_INSUFFICIENT', status: used?.status ?? null };
  const resaleValue = Math.round(base * (1 - haircut) * (1 - fee));
  const assumptions = { resaleBasis: basis, basisPrice: base, priceKind: used.priceKind, negotiationHaircut: haircut, sellerFeeRate: fee,
    provenance: ontology.usedPrice.realCostDefaults.provenance, sampleSize: used.sampleSize, sources: used.sources };
  const flags = [];
  if (resaleValue >= newPrice) flags.push('used_price_not_below_new');
  if (used.priceKind !== 'sold') flags.push('asking_price_basis');
  if (used.status !== 'ok') flags.push('quartiles_not_reported');
  if (flags.includes('used_price_not_below_new')) return { error: 'USED_NOT_BELOW_NEW', flags, assumptions };
  const cost = newPrice - resaleValue;
  return { newPrice, months, resaleValue, realCost: cost, perMonth: Math.round(cost / months), lossRate: Math.round(cost / newPrice * 1000) / 10, assumptions, flags };
}

const won = n => `${Math.round(n).toLocaleString('ko-KR')}원`;
export function realCostLine(r) {
  if (!r || r.error) return null;
  const a = r.assumptions;
  return `새로 사서 ${r.months}개월 쓰고 팔면 실제 비용 약 ${won(r.realCost)}(월 ${won(r.perMonth)}). 되파는 값은 현재 중고 ${a.priceKind === 'sold' ? '거래가' : '호가'} 하위 25%(${won(a.basisPrice)})에서 흥정 ${Math.round(a.negotiationHaircut * 100)}%·수수료 ${Math.round(a.sellerFeeRate * 1000) / 10}%를 뺀 ${won(r.resaleValue)}으로 가정했고, 표본 ${a.sampleSize}건 기준 시나리오이지 예측이 아닙니다.`;
}

// ---- collectors -------------------------------------------------------------------------------------------------------
const get = async (fetchImpl, url, accept) => {
  const res = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { accept, 'user-agent': 'Mozilla/5.0 (compatible; acada-research/1.0)' } });
  if (res.status !== 200) { await res.body?.cancel(); throw fail(`HTTP_${res.status}`); }
  return res;
};

// One page per source per query. Daangn's robots.txt disallows AI agents, so it is opt-in and meant for pages a person saved.
export async function fetchUsedListings(query, { fetchImpl = globalThis.fetch, includeDaangn = false, sources = ['bunjang', 'joongna', 'hellomarket'] } = {}) {
  const q = encodeURIComponent(query);
  const jobs = {
    bunjang: async () => parseBunjangSearch(await (await get(fetchImpl, `https://api.bunjang.co.kr/api/1/find_v2.json?q=${q}&order=date&page=0&n=30&req_ref=search&stat_device=w&version=4`, 'application/json')).json()),
    joongna: async () => parseJoongnaSearch(await (await get(fetchImpl, `https://web.joongna.com/search/${q}`, 'text/html')).text()),
    hellomarket: async () => parseHellomarketSearch(await (await get(fetchImpl, `https://www.hellomarket.com/search?q=${q}`, 'text/html')).text()),
    ...(includeDaangn ? { daangn: async () => parseDaangnSearch(await (await fetchImpl(`https://www.daangn.com/kr/search/buy-sell/?q=${q}`, { signal: AbortSignal.timeout(15_000), headers: { accept: 'text/html' } })).text()) } : {}),
  };
  const listings = [], errors = {};
  for (const id of [...sources, ...(includeDaangn ? ['daangn'] : [])]) {
    if (!jobs[id]) continue;
    try { listings.push(...await jobs[id]()); } catch (e) { errors[id] = e.code ?? e.message; }
  }
  return { listings, errors };
}
