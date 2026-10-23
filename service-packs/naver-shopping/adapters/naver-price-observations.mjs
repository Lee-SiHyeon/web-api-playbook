import { parse } from 'parse5';
import { NaverShoppingClient, NaverShoppingError, validateShoppingQuery } from './naver-shopping.mjs';

// Ported from the AGY Nexearch price-engine draft after checking the current
// document. These observed price rows distinguish list/current/coupon prices.
const selectors = { price: 'lS3yrqWd', amount: 'lfETsaia', listPrice: 'YsimyBy5', couponPrice: 'hx15sCPH', rating: 'mlLzqQ3t', reviews: 'zZrIETI9' };
function attr(node, name) { return node.attrs?.find(x => x.name === name)?.value ?? ''; }
function hasClass(node, name) { return attr(node, 'class').split(/\s+/).includes(name); }
function descendants(node) {
  const rows = [];
  const visit = current => {
    if (['script', 'style', 'template'].includes(current.tagName)) return;
    rows.push(current);
    for (const child of current.childNodes ?? []) visit(child);
  };
  visit(node);
  return rows;
}
function plainText(node) {
  if (!node || ['script', 'style', 'template'].includes(node.tagName)) return '';
  if (node.nodeName === '#text') return node.value;
  return (node.childNodes ?? []).map(plainText).join(' ').replace(/\s+/g, ' ').trim();
}
function productId(node) {
  if (node.tagName !== 'a') return null;
  try {
    const url = new URL(attr(node, 'href'));
    const mid = url.searchParams.get('nv_mid');
    return url.protocol === 'https:' && !url.username && !url.password && /^cr\d*\.shopping\.naver\.com$/.test(url.hostname)
      && url.pathname === '/v2/bridge/searchGate' && /^[1-9][0-9]{0,15}$/.test(mid ?? '') ? mid : null;
  } catch { return null; }
}
function titleNode(rows, mid) {
  return rows.find(x => x.tagName === 'a' && productId(x) === mid && /\.(?:outtit|itemtit)$/.test(attr(x, 'data-nlog-area')));
}
function findCard(anchor, mid) {
  let current = anchor.parentNode;
  for (let depth = 0; current && depth < 12; depth++, current = current.parentNode) {
    const rows = descendants(current), ids = new Set(rows.map(productId).filter(Boolean));
    if (ids.size > 1) return null;
    if (ids.size === 1 && ids.has(mid) && titleNode(rows, mid) && rows.some(x => hasClass(x, selectors.price))) return { rows, node: current };
  }
  return null;
}
function rowPrice(rows, className, required = false) {
  const regions = rows.filter(x => hasClass(x, className));
  if (!regions.length && !required) return null;
  if (regions.length !== 1) throw new NaverShoppingError('SCHEMA_CHANGED', 'Integrated product price row was missing or ambiguous');
  const amounts = descendants(regions[0]).filter(x => hasClass(x, selectors.amount));
  const value = amounts.length === 1 ? plainText(amounts[0]) : '';
  if (!/^(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)$/.test(value) || !plainText(regions[0]).includes('원')) throw new NaverShoppingError('SCHEMA_CHANGED', 'Integrated product price amount changed');
  const amount = Number(value.replaceAll(',', ''));
  if (!Number.isSafeInteger(amount)) throw new NaverShoppingError('SCHEMA_CHANGED', 'Integrated product price was outside the integer range');
  return amount;
}
function displayedCount(value) {
  const display = String(value ?? '').replace(/[()\s]/g, '');
  if (/^\d+(?:,\d{3})*$/.test(display)) {
    const exact = Number(display.replaceAll(',', ''));
    if (Number.isSafeInteger(exact)) return { exact, approximate: null, display, precision: 'exact' };
  }
  const abbreviated = display.match(/^(\d+(?:\.\d+)?)(만|억)$/);
  if (abbreviated) return { exact: null, approximate: Math.round(Number(abbreviated[1]) * (abbreviated[2] === '만' ? 10000 : 100000000)), display, precision: 'abbreviated' };
  return { exact: null, approximate: null, display: display || null, precision: 'unknown' };
}

export function parseIntegratedPriceCards(html, { checkedAt = new Date().toISOString(), sourceUrl = null, limit = 20 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 40) throw new NaverShoppingError('INPUT', 'limit must be between 1 and 40');
  const anchors = descendants(parse(html)).filter(x => productId(x));
  if (!anchors.length) throw new NaverShoppingError('SHOPPING_BLOCK_UNAVAILABLE', 'Integrated search did not expose the observed shopping block; no zero-price or empty result was inferred');
  const items = [], seen = new Set();
  for (const anchor of anchors) {
    const mid = productId(anchor), card = findCard(anchor, mid);
    if (!card) continue;
    const title = plainText(titleNode(card.rows, mid)).slice(0, 1000);
    if (!title) throw new NaverShoppingError('SCHEMA_CHANGED', 'Integrated product title was missing');
    const listingPriceKrw = rowPrice(card.rows, selectors.price, true);
    const listPriceKrw = rowPrice(card.rows, selectors.listPrice), conditionalCouponPriceKrw = rowPrice(card.rows, selectors.couponPrice);
    const seller = plainText(card.rows.find(x => /\.outmall$/.test(attr(x, 'data-nlog-area')))).slice(0, 200) || null;
    const duplicateKey = mid + '|' + title + '|' + seller + '|' + listingPriceKrw + '|' + conditionalCouponPriceKrw;
    if (seen.has(duplicateKey)) continue;
    seen.add(duplicateKey);
    const ratingText = plainText(card.rows.find(x => hasClass(x, selectors.rating))), rating = ratingText ? Number(ratingText) : null;
    const review = displayedCount(plainText(card.rows.find(x => hasClass(x, selectors.reviews))));
    const cardText = plainText(card.node);
    const sellerCount = displayedCount(cardText.match(/판매처\s*([0-9.,]+(?:만|억)?)/)?.[1]);
    // Shipping and Naver membership points as the card prints them; points are a reward, never subtracted from the price.
    const won = s => (s === undefined ? null : Number(s.replaceAll(',', '')));
    const deliveryFeeKrw = /배송비\s*무료/.test(cardText) ? 0 : won(cardText.match(/배송비\s*([0-9]{1,3}(?:,[0-9]{3})*|[0-9]+)\s*원/)?.[1]);
    const membershipRewardMaxKrw = won(cardText.match(/최대\s*([0-9]{1,3}(?:,[0-9]{3})*|[0-9]+)\s*원\s*적립/)?.[1]);
    const membershipRewardRate = Number(cardText.match(/멤버십\s*([0-9]{1,2})\s*%\s*적립/)?.[1] ?? NaN);
    items.push({ provider: 'naver-shopping', productId: mid, idKind: 'nv_mid', title, checkedAt,
      sourceKind: 'integrated_search_shopping_card', sourceUrl, sourceOrder: items.length + 1, searchRank: null,
      seller, listingPriceKrw, listPriceKrw, conditionalCouponPriceKrw, currency: 'KRW',
      deliveryFeeKrw, membershipRewardMaxKrw, membershipRewardRate: Number.isFinite(membershipRewardRate) ? membershipRewardRate : null,
      couponEligibilityVerified: false, payablePriceVerified: false, optionsVerified: false,
      sellersCount: sellerCount.exact, sellersCountApproximate: sellerCount.approximate,
      listingKind: /\.itemtit$/.test(attr(titleNode(card.rows, mid), 'data-nlog-area')) ? 'catalog_comparison' : 'seller_offer',
      averageRating: rating !== null && Number.isFinite(rating) && rating >= 0 && rating <= 5 ? rating : null,
      reviewCount: review.exact, reviewCountApproximate: review.approximate, reviewCountDisplay: review.display, reviewCountPrecision: review.precision,
      url: null, productUrlVerified: false, adStatus: 'not_determined', contentTrust: 'untrusted_external_text' });
    if (items.length === limit) break;
  }
  if (!items.length) throw new NaverShoppingError('SCHEMA_CHANGED', 'Shopping product identity/price card structure changed');
  return items;
}

export function summarizePriceObservations(items) {
  const prices = items.filter(x => Number.isSafeInteger(x.listingPriceKrw) && x.listingPriceKrw >= 0);
  const count = BigInt(prices.length), total = prices.reduce((sum, x) => sum + BigInt(x.listingPriceKrw), 0n);
  return { scope: 'returned_cards_only', pricedItemCount: prices.length,
    lowest: prices.length ? Math.min(...prices.map(x => x.listingPriceKrw)) : null,
    highest: prices.length ? Math.max(...prices.map(x => x.listingPriceKrw)) : null,
    arithmeticMean: prices.length ? Number((total + count / 2n) / count) : null,
    comparableVariantsVerified: false, checkoutPricesVerified: false };
}

function boundedPattern(pattern) {
  if (pattern === null) return null;
  const fail = () => { throw new NaverShoppingError('INPUT', 'Filter regex supports literals, classes, up to four groups/eight alternatives and one .*; backreferences, lookarounds and other repetition are not supported'); };
  if (typeof pattern !== 'string' || !pattern || pattern.length > 160 || /[\u0000-\u001f]/.test(pattern)) fail();
  let depth = 0, groups = 0, alternatives = 0, wildcards = 0, inClass = false, escaped = false, dot = false;
  for (const c of pattern) {
    if (escaped) { if (!/[dDsSwWbB.^$*+?()[\]{}|\\/-]/.test(c)) fail(); escaped = false; dot = false; continue; }
    if (c === '\\') { escaped = true; dot = false; continue; }
    if (inClass) { if (c === '[') fail(); if (c === ']') inClass = false; dot = false; continue; }
    if (c === '[') { inClass = true; dot = false; continue; }
    if (c === '(') { if (++depth > 2 || ++groups > 4) fail(); }
    if (c === ')' && --depth < 0) fail();
    if (c === '|' && ++alternatives > 8) fail();
    if (c === '*') { if (!dot || ++wildcards > 1) fail(); }
    if ('+?{}'.includes(c)) fail();
    dot = c === '.';
  }
  if (escaped || inClass || depth !== 0) fail();
  try { return new RegExp(pattern, 'iu'); } catch { fail(); }
}

export function filterPriceObservations(items, { includeRegex = null, excludeRegex = null, minPriceKrw = null, maxPriceKrw = null } = {}) {
  const include = boundedPattern(includeRegex), exclude = boundedPattern(excludeRegex);
  for (const n of [minPriceKrw, maxPriceKrw]) if (n !== null && (!Number.isSafeInteger(n) || n < 0)) throw new NaverShoppingError('INPUT', 'Price bounds must be non-negative safe integers');
  if (minPriceKrw !== null && maxPriceKrw !== null && minPriceKrw > maxPriceKrw) throw new NaverShoppingError('INPUT', 'Minimum price cannot exceed maximum price');
  return items.filter(item => {
    if (minPriceKrw !== null && (item.listingPriceKrw === null || item.listingPriceKrw < minPriceKrw)) return false;
    if (maxPriceKrw !== null && (item.listingPriceKrw === null || item.listingPriceKrw > maxPriceKrw)) return false;
    const target = (item.title + ' ' + (item.seller ?? '')).slice(0, 1201);
    return (!include || include.test(target)) && (!exclude || !exclude.test(target));
  });
}

export async function searchIntegratedPrices({ query, limit = 20, fetchImpl = globalThis.fetch, includeRegex = null, excludeRegex = null, minPriceKrw = null, maxPriceKrw = null } = {}) {
  const keyword = validateShoppingQuery(query);
  if (!Number.isInteger(limit) || limit < 1 || limit > 40) throw new NaverShoppingError('INPUT', 'limit must be between 1 and 40');
  const filters = { includeRegex, excludeRegex, minPriceKrw, maxPriceKrw };
  filterPriceObservations([], filters); // Validate filters before issuing HTTP.
  const url = new URL('https://search.naver.com/search.naver'); url.searchParams.set('where', 'nexearch'); url.searchParams.set('query', keyword);
  const response = await new NaverShoppingClient({ fetchImpl, responseByteLimit: 4 * 1024 * 1024 }).request(url);
  let observations;
  try { observations = parseIntegratedPriceCards(response.data, { checkedAt: response.receipt.checkedAt, sourceUrl: url.href, limit }); }
  catch (error) { if (error instanceof NaverShoppingError) error.receipt = response.receipt; throw error; }
  const items = filterPriceObservations(observations, filters);
  return { scope: 'integrated_search_shopping_cards', query: keyword, items, inspectedCount: observations.length, matchedCount: items.length,
    filtering: 'local_filter_of_inspected_cards', filters, catalogComplete: false, comparisonReady: false,
    paginationVerified: false, reviewBodiesIncluded: false, observedPriceRangeKrw: summarizePriceObservations(items),
    priceOrder: [...items].sort((a, b) => a.listingPriceKrw - b.listingPriceKrw).map(x => ({ sourceOrder: x.sourceOrder, productId: x.productId, listingPriceKrw: x.listingPriceKrw })),
    receipt: response.receipt };
}
