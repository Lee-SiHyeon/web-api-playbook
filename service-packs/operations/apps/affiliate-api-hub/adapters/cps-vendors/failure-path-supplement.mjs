import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseFragment } from 'parse5';
import { extractPublicPage, safeUrl, textContent } from '../../lib/cps-public-reader.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT = path.resolve(HERE, '../../references/cps-reverify/failure-path-supplement.json');
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const PAUSE_MS = 180;

const MERCHANTS = Object.freeze({
  jestina: {
    siteUrl: 'https://www.jestina.co.kr/',
    vertical: 'fashion',
    observedProductRoutes: ['https://www.jestina.co.kr/products/view/G2000030770?cateCd=282'],
  },
  mycredit1: {
    siteUrl: 'https://www.credit.co.kr/',
    vertical: 'financial_service',
    observedLocation: 'https://www.credit.co.kr/ib20/mnu/BZWMAN00001',
  },
  yes24: {
    siteUrl: 'https://www.yes24.com/',
    vertical: 'books',
    observedCategoryText: ['소설/시/희곡', '에세이'],
  },
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function registrableRoot(hostname) {
  const host = hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  const labels = host.split('.');
  const suffix = ['co.kr','or.kr','go.kr','ac.kr','co.uk','org.uk','com.au','net.au','co.nz','co.jp','com.sg','com.hk','com.tw']
    .find(value => host.endsWith(`.${value}`));
  const count = suffix ? suffix.split('.').length + 1 : 2;
  return labels.slice(-count).join('.');
}

function sameProvider(urlText, allowedRoot) {
  try { return new URL(urlText).protocol === 'https:' && registrableRoot(new URL(urlText).hostname) === allowedRoot; }
  catch { return false; }
}

function text(value, max = 1200) {
  if (typeof value !== 'string') return null;
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) || null;
}

function decodeHtml(bytes, contentType) {
  const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType ?? '')?.[1] ?? 'utf-8';
  try { return new TextDecoder(charset, { fatal: false }).decode(bytes); }
  catch { return new TextDecoder('utf-8', { fatal: false }).decode(bytes); }
}

function attrs(node) { return Object.fromEntries((node?.attrs ?? []).map(item => [item.name.toLowerCase(), item.value])); }

function walk(root, predicate, output = []) {
  if (!root || output.length >= 8000) return output;
  if (predicate(root)) output.push(root);
  for (const child of root.childNodes ?? []) walk(child, predicate, output);
  return output;
}

function metadata(html) {
  const root = parseFragment(html ?? '');
  const all = walk(root, () => true, []);
  const meta = all.filter(node => node.tagName === 'meta').map(node => attrs(node));
  const findMeta = (...names) => {
    for (const name of names) {
      const found = meta.find(row => (row.property ?? row.name ?? '').toLowerCase() === name.toLowerCase());
      if (found?.content) return text(found.content, 2000);
    }
    return null;
  };
  const heading = all.filter(node => node.tagName === 'h1').map(node => text(textContent(node, 500))).find(Boolean) ?? null;
  const title = findMeta('og:title', 'twitter:title') ?? heading;
  const description = findMeta('og:description', 'description', 'twitter:description');
  const anchors = all.filter(node => node.tagName === 'a').map(node => {
    const a = attrs(node);
    const imageAlt = walk(node, child => child.tagName === 'img', []).map(img => attrs(img).alt).find(Boolean);
    const linkText = text(textContent(node, 500)) ?? text(a.title, 500) ?? text(imageAlt, 500);
    return { url: typeof a.href === 'string' ? a.href : null, text: linkText };
  }).filter(item => item.url);
  const priceMeta = meta.find(row => row.itemprop?.toLowerCase() === 'price')?.content
    ?? meta.find(row => row.property?.toLowerCase() === 'product:price:amount')?.content
    ?? null;
  const visible = text(textContent(root, 20_000), 20_000) ?? '';
  const labelMatches = [...visible.matchAll(/(?:쿠폰적용가|쿠폰가|최종가|판매가|할인가|정가|가격)\s*[:：]?\s*(?:₩\s*|KRW\s*)?([0-9][0-9,]*)(?:\s*원)?/gi)];
  const prices = labelMatches.map(match => ({ label: text(match[0], 100), amount: Number(match[1].replaceAll(',', '')) })).filter(row => Number.isFinite(row.amount));
  const itemPrice = walk(root, node => node.attrs?.some(attr => attr.name.toLowerCase() === 'itemprop' && attr.value.toLowerCase() === 'price'), [])
    .map(node => { const a = attrs(node); const raw = a.content ?? text(textContent(node, 100)); const amount = Number(String(raw ?? '').replace(/[^0-9.]/g, '')); return Number.isFinite(amount) ? amount : null; })
    .find(value => value != null) ?? null;
  const currentPrice = itemPrice ?? prices.find(row => /쿠폰적용가|쿠폰가|최종가|판매가|할인가/i.test(row.label))?.amount ?? null;
  return { root, anchors, title, description, visiblePriceLabels: [...new Set(prices.map(row => row.label))].slice(0, 8),
    priceAmount: currentPrice, priceText: currentPrice == null ? null : prices.find(row => row.amount === currentPrice)?.label ?? String(currentPrice),
    explicitWonUnit: /(?:[0-9][0-9,]*)\s*원/.test(visible), visibleText: visible };
}

function pageError(title, html, finalUrl) {
  const bodyText = text(textContent(html, 12_000), 12_000) ?? '';
  const combined = `${title ?? ''} ${bodyText} ${finalUrl ?? ''}`;
  return /(시스템 처리 시 에러|시스템 에러|서비스 오류|페이지를 찾을 수 없|일시적인 오류|temporarily unavailable|internal server error|error[_ -]?500)/i.test(combined);
}

function visibleChallenge(title, html) {
  const bodyText = text(textContent(html, 6000), 6000) ?? '';
  return /(verify (?:that )?you are human|captcha|로봇이 아닙니다|비정상적인 접근|요청이 차단|security challenge|access denied)/i.test(`${title ?? ''} ${bodyText}`);
}

async function readOne(inputUrl, allowedRoot, report, operation, parentUrl = null, edgeType = 'observed_link') {
  let currentUrl = inputUrl;
  const redirects = [];
  let final = null;
  let stopReason = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!sameProvider(currentUrl, allowedRoot)) {
      stopReason = 'URL_OUTSIDE_OBSERVED_PROVIDER_SCOPE';
      break;
    }
    let response;
    const startedAt = new Date().toISOString();
    try {
      // Deliberately use native fetch defaults: no custom headers, user-agent, cookies or authorization.
      response = await fetch(currentUrl, { redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      stopReason = error?.name === 'TimeoutError' ? 'NATIVE_FETCH_TIMEOUT' : 'NATIVE_FETCH_TRANSPORT_ERROR';
      report.contracts.push({ operation, method: 'GET', requestUrl: safeUrl(currentUrl), responseStatus: null,
        contentType: null, observedAt: startedAt, stopReason, execution: { browserUsed: false, cookiesSent: false,
          authorizationSent: false, userAgentOverridden: false } });
      break;
    }
    const status = response.status;
    const contentType = response.headers.get('content-type');
    const observedAt = new Date().toISOString();
    const isRedirect = status >= 300 && status < 400;
    const receipt = { id: randomUUID(), requestMethod: 'GET', requestUrl: safeUrl(currentUrl), responseUrl: safeUrl(currentUrl),
      responseStatus: status, contentType, bytes: 0, responseSha256: null, observedAt, browserUsed: false,
      cookiesSent: false, authorizationSent: false, userAgentOverridden: false };
    let html = null;
    let bytes = Buffer.alloc(0);
    if (isRedirect) {
      const location = response.headers.get('location');
      try { await response.body?.cancel(); } catch { /* no response body is needed to follow Location */ }
      if (!location) { stopReason = 'REDIRECT_LOCATION_MISSING'; receipt.stopReason = stopReason; }
      else {
        let next;
        try { next = new URL(location, currentUrl); } catch { stopReason = 'REDIRECT_URL_INVALID'; receipt.stopReason = stopReason; }
        if (next && new URL(currentUrl).protocol === 'https:' && next.protocol !== 'https:') { stopReason = 'REDIRECT_HTTPS_DOWNGRADE_REJECTED'; receipt.stopReason = stopReason; }
        else if (next && !sameProvider(next.href, allowedRoot)) { stopReason = 'REDIRECT_OUTSIDE_OBSERVED_PROVIDER'; receipt.stopReason = stopReason; }
        else if (next && hop === MAX_REDIRECTS) { stopReason = 'REDIRECT_LIMIT_REACHED'; receipt.stopReason = stopReason; }
        else if (next) {
          receipt.redirectTo = safeUrl(next.href);
          redirects.push({ status, from: safeUrl(currentUrl), to: safeUrl(next.href) });
          currentUrl = next.href;
        }
      }
      report.receipts.push(receipt);
      report.contracts.push({ operation, method: 'GET', requestUrl: receipt.requestUrl, finalUrl: receipt.redirectTo ?? receipt.responseUrl,
        responseStatus: status, contentType, bytes: 0, responseSha256: null, observedAt, redirectTo: receipt.redirectTo ?? null,
        receiptId: receipt.id, execution: { browserUsed: false, cookiesSent: false, authorizationSent: false, userAgentOverridden: false } });
      if (stopReason) break;
      continue;
    }

    if ([401, 403, 418, 429].includes(status)) {
      try { await response.body?.cancel(); } catch { /* rejected response is not read */ }
      receipt.stopReason = `HTTP_${status}`;
      report.receipts.push(receipt);
      report.contracts.push({ operation, method: 'GET', requestUrl: receipt.requestUrl, finalUrl: receipt.responseUrl,
        responseStatus: status, contentType, bytes: 0, responseSha256: null, observedAt, stopReason: receipt.stopReason,
        receiptId: receipt.id, execution: { browserUsed: false, cookiesSent: false, authorizationSent: false, userAgentOverridden: false } });
      stopReason = receipt.stopReason;
      break;
    }

    try {
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > MAX_BYTES) {
        await response.body?.cancel();
        stopReason = 'RESPONSE_TOO_LARGE';
      } else {
        bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.byteLength > MAX_BYTES) stopReason = 'RESPONSE_TOO_LARGE';
        else if (/text\/html|application\/xhtml\+xml/i.test(contentType ?? '')) html = decodeHtml(bytes, contentType);
      }
    } catch { stopReason = 'RESPONSE_BODY_READ_FAILED'; }
    receipt.bytes = bytes.byteLength;
    receipt.responseSha256 = bytes.byteLength ? createHash('sha256').update(bytes).digest('hex') : null;
    report.receipts.push(receipt);
    if (stopReason) {
      report.contracts.push({ operation, method: 'GET', requestUrl: receipt.requestUrl, finalUrl: receipt.responseUrl,
        responseStatus: status, contentType, bytes: receipt.bytes, responseSha256: receipt.responseSha256,
        observedAt, stopReason, receiptId: receipt.id, execution: { browserUsed: false, cookiesSent: false,
          authorizationSent: false, userAgentOverridden: false } });
      break;
    }

    const page = html ? extractPublicPage({ ok: true, url: currentUrl, status, contentType, html, receipt }) : null;
    const pageMeta = html ? metadata(html) : null;
    const challenge = html ? visibleChallenge(page?.title, html) : false;
    const errorPage = html ? pageError(page?.title, html, currentUrl) : false;
    const state = challenge ? 'confirmed_visible_challenge' : [401,403,418,429].includes(status) ? `hard_reject_${status}`
      : status >= 500 ? `http_${status}` : status !== 200 ? `http_${status}`
        : errorPage ? 'first_party_error_or_expiry_page' : !html ? 'non_html_response' : 'public_html';
    const frontierState = challenge || [401,403,418,429].includes(status) ? 'blocked'
      : state === 'public_html' ? 'inspected' : 'pending';
    const contract = { operation, method: 'GET', requestUrl: receipt.requestUrl, finalUrl: receipt.responseUrl,
      responseStatus: status, contentType, bytes: receipt.bytes, responseSha256: receipt.responseSha256,
      observedAt, redirects, pageTitle: page?.title ?? null, pageDescription: page?.description ?? null,
      jsonLdObjectCount: page?.jsonLd?.length ?? 0, embeddedJsonBlockCount: page?.embeddedJson?.length ?? 0,
      observedLinkCount: page?.links?.length ?? 0, normalizedRecordCount: page?.records?.length ?? 0,
      stopReason: challenge ? 'VISIBLE_CHALLENGE' : errorPage ? 'FIRST_PARTY_ERROR_PAGE' : status >= 500 ? `HTTP_${status}` : null,
      receiptId: receipt.id, execution: { browserUsed: false, cookiesSent: false, authorizationSent: false, userAgentOverridden: false } };
    report.contracts.push(contract);
    report.frontier.push({ url: receipt.responseUrl, parentUrl: safeUrl(parentUrl), sourceReceiptId: receipt.id,
      edgeType, state: frontierState, stopReason: contract.stopReason,
      note: errorPage ? 'First-party error/expiry HTML. No offering record was inferred from the error page.' : null });
    final = { page, pageMeta, html, url: currentUrl, receipt, errorPage, challenge, status, contentType, visibleText: html ? text(textContent(html, 20_000), 20_000) : null };
    if (status >= 500 || status !== 200 || challenge || errorPage || !html) stopReason = contract.stopReason ?? state;
    break;
  }
  if (final) final.redirects = redirects;
  return { final, stopReason, redirects };
}

function productPath(merchantId, urlText) {
  try {
    const url = new URL(urlText);
    if (merchantId === 'jestina') return /^\/products\/view\/[A-Za-z0-9_-]+\/?$/i.test(url.pathname);
    if (merchantId === 'yes24') return /^\/product\/goods\/[A-Za-z0-9_-]+(?:\.aspx)?\/?$/i.test(url.pathname);
    return false;
  } catch { return false; }
}

function observedProductLinks(merchantId, page, allowedRoot) {
  if (!page?.page || !page?.pageMeta) return [];
  const links = page.page.links.map(link => ({ ...link,
    url: safeUrl(link.url, page.url), text: text(link.text, 500) ?? null }));
  return [...new Map(links.filter(link => link.url && sameProvider(link.url, allowedRoot) && productPath(merchantId, link.url))
    .map(link => [link.url, link])).values()].slice(0, 2);
}

function categoryLinksFromYes24(page, allowedRoot) {
  if (!page?.page) return [];
  const links = page.page.links.map(link => ({ ...link, url: safeUrl(link.url, page.url), text: text(link.text, 300) }));
  const observed = links.filter(link => link.url && sameProvider(link.url, allowedRoot)
    && /^\/product\/category\/display\/\d+\/?$/i.test(new URL(link.url).pathname)
    && ['소설/시/희곡','에세이'].includes(link.text));
  const selected = [];
  for (const label of MERCHANTS.yes24.observedCategoryText) {
    const link = observed.find(item => item.text === label);
    if (link && !selected.some(item => item.url === link.url)) selected.push(link);
  }
  return selected.slice(0, 2);
}

function observedSafeServiceLinks(page, allowedRoot) {
  if (!page?.page) return [];
  const links = page.page.links.map(link => ({ ...link, url: safeUrl(link.url, page.url), text: text(link.text, 300) }));
  const safe = links.filter(link => {
    if (!link.url || link.url === safeUrl(page.url) || !sameProvider(link.url, allowedRoot)) return false;
    const url = new URL(link.url);
    if (/login|logout|member|mypage|account|join|password|auth|order|payment|apply|request|withdraw/i.test(url.pathname)) return false;
    return /신용|대출|카드|보험|서비스|관리|혜택/.test(link.text ?? '')
      && /\/ib20\/mnu\//i.test(url.pathname);
  });
  return [...new Map(safe.map(link => [link.url, link])).values()].slice(0, 2);
}

function localIdFromUrl(merchantId, urlText) {
  try {
    const url = new URL(urlText);
    if (merchantId === 'jestina') return url.pathname.match(/\/products\/view\/([A-Za-z0-9_-]+)/i)?.[1] ?? null;
    if (merchantId === 'yes24') return url.pathname.match(/\/Product\/Goods\/([A-Za-z0-9_-]+)/i)?.[1] ?? null;
    return null;
  } catch { return null; }
}

function namedOfferingTitle(value) {
  const title = text(value, 800);
  if (!title || title.length < 4) return false;
  return !/^(?:상품고시|상품정보제공고시|상품 상세|상세정보|배송안내|예스24|제이에스티나 공식온라인스토어|소설\/시\/희곡 - 예스24|에세이 - 예스24)$/i.test(title);
}

function jestinaProductDetails(html) {
  const root = parseFragment(html ?? '');
  const all = walk(root, () => true, []);
  const headings = all.filter(node => node.tagName === 'h2').map(node => text(textContent(node, 500))).filter(Boolean);
  const title = headings.find(value => namedOfferingTitle(value) && /\([A-Z0-9]{8,}\)/.test(value)) ?? null;
  const sku = title?.match(/\(([A-Z0-9]{8,})\)/)?.[1] ?? null;
  const byClass = className => all.find(node => {
    const classValue = attrs(node).class ?? '';
    return classValue.split(/\s+/).includes(className);
  }) ?? null;
  const listNode = byClass('prod-overview__price-gray');
  const currentNode = byClass('prod-overview__price-black');
  const discountNode = byClass('prod-overview__price-main');
  const benefitNode = byClass('product-benefit__wrapper');
  const parseWon = node => {
    const value = node ? text(textContent(node, 200)) : null;
    const match = value?.match(/([0-9][0-9,]*)\s*원/);
    return match ? Number(match[1].replaceAll(',', '')) : null;
  };
  const saleAmount = parseWon(currentNode);
  const listAmount = parseWon(listNode);
  const discountText = discountNode ? text(textContent(discountNode, 300)) : null;
  const benefitText = benefitNode ? text(textContent(benefitNode, 800)) : null;
  const explicitCurrency = [listNode, currentNode, discountNode, benefitNode]
    .some(node => node && /[0-9][0-9,]*\s*원/.test(text(textContent(node, 800)) ?? ''));
  return { title, sku, saleAmount, listAmount, explicitCurrency,
    discountPercent: Number(discountText?.match(/([0-9]{1,2})\s*%/)?.[1] ?? NaN) || null,
    priceText: currentNode ? text(textContent(currentNode, 200)) : null,
    discountText, benefitText,
    locators: { title: 'h2:first product title with visible item code', currentPrice: 'p.prod-overview__price-black',
      listPrice: 'div.prod-overview__price-gray', discount: 'div.prod-overview__price-main', benefit: 'div.product-benefit__wrapper' } };
}

function offeringRecord(merchantId, pageResult, link = null) {
  const page = pageResult?.final;
  if (!page || page.status !== 200 || page.errorPage || page.challenge || !page.page) return [];
  const records = [];
  if (merchantId === 'jestina') {
    const product = jestinaProductDetails(page.html);
    const itemUrl = link?.url ?? page.url;
    const sourceLocalId = localIdFromUrl(merchantId, itemUrl);
    if (!product.title || !sourceLocalId) return [];
    const currency = product.explicitCurrency && product.saleAmount != null ? 'KRW' : null;
    records.push({ type: 'RetailProduct', ontologyType: 'RetailProduct', sourceLocalId, sourceSku: product.sku, identifiers: product.sku ? { sku: product.sku } : {},
      title: product.title, url: safeUrl(itemUrl), description: null, brand: null,
      price: { amount: product.saleAmount, currency, priceText: product.priceText,
        priceKind: 'coupon_adjusted_sale_price', listAmount: product.listAmount,
        condition: 'The page labels this as a 10% discounted display price and states coupon application is limited to members; coupon eligibility/redemption was not tested.',
        qualifiers: [product.discountText, product.benefitText].filter(Boolean) },
      rating: { value: null, best: null, worst: null, reviewCount: null, ratingCount: null }, variants: [], reviewSamples: [],
      ontologyBasis: 'A first-party product detail URL contains a product-name h2 with a visible item code and the primary displayed sale-price element. The route product ID is retained as sourceLocalId; currency is supported by explicit 원 text.',
      evidence: [{ receiptId: page.receipt.id, locator: `${product.locators.title}; ${product.locators.currentPrice}; ${product.locators.listPrice}; ${product.locators.discount}; ${product.locators.benefit}`,
        fields: ['sourceLocalId', ...(product.sku ? ['sourceSku', 'identifiers'] : []), 'title', 'url', ...(product.saleAmount != null ? ['price'] : []),
          ...(product.listAmount != null ? ['price.listAmount'] : []), ...(product.explicitCurrency ? ['price.currency'] : [])] }] });
    return records;
  }
  for (const row of page.page.records ?? []) {
    if (!namedOfferingTitle(row.title) || !row.url || !productPath(merchantId, row.url)) continue;
    const schema = page.page.jsonLd.find(item => text(item.name, 800) === row.title) ?? null;
    const rawType = schema?.['@type'];
    const sourceSchemaType = Array.isArray(rawType) ? rawType.map(value => String(value).split(/[\/#]/).at(-1)).join(',')
      : typeof rawType === 'string' ? rawType.split(/[\/#]/).at(-1) : null;
    records.push({ ...row, type: merchantId === 'yes24' ? 'RetailProduct' : 'RetailProduct', ontologyType: 'RetailProduct',
      sourceLocalId: row.sourceLocalId ?? localIdFromUrl(merchantId, row.url), sourceSchemaType: sourceSchemaType ?? undefined,
      ontologyBasis: merchantId === 'yes24' ? 'A first-party YES24 book goods detail URL and book-category route identify a purchasable book.'
        : 'A first-party Jestina product detail route identifies a physical fashion or jewelry item.',
      evidence: (row.evidence ?? []).map(proof => ({ ...proof,
        fields: [...new Set([...(proof.fields ?? []), ...(sourceSchemaType ? ['@type', 'sourceSchemaType'] : [])])] })) });
  }
  const itemUrl = link?.url ?? page.url;
  const meta = page.pageMeta;
  const title = text(meta.title, 500);
  const validTitle = namedOfferingTitle(title);
  const id = localIdFromUrl(merchantId, itemUrl);
  if (!records.length && validTitle && id) {
    const schemaType = page.page.jsonLd.flatMap(item => {
      const type = item?.['@type']; return Array.isArray(type) ? type : type ? [type] : [];
    }).map(type => String(type).split(/[\/#]/).at(-1)).find(type => /^(Product|Book)$/i.test(type)) ?? null;
    records.push({ type: 'RetailProduct', ontologyType: 'RetailProduct', sourceLocalId: id, title,
      url: safeUrl(itemUrl), description: text(meta.description, 2000), brand: null,
      price: { amount: meta.priceAmount, currency: meta.priceAmount == null ? null : 'KRW', priceText: meta.priceText },
      rating: { value: null, best: null, worst: null, reviewCount: null, ratingCount: null }, variants: [], reviewSamples: [],
      ...(schemaType ? { sourceSchemaType: schemaType } : {}),
      ontologyBasis: merchantId === 'yes24' ? 'First-party public book category link and named book-detail HTML; no author or reviewer identity retained.'
        : 'First-party public product route and named item metadata/text; no schema.org product object was present.',
      evidence: [{ receiptId: page.receipt.id, locator: schemaType ? 'first-party JSON-LD plus product route' : 'first-party product-detail HTML metadata/visible price labels',
        fields: ['sourceLocalId', 'title', 'url', ...(meta.description ? ['description'] : []), ...(meta.priceAmount != null ? ['price'] : []),
          ...(schemaType ? ['@type', 'sourceSchemaType'] : [])] }] });
  }
  return records.slice(0, 2);
}

function reportBase(merchantId, spec, checkedAt) {
  return { merchantId, siteUrl: spec.siteUrl, checkedAt, adapter: 'native-fetch-failure-path-supplement',
    execution: { client: 'Node native fetch default transport', browserUsed: false, cookiesSent: false,
      authorizationSent: false, userAgentOverridden: false, redirectPolicy: 'manual; HTTPS same-registrable-provider only; max 3 redirects' },
    receipts: [], contracts: [], records: [], frontier: [], status: 'pending' };
}

async function collectMerchant(merchantId) {
  const spec = MERCHANTS[merchantId];
  const root = registrableRoot(new URL(spec.siteUrl).hostname);
  const report = reportBase(merchantId, spec, new Date().toISOString());
  const first = await readOne(spec.siteUrl, root, report, 'homepage_read');
  let rootPage = first.final;
  if (first.stopReason) {
    report.status = first.stopReason.startsWith('hard_reject_') ? `blocked_${first.stopReason.replace('hard_reject_', 'http_')}`
      : first.stopReason === 'confirmed_visible_challenge' ? 'blocked_challenge' : first.stopReason;
    report.frontier.push({ url: safeUrl(spec.siteUrl), state: report.status.startsWith('blocked_') ? 'blocked' : 'pending', stopReason: first.stopReason });
    return report;
  }
  if (!rootPage) { report.status = first.stopReason ?? 'root_unavailable'; return report; }

  const detailResults = [];
  if (merchantId === 'jestina') {
    const observed = observedProductLinks(merchantId, rootPage, root);
    const candidateUrls = observed.length ? observed.map(item => item.url) : spec.observedProductRoutes;
    for (const url of candidateUrls.slice(0, 2)) {
      await delay(PAUSE_MS);
      const result = await readOne(url, root, report, 'observed_product_detail_read', rootPage.url,
        observed.length ? 'homepage_to_observed_product_detail' : 'prior_batch_observed_product_candidate');
      detailResults.push({ result, link: observed.find(item => item.url === url) ?? { url, text: null } });
      if (result.stopReason?.startsWith('hard_reject_') || result.stopReason === 'confirmed_visible_challenge') {
        report.frontier.push({ url: safeUrl(url), state: 'blocked', stopReason: result.stopReason });
        report.status = result.stopReason.startsWith('hard_reject_') ? `blocked_${result.stopReason.replace('hard_reject_', 'http_')}` : 'blocked_challenge';
        return report;
      }
    }
  }

  if (merchantId === 'yes24') {
    const categories = categoryLinksFromYes24(rootPage, root);
    const productLinkSets = [];
    for (const category of categories) {
      await delay(PAUSE_MS);
      const result = await readOne(category.url, root, report, 'observed_book_category_read', rootPage.url, 'homepage_to_observed_book_category');
      if (result.stopReason?.startsWith('hard_reject_') || result.stopReason === 'confirmed_visible_challenge') {
        report.status = result.stopReason.startsWith('hard_reject_') ? `blocked_${result.stopReason.replace('hard_reject_', 'http_')}` : 'blocked_challenge';
        return report;
      }
      if (!result.final || result.stopReason) continue;
      const links = observedProductLinks(merchantId, result.final, root);
      productLinkSets.push(...links.map(link => ({ ...link, parentUrl: result.final.url })));
    }
    const uniqueBookLinks = [...new Map(productLinkSets.map(link => [link.url, link])).values()].slice(0, 2);
    for (const bookLink of uniqueBookLinks) {
      await delay(PAUSE_MS);
      const result = await readOne(bookLink.url, root, report, 'observed_book_detail_read', bookLink.parentUrl, 'book_category_to_observed_book_detail');
      detailResults.push({ result, link: bookLink });
      if (result.stopReason?.startsWith('hard_reject_') || result.stopReason === 'confirmed_visible_challenge') {
        report.status = result.stopReason.startsWith('hard_reject_') ? `blocked_${result.stopReason.replace('hard_reject_', 'http_')}` : 'blocked_challenge';
        return report;
      }
    }
    if (!categories.length) report.frontier.push({ url: safeUrl(rootPage.url), state: 'pending',
      stopReason: 'OBSERVED_BOOK_CATEGORY_LINK_NOT_FOUND', note: '홈페이지의 실제 앵커에서 지정된 도서 카테고리를 찾지 못함.' });
    if (categories.length && !uniqueBookLinks.length) report.frontier.push({ url: categories[0].url, state: 'pending',
      stopReason: 'NO_OBSERVED_BOOK_DETAIL_LINK', note: '도서 카테고리 페이지는 읽었지만 상품 상세 경로를 확인하지 못함.' });
  }

  if (merchantId === 'mycredit1') {
    const safeLinks = observedSafeServiceLinks(rootPage, root);
    for (const link of safeLinks) {
      await delay(PAUSE_MS);
      const result = await readOne(link.url, root, report, 'observed_public_service_read', rootPage.url, 'homepage_to_observed_service_page');
      detailResults.push({ result, link });
      if (result.stopReason?.startsWith('hard_reject_') || result.stopReason === 'confirmed_visible_challenge') {
        report.status = result.stopReason.startsWith('hard_reject_') ? `blocked_${result.stopReason.replace('hard_reject_', 'http_')}` : 'blocked_challenge';
        return report;
      }
    }
    if (!safeLinks.length) report.frontier.push({ url: safeUrl(rootPage.url), state: 'pending',
      stopReason: 'NO_NAMED_PUBLIC_CREDIT_SUBSERVICE_LINK', note: '브랜드 메인 페이지에 대한 자기 링크를 제외했으며, 이름 있는 신용관리 기능·신용보고서·요금제의 별도 공개 페이지 링크를 확인하지 못함.' });
  }

  const pages = [{ result: first, link: null }, ...detailResults];
  for (const item of pages) {
    const page = item.result.final;
    if (!page || page.status !== 200 || page.errorPage || page.challenge) continue;
    const records = offeringRecord(merchantId, item.result, item.link);
    for (const record of records) {
      if (!record.evidence?.some(evidence => evidence.receiptId)) continue;
      if (!report.records.some(existing => existing.sourceLocalId === record.sourceLocalId && existing.url === record.url)) report.records.push(record);
    }
  }
  if (merchantId === 'jestina') {
    for (const record of report.records) report.frontier.push({ url: record.url, state: 'not_observed',
      sourceReceiptId: record.evidence?.[0]?.receiptId ?? null,
      stopReason: 'NO_PUBLIC_REVIEW_SUMMARY_OR_VARIANTS_IN_CAPTURED_PRODUCT_HTML',
      note: '상품 상세 페이지에는 리뷰 탭 이름만 보였고 리뷰 요약·리뷰 본문 또는 variant 값은 노출되지 않아 기록하지 않음.' });
  }
  const finalRoot = first.final;
  if (finalRoot.errorPage || finalRoot.status >= 500) report.status = finalRoot.errorPage ? 'first_party_error_or_expiry_page' : `http_${finalRoot.status}`;
  else if (report.records.length) report.status = 'public_ontology_records_verified_partial_catalog';
  else report.status = 'public_site_reached_no_named_offering_record';
  report.coverage = { pagesRead: report.receipts.filter(row => row.responseStatus === 200).length,
    recordsRead: report.records.length, catalogExhausted: false, reviewPaginationComplete: false,
    nextLinksInspected: detailResults.length, maxNextLinks: merchantId === 'yes24' ? 4 : merchantId === 'mycredit1' ? 2 : 2 };
  for (const contract of report.contracts) {
    contract.normalizedRecordCount = report.records.filter(record => (record.evidence ?? []).some(item => item.receiptId === contract.receiptId)).length;
  }
  report.operations = {
    product_or_service_detail: { state: report.records.length ? 'live_replay_verified' : 'not_observed', recordCount: report.records.length },
    price: { state: report.records.some(row => row.price?.amount != null || row.offers?.length) ? 'live_replay_verified' : 'not_observed' },
    rating_summary: { state: report.records.some(row => row.rating?.value != null || row.rating?.reviewCount != null) ? 'aggregate_observed' : 'not_observed' },
    reviews_list: { state: 'not_observed', sampleCount: 0 },
  };
  return report;
}

function atomicWrite(report) {
  const temp = `${OUTPUT}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    renameSync(temp, OUTPUT);
  } catch (error) {
    try { if (existsSync(temp)) unlinkSync(temp); } catch { /* cleanup only */ }
    throw error;
  }
}

function buildSupplement(reports, prior = null) {
  const merged = new Map((prior?.merchants ?? []).filter(row => row?.merchantId).map(row => [row.merchantId, row]));
  for (const report of reports) merged.set(report.merchantId, report);
  const merchants = [...merged.values()];
  return { ...(prior ?? {}), schemaVersion: 1, generatedAt: new Date().toISOString(),
    execution: { mode: 'anonymous_native_fetch_public_html', browserUsed: false, cookiesSent: false,
      authorizationSent: false, userAgentOverridden: false, redirectPolicy: 'manual; HTTPS same-provider only; maximum 3 redirects',
      challengePolicy: 'stop immediately on 401/403/418/429 or confirmed challenge',
      bodyPolicy: 'parse HTML in memory; persist only sanitized URL/status/MIME/byte/hash/time receipts and normalized offerings' },
    merchantCount: merchants.length, summary: { reachableRoots: merchants.filter(row => row.contracts?.some(contract => contract.operation === 'homepage_read' && contract.responseStatus === 200)).length,
      offeringRecords: merchants.reduce((sum, row) => sum + (row.records?.length ?? 0), 0), blocked: merchants.filter(row => String(row.status).startsWith('blocked_')).length },
    merchants };
}

function publicMerchantSummary(row) {
  return { merchantId: row.merchantId, status: row.status, recordCount: row.records.length,
    receiptCount: row.receipts.length, pendingFrontierCount: row.frontier.filter(item => item.state === 'pending').length,
    receiptSummaries: row.receipts.map(receipt => ({ requestUrl: receipt.requestUrl, responseStatus: receipt.responseStatus,
      contentType: receipt.contentType, bytes: receipt.bytes, responseSha256: receipt.responseSha256, observedAt: receipt.observedAt })),
    records: row.records.map(({ type, sourceLocalId, sourceSku, title, url, price, rating }) => ({ type, sourceLocalId, sourceSku, title, url, price, rating })) };
}

export const failurePathMerchantIds = Object.freeze(Object.keys(MERCHANTS));

export async function collectFailurePathMerchant(merchantId) {
  if (!Object.hasOwn(MERCHANTS, merchantId)) throw new RangeError(`Unknown failure-path merchant: ${String(merchantId)}`);
  const prior = existsSync(OUTPUT) ? JSON.parse(readFileSync(OUTPUT, 'utf8')) : null;
  const report = await collectMerchant(merchantId);
  const supplement = buildSupplement([report], prior);
  atomicWrite(supplement);
  return report;
}

export async function collectFailurePathSupplement() {
  const reports = [];
  for (const merchantId of Object.keys(MERCHANTS)) reports.push(await collectMerchant(merchantId));
  const supplement = buildSupplement(reports);
  atomicWrite(supplement);
  return { path: OUTPUT, merchantCount: reports.length, summary: supplement.summary,
    merchants: reports.map(publicMerchantSummary) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const merchantId = process.argv[2];
  if (merchantId && !Object.hasOwn(MERCHANTS, merchantId)) throw new RangeError(`Unknown failure-path merchant: ${merchantId}`);
  const result = merchantId ? await collectFailurePathMerchant(merchantId) : await collectFailurePathSupplement();
  process.stdout.write(JSON.stringify(merchantId ? publicMerchantSummary(result) : result) + '\n');
}
