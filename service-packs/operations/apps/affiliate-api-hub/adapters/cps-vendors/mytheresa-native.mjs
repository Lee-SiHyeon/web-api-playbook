import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFragment } from 'parse5';
import { extractPublicPage, isStrongPublicChallenge, safeUrl, textContent } from '../../lib/cps-public-reader.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '../..');
const RESULT_PATH = path.join(APP_ROOT, 'references/cps-reverify/mytheresa-native-supplement.json');
const ROOT_URL = 'https://www.mytheresa.com/';
const ALLOWED_HOSTS = new Set(['mytheresa.com', 'www.mytheresa.com']);
const MAX_BYTES = 6 * 1024 * 1024;
const MAX_FOLLOWUP_PAGES = 2;
const WOMEN_URL = 'https://www.mytheresa.com/kr/ko/women';

function safeMerchantUrl(value, baseUrl) {
  const url = safeUrl(value, baseUrl);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && ALLOWED_HOSTS.has(parsed.hostname) ? url : null;
  } catch { return null; }
}

function saveCheckpoint(report) {
  mkdirSync(path.dirname(RESULT_PATH), { recursive: true });
  const tempPath = `${RESULT_PATH}.tmp-${process.pid}`;
  writeFileSync(tempPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  renameSync(tempPath, RESULT_PATH);
}

function contentCharset(contentType, bytes) {
  const header = /(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType ?? '')?.[1];
  if (header) return header;
  const prefix = bytes.subarray(0, Math.min(bytes.length, 4096)).toString('latin1');
  return /<meta\b[^>]*charset\s*=\s*["']?([^\s"'/>;]+)/i.exec(prefix)?.[1]
    ?? /<meta\b[^>]*content\s*=\s*["'][^"']*charset=([^\s"';]+)/i.exec(prefix)?.[1]
    ?? 'utf-8';
}

async function readResponseBytes(response, maxBytes) {
  if (!response.body) return { bytes: Buffer.alloc(0), complete: true };
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return { bytes: Buffer.concat(chunks), complete: false };
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return { bytes: Buffer.concat(chunks, size), complete: true };
}

function textFromBytes(bytes, contentType) {
  const charset = contentCharset(contentType, bytes);
  try { return new TextDecoder(charset, { fatal: false }).decode(bytes); }
  catch { return new TextDecoder('utf-8', { fatal: false }).decode(bytes); }
}

function pageAnchors(html, baseUrl) {
  return observedDomAnchors(html, baseUrl).filter(row => row.text || row.imageAlt);
}

function observedDomAnchors(html, baseUrl) {
  let root;
  try { root = parseFragment(html ?? ''); } catch { return []; }
  const rows = [];
  const visit = (node, ancestors = []) => {
    if (node?.tagName === 'a') {
      const href = node.attrs?.find(attr => attr.name === 'href')?.value;
      const url = safeMerchantUrl(href, baseUrl);
      const anchorText = textContent(node, 400);
      const ariaLabel = node.attrs?.find(attr => attr.name === 'aria-label')?.value ?? null;
      const anchorTitle = node.attrs?.find(attr => attr.name === 'title')?.value ?? null;
      const image = (() => {
        const find = current => {
          if (current?.tagName === 'img') return current;
          for (const child of current?.childNodes ?? []) { const got = find(child); if (got) return got; }
          return null;
        };
        return find(node);
      })();
      const imageAlt = image?.attrs?.find(attr => attr.name === 'alt')?.value ?? null;
      const labelSource = anchorText ? 'anchor_text' : ariaLabel ? 'aria_label' : anchorTitle ? 'anchor_title' : imageAlt ? 'image_alt' : null;
      const label = anchorText || ariaLabel || anchorTitle || imageAlt || null;
      if (url) {
        const cardNode = [...ancestors].reverse().find(parent => {
          const tag = parent.tagName ?? '';
          const classes = parent.attrs?.find(attr => attr.name === 'class')?.value ?? '';
          return /^(article|li)$/.test(tag) || /(?:^|[\s_-])(?:item|tile|card|result)(?:$|__|[\s_-])/i.test(classes);
        });
        const navNode = [...ancestors].reverse().find(parent => /^(nav|header|footer)$/.test(parent.tagName ?? '')
          || /(?:nav|menu|header|footer)/i.test(parent.attrs?.find(attr => attr.name === 'class')?.value ?? ''));
        const cardText = cardNode ? textContent(cardNode, 1200) : null;
        const classes = [...ancestors].reverse().slice(0, 5).map(parent => ({
          tag: parent.tagName ?? null,
          className: parent.attrs?.find(attr => attr.name === 'class')?.value?.slice(0, 180) ?? null,
        }));
        rows.push({ url, text: label?.trim().slice(0, 400) || null, labelSource,
          cardText: cardText?.trim().slice(0, 1200) || null, imageAlt: imageAlt?.slice(0, 300) ?? null,
          anchorTitle: anchorTitle?.slice(0, 300) ?? null, inNavigation: Boolean(navNode),
          hasCardAncestor: Boolean(cardNode), ancestry: classes });
      }
    }
    const nextAncestors = node?.tagName ? [...ancestors, node] : ancestors;
    for (const child of node?.childNodes ?? []) visit(child, nextAncestors);
  };
  visit(root);
  const byUrl = new Map();
  for (const row of rows) {
    const prior = byUrl.get(row.url);
    if (!prior || (row.hasCardAncestor && !prior.hasCardAncestor) || ((row.text || row.imageAlt) && !(prior.text || prior.imageAlt))) {
      byUrl.set(row.url, row);
    }
  }
  return [...byUrl.values()];
}

function scrubVisibleText(value, max = 1200) {
  if (typeof value !== 'string') return null;
  return value.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/(?:\+?\d[\d ().-]{7,}\d)/g, '[phone]').replace(/\s+/g, ' ').trim().slice(0, max) || null;
}

function classifyAnchor(row) {
  let parsed;
  try { parsed = new URL(row.url); } catch { return null; }
  const words = `${row.text} ${parsed.pathname} ${parsed.search}`.toLowerCase();
  const slugProductId = /-p\d{5,}(?:\/|$)/i.test(parsed.pathname);
  const genericLinkLabel = /^(?:전체 보기|더 보기|자세히 보기|shop now|view all|quick view|wishlist|장바구니)$/i.test((row.text ?? '').trim());
  if ((slugProductId && row.text && !genericLinkLabel)
    || /(?:product|products|item|goods|sku|pdp|detail|\/p\/|article)(?:[^a-z]|$)|(?:product_id|item_id|sku)=/i.test(words)) {
    return { ...row, kind: 'observed_product_detail' };
  }
  const categoryPath = /\/(?:women|men|kids)(?:\/(?:clothing|shoes|bags?|accessories|new-arrivals?|sale|beauty|designers?)(?:\/[^/]+)?)?\/?$/i.test(parsed.pathname)
    && !slugProductId;
  const categoryLabel = /^(?:women|woman|men|man|kids|clothing|shoes|bags?|designer(?:s)?|new arrivals?|sale|beauty|accessories|여성|남성|아동|의류|신발|가방|디자이너|신상품|세일|뷰티|액세서리)$/i
    .test((row.text ?? '').trim());
  if (categoryPath || categoryLabel) {
    return { ...row, kind: 'observed_category' };
  }
  return null;
}

function numberValue(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(?:[€$£¥]\s*)?(\d{1,3}(?:,\d{3})*|\d+)(?:\.\d+)?(?:\s*(?:EUR|USD|GBP|JPY|KRW))?$/i);
  return match ? Number(match[1].replaceAll(',', '') + (value.match(/\.\d+/)?.[0] ?? '')) : null;
}

function normalizeSchemaProduct(row, page, receiptId, locator) {
  const types = (Array.isArray(row?.['@type']) ? row['@type'] : [row?.['@type']]).filter(Boolean)
    .map(item => String(item).split(/[\/#]/).at(-1).toLowerCase());
  if (!types.some(type => ['product', 'productgroup', 'productcollection'].includes(type))) return null;
  const title = typeof row.name === 'string' && row.name.trim().length > 2 ? row.name.trim().slice(0, 600) : null;
  if (!title) return null;
  const sourceLocalId = row.sku ?? row.mpn ?? row.gtin ?? row.productID
    ?? (typeof row.identifier === 'string' ? row.identifier : row.identifier?.value) ?? null;
  const offers = (Array.isArray(row.offers) ? row.offers : row.offers ? [row.offers] : [])
    .filter(item => item && typeof item === 'object').slice(0, 20).map(offer => {
      const amount = numberValue(offer.price ?? offer.priceSpecification?.price);
      const lowPrice = numberValue(offer.lowPrice);
      const highPrice = numberValue(offer.highPrice);
      const rawCurrency = offer.priceCurrency ?? offer.priceSpecification?.priceCurrency;
      const currency = typeof rawCurrency === 'string' && /^[A-Za-z]{3}$/.test(rawCurrency) ? rawCurrency.toUpperCase() : null;
      return { amount, currency, priceText: offer.price == null ? null : String(offer.price), lowPrice, highPrice,
        type: 'Offer', availability: 'unknown', seller: null, validFrom: null, validUntil: null, condition: null,
        url: safeMerchantUrl(offer.url, page.url) };
    });
  const firstOffer = offers.find(item => item.amount != null || item.priceText != null);
  const rawPrice = row.price;
  const rawCurrency = row.priceCurrency;
  const price = { amount: numberValue(rawPrice) ?? firstOffer?.amount ?? null,
    currency: typeof rawCurrency === 'string' && /^[A-Za-z]{3}$/.test(rawCurrency) ? rawCurrency.toUpperCase() : firstOffer?.currency ?? null,
    priceText: rawPrice == null ? firstOffer?.priceText ?? null : String(rawPrice) };
  const aggregate = row.aggregateRating && typeof row.aggregateRating === 'object' ? row.aggregateRating : {};
  const rating = { value: numberValue(aggregate.ratingValue), best: numberValue(aggregate.bestRating), worst: numberValue(aggregate.worstRating),
    reviewCount: Number.isSafeInteger(Number(aggregate.reviewCount)) && aggregate.reviewCount != null ? Number(aggregate.reviewCount) : null,
    ratingCount: Number.isSafeInteger(Number(aggregate.ratingCount)) && aggregate.ratingCount != null ? Number(aggregate.ratingCount) : null };
  const description = typeof row.description === 'string' ? row.description.slice(0, 3000) : null;
  const brand = typeof row.brand === 'string' ? row.brand : row.brand?.name ?? null;
  const fields = ['type', 'title', 'url'];
  if (sourceLocalId != null) fields.push('sourceLocalId');
  if (description) fields.push('description');
  if (brand) fields.push('brand');
  if (price.amount != null || price.priceText != null) fields.push('price');
  if (offers.length) fields.push('offers');
  if (rating.value != null || rating.reviewCount != null || rating.ratingCount != null) fields.push('rating');
  return { type: 'RetailProduct', sourceSchemaType: types.join('|'), sourceLocalId: sourceLocalId == null ? null : String(sourceLocalId),
    title, url: safeUrl(page.url), description, brand, price, offers, rating, variants: [], reviewSamples: [],
    evidence: [{ receiptId, locator, fields }] };
}

function observedEmbeddedProducts(extraction, page, receiptId) {
  const output = [];
  let visited = 0;
  const visit = (value, blockId, pathLabel, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 14 || visited >= 25_000 || output.length >= 40) return;
    visited += 1;
    if (Array.isArray(value)) {
      value.slice(0, 1000).forEach((item, index) => visit(item, blockId, `${pathLabel}[${index}]`, depth + 1));
      return;
    }
    const title = [value.productName, value.productTitle, value.name, value.title]
      .find(item => typeof item === 'string' && item.trim().length > 2) ?? null;
    const localId = [value.sku, value.productId, value.product_id, value.articleNumber, value.articleCode, value.productCode]
      .find(item => (typeof item === 'string' && item.trim()) || (typeof item === 'number' && Number.isFinite(item))) ?? null;
    const pathText = `${pathLabel} ${Object.keys(value).join(' ')}`;
    const productSignal = /(?:product|catalog|item|sku|article)/i.test(pathText);
    if (title && localId != null && productSignal) {
      const priceRaw = value.salePrice ?? value.currentPrice ?? value.price ?? value.amount ?? value.offer?.price ?? null;
      const amount = numberValue(priceRaw);
      const currencyRaw = value.currency ?? value.priceCurrency ?? value.offer?.priceCurrency ?? null;
      const currency = typeof currencyRaw === 'string' && /^[A-Za-z]{3}$/.test(currencyRaw) ? currencyRaw.toUpperCase() : null;
      const price = { amount, currency, priceText: priceRaw == null ? null : String(priceRaw) };
      const description = typeof value.description === 'string' ? value.description.slice(0, 3000) : null;
      const brand = typeof value.brand === 'string' ? value.brand : value.brand?.name ?? null;
      const recordUrl = safeMerchantUrl(value.url ?? value.productUrl ?? value.href, page.url) ?? safeUrl(page.url);
      const fields = ['type', 'title', 'url', 'sourceLocalId'];
      if (description) fields.push('description');
      if (brand) fields.push('brand');
      if (amount != null || price.priceText != null) fields.push('price');
      output.push({ type: 'RetailProduct', sourceLocalId: String(localId), title: title.trim().slice(0, 600),
        url: recordUrl, description, brand, price,
        rating: { value: null, best: null, worst: null, reviewCount: null, ratingCount: null },
        variants: [], reviewSamples: [], evidence: [{ receiptId, locator: `embedded JSON ${blockId}:${pathLabel}`, fields }] });
    }
    for (const [key, child] of Object.entries(value).slice(0, 300)) visit(child, blockId, `${pathLabel}.${String(key).slice(0, 80)}`, depth + 1);
  };
  for (const block of extraction.embeddedJson ?? []) visit(block.value, block.id, '$');
  return output;
}

function uniqueRecords(records) {
  const deduped = new Map();
  for (const row of records) {
    if (!row?.title || !row?.url || !row.evidence?.length) continue;
    // Mytheresa's same product can surface once as text and once as image-alt copy.
    // The exact observed PDP URL is the stable identity; keep one record and merge evidence.
    const key = row.url;
    const prior = deduped.get(key);
    if (prior) {
      prior.evidence = [...new Map([...prior.evidence, ...row.evidence].map(item => [`${item.receiptId}|${item.locator}`, item])).values()];
    } else deduped.set(key, row);
  }
  return [...deduped.values()];
}

async function responseBytes(response) {
  return readResponseBytes(response, MAX_BYTES);
}

export async function collectMytheresaNative() {
  const report = {
    schemaVersion: 1,
    merchantId: 'mytheresa',
    merchantName: '마이테레사',
    siteUrl: ROOT_URL,
    checkedAt: new Date().toISOString(),
    transport: { browserUsed: false, cookiesSent: false, authorizationSent: false, customHeaders: false, fetchMode: 'native_default' },
    priorEvidence: { source: 'mytheresa-public-supplement.json', receipts: [], contracts: [], frontier: [] },
    receipts: [], records: [], contracts: [], frontier: [], operations: {}, blocked: false, status: 'pending',
    discoveryBounds: { rootUrl: ROOT_URL, maxObservedFollowupPages: MAX_FOLLOWUP_PAGES, scriptsExecuted: false, bodyPersisted: false },
  };
  try {
    const old = JSON.parse((await import('node:fs')).readFileSync(path.join(APP_ROOT, 'references/cps-reverify/mytheresa-public-supplement.json'), 'utf8'));
    report.priorEvidence = { source: 'mytheresa-public-supplement.json', receipts: old.receipts ?? [], contracts: old.contracts ?? [], frontier: old.frontier ?? [] };
  } catch { /* Prior context remains empty if no earlier supplement exists. */ }

  const queue = [{ url: ROOT_URL, kind: 'anonymous_root_native_fetch', discoveredFromReceiptId: null }];
  const visited = new Set();
  let followups = 0;
  let hardStop = false;
  while (queue.length && !hardStop) {
    const current = queue.shift();
    if (!current?.url || visited.has(current.url)) continue;
    visited.add(current.url);
    const startedAt = new Date().toISOString();
    let response;
    let body = Buffer.alloc(0);
    let completeBody = false;
    let fetchFailure = null;
    try {
      // Intentionally use Node's default fetch request: no headers, cookies, credentials, or browser context.
      response = await fetch(current.url);
      const fetched = await responseBytes(response);
      body = fetched.bytes;
      completeBody = fetched.complete;
    } catch (error) { fetchFailure = error?.name === 'AbortError' ? 'FETCH_ABORTED' : 'NATIVE_FETCH_FAILED'; }

    const contentType = response?.headers?.get('content-type') ?? null;
    const finalUrl = safeUrl(response?.url ?? current.url);
    const receipt = {
      id: randomUUID(), requestMethod: 'GET', requestUrl: safeUrl(current.url), finalUrl,
      responseStatus: Number.isInteger(response?.status) ? response.status : null,
      contentType, bytes: body.length, responseSha256: completeBody ? createHash('sha256').update(body).digest('hex') : null,
      observedAt: startedAt, browserUsed: false, cookiesSent: false, authorizationSent: false,
      customHeaders: false, secureTransport: true, nativeFetchDefault: true,
      ...(response?.redirected ? { redirected: true } : {}),
      ...(!completeBody ? { bodyTruncated: true } : {}),
      ...(fetchFailure ? { stopReason: fetchFailure } : {}),
    };
    report.receipts.push(receipt);
    const frontier = { operation: current.kind, url: safeUrl(current.url), state: fetchFailure ? fetchFailure : 'receipt_checkpointed',
      retry: false, ...(current.discoveredFromReceiptId ? { discoveredFromReceiptId: current.discoveredFromReceiptId } : {}),
      evidenceReceiptId: receipt.id };
    report.frontier.push(frontier);
    report.contracts.push({ operation: current.kind, method: 'GET', requestUrl: receipt.requestUrl, finalUrl: receipt.finalUrl,
      status: receipt.responseStatus, contentType, observedAt: startedAt, browserUsed: false, cookiesSent: false,
      authorizationSent: false, customHeaders: false, nativeFetchDefault: true, redirected: Boolean(response?.redirected),
      bodyPersisted: false, evidenceReceiptId: receipt.id, ...(fetchFailure ? { stopReason: fetchFailure } : {}) });

    report.checkedAt = new Date().toISOString();
    report.status = 'receipt_checkpointed';
    saveCheckpoint(report);
    if (fetchFailure) { report.status = 'attempt_without_response'; report.frontier.at(-1).state = fetchFailure; saveCheckpoint(report); break; }
    if (!completeBody) {
      report.status = 'response_too_large_stopped'; report.frontier.at(-1).state = 'response_too_large'; saveCheckpoint(report); break;
    }
    if ([401, 403, 418, 429].includes(Number(response.status))) {
      report.blocked = true; report.status = 'blocked_stopped'; report.frontier.at(-1).state = `HTTP_${response.status}`;
      report.frontier.at(-1).stopHost = true; report.contracts.at(-1).stopReason = 'HTTP_ACCESS_BLOCKED';
      saveCheckpoint(report); break;
    }
    if (response.status !== 200) {
      report.status = `http_${response.status}_stopped`; report.frontier.at(-1).state = `HTTP_${response.status}`; saveCheckpoint(report); break;
    }
    if (!finalUrl || !safeMerchantUrl(finalUrl) || !/^text\/html(?:;|$)/i.test(contentType ?? '')) {
      report.status = 'final_url_or_html_mime_outside_expected_scope'; report.frontier.at(-1).state = report.status; saveCheckpoint(report); break;
    }

    const html = textFromBytes(body, contentType);
    body = Buffer.alloc(0);
    const responseHeaders = Object.fromEntries(response.headers.entries());
    if (isStrongPublicChallenge(responseHeaders, html)) {
      report.blocked = true; report.status = 'visible_challenge_stopped'; report.frontier.at(-1).state = 'VISIBLE_CHALLENGE';
      report.frontier.at(-1).stopHost = true; report.contracts.at(-1).stopReason = 'VISIBLE_CHALLENGE'; saveCheckpoint(report); break;
    }
    const page = { ok: true, url: finalUrl, status: response.status, contentType, html, receipt: { ...receipt } };
    const extraction = extractPublicPage(page, { merchantId: 'mytheresa', typeHint: 'fashion' });
    const anchors = pageAnchors(html, finalUrl);
    const classified = anchors.map(classifyAnchor).filter(Boolean);
    const categories = classified.filter(item => item.kind === 'observed_category');
    const products = classified.filter(item => item.kind === 'observed_product_detail');
    const records = extraction.records.map(record => ({ ...record, url: safeUrl(record.url) ?? safeUrl(finalUrl),
      reviewSamples: (record.reviewSamples ?? []).map(review => ({ title: review.title ?? null, rating: review.rating ?? null,
        publishedAt: review.publishedAt ?? null, reviewer: null, body: null })) }));
    const productPage = current.kind === 'observed_product_detail';
    if (productPage) {
      for (const [index, row] of (extraction.jsonLd ?? []).entries()) {
        const candidate = normalizeSchemaProduct(row, page, receipt.id, `observed detail JSON-LD row ${index + 1}`);
        if (candidate) records.push(candidate);
      }
    }
    const embedded = observedEmbeddedProducts(extraction, page, receipt.id);
    records.push(...embedded);
    const savedRecords = uniqueRecords(records);
    report.records = uniqueRecords([...report.records, ...savedRecords]);
    report.contracts.at(-1).title = extraction.title;
    report.contracts.at(-1).description = extraction.description;
    report.contracts.at(-1).jsonLdBlocks = extraction.jsonLd.length;
    report.contracts.at(-1).embeddedJsonBlocks = extraction.embeddedJson.length;
    report.contracts.at(-1).observedAnchorCount = anchors.length;
    report.contracts.at(-1).observedCategoryLinkCount = categories.length;
    report.contracts.at(-1).observedProductLinkCount = products.length;
    report.contracts.at(-1).offeringRecordCount = savedRecords.length;
    report.contracts.at(-1).embeddedProductCandidateCount = embedded.length;
    report.frontier.at(-1).state = 'read';
    report.frontier.at(-1).observedCounts = { jsonLdBlocks: extraction.jsonLd.length, embeddedJsonBlocks: extraction.embeddedJson.length,
      observedAnchors: anchors.length, categoryLinks: categories.length, productLinks: products.length,
      offeringRecords: savedRecords.length, embeddedProductCandidates: embedded.length };

    const sameHost = (() => { try { return ALLOWED_HOSTS.has(new URL(finalUrl).hostname); } catch { return false; } })();
    if (!sameHost) {
      report.status = 'redirected_outside_provider_scope_stopped';
      report.frontier.at(-1).state = report.status; saveCheckpoint(report); break;
    }
    if (current.kind === 'anonymous_root_native_fetch' && classified.length === 0 && extraction.jsonLd.length === 0 && extraction.embeddedJson.length === 0) {
      report.frontier.at(-1).state = 'same_shell_no_observed_catalog_links_or_embedded_state';
    }
    if (followups < MAX_FOLLOWUP_PAGES) {
      const choices = [...products, ...categories];
      for (const item of choices) {
        if (followups >= MAX_FOLLOWUP_PAGES) break;
        if (visited.has(item.url) || queue.some(row => row.url === item.url)) continue;
        queue.push({ url: item.url, kind: item.kind, discoveredFromReceiptId: receipt.id });
        report.frontier.push({ operation: item.kind, url: safeUrl(item.url), label: item.text,
          state: 'observed_link_pending_budget', retry: false, discoveredFromReceiptId: receipt.id });
        followups += 1;
      }
    }
    saveCheckpoint(report);
  }

  for (const pending of queue) if (!visited.has(pending.url)) {
    const existing = report.frontier.find(item => item.url === safeUrl(pending.url) && item.state === 'observed_link_pending_budget');
    if (existing) existing.state = 'pending_followup_budget';
  }
  report.checkedAt = new Date().toISOString();
  const recordReceiptIds = [...new Set(report.records.flatMap(record => (record.evidence ?? []).map(item => item.receiptId).filter(Boolean)))];
  report.operations = {
    publicPageRead: { state: report.receipts.some(item => item.responseStatus === 200) ? 'live_replay' : 'attempt_without_response',
      evidenceReceiptIds: report.receipts.map(item => item.id) },
    publicCatalogNavigation: { state: report.contracts.some(item => (item.observedCategoryLinkCount ?? 0) + (item.observedProductLinkCount ?? 0) > 0)
      ? 'observed_links' : 'no_observed_product_or_category_links',
      categoryLinkCount: report.contracts.reduce((sum, item) => sum + (item.observedCategoryLinkCount ?? 0), 0),
      productLinkCount: report.contracts.reduce((sum, item) => sum + (item.observedProductLinkCount ?? 0), 0),
      evidenceReceiptIds: report.contracts.map(item => item.evidenceReceiptId).filter(Boolean) },
    productOrServiceRecord: { state: report.records.length ? 'live_replay' : 'not_observed', recordCount: report.records.length, evidenceReceiptIds: recordReceiptIds },
    price: { state: report.records.some(row => row.price?.amount != null || row.price?.priceText != null) ? 'live_replay' : 'not_observed',
      recordCount: report.records.filter(row => row.price?.amount != null || row.price?.priceText != null).length,
      evidenceReceiptIds: [...new Set(report.records.filter(row => row.price?.amount != null || row.price?.priceText != null)
        .flatMap(row => row.evidence.map(item => item.receiptId).filter(Boolean)))] },
    ratingSummary: { state: report.records.some(row => row.rating?.value != null || row.rating?.reviewCount != null || row.rating?.ratingCount != null) ? 'live_replay' : 'not_observed',
      recordCount: report.records.filter(row => row.rating?.value != null || row.rating?.reviewCount != null || row.rating?.ratingCount != null).length },
    reviewsList: { state: report.records.some(row => row.reviewSamples?.length) ? 'partial_samples' : 'not_observed',
      sampleCount: report.records.reduce((sum, row) => sum + (row.reviewSamples?.length ?? 0), 0), complete: false },
    productOptions: { state: report.records.some(row => row.variants?.length) ? 'variants_observed' : 'not_observed',
      variantCount: report.records.reduce((sum, row) => sum + (row.variants?.length ?? 0), 0) },
  };
  if (!report.blocked && ['pending', 'receipt_checkpointed', 'attempt_without_response'].includes(report.status)) {
    report.status = report.records.length ? 'ontology_records_observed' : report.contracts.some(item => item.status === 200) ? 'reachable_without_offering_record' : 'attempt_without_response';
  }
  saveCheckpoint(report);
  process.stdout.write(`${JSON.stringify({ status: report.status, receipts: report.receipts.length, records: report.records.length,
    categoriesObserved: report.operations.publicCatalogNavigation.categoryLinkCount,
    productsObserved: report.operations.publicCatalogNavigation.productLinkCount, blocked: report.blocked })}\n`);
  return report;
}

/**
 * Continue catalog discovery from the already-observed women URL without
 * replaying the homepage. The women page is reread only to inspect its live
 * DOM after the prior in-memory HTML was correctly discarded.
 */
export async function collectMytheresaNativeCatalog() {
  const report = JSON.parse(readFileSync(RESULT_PATH, 'utf8'));
  const initialReceiptCount = report.receipts?.length ?? 0;
  if (report.blocked) return report;
  const visited = new Set((report.receipts ?? []).map(item => item.requestUrl).filter(Boolean));
  const hardBlocked = new Set(['401', '403', '418', '429']);

  const readObserved = async (url, operation, discoveredFromReceiptId) => {
    if (!safeMerchantUrl(url) || hardBlocked.has(String(report.receipts.find(item => item.requestUrl === url)?.responseStatus))) return null;
    const startedAt = new Date().toISOString();
    let response = null;
    let bytes = Buffer.alloc(0);
    let complete = false;
    let failure = null;
    try {
      // Use the native default request. Do not send cookies, authorization, or any custom headers.
      response = await fetch(url);
      const streamed = await responseBytes(response);
      bytes = streamed.bytes;
      complete = streamed.complete;
    } catch (error) { failure = error?.name === 'AbortError' ? 'FETCH_ABORTED' : 'NATIVE_FETCH_FAILED'; }
    const contentType = response?.headers?.get('content-type') ?? null;
    const finalUrl = safeUrl(response?.url ?? url);
    const receipt = { id: randomUUID(), requestMethod: 'GET', requestUrl: safeUrl(url), finalUrl,
      responseStatus: Number.isInteger(response?.status) ? response.status : null, contentType, bytes: bytes.length,
      responseSha256: complete ? createHash('sha256').update(bytes).digest('hex') : null, observedAt: startedAt,
      browserUsed: false, cookiesSent: false, authorizationSent: false, customHeaders: false,
      secureTransport: true, nativeFetchDefault: true, ...(response?.redirected ? { redirected: true } : {}),
      ...(!complete ? { bodyTruncated: true } : {}), ...(failure ? { stopReason: failure } : {}) };
    report.receipts.push(receipt);
    const contract = { operation, method: 'GET', requestUrl: receipt.requestUrl, finalUrl, status: receipt.responseStatus,
      contentType, observedAt: startedAt, browserUsed: false, cookiesSent: false, authorizationSent: false,
      customHeaders: false, nativeFetchDefault: true, redirected: Boolean(response?.redirected), bodyPersisted: false,
      evidenceReceiptId: receipt.id, ...(failure ? { stopReason: failure } : {}) };
    report.contracts.push(contract);
    const frontier = { operation, url: receipt.requestUrl, state: failure ?? 'receipt_checkpointed', retry: false,
      discoveredFromReceiptId, evidenceReceiptId: receipt.id };
    report.frontier.push(frontier);
    report.checkedAt = new Date().toISOString();
    report.status = 'receipt_checkpointed';
    saveCheckpoint(report); // Checkpoint the safe receipt before parsing the response body.
    if (failure) { report.status = 'attempt_without_response'; frontier.state = failure; saveCheckpoint(report); return null; }
    if (!complete) { report.status = 'response_too_large_stopped'; frontier.state = 'response_too_large'; saveCheckpoint(report); return null; }
    if ([401, 403, 418, 429].includes(Number(response.status))) {
      report.blocked = true; report.status = 'blocked_stopped'; frontier.state = `HTTP_${response.status}`; frontier.stopHost = true;
      contract.stopReason = 'HTTP_ACCESS_BLOCKED'; saveCheckpoint(report); return null;
    }
    if (response.status !== 200) {
      report.status = `http_${response.status}_stopped`; frontier.state = `HTTP_${response.status}`; saveCheckpoint(report); return null;
    }
    if (!finalUrl || !safeMerchantUrl(finalUrl) || !/^text\/html(?:;|$)/i.test(contentType ?? '')) {
      report.status = 'final_url_or_html_mime_outside_expected_scope'; frontier.state = report.status; saveCheckpoint(report); return null;
    }
    const html = textFromBytes(bytes, contentType);
    bytes = Buffer.alloc(0);
    if (isStrongPublicChallenge(Object.fromEntries(response.headers.entries()), html)) {
      report.blocked = true; report.status = 'visible_challenge_stopped'; frontier.state = 'VISIBLE_CHALLENGE'; frontier.stopHost = true;
      contract.stopReason = 'VISIBLE_CHALLENGE'; saveCheckpoint(report); return null;
    }
    const page = { ok: true, url: finalUrl, status: response.status, contentType, html, receipt: { ...receipt } };
    const extraction = extractPublicPage(page, { merchantId: 'mytheresa', typeHint: 'fashion' });
    const anchors = observedDomAnchors(html, finalUrl);
    const products = anchors.filter(item => item.hasCardAncestor && !item.inNavigation
      && item.url !== safeMerchantUrl(finalUrl) && (item.text || item.imageAlt));
    const productJsonLd = (extraction.jsonLd ?? []).filter(row => {
      const rawTypes = Array.isArray(row?.['@type']) ? row['@type'] : [row?.['@type']];
      return rawTypes.some(type => /(?:^|[/#])product(?:group|collection)?$/i.test(String(type)));
    }).slice(0, 50).map(row => ({ name: scrubVisibleText(row.name, 500), url: safeMerchantUrl(row.url, finalUrl),
      sku: typeof row.sku === 'string' || typeof row.sku === 'number' ? String(row.sku).slice(0, 100) : null }));
    contract.title = extraction.title;
    contract.description = extraction.description;
    contract.jsonLdBlocks = extraction.jsonLd.length;
    contract.embeddedJsonBlocks = extraction.embeddedJson.length;
    contract.observedAnchorCount = anchors.length;
    contract.domProductCardCount = products.length;
    contract.productJsonLdCount = productJsonLd.length;
    contract.observedProductCards = products.slice(0, 30).map(item => ({ url: item.url, title: scrubVisibleText(item.text || item.imageAlt, 500),
      imageAlt: scrubVisibleText(item.imageAlt, 300), cardText: scrubVisibleText(item.cardText, 1200),
      ancestry: item.ancestry, receiptId: receipt.id }));
    contract.productJsonLdCandidates = productJsonLd;
    frontier.state = 'read';
    frontier.observedCounts = { jsonLdBlocks: extraction.jsonLd.length, embeddedJsonBlocks: extraction.embeddedJson.length,
      observedAnchors: anchors.length, productCardLinks: products.length, productJsonLdCandidates: productJsonLd.length };
    saveCheckpoint(report);
    return { page, extraction, anchors, products, receipt, contract, frontier };
  };

  // Re-read only the prior exact observed URL to recover current DOM link/card evidence.
  const women = await readObserved(WOMEN_URL, 'observed_women_page_dom_refresh', report.receipts.find(item => item.requestUrl === ROOT_URL)?.id ?? null);
  if (!women || report.blocked) return report;
  visited.add(WOMEN_URL);

  const categoryPattern = /(?:new[-_/ ]?arrivals?|new[-_/ ]?in|clothing|bags?|shoes?|accessories|신상품|의류|가방|신발|액세서리)/i;
  const categoryCandidates = women.anchors.filter(item => item.url !== WOMEN_URL && item.inNavigation)
    .filter(item => categoryPattern.test(`${item.text ?? ''} ${new URL(item.url).pathname}`))
    .sort((a, b) => {
      const score = item => /(?:new[-_/ ]?arrivals?|new[-_/ ]?in|신상품)/i.test(`${item.text ?? ''} ${new URL(item.url).pathname}`) ? 0
        : /(?:clothing|bags?|shoes?|신발|가방|의류)/i.test(`${item.text ?? ''} ${new URL(item.url).pathname}`) ? 1 : 2;
      return score(a) - score(b);
    });
  // One directly observed category branch, chosen from live labels/path only.
  const category = categoryCandidates.find(item => !visited.has(item.url));
  let categoryPage = null;
  if (category) {
    report.frontier.push({ operation: 'observed_category', url: category.url, label: scrubVisibleText(category.text, 200),
      state: 'observed_link_pending_budget', retry: false, discoveredFromReceiptId: women.receipt.id });
    saveCheckpoint(report);
    categoryPage = await readObserved(category.url, 'observed_catalog_category_page', women.receipt.id);
  }
  if (!categoryPage || report.blocked) {
    report.discoveryBounds = { ...(report.discoveryBounds ?? {}), categoryPageBoundedFollowup: true,
      samePageRefreshReceiptId: women.receipt.id, selectedCategoryUrl: category?.url ?? null,
      selectedCategoryLabel: scrubVisibleText(category?.text, 200), productDetailRead: false };
    if (!report.blocked && !report.records.length) report.status = 'reachable_without_offering_record';
    report.checkedAt = new Date().toISOString(); saveCheckpoint(report); return report;
  }

  const categoryRecords = [];
  for (const [index, item] of categoryPage.products.entries()) {
    const title = scrubVisibleText(item.text || item.imageAlt, 500);
    if (!title || title.length < 3 || /^(?:더 보기|자세히 보기|shop now|view all|quick view|wishlist|장바구니)$/i.test(title)) continue;
    const fields = ['type', 'title', 'url'];
    categoryRecords.push({ type: 'RetailProduct', sourceLocalId: null, title, url: safeUrl(item.url), description: null, brand: null,
      price: { amount: null, currency: null, priceText: null },
      rating: { value: null, best: null, worst: null, reviewCount: null, ratingCount: null }, variants: [], reviewSamples: [],
      evidence: [{ receiptId: categoryPage.receipt.id, locator: `observed product-card anchor ${index + 1}; DOM ancestry ${item.ancestry.map(row => `${row.tag}.${row.className ?? ''}`).join(' > ')}`,
        fields }] });
  }
  report.records = uniqueRecords([...(report.records ?? []), ...categoryRecords]);

  const detailCandidates = categoryPage.products
    .filter(item => item.url !== categoryPage.page.url && (item.text || item.imageAlt))
    .sort((a, b) => Number(Boolean(b.cardText)) - Number(Boolean(a.cardText))
      || Number(Boolean(b.imageAlt)) - Number(Boolean(a.imageAlt)));
  const productJsonLd = categoryPage.contract.productJsonLdCandidates ?? [];
  const observedDetail = detailCandidates[0]?.url ?? productJsonLd.find(item => item.url)?.url ?? null;
  let detail = null;
  if (observedDetail && !visited.has(observedDetail)) {
    const fromCategory = categoryPage.receipt.id;
    report.frontier.push({ operation: 'observed_product_detail', url: safeUrl(observedDetail),
      label: scrubVisibleText(detailCandidates[0]?.text || detailCandidates[0]?.imageAlt || productJsonLd.find(item => item.url)?.name, 200),
      state: 'observed_link_pending_budget', retry: false, discoveredFromReceiptId: fromCategory });
    saveCheckpoint(report);
    detail = await readObserved(observedDetail, 'observed_product_detail', fromCategory);
  }
  if (detail && !report.blocked) {
    const detailRecords = [];
    for (const [index, row] of (detail.extraction.jsonLd ?? []).entries()) {
      const record = normalizeSchemaProduct(row, detail.page, detail.receipt.id, `observed product detail JSON-LD row ${index + 1}`);
      if (record) detailRecords.push(record);
    }
    detailRecords.push(...observedEmbeddedProducts(detail.extraction, detail.page, detail.receipt.id));
    // Preserve a named category-card item when the detail page does not publish structured data.
    if (!detailRecords.length) {
      const matchingCard = categoryRecords.find(row => row.url === safeUrl(observedDetail));
      const heading = scrubVisibleText(detail.extraction.title, 600);
      if (matchingCard && heading && !/mytheresa|마이테레사/i.test(heading)) {
        matchingCard.evidence.push({ receiptId: detail.receipt.id, locator: 'observed product detail document title', fields: ['title', 'url'] });
      }
    }
    report.records = uniqueRecords([...(report.records ?? []), ...detailRecords]);
  }
  report.discoveryBounds = { ...(report.discoveryBounds ?? {}), categoryPageBoundedFollowup: true,
    samePageRefreshReceiptId: women.receipt.id, selectedCategoryUrl: category.url,
    selectedCategoryLabel: scrubVisibleText(category.text, 200), productDetailRead: Boolean(detail),
    productDetailUrl: detail ? safeUrl(detail.page.url) : null, maxNewCategoryPages: 1, maxNewProductDetailPages: 1 };
  const recordReceiptIds = [...new Set(report.records.flatMap(record => (record.evidence ?? []).map(item => item.receiptId).filter(Boolean)))];
  report.operations = { ...(report.operations ?? {}), publicPageRead: { state: report.receipts.some(item => item.responseStatus === 200) ? 'live_replay' : 'attempt_without_response',
      evidenceReceiptIds: report.receipts.map(item => item.id) },
    productOrServiceRecord: { state: report.records.length ? 'live_replay' : 'not_observed', recordCount: report.records.length, evidenceReceiptIds: recordReceiptIds },
    price: { state: report.records.some(row => row.price?.amount != null || row.price?.priceText != null) ? 'live_replay' : 'not_observed',
      recordCount: report.records.filter(row => row.price?.amount != null || row.price?.priceText != null).length,
      evidenceReceiptIds: [...new Set(report.records.filter(row => row.price?.amount != null || row.price?.priceText != null)
        .flatMap(row => row.evidence.map(item => item.receiptId).filter(Boolean)))] },
  };
  report.status = report.blocked ? 'blocked_stopped' : report.records.length ? 'ontology_records_observed' : 'reachable_without_offering_record';
  report.checkedAt = new Date().toISOString();
  saveCheckpoint(report);
  process.stdout.write(`${JSON.stringify({ status: report.status, newReceipts: report.receipts.length - initialReceiptCount, totalReceipts: report.receipts.length,
    records: report.records.length, selectedCategory: category?.url ?? null, productDetail: detail ? detail.page.url : null, blocked: report.blocked })}\n`);
  return report;
}

/** Fetch one PDP already present in a saved first-party product card observation. */
export async function collectMytheresaNativeObservedCardPdp() {
  const report = JSON.parse(readFileSync(RESULT_PATH, 'utf8'));
  if (report.blocked) return report;
  const womenContract = report.contracts?.find(item => item.operation === 'observed_women_page_dom_refresh'
    && item.evidenceReceiptId && Array.isArray(item.observedProductCards));
  if (!womenContract) throw new Error('MYTHERESA_NO_SAVED_OBSERVED_PRODUCT_CARD');
  const generic = /^(?:전체 보기|더 보기|자세히 보기|shop now|view all|quick view|wishlist|장바구니)$/i;
  const card = womenContract.observedProductCards.find(item => item.url && item.title && !generic.test(item.title)
    && item.ancestry?.some(parent => /(?:^|[\s_-])item(?:$|__|[-_])/i.test(parent.className ?? ''))
    && safeMerchantUrl(item.url) && item.url !== report.discoveryBounds?.selectedCategoryUrl);
  if (!card) throw new Error('MYTHERESA_NO_NAMED_OBSERVED_PRODUCT_CARD');
  const detailUrl = safeMerchantUrl(card.url);
  if (report.receipts.some(item => item.requestUrl === detailUrl && [401, 403, 418, 429].includes(item.responseStatus))) return report;
  if (report.receipts.some(item => item.requestUrl === detailUrl && item.responseStatus === 200)) return report;

  const startedAt = new Date().toISOString();
  let response = null;
  let bytes = Buffer.alloc(0);
  let complete = false;
  let failure = null;
  try {
    // Native default fetch: no custom headers, cookies, authorization, or browser context.
    response = await fetch(detailUrl);
    const streamed = await responseBytes(response);
    bytes = streamed.bytes;
    complete = streamed.complete;
  } catch (error) { failure = error?.name === 'AbortError' ? 'FETCH_ABORTED' : 'NATIVE_FETCH_FAILED'; }
  const contentType = response?.headers?.get('content-type') ?? null;
  const finalUrl = safeUrl(response?.url ?? detailUrl);
  const receipt = { id: randomUUID(), requestMethod: 'GET', requestUrl: detailUrl, finalUrl,
    responseStatus: Number.isInteger(response?.status) ? response.status : null, contentType, bytes: bytes.length,
    responseSha256: complete ? createHash('sha256').update(bytes).digest('hex') : null, observedAt: startedAt,
    browserUsed: false, cookiesSent: false, authorizationSent: false, customHeaders: false,
    secureTransport: true, nativeFetchDefault: true, ...(response?.redirected ? { redirected: true } : {}),
    ...(!complete ? { bodyTruncated: true } : {}), ...(failure ? { stopReason: failure } : {}) };
  report.receipts.push(receipt);
  const contract = { operation: 'observed_product_detail_from_public_card', method: 'GET', requestUrl: detailUrl,
    finalUrl, status: receipt.responseStatus, contentType, observedAt: startedAt, browserUsed: false, cookiesSent: false,
    authorizationSent: false, customHeaders: false, nativeFetchDefault: true, redirected: Boolean(response?.redirected),
    bodyPersisted: false, evidenceReceiptId: receipt.id, discoveredFromReceiptId: womenContract.evidenceReceiptId,
    cardTitle: scrubVisibleText(card.title, 500), ...(failure ? { stopReason: failure } : {}) };
  report.contracts.push(contract);
  const frontier = { operation: 'observed_product_detail_from_public_card', url: detailUrl,
    label: scrubVisibleText(card.title, 200), state: failure ?? 'receipt_checkpointed', retry: false,
    discoveredFromReceiptId: womenContract.evidenceReceiptId, evidenceReceiptId: receipt.id };
  report.frontier.push(frontier);
  report.checkedAt = new Date().toISOString();
  report.status = 'receipt_checkpointed';
  saveCheckpoint(report); // Safe receipt first; response body is never persisted.

  if (failure) { report.status = 'attempt_without_response'; frontier.state = failure; saveCheckpoint(report); return report; }
  if (!complete) { report.status = 'response_too_large_stopped'; frontier.state = 'response_too_large'; saveCheckpoint(report); return report; }
  if ([401, 403, 418, 429].includes(Number(response.status))) {
    report.blocked = true; report.status = 'blocked_stopped'; frontier.state = `HTTP_${response.status}`; frontier.stopHost = true;
    contract.stopReason = 'HTTP_ACCESS_BLOCKED'; saveCheckpoint(report); return report;
  }
  if (response.status !== 200) {
    report.status = `http_${response.status}_stopped`; frontier.state = `HTTP_${response.status}`; saveCheckpoint(report); return report;
  }
  if (!finalUrl || !safeMerchantUrl(finalUrl) || !/^text\/html(?:;|$)/i.test(contentType ?? '')) {
    report.status = 'final_url_or_html_mime_outside_expected_scope'; frontier.state = report.status; saveCheckpoint(report); return report;
  }
  const html = textFromBytes(bytes, contentType);
  bytes = Buffer.alloc(0);
  if (isStrongPublicChallenge(Object.fromEntries(response.headers.entries()), html)) {
    report.blocked = true; report.status = 'visible_challenge_stopped'; frontier.state = 'VISIBLE_CHALLENGE'; frontier.stopHost = true;
    contract.stopReason = 'VISIBLE_CHALLENGE'; saveCheckpoint(report); return report;
  }
  const page = { ok: true, url: finalUrl, status: response.status, contentType, html, receipt: { ...receipt } };
  const extraction = extractPublicPage(page, { merchantId: 'mytheresa', typeHint: 'fashion' });
  const detailRecords = (extraction.jsonLd ?? []).map((row, index) => normalizeSchemaProduct(row, page, receipt.id,
    `observed product detail JSON-LD row ${index + 1}`)).filter(Boolean);
  detailRecords.push(...observedEmbeddedProducts(extraction, page, receipt.id));
  const cardRecord = { type: 'RetailProduct', sourceLocalId: null, title: scrubVisibleText(card.title, 500), url: detailUrl,
    description: null, brand: null, price: { amount: null, currency: null, priceText: null },
    rating: { value: null, best: null, worst: null, reviewCount: null, ratingCount: null }, variants: [], reviewSamples: [],
    evidence: [{ receiptId: womenContract.evidenceReceiptId,
      locator: `observed product carousel card (${card.ancestry.map(item => `${item.tag}.${item.className ?? ''}`).join(' > ')})`,
      fields: ['type', 'title', 'url'] }] };
  const pathId = /(?:^|-)\b(p\d{5,})$/i.exec(new URL(detailUrl).pathname.split('/').at(-1) ?? '')?.[1] ?? null;
  if (pathId) {
    cardRecord.sourceLocalId = pathId;
    cardRecord.evidence[0].fields.push('sourceLocalId');
    cardRecord.evidence[0].locator += '; observed SKU-like suffix in href path';
  }
  const matchingDetail = detailRecords.find(item => item.url === detailUrl || (item.title && item.title === cardRecord.title));
  if (matchingDetail) matchingDetail.evidence.push(...cardRecord.evidence);
  else detailRecords.push(cardRecord);
  report.records = uniqueRecords([...(report.records ?? []), ...detailRecords]);
  contract.title = extraction.title;
  contract.description = extraction.description;
  contract.jsonLdBlocks = extraction.jsonLd.length;
  contract.embeddedJsonBlocks = extraction.embeddedJson.length;
  contract.offeringRecordCount = detailRecords.length;
  contract.detailProductRecordCount = detailRecords.filter(item => item.type === 'RetailProduct').length;
  frontier.state = 'read';
  frontier.observedCounts = { jsonLdBlocks: extraction.jsonLd.length, embeddedJsonBlocks: extraction.embeddedJson.length,
    offeringRecords: detailRecords.length };
  report.discoveryBounds = { ...(report.discoveryBounds ?? {}), productDetailRead: true,
    productDetailUrl: safeUrl(finalUrl), productDetailReceiptId: receipt.id, productCardSourceReceiptId: womenContract.evidenceReceiptId,
    maxNewCategoryPages: 1, maxNewProductDetailPages: 1 };
  const recordReceiptIds = [...new Set(report.records.flatMap(record => (record.evidence ?? []).map(item => item.receiptId).filter(Boolean)))];
  report.operations = { ...(report.operations ?? {}), productOrServiceRecord: { state: report.records.length ? 'live_replay' : 'not_observed',
      recordCount: report.records.length, evidenceReceiptIds: recordReceiptIds },
    price: { state: report.records.some(row => row.price?.amount != null || row.price?.priceText != null) ? 'live_replay' : 'not_observed',
      recordCount: report.records.filter(row => row.price?.amount != null || row.price?.priceText != null).length,
      evidenceReceiptIds: [...new Set(report.records.filter(row => row.price?.amount != null || row.price?.priceText != null)
        .flatMap(row => row.evidence.map(item => item.receiptId).filter(Boolean)))] } };
  report.status = report.records.length ? 'ontology_records_observed' : 'reachable_without_offering_record';
  report.checkedAt = new Date().toISOString();
  saveCheckpoint(report);
  process.stdout.write(`${JSON.stringify({ status: report.status, records: report.records.length, productDetailUrl: finalUrl,
    cardTitle: cardRecord.title, jsonLdBlocks: extraction.jsonLd.length, blocked: report.blocked })}\n`);
  return report;
}

/** Refresh the exact observed women page once and retain every unique named slug PDP card. */
export async function refreshMytheresaWomenProductCards() {
  const report = JSON.parse(readFileSync(RESULT_PATH, 'utf8'));
  if (report.blocked) return report;
  const startedAt = new Date().toISOString();
  let response = null;
  let bytes = Buffer.alloc(0);
  let complete = false;
  let failure = null;
  try {
    // Re-read only this prior observed first-party URL, with native fetch defaults.
    response = await fetch(WOMEN_URL);
    const streamed = await responseBytes(response);
    bytes = streamed.bytes;
    complete = streamed.complete;
  } catch (error) { failure = error?.name === 'AbortError' ? 'FETCH_ABORTED' : 'NATIVE_FETCH_FAILED'; }
  const contentType = response?.headers?.get('content-type') ?? null;
  const finalUrl = safeUrl(response?.url ?? WOMEN_URL);
  const receipt = { id: randomUUID(), requestMethod: 'GET', requestUrl: WOMEN_URL, finalUrl,
    responseStatus: Number.isInteger(response?.status) ? response.status : null, contentType, bytes: bytes.length,
    responseSha256: complete ? createHash('sha256').update(bytes).digest('hex') : null, observedAt: startedAt,
    browserUsed: false, cookiesSent: false, authorizationSent: false, customHeaders: false,
    secureTransport: true, nativeFetchDefault: true, ...(response?.redirected ? { redirected: true } : {}),
    ...(!complete ? { bodyTruncated: true } : {}), ...(failure ? { stopReason: failure } : {}) };
  report.receipts.push(receipt);
  const contract = { operation: 'observed_women_product_card_inventory_refresh', method: 'GET', requestUrl: WOMEN_URL,
    finalUrl, status: receipt.responseStatus, contentType, observedAt: startedAt, browserUsed: false, cookiesSent: false,
    authorizationSent: false, customHeaders: false, nativeFetchDefault: true, redirected: Boolean(response?.redirected),
    bodyPersisted: false, evidenceReceiptId: receipt.id, maxPageRequests: 1, noProductDetailRequests: true,
    noCategoryFollowupRequests: true, ...(failure ? { stopReason: failure } : {}) };
  report.contracts.push(contract);
  const frontier = { operation: 'observed_women_product_card_inventory_refresh', url: WOMEN_URL,
    state: failure ?? 'receipt_checkpointed', retry: false, evidenceReceiptId: receipt.id,
    discoveredFromReceiptId: report.receipts.find(item => item.requestUrl === ROOT_URL)?.id ?? null };
  report.frontier.push(frontier);
  report.checkedAt = new Date().toISOString();
  report.status = 'receipt_checkpointed';
  saveCheckpoint(report); // Save the safe receipt before parsing HTML.
  if (failure) { report.status = 'attempt_without_response'; frontier.state = failure; saveCheckpoint(report); return report; }
  if (!complete) { report.status = 'response_too_large_stopped'; frontier.state = 'response_too_large'; saveCheckpoint(report); return report; }
  if ([401, 403, 418, 429].includes(Number(response.status))) {
    report.blocked = true; report.status = 'blocked_stopped'; frontier.state = `HTTP_${response.status}`; frontier.stopHost = true;
    contract.stopReason = 'HTTP_ACCESS_BLOCKED'; saveCheckpoint(report); return report;
  }
  if (response.status !== 200) {
    report.status = `http_${response.status}_stopped`; frontier.state = `HTTP_${response.status}`; saveCheckpoint(report); return report;
  }
  if (!finalUrl || !safeMerchantUrl(finalUrl) || !/^text\/html(?:;|$)/i.test(contentType ?? '')) {
    report.status = 'final_url_or_html_mime_outside_expected_scope'; frontier.state = report.status; saveCheckpoint(report); return report;
  }
  const html = textFromBytes(bytes, contentType);
  bytes = Buffer.alloc(0);
  if (isStrongPublicChallenge(Object.fromEntries(response.headers.entries()), html)) {
    report.blocked = true; report.status = 'visible_challenge_stopped'; frontier.state = 'VISIBLE_CHALLENGE'; frontier.stopHost = true;
    contract.stopReason = 'VISIBLE_CHALLENGE'; saveCheckpoint(report); return report;
  }
  const page = { ok: true, url: finalUrl, status: response.status, contentType, html, receipt: { ...receipt } };
  const extraction = extractPublicPage(page, { merchantId: 'mytheresa', typeHint: 'fashion' });
  const anchors = pageAnchors(html, finalUrl);
  const generic = /^(?:전체 보기|더 보기|자세히 보기|shop now|view all|quick view|wishlist|장바구니)$/i;
  const slugAnchors = anchors.filter(row => /-p\d{5,}(?:\/|$)/i.test(new URL(row.url).pathname));
  const cardRows = slugAnchors.filter(row => {
    const anchorName = row.text || row.imageAlt || row.anchorTitle;
    return anchorName && !generic.test(anchorName.trim());
  });
  const records = cardRows.map((row, index) => {
    const title = scrubVisibleText(row.text || row.imageAlt || row.anchorTitle, 500);
    const slug = new URL(row.url).pathname.split('/').at(-1) ?? '';
    const pathId = /-p\d{5,}$/i.exec(slug)?.[0]?.slice(1) ?? null;
    const fields = ['type', 'title', 'url'];
    if (pathId) fields.push('sourceLocalId');
    return { type: 'RetailProduct', sourceLocalId: pathId, title, url: safeUrl(row.url), description: null, brand: null,
      price: { amount: null, currency: null, priceText: null },
      rating: { value: null, best: null, worst: null, reviewCount: null, ratingCount: null }, variants: [], reviewSamples: [],
      evidence: [{ receiptId: receipt.id,
        locator: `${row.labelSource ?? 'anchor label'} on observed slug PDP anchor ${index + 1}${pathId ? `; href suffix ${pathId}` : ''}`,
        fields }] };
  });
  report.records = uniqueRecords([...(report.records ?? []), ...records]);
  const classified = anchors.map(classifyAnchor).filter(Boolean);
  const categories = classified.filter(row => row.kind === 'observed_category');
  contract.title = extraction.title;
  contract.description = extraction.description;
  contract.jsonLdBlocks = extraction.jsonLd.length;
  contract.embeddedJsonBlocks = extraction.embeddedJson.length;
  contract.labeledSameHostAnchorCount = anchors.length;
  contract.observedCategoryLinkCount = categories.length;
  contract.observedSlugAnchorCount = slugAnchors.length;
  contract.uniqueNamedProductCardCount = records.length;
  contract.slugAnchorDiagnostics = slugAnchors.slice(0, 20).map(row => ({ url: row.url, text: scrubVisibleText(row.text, 400),
    imageAlt: scrubVisibleText(row.imageAlt, 300), anchorTitle: scrubVisibleText(row.anchorTitle, 300), labelSource: row.labelSource }));
  contract.observedProductCards = records.map(record => ({ sourceLocalId: record.sourceLocalId, title: record.title,
    url: record.url, evidenceReceiptId: receipt.id, locator: record.evidence[0].locator }));
  frontier.state = 'read';
  frontier.observedCounts = { labeledSameHostAnchors: anchors.length, observedCategoryLinks: categories.length,
    slugAnchors: slugAnchors.length, uniqueNamedProductCards: records.length };

  // Older path-keyword counts were overinclusive; retain them only as explicitly superseded history.
  for (const previous of report.contracts.filter(item => item.operation === 'anonymous_root_native_fetch'
    || item.operation === 'observed_category')) {
    if (previous.legacyClassificationMethod) continue;
    previous.legacyClassifiedCount = previous.observedAnchorCount;
    previous.legacyCategoryLinkCount = previous.observedCategoryLinkCount;
    previous.legacyProductLinkCount = previous.observedProductLinkCount;
    previous.legacyClassificationMethod = 'Keyword-only classification overcounted /women product slugs; superseded by DOM card extraction.';
    previous.observedAnchorCount = null;
    previous.observedCategoryLinkCount = null;
    previous.observedProductLinkCount = null;
  }
  report.operations = { ...(report.operations ?? {}), publicPageRead: { state: 'live_replay', evidenceReceiptIds: report.receipts.map(item => item.id) },
    publicCatalogNavigation: { state: records.length ? 'named_product_cards_observed' : 'no_named_product_cards_on_refresh',
      categoryLinkCount: categories.length, productLinkCount: records.length, productCardCount: records.length,
      evidenceReceiptIds: [receipt.id] },
    productOrServiceRecord: { state: records.length ? 'live_replay' : report.records.length ? 'retained_prior_evidence_after_zero_fresh_cards' : 'not_observed',
      freshCardRecordCount: records.length, recordCount: report.records.length,
      evidenceReceiptIds: [...new Set(report.records.flatMap(record => record.evidence.map(item => item.receiptId)))] },
    price: { state: 'not_observed', recordCount: 0, evidenceReceiptIds: [] } };
  report.discoveryBounds = { ...(report.discoveryBounds ?? {}), productCardInventoryReceiptId: receipt.id,
    uniqueNamedProductCardCount: records.length, productDetailRequestsInThisStep: 0, categoryFollowupRequestsInThisStep: 0,
    cardFields: ['title', 'url', 'sourceLocalId_from_observed_href_suffix'] };
  report.status = report.records.length ? 'ontology_records_observed' : 'reachable_without_offering_record';
  report.checkedAt = new Date().toISOString();
  saveCheckpoint(report);
  process.stdout.write(`${JSON.stringify({ status: report.status, uniqueNamedProductCards: records.length,
    totalRecords: report.records.length, categories: categories.length, pageRequests: 1, detailRequests: 0, blocked: report.blocked })}\n`);
  return report;
}

/** Parent-facing collector: always replay the observed first-party women listing once. */
export async function collectMytheresaPublicNative() {
  return refreshMytheresaWomenProductCards();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const operation = process.argv.includes('--refresh-women-cards') ? refreshMytheresaWomenProductCards
    : process.argv.includes('--continue-observed-pdp') ? collectMytheresaNativeObservedCardPdp
    : process.argv.includes('--continue-catalog') ? collectMytheresaNativeCatalog
      : process.argv.includes('--root-discovery') ? collectMytheresaNative : collectMytheresaPublicNative;
  operation().catch(error => { process.stderr.write(`${error.code ?? error.message}\n`); process.exitCode = 1; });
}
