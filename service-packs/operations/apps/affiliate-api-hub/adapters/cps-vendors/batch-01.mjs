import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';
import { parseFragment } from 'parse5';
import { createHash, randomUUID } from 'node:crypto';
import { readPublicPage, readPublicResource, extractPublicPage, safeUrl, textContent, isStrongPublicChallenge, publicPageInternals } from '../../lib/cps-public-reader.mjs';
import { collect as collectConsumerCatalog } from '../../../naver-blog-api/research/content-store/grocery-compare.mjs';
import { collectMerchant as collectNaverShoppingPublic } from './naver-shopping-public.mjs';
import { collectMerchant as collectBatch01ReviewMetadata } from './batch-01-review-metadata.mjs';
import { collectDosirakCatalog } from './dosirak-catalog.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APPS_ROOT = path.resolve(HERE, '../../..');
const TAXONOMY_FILE = path.join(APPS_ROOT, 'affiliate-api-hub/references/linkprice-cps-vertical-taxonomy.v1.json');
const taxonomy = JSON.parse(readFileSync(TAXONOMY_FILE, 'utf8').replace(/^\uFEFF/, ''));
const REVERIFY_REPORT_FILE = path.join(APPS_ROOT, 'affiliate-api-hub/references/cps-reverify/batch-01.json');
const DOSIRAK_API_HOST = 'esimapi.wifidosirak.com';
const DOSIRAK_API_BASE = `https://${DOSIRAK_API_HOST}/api/v1`;
const DOSIRAK_PRODUCT_LIST_URL = `${DOSIRAK_API_BASE}/product/web/product`;
const DOSIRAK_PRODUCT_DETAIL_BASE = 'https://dosirakesim.com/Product/Detail/1/';
export const BATCH_01_IDS = Object.freeze([
  'toyotarent', 'nbtnaver', 'dosirak1', 'halfclub1', 'shockzkr', 'smk', 'kurly',
  'lgecom', 'refurlab', 'myrealtrip', '60saju', 'dswellife', 'misope', 'stories',
]);
export const merchantIds = BATCH_01_IDS;
export const refreshableAfterPublicBlockMerchants = Object.freeze(['nbtnaver']);
const merchantById = new Map(taxonomy.merchants.filter(row => BATCH_01_IDS.includes(row.merchantId)).map(row => [row.merchantId, row]));

function merchantHostRoots(merchant) {
  const host = new URL(merchant.siteUrl).hostname.toLowerCase().replace(/^www\./, '');
  const explicit = merchant.merchantId === 'nbtnaver'
    ? ['shopping.naver.com', 'smartstore.naver.com', 'brand.naver.com'] : [];
  return [...new Set([host, ...explicit])];
}

function loadSavedBatch() {
  try { return JSON.parse(readFileSync(REVERIFY_REPORT_FILE, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

function hostAllowed(hostname, roots) {
  const host = String(hostname).toLowerCase().replace(/\.$/, '');
  return roots.some(root => host === root || host.endsWith(`.${root}`));
}

function isLgProductPath(value) {
  try {
    const pathname = new URL(value).pathname.toLowerCase();
    return pathname.startsWith('/product/care-solutions/') || pathname.startsWith('/product/home-iot-product/') ||
      /^\/care-solutions\/[^/]+\/[^/]+\/?$/.test(pathname) || /^\/home-iot-product\/[^/]+\/?$/.test(pathname);
  } catch { return false; }
}

function firstPartyLinks(links, roots) {
  return links.filter(link => {
    try { return hostAllowed(new URL(link.url).hostname, roots); } catch { return false; }
  });
}

function safeLinkLabel(link) {
  const url = String(link?.url ?? '').toLowerCase();
  if (/review|itemuse|goodsreview|board\/view|\/reviews?\//.test(url)) return 'public_review_page';
  const label = link?.text ?? link?.label;
  return label ? String(label).slice(0, 160) : null;
}

function usefulObservedOfferingUrl(merchantId, value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  const pathAndQuery = `${url.pathname}${url.search}`.toLowerCase();
  if (/\.(?:js|css|png|jpe?g|svg|webp|woff2?)(?:$|\?)/i.test(pathAndQuery)) return false;
  if (/(?:review|itemuse|goodsreview|board\/view)/i.test(pathAndQuery)) {
    if (merchantId === 'shockzkr' && /itemuse\.php/i.test(pathAndQuery)) return true;
    return ['misope', 'refurlab'].includes(merchantId) && /board\/list\.php\?[^#]*bdid=goodsreview/i.test(pathAndQuery);
  }
  if (merchantId === 'shockzkr' && /\/shop\/[^/?]+\.(?:php|html?)(?:$|\?)/i.test(pathAndQuery)) return false;
  const byMerchant = {
    toyotarent: /folder=cars.*page=cars(?:view)?|page=carsview/i.test(pathAndQuery),
    nbtnaver: /(?:\/products?\/|\/goods\/|\/item\/)/i.test(pathAndQuery),
    dosirak1: /(?:\/product\/|\/products\/|\/country\/|\/esim\/)/i.test(pathAndQuery),
    halfclub1: /(?:\/product\/|\/products\/|\/goods\/)/i.test(pathAndQuery),
    shockzkr: /\/shop\/(?!itemuse|itemuseform)[^/]+/i.test(pathAndQuery),
    smk: /\/asp\/product\/productdetail\.asp\?[^#]*productcode=/i.test(pathAndQuery),
    lgecom: isLgProductPath(url.href),
    refurlab: /\/goods\/goods_(?:list|view)\.php\?[^#]*good(?:sno|scd|cd)=/i.test(pathAndQuery),
    myrealtrip: /\/(?:products\/|union\/products\/|pkc\/detail\/)/i.test(pathAndQuery),
    '60saju': /^\/(?:yearly|wealth|match|self-guide|about)(?:\/|$)/i.test(pathAndQuery),
    dswellife: /\/products\/view\//i.test(pathAndQuery),
    misope: /\/goods\/goods_view\.php\?[^#]*goodsno=/i.test(pathAndQuery),
    stories: /\/product(?:s)?\//i.test(pathAndQuery),
  };
  return byMerchant[merchantId] === true;
}

function routePriority(merchantId, value) {
  const lower = String(value).toLowerCase();
  if (merchantId === 'toyotarent') return /page=carsview/i.test(lower) ? 2 : 1;
  if (merchantId === 'refurlab') return /goods_view\.php/i.test(lower) ? 2 : 1;
  if (merchantId === 'shockzkr') return /itemuse\.php/i.test(lower) ? 3 : /\/shop\/(?:all|category|list)(?:\/|\?|$)/i.test(lower) ? 1 : 2;
  if (merchantId === '60saju') return /\/yearly(?:\/|\?|$)/i.test(lower) ? 1 : 2;
  if (merchantId === 'myrealtrip') return 2;
  return 2;
}

function withoutReviewBodies(record) {
  return {
    ...record,
    reviewSamples: (record.reviewSamples ?? []).map(review => ({
      rating: Number.isFinite(review.rating) ? review.rating : null,
      publishedAt: typeof review.publishedAt === 'string' ? review.publishedAt : null,
      bodyAvailable: review.bodyAvailable === true, helpfulCount: null,
      hasMedia: null, completeness: 'partial',
    })),
  };
}

function halfclubSourceNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

function halfclubItemRecord(source, receiptId, locator) {
  const id = source?.prdNo == null ? null : String(source.prdNo);
  const title = typeof source?.prdNm === 'string' ? source.prdNm.trim() : '';
  const url = safeUrl(typeof source?.appPrdDtlUrl === 'string' ? source.appPrdDtlUrl : '');
  if (!id || !/^[A-Za-z0-9_-]{1,80}$/.test(id) || !title || !url) return null;
  try { if (!hostAllowed(new URL(url).hostname, ['halfclub.com'])) return null; } catch { return null; }
  const amount = [source.dcPrcPc, source.dcPrcMc, source.dcPrcApp].map(halfclubSourceNumber)
    .find(value => value !== null && value > 0) ?? null;
  const reviewCount = halfclubSourceNumber(source.reviewQty);
  const parsedRating = halfclubSourceNumber(source.reviewStar);
  const ratingValue = parsedRating !== null && parsedRating > 0 ? parsedRating : null;
  const fields = ['type', 'sourceLocalId', 'title', 'url'];
  if (amount !== null) fields.push('price');
  if (ratingValue !== null || reviewCount !== null) fields.push('rating');
  return {
    type: 'RetailProduct', sourceLocalId: id, title, url, description: null,
    brand: typeof source.brandNm === 'string' && source.brandNm.trim() ? source.brandNm.trim() : null,
    price: { amount, currency: amount === null ? null : 'KRW', priceText: amount === null ? null : `${amount}원` },
    rating: { value: ratingValue, best: null, worst: null, reviewCount, ratingCount: null },
    variants: [], reviewSamples: [], retrievalContext: { surface: 'homepage_product_list_sample', queryApplied: false },
    evidence: [{ receiptId, locator, fields }],
  };
}

function halfclubPdpData(html) {
  const script = embeddedScriptText(html, 'pdp-data');
  if (!script) return null;
  try { return JSON.parse(script); } catch { return null; }
}

function halfclubPdpVariants(productInfo) {
  const variants = [];
  for (const group of Array.isArray(productInfo?.optionItem) ? productInfo.optionItem : []) {
    const groupName = typeof group?.optItemNm === 'string' ? group.optItemNm.trim() : '';
    const values = Array.isArray(group?.optValueList) ? group.optValueList : [];
    for (const option of values) {
      const label = [option?.optValueNm, option?.optionValueNm, option?.optNm, option?.valueNm, option?.value, option?.name]
        .find(value => typeof value === 'string' && value.trim())?.trim() ?? '';
      if (!label) continue;
      variants.push({ title: label, attributes: { ...(groupName ? { optionGroup: groupName } : {}), optionValue: label } });
      if (variants.length >= 100) return variants;
    }
  }
  return variants;
}

function halfclubRuntimeConfig(html) {
  const source = String(html ?? '');
  const publicObject = source.match(/window\.__NUXT__\.config\s*=\s*\{\s*public\s*:\s*\{([\s\S]*?)\}\s*,?\s*(?:app|$)/i)?.[1]
    ?? source.match(/window\.__NUXT__\.config\s*=\s*\{\s*public\s*:\s*\{([\s\S]*?)\}\s*\}/i)?.[1]
    ?? '';
  const readString = key => {
    const match = publicObject.match(new RegExp(`(?:^|[,\\s])${key}\\s*:\\s*["']([^"']{1,300})["']`));
    return match?.[1] ?? null;
  };
  const config = {
    baseURL: readString('baseURL'), siteCd: readString('siteCd'),
    mobileDeviceCd: readString('mobileDeviceCd'), deviceTypeCd: readString('deviceTypeCd'),
  };
  return Object.values(config).some(value => value !== null) ? config : null;
}

function embeddedScriptText(html, scriptId) {
  let tree;
  try { tree = parseFragment(String(html ?? '')); } catch { return null; }
  const script = descendants(tree, node => node.tagName === 'script' && nodeAttr(node, 'id') === scriptId, [])[0];
  if (!script) return null;
  return (script.childNodes ?? []).map(node => node.value ?? '').join('') || null;
}

function normalizeMerchantRecord(record, merchantId) {
  const safe = withoutReviewBodies(record);
  if (merchantId !== 'myrealtrip') return safe;
  safe.type = 'TravelOffering';
  const homepageSample = (safe.evidence ?? []).some(item => String(item.locator ?? '').includes('__NEXT_DATA__'));
  safe.retrievalContext = { surface: homepageSample ? 'homepage_ranked_sample' : 'observed_detail_page', queryApplied: false };
  try {
    const url = new URL(safe.url);
    const accommodation = url.hostname.startsWith('accommodation.') || /\/union\/products\//i.test(url.pathname);
    if (accommodation) {
      const checkIn = url.searchParams.get('checkIn');
      const checkOut = url.searchParams.get('checkOut');
      const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
      const stayStart = validDate(checkIn);
      const stayEnd = validDate(checkOut);
      safe.price = {
        ...(safe.price ?? { amount: null, currency: null, priceText: null }),
        priceKind: stayStart && stayEnd ? 'date_conditioned_accommodation_quote' : 'accommodation_quote_basis_unknown',
        condition: stayStart && stayEnd ? { checkIn: stayStart, checkOut: stayEnd } : null,
        amountBasis: null,
        qualifiers: ['nightly_vs_stay_total_not_established'],
      };
    }
  } catch { /* retain the observed record if its URL cannot be parsed */ }
  return safe;
}

function nodeAttr(node, name) { return node?.attrs?.find(row => row.name === name)?.value ?? null; }
function descendants(root, predicate, output = []) {
  if (!root || output.length >= 5000) return output;
  if (predicate(root)) output.push(root);
  for (const child of root.childNodes ?? []) descendants(child, predicate, output);
  return output;
}
function observedScriptResources(html, pageUrl, roots) {
  let tree;
  try { tree = parseFragment(html); } catch { return []; }
  const candidates = descendants(tree, node => node.tagName === 'script' && nodeAttr(node, 'src')
    || node.tagName === 'link' && nodeAttr(node, 'href') && /(?:modulepreload|prefetch)/i.test(nodeAttr(node, 'rel') ?? '')).slice(0, 150);
  return candidates.flatMap(node => {
    const href = node.tagName === 'script' ? nodeAttr(node, 'src') : nodeAttr(node, 'href');
    const url = safeUrl(href, pageUrl);
    if (!url) return [];
    try {
      const parsed = new URL(url);
      if (!hostAllowed(parsed.hostname, roots)) return [];
      // Do not retain analytics/session-bearing beacon URLs in the discovery frontier.
      if (/\/(?:gd_visit|analytics|tracking|beacon)\.[^/]+$/i.test(parsed.pathname) ||
          [...parsed.searchParams.keys()].some(key => /^(?:requestData|analytics_client_id|analytics_session_id|session_id|user_id|dummyData)$/i.test(key))) return [];
    } catch { return []; }
    return [{ url, type: node.tagName === 'script' ? nodeAttr(node, 'type') : nodeAttr(node, 'rel'), async: nodeAttr(node, 'async') !== null, defer: nodeAttr(node, 'defer') !== null }];
  });
}

function recordIdFromUrl(url) {
  try {
    const parsed = new URL(url);
    for (const key of ['goodsNo', 'ProductCode', 'productCode', 'idx', 'itemNo', 'modelId', 'it_id']) {
      const value = parsed.searchParams.get(key);
      if (value && /^[A-Za-z0-9_-]{1,100}$/.test(value)) return value;
    }
    const patterns = [/\/products\/view\/([A-Za-z0-9_-]{1,100})/, /\/goods\/([A-Za-z0-9_-]{1,100})$/, /\/shop\/([A-Za-z0-9_-]{1,100})$/, /\/([A-Za-z0-9_-]{3,100})\/?$/];
    for (const pattern of patterns) { const match = parsed.pathname.match(pattern); if (match) return match[1]; }
  } catch { /* no safe local identifier */ }
  return null;
}

function isObservedDetailPage(merchantId, value) {
  const text = String(value).toLowerCase();
  if (merchantId === 'toyotarent') return /page=carsview/i.test(text);
  if (merchantId === 'refurlab') return /goods_view\.php/i.test(text);
  if (merchantId === 'shockzkr') return /\/shop\/(?!itemuse|all|category|list)[^/?]+/i.test(text);
  if (merchantId === 'smk') return /productdetail\.asp/i.test(text);
  if (merchantId === 'lgecom') return isLgProductPath(text);
  if (merchantId === 'myrealtrip') return /\/(?:products\/|union\/products\/|pkc\/detail\/)/i.test(text);
  if (merchantId === 'dswellife') return /\/products\/view\//i.test(text);
  if (merchantId === 'misope') return /goods_view\.php/i.test(text);
  if (merchantId === '60saju') return /^https:\/\/60saju\.com\/(?:yearly|wealth|match|self-guide)/i.test(text);
  if (merchantId === 'halfclub1') return /\/(?:product|products|goods)\//i.test(text);
  if (merchantId === 'dosirak1') return /^https:\/\/dosirakesim\.com\/product\/detail\/1\/[a-z0-9_-]+(?:[?#]|$)/i.test(text);
  if (merchantId === 'stories') return /\/product(?:s)?\//i.test(text);
  return false;
}

function kurlyRecordsFromBody(body, receiptId) {
  let json;
  try { json = JSON.parse(body); } catch { return { records: [], resultCount: 0 }; }
  const items = (json?.data?.listSections ?? []).flatMap(section => section?.data?.items ?? []).slice(0, 20);
  const records = [];
  for (const item of items) {
    const id = item?.no == null ? null : String(item.no);
    const title = typeof item?.name === 'string' ? item.name.trim() : '';
    const amountValue = [item.discountedPrice, item.salesPrice].find(value => Number.isSafeInteger(value) && value >= 0
      || typeof value === 'string' && /^\d+$/.test(value));
    const amount = amountValue === undefined ? null : Number(amountValue);
    const reviewText = item?.reviewCount;
    const reviewCount = typeof reviewText === 'string' && /^\d+$/.test(reviewText) ? Number(reviewText)
      : Number.isSafeInteger(reviewText) && reviewText >= 0 ? reviewText : null;
    const fields = ['type', 'sourceLocalId', 'title', 'url'];
    if (amount !== null) fields.push('price');
    if (reviewCount !== null) fields.push('rating');
    if (!id || !title) continue;
    records.push({ type: 'RetailProduct', sourceLocalId: id, title, url: `https://www.kurly.com/goods/${encodeURIComponent(id)}`,
      description: null, brand: null, price: { amount, currency: amount === null ? null : 'KRW', priceText: amount === null ? null : `${amount}원` },
      rating: { value: null, best: null, worst: null, reviewCount, ratingCount: null }, variants: [], reviewSamples: [],
      evidence: [{ receiptId, locator: '$.data.listSections[*].data.items[*]', fields }] });
  }
  return { records, resultCount: items.length };
}

function renderedRecord({ merchant, url, pageTitle, description, html, receiptId, observedLabel = null }) {
  const visible = textContent(html, 100_000) ?? '';
  const id = recordIdFromUrl(url);
  let title = null;
  if (merchant.merchantId === 'toyotarent') {
    title = visible.match(/토요타렌터카\s+(.{2,100}?)\s+상세보기/)?.[1]?.trim() ?? null;
  } else if (merchant.merchantId === 'smk') {
    title = observedLabel?.replace(/\s+[\d,]+\s*$/, '').trim() ?? null;
    if (!title) title = visible.match(/COLLABO\s+(.{2,120}?)\s+스타일컬러/)?.[1]?.trim() ?? null;
  } else if (merchant.merchantId === 'lgecom') {
    const parts = String(pageTitle ?? '').split(/\s*\|\s*/).map(part => part.trim()).filter(Boolean);
    title = parts.length >= 2 ? `${parts[0]} ${parts[1]}` : parts[0] ?? null;
    if (!title && observedLabel) title = observedLabel.replace(/\s+최대혜택가.*$/i, '').trim();
  } else if (merchant.merchantId === 'refurlab') {
    title = String(pageTitle ?? '').replace(/^리퍼연구소\s*[-|:]\s*/i, '').trim() || null;
  } else if (merchant.merchantId === 'dswellife') {
    title = String(pageTitle ?? '').split('|')[0].trim() || null;
  } else if (merchant.merchantId === 'misope') {
    title = String(pageTitle ?? '').split('|').slice(1).join('|').trim() || null;
  } else if (merchant.merchantId === '60saju') {
    title = String(pageTitle ?? '').split('|')[0].trim() || null;
  } else if (merchant.merchantId === 'toyotarent') {
    title = visible.match(/(?:차량명|차종)\s*[:：]?\s*([^\n|]{2,80})/)?.[1]?.trim() ?? null;
  } else if (merchant.merchantId === 'dosirak1' || merchant.merchantId === 'halfclub1' || merchant.merchantId === 'myrealtrip') {
    const parts = String(pageTitle ?? '').split(/\s*[|–-]\s*/).map(part => part.trim()).filter(Boolean);
    title = parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0] ?? null;
  }
  if (!title) return null;

  const finalBenefitMatch = visible.match(/최종혜택가\s*([\d,]+)\s*원/i);
  const saleMatch = visible.match(/(?:판매가|판매 가격|최종가|할인가|즉시할인가)\s*[:：]?\s*([\d,]+)\s*원/i);
  const monthlyMatch = visible.match(/(?:최대\s*혜택가|월\s*요금|월\s*가격|구독)\s*[:：]?\s*월?\s*([\d,]+)\s*원/i)
    ?? visible.match(/월\s*([\d,]+)\s*원/i);
  const classPriceMatch = merchant.merchantId === 'dswellife' ? String(html ?? '').match(/<p\b[^>]*class=["'][^"']*\bprice\b[^"']*["'][^>]*>\s*<span[^>]*>\s*([\d,]+)/i) : null;
  const yenMatch = visible.match(/가격\s*(￥\s*[\d,]+)/i);
  const priceMatch = finalBenefitMatch ?? saleMatch ?? monthlyMatch ?? (classPriceMatch ? [classPriceMatch[0], classPriceMatch[1]] : null);
  let amount = priceMatch ? Number(priceMatch[1].replace(/,/g, '')) : null;
  let currency = priceMatch ? 'KRW' : yenMatch ? 'JPY' : null;
  let priceText = classPriceMatch ? `${classPriceMatch[1]}원` : priceMatch?.[0] ?? yenMatch?.[0] ?? null;
  if (merchant.merchantId === 'toyotarent' && yenMatch) { amount = null; priceText = null; }
  if (merchant.merchantId === 'lgecom' && amount === 0) amount = null;
  if (merchant.merchantId === 'refurlab') {
    const sale = visible.match(/판매가\s*[:：]?\s*([\d,]+)\s*원/i)?.[1];
    const list = visible.match(/정가\s*[:：]?\s*([\d,]+)\s*원/i)?.[1];
    // Prefer the explicit final benefit price when the page exposes it. Some
    // refurbished listings show a comparison price in the same visible block,
    // so comparing that value with the sale label would falsely mark the
    // clearly stated final price as contradictory.
    if (!finalBenefitMatch && sale && list && Number(sale.replace(/,/g, '')) > Number(list.replace(/,/g, ''))) {
      amount = null; currency = 'KRW'; priceText = `판매가 ${sale}원; 정가 ${list}원 (표시값 상충)`;
    }
  }
  const reviewMatch = visible.match(/(?:상품\s*후기|상품\s*리뷰|리뷰)\s*[（(]?\s*([\d,]+)\s*[）)]?/i)
    ?? visible.match(/리뷰\s+([\d,]+)\s+리뷰쓰기/i);
  const reviewCount = reviewMatch ? Number(reviewMatch[1].replace(/,/g, '')) : null;
  const ratingMatch = visible.match(/(?:사용자\s*)?총\s*평점\s*([\d.]+)/i);
  const ratingValue = ratingMatch && Number(ratingMatch[1]) >= 0 ? Number(ratingMatch[1]) : null;
  const type = merchant.verticalHint === 'travel' ? 'TravelOffering' : merchant.merchantId === '60saju' ? 'ServiceOffering' : 'RetailProduct';
  const fields = ['title', 'url'];
  if (priceText || amount !== null) fields.push('price');
  if (ratingValue !== null || reviewCount !== null) fields.push('rating');
  return {
    type, sourceLocalId: id, title, url: safeUrl(url), description: description ?? null, brand: null,
    price: { amount: Number.isSafeInteger(amount) && amount >= 0 ? amount : null, currency, priceText },
    rating: { value: ratingValue, best: null, worst: null, reviewCount: Number.isSafeInteger(reviewCount) ? reviewCount : null, ratingCount: null },
    variants: [], reviewSamples: [],
    evidence: [{ receiptId, locator: finalBenefitMatch ? 'document.visible_text:최종혜택가' : saleMatch ? 'document.visible_text:판매가' : monthlyMatch ? 'document.visible_text:monthly_price' : classPriceMatch ? 'p.price > span' : yenMatch ? 'document.visible_text:가격' : 'document.title_or_observed_link', fields }],
  };
}

function myRealTripHomeRecords(html, receiptId, roots) {
  const match = String(html ?? '').match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return [];
  let data;
  try { data = JSON.parse(match[1]); } catch { return []; }
  const queryData = data?.props?.pageProps?.dehydratedState?.queries?.[0]?.state?.data;
  const groups = queryData?.rankProduct?.list;
  if (!Array.isArray(groups)) return [];
  const records = [];
  for (const group of groups) {
    for (const item of Array.isArray(group?.products) ? group.products : []) {
      const url = safeUrl(item?.productUrl);
      const title = typeof item?.title === 'string' ? item.title.trim() : '';
      if (!title || !url) continue;
      try { if (!hostAllowed(new URL(url).hostname, roots)) continue; } catch { continue; }
      const rawAmount = [item.salePrice, item.memberPrice, item.originalPrice].find(value =>
        Number.isSafeInteger(value) && value >= 0 || typeof value === 'string' && /^\d+$/.test(value));
      const amountValue = rawAmount === undefined ? null : Number(rawAmount);
      const parsedRating = typeof item.reviewStar === 'string' && /^\d+(?:\.\d+)?$/.test(item.reviewStar) ? Number(item.reviewStar)
        : Number.isFinite(item.reviewStar) && item.reviewStar >= 0 ? item.reviewStar : null;
      // The provider uses zero as an empty-rating sentinel, including for
      // products that have reviews. A zero average is not a valid observed
      // rating; retain the explicit review count separately.
      const ratingValue = parsedRating === 0 ? null : parsedRating;
      const reviewCountValue = typeof item.reviewCount === 'string' && /^\d+$/.test(item.reviewCount) ? Number(item.reviewCount)
        : Number.isSafeInteger(item.reviewCount) && item.reviewCount >= 0 ? item.reviewCount : null;
      const fields = ['type', 'title', 'url'];
      if (amountValue !== null) fields.push('price');
      if (ratingValue !== null || reviewCountValue !== null) fields.push('rating');
      records.push({ type: 'TravelOffering', sourceLocalId: /^[A-Za-z0-9_-]{1,80}$/.test(String(item.gid ?? '')) ? String(item.gid) : null,
        title, url, description: null, brand: null,
        price: { amount: amountValue, currency: amountValue !== null ? 'KRW' : null, priceText: amountValue !== null ? `${amountValue}원` : null },
        rating: { value: ratingValue, best: null, worst: null,
          reviewCount: Number.isSafeInteger(reviewCountValue) && reviewCountValue >= 0 ? reviewCountValue : null, ratingCount: null },
        variants: [], reviewSamples: [], evidence: [{ receiptId,
          locator: '__NEXT_DATA__.props.pageProps.dehydratedState.queries[0].state.data.rankProduct.list[*].products[*]', fields }] });
      if (records.length >= 100) return records;
    }
  }
  return records;
}

/** Replays one observed first-party URL with the shared anonymous HTTPS reader. */
export async function readBatch01Page({ merchantId, url, checkedAt = new Date().toISOString(), includeHtml = false } = {}) {
  const merchant = merchantById.get(merchantId);
  if (!merchant) throw Object.assign(new Error('MERCHANT_NOT_IN_BATCH_01'), { code: 'MERCHANT_NOT_IN_BATCH_01' });
  const allowedHosts = merchantHostRoots(merchant);
  const page = await readPublicPage(url, { allowedHosts });
  const receipt = page.receipt ? { ...page.receipt, checkedAt: page.receipt.observedAt ?? checkedAt } : null;
  const receipts = receipt ? [receipt] : [];
  const redirects = (page.redirects ?? []).map(row => ({ status: row.status, from: safeUrl(row.from), to: safeUrl(row.to) }));
  if (!page.ok) {
    const blocked = page.blocked === true || [401, 403, 418, 429].includes(page.status);
    const state = page.status ? `http_${page.status}` : page.stopReason === 'VISIBLE_CHALLENGE' ? 'visible_challenge' : page.stopReason ?? 'read_failed';
    return { merchantId, siteUrl: merchant.siteUrl, state, stopReason: page.stopReason, blocked, receipts, redirects, parsed: null, stopHost: blocked };
  }
  const parsed = extractPublicPage(page, { merchantId, typeHint: merchant.verticalHint === 'travel' ? 'TravelOffering' : null });
  parsed.links = firstPartyLinks(parsed.links, allowedHosts);
  parsed.records = parsed.records.map(record => {
    const safe = normalizeMerchantRecord(record, merchantId);
    if (!safe.sourceLocalId) safe.sourceLocalId = recordIdFromUrl(safe.url ?? page.url);
    return safe;
  });
  const canonicalUrl = parsed.links.find(link => String(link.rel ?? '').toLowerCase().split(/\s+/).includes('canonical'))?.url ?? null;
  parsed.page = { url: page.url, title: parsed.title, description: parsed.description, canonicalUrl };
  parsed.anchors = parsed.links.map(link => ({ url: link.url, text: link.text, rel: link.rel ?? null }));
  parsed.observedResources = observedScriptResources(page.html, page.url, allowedHosts);
  if (merchantId === 'myrealtrip' && new URL(page.url).pathname === '/') {
    const existingUrls = new Set(parsed.records.map(row => row.url));
    parsed.records.push(...myRealTripHomeRecords(page.html, receipt?.id ?? null, allowedHosts).filter(row => !existingUrls.has(row.url)));
    parsed.records = parsed.records.map(record => {
      const safe = normalizeMerchantRecord(record, merchantId);
      if (!safe.sourceLocalId) safe.sourceLocalId = recordIdFromUrl(safe.url ?? page.url);
      return safe;
    });
  }
  if (/(?:itemuse|goodsreview|\/review|\/reviews|board\/list\.php.*goodsreview)/i.test(`${new URL(page.url).pathname}${new URL(page.url).search}`)) {
    const visible = textContent(page.html, 100_000) ?? '';
    const countMatch = visible.match(/리뷰\s+([\d,]+)\s+리뷰쓰기/i) ?? visible.match(/상품\s*후기\s*[（(]\s*([\d,]+)\s*[）)]/i);
    const ratingMatch = visible.match(/(?:사용자\s*)?총\s*평점\s*([\d.]+)/i);
    parsed.publicReviewSummary = {
      reviewCount: countMatch ? Number(countMatch[1].replace(/,/g, '')) : null,
      ratingValue: ratingMatch && Number.isFinite(Number(ratingMatch[1])) ? Number(ratingMatch[1]) : null,
      completeness: 'aggregate_only',
    };
  }
  parsed.jsonLdBlocksRead = parsed.jsonLd.length;
  parsed.offeringCandidateCount = parsed.records.length;
  return { merchantId, siteUrl: merchant.siteUrl, state: 'http_200_html', stopReason: null, blocked: false, receipts, redirects, parsed, stopHost: false,
    ...(includeHtml ? { transientHtml: page.html } : {}) };
}

/** Read one observed first-party JS/JSON/text URL. The response body is transient. */
export async function readBatch01Resource({ merchantId, url, checkedAt = new Date().toISOString() } = {}) {
  const merchant = merchantById.get(merchantId);
  if (!merchant) throw Object.assign(new Error('MERCHANT_NOT_IN_BATCH_01'), { code: 'MERCHANT_NOT_IN_BATCH_01' });
  const roots = merchantHostRoots(merchant);
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch { throw Object.assign(new Error('OBSERVED_RESOURCE_URL_INVALID'), { code: 'OBSERVED_RESOURCE_URL_INVALID' }); }
  if (!hostAllowed(parsedUrl.hostname, roots)) throw Object.assign(new Error('OBSERVED_RESOURCE_HOST_OUT_OF_SCOPE'), { code: 'OBSERVED_RESOURCE_HOST_OUT_OF_SCOPE' });
  const resource = await readPublicResource(url, { allowedHosts: roots });
  const receipt = resource.receipt ? { ...resource.receipt, checkedAt: resource.receipt.observedAt ?? checkedAt } : null;
  return { merchantId, state: resource.ok ? 'http_200_resource' : resource.status ? `http_${resource.status}` : resource.stopReason ?? 'read_failed',
    stopReason: resource.stopReason, blocked: resource.blocked === true || [401, 403, 418, 429].includes(resource.status),
    url: resource.url, status: resource.status, contentType: resource.contentType, receipts: receipt ? [receipt] : [], redirects: (resource.redirects ?? []).map(row => ({ status: row.status, from: safeUrl(row.from), to: safeUrl(row.to) })),
    transientBody: resource.ok ? resource.body : null };
}

function dosirakReceipt({ url, status = null, contentType = null, bytes = 0, responseSha256 = null, observedAt = new Date().toISOString() }) {
  return { id: randomUUID(), requestMethod: 'POST', requestUrl: safeUrl(url), responseStatus: Number.isInteger(status) ? status : null,
    contentType: contentType ?? null, bytes: Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : 0, responseSha256,
    observedAt, checkedAt: observedAt, browserUsed: false, cookiesSent: false, authorizationSent: false };
}

/** One bounded anonymous replay of the bundle-observed Dosi product-list POST. */
async function postObservedDosirakProductList(countryIds) {
  const url = new URL(DOSIRAK_PRODUCT_LIST_URL);
  const payload = Buffer.from(JSON.stringify({ countryId: countryIds.join(',') }), 'utf8');
  const observedAt = new Date().toISOString();
  const fail = (stopReason, receipt = dosirakReceipt({ url: url.href, observedAt })) => ({ ok: false, stopReason, blocked: false, receipt });
  if (url.protocol !== 'https:' || url.hostname !== DOSIRAK_API_HOST || url.pathname !== '/api/v1/product/web/product' || url.search || payload.length > 16_384) {
    return fail('OBSERVED_POST_SCOPE_REJECTED');
  }

  let pinnedAddress;
  try {
    const answers = await lookup(DOSIRAK_API_HOST, { all: true, verbatim: true });
    const ipv4 = answers.filter(row => row.family === 4);
    if (!ipv4.length) return fail('PUBLIC_IPV4_REQUIRED');
    if (ipv4.some(row => !publicPageInternals.isPublicIpv4(row.address))) return fail('NON_PUBLIC_ADDRESS_REJECTED');
    pinnedAddress = ipv4[0].address;
  } catch {
    return fail('DNS_LOOKUP_FAILED');
  }

  let response;
  try {
    response = await new Promise((resolve, reject) => {
      const request = https.request({
        protocol: 'https:', hostname: DOSIRAK_API_HOST, servername: DOSIRAK_API_HOST,
        path: url.pathname, method: 'POST', signal: AbortSignal.timeout(20_000),
        headers: { accept: 'application/json', 'accept-encoding': 'identity', 'content-type': 'application/json', 'content-length': String(payload.length) },
        lookup(host, options, callback) {
          if (host.toLowerCase() !== DOSIRAK_API_HOST) return callback(new Error('HOST_CHANGED'));
          if (options?.all) return callback(null, [{ address: pinnedAddress, family: 4 }]);
          return callback(null, pinnedAddress, 4);
        },
      }, resolve);
      request.once('error', () => reject(new Error('PUBLIC_HTTP_TRANSPORT_FAILED')));
      request.end(payload);
    });
  } catch (error) {
    const reason = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'REQUEST_TIMEOUT' : 'PUBLIC_HTTP_TRANSPORT_FAILED';
    return fail(reason);
  }

  const status = response.statusCode ?? 0;
  const contentType = Array.isArray(response.headers['content-type']) ? response.headers['content-type'].join(', ')
    : response.headers['content-type'] ?? null;
  const blocked = [401, 403, 418, 429].includes(status);
  if (blocked) {
    response.destroy();
    return { ok: false, stopReason: `HTTP_${status}`, blocked: true,
      receipt: dosirakReceipt({ url: url.href, status, contentType, observedAt }) };
  }
  if (status >= 300 && status < 400) {
    response.destroy();
    return { ok: false, stopReason: 'REDIRECT_NOT_FOLLOWED_FOR_POST', blocked: false,
      receipt: dosirakReceipt({ url: url.href, status, contentType, observedAt }) };
  }
  if (status !== 200) {
    response.destroy();
    return { ok: false, stopReason: `HTTP_STATUS_${status || 'UNKNOWN'}`, blocked: false,
      receipt: dosirakReceipt({ url: url.href, status, contentType, observedAt }) };
  }

  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of response) {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) {
        response.destroy();
        return { ok: false, stopReason: 'RESPONSE_TOO_LARGE', blocked: false,
          receipt: dosirakReceipt({ url: url.href, status, contentType, bytes, observedAt }) };
      }
      chunks.push(chunk);
    }
  } catch {
    return { ok: false, stopReason: 'PUBLIC_HTTP_BODY_FAILED', blocked: false,
      receipt: dosirakReceipt({ url: url.href, status, contentType, bytes, observedAt }) };
  }
  const raw = Buffer.concat(chunks, bytes);
  const responseSha256 = createHash('sha256').update(raw).digest('hex');
  const receipt = dosirakReceipt({ url: url.href, status, contentType, bytes, responseSha256, observedAt });
  const body = raw.toString('utf8');
  if (isStrongPublicChallenge(response.headers, body)) return { ok: false, stopReason: 'VISIBLE_OR_HEADER_CHALLENGE', blocked: true, receipt };
  const mime = String(contentType ?? '').split(';', 1)[0].trim().toLowerCase();
  if (!(mime === 'application/json' || /^application\/[a-z0-9.+-]+\+json$/i.test(mime))) {
    return { ok: false, stopReason: 'JSON_CONTENT_TYPE_REQUIRED', blocked: false, receipt };
  }
  let value;
  try { value = JSON.parse(body); } catch { return { ok: false, stopReason: 'JSON_PARSE_FAILED', blocked: false, receipt }; }
  return { ok: true, stopReason: null, blocked: false, receipt, value };
}

async function collectDosirakCatalogue(report, prior, options = {}) {
  const bundleUrl = report.frontier.find(row => /\/dist\/js\/app\.bundle\.js(?:\?|$)/i.test(row.url ?? ''))?.url
    ?? prior?.frontier?.find(row => /\/dist\/js\/app\.bundle\.js(?:\?|$)/i.test(row.url ?? ''))?.url
    ?? prior?.receipts?.find(row => /\/dist\/js\/app\.bundle\.js(?:\?|$)/i.test(row.requestUrl ?? ''))?.requestUrl;
  if (!bundleUrl) {
    report.contracts.push({ operation: 'observed_public_source_resource', state: 'source_contract_unavailable', stopReason: 'OBSERVED_BUNDLE_URL_MISSING' });
    report.frontier.push({ url: null, label: 'dosirak_product_search_contract', state: 'pending', stopReason: 'OBSERVED_BUNDLE_URL_MISSING' });
    return;
  }

  const source = await readBatch01Resource({ merchantId: 'dosirak1', url: bundleUrl });
  report.receipts.push(...source.receipts);
  if (source.blocked) {
    report.status = source.state;
    report.frontier.push({ url: source.url, label: 'observed_public_source_resource', state: 'blocked', stopReason: source.stopReason,
      sourceReceiptId: source.receipts[0]?.id ?? null });
    return;
  }
  const sourceBody = source.transientBody ?? '';
  const sourceContractVerified = source.state === 'http_200_resource'
    && sourceBody.includes(`https://${DOSIRAK_API_HOST}`)
    && sourceBody.includes('/product/web/product')
    && sourceBody.includes('/product/continent')
    && sourceBody.includes('/product/country')
    && sourceBody.includes('countryId: sCountrys.join');
  const sourceReceiptId = source.receipts[0]?.id ?? null;
  report.contracts.push({ operation: 'observed_public_source_resource', state: sourceContractVerified ? 'source_contract_verified' : 'source_contract_changed',
    method: 'GET', receiptId: sourceReceiptId, requestedUrl: source.url, endpointHost: DOSIRAK_API_HOST,
    endpointPath: '/api/v1/product/web/product', requestFieldNames: ['countryId'], requestFieldSource: 'selectedCountrys.join(",")',
    bootstrapPaths: ['/api/v1/product/continent', '/api/v1/product/country'], responsePath: '$.resultValue.productJoinedProduct',
    sourceOnly: false, endpointReplay: false });
  if (!sourceContractVerified) {
    report.frontier.push({ url: source.url, label: 'dosirak_product_search_contract', state: 'pending', stopReason: 'SOURCE_CONTRACT_CHANGED', sourceReceiptId });
    return;
  }

  const bootstrapRows = [];
  for (const [name, pathName] of [['continent_bootstrap', '/product/continent'], ['country_bootstrap', '/product/country']]) {
    const resourceUrl = `${DOSIRAK_API_BASE}${pathName}`;
    const resource = await readPublicResource(resourceUrl, { allowedHosts: [DOSIRAK_API_HOST], maxBytes: 1024 * 1024, timeoutMs: 20_000 });
    if (resource.receipt) report.receipts.push({ ...resource.receipt, checkedAt: resource.receipt.observedAt });
    const receiptId = resource.receipt?.id ?? null;
    if (!resource.ok) {
      const blocked = resource.blocked === true || [401, 403, 418, 429].includes(resource.status);
      report.contracts.push({ operation: name, state: blocked ? 'blocked' : 'current_replay_unavailable', method: 'GET', receiptId,
        requestUrl: resource.url, responseStatus: resource.status, contentType: resource.contentType, stopReason: resource.stopReason,
        browserUsed: false, cookiesSent: false, authorizationSent: false });
      report.frontier.push({ url: resource.url, label: name, state: blocked ? 'blocked' : 'pending', stopReason: resource.stopReason, sourceReceiptId: receiptId });
      if (blocked) { report.status = resource.status ? `blocked_http_${resource.status}` : 'blocked_public_challenge'; return; }
      return;
    }
    let rows;
    try { rows = JSON.parse(resource.body); } catch { rows = null; }
    const mime = String(resource.contentType ?? '').split(';', 1)[0].trim().toLowerCase();
    if (isStrongPublicChallenge(null, resource.body) || mime !== 'application/json' || !Array.isArray(rows)) {
      report.contracts.push({ operation: name, state: 'schema_unverified', method: 'GET', receiptId, requestUrl: resource.url,
        responseStatus: resource.status, contentType: resource.contentType, rowCount: Array.isArray(rows) ? rows.length : null,
        stopReason: isStrongPublicChallenge(null, resource.body) ? 'VISIBLE_CHALLENGE' : 'JSON_ARRAY_REQUIRED' });
      report.frontier.push({ url: resource.url, label: name, state: 'pending', stopReason: 'SCHEMA_UNVERIFIED', sourceReceiptId: receiptId });
      return;
    }
    bootstrapRows.push({ name, rows, receiptId, requestUrl: resource.url });
    report.contracts.push({ operation: name, state: 'live_replay_verified', method: 'GET', receiptId, requestUrl: resource.url,
      responseStatus: resource.status, contentType: resource.contentType, resultCount: rows.length,
      browserUsed: false, cookiesSent: false, authorizationSent: false });
  }

  const countries = bootstrapRows.find(row => row.name === 'country_bootstrap')?.rows ?? [];
  const activeCountryIds = [...new Set(countries.filter(row => row?.isUse === true && typeof row.countryId === 'string' && /^[A-Z]{3}$/.test(row.countryId))
    .map(row => row.countryId))];
  const requestedCountryIds = Array.isArray(options.dosirakCountryIds) ? [...new Set(options.dosirakCountryIds)] : activeCountryIds;
  const countryIds = requestedCountryIds.filter(id => activeCountryIds.includes(id));
  if (!countryIds.length || countryIds.length !== requestedCountryIds.length || countryIds.length > 200) {
    report.contracts.push({ operation: 'product_search', state: 'current_replay_unavailable', method: 'POST', requestUrl: DOSIRAK_PRODUCT_LIST_URL,
      stopReason: 'OBSERVED_ACTIVE_COUNTRY_IDS_UNAVAILABLE', observedCountryRows: countries.length, selectedActiveCountryCount: countryIds.length,
      sourceReceiptId, countryBootstrapReceiptId: bootstrapRows.find(row => row.name === 'country_bootstrap')?.receiptId ?? null });
    report.frontier.push({ url: DOSIRAK_PRODUCT_LIST_URL, label: 'observed_public_product_search', state: 'pending', stopReason: 'OBSERVED_ACTIVE_COUNTRY_IDS_UNAVAILABLE' });
    return;
  }

  const result = await postObservedDosirakProductList(countryIds);
  if (result.receipt) report.receipts.push(result.receipt);
  const receiptId = result.receipt?.id ?? null;
  if (!result.ok) {
    report.contracts.push({ operation: 'product_search', state: result.blocked ? 'blocked' : 'current_replay_unavailable', method: 'POST',
      receiptId, requestUrl: DOSIRAK_PRODUCT_LIST_URL, responseStatus: result.receipt?.responseStatus ?? null,
      contentType: result.receipt?.contentType ?? null, stopReason: result.stopReason, requestFieldNames: ['countryId'],
      selectedCountryCount: countryIds.length, sourceReceiptId, countryBootstrapReceiptId: bootstrapRows.find(row => row.name === 'country_bootstrap')?.receiptId ?? null,
      browserUsed: false, cookiesSent: false, authorizationSent: false });
    report.frontier.push({ url: DOSIRAK_PRODUCT_LIST_URL, label: 'observed_public_product_search', state: result.blocked ? 'blocked' : 'pending',
      stopReason: result.stopReason, sourceReceiptId: receiptId });
    if (result.blocked) report.status = result.receipt?.responseStatus ? `blocked_http_${result.receipt.responseStatus}` : 'visible_challenge';
    return;
  }

  const resultValue = result.value?.resultValue;
  const products = resultValue?.productJoinedProduct;
  if (!Array.isArray(products)) {
    report.contracts.push({ operation: 'product_search', state: 'schema_unverified', method: 'POST', receiptId, requestUrl: DOSIRAK_PRODUCT_LIST_URL,
      responseStatus: result.receipt.responseStatus, contentType: result.receipt.contentType, stopReason: 'PRODUCT_LIST_ARRAY_NOT_FOUND',
      responseTopLevelKeys: result.value && typeof result.value === 'object' ? Object.keys(result.value).filter(key => !/(?:token|auth|session|account|email|phone|secret|cookie|credential)/i.test(key)).slice(0, 50) : [],
      sourceReceiptId, countryBootstrapReceiptId: bootstrapRows.find(row => row.name === 'country_bootstrap')?.receiptId ?? null,
      selectedCountryCount: countryIds.length, browserUsed: false, cookiesSent: false, authorizationSent: false });
    report.frontier.push({ url: DOSIRAK_PRODUCT_LIST_URL, label: 'observed_public_product_search', state: 'pending',
      stopReason: 'PRODUCT_LIST_ARRAY_NOT_FOUND', sourceReceiptId: receiptId });
    return;
  }

  const parseAmount = value => {
    if (Number.isSafeInteger(value) && value >= 0) return value;
    if (typeof value === 'string' && /^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(value.trim())) {
      const amount = Number(value.replace(/,/g, ''));
      return Number.isSafeInteger(amount) && amount >= 0 ? amount : null;
    }
    return null;
  };
  const seenCodes = new Set();
  for (const product of products) {
    const code = typeof product?.code === 'string' || Number.isSafeInteger(product?.code) ? String(product.code) : '';
    const title = typeof product?.name === 'string' ? product.name.trim() : '';
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(code) || !title || seenCodes.has(code)) continue;
    seenCodes.add(code);
    const amount = parseAmount(product.price);
    const fields = ['type', 'sourceLocalId', 'title', 'url'];
    if (amount !== null) fields.push('price');
    report.records.push({ type: 'TravelOffering', sourceLocalId: code, title,
      url: safeUrl(`${DOSIRAK_PRODUCT_DETAIL_BASE}${encodeURIComponent(code)}`), description: null, brand: null,
      price: { amount, currency: amount === null ? null : 'KRW', priceText: amount === null ? null : `${amount}원` },
      rating: { value: null, best: null, worst: null, reviewCount: null, ratingCount: null }, variants: [], reviewSamples: [],
      evidence: [{ receiptId, locator: '$.resultValue.productJoinedProduct[*]', fields }] });
  }
  report.contracts.push({ operation: 'product_search', state: 'live_replay_verified', method: 'POST', receiptId,
    requestUrl: DOSIRAK_PRODUCT_LIST_URL, responseStatus: result.receipt.responseStatus, contentType: result.receipt.contentType,
    resultCount: report.records.length, sourceArrayCount: products.length, selectedCountryCount: countryIds.length,
    responseTopLevelKeys: result.value && typeof result.value === 'object' ? Object.keys(result.value).filter(key => !/(?:token|auth|session|account|email|phone|secret|cookie|credential)/i.test(key)).slice(0, 50) : [],
    resultValueKeys: resultValue && typeof resultValue === 'object' ? Object.keys(resultValue).filter(key => !/(?:token|auth|session|account|email|phone|secret|cookie|credential)/i.test(key)).slice(0, 100) : [],
    applicationResultCode: ['string', 'number', 'boolean'].includes(typeof result.value?.resultCode) ? result.value.resultCode : null,
    sourceProductKeyNames: [...new Set(products.flatMap(product => product && typeof product === 'object' ? Object.keys(product) : []))]
      .filter(key => !/(?:token|auth|session|account|email|phone|secret|cookie|credential)/i.test(key)).slice(0, 100),
    selectionSource: 'active_countryIds_from_observed_public_country_bootstrap', requestFieldNames: ['countryId'],
    detailRouteSource: 'observed_public_bundle:/Product/Detail/1/{productCode}',
    sourceReceiptId, countryBootstrapReceiptId: bootstrapRows.find(row => row.name === 'country_bootstrap')?.receiptId ?? null,
    browserUsed: false, cookiesSent: false, authorizationSent: false });
}

async function collectHalfclubCatalogue(report, prior) {
  const currentResource = pattern => report.frontier.find(row => row.state === 'pending_resource' && pattern.test(row.url ?? ''))?.url
    ?? prior?.frontier?.find(row => pattern.test(row.url ?? ''))?.url
    ?? prior?.receipts?.find(row => pattern.test(row.requestUrl ?? ''))?.requestUrl
    ?? null;
  const homeContract = report.contracts.find(row => row.operation === 'public_runtime_config') ?? null;
  const runtimeSiteCd = homeContract?.publicConfig?.siteCd ?? null;
  const requiredSources = [
    { operation: 'observed_search_store_source', pattern: /\/search-B[^/]*\.js(?:\?|$)/i },
    { operation: 'observed_home_listing_caller', pattern: /\/index-[^/]*\.js(?:\?|$)/i },
    { operation: 'observed_request_builder_source', pattern: /\/entry-[^/]*\.js(?:\?|$)/i },
  ];
  const sourceBodies = new Map();
  for (const source of requiredSources) {
    const url = currentResource(source.pattern);
    if (!url) {
      report.contracts.push({ operation: source.operation, state: 'source_contract_unavailable', stopReason: 'OBSERVED_SOURCE_URL_MISSING' });
      report.frontier.push({ url: null, label: source.operation, state: 'pending', stopReason: 'OBSERVED_SOURCE_URL_MISSING' });
      return;
    }
    const result = await readBatch01Resource({ merchantId: 'halfclub1', url });
    report.receipts.push(...result.receipts);
    const receiptId = result.receipts[0]?.id ?? null;
    const frontierRow = report.frontier.find(row => row.url === url);
    if (result.blocked) {
      if (frontierRow) { frontierRow.state = 'blocked'; frontierRow.stopReason = result.stopReason; }
      report.contracts.push({ operation: source.operation, state: 'blocked', method: 'GET', receiptId, requestUrl: result.url,
        responseStatus: result.status, contentType: result.contentType, stopReason: result.stopReason });
      report.frontier.push({ url: result.url, label: source.operation, state: 'blocked', stopReason: result.stopReason, sourceReceiptId: receiptId });
      report.status = result.status ? `blocked_http_${result.status}` : 'visible_challenge';
      return;
    }
    const body = result.transientBody ?? '';
    const sourceValid = result.state === 'http_200_resource' && body.length > 0;
    if (frontierRow) { frontierRow.state = sourceValid ? 'source_inspected' : 'pending'; frontierRow.stopReason = result.stopReason ?? null; }
    sourceBodies.set(source.operation, body);
    report.contracts.push({ operation: source.operation, state: sourceValid ? 'source_contract_verified' : 'source_contract_unavailable',
      method: 'GET', receiptId, requestUrl: result.url, responseStatus: result.status, contentType: result.contentType,
      ...(source.operation === 'observed_search_store_source' ? {
        initializerSiteCd: body.match(/siteCd\s*:\s*["']([^"']+)["']/)?.[1] ?? null,
        initializerDevice: body.match(/device\s*:\s*["']([^"']+)["']/)?.[1] ?? null,
        initializerLimit: body.match(/limit\s*:\s*["']([^"']+)["']/)?.[1] ?? null,
        initializerSortSeq: body.match(/sortSeq\s*:\s*["']([^"']+)["']/)?.[1] ?? null,
        siteCdSetterExported: /setSiteCd\s*:/.test(body),
      } : source.operation === 'observed_home_listing_caller' ? {
        callerInitializerSiteCd: body.match(/siteCd\s*:\s*["']([^"']+)["']/)?.[1] ?? null,
        callerInitializerLimit: body.match(/limit\s*:\s*["']([^"']+)["']/)?.[1] ?? null,
        callerInitializerSortSeq: body.match(/sortSeq\s*:\s*["']([^"']+)["']/)?.[1] ?? null,
        callerHasConditionalFilterOverride: /isNewOnlyHalf\s*\|\|\s*\(b\.selAcntCd/.test(body),
      } : {
        endpointPathObserved: body.includes('searches/prdList/') || body.includes('searches/prdList/?'),
        siteCdReadFromRuntimeConfig: /siteCd="\+se\("siteCd"\)/.test(body),
        deviceValueObserved: body.includes('device=pc'),
      }),
      browserXhrCaptured: false });
    if (!sourceValid) {
      report.frontier.push({ url: result.url, label: source.operation, state: 'pending', stopReason: result.stopReason ?? 'SOURCE_RESOURCE_UNAVAILABLE', sourceReceiptId: receiptId });
      return;
    }
  }

  const searchSource = sourceBodies.get('observed_search_store_source') ?? '';
  const callerSource = sourceBodies.get('observed_home_listing_caller') ?? '';
  const requestSource = sourceBodies.get('observed_request_builder_source') ?? '';
  const contractVerified = homeContract?.state === 'public_config_verified'
    && typeof runtimeSiteCd === 'string' && /^[0-9]{1,3}$/.test(runtimeSiteCd)
    && searchSource.includes('siteCd:"2"') && callerSource.includes('siteCd:"2"')
    && callerSource.includes('limit:"0,40"') && callerSource.includes('sortSeq:"12"')
    && requestSource.includes('searches/prdList/') && /siteCd="\+se\("siteCd"\)/.test(requestSource)
    && requestSource.includes('device=pc');
  if (!contractVerified) {
    report.contracts.push({ operation: 'product_search', state: 'current_replay_unavailable', stopReason: 'RUNTIME_CONFIG_OR_CALLER_CONTRACT_UNVERIFIED',
      runtimeSiteCd: runtimeSiteCd ?? null, browserXhrCaptured: false });
    report.frontier.push({ url: null, label: 'observed_public_product_search', state: 'pending', stopReason: 'RUNTIME_CONFIG_OR_CALLER_CONTRACT_UNVERIFIED' });
    return;
  }

  // The caller template defaults to siteCd=2, but the shared request builder
  // takes siteCd from the current public runtime config (siteCd=1). Keep both
  // observations and replay the runtime value; no browser XHR is claimed.
  const params = new URLSearchParams({ siteCd: runtimeSiteCd, device: 'pc', limit: '0,40', sortSeq: '12', icnSet: '온리하프' });
  const requestUrl = `https://hapix.halfclub.com/searches/prdList/?${params.toString()}`;
  const result = await readBatch01Resource({ merchantId: 'halfclub1', url: requestUrl });
  report.receipts.push(...result.receipts);
  const receiptId = result.receipts[0]?.id ?? null;
  if (result.blocked) {
    report.contracts.push({ operation: 'product_search', state: 'blocked', method: 'GET', receiptId, requestUrl: result.url,
      responseStatus: result.status, contentType: result.contentType, stopReason: result.stopReason,
      siteCd: runtimeSiteCd, siteCdSource: 'home_public_runtime_config', storeInitializerSiteCd: '2', browserXhrCaptured: false });
    report.frontier.push({ url: result.url, label: 'observed_public_product_search', state: 'blocked', stopReason: result.stopReason, sourceReceiptId: receiptId });
    report.status = result.status ? `blocked_http_${result.status}` : 'visible_challenge';
    return;
  }
  let value;
  try { value = JSON.parse(result.transientBody ?? ''); } catch { value = null; }
  const mime = String(result.contentType ?? '').split(';', 1)[0].trim().toLowerCase();
  const hits = value?.data?.result?.hits?.hits;
  const deals = value?.data?.deal_list?.hits?.hits;
  if (result.state !== 'http_200_resource' || mime !== 'application/json' || !Array.isArray(hits) || !Array.isArray(deals)) {
    report.contracts.push({ operation: 'product_search', state: 'schema_unverified', method: 'GET', receiptId, requestUrl: result.url,
      responseStatus: result.status, contentType: result.contentType, stopReason: 'SEARCH_RESPONSE_SCHEMA_UNVERIFIED',
      siteCd: runtimeSiteCd, siteCdSource: 'home_public_runtime_config', storeInitializerSiteCd: '2', browserXhrCaptured: false });
    report.frontier.push({ url: result.url, label: 'observed_public_product_search', state: 'pending', stopReason: 'SEARCH_RESPONSE_SCHEMA_UNVERIFIED', sourceReceiptId: receiptId });
    return;
  }

  const searchRecords = [];
  for (const hit of hits.slice(0, 100)) {
    const record = halfclubItemRecord(hit?._source, receiptId, '$.data.result.hits.hits[*]._source');
    if (!record) continue;
    const priorRecord = searchRecords.find(item => item.sourceLocalId === record.sourceLocalId);
    if (!priorRecord) searchRecords.push(record);
  }
  report.records.push(...searchRecords);
  const total = value?.data?.result?.hits?.total;
  const totalValue = Number.isSafeInteger(total?.value) && total.value >= 0 ? total.value : null;
  const sourceReceipts = requiredSources.map(source => report.contracts.find(row => row.operation === source.operation)?.receiptId).filter(Boolean);
  report.contracts.push({ operation: 'product_search', state: 'live_replay_verified', method: 'GET', receiptId,
    requestUrl: result.url, responseStatus: result.status, contentType: result.contentType,
    resultCount: searchRecords.length, pageHitCount: hits.length, dealHitCount: deals.length, totalHitCount: totalValue,
    query: { siteCd: runtimeSiteCd, siteCdSource: 'home_public_runtime_config', storeInitializerSiteCd: '2', device: 'pc', limit: '0,40', sortSeq: '12', filter: '온리하프', keywordApplied: false },
    sourceReceiptIds: sourceReceipts, browserXhrCaptured: false, cookiesSent: false, authorizationSent: false });
  if (totalValue !== null && totalValue > hits.length) {
    report.frontier.push({ url: result.url, label: 'halfclub_product_list_pagination', state: 'pending', sourceReceiptId: receiptId,
      pageStart: hits.length, observedTotal: totalValue, stopReason: 'BOUNDED_FIRST_PAGE_SAMPLE' });
  }
  if (deals.length) report.frontier.push({ url: result.url, label: 'halfclub_deal_list_mapping', state: 'pending', sourceReceiptId: receiptId,
    observedDealCount: deals.length, stopReason: 'DEAL_LIST_NOT_NORMALIZED' });

  const firstHit = hits.find(hit => String(hit?._source?.prdNo ?? '') === String(searchRecords[0]?.sourceLocalId ?? ''));
  const firstSourceUrl = typeof firstHit?._source?.appPrdDtlUrl === 'string' ? safeUrl(firstHit._source.appPrdDtlUrl) : null;
  if (!firstSourceUrl || !searchRecords.length) return;
  const detail = await readBatch01Page({ merchantId: 'halfclub1', url: firstSourceUrl, includeHtml: true });
  report.receipts.push(...detail.receipts);
  const detailReceiptId = detail.receipts[0]?.id ?? null;
  if (detail.blocked) {
    report.contracts.push({ operation: 'observed_product_detail', state: 'blocked', receiptId: detailReceiptId,
      requestedUrl: firstSourceUrl, responseStatus: detail.receipts[0]?.responseStatus ?? null, stopReason: detail.stopReason, recordCount: 0 });
    report.frontier.push({ url: firstSourceUrl, label: 'observed_product_detail', state: 'blocked', stopReason: detail.stopReason, sourceReceiptId: detailReceiptId });
    report.status = detail.state;
    return;
  }
  const data = detail.transientHtml ? halfclubPdpData(detail.transientHtml) : null;
  const productInfo = data?.productInfo;
  const detailId = productInfo?.prdNo == null ? null : String(productInfo.prdNo);
  const target = report.records.find(record => record.sourceLocalId === detailId);
  const sameTitle = typeof productInfo?.prdNm === 'string' && productInfo.prdNm.trim() === target?.title;
  if (detail.state !== 'http_200_html' || !detailReceiptId || !target || !sameTitle) {
    report.contracts.push({ operation: 'observed_product_detail', state: 'detail_mapping_unverified', receiptId: detailReceiptId,
      requestedUrl: firstSourceUrl, finalUrl: detail.parsed?.page?.url ?? null, pageTitle: detail.parsed?.title ?? null,
      productId: detailId, titleMatchesListing: sameTitle, recordCount: 0 });
    report.frontier.push({ url: firstSourceUrl, label: 'observed_product_detail', state: 'pending', sourceReceiptId: detailReceiptId,
      stopReason: 'DETAIL_PRODUCT_ID_OR_TITLE_MISMATCH' });
    return;
  }

  const finalUrl = safeUrl(detail.parsed.page.url) ?? target.url;
  target.url = finalUrl;
  const detailPrice = halfclubSourceNumber(data?.prductPriceInfo?.price);
  target.price.sourceMetrics = { searchDcPrcPc: target.price.amount, detailPrductPriceInfoPrice: detailPrice };
  const searchReviewQty = target.rating.reviewCount;
  const detailReviewTotalCnt = halfclubSourceNumber(productInfo.reviewTotalCnt);
  target.rating.sourceMetrics = { searchReviewQty, detailReviewTotalCnt };
  const variants = halfclubPdpVariants(productInfo);
  if (variants.length) target.variants = variants;
  target.evidence.push({ receiptId: detailReceiptId, locator: 'script#pdp-data.productInfo', fields: [
    'url', ...(detailPrice === null ? [] : ['price']), ...(detailReviewTotalCnt === null ? [] : ['rating', 'rating.detailReviewTotalCnt']), ...(variants.length ? ['variants'] : []),
  ] });
  report.contracts.push({ operation: 'observed_product_detail', state: 'live_replay_verified', receiptId: detailReceiptId,
    requestedUrl: firstSourceUrl, finalUrl, pageTitle: detail.parsed.page.title, sourceLocalId: detailId,
    merchantBrandingConfirmed: /하프클럽/i.test(detail.parsed.page.title ?? ''),
    listPrice: target.price.amount, detailPrice, listReviewQty: searchReviewQty, detailReviewTotalCnt,
    variantCount: variants.length, recordCount: 1, redirectChain: detail.redirects, browserUsed: false });
}

async function collectKurlyWithMaintainedSearch(report, prior) {
  const captured = [];
  const transientBodies = new Map();
  const scopedFetch = async (input, init = {}) => {
    const headers = new Headers(init.headers ?? {});
    if (headers.has('cookie') || headers.has('authorization')) throw Object.assign(new Error('KURLY_CREDENTIALS_NOT_ALLOWED'), { code: 'KURLY_CREDENTIALS_NOT_ALLOWED' });
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    const requestUrl = safeUrl(rawUrl);
    const method = String(init.method ?? input?.method ?? 'GET').toUpperCase();
    let requestHost = null;
    try { requestHost = new URL(rawUrl).hostname.toLowerCase(); } catch {}
    if (!requestUrl || !['api.kurly.com', 'www.kurly.com'].includes(requestHost) || method !== 'GET')
      throw Object.assign(new Error('KURLY_SEARCH_REQUEST_SCOPE_REJECTED'), { code: 'KURLY_SEARCH_REQUEST_SCOPE_REJECTED' });
    const response = await fetch(input, { ...init, credentials: 'omit', redirect: 'manual', cache: 'no-store' });
    const bytes = Buffer.from(await response.clone().arrayBuffer());
    const receiptId = randomUUID();
    const observedAt = new Date().toISOString();
    const contentType = response.headers.get('content-type');
    captured.push({ id: receiptId, requestMethod: method, requestUrl, responseStatus: response.status, contentType,
      bytes: bytes.length, responseSha256: bytes.length ? createHash('sha256').update(bytes).digest('hex') : null,
      observedAt, checkedAt: observedAt, browserUsed: false, cookiesSent: false, authorizationSent: false });
    transientBodies.set(receiptId, bytes.toString('utf8'));
    return response;
  };
  let result;
  try {
    result = await collectConsumerCatalog('삼겹살', { fetchImpl: scopedFetch, perSite: 10, kurlyDetails: 0,
      includeGmarket: false, includeCoupangPartners: false, includeMarketReference: false, includeCoupangDanawa: false,
      sleepImpl: async () => {}, onlySources: ['kurly'], filterMode: 'catalog' });
  } catch (error) {
    result = { sites: { kurly: { error: error?.code ?? 'FAILED' } }, offers: [] };
  }
  report.receipts.push(...captured);
  const receipt = captured[0] ?? null;
  const site = result?.sites?.kurly ?? {};
  const currentBody = receipt ? transientBodies.get(receipt.id) ?? '' : '';
  const currentMime = String(receipt?.contentType ?? '').split(';', 1)[0].toLowerCase();
  const visibleChallenge = /(?:access denied|just a moment\.\.\.|attention required|captcha|verify you are human)/i.test(currentBody.slice(0, 25_000));
  const statusBlocked = [401, 403, 418, 429].includes(receipt?.responseStatus);
  if (!site.error && receipt?.responseStatus === 200 && /application\/json/i.test(currentMime)) {
    const offers = (result.offers ?? []).filter(offer => offer.mall === 'kurly').slice(0, 10);
    report.records.push(...offers.map(offer => {
      const amount = Number.isSafeInteger(offer.price) && offer.price >= 0 ? offer.price : null;
      const count = !offer.reviewsCapped && Number.isSafeInteger(offer.reviews) && offer.reviews >= 0 ? offer.reviews : null;
      const fields = ['type', 'sourceLocalId', 'title', 'url'];
      if (amount !== null) fields.push('price');
      if (count !== null) fields.push('rating');
      return { type: 'RetailProduct', sourceLocalId: String(offer.id).replace(/^kurly:/, ''), title: offer.name, url: safeUrl(offer.url),
        description: null, brand: null, price: { amount, currency: amount === null ? null : 'KRW', priceText: amount === null ? null : `${amount}원` },
        rating: { value: null, best: null, worst: null, reviewCount: count, ratingCount: null }, variants: [], reviewSamples: [],
        evidence: [{ receiptId: receipt.id, locator: '$.data.listSections[*].data.items[*]', fields }] };
    }));
    report.contracts.push({ operation: 'product_search', state: 'live_replay_verified', method: 'GET', receiptId: receipt.id,
      requestUrl: receipt.requestUrl, resultCount: offers.length, query: '삼겹살', browserUsed: false, cookiesSent: false, authorizationSent: false });
  } else {
    const stopReason = statusBlocked ? `HTTP_${receipt.responseStatus}` : visibleChallenge ? 'VISIBLE_CHALLENGE'
      : /(?:text\/html|application\/xhtml\+xml)/i.test(receipt?.contentType ?? '') ? 'PUBLIC_SEARCH_CONTENT_TYPE_MISMATCH' : site.error ?? 'PUBLIC_SEARCH_RESPONSE_NOT_JSON';
    report.contracts.push({ operation: 'product_search', state: statusBlocked || visibleChallenge ? 'blocked' : 'current_replay_unavailable',
      method: 'GET', ...(receipt ? { currentAttemptReceiptId: receipt.id, requestUrl: receipt.requestUrl, responseStatus: receipt.responseStatus, contentType: receipt.contentType } : {}),
      stopReason, browserUsed: false, cookiesSent: false, authorizationSent: false });
    report.frontier.push({ url: receipt?.requestUrl ?? null, label: 'observed_public_product_search', state: statusBlocked || visibleChallenge ? 'blocked' : 'replay_unavailable',
      stopReason, sourceReceiptId: receipt?.id ?? null });
    const priorContract = prior?.contracts?.find(contract => contract.operation === 'product_search') ?? null;
    if (!statusBlocked && !visibleChallenge && prior?.records?.length && priorContract?.receiptId) {
      const priorReceipt = prior.receipts?.find(row => (row.id ?? row.receiptId) === priorContract.receiptId);
      if (priorReceipt) report.receipts.push({ ...priorReceipt, replayStatus: 'prior_live_replay_not_current' });
      report.records.push(...prior.records.map(withoutReviewBodies));
      report.contracts.push({ operation: 'product_search', state: 'prior_live_replay_current_replay_unavailable', method: 'GET',
        receiptId: priorContract.receiptId, currentAttemptReceiptId: receipt?.id ?? null, requestUrl: priorContract.requestUrl,
        resultCount: priorContract.resultCount ?? prior.records.length, currentStopReason: stopReason,
        browserUsed: false, cookiesSent: false, authorizationSent: false });
    }
    if (statusBlocked || visibleChallenge) report.status = statusBlocked ? `blocked_http_${receipt.responseStatus}` : 'visible_challenge';
  }
}

/** Collect observed catalogue/detail routes and known public consumer-search data. */
export async function collectMerchant(merchantId, options = {}) {
  const merchant = merchantById.get(merchantId);
  if (!merchant) throw Object.assign(new Error('MERCHANT_NOT_IN_BATCH_01'), { code: 'MERCHANT_NOT_IN_BATCH_01' });
  const saved = loadSavedBatch();
  const prior = saved?.merchants?.find(row => row.merchantId === merchantId) ?? null;
  const includeHome = options.includeHome !== false;
  const limit = Number.isInteger(options.maxPages) ? Math.max(1, Math.min(12, options.maxPages))
    : merchantId === 'shockzkr' ? 3 : ['misope', 'refurlab'].includes(merchantId) ? 5 : 4;
  const report = { merchantId, siteUrl: merchant.siteUrl, receipts: [], records: [], contracts: [], operations: {}, frontier: [], status: 'not_started' };

  if (merchantId === 'nbtnaver') {
    // The independent public listing lane does not replay saved rejected
    // search/review/detail origins. It can refresh promotion cards while
    // retaining the historical SmartStore detail stop in its own report.
    return collectNaverShoppingPublic(merchantId, options);
  }

  // A confirmed block is a hard stop for this merchant host; surface saved evidence without retrying.
  if (prior?.status === 'blocked_http_403' || prior?.receipts?.some(row => [401, 403, 418, 429].includes(row.responseStatus ?? row.httpStatus))) {
    report.receipts = prior.receipts ?? [];
    report.records = (prior.records ?? []).map(withoutReviewBodies);
    report.contracts = prior.contracts ?? [];
    report.operations = prior.operations ?? {};
    report.frontier = (prior.frontier ?? []).map(link => ({ ...link, label: safeLinkLabel(link) }));
    report.status = prior.status ?? 'blocked_http_status';
    return report;
  }

  const explicit = Array.isArray(options.observedUrls) ? options.observedUrls : null;
  let storedSeeds = explicit ?? (prior?.frontier ?? []).filter(link => usefulObservedOfferingUrl(merchantId, link.url))
    .sort((a, b) => routePriority(merchantId, a.url) - routePriority(merchantId, b.url));
  if (!explicit && merchantId === 'shockzkr') {
    const firstDetail = storedSeeds.find(link => isObservedDetailPage(merchantId, link.url));
    const firstReview = storedSeeds.find(link => /itemuse\.php/i.test(link.url));
    storedSeeds = [firstDetail, firstReview].filter(Boolean);
  }
  if (!explicit && merchantId === 'toyotarent') {
    const firstCategory = storedSeeds.find(link => /page=cars(?:&|$)/i.test(link.url) && !/page=carsview/i.test(link.url));
    const firstDetail = storedSeeds.find(link => /page=carsview/i.test(link.url));
    storedSeeds = [firstCategory, firstDetail, ...storedSeeds.filter(link => /page=carsview/i.test(link.url) && link !== firstDetail)].filter(Boolean);
  }
  if (!explicit && merchantId === '60saju') {
    const yearly = storedSeeds.find(link => /\/yearly(?:\/|\?|$)/i.test(link.url));
    storedSeeds = [yearly, ...storedSeeds.filter(link => link !== yearly)].filter(Boolean);
  }
  if (!explicit && ['misope', 'refurlab'].includes(merchantId)) {
    const reviewPage = storedSeeds.find(link => /board\/list\.php\?[^#]*bdid=goodsreview/i.test(link.url));
    const details = storedSeeds.filter(link => isObservedDetailPage(merchantId, link.url));
    storedSeeds = [reviewPage, ...details].filter(Boolean);
  }
  const queue = [];
  if (includeHome) queue.push({ url: merchant.siteUrl, label: null, sourceReceiptId: null });
  for (const item of storedSeeds) queue.push(typeof item === 'string' ? { url: item, label: options.labelsByUrl?.[item] ?? null } : item);
  const maxPages = limit;
  const seen = new Set();
  const receiptsByRequest = new Map();
  let pagesRead = 0;
  for (let index = 0; index < queue.length && pagesRead < maxPages; index++) {
    const candidate = queue[index];
    const safe = safeUrl(candidate?.url);
    if (!safe || seen.has(safe) || !usefulObservedOfferingUrl(merchantId, safe) && safe !== safeUrl(merchant.siteUrl)) continue;
    seen.add(safe);
    const result = await readBatch01Page({ merchantId, url: safe, includeHtml: true });
    pagesRead += 1;
    report.receipts.push(...result.receipts);
    const receiptId = result.receipts[0]?.id ?? null;
    if (receiptId) receiptsByRequest.set(safe, receiptId);
    if (result.blocked) {
      report.status = result.state;
      report.frontier.push({ url: safe, label: safeLinkLabel(candidate), state: 'blocked', stopReason: result.stopReason, sourceReceiptId: receiptId });
      break;
    }
    if (!result.parsed) {
      report.frontier.push({ url: safe, label: safeLinkLabel(candidate), state: result.state, stopReason: result.stopReason, sourceReceiptId: receiptId });
      continue;
    }
    const parsed = result.parsed;
    if (merchantId === 'halfclub1' && safe === safeUrl(merchant.siteUrl)) {
      const publicConfig = halfclubRuntimeConfig(result.transientHtml);
      let publicBaseAllowed = false;
      try { publicBaseAllowed = Boolean(publicConfig?.baseURL && hostAllowed(new URL(publicConfig.baseURL).hostname, ['halfclub.com'])); } catch { /* leave unverified */ }
      report.contracts.push({ operation: 'public_runtime_config', state: publicConfig?.siteCd && publicBaseAllowed ? 'public_config_verified' : 'public_config_unverified',
        receiptId, publicConfig: publicConfig ? {
          baseURL: publicBaseAllowed ? safeUrl(publicConfig.baseURL) : null,
          siteCd: publicConfig.siteCd, mobileDeviceCd: publicConfig.mobileDeviceCd, deviceTypeCd: publicConfig.deviceTypeCd,
        } : null,
        allowedFields: ['baseURL', 'siteCd', 'mobileDeviceCd', 'deviceTypeCd'], persistedPrivateOrAccessKeyFields: false });
    }
    let pageRecords = parsed.records.map(withoutReviewBodies);
    if (!pageRecords.length && isObservedDetailPage(merchantId, safe)) {
      const generated = renderedRecord({ merchant, url: parsed.page.url, pageTitle: parsed.title, description: parsed.description,
        html: result.transientHtml, receiptId, observedLabel: options.labelsByUrl?.[safe] ?? candidate?.label ?? null });
      if (generated) pageRecords = [generated];
    }
    for (const record of pageRecords) {
      const existing = report.records.findIndex(row => row.url === record.url || record.sourceLocalId && row.sourceLocalId === record.sourceLocalId);
      if (existing >= 0) report.records[existing] = { ...report.records[existing], ...record };
      else report.records.push(record);
    }
    const operation = parsed.publicReviewSummary ? 'reviews_list'
      : safe === safeUrl(merchant.siteUrl) ? 'public_home_document'
        : isObservedDetailPage(merchantId, safe) ? 'observed_product_detail' : 'observed_category';
    report.contracts.push({ operation, state: 'live_replay_verified', receiptId, requestedUrl: safe, finalUrl: parsed.page.url, title: parsed.title,
      jsonLdTypes: parsed.jsonLd.map(row => row?.['@type'] ?? null), recordCount: pageRecords.length,
      ...(parsed.publicReviewSummary ? { aggregateReviewCount: parsed.publicReviewSummary.reviewCount, aggregateRating: parsed.publicReviewSummary.ratingValue } : {}) });
    if (parsed.publicReviewSummary) {
      const productId = recordIdFromUrl(safe);
      const target = report.records.find(row => productId && row.sourceLocalId === productId)
        ?? (merchantId === 'shockzkr' ? report.records.find(row => /openrun pro 2/i.test(row.title)) : null);
      if (target) {
        if (parsed.publicReviewSummary.reviewCount !== null) target.rating.reviewCount = parsed.publicReviewSummary.reviewCount;
        if (parsed.publicReviewSummary.ratingValue !== null) target.rating.value = parsed.publicReviewSummary.ratingValue;
        target.evidence ??= [];
        target.evidence.push({ receiptId, locator: 'document.visible_text:aggregate_review_summary', fields: ['rating'] });
      }
    }
    const existingFrontierUrls = new Set(report.frontier.map(link => link.url));
    for (const link of parsed.anchors) {
      if (usefulObservedOfferingUrl(merchantId, link.url) && !existingFrontierUrls.has(link.url)) {
        const frontierItem = { url: link.url, label: safeLinkLabel(link), observedOn: parsed.page.url, sourceReceiptId: receiptId, state: 'pending' };
        report.frontier.push(frontierItem); existingFrontierUrls.add(link.url);
        if (pagesRead + queue.length - index - 1 < maxPages) queue.push(frontierItem);
      }
    }
    // MyRealTrip offers are embedded in the observed Next.js page data and those exact product URLs are valid next hops.
    if (merchantId === 'myrealtrip' && report.records[0] && !seen.has(report.records[0].url) && pagesRead + queue.length - index - 1 < maxPages) {
      const first = report.records[0];
      const frontierItem = { url: first.url, label: first.title, observedOn: parsed.page.url, sourceReceiptId: receiptId, state: 'pending' };
      if (!existingFrontierUrls.has(first.url)) { report.frontier.push(frontierItem); queue.push(frontierItem); existingFrontierUrls.add(first.url); }
    }
    if (options.includeObservedResources !== false) {
      for (const resource of parsed.observedResources ?? []) if (!existingFrontierUrls.has(resource.url)) {
        report.frontier.push({ url: resource.url, label: 'observed_public_script', observedOn: parsed.page.url, sourceReceiptId: receiptId, state: 'pending_resource', resourceType: resource.type ?? null });
        existingFrontierUrls.add(resource.url);
      }
    }
  }

  if (merchantId === 'kurly' && options.includeSearch !== false) await collectKurlyWithMaintainedSearch(report, prior);
  if (merchantId === 'dosirak1' && options.includeSearch !== false) await collectDosirakCatalogue(report, prior, options);
  if (merchantId === 'halfclub1' && options.includeSearch !== false) await collectHalfclubCatalogue(report, prior);

  if (report.status === 'not_started') report.status = report.records.length ? 'partial_records_available'
    : report.receipts.some(row => (row.responseStatus ?? row.httpStatus) === 200) ? 'reachable_no_normalized_records' : 'no_public_result';
  const evidenceIdsFor = field => [...new Set(report.records.filter(record => {
    if (field === 'price') return record.price?.amount != null || record.price?.priceText != null;
    if (field === 'rating_value') return record.rating?.value != null;
    if (field === 'rating_count') return record.rating?.reviewCount != null || record.rating?.ratingCount != null;
    return false;
  }).flatMap(record => record.evidence?.filter(item => item.fields?.includes(field === 'rating_value' || field === 'rating_count' ? 'rating' : field)).map(item => item.receiptId) ?? []).filter(Boolean))];
  const searchContracts = report.contracts.filter(contract => contract.operation === 'product_search');
  const detailContracts = report.contracts.filter(contract => contract.operation === 'observed_product_detail' && contract.recordCount > 0);
  const reviewContracts = report.contracts.filter(contract => contract.operation === 'reviews_list');
  const reviewEvidence = [...new Set(reviewContracts.filter(contract => contract.aggregateReviewCount != null)
    .map(contract => contract.receiptId).filter(Boolean))];
  const currentReceiptIds = new Set(report.receipts.filter(row => row.replayStatus !== 'prior_live_replay_not_current').map(row => row.id ?? row.receiptId).filter(Boolean));
  const evidenceState = ids => ids.length ? ids.some(id => currentReceiptIds.has(id)) ? 'replay_verified' : 'prior_replay_only' : 'not_exposed';
    const searchState = searchContracts.some(contract => contract.state === 'live_replay_verified') ? 'replay_verified'
      : searchContracts.some(contract => String(contract.state ?? '').startsWith('prior_live_replay_current_')) ? 'prior_replay_only_current_unavailable'
        : 'not_captured';
  report.operations = {
    product_search: { state: searchState, evidenceReceiptIds: searchContracts.map(contract => contract.receiptId).filter(Boolean) },
    product_detail: { state: detailContracts.length ? evidenceState(detailContracts.map(contract => contract.receiptId).filter(Boolean)) : 'not_exposed', evidenceReceiptIds: detailContracts.map(contract => contract.receiptId).filter(Boolean) },
    price: { state: evidenceState(evidenceIdsFor('price')), evidenceReceiptIds: evidenceIdsFor('price') },
    rating_summary: { state: evidenceState([...new Set([...evidenceIdsFor('rating_value'), ...evidenceIdsFor('rating_count')])]), evidenceReceiptIds: [...new Set([...evidenceIdsFor('rating_value'), ...evidenceIdsFor('rating_count')])] },
    reviews_list: { state: reviewEvidence.length ? evidenceState(reviewEvidence) === 'replay_verified' ? 'aggregate_count_only' : 'prior_aggregate_count_only'
      : reviewContracts.length ? evidenceState(reviewContracts.map(contract => contract.receiptId).filter(Boolean)) === 'replay_verified' ? 'page_replay_no_aggregate' : 'prior_page_replay_no_aggregate'
        : 'not_exposed', evidenceReceiptIds: [...new Set(reviewContracts.map(contract => contract.receiptId).filter(Boolean))] },
  };
  if (merchantId === 'kurly' && options.includeReviews !== false && !/block|challenge/i.test(report.status)) {
    const reviews = await collectBatch01ReviewMetadata('kurly');
    report.receipts.push(...reviews.receipts);
    report.records.push(...reviews.records);
    report.contracts.push(...reviews.contracts);
    report.frontier.push(...reviews.frontier);
    report.operations.reviews_list = reviews.operations.reviews_list;
  }
  if (merchantId === 'dosirak1' && options.includeServiceOptions !== false && !/block|challenge/i.test(report.status)) {
    const supplement = await collectDosirakCatalog({ countryIds: options.dosirakCountryIds ?? null });
    const seenReceiptIds = new Set(report.receipts.map(row => row.id ?? row.receiptId));
    report.receipts.push(...supplement.receipts.filter(row => !seenReceiptIds.has(row.id ?? row.receiptId)));
    report.contracts.push(...supplement.contracts);
    report.frontier.push(...supplement.frontier);
    report.operations.quick_use_day = { ...supplement.operations.quickUseDayOptions, observedOptions: supplement.serviceOptions };
    if (!report.records.length) report.operations.product_search.state = 'live_replay_empty';
  }
  return report;
}

export function getBatch01Merchants() {
  return BATCH_01_IDS.map(merchantId => {
    const merchant = merchantById.get(merchantId);
    if (!merchant) throw new Error(`BATCH_01_MERCHANT_MISSING:${merchantId}`);
    return { ...merchant };
  });
}

export function isPotentialOfferingLink(link) {
  let host = '';
  try { host = new URL(link?.url).pathname.toLowerCase(); } catch { return false; }
  const text = String(link?.text ?? '').toLowerCase();
  const signal = /product|goods|item|detail|experience|activity|tour|package|booking|reservation|rent|car|esim|요금|상품|예약|렌트|투어|체험|옵션|상세|구매|쇼핑|호텔/.test(`${host} ${text}`);
  const excluded = /login|logout|member|mypage|cart|basket|search|privacy|terms|약관|로그인|회원|장바구니|검색|채용/.test(`${host} ${text}`);
  return signal && !excluded;
}

export function safeBatchUrl(url) { return safeUrl(url); }
