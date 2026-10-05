import { createHash } from 'node:crypto';
import { parseHTML } from 'linkedom';
import { commerceFail } from './http.mjs';

const SERVICE = 'rakuten-ichiba';
const REVIEW_PAGE_ORIGIN = 'https://review.rakuten.co.jp';
const REVIEW_ORIGIN = 'https://web-gateway.rakuten.co.jp';
const REVIEW_PATH = '/review/itemshopreviewlist/get/v1';
const BUNDLE_ORIGIN = 'https://r.r10s.jp';
const BUNDLE_PREFIX = '/com/review/front/assets/app/pages/review/javascript/';
const PUBLIC_RECEIPT_SCHEMA = 'web-api-public-read-receipt-v1';
const MAX_PAGE_HTML_BYTES = 3 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;
const MAX_REVIEW_BYTES = 4 * 1024 * 1024;
const REVIEW_PAGE_SIZE = 30;
const KEY_CACHE_TTL_MS = 5 * 60 * 1000;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

const fail = (code, receipt) => commerceFail(SERVICE, `RAKUTEN_ICHIBA_PUBLIC_${code}`, receipt);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeNonnegative = value => Number.isSafeInteger(value) && value >= 0;
const text = (value, max = 2_000) => typeof value === 'string' && value.length <= max && !CONTROL.test(value);
const nonemptyText = (value, max = 2_000) => text(value, max) && value.length > 0;

function checkedAt(now) {
  const time = now();
  if (!Number.isFinite(time)) fail('CLOCK_INVALID');
  try { return new Date(time).toISOString(); }
  catch { fail('CLOCK_INVALID'); }
}

function itemCodeParts(itemCode) {
  if (typeof itemCode !== 'string' || itemCode.length > 250 || CONTROL.test(itemCode)) fail('ITEM_CODE_INVALID');
  const at = itemCode.indexOf(':');
  if (at < 1 || at === itemCode.length - 1) fail('ITEM_CODE_INVALID');
  const shopCode = itemCode.slice(0, at);
  const itemPart = itemCode.slice(at + 1);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(shopCode) || !/^[^\s/?#]{1,200}$/.test(itemPart)) {
    fail('ITEM_CODE_INVALID');
  }
  return { itemCode, shopCode, itemPart };
}

function fixedUrl(value, origin, pathname, code) {
  let url;
  try { url = new URL(value); } catch { fail(code); }
  if (url.origin !== origin || url.pathname !== pathname || url.username || url.password || url.port || url.hash) {
    fail(code);
  }
  return url;
}

function parseReviewUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('REVIEW_URL_INVALID'); }
  if (url.protocol !== 'https:' || url.origin !== REVIEW_PAGE_ORIGIN || url.username || url.password || url.port || url.hash) {
    fail('REVIEW_URL_INVALID');
  }
  const match = /^\/item\/1\/(\d+)_(\d+)\/\d+\.\d+\/$/.exec(url.pathname);
  if (!match) fail('REVIEW_URL_INVALID');
  const shopIdentity = positiveDecimalId(match[1], 'REVIEW_URL_INVALID');
  const itemIdentity = positiveDecimalId(match[2], 'REVIEW_URL_INVALID');
  url.search = '';
  return { url: url.href, path: url.pathname, shopId: shopIdentity.text, itemId: itemIdentity.text };
}

function positiveDecimalId(value, code) {
  const textValue = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof textValue !== 'string' || !/^\d{1,20}$/.test(textValue)) fail(code);
  const number = Number(textValue);
  if (!Number.isSafeInteger(number) || number <= 0 || String(number) !== textValue) fail(code);
  return { text: textValue, number };
}

function mimeOf(response) {
  return response.headers?.get?.('content-type')?.split(';')[0]?.trim().toLowerCase() ?? null;
}

async function readBounded(response, maxBytes, receipt) {
  if (!response.body?.getReader) fail('BODY_UNREADABLE', receipt);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => {});
        fail('RESPONSE_TOO_LARGE', { ...receipt, responseBytes: length });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

async function directHttp({
  url,
  method,
  headers,
  body,
  expectedStatuses,
  expectedMime,
  maxBytes,
  fetchImpl,
  checked,
  readOnly = true,
}) {
  const requestUrl = new URL(url);
  const requestBase = {
    method,
    origin: requestUrl.origin,
    path: requestUrl.pathname,
    checkedAt: checked,
    browserUsed: false,
    anonymous: true,
    credentialsUsed: false,
    userCredentialsUsed: false,
    publicFrontendKeyUsed: false,
    cookieSent: false,
    readOnly,
    queryFields: [...new Set([...requestUrl.searchParams.keys()])].sort(),
  };
  let response;
  try {
    response = await fetchImpl(requestUrl, {
      method,
      headers: new Headers(headers),
      ...(body === undefined ? {} : { body }),
      redirect: 'manual',
      credentials: 'omit',
      signal: AbortSignal.timeout(25_000),
    });
  } catch (error) {
    fail(error?.name === 'TimeoutError' ? 'HTTP_TIMEOUT' : 'HTTP_TRANSPORT_FAILED', {
      ...requestBase,
      causeCode: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'TRANSPORT_ERROR',
    });
  }
  const request = { ...requestBase, httpStatus: response.status, mime: mimeOf(response) };
  const contentType = response.headers?.get?.('content-type') ?? request.mime;
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel().catch(() => {});
    fail('REDIRECT_REJECTED', { ...request, redirectFollowed: false });
  }
  if (!expectedStatuses.includes(response.status)) {
    await response.body?.cancel().catch(() => {});
    fail('HTTP_STATUS_INVALID', request);
  }
  if (!expectedMime.includes(request.mime)) {
    await response.body?.cancel().catch(() => {});
    fail('HTTP_MIME_INVALID', request);
  }
  const bytes = await readBounded(response, maxBytes, request);
  return {
    bytes,
    contentType,
    receipt: {
      ...request,
      responseBytes: bytes.length,
      responseSha256: createHash('sha256').update(bytes).digest('hex'),
    },
  };
}

function decodeHtml(bytes, mime) {
  const charset = /charset\s*=\s*([^;]+)/i.exec(mime ?? '')?.[1]?.trim().replace(/^['"]|['"]$/g, '') || 'utf-8';
  try { return new TextDecoder(charset).decode(bytes); }
  catch { fail('HTML_CHARSET_UNSUPPORTED'); }
}

function reviewUrlFromProductHtml(html, productUrl, expectedItemCode) {
  const { document } = parseHTML(html);
  const pageShop = new URL(productUrl).pathname.split('/').filter(Boolean)[0] ?? '';
  if (!pageShop || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(pageShop)) fail('PRODUCT_PAGE_IDENTITY_INVALID');
  const itemIdentity = expectedItemCode ? itemCodeParts(expectedItemCode) : null;
  if (itemIdentity && pageShop !== itemIdentity.shopCode) fail('PRODUCT_SHOP_CODE_MISMATCH');

  const shopId = document.querySelector('input[name="shop_bid"]')?.getAttribute('value') ?? null;
  const itemId = document.querySelector('input[name="item_id"]')?.getAttribute('value') ?? null;
  const pageShopCode = document.querySelector('input[name="shopurl"]')?.getAttribute('value') ?? null;
  if (!/^\d{1,20}$/.test(shopId ?? '') || !/^\d{1,20}$/.test(itemId ?? '') || pageShopCode !== pageShop) {
    fail('PRODUCT_PAGE_IDENTITY_UNVERIFIED');
  }

  const candidates = [];
  for (const anchor of document.querySelectorAll('a[href]')) {
    let target;
    try { target = new URL(anchor.getAttribute('href'), productUrl); } catch { continue; }
    if (target.origin !== REVIEW_PAGE_ORIGIN || !/^\/item\/1\/\d+_\d+\/\d+\.\d+\/$/.test(target.pathname)) continue;
    const candidate = parseReviewUrl(target.href);
    const anchorText = (anchor.textContent ?? '').replace(/\s+/g, ' ').trim();
    candidates.push({ ...candidate, anchorText });
  }
  const matched = candidates.find(candidate => candidate.shopId === shopId && candidate.itemId === itemId &&
    /レビュー|review/i.test(candidate.anchorText));
  if (!matched) fail('PRODUCT_REVIEW_LINK_IDENTITY_MISMATCH');
  const product = new URL(productUrl);
  product.search = '';
  product.hash = '';
  return {
    productUrl: product.href,
    reviewUrl: matched.url,
    shopId,
    itemId,
    targetKey: `${shopId}:${itemId}`,
    ...(expectedItemCode ? { requestedItemCode: expectedItemCode, requestedShopCodeMatched: true } : {}),
    pageShopCode: pageShop,
    productPageAndReviewHrefMatched: true,
    resolutionBasis: 'item_page_hidden_shop_bid_item_id_and_same_page_review_href',
  };
}

function parsePublicReviewAuthKey(bundle) {
  const featureStart = bundle.indexOf('itemShopReviewList:');
  if (featureStart < 0) fail('PUBLIC_REVIEW_KEY_SOURCE_MISSING');
  const featureWindow = bundle.slice(featureStart, featureStart + 2_000);
  const match = /^itemShopReviewList\s*:\s*\{\s*name\s*:\s*["']itemshopreviewlist["']\s*,\s*url\s*:\s*["']https:\/\/web-gateway\.rakuten\.co\.jp\/review\/itemshopreviewlist\/get\/v1["']\s*,\s*authkey\s*:\s*["']([^"']{8,512})["']/.exec(featureWindow);
  if (!match || !featureWindow.includes('ITEM_REVIEW_LIST:"itemReviewList"') ||
      !featureWindow.includes('MEDIA_REVIEW_LIST:"mediaReviewList"')) fail('PUBLIC_REVIEW_KEY_SOURCE_INVALID');
  const key = match[1];
  if (CONTROL.test(key) || /\s/.test(key)) fail('PUBLIC_REVIEW_KEY_SOURCE_INVALID');
  return key;
}

function schemaOfReview(row, { shopId, itemId } = {}) {
  if (!isObject(row)) fail('REVIEW_ROW_SCHEMA_INVALID');
  if (!Number.isSafeInteger(row.rating) || row.rating < 1 || row.rating > 5) fail('REVIEW_RATING_INVALID');
  if (!text(row.body, 50_000)) fail('REVIEW_BODY_INVALID');
  if (!/^(?:\d{4}[/-]\d{1,2}[/-]\d{1,2})$/.test(row.postDate ?? '')) fail('REVIEW_DATE_INVALID');
  if (row.title !== undefined && row.title !== null && !text(row.title, 5_000)) fail('REVIEW_TITLE_INVALID');
  if (row.orderDate !== undefined && row.orderDate !== null && !/^(?:\d{4}[/-]\d{1,2}[/-]\d{1,2})$/.test(row.orderDate)) {
    fail('REVIEW_ORDER_DATE_INVALID');
  }
  if (row.helpfulCount !== undefined && row.helpfulCount !== null && !safeNonnegative(row.helpfulCount)) {
    fail('REVIEW_HELPFUL_COUNT_INVALID');
  }
  const review = {
    rating: row.rating,
    body: row.body,
    postDate: row.postDate,
  };
  if (typeof row.revSubkey === 'string' && /^\d{1,20}$/.test(row.revSubkey)) {
    review.reviewId = row.revSubkey;
    review.identityKind = 'native_review_id';
    review.reviewIdSource = 'revSubkey';
  } else {
    review.reviewId = createHash('sha256').update([
      shopId, itemId, row.postDate, row.rating, row.title ?? '', row.body,
    ].join('\0')).digest('hex');
    review.identityKind = 'content_fingerprint';
  }
  if (typeof row.title === 'string') review.title = row.title;
  if (typeof row.orderDate === 'string') review.orderDate = row.orderDate;
  if (safeNonnegative(row.helpfulCount)) review.helpfulCount = row.helpfulCount;
  let unsafeMediaCount = 0;
  const media = [];
  if (row.media !== undefined && row.media !== null) {
    if (!Array.isArray(row.media)) fail('REVIEW_MEDIA_SCHEMA_INVALID');
    for (const image of row.media) {
      if (!isObject(image) || typeof image.thumbnail !== 'string' || !Number.isSafeInteger(image.type)) {
        unsafeMediaCount++;
        continue;
      }
      let url;
      try { url = new URL(image.thumbnail); } catch { unsafeMediaCount++; continue; }
      const host = url.hostname.toLowerCase();
      if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
          !(host === 'rakuten.co.jp' || host.endsWith('.rakuten.co.jp') || host === 'r10s.jp' || host.endsWith('.r10s.jp'))) {
        unsafeMediaCount++;
        continue;
      }
      media.push({ thumbnailUrl: url.href, type: image.type,
        mediaKind: image.type === 1 ? 'image' : image.type === 2 ? 'video' : 'unknown' });
    }
  }
  if (media.length) review.media = media;
  return { review, unsafeMediaCount };
}

function noSecretOutput(value, secret) {
  const encoded = JSON.stringify(value);
  return !secret || !encoded.includes(secret);
}

/**
 * Read-only Rakuten Ichiba public review XHR adapter. The site's frontend
 * publishes a client authkey in its current review bundle; it is refreshed
 * from a live review page, held only in this client instance, and sent without
 * account cookies or user credentials.
 */
export function createRakutenIchibaPublicClient({
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') fail('CLIENT_CONFIGURATION_INVALID');
  let cachedFrontendKey = null;
  let cachedBootstrap = null;
  let cachedAt = 0;

  async function fetchReviewPage(reviewUrl) {
    const check = checkedAt(now);
    const fetched = await directHttp({
      url: reviewUrl,
      method: 'GET',
      headers: { accept: 'text/html,application/xhtml+xml' },
      expectedStatuses: [200],
      expectedMime: ['text/html', 'application/xhtml+xml'],
      maxBytes: MAX_PAGE_HTML_BYTES,
      fetchImpl,
      checked: check,
    });
    return { ...fetched, checkedAt: check };
  }

  async function bootstrapFrontendKey(reviewUrl, force = false) {
    const parsed = parseReviewUrl(reviewUrl);
    if (!force && cachedFrontendKey && now() - cachedAt < KEY_CACHE_TTL_MS) {
      return { key: cachedFrontendKey, metadata: { ...cachedBootstrap, reusedInProcess: true } };
    }
    const pageRead = await fetchReviewPage(parsed.url);
    const html = decodeHtml(pageRead.bytes, pageRead.contentType);
    const { document } = parseHTML(html);
    const assets = [];
    for (const script of document.querySelectorAll('script[src]')) {
      let asset;
      try { asset = new URL(script.getAttribute('src'), parsed.url); } catch { continue; }
      if (asset.origin === BUNDLE_ORIGIN && asset.pathname.startsWith(BUNDLE_PREFIX) &&
          /\/pc-[A-Za-z0-9_-]+\.bundle\.js$/.test(asset.pathname)) assets.push(asset);
    }
    const uniqueAssets = [...new Map(assets.map(asset => [asset.href, asset])).values()].slice(0, 5);
    if (!uniqueAssets.length) fail('PUBLIC_REVIEW_BUNDLE_NOT_FOUND', pageRead.receipt);
    let key;
    let bundleRead;
    for (const asset of uniqueAssets) {
      const check = checkedAt(now);
      const fetched = await directHttp({
        url: asset.href,
        method: 'GET',
        headers: { accept: 'application/javascript,text/javascript,*/*' },
        expectedStatuses: [200],
        expectedMime: ['application/javascript', 'text/javascript', 'application/x-javascript'],
        maxBytes: MAX_BUNDLE_BYTES,
        fetchImpl,
        checked: check,
      });
      const text = fetched.bytes.toString('utf8');
      try { key = parsePublicReviewAuthKey(text); }
      catch { continue; }
      bundleRead = {
        ...fetched.receipt,
        bootstrapSource: 'itemShopReviewList.authkey',
        endpointOrigin: REVIEW_ORIGIN,
        endpointPath: REVIEW_PATH,
        keyValuePersisted: false,
      };
      break;
    }
    if (!key || !bundleRead) fail('PUBLIC_REVIEW_KEY_BOOTSTRAP_FAILED', pageRead.receipt);
    cachedFrontendKey = key;
    cachedAt = now();
    cachedBootstrap = {
      sourcePage: pageRead.receipt,
      sourceBundle: bundleRead,
      publicFrontendKeyUsed: true,
      publicFrontendKeyHeader: 'authkey',
      publicFrontendKeySourceField: 'itemShopReviewList.authkey',
      userCredentialsUsed: false,
      cookiesSent: false,
      valuePersisted: false,
      reusedInProcess: false,
    };
    return { key, metadata: cachedBootstrap };
  }

  async function resolveReviewTarget({ productUrl, itemCode } = {}) {
    const check = checkedAt(now);
    let url;
    try { url = new URL(productUrl); } catch { fail('PRODUCT_URL_INVALID'); }
    if (url.protocol !== 'https:' || url.origin !== 'https://item.rakuten.co.jp' ||
        url.username || url.password || url.port || url.hash || url.search) fail('PRODUCT_URL_INVALID');
    const pathParts = url.pathname.split('/').filter(Boolean);
    if (pathParts.length < 2) fail('PRODUCT_URL_INVALID');
    const shopCode = pathParts[0];
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(shopCode)) fail('PRODUCT_URL_INVALID');
    const itemIdentity = itemCode === undefined ? null : itemCodeParts(itemCode);
    if (itemIdentity && itemIdentity.shopCode !== shopCode) fail('PRODUCT_SHOP_CODE_MISMATCH');
    const pageRead = await directHttp({
      url: url.href,
      method: 'GET',
      headers: { accept: 'text/html,application/xhtml+xml' },
      expectedStatuses: [200],
      expectedMime: ['text/html', 'application/xhtml+xml'],
      maxBytes: MAX_PAGE_HTML_BYTES,
      fetchImpl,
      checked: check,
    });
    const { document } = parseHTML(decodeHtml(pageRead.bytes, pageRead.contentType));
    const readField = name => document.querySelector(`input[name="${name}"]`)?.getAttribute('value') ?? null;
    const hiddenShopId = readField('shop_bid');
    const hiddenItemId = readField('item_id');
    const hiddenShopCode = readField('shopurl');
    let hiddenShopIdentity;
    let hiddenItemIdentity;
    try {
      hiddenShopIdentity = positiveDecimalId(hiddenShopId, 'PRODUCT_PAGE_IDENTITY_UNVERIFIED');
      hiddenItemIdentity = positiveDecimalId(hiddenItemId, 'PRODUCT_PAGE_IDENTITY_UNVERIFIED');
    } catch { fail('PRODUCT_PAGE_IDENTITY_UNVERIFIED', pageRead.receipt); }
    if (hiddenShopCode !== shopCode) fail('PRODUCT_PAGE_IDENTITY_UNVERIFIED', pageRead.receipt);
    const candidates = [];
    for (const anchor of document.querySelectorAll('a[href]')) {
      let target;
      try { target = new URL(anchor.getAttribute('href'), url.href); } catch { continue; }
      if (target.origin !== REVIEW_PAGE_ORIGIN) continue;
      let parsed;
      try { parsed = parseReviewUrl(target.href); } catch { continue; }
      if (parsed.shopId === hiddenShopIdentity.text && parsed.itemId === hiddenItemIdentity.text &&
          /レビュー|review/i.test((anchor.textContent ?? '').replace(/\s+/g, ' '))) candidates.push(parsed);
    }
    if (candidates.length !== 1) fail('PRODUCT_REVIEW_LINK_IDENTITY_UNVERIFIED', pageRead.receipt);
    const target = candidates[0];
    return {
      shopId: hiddenShopIdentity.text,
      itemId: hiddenItemIdentity.text,
      targetKey: `${hiddenShopIdentity.text}:${hiddenItemIdentity.text}`,
      reviewUrl: target.url,
      productUrl: url.href,
      ...(itemIdentity ? { requestedItemCode: itemIdentity.itemCode, requestedShopCodeMatched: true,
        itemCodePathMatched: pathParts.slice(1).includes(itemIdentity.itemPart) } : {}),
      targetVerified: true,
      targetMatchBasis: 'same_product_page_hidden_shop_bid_item_id_and_review_href',
      receipt: {
        schema: 'web-api-rakuten-review-target-bootstrap-v1',
        service: SERVICE,
        capabilityId: 'catalog.review_target_resolver',
        checkedAt: check,
        anonymous: true,
        authenticated: false,
        credentialsUsed: false,
        userCredentialsUsed: false,
        publicFrontendKeyUsed: false,
        secretsPersistedInEvidence: false,
        schemaVerified: true,
        expectedResultVerified: true,
        source: 'first_party_public_product_document_bootstrap_only',
        productPageRead: pageRead.receipt,
        matchedHiddenFields: ['shop_bid', 'item_id', 'shopurl'],
        reviewPathMatchedHiddenIds: true,
        productBodyPersisted: false,
      },
    };
  }

  async function getReviews({ shopId, itemId, reviewUrl, page = 1, mediaOnly = false, productUrl, itemCode } = {}) {
    if (!Number.isSafeInteger(page) || page < 1 || page > 100) fail('PAGE_INVALID');
    if (typeof mediaOnly !== 'boolean') fail('MEDIA_ONLY_INVALID');
    const idShop = positiveDecimalId(shopId, 'REVIEW_IDENTITY_REQUIRED');
    const idItem = positiveDecimalId(itemId, 'REVIEW_IDENTITY_REQUIRED');
    const parsedReviewUrl = parseReviewUrl(reviewUrl);
    if (parsedReviewUrl.shopId !== idShop.text || parsedReviewUrl.itemId !== idItem.text) fail('REVIEW_TARGET_IDENTITY_MISMATCH');
    let targetBootstrap;
    if (productUrl !== undefined) {
      targetBootstrap = await resolveReviewTarget({ productUrl, itemCode });
      if (targetBootstrap.shopId !== idShop.text || targetBootstrap.itemId !== idItem.text ||
          targetBootstrap.reviewUrl !== parsedReviewUrl.url) fail('PRODUCT_REVIEW_TARGET_MISMATCH');
    }
    const { key, metadata } = await bootstrapFrontendKey(parsedReviewUrl.url);
    const check = checkedAt(now);
    const requestBody = {
      common: { params: { device: 'pc' }, include: ['itemReviewList'] },
      features: {
        itemReviewList: {
          params: {
            shopId: idShop.number,
            itemId: idItem.number,
            sort: '',
            page: String(page),
            hits: REVIEW_PAGE_SIZE,
            filter: { rating: '', mediaOnly: String(mediaOnly), ageRange: '', sex: '' },
          },
        },
      },
    };
    const serialized = JSON.stringify(requestBody);
    if (Buffer.byteLength(serialized, 'utf8') > 16 * 1024) fail('REQUEST_TOO_LARGE');
    const apiRead = await directHttp({
      url: new URL(REVIEW_PATH, REVIEW_ORIGIN).href,
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json; charset=UTF-8',
        origin: REVIEW_PAGE_ORIGIN,
        referer: parsedReviewUrl.url,
        authkey: key,
      },
      body: serialized,
      expectedStatuses: [207],
      expectedMime: ['application/json'],
      maxBytes: MAX_REVIEW_BYTES,
      fetchImpl,
      checked: check,
    });
    let payload;
    try { payload = JSON.parse(apiRead.bytes.toString('utf8')); }
    catch { fail('REVIEW_JSON_INVALID', apiRead.receipt); }
    if (!isObject(payload) || payload.status !== 'SUCCESS' || !isObject(payload.body)) fail('REVIEW_API_STATUS_INVALID', apiRead.receipt);
    const feature = payload.body.itemReviewList;
    if (!isObject(feature) || (feature.status !== undefined && feature.status !== 'SUCCESS') || !isObject(feature.data)) {
      fail('REVIEW_COMPONENT_STATUS_INVALID', apiRead.receipt);
    }
    const data = feature.data;
    if (!Array.isArray(data.reviews) || data.reviews.length > REVIEW_PAGE_SIZE || !safeNonnegative(data.count) ||
        typeof data.hasNextPage !== 'boolean') fail('REVIEW_RESPONSE_SCHEMA_INVALID', apiRead.receipt);
    const reviews = [];
    let unsafeMediaCount = 0;
    for (const row of data.reviews) {
      const mapped = schemaOfReview(row, { shopId: idShop.text, itemId: idItem.text });
      reviews.push(mapped.review);
      unsafeMediaCount += mapped.unsafeMediaCount;
    }
    if (!noSecretOutput(reviews, key)) fail('REVIEW_RESPONSE_CONTAINS_PUBLIC_KEY', apiRead.receipt);
    const nativeIds = reviews.filter(row => row.identityKind === 'native_review_id').map(row => row.reviewId);
    const duplicateNativeIds = nativeIds.length - new Set(nativeIds).size;
    const allNativeIdsUnique = duplicateNativeIds === 0 && nativeIds.length === reviews.length;
    const readRequest = {
      ...apiRead.receipt,
      readOnly: true,
      publicFrontendKeyUsed: true,
      publicFrontendKeyHeader: 'authkey',
      userCredentialsUsed: false,
      bodyFields: [
        'common.params.device', 'common.include', 'features.itemReviewList.params.shopId',
        'features.itemReviewList.params.itemId', 'features.itemReviewList.params.sort',
        'features.itemReviewList.params.page', 'features.itemReviewList.params.hits',
        'features.itemReviewList.params.filter.rating', 'features.itemReviewList.params.filter.mediaOnly',
        'features.itemReviewList.params.filter.ageRange', 'features.itemReviewList.params.filter.sex',
      ],
      targetKey: `${idShop.text}:${idItem.text}`,
      pageParameterSent: page,
      mediaOnly,
    };
    const receipt = {
      schema: PUBLIC_RECEIPT_SCHEMA,
      service: SERVICE,
      capabilityId: mediaOnly ? 'catalog.public_review_photos'
        : page > 1 ? 'catalog.public_review_pagination' : 'catalog.public_review_page',
      checkedAt: check,
      secretsPersistedInEvidence: false,
      anonymous: true,
      authenticated: false,
      credentialsUsed: false,
      userCredentialsUsed: false,
      publicFrontendKeyUsed: true,
      schemaVerified: true,
      expectedResultVerified: true,
      targetKey: `${idShop.text}:${idItem.text}`,
      productIdMatched: parsedReviewUrl.shopId === idShop.text && parsedReviewUrl.itemId === idItem.text &&
        (targetBootstrap === undefined || targetBootstrap.targetVerified),
      targetMatchBasis: targetBootstrap?.targetMatchBasis ?? 'review_url_path_shop_item_ids_match_request',
      contractProvenance: { kind: 'browser_xhr_observed', sourceURL: parsedReviewUrl.url },
      publicFrontendBootstrap: metadata,
      ...(targetBootstrap ? { productTargetBootstrap: {
        source: 'first_party_public_product_page',
        productPageRead: targetBootstrap.receipt.productPageRead,
        productUrl: targetBootstrap.productUrl,
        reviewUrlMatched: targetBootstrap.reviewUrl === parsedReviewUrl.url,
        targetKey: targetBootstrap.targetKey,
      } } : {}),
      reviewPageRead: metadata.sourcePage,
      frontendBundleRead: metadata.sourceBundle,
      request: readRequest,
      result: {
        requestedPage: page,
        pageSize: REVIEW_PAGE_SIZE,
        totalReviews: data.count,
        returnedReviews: reviews.length,
        hasNextPage: data.hasNextPage,
        nextPage: data.hasNextPage ? page + 1 : null,
        paginationVerified: true,
        mediaOnly,
        returnedMedia: reviews.reduce((sum, row) => sum + (row.media?.length ?? 0), 0),
        unsafeMediaSkipped: unsafeMediaCount,
        nativeReviewIds: nativeIds.length,
        contentFingerprints: reviews.filter(row => row.identityKind === 'content_fingerprint').length,
        duplicateNativeIds,
        deduplicationExact: allNativeIdsUnique,
        completeForFilter: !data.hasNextPage && allNativeIdsUnique,
      },
    };
    return {
      productId: `${idShop.text}:${idItem.text}`,
      targetKey: `${idShop.text}:${idItem.text}`,
      shopId: idShop.text,
      itemId: idItem.text,
      productIdMatched: receipt.productIdMatched,
      reviews,
      totalReviews: data.count,
      total: data.count,
      paginationVerified: true,
      nextCursor: data.hasNextPage ? page + 1 : null,
      deduplicationExact: allNativeIdsUnique,
      completeForFilter: !data.hasNextPage && allNativeIdsUnique,
      pagination: {
        page,
        pageSize: REVIEW_PAGE_SIZE,
        totalReviews: data.count,
        hasNextPage: data.hasNextPage,
        nextPage: data.hasNextPage ? page + 1 : null,
      },
      mediaOnly,
      receipts: [readRequest],
      receipt,
    };
  }

  return Object.freeze({ resolveReviewTarget, getReviews });
}
