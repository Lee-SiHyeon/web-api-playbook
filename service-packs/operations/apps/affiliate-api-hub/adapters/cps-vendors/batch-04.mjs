import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFragment } from 'parse5';
import { readPublicPage, extractPublicPage } from '../../lib/cps-public-reader.mjs';
import { collect as collectShoppingSearch } from '../../../naver-blog-api/research/content-store/grocery-compare.mjs';
import { collectMerchant as collectNativeCatalog } from './rakuten-fwrd-native-public.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '../..');
const TAXONOMY_PATH = path.join(APP_ROOT, 'references/linkprice-cps-vertical-taxonomy.v1.json');
const OUTPUT_PATH = path.join(APP_ROOT, 'references/cps-reverify/batch-04.json');
export const merchantIds = Object.freeze(['rakutentr', 'posty', 'gocity', 'airalo', 'legokr', 'clubclio', 'fwrd', 'babybjorn', 'lotteon', 'crocskr', 'lululemon', 'marshall', 'operandi', 'hbx']);
const OBSERVED_PROVIDER_ROOTS = Object.freeze({ marshall: ['marshall.com'] });
const MAX_PAGES_PER_MERCHANT = 5;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const readJson = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const taxonomy = readJson(TAXONOMY_PATH);
const merchantsById = new Map((taxonomy.merchants ?? []).map(row => [row.merchantId, row]));

function providerRoot(hostname) {
  const labels = hostname.toLowerCase().replace(/\.$/, '').split('.');
  if (labels.length <= 2) return labels.join('.');
  const suffix3 = labels.slice(-3).join('.');
  if (/\.(?:co|or|go|ac|ne|re)\.[a-z]{2}$/i.test(suffix3)) return suffix3;
  return labels.slice(-2).join('.');
}

function allowedHostsFor(merchant) {
  const base = new URL(merchant.siteUrl).hostname.toLowerCase();
  return [...new Set([base, providerRoot(base), ...(OBSERVED_PROVIDER_ROOTS[merchant.merchantId] ?? [])])];
}

function isAllowedUrl(value, roots) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return false;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return roots.some(root => host === root || host.endsWith(`.${root}`));
  } catch { return false; }
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/token|auth|session|password|secret|csrf|email|phone|account|api.?key|access.?key/i.test(key)) url.searchParams.set(key, 'REDACTED');
    }
    return url.href;
  } catch { return null; }
}

function sanitizeReviewText(value, max = 1200) {
  if (typeof value !== 'string') return null;
  return value.replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[이메일]')
    .replace(/(?:\+?82[\s-]?)?0\d{1,2}[\s-]?\d{3,4}[\s-]?\d{4}/g, '[전화번호]')
    .replace(/\b\d{6}[- ]?[1-4]\d{6}\b/g, '[개인식별번호]')
    .replace(/(주문\s*번호|운송장\s*번호?|송장\s*번호?|계좌\s*번호|카드\s*번호)\s*[:：#-]?\s*[A-Z0-9-]{4,}/gi, '$1 [민감정보]')
    .replace(/https?:\/\/\S+/gi, '[링크]').slice(0, max) || null;
}

function httpsFirstPartyUrl(value, roots) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!roots.some(root => host === root || host.endsWith(`.${root}`))) return null;
    url.protocol = 'https:';
    url.hash = '';
    return url.href;
  } catch { return null; }
}

function pageReceipt(page, merchantId, index) {
  const source = page?.receipt ?? {};
  const receiptId = source.receiptId ?? source.id ?? `b04-${merchantId}-${index}`;
  const status = source.httpStatus ?? source.responseStatus ?? source.status ?? page?.status ?? null;
  const contentType = source.contentType ?? page?.contentType ?? null;
  return {
    receiptId,
    method: 'GET',
    requestUrl: safeUrl(source.requestUrl ?? source.url ?? page?.url),
    finalUrl: safeUrl(source.finalUrl ?? page?.url),
    httpStatus: status,
    contentType,
    mime: source.mime ?? (typeof contentType === 'string' ? contentType.split(';', 1)[0].trim().toLowerCase() : null),
    bytes: source.bytes ?? null,
    responseSha256: source.responseSha256 ?? source.sha256 ?? null,
    checkedAt: source.checkedAt ?? source.observedAt ?? new Date().toISOString(),
    browserUsed: false,
    cookiesSent: false,
    authorizationSent: false,
    transport: source.transport ?? 'shared_public_page_reader',
    redirects: (page?.redirects ?? source.redirects ?? []).map(row => ({
      status: row.status ?? row.httpStatus ?? null,
      from: safeUrl(row.from ?? row.requestUrl),
      to: safeUrl(row.to ?? row.location ?? row.finalUrl),
    })),
    ...(source.challengeSignal ? { challengeSignal: source.challengeSignal } : {}),
    ...(typeof page?.stopReason === 'string' ? { stopReason: page.stopReason } : {}),
  };
}

function inferredType(row) {
  if (typeof row?.type === 'string' && row.type) return row.type;
  const schemaTypes = Array.isArray(row?._schemaTypes) ? row._schemaTypes : Array.isArray(row?.schemaTypes) ? row.schemaTypes : Array.isArray(row?.['@type']) ? row['@type'] : row?.['@type'] ? [row['@type']] : [];
  const types = schemaTypes.map(x => String(x).toLowerCase());
  if (types.some(x => /hotel|lodging|trip|tour|event|activity|ticket/.test(x))) return 'TravelOffering';
  if (types.some(x => /product|book/.test(x))) return 'RetailProduct';
  if (types.some(x => /service|software|course/.test(x))) return 'ServiceOffering';
  return 'UnclassifiedOffering';
}

function normalizePrice(row) {
  const raw = row?.price ?? row?.offer ?? row?.offers?.[0] ?? row?.offerObservations?.[0] ?? null;
  if (!raw || (typeof raw !== 'object' && typeof raw !== 'number' && typeof raw !== 'string')) return { amount: null, currency: null, priceText: null };
  let amount = typeof raw === 'object' ? raw.amount ?? raw.value ?? raw.price ?? raw.amountMinor ?? null : raw;
  const currencyValue = typeof raw === 'object' ? raw.currency ?? raw.priceCurrency : row?.priceCurrency ?? row?.currency;
  const currency = typeof currencyValue === 'string' ? currencyValue.toUpperCase() : null;
  if (amount == null && (typeof row?.price === 'number' || typeof row?.price === 'string')) amount = row.price;
  if (amount == null && typeof row?.lowPrice === 'number') amount = row.lowPrice;
  if (typeof raw === 'object' && raw.amountMinor != null && currency) {
    const zeroDecimal = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
    const twoDecimal = new Set(['AED', 'AUD', 'CAD', 'CHF', 'CNY', 'EUR', 'GBP', 'HKD', 'IDR', 'INR', 'NZD', 'SGD', 'THB', 'TWD', 'USD', 'ZAR']);
    amount = zeroDecimal.has(currency) ? Number(raw.amountMinor) : twoDecimal.has(currency) ? Number(raw.amountMinor) / 100 : null;
  }
  return {
    amount: typeof amount === 'number' && Number.isFinite(amount) ? amount : typeof amount === 'string' && /^\d[\d,]*(?:\.\d+)?$/.test(amount.trim()) ? Number(amount.replace(/,/g, '')) : null,
    currency,
    priceText: typeof (raw.priceText ?? raw.text) === 'string' ? (raw.priceText ?? raw.text).slice(0, 240) : null,
  };
}

function normalizeRating(row) {
  const raw = row?.rating ?? row?.aggregateRating ?? row?.ratingAggregate ?? null;
  if (!raw || typeof raw !== 'object') return null;
  const numeric = (value) => value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
  const count = value => value != null && /^\d+$/.test(String(value).replace(/,/g, '')) && Number.isSafeInteger(Number(String(value).replace(/,/g, ''))) ? Number(String(value).replace(/,/g, '')) : null;
  const result = { value: numeric(raw.value ?? raw.ratingValue), best: numeric(raw.best ?? raw.bestRating), worst: numeric(raw.worst ?? raw.worstRating), reviewCount: count(raw.reviewCount), ratingCount: count(raw.ratingCount) };
  return Object.values(result).some(value => value != null) ? result : null;
}

function normalizeRecord(row, merchant, pageUrl, receiptId, { locator = 'structured_page_data' } = {}) {
  if (!row || typeof row !== 'object') return null;
  const title = typeof (row.title ?? row.name) === 'string' ? (row.title ?? row.name).replace(/\s+/g, ' ').trim().slice(0, 500) : null;
  if (!title || /^\[(?:TRUNCATED|REDACTED)\]$/i.test(title)) return null;
  const rawUrl = row.url ?? row.canonicalUrl ?? row.productUrl ?? row.detailUrl ?? row.link ?? null;
  const placeholderUrl = typeof rawUrl === 'string' && /^\[(?:링크|LINK|TRUNCATED|REDACTED)\]$/i.test(rawUrl.trim());
  let recordUrl = null;
  try {
    const resolved = rawUrl && !placeholderUrl ? new URL(rawUrl, pageUrl) : null;
    if (resolved && isAllowedUrl(resolved.href, allowedHostsFor(merchant))) { resolved.protocol = 'https:'; recordUrl = safeUrl(resolved.href); }
  } catch { recordUrl = null; }
  if (!recordUrl && pageUrl && (rawUrl == null || placeholderUrl)) {
    const schemaTypes = Array.isArray(row?._schemaTypes) ? row._schemaTypes : Array.isArray(row?.schemaTypes) ? row.schemaTypes : Array.isArray(row?.['@type']) ? row['@type'] : row?.['@type'] ? [row['@type']] : [];
    const knownOffering = /product|service|hotel|lodging|tour|trip|activity|pass|esim|ticket/i.test(`${row.type ?? ''} ${schemaTypes.join(' ')}`);
    const pagePath = new URL(pageUrl).pathname;
    const detailPath = /\/(?:product|goodsView|item|items|detail)\/[^/]+/i.test(pagePath) || /\/products\/[^/]+\/[^/]+/i.test(pagePath);
    if (knownOffering && detailPath && isAllowedUrl(pageUrl, allowedHostsFor(merchant))) recordUrl = safeUrl(pageUrl);
  }
  const price = normalizePrice(row);
  const rating = normalizeRating(row);
  const variants = Array.isArray(row.variants) ? row.variants.slice(0, 40) : Array.isArray(row.hasVariant) ? row.hasVariant.slice(0, 40) : [];
  const reviews = Array.isArray(row.reviewSamples) ? row.reviewSamples : Array.isArray(row.reviews) ? row.reviews : Array.isArray(row.review) ? row.review : row.review ? [row.review] : [];
  const actualFields = ['type', ...(row.sourceLocalId ?? row.sku ?? row.gtin ?? row.mpn ?? row.isbn ? ['sourceLocalId'] : []), 'title', ...(recordUrl ? ['url'] : []), ...(row.description ? ['description'] : []), ...(row.brand ? ['brand'] : []), ...(price.amount != null || price.priceText ? ['price'] : []), ...(rating ? ['rating'] : []), ...(variants.length ? ['variants'] : []), ...(reviews.length ? ['reviewSamples'] : [])];
  const evidence = Array.isArray(row.evidence) && row.evidence.length ? row.evidence.map(ref => ({
    receiptId: ref.receiptId ?? receiptId,
    locator: typeof ref.locator === 'string' ? ref.locator : locator,
    fields: Array.isArray(ref.fields) ? ref.fields.filter(field => actualFields.includes(field)) : actualFields,
  })) : [{ receiptId, locator: row._jsonPointer ?? row.locator ?? locator, fields: actualFields }];
  return {
    type: inferredType(row),
    sourceLocalId: row.sourceLocalId ?? row.sku ?? row.gtin ?? row.mpn ?? row.isbn ?? null,
    title,
    url: recordUrl,
    description: typeof row.description === 'string' ? row.description.replace(/\s+/g, ' ').trim().slice(0, 3000) : null,
    brand: typeof row.brand === 'string' ? row.brand.slice(0, 200) : row.brand?.name?.slice?.(0, 200) ?? null,
    price,
    rating,
    variants,
    reviewSamples: reviews.slice(0, 20).map(review => ({
      rating: review?.rating ?? review?.ratingValue ?? review?.reviewRating?.ratingValue ?? null,
      title: sanitizeReviewText(review?.title ?? review?.name ?? review?.headline, 240),
      body: sanitizeReviewText(review?.body ?? review?.reviewBody ?? review?.description),
      publishedAt: review?.publishedAt ?? review?.datePublished ?? null,
      optionText: review?.optionText ?? null,
      helpfulCount: review?.helpfulCount ?? null,
      reviewerIdentity: null,
    })),
    evidence,
  };
}

function formContracts(forms, pageUrl, roots, receiptId) {
  if (!Array.isArray(forms)) return [];
  return forms.slice(0, 20).flatMap((form, index) => {
    const action = httpsFirstPartyUrl(form.action ?? pageUrl, roots);
    if (!action) return [];
    const inputs = (form.controls ?? []).slice(0, 40).filter(control => control?.name).map(control => ({
      name: String(control.name).slice(0, 150), type: String(control.type ?? 'unknown').slice(0, 40),
    }));
    const search = inputs.some(input => /search|keyword|query|검색|키워드/i.test(input.name) || input.name.toLowerCase() === 'q');
    return [{
      contractId: `${receiptId}-form-${index + 1}`,
      kind: search ? 'html_search_form_observed' : 'html_form_observed',
      method: String(form.method ?? 'GET').toUpperCase(),
      action: safeUrl(action),
      inputNames: inputs,
      searchForm: search,
      replayed: false,
      evidence: { receiptId, locator: `html.form[${index}]` },
    }];
  });
}

function rankLink(link, merchant) {
  const rawUrl = link?.url ?? link?.href;
  const url = safeUrl(rawUrl);
  if (!url) return -1;
  const parsed = new URL(url);
  const pathAndText = `${parsed.pathname} ${link.text ?? ''}`.toLowerCase();
  if (/\.(?:png|jpe?g|webp|avif|gif|svg|ico|css|js|mjs|map|woff2?|ttf|eot|pdf|mp4)(?:$|\?)/i.test(parsed.pathname)) return -1;
  if (/(?:^|\/)favicon(?:\/|$)|(?:^|\/)assets?(?:\/|$)|(?:^|\/)(?:images?|media|fonts?)(?:\/|$)|(?:^|\/)static(?:\/|$)/i.test(parsed.pathname)) return -1;
  if (/login|logout|member|mypage|cart|basket|shopping-bag|privacy|terms|policy|search|authentication|warranty|support|newsletter|로그인|회원|장바구니|약관|개인정보/.test(pathAndText)) return -1;
  let score = 0;
  const routeSignal = /(?:^|\/)(?:products?|goods|items?|detail|sku|catalog|collections?|categories?|shop|pass|esim|package|hotel|room|ticket|tour|activity|experience|destination)(?:\/|$)|(?:[?&](?:goodsNo|itemId|productId|sku)=)/i.test(`${parsed.pathname}${parsed.search}`);
  const textSignal = /제품|상품|구매|여행|숙박|패스|eSIM|티켓|투어|체험|상세|컬렉션|매장|카테고리/i.test(link.text ?? '');
  if (routeSignal) score += 4;
  if (textSignal) score += 3;
  if (/(?:^|\/)(?:product|products|goodsView|item|items|detail)\/[^/]+/i.test(parsed.pathname) || /\/products\/[^/]+\/[^/]+/i.test(parsed.pathname) || /(?:[?&](?:goodsNo|itemId|productId|sku)=)[^&]+/i.test(parsed.search)) score += 8;
  else if (/(?:^|\/)(?:goodsList|categories|category|collections?|shop)(?:\/|$)/i.test(parsed.pathname)) score -= 2;
  if (merchant.merchantId === 'airalo' && /(?:^|\/)(?:[a-z]+-)+esim\/?$/i.test(parsed.pathname)) {
    const slug = parsed.pathname.split('/').filter(Boolean).at(-1)?.toLowerCase();
    const genericSections = new Set(['global-esim', 'regional-esim', 'local-esim', 'asia-esim', 'africa-esim', 'europe-esim', 'north-america-esim', 'latin-america-esim', 'oceania-esim', 'middle-east-and-north-africa-esim', 'eu-plus-uk-esim', 'caribbean-islands-esim', 'africa-safari-esim']);
    score += genericSections.has(slug) ? 6 : 12;
  }
  if (merchant.verticalHint === 'travel' && /travel|hotel|room|ticket|tour|pass|esim|activity|package|destination/i.test(pathAndText)) score += 2;
  if (merchant.verticalHint !== 'travel' && /(?:^|\/)(?:travel|hotel|room|ticket|tour|activity|destination)(?:\/|$)/i.test(parsed.pathname) && !/product|goods|item/i.test(parsed.pathname)) return -1;
  const pageUrl = link.pageUrl ?? null;
  const localePrefix = (pageUrl ? new URL(pageUrl).pathname : new URL(merchant.siteUrl).pathname).split('/').filter(Boolean)[0];
  const candidatePrefix = parsed.pathname.split('/').filter(Boolean)[0];
  const localePattern = /^[a-z]{2}(?:-[a-z0-9]{2,})?$/i;
  if (localePrefix && localePattern.test(localePrefix) && candidatePrefix && localePattern.test(candidatePrefix) && localePrefix.toLowerCase() !== candidatePrefix.toLowerCase()) return -1;
  if (localePrefix && localePattern.test(localePrefix) && candidatePrefix?.toLowerCase() === localePrefix.toLowerCase()) score += 2;
  return score >= 3 ? score : -1;
}

const offeringSchemaTypes = new Set(['product', 'productgroup', 'productcollection', 'service', 'hotel', 'lodgingbusiness', 'touristtrip', 'trip', 'event', 'course', 'softwareapplication', 'book', 'creativework', 'touristdestination']);

function jsonLdRecords(extracted, merchant, pageUrl, receiptId) {
  const objects = Array.isArray(extracted?.jsonLd) ? extracted.jsonLd : [];
  return objects.flatMap((row, index) => {
    if (!row || typeof row !== 'object') return [];
    const types = Array.isArray(row['@type']) ? row['@type'] : row['@type'] ? [row['@type']] : [];
    if (!types.some(type => offeringSchemaTypes.has(String(type).split(/[\/#]/).at(-1).toLowerCase()))) return [];
    const record = normalizeRecord(row, merchant, pageUrl, receiptId, { locator: `jsonLd[${index}]` });
    return record ? [record] : [];
  });
}

function observedHtmlOfferRecords(extracted, merchant, pageUrl, receiptId) {
  if (merchant.merchantId !== 'clubclio') return [];
  const roots = allowedHostsFor(merchant);
  const links = Array.isArray(extracted?.links) ? extracted.links : [];
  const output = [];
  for (const link of links) {
    const url = httpsFirstPartyUrl(link?.url ?? link?.href, roots);
    const match = url ? new URL(url).pathname.match(/\/shop\/goodsView\/([A-Za-z0-9_-]+)/i) : null;
    const rawText = typeof link?.text === 'string' ? link.text.replace(/\s+/g, ' ').trim() : '';
    if (!match || rawText.length < 12 || /^\[(?:TRUNCATED|REDACTED)\]$/i.test(rawText)) continue;
    const discount = /(?:^|\s)(\d{1,2})%\s*/.exec(rawText);
    const ratingMatch = /(?:^|\s)([0-5](?:\.\d+)?)\s*\(\s*(\d[\d,]*)\s*\)\s*$/.exec(rawText);
    const ratingStart = ratingMatch ? ratingMatch.index : rawText.length;
    const priceTokens = [...rawText.slice(0, ratingStart).matchAll(/\d{1,3}(?:,\d{3})+(?:\s*원)?|\d+(?:\s*원)/g)]
      .map(row => ({ text: row[0], index: row.index, end: row.index + row[0].length, amount: Number(row[0].replace(/[^\d]/g, '')) }))
      .filter(row => row.amount >= 1000);
    let selectedPrices = priceTokens.slice(-2);
    if (discount && priceTokens.length > 2) {
      const discountStart = discount.index;
      const discountEnd = discount.index + discount[0].length;
      const pairs = priceTokens.slice(0, -1).map((row, index) => [row, priceTokens[index + 1]]);
      selectedPrices = pairs.sort((a, b) => {
        const gap = pair => pair[1].end <= discountStart ? discountStart - pair[1].end : pair[0].index >= discountEnd ? pair[0].index - discountEnd : 0;
        return gap(a) - gap(b);
      })[0] ?? selectedPrices;
    }
    const amount = selectedPrices[0]?.amount ?? null;
    let title = rawText;
    const removals = [...selectedPrices.map(row => [row.index, row.end])];
    if (discount) removals.push([discount.index, discount.index + discount[0].length]);
    if (ratingMatch) removals.push([ratingMatch.index, ratingMatch.index + ratingMatch[0].length]);
    for (const [start, end] of removals.sort((a, b) => b[0] - a[0])) title = `${title.slice(0, start)} ${title.slice(end)}`;
    title = title.replace(/\s+/g, ' ').replace(/^[\s|·•:;\-]+|[\s|·•:;\-]+$/g, '').trim();
    if (!title || amount == null || !Number.isFinite(amount)) continue;
    const fields = ['type', 'sourceLocalId', 'title', 'url', 'price', ...(ratingMatch ? ['rating'] : [])];
    const locator = `html.a[href="${new URL(url).pathname}"]`;
    const priceText = [selectedPrices[0]?.text, selectedPrices[1]?.text].filter(Boolean).join(' / ') + (discount ? ` ${discount[1]}%` : '');
    const record = normalizeRecord({
      type: 'RetailProduct', sourceLocalId: match[1], title, url,
      price: { amount, currency: null, priceText: priceText || String(amount) },
      rating: ratingMatch ? { value: Number(ratingMatch[1]), best: null, worst: null, reviewCount: Number(ratingMatch[2].replace(/,/g, '')), ratingCount: null } : null,
      evidence: fields.map(field => ({ receiptId, locator: field === 'type' || field === 'sourceLocalId' || field === 'url' ? `${locator}.href` : `${locator}.textContent`, fields: [field] })),
    }, merchant, pageUrl, receiptId, { locator });
    if (record) output.push(record);
  }
  return output;
}

function clubclioDetailRecord(html, merchant, pageUrl, receiptId) {
  if (merchant.merchantId !== 'clubclio' || typeof html !== 'string' || !isAllowedUrl(pageUrl, allowedHostsFor(merchant))) return null;
  let parsedUrl;
  let tree;
  try { parsedUrl = new URL(pageUrl); tree = parseFragment(html); } catch { return null; }
  const match = parsedUrl.pathname.match(/^\/shop\/goodsView\/([A-Za-z0-9_-]+)\/?$/i);
  if (!match) return null;
  const attr = (node, key) => node?.attrs?.find(row => row.name === key)?.value ?? null;
  const nodeText = node => {
    if (!node || ['script', 'style', 'noscript'].includes(node.tagName)) return '';
    if (node.nodeName === '#text') return node.value ?? '';
    return (node.childNodes ?? []).map(nodeText).join(' ');
  };
  let title = null;
  let description = null;
  let priceAmount = null;
  const walk = node => {
    if (!node) return;
    if (node.tagName === 'meta') {
      const property = attr(node, 'property');
      if (property === 'og:title') title = attr(node, 'content') ?? title;
      if (property === 'og:description') description = attr(node, 'content') ?? description;
    }
    const classes = String(attr(node, 'class') ?? '').split(/\s+/);
    if (node.tagName === 'div' && classes.includes('details_percent')) {
      const scanPrice = child => {
        if (!child || priceAmount != null || ['script', 'style', 'noscript'].includes(child.tagName)) return;
        if (child.tagName === 'b') {
          const numericText = nodeText(child).replace(/\s+/g, '').trim();
          const amountMatch = numericText.match(/^(\d[\d,]*)(?:원)?$/);
          const surrounding = nodeText(node).replace(/\s+/g, '');
          if (amountMatch && surrounding.includes(`${amountMatch[1]}원`)) priceAmount = Number(amountMatch[1].replace(/,/g, ''));
        }
        for (const nested of child.childNodes ?? []) scanPrice(nested);
      };
      scanPrice(node);
    }
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(tree);
  if (!title || priceAmount == null || !Number.isFinite(priceAmount)) return null;
  const selector = 'html.dl.view__product_details .details_percent b';
  return normalizeRecord({
    type: 'RetailProduct', sourceLocalId: match[1], title, url: pageUrl, description,
    price: { amount: priceAmount, currency: 'KRW', priceText: `${priceAmount.toLocaleString('en-US')}원` },
    evidence: [
      { receiptId, locator: 'meta[property="og:title"]', fields: ['title'] },
      { receiptId, locator: `http.response.finalUrl.pathname.goodsView[${match[1]}]`, fields: ['sourceLocalId', 'url'] },
      { receiptId, locator: selector, fields: ['price'] },
    ],
  }, merchant, pageUrl, receiptId, { locator: selector });
}

function airaloPageOfferRecords(extracted, merchant, pageUrl, receiptId) {
  if (merchant.merchantId !== 'airalo' || typeof extracted?.title !== 'string') return [];
  const match = extracted.title.match(/^(.+?eSIM)\s*[,|·]\s*([$€£¥])?\s*(\d[\d,]*(?:\.\d{1,2})?)\s*(USD|EUR|GBP|AUD|CAD|NZD|SGD|JPY|KRW)?\s*(?:부터|from|ab|à partir)/i);
  if (!match) return [];
  const amount = Number(match[3].replace(/,/g, ''));
  if (!Number.isFinite(amount)) return [];
  const url = httpsFirstPartyUrl(pageUrl, allowedHostsFor(merchant));
  if (!url) return [];
  const row = {
    type: 'TravelOffering', sourceLocalId: null, title: match[1].trim(), url,
    description: typeof extracted.description === 'string' ? extracted.description : null,
    brand: 'Airalo', price: { amount, currency: match[4]?.toUpperCase() ?? ({ '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY' }[match[2]] ?? null), priceText: match[0].replace(/^.*?[,|·]\s*/, '').trim() },
    evidence: [
      { receiptId, locator: 'html.title', fields: ['title', 'price'] },
      { receiptId, locator: 'http.response.finalUrl', fields: ['url'] },
    ],
  };
  return [normalizeRecord(row, merchant, pageUrl, receiptId, { locator: 'html.title' })].filter(Boolean);
}

function embeddedRecords(extracted, merchant, pageUrl, receiptId) {
  const roots = Array.isArray(extracted?.embeddedJson) ? extracted.embeddedJson : [];
  const output = [];
  let visited = 0;
  const walk = (value, locator, pathParts, depth = 0) => {
    if (depth > 12 || visited >= 1800 || value == null || typeof value !== 'object') return;
    visited++;
    if (Array.isArray(value)) { value.slice(0, 300).forEach((item, index) => walk(item, `${locator}[${index}]`, pathParts, depth + 1)); return; }
    const typeText = `${value.type ?? ''} ${value['@type'] ?? ''}`.toLowerCase();
    const keyText = pathParts.join('.').toLowerCase();
    const name = value.name ?? value.title ?? value.productName ?? value.goodsName ?? value.itemName;
    const hasCommerceFields = value.sku != null || value.gtin != null || value.productId != null || value.goodsNo != null || value.price != null || value.offers != null || value.brand != null;
    const typed = /product|goods|hotel|lodging|trip|tour|activity|pass|esim|service|ticket/.test(typeText);
    const scoped = /product|products|goods|items|catalog|offering|hotel|trip|tour|activity|pass|esim|ticket/.test(keyText);
    if (typeof name === 'string' && name.trim() && hasCommerceFields && (typed || scoped)) {
      const row = {
        ...value,
        name,
        sku: value.sku ?? value.productId ?? value.goodsNo ?? value.itemId ?? null,
        url: value.url ?? value.productUrl ?? value.detailUrl ?? value.link ?? null,
        price: value.price ?? value.salePrice ?? value.finalPrice ?? value.lowPrice ?? null,
        aggregateRating: value.aggregateRating ?? (typeof value.rating === 'number' || typeof value.rating === 'string' ? { ratingValue: value.rating, reviewCount: value.reviewCount ?? value.ratingCount ?? null } : null),
      };
      const record = normalizeRecord(row, merchant, pageUrl, receiptId, { locator: `${locator}.${pathParts.join('.')}` });
      if (record) output.push(record);
    }
    for (const [key, child] of Object.entries(value).slice(0, 250)) {
      if (/reviewer|author|customer|member|account|email|phone|token|credential|password/i.test(key)) continue;
      walk(child, locator, [...pathParts, key], depth + 1);
    }
  };
  for (const [index, item] of roots.entries()) walk(item?.value ?? item, `embeddedJson[${index}]`, [item?.id ?? 'payload']);
  return output;
}

function rawJsonPayloads(html) {
  if (typeof html !== 'string') return [];
  let tree;
  try { tree = parseFragment(html); } catch { return []; }
  const scripts = [];
  const walkNodes = node => {
    if (!node || scripts.length >= 40) return;
    if (node.tagName === 'script') scripts.push(node);
    for (const child of node.childNodes ?? []) walkNodes(child);
  };
  walkNodes(tree);
  const output = [];
  for (const [index, script] of scripts.entries()) {
    const getAttr = name => script.attrs?.find(row => row.name === name)?.value ?? null;
    const type = (getAttr('type') ?? '').split(';', 1)[0].trim().toLowerCase();
    const id = getAttr('id') ?? `script-${index + 1}`;
    const isEmbedded = type === 'application/json' || /(?:__next_data__|__nuxt_data__|initial[_-]?state|bootstrap|page[_-]?state)/i.test(id);
    if (!isEmbedded || type === 'application/ld+json') continue;
    const raw = (script.childNodes ?? []).map(child => child.value ?? '').join('').trim();
    if (!raw || raw.length > 1024 * 1024) continue;
    try { output.push({ id: id.slice(0, 120), value: JSON.parse(raw) }); } catch { /* malformed public data is ignored */ }
  }
  return output;
}

function extractRawJsonLd(html, merchant, pageUrl, receiptId) {
  if (typeof html !== 'string') return { records: [], links: [] };
  let tree;
  try { tree = parseFragment(html); } catch { return { records: [], links: [] }; }
  const scripts = [];
  const walkNodes = node => {
    if (!node || scripts.length >= 40) return;
    if (node.tagName === 'script') scripts.push(node);
    for (const child of node.childNodes ?? []) walkNodes(child);
  };
  walkNodes(tree);
  const records = [];
  const links = [];
  let visited = 0;
  const visit = (value, locator, depth = 0) => {
    if (depth > 14 || visited >= 20000 || value == null || typeof value !== 'object') return;
    visited++;
    if (Array.isArray(value)) { value.slice(0, 500).forEach((item, index) => visit(item, `${locator}[${index}]`, depth + 1)); return; }
    const schemaTypes = Array.isArray(value['@type']) ? value['@type'] : value['@type'] ? [value['@type']] : [];
    if (schemaTypes.some(type => offeringSchemaTypes.has(String(type).split(/[\/#]/).at(-1).toLowerCase()))) {
      const record = normalizeRecord(value, merchant, pageUrl, receiptId, { locator });
      if (record) records.push(record);
    }
    if (schemaTypes.some(type => String(type).split(/[\/#]/).at(-1).toLowerCase() === 'listitem') && /\.itemListElement(?:\[\d+\])?$/.test(locator) && typeof value.url === 'string') {
      const url = httpsFirstPartyUrl(value.url, allowedHostsFor(merchant));
      if (url) links.push({ url, position: value.position ?? null, locator: `${locator}.url` });
    }
    for (const [key, child] of Object.entries(value).slice(0, 300)) {
      if (/reviewer|author|customer|member|account|email|phone|token|credential|password/i.test(key)) continue;
      visit(child, `${locator}.${key}`, depth + 1);
    }
  };
  for (const [index, script] of scripts.entries()) {
    const type = (script.attrs?.find(row => row.name === 'type')?.value ?? '').split(';', 1)[0].trim().toLowerCase();
    if (type !== 'application/ld+json') continue;
    const raw = (script.childNodes ?? []).map(child => child.value ?? '').join('').trim();
    if (!raw || raw.length > 1024 * 1024) continue;
    try { visit(JSON.parse(raw), `jsonLdRaw[${index}]`); } catch { /* malformed public schema is ignored */ }
  }
  return { records, links: [...new Map(links.map(row => [row.url, row])).values()] };
}

function extractHbxCatalog(html, merchant, pageUrl, receiptId) {
  if (merchant.merchantId !== 'hbx' || typeof html !== 'string') return { records: [], contract: null };
  let tree;
  try { tree = parseFragment(html); } catch { return { records: [], contract: null }; }
  let payload = null;
  const walk = node => {
    if (!node || payload) return;
    const raw = node.attrs?.find(attr => attr.name === 'data-catalog-products-value')?.value;
    if (typeof raw === 'string' && raw.length <= 1024 * 1024) {
      try { payload = JSON.parse(raw); } catch { /* Invalid catalog attribute is not structured evidence. */ }
    }
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(tree);
  if (!payload || !Array.isArray(payload.items)) return { records: [], contract: null };
  const rows = payload.items.slice(0, 100).flatMap((item, index) => {
    const title = typeof item?.name === 'string' ? item.name.trim() : null;
    const sourceLocalId = item?.id == null ? null : String(item.id);
    const rawUrl = item?._links?.self?.href;
    const url = rawUrl ? httpsFirstPartyUrl(rawUrl, allowedHostsFor(merchant)) : null;
    const priceText = typeof item?.price?.display === 'string' ? item.price.display : typeof item?.price?.fractionDisplay === 'string' ? item.price.fractionDisplay : null;
    const currency = typeof item?.price?.currency === 'string' && /^[A-Za-z]{3}$/.test(item.price.currency) ? item.price.currency.toUpperCase() : null;
    const amountMatch = priceText?.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
    const amount = amountMatch ? Number(amountMatch[0]) : null;
    const brand = Array.isArray(item?.brands) ? item.brands.find(row => typeof row?.name === 'string')?.name ?? null : null;
    if (!title || !sourceLocalId || !url) return [];
    const base = `html[data-catalog-products-value].items[${index}]`;
    return [normalizeRecord({
      type: 'RetailProduct', sourceLocalId, title, url, description: null, brand,
      price: { amount: Number.isFinite(amount) ? amount : null, currency, priceText },
      evidence: [
        { receiptId, locator: `${base}.id`, fields: ['sourceLocalId'] },
        { receiptId, locator: `${base}.name`, fields: ['title'] },
        { receiptId, locator: `${base}._links.self.href`, fields: ['url'] },
        ...(brand ? [{ receiptId, locator: `${base}.brands[0].name`, fields: ['brand'] }] : []),
        ...(priceText ? [{ receiptId, locator: `${base}.price.display`, fields: ['price'] }] : []),
      ],
    }, merchant, pageUrl, receiptId, { locator: base })].filter(Boolean);
  });
  return {
    records: rows,
    contract: {
      kind: 'html_catalog_json_attribute_observed', receiptId,
      attribute: 'data-catalog-products-value', page: payload.page ?? null, pages: payload.pages ?? null,
      limit: payload.limit ?? null, total: payload.total ?? null, parsedItemCount: payload.items.length,
      retainedOfferCount: rows.length, firstPartyDetailLinksObserved: rows.length > 0,
      evidence: { receiptId, locator: 'html[data-catalog-products-value]' },
    },
  };
}

function extractRawEmbeddedRecords(html, merchant, pageUrl, receiptId) {
  const output = [];
  let visited = 0;
  const sensitiveKey = /token|authorization|auth|csrf|cookie|session|password|credential|customer|member|user|email|phone|order|shipment|address|payment|reviewer|author|account/i;
  const getString = (object, keys, limit = 800) => {
    for (const key of keys) {
      const value = object?.[key];
      if (typeof value === 'string' && value.trim() && !/^\[(?:TRUNCATED|REDACTED)\]$/.test(value.trim())) return value.replace(/\s+/g, ' ').trim().slice(0, limit);
    }
    return null;
  };
  const numericOrText = value => {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return { amount: value, text: String(value) };
    if (typeof value !== 'string' || !value.trim()) return { amount: null, text: null };
    const text = value.trim().slice(0, 240);
    const match = text.replace(/,/g, '').match(/(?:^|[^\d])(\d+(?:\.\d+)?)(?:$|[^\d])/);
    return { amount: match ? Number(match[1]) : null, text };
  };
  const typeFrom = (object, keyPath) => {
    const rawType = `${object.type ?? ''} ${object['@type'] ?? ''}`.toLowerCase();
    const path = keyPath.toLowerCase();
    if (/hotel|lodging|touristtrip|\btrip\b|\btour\b|activity|\bpass\b|esim|ticket|travel|package/.test(rawType) || /hotel|lodging|touristtrip|\btrip\b|\btour\b|activity|\bpass\b|esim|ticket|travel|package/.test(path)) return 'TravelOffering';
    if (/product|goods|item|catalog|retail|book/.test(rawType) || /product|goods|item|catalog|retail/.test(path)) return 'RetailProduct';
    if (/service|subscription/.test(rawType) || /service|subscription/.test(path)) return 'ServiceOffering';
    return 'UnclassifiedOffering';
  };
  const walk = (value, scriptLocator, keyPath, depth = 0) => {
    if (depth > 18 || visited >= 20000 || value == null || typeof value !== 'object') return;
    visited++;
    if (Array.isArray(value)) { value.slice(0, 500).forEach((item, index) => walk(item, scriptLocator, `${keyPath}[${index}]`, depth + 1)); return; }
    const title = getString(value, ['name', 'title', 'productName', 'product_name', 'productTitle', 'goodsName', 'goods_name', 'itemName', 'item_name', 'displayName', 'display_name']);
    const itemPath = /(?:^|\.)(?:product|products|product_list|productlist|item|items|item_list|itemlist|goods|goods_list|goodlist|offer|offers|hotel|lodging|trip|tour|activity|pass|esim|ticket|packages|plans)$/i.test(keyPath);
    const localId = getString(value, ['sku', 'gtin', 'gtin13', 'mpn', 'isbn', 'productId', 'product_id', 'goodsNo', 'goods_no', 'itemId', 'item_id', 'productCode', 'product_code', 'product_no', 'goods_id', 'goods_code'], 200)
      ?? (itemPath && (typeof value.id === 'string' || typeof value.id === 'number') ? String(value.id) : null);
    const finalPriceInfo = value.final_price_info && typeof value.final_price_info === 'object' ? value.final_price_info : null;
    const priceObject = value.price && typeof value.price === 'object' ? value.price : value.salePrice && typeof value.salePrice === 'object' ? value.salePrice : finalPriceInfo;
    const priceRaw = priceObject?.amount ?? priceObject?.value ?? priceObject?.price ?? priceObject?.final_price ?? value.salePrice ?? value.finalPrice ?? value.priceAmount ?? value.price ?? value.displayPrice ?? value.display_price ?? value.lowPrice ?? null;
    const price = numericOrText(priceRaw);
    const hasCommerceSignal = localId != null || price.amount != null || value.offer != null || value.offers != null || value.brand != null;
    if (title && hasCommerceSignal && itemPath) {
      const ratingRaw = value.aggregateRating ?? value.rating ?? value.reviewRating ?? value.review_score ?? value.review_count_and_rating_average ?? null;
      const ratingNumber = ratingRaw && typeof ratingRaw === 'object' ? ratingRaw.ratingValue ?? ratingRaw.value ?? ratingRaw.average ?? ratingRaw.ratings_average : ratingRaw;
      const reviewCount = value.reviewCount ?? value.review_count ?? value.ratingCount ?? value.rating_count ?? (ratingRaw && typeof ratingRaw === 'object' ? ratingRaw.reviewCount ?? ratingRaw.ratingCount ?? ratingRaw.all_count : null) ?? null;
      const hasRating = (Number(reviewCount) > 0 || Number(ratingNumber) > 0) && ratingNumber != null;
      const currencyRaw = priceObject?.currency ?? priceObject?.priceCurrency ?? value.priceCurrency ?? value.currency ?? null;
      const currency = typeof currencyRaw === 'string' && /^[A-Za-z]{3}$/.test(currencyRaw) ? currencyRaw.toUpperCase() : /₩|원/.test(price.text ?? '') ? 'KRW' : null;
      const evidence = [];
      const baseLocator = keyPath ? `${scriptLocator}.${keyPath}` : scriptLocator;
      const addEvidence = (field, suffix) => evidence.push({ receiptId, locator: `${baseLocator}.${suffix}`, fields: [field] });
      addEvidence('title', 'name');
      if (localId != null) addEvidence('sourceLocalId', value.id != null && localId === String(value.id) ? 'id' : 'sku_or_product_id');
      if (value.brand != null) addEvidence('brand', value.brand && typeof value.brand === 'object' ? 'brand.name' : 'brand');
      if (price.amount != null || price.text) addEvidence('price', finalPriceInfo ? 'final_price_info.final_price' : 'price');
      if (hasRating) addEvidence('rating', 'review_count_and_rating_average');
      const row = {
        type: typeFrom(value, keyPath),
        sourceLocalId: localId,
        name: title,
        url: getString(value, ['url', 'productUrl', 'product_url', 'detailUrl', 'detail_url', 'permalink', 'href', 'link'], 1200),
        description: getString(value, ['description', 'summary', 'shortDescription', 'short_description'], 2000),
        brand: value.brand?.name ?? value.brand ?? value.manufacturer?.name ?? null,
        price: { amount: price.amount, currency, priceText: price.text },
        aggregateRating: hasRating ? { ratingValue: ratingNumber, reviewCount, ratingCount: value.ratingCount ?? value.rating_count ?? null } : null,
        variants: Array.isArray(value.variants) ? value.variants.slice(0, 30) : Array.isArray(value.options) ? value.options.slice(0, 30) : [],
        reviewSamples: Array.isArray(value.reviews) ? value.reviews.slice(0, 8) : Array.isArray(value.review) ? value.review.slice(0, 8) : [],
        evidence,
      };
      const record = normalizeRecord(row, merchant, pageUrl, receiptId, { locator: baseLocator });
      if (record) output.push(record);
    }
    for (const [key, child] of Object.entries(value).slice(0, 500)) {
      if (sensitiveKey.test(key)) continue;
      walk(child, scriptLocator, keyPath ? `${keyPath}.${key}` : key, depth + 1);
    }
  };
  for (const payload of rawJsonPayloads(html)) walk(payload.value, `embeddedScript[${payload.id}]`, '');
  return output;
}

function pickLinks(extracted, pageUrl, roots, merchant) {
  const links = Array.isArray(extracted?.links) ? extracted.links : [];
  const ranked = links.map(link => {
    const url = httpsFirstPartyUrl(link.url ?? link.href, roots);
    return { url, text: link.text ?? null, score: url ? rankLink({ ...link, url, pageUrl }, merchant) : -1 };
  })
    .filter(link => link.url && link.score > 0 && isAllowedUrl(link.url, roots))
    .filter(link => new URL(link.url).href !== new URL(pageUrl).href)
    .sort((a, b) => b.score - a.score);
  const dedupe = new Set();
  return ranked.filter(link => { if (dedupe.has(link.url)) return false; dedupe.add(link.url); return true; });
}

function uniqueFirstPartyRecordLink(found, roots, visited) {
  for (const item of found) {
    const record = item.row;
    const url = httpsFirstPartyUrl(record?.url, roots);
    if (!url || visited.has(url)) continue;
    const pathname = new URL(url).pathname;
    if (/\.(?:png|jpe?g|webp|avif|gif|svg|ico|css|js|mjs|map|woff2?|ttf|eot|pdf|mp4)$/i.test(pathname)) continue;
    return { url, text: record.title ?? null, score: 100 };
  }
  return null;
}

function capabilityState(records, key) {
  if (!records.length) return { state: 'not_observed', evidenceReceiptIds: [] };
  const rows = records.filter(row => {
    const value = row[key];
    if (value == null) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.values(value).some(item => item != null && item !== '');
    return value !== '';
  });
  return rows.length ? { state: 'observed_in_public_page', evidenceReceiptIds: [...new Set(rows.flatMap(row => row.evidence.map(ref => ref.receiptId)))] } : { state: 'not_observed', evidenceReceiptIds: [] };
}

async function readOne(url, merchant, roots, index) {
  const page = await readPublicPage(url, { allowedHosts: roots, maxRedirects: 3, maxBytes: 5 * 1024 * 1024, timeoutMs: 20000 });
  const receipt = pageReceipt(page, merchant.merchantId, index);
  let extracted = null;
  if (page?.ok && typeof page.html === 'string') extracted = extractPublicPage(page, { merchantId: merchant.merchantId, typeHint: merchant.verticalHint });
  return { page, receipt, extracted };
}

async function collectLotteonSample() {
  const receipts = [];
  let sourceItems = [];
  const allowed = ['www.lotteon.com'];
  const trackedFetch = async (input, init = {}) => {
    let url;
    try { url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); }
    catch { throw Object.assign(new Error('LOTTEON_URL_INVALID'), { code: 'LOTTEON_URL_INVALID' }); }
    if (!allowed.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`)) || url.protocol !== 'https:' || url.port) throw Object.assign(new Error('LOTTEON_HOST_OUTSIDE_ALLOWLIST'), { code: 'LOTTEON_HOST_OUTSIDE_ALLOWLIST' });
    const headers = new Headers(init.headers ?? {});
    if (headers.has('cookie') || headers.has('authorization')) throw Object.assign(new Error('LOTTEON_CREDENTIAL_HEADER_REJECTED'), { code: 'LOTTEON_CREDENTIAL_HEADER_REJECTED' });
    const method = String(init.method ?? 'GET').toUpperCase();
    const response = await fetch(url, { ...init, credentials: 'omit', redirect: 'manual', cache: 'no-store', headers });
    const observedAt = new Date().toISOString();
    let body = new Uint8Array();
    let responseSha256 = null;
    try {
      const buffer = await response.clone().arrayBuffer();
      if (buffer.byteLength <= 5 * 1024 * 1024) {
        body = new Uint8Array(buffer);
        responseSha256 = createHash('sha256').update(body).digest('hex');
        if (response.status === 200 && /json/i.test(response.headers.get('content-type') ?? '')) {
          try {
            const payload = JSON.parse(new TextDecoder().decode(body));
            sourceItems = (payload.itemList ?? []).slice(0, 100).map((item, index) => {
              const explicit = [];
              const walk = (value, locator, depth = 0) => {
                if (depth > 6 || value == null || typeof value !== 'object') return;
                if (Array.isArray(value)) { value.slice(0, 30).forEach((child, childIndex) => walk(child, `${locator}[${childIndex}]`, depth + 1)); return; }
                for (const [key, child] of Object.entries(value).slice(0, 150)) {
                  if (/currency|price.?unit|currency.?code/i.test(key) && typeof child === 'string' && child.trim()) explicit.push({ locator: `${locator}.${key}`, value: child.trim().slice(0, 40) });
                  if (!/reviewer|author|customer|member|account|email|phone|token|credential|password|session|cookie/i.test(key)) walk(child, `${locator}.${key}`, depth + 1);
                }
              };
              walk(item, `json.itemList[${index}]`);
              const id = item?.sitmId ?? item?.pdId ?? null;
              const finalPrice = item?.priceInfo?.finalPrice ?? item?.brazeData?.discountPrice ?? null;
              const pricePath = item?.priceInfo?.finalPrice != null ? `json.itemList[${index}].priceInfo.finalPrice` : item?.brazeData?.discountPrice != null ? `json.itemList[${index}].brazeData.discountPrice` : `json.itemList[${index}]`;
              const numericPrice = typeof finalPrice === 'number' ? finalPrice : typeof finalPrice === 'string' && /^\d[\d,]*(?:\.\d+)?$/.test(finalPrice.trim()) ? Number(finalPrice.replace(/,/g, '')) : null;
              const base = `json.itemList[${index}]`;
              const idField = item?.sitmId != null ? 'sitmId' : item?.pdId != null ? 'pdId' : null;
              const productUrl = typeof item?.pdLink === 'string' && item.pdLink.trim() ? new URL(item.pdLink, 'https://www.lotteon.com').href : null;
              const ratingValuePath = item?.brazeData?.reviewScore != null ? `${base}.brazeData.reviewScore` : item?.reviewInfo?.score != null ? `${base}.reviewInfo.score` : null;
              const reviewCountPath = item?.brazeData?.reviewCount != null ? `${base}.brazeData.reviewCount` : item?.reviewInfo?.count != null ? `${base}.reviewInfo.count` : null;
              const brand = typeof item?.brazeData?.brandName === 'string' && item.brazeData.brandName.trim() ? item.brazeData.brandName.trim().slice(0, 200) : null;
              const brandPath = brand ? `${base}.brazeData.brandName` : null;
              return { index, id: id == null ? null : `lotteon:${id}`, localId: id == null ? null : String(id), idField, titlePath: `${base}.pdName`, productUrl, urlPath: productUrl ? `${base}.pdLink` : null, numericPrice, pricePath, ratingValuePath, reviewCountPath, brand, brandPath, explicitCurrencyFields: explicit.slice(0, 5) };
            });
          } catch { sourceItems = []; }
        }
      }
    } catch { /* retain the response status without fabricating a body digest */ }
    receipts.push({
      receiptId: `b04-lotteon-api-${receipts.length + 1}`,
      method,
      requestUrl: safeUrl(url.href),
      httpStatus: response.status,
      contentType: response.headers.get('content-type'),
      mime: (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase() || null,
      bytes: body.byteLength,
      responseSha256,
      checkedAt: observedAt,
      browserUsed: false,
      cookiesSent: false,
      authorizationSent: false,
      credentials: 'omitted',
      redirect: response.status >= 300 && response.status < 400 ? safeUrl(response.headers.get('location') ?? '', url.href) : null,
    });
    return response;
  };
  const query = '삼겹살';
  let result;
  try {
    result = await collectShoppingSearch(query, { onlySources: ['lotteon'], perSite: 20, sleepImpl: async () => {}, fetchImpl: trackedFetch });
  } catch (error) {
    return { query, receipts, offers: [], error: error?.code ?? 'LOTTEON_SEARCH_FAILED' };
  }
  const offers = (result.offers ?? []).filter(row => row.mall === 'lotteon').slice(0, 20);
  return { query, receipts, offers, sourceItems, searchSummary: result.sites?.lotteon ?? null };
}

async function reverifyMerchant(merchant, { allowedHosts = null, maxPages = MAX_PAGES_PER_MERCHANT } = {}) {
  const roots = allowedHosts ?? allowedHostsFor(merchant);
  const receipts = [];
  const contracts = [];
  const records = [];
  const visited = new Set();
  const frontier = [];
  let stopReason = null;
  let pageIndex = 0;
  const queue = [];
  let usefulDetailObserved = false;
  let apiSearch = null;
  if (merchant.merchantId === 'lotteon') {
    apiSearch = await collectLotteonSample();
    receipts.push(...apiSearch.receipts);
    const searchReceiptId = apiSearch.receipts[0]?.receiptId ?? null;
    for (const [index, offer] of apiSearch.offers.entries()) {
      const sourceItem = apiSearch.sourceItems?.find(row => row.id === offer.id) ?? null;
      let url = null;
      try { url = sourceItem?.productUrl ? httpsFirstPartyUrl(sourceItem.productUrl, roots) : null; } catch { url = null; }
      const sourceLocalId = sourceItem?.localId ?? null;
      const sourcePricePath = sourceItem && Number(offer.price) === Number(sourceItem.numericPrice) ? sourceItem.pricePath : sourceItem ? `json.itemList[${sourceItem.index}]` : `public_search.items[${index}]`;
      const explicitCurrencyValue = sourceItem?.explicitCurrencyFields?.find(row => /^[A-Za-z]{3}$/.test(row.value) || /^(?:원|₩|\$|€|£|¥)$/u.test(row.value))?.value ?? null;
      const explicitCurrency = /^[A-Za-z]{3}$/.test(explicitCurrencyValue ?? '') ? explicitCurrencyValue.toUpperCase() : explicitCurrencyValue === '원' || explicitCurrencyValue === '₩' ? 'KRW' : explicitCurrencyValue === '$' ? 'USD' : explicitCurrencyValue === '€' ? 'EUR' : explicitCurrencyValue === '£' ? 'GBP' : explicitCurrencyValue === '¥' ? 'JPY' : null;
      const record = normalizeRecord({
        type: 'RetailProduct', sourceLocalId, title: offer.name, url, description: offer.description ?? null,
        brand: sourceItem?.brand ?? null,
        price: { amount: offer.price ?? null, currency: explicitCurrency, priceText: null },
        rating: offer.rating == null && offer.reviews == null ? null : { value: offer.rating ?? null, best: null, worst: null, reviewCount: offer.reviews ?? null, ratingCount: null },
      }, merchant, url ?? merchant.siteUrl, searchReceiptId ?? `b04-lotteon-search-${index + 1}`, { locator: sourceItem ? `json.itemList[${sourceItem.index}]` : `public_search.items[${index}]` });
      if (record) {
        const base = sourceItem ? `json.itemList[${sourceItem.index}]` : `public_search.items[${index}]`;
        record.evidence = [
          { receiptId: searchReceiptId, locator: base, fields: ['type'] },
          ...(sourceItem?.idField ? [{ receiptId: searchReceiptId, locator: `${base}.${sourceItem.idField}`, fields: ['sourceLocalId'] }] : []),
          ...(sourceItem?.titlePath ? [{ receiptId: searchReceiptId, locator: sourceItem.titlePath, fields: ['title'] }] : []),
          ...(record.url && sourceItem?.urlPath ? [{ receiptId: searchReceiptId, locator: sourceItem.urlPath, fields: ['url'] }] : []),
          ...(record.brand && sourceItem?.brandPath ? [{ receiptId: searchReceiptId, locator: sourceItem.brandPath, fields: ['brand'] }] : []),
          ...(record.price.amount != null ? [{ receiptId: searchReceiptId, locator: sourcePricePath, fields: ['price'] }] : []),
          ...(record.rating && sourceItem?.ratingValuePath ? [{ receiptId: searchReceiptId, locator: sourceItem.ratingValuePath, fields: ['rating'] }] : []),
          ...(record.rating && sourceItem?.reviewCountPath ? [{ receiptId: searchReceiptId, locator: sourceItem.reviewCountPath, fields: ['rating'] }] : []),
        ];
        records.push(record);
        if (url && !queue.includes(url)) queue.push(url);
      }
    }
    if (apiSearch.error || apiSearch.receipts.some(receipt => [401, 403, 418, 429].includes(receipt.httpStatus))) {
      const blocked = apiSearch.receipts.some(receipt => [401, 403, 418, 429].includes(receipt.httpStatus));
      frontier.push(`LotteON public search stopped: ${apiSearch.error ?? `HTTP_${apiSearch.receipts.at(-1)?.httpStatus}`}`);
      if (blocked) {
        return {
          merchantId: merchant.merchantId, merchantName: merchant.merchantName, siteUrl: safeUrl(merchant.siteUrl), verticalHint: merchant.verticalHint,
          receipts, records, contracts: [], operations: { product_search: { state: 'blocked', evidenceReceiptIds: apiSearch.receipts.map(row => row.receiptId) }, product_or_service_detail: { state: 'not_observed', evidenceReceiptIds: [] }, price: capabilityState(records, 'price'), rating_summary: capabilityState(records, 'rating'), review_samples: { state: 'not_observed', evidenceReceiptIds: [] }, review_list_endpoint: { state: 'not_observed', evidenceReceiptIds: [] } },
          frontier, status: 'blocked', stopReason: `HTTP_${apiSearch.receipts.at(-1)?.httpStatus}`,
        };
      }
    }
  }
  const homeUrl = httpsFirstPartyUrl(merchant.siteUrl, roots) ?? merchant.siteUrl;
  if (!queue.includes(homeUrl)) queue.push(homeUrl);
  if (merchant.merchantId === 'marshall' && !roots.includes('marshall.com')) roots.push('marshall.com');

  while (queue.length && pageIndex < maxPages) {
    const requestedUrl = queue.shift();
    if (!requestedUrl || visited.has(requestedUrl)) continue;
    if (!isAllowedUrl(requestedUrl, roots)) { frontier.push(`Rejected out-of-provider URL: ${requestedUrl}`); continue; }
    visited.add(requestedUrl);
    pageIndex++;
    let result;
    try {
      result = await readOne(requestedUrl, merchant, roots, pageIndex);
    } catch (error) {
      stopReason = error?.code ?? error?.message ?? 'PUBLIC_PAGE_READ_FAILED';
      frontier.push(`Stopped after ${stopReason} on ${requestedUrl}`);
      break;
    }
    receipts.push(result.receipt);
    if (!result.page?.ok) {
      stopReason = result.page?.stopReason ?? result.page?.blocked ?? `HTTP_${result.receipt.httpStatus ?? 'unknown'}`;
      frontier.push(`Stopped on ${stopReason} at ${safeUrl(requestedUrl)}`);
      break;
    }

    const receiptId = result.receipt.receiptId;
    const rawJsonLd = extractRawJsonLd(result.page.html, merchant, result.page.url ?? requestedUrl, receiptId);
    const hbxCatalog = extractHbxCatalog(result.page.html, merchant, result.page.url ?? requestedUrl, receiptId);
    const found = [
      ...(Array.isArray(result.extracted?.records) ? result.extracted.records.map(row => ({ row, options: { locator: row.evidence?.[0]?.locator ?? 'page_linked_jsonld' } })) : []),
      ...jsonLdRecords(result.extracted, merchant, result.page.url ?? requestedUrl, receiptId).map(row => ({ row, normalized: true })),
      ...rawJsonLd.records.map(row => ({ row, normalized: true })),
      ...hbxCatalog.records.map(row => ({ row, normalized: true })),
      ...observedHtmlOfferRecords(result.extracted, merchant, result.page.url ?? requestedUrl, receiptId).map(row => ({ row, normalized: true })),
      ...airaloPageOfferRecords(result.extracted, merchant, result.page.url ?? requestedUrl, receiptId).map(row => ({ row, normalized: true })),
      ...embeddedRecords(result.extracted, merchant, result.page.url ?? requestedUrl, receiptId).map(row => ({ row, normalized: true })),
      ...extractRawEmbeddedRecords(result.page.html, merchant, result.page.url ?? requestedUrl, receiptId).map(row => ({ row, normalized: true })),
      ...[clubclioDetailRecord(result.page.html, merchant, result.page.url ?? requestedUrl, receiptId)].filter(Boolean).map(row => ({ row, normalized: true })),
    ];
    for (const item of found) {
      const record = item.normalized ? item.row : normalizeRecord(item.row, merchant, result.page.url ?? requestedUrl, receiptId, item.options);
      if (record) {
        record.evidence = record.evidence.map(ref => ({ ...ref, pageUrl: safeUrl(result.page.url ?? requestedUrl) }));
        if (records.length < 100) records.push(record);
        if (record.url && record.evidence.some(ref => {
          try {
            const observed = new URL(ref.pageUrl);
            const offering = new URL(record.url);
            return observed.origin === offering.origin && observed.pathname.replace(/\/$/, '') === offering.pathname.replace(/\/$/, '');
          } catch { return false; }
        })) usefulDetailObserved = true;
      }
    }
    contracts.push(...formContracts(result.extracted?.forms, result.page.url ?? requestedUrl, roots, receiptId));
    if ((result.extracted?.embeddedJson ?? []).length) contracts.push({
      kind: 'embedded_json_state_observed', receiptId, blockCount: result.extracted.embeddedJson.length,
      reusableNetworkContract: false, note: 'Embedded page state was captured; no underlying XHR request was replayed.',
    });

    const candidates = pickLinks(result.extracted, result.page.url ?? requestedUrl, roots, merchant);
    contracts.push({
      kind: 'public_html_page_inspection', receiptId,
      pageUrl: safeUrl(result.page.url ?? requestedUrl), title: result.extracted?.title ?? null,
      outgoingCommerceLinksObserved: candidates.slice(0, 8).map(row => ({ url: row.url, text: row.text, score: row.score })),
      linkedJsonLdObjects: (result.extracted?.jsonLd ?? []).length,
      embeddedJsonBlocks: (result.extracted?.embeddedJson ?? []).length,
      offeringRecordsExtracted: found.length,
      xhrCaptured: false,
    });
    const pageSample = [...new Map(found.map(item => item.row).filter(row => row?.title).map(row => [row.url ?? `${row.type}|${row.sourceLocalId ?? ''}|${row.title}`, row])).values()]
      .slice(0, 5).map(row => ({ sourceLocalId: row.sourceLocalId ?? null, type: row.type ?? null, title: row.title, url: safeUrl(row.url), price: row.price ?? null, rating: row.rating ?? null }));
    contracts.push({
      kind: 'retrieval_scope_observed', receiptId,
      pageUrl: safeUrl(result.page.url ?? requestedUrl), pageTitle: result.extracted?.title ?? null,
      pageRole: pageSample.some(row => row.url === safeUrl(result.page.url ?? requestedUrl)) ? 'offering_detail_or_page-linked-offer' : pageSample.length ? 'catalog_or_landing_sample' : 'page_without_extracted_offer',
      sampledOfferCount: pageSample.length, sampledOffers: pageSample,
      evidence: { receiptId, locator: 'http.response.finalUrl plus extracted page records' },
    });
    if (rawJsonLd.links.length) contracts.push({
      kind: 'jsonld_itemlist_product_links_observed', receiptId,
      linkCount: rawJsonLd.links.length,
      sampleLinks: rawJsonLd.links.slice(0, 5).map(row => ({ url: safeUrl(row.url), position: row.position, locator: row.locator })),
      evidence: { receiptId, locator: 'jsonLdRaw.ItemList.itemListElement[].url' },
    });
    if (hbxCatalog.contract) contracts.push(hbxCatalog.contract);
    for (const row of rawJsonLd.links.slice(0, 40)) {
      if (!visited.has(row.url) && !queue.includes(row.url)) queue.push(row.url);
    }
    const structuredTarget = rawJsonLd.links.find(row => !visited.has(row.url));
    const queuedItem = queue.find(url => !visited.has(url));
    const target = uniqueFirstPartyRecordLink(found, roots, visited) ?? (structuredTarget ? { url: structuredTarget.url, text: null, score: 100 } : null)
      ?? (queuedItem ? { url: queuedItem, text: null, score: 90 } : null) ?? candidates[0];
    if (target && !visited.has(target.url) && pageIndex < maxPages) {
      const queuedIndex = queue.indexOf(target.url);
      if (queuedIndex >= 0) queue.splice(queuedIndex, 1);
      queue.unshift(target.url);
      continue;
    }
    if (target && !visited.has(target.url) && pageIndex >= maxPages) frontier.push(`Page budget reached before observed same-provider offering link: ${safeUrl(target.url)}`);
  }

  const uniqueRecords = [];
  const hasValue = value => {
    if (value == null || value === '') return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.values(value).some(hasValue);
    return true;
  };
  for (const row of records) {
    const index = uniqueRecords.findIndex(existing => {
      const sameTitle = String(existing.title ?? '').replace(/\s+/g, ' ').trim().toLowerCase() === String(row.title ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      const sameBrand = !existing.brand || !row.brand || String(existing.brand).toLowerCase() === String(row.brand).toLowerCase();
      const sameId = existing.sourceLocalId != null && row.sourceLocalId != null && String(existing.sourceLocalId) === String(row.sourceLocalId);
      const oneIdMissing = existing.sourceLocalId == null || row.sourceLocalId == null;
      const sameLocation = existing.url === row.url || ((!existing.url || !row.url) && sameTitle);
      return existing.type === row.type && sameLocation && (sameId || (oneIdMissing && sameTitle && sameBrand));
    });
    if (index < 0) { uniqueRecords.push(row); continue; }
    const existing = uniqueRecords[index];
    for (const field of ['sourceLocalId', 'url', 'description', 'brand', 'rating']) {
      if (!hasValue(existing[field]) && hasValue(row[field])) existing[field] = row[field];
    }
    if (!existing.price || typeof existing.price !== 'object') existing.price = { amount: null, currency: null, priceText: null };
    for (const field of ['amount', 'currency', 'priceText']) if (!hasValue(existing.price[field]) && hasValue(row.price?.[field])) existing.price[field] = row.price[field];
    const rowHasExactDetailPrice = row.evidence?.some(ref => (ref.fields ?? []).includes('price') && ref.pageUrl && (() => {
      try {
        const observed = new URL(ref.pageUrl);
        const offering = new URL(row.url);
        return observed.origin === offering.origin && observed.pathname.replace(/\/$/, '') === offering.pathname.replace(/\/$/, '');
      } catch { return false; }
    })());
    if (rowHasExactDetailPrice && row.price?.priceText) existing.price.priceText = row.price.priceText;
    if ((!existing.type || existing.type === 'UnclassifiedOffering') && row.type) existing.type = row.type;
    for (const field of ['variants', 'reviewSamples']) {
      const combined = [...(existing[field] ?? []), ...(row[field] ?? [])];
      existing[field] = [...new Map(combined.map(value => [JSON.stringify(value), value])).values()];
    }
    const evidence = [...(existing.evidence ?? []), ...(row.evidence ?? [])];
    existing.evidence = [...new Map(evidence.map(ref => [`${ref.receiptId}|${ref.locator}|${(ref.fields ?? []).join(',')}|${ref.pageUrl ?? ''}`, ref])).values()];
  }
  const detailRecords = uniqueRecords.filter(row => row.url && row.evidence.some(ref => {
    try {
      const observed = new URL(ref.pageUrl);
      const offering = new URL(row.url);
      return observed.origin === offering.origin && observed.pathname.replace(/\/$/, '') === offering.pathname.replace(/\/$/, '');
    } catch { return false; }
  }));
  const fetchedDetailPages = receipts.filter(receipt => {
    if (receipt.httpStatus !== 200) return false;
    try {
      const pageUrl = new URL(receipt.finalUrl ?? receipt.requestUrl);
      if (/\/(?:product|goodsView|item|items|detail)\/[^/]+/i.test(pageUrl.pathname)) return true;
      return uniqueRecords.some(row => {
        if (!row.url) return false;
        const offeringUrl = new URL(row.url);
        return offeringUrl.origin === pageUrl.origin && offeringUrl.pathname.replace(/\/$/, '') === pageUrl.pathname.replace(/\/$/, '');
      });
    } catch { return false; }
  });
  if (!usefulDetailObserved && uniqueRecords.length === 0) frontier.push('No product/service record was extracted from the public pages read.');
  if (!contracts.some(row => row.searchForm)) frontier.push('Product search endpoint or usable search form was not observed/replayed.');
  if (!uniqueRecords.some(row => row.rating || row.reviewSamples.length)) frontier.push('No aggregate rating or review sample was observed.');
  if (queue.length) frontier.push(`Observed ${queue.length} additional same-provider product/service URL(s) remain beyond this pass budget.`);
  if (apiSearch) frontier.push(`LotteON search sample used query "${apiSearch.query}" and retained at most 20 first-page offers; it is not a full catalog or complete review feed.`);
  frontier.push('Review list completeness/pagination and a reusable search API contract remain unverified unless explicitly shown in contracts.');

  const status = stopReason
    ? (/HTTP_(401|403|418|429)|challenge|blocked/i.test(String(stopReason)) ? 'blocked' : 'read_stopped')
    : uniqueRecords.length ? 'records_observed' : 'public_page_only';
  return {
    merchantId: merchant.merchantId,
    merchantName: merchant.merchantName,
    siteUrl: safeUrl(merchant.siteUrl),
    verticalHint: merchant.verticalHint,
    receipts,
    records: uniqueRecords,
    contracts: [
      ...contracts,
      ...(apiSearch ? [{
        kind: 'observed_public_search_api',
        method: apiSearch.receipts[0]?.method ?? null,
        requestUrl: apiSearch.receipts[0]?.requestUrl ?? null,
        query: apiSearch.query,
        firstPageOnly: true,
        responseReceiptIds: apiSearch.receipts.map(row => row.receiptId),
        responseShape: { itemsPath: '$.itemList', totalPath: '$.total', parsedFirstPageCount: apiSearch.sourceItems?.length ?? null, explicitCurrencyFieldCount: apiSearch.sourceItems?.filter(row => row.explicitCurrencyFields.length).length ?? 0 },
        replayState: apiSearch.receipts.some(row => row.httpStatus === 200) ? 'replayed_publicly' : 'not_replayed',
      }] : []),
      ...(merchant.merchantId === 'marshall' && receipts.some(row => row.requestUrl?.includes('marshallheadphones.com')) ? [{ kind: 'same_service_redirect', from: 'https://www.marshallheadphones.com/', observedLocation: 'https://www.marshall.com/', allowlistReason: 'Location was observed on the CPS merchant URL; destination identity checked by its public page and merchant branding.' }] : []),
    ],
    operations: {
      product_search: apiSearch?.receipts.some(row => row.httpStatus === 200) ? { state: 'verified_public_http', evidenceReceiptIds: apiSearch.receipts.map(row => row.receiptId), firstPageOfferCount: apiSearch.offers.length, query: apiSearch.query }
        : contracts.some(row => row.searchForm) ? { state: 'search_form_observed_not_replayed', evidenceReceiptIds: contracts.filter(row => row.searchForm).map(row => row.evidence.receiptId) } : { state: 'not_observed', evidenceReceiptIds: [] },
      catalog_items: capabilityState(uniqueRecords, 'title'),
      product_or_service_detail: detailRecords.length ? { state: 'detail_page_record_observed', evidenceReceiptIds: [...new Set(detailRecords.flatMap(row => row.evidence.map(ref => ref.receiptId)))] }
        : fetchedDetailPages.length ? { state: 'detail_page_html_fetched_no_structured_record', evidenceReceiptIds: fetchedDetailPages.map(row => row.receiptId) }
          : { state: 'not_observed', evidenceReceiptIds: [] },
      price: capabilityState(uniqueRecords, 'price'),
      rating_summary: capabilityState(uniqueRecords, 'rating'),
      review_samples: capabilityState(uniqueRecords, 'reviewSamples'),
      review_list_endpoint: { state: 'not_observed', evidenceReceiptIds: [] },
    },
    frontier,
    status,
    stopReason,
  };
}

export async function collectMerchant(merchantId, options = {}) {
  const merchant = merchantsById.get(merchantId);
  if (!merchant) return { merchantId, siteUrl: null, receipts: [], records: [], contracts: [], operations: {}, frontier: ['Merchant ID was not present in vertical taxonomy.'], status: 'taxonomy_record_missing' };
  if (['rakutentr', 'fwrd'].includes(merchantId)) return collectNativeCatalog(merchantId, options);
  return reverifyMerchant(merchant, options);
}

export async function runBatch04({ ids = merchantIds, outputPath = OUTPUT_PATH, writeOutput = true, pauseMs = 350, preserveBlocked = true } = {}) {
  const checkedAt = new Date().toISOString();
  const merchants = [];
  let previous = new Map();
  if (preserveBlocked) {
    try { previous = new Map(readJson(outputPath).merchants.map(row => [row.merchantId, row])); } catch { /* first run or invalid prior artifact */ }
  }
  for (const id of ids) {
    const merchant = merchantsById.get(id);
    if (!merchant) {
      merchants.push({ merchantId: id, status: 'taxonomy_record_missing', receipts: [], records: [], contracts: [], operations: {}, frontier: ['Merchant ID was not present in vertical taxonomy.'] });
      continue;
    }
    const old = previous.get(id);
    if (old?.status === 'blocked' || ['HTTP_ACCESS_BLOCKED', 'VISIBLE_CHALLENGE'].includes(old?.stopReason)
      || (old?.stopReason === 'PUBLIC_HTTP_TRANSPORT_FAILED' && old?.transportRetryAttempted === true)) {
      merchants.push(old);
    } else {
      const row = await collectMerchant(id, { allowedHosts: allowedHostsFor(merchant) });
      if (old?.stopReason === 'PUBLIC_HTTP_TRANSPORT_FAILED') row.transportRetryAttempted = true;
      merchants.push(row);
    }
    await sleep(pauseMs);
  }
  const output = { schemaVersion: 2, batchId: '04', checkedAt, merchantCount: merchants.length, merchants };
  if (writeOutput) {
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  }
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = await runBatch04();
  process.stdout.write(`${JSON.stringify({ outputPath: OUTPUT_PATH, checkedAt: output.checkedAt, merchantCount: output.merchantCount, outcomes: output.merchants.map(row => ({ merchantId: row.merchantId, status: row.status, records: row.records.length, receipts: row.receipts.length, stopReason: row.stopReason ?? null })) }, null, 2)}\n`);
}
