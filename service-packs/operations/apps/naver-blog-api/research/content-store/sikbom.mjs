// 식봄 (foodspring.co.kr, 마켓보로 식자재 오픈마켓) public reader — owner 2026-10-10 "식봄 붙여".
// Product and category pages are server-rendered Next.js pages whose __NEXT_DATA__ carries a Relay record store
// (pageProps.initialRecords); the product page also has a schema.org Product JSON-LD. Both are readable without login.
// robots.txt (2026-10-10) allows /goods/detail/ and /category/goods_detail/ and disallows /API/, /main/, /cart, /order/,
// so this reads only those two page kinds, one GET each, and never calls the site's API.
import { pathToFileURL } from 'node:url';

export const ORIGIN = 'https://www.foodspring.co.kr';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const fail = (code, message) => { throw Object.assign(new Error(`${code}: ${message}`), { code }); };

export function nextData(html) {
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) fail('SIKBOM_NO_NEXT_DATA', 'page has no __NEXT_DATA__');
  return JSON.parse(m[1]);
}

// Relay store helpers: a field is a value, {__ref} or {__refs}.
const store = html => nextData(html).props?.pageProps?.initialRecords ?? fail('SIKBOM_NO_RECORDS', 'no initialRecords');
const ref = (s, v) => (v && v.__ref ? s[v.__ref] ?? null : v ?? null);
const refs = (s, v) => (v && Array.isArray(v.__refs) ? v.__refs.map(id => s[id]).filter(Boolean) : []);

function shippingOf(s, goods) {
  const fee = ref(s, goods.deliveryFee);
  const vendor = ref(s, goods.vendor), delivery = vendor ? ref(s, vendor.delivery) : null;
  const rural = delivery ? ref(s, delivery.ruralDeliveryFee) : null, due = delivery ? ref(s, delivery.orderDue) : null;
  const base = { method: delivery?.__typename ?? null, free: goods.isFreeDelivery === true || fee?.__typename === 'FreeDeliveryFee',
    ruralFeeKrw: rural?.rural ?? null, jejuFeeKrw: rural?.jeju ?? null, orderDue: due ? { day: due.day, hour: due.hour, minute: due.minute } : null };
  if (!fee) return { ...base, rule: null };
  if (fee.__typename === 'QuantityDeliveryFee') return { ...base, rule: 'per_quantity', feeKrw: fee.price, perUnits: fee.unitQuantity };
  if (fee.__typename === 'ConditionalDeliveryFee') return { ...base, rule: 'free_over', freeOverKrw: fee.condition, feeKrw: fee.price ?? null };
  if (fee.__typename === 'FreeDeliveryFee') return { ...base, rule: 'free', feeKrw: 0 };
  return { ...base, rule: fee.__typename, feeKrw: fee.price ?? null };
}

function couponOf(s, c) {
  const d = ref(s, c.discountInfo), cond = ref(s, c.condition), p = ref(s, c.period);
  return { id: c.nid, name: c.displayName?.trim() ?? null, status: c.issueStatus ?? null,
    discount: d ? { type: d.__typename, percent: d.discountPercentage ?? null, amountKrw: d.discountAmount ?? null, capKrw: d.discountLimitAmount ?? null } : null,
    minimumPurchaseKrw: cond?.minimumPurchaseAmount ?? null, startAt: p?.startAt ?? null, endAt: p?.endAt ?? null };
}

function goodsRow(s, g) {
  const price = ref(s, g.price) ?? {}, vendor = ref(s, g.vendor), images = ref(s, g.images), stock = ref(s, g.stock), cat = ref(s, g.categoryNode);
  const applied = ref(s, price.appliedCoupon), best = ref(s, price.maxBenefitCoupon);
  return {
    id: g.nid, url: `${ORIGIN}/goods/detail/${g.nid}`, name: g.name, standard: g.standard ?? null, unit: g.unit ?? null,
    salePriceKrw: price.salePrice ?? null, originalPriceKrw: price.originalPrice ?? null, discountRate: price.discountRate ?? null,
    // a coupon price is what the page shows after the seller's/site's coupon; it needs the coupon issued and its conditions
    couponPriceKrw: applied?.price ?? best?.price ?? null,
    vendor: vendor ? { id: vendor.nid, name: vendor.name } : null,
    category: cat ? { id: cat.nid, name: cat.name, path: cat.path ?? null } : null,
    image: images?.primaryUrl ?? images?.listingUrl ?? null,
    stock: stock?.quantity ?? null, purchasable: refs(s, g.nonPurchasableReason).length === 0 && g.isUse !== false,
    shipping: shippingOf(s, g),
  };
}

export function parseGoodsPage(html) {
  const s = store(html);
  const g = Object.values(s).find(v => v.__typename === 'Goods' && s['client:root']?.[`node(id:"${v.id}")`]) ?? Object.values(s).find(v => v.__typename === 'Goods');
  if (!g) fail('SIKBOM_NO_GOODS', 'no Goods record');
  const row = goodsRow(s, g);
  const ld = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map(m => { try { return JSON.parse(m[1]); } catch { return null; } }).find(x => x?.['@type'] === 'Product');
  // the JSON-LD offer is the plain sale price; it must agree with the record store
  if (ld?.offers?.price != null && Number(ld.offers.price) !== row.salePriceKrw) fail('SIKBOM_PRICE_MISMATCH', `ld ${ld.offers.price} vs record ${row.salePriceKrw}`);
  const best = ref(s, ref(s, g.price)?.maxBenefitCoupon);
  return { ...row, origin: g.origin ?? null, todayPurchasedCount: g.todayPurchasedCount ?? null,
    coupons: refs(s, g.couponList).map(c => couponOf(s, c)),
    bestCoupon: best ? { priceKrw: best.price, coupons: refs(s, best.couponList).map(c => couponOf(s, c)) } : null,
    priceHistory: refs(s, g.priceRecord).map(r => ({ at: r.datetime, priceKrw: r.price })),
    availability: ld?.offers?.availability?.replace('https://schema.org/', '') ?? null };
}

export function parseCategoryPage(html) {
  const s = store(html);
  const node = Object.values(s).find(v => v.__typename === 'GoodsCategoryNode' && s['client:root']?.[`goodsCategory(nid:${v.nid})`]);
  if (!node) fail('SIKBOM_NO_CATEGORY', 'no GoodsCategoryNode');
  const listKey = Object.keys(node).find(k => k.startsWith('goodsList('));
  const conn = ref(s, node[listKey]);
  const edges = refs(s, conn?.edges);
  const page = ref(s, conn?.pageInfo);
  return { id: node.nid, name: node.name, path: node.path ?? null, sort: /sort:"([A-Z_]+)"/.exec(listKey ?? '')?.[1] ?? null,
    totalCount: conn?.totalCount ?? null, hasNextPage: page?.hasNextPage ?? null,
    goods: edges.map(e => ref(s, e.node)).filter(Boolean).map(g => goodsRow(s, g)) };
}

export async function fetchPage(pathname, { fetchImpl = fetch } = {}) {
  if (!/^\/(goods\/detail\/\d+|category\/goods_detail\/\d+)$/.test(pathname)) fail('SIKBOM_PATH_NOT_ALLOWED', pathname);
  const res = await fetchImpl(ORIGIN + pathname, { headers: { 'user-agent': UA, 'accept-language': 'ko-KR,ko;q=0.9', accept: 'text/html' } });
  if (!res.ok) fail(`SIKBOM_HTTP_${res.status}`, pathname);
  return res.text();
}
export const goods = async (id, o) => ({ checkedAt: new Date().toISOString(), ...parseGoodsPage(await fetchPage(`/goods/detail/${id}`, o)) });
export const category = async (id, o) => ({ checkedAt: new Date().toISOString(), ...parseCategoryPage(await fetchPage(`/category/goods_detail/${id}`, o)) });

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...ids] = process.argv.slice(2);
  const fn = { goods, category }[cmd];
  if (!fn || !ids.length) { console.error('usage: node sikbom.mjs goods <id...> | category <id...>'); process.exit(2); }
  for (const [n, id] of ids.entries()) {
    if (n) await new Promise(r => setTimeout(r, 1500));
    try { console.log(JSON.stringify(await fn(id))); } catch (e) { console.log(JSON.stringify({ id, error: e.code ?? e.message })); process.exitCode = 1; }
  }
}
