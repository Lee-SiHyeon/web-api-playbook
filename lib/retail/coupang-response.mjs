import { createHash } from 'node:crypto';
import { parse } from 'parse5';

const MAX_BYTES = 8 * 1024 * 1024;
const ORIGIN = 'https://www.coupang.com';
const safeError = error => /^COUPANG_[A-Z0-9_]{1,100}$/.test(error?.code ?? '')
  ? error.code : 'COUPANG_RETAIL_PARSE_FAILED';
const clean = value => value.replace(/\s+/g, ' ').trim();
const fail = code => { throw Object.assign(new Error(code), { code }); };

// Parse only a literal JSON array. Never execute/evaluate response JavaScript.
function jsonArrayAt(source, start) {
  if (source[start] !== '[') return null;
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      if (--depth === 0) {
        try { return { value: JSON.parse(source.slice(start, i + 1)), end: i + 1 }; }
        catch { return null; }
      }
    }
  }
  return null;
}

function inspectHtml(body) {
  const doc = parse(body), stack = [{ node: doc, depth: 0, hidden: false }];
  const scripts = [], json = [], flight = [], productLinks = new Set(), cardLists = [];
  const signals = { nodes: 0, scripts: 0, externalScripts: 0, jsonScripts: 0, invalidJsonScripts: 0,
    flightPushes: 0, unsupportedFlightPushes: 0, productLinks: 0, exactSkuLinks: 0,
    passwordInputs: 0, metaRefresh: false, scriptNavigation: false,
    mainProductCards: 0, visibleTextCharacters: 0, titlePresent: false, accessDeniedTitle: false,
    challengeTitle: false, loginTitle: false, humanVerificationText: false };
  const exactLinks = new Set(); let title = '', visible = '';
  const textOf = node => (node.childNodes ?? []).filter(n => n.nodeName === '#text').map(n => n.value).join('');
  while (stack.length) {
    const { node, depth, hidden } = stack.pop();
    if (++signals.nodes > 250000 || depth > 256) fail('COUPANG_RETAIL_HTML_STRUCTURE_LIMIT');
    const tag = node.tagName, attrs = Object.fromEntries((node.attrs ?? []).map(a => [a.name, a.value]));
    const suppressed = hidden || ['script', 'style', 'template', 'head'].includes(tag) || 'hidden' in attrs;
    if (tag === 'title') title += textOf(node);
    if (!suppressed && attrs.id === 'product-list') cardLists.push((node.childNodes ?? []).filter(n => n.tagName === 'li'));
    if (node.nodeName === '#text' && !suppressed) visible += ' ' + node.value;
    if (tag === 'input' && attrs.type?.toLowerCase() === 'password') signals.passwordInputs++;
    if (tag === 'meta' && attrs['http-equiv']?.toLowerCase() === 'refresh') signals.metaRefresh = true;
    if (tag === 'a' && attrs.href) {
      try {
        const u = new URL(attrs.href, ORIGIN);
        if (u.origin === ORIGIN && !u.username && !u.password && /^\/vp\/products\/[1-9]\d{0,19}$/.test(u.pathname)) {
          productLinks.add(u.pathname);
          if (/^[1-9]\d{0,19}$/.test(u.searchParams.get('itemId') ?? '')
            && /^[1-9]\d{0,19}$/.test(u.searchParams.get('vendorItemId') ?? ''))
            exactLinks.add([u.pathname, u.searchParams.get('itemId'), u.searchParams.get('vendorItemId')].join(':'));
        }
      } catch { /* A malformed/unrelated link is not a product. */ }
    }
    if (tag === 'script') {
      if (++signals.scripts > 4000) fail('COUPANG_RETAIL_HTML_STRUCTURE_LIMIT');
      if (attrs.src) signals.externalScripts++;
      const source = textOf(node); scripts.push(source);
      if (attrs.id === '__NEXT_DATA__' || /^application\/(?:ld\+)?json(?:\s*;|$)/i.test(attrs.type ?? '')) {
        signals.jsonScripts++;
        try { json.push(JSON.parse(source)); } catch { signals.invalidJsonScripts++; }
      }
    }
    for (const child of (node.childNodes ?? []).toReversed()) stack.push({ node: child, depth: depth + 1, hidden: suppressed });
    // Inert template content is not evidence of displayed products.
  }
  title = clean(title); visible = clean(visible);
  signals.titlePresent = title.length > 0;
  signals.accessDeniedTitle = /^(?:Access Denied|접근\s*(?:거부|차단))\s*[.!]?$/i.test(title);
  signals.challengeTitle = /^(?:Challenge|Just a moment(?:\.\.\.)?|Security Verification|보안 확인)\s*[.!]?$/i.test(title);
  signals.loginTitle = /^(?:로그인|Sign in|Log in)(?:\s*[-|·]\s*쿠팡|\s*[-|·]\s*Coupang)?$/i.test(title);
  signals.humanVerificationText = /\bverify (?:that )?you are human\b/i.test(visible);
  signals.visibleTextCharacters = visible.length;
  signals.productLinks = productLinks.size; signals.exactSkuLinks = exactLinks.size;
  for (const source of scripts) {
    signals.scriptNavigation ||= /\b(?:(?:window|document)\.)?location(?:\.href\s*=|\s*=|\.(?:replace|assign)\s*\()/u.test(source);
    const calls = /(?:self|window)\.__next_f\.push\(\s*/g; let match;
    while ((match = calls.exec(source))) {
      if (++signals.flightPushes > 4000) fail('COUPANG_RETAIL_HTML_STRUCTURE_LIMIT');
      const literal = jsonArrayAt(source, calls.lastIndex);
      if (!literal || !/^\s*\)/.test(source.slice(literal.end))) { signals.unsupportedFlightPushes++; continue; }
      calls.lastIndex = literal.end;
      if (literal.value[0] === 1 && typeof literal.value[1] === 'string') flight.push(literal.value[1]);
    }
  }
  signals.mainProductCards = cardLists.reduce((n, cards) => n + cards.length, 0);
  return { signals, json, flight: flight.join(''), cardLists };
}

// Reuse the observed #product-list > li / productName / priceArea contract.
// Never pick the first/last number from a combined original/sale/unit-price string.
function domListing(cardLists) {
  if (cardLists.length !== 1 || cardLists[0].length > 1000) fail('COUPANG_RETAIL_DOM_SCHEMA');
  const attr = (node, key) => node.attrs?.find(a => a.name === key)?.value ?? '';
  function visibleNodes(root) {
    const nodes = [], stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (nodes.length > 250000) fail('COUPANG_RETAIL_HTML_STRUCTURE_LIMIT');
      if (['script','style','template','del','s','strike'].includes(node.tagName)
        || node.attrs?.some(a => a.name === 'hidden' || a.name === 'aria-hidden' && a.value === 'true')
        || /(?:^|\s)(?:fw-)?line-through(?:\s|$)/.test(attr(node, 'class'))) continue;
      nodes.push(node); stack.push(...(node.childNodes ?? []).toReversed());
    }
    return nodes;
  }
  const text = root => clean(visibleNodes(root).filter(n => n.nodeName === '#text').map(n => n.value).join(''));
  const products = [];
  for (const card of cardLists[0]) {
    const nodes = visibleNodes(card), links = new Map();
    for (const node of nodes.filter(n => n.tagName === 'a')) {
      try {
        const u = new URL(attr(node, 'href'), ORIGIN);
        if (u.origin !== ORIGIN || u.username || u.password || !/^\/vp\/products\/[1-9]\d{0,19}$/.test(u.pathname)) continue;
        const item = u.searchParams.get('itemId'), vendor = u.searchParams.get('vendorItemId');
        if (!/^[1-9]\d{0,19}$/.test(item ?? '') || !/^[1-9]\d{0,19}$/.test(vendor ?? '')) fail('COUPANG_RETAIL_DOM_SCHEMA');
        const url = ORIGIN + u.pathname + '?itemId=' + item + '&vendorItemId=' + vendor;
        links.set(url, { productId: u.pathname.split('/').at(-1), vendorItemId: vendor });
      } catch (error) { if (error?.code) throw error; }
    }
    if (links.size === 0) continue; // A non-product ad/placeholder is not a product.
    if (links.size !== 1) fail('COUPANG_RETAIL_DOM_SCHEMA');
    const names = nodes.filter(n => /(?:^|\s)ProductUnit_productName[^\s]*/.test(attr(n, 'class')));
    const priceAreas = nodes.filter(n => /(?:^|\s)PriceArea_priceArea__[^\s]+/.test(attr(n, 'class')));
    if (names.length !== 1 || priceAreas.length !== 1 || !text(names[0])) fail('COUPANG_RETAIL_DOM_SCHEMA');
    const priceLabel = text(priceAreas[0]);
    if (/(?:월|개월|개당|일당)|-\s*[\d,]+\s*원/.test(priceLabel)) fail('COUPANG_RETAIL_DOM_PRICE_AMBIGUOUS');
    const prices = [...priceLabel.matchAll(/(?:^|[^\d,.])((?:\d{1,3}(?:,\d{3})+|\d+))\s*원/g)]
      .map(m => Number(m[1].replaceAll(',', '')));
    if (prices.length !== 1 || !Number.isSafeInteger(prices[0]) || prices[0] <= 0) fail('COUPANG_RETAIL_DOM_PRICE_AMBIGUOUS');
    const [link, identity] = [...links][0];
    const fees = nodes.filter(n => attr(n, 'data-badge-type') === 'feePrice');
    products.push({ legacyProductId: identity.productId, vendorItemId: identity.vendorItemId, link,
      imageAndTitleArea: { title: text(names[0]) }, priceArea: { price: priceLabel,
        i18nSalesPrice: { amount: String(prices[0]), currency: 'KRW', fractionDigits: 0 },
        shippingFeeDescription: fees.map(text).join(' ') }, adBadgeArea: { sponsored: /광고/.test(text(card)) } });
  }
  if (!products.length) fail('COUPANG_RETAIL_DOM_SCHEMA');
  return { products };
}

/** Metadata is safe to persist. data contains validated public products, never HTML/script/cookie values.
 * productCount:null means unmeasured. It must never be coerced to zero or called an empty catalog.
 * Generic DOM links/JSON-LD are candidates. Only the pinned product-list card schema can validate DOM prices.
 */
export function inspectCoupangResponse({ body, sourceUrl, status, contentType, parseRsc }) {
  const diagnostic = { httpStatus: Number.isInteger(status) ? status : null,
    contentType: typeof contentType === 'string' ? contentType.split(';')[0].trim().toLowerCase() : null,
    bodyBytes: typeof body === 'string' ? Buffer.byteLength(body) : null, bodySha256: null,
    format: 'unknown', classification: 'unknown', htmlInspected: false, html: null,
    parseAttempted: false, parseStatus: 'not_attempted', parserFormat: null,
    productCount: null, dataValidated: false, strategies: [] };
  const result = { ok: false, code: null, data: null, diagnostic };
  try {
    if (typeof body !== 'string' || diagnostic.bodyBytes > MAX_BYTES) fail('COUPANG_RETAIL_RESPONSE_SIZE');
    const u = new URL(sourceUrl);
    if (u.origin !== ORIGIN || u.pathname !== '/np/search' || u.username || u.password) fail('COUPANG_RETAIL_RESPONSE_SCOPE');
    diagnostic.bodySha256 = createHash('sha256').update(body).digest('hex');
    // Body evidence wins over a misleading/missing Content-Type.
    const lead = body.replace(/^\uFEFF/, '').replace(/^(?:\s*<!--[\s\S]*?-->)*\s*/, '');
    const looksRsc = /^[\da-f]+:(?:[A-Z]*[\[{])/im.test(lead), looksJson = /^[\[{]/.test(lead);
    const isHtml = /^(?:<!doctype\s+html\b|<(?:html|head|body|title|script|meta|div|main|form|a)\b)/i.test(lead)
      || diagnostic.contentType === 'text/html' && !looksRsc && !looksJson;
    const candidates = []; let cardLists = [];
    if (isHtml) {
      diagnostic.format = 'html';
      const html = inspectHtml(body); diagnostic.htmlInspected = true; diagnostic.html = html.signals;
      cardLists = html.cardLists;
      diagnostic.strategies.push({ name: 'html_dom', status: 'inspected', candidates: html.signals.exactSkuLinks });
      diagnostic.classification = html.signals.accessDeniedTitle ? 'access_denied'
        : html.signals.challengeTitle || html.signals.humanVerificationText ? 'challenge'
        : html.signals.loginTitle && html.signals.passwordInputs > 0 ? 'login'
        : html.signals.productLinks > 0 ? 'unvalidated_listing_candidates'
        : html.signals.visibleTextCharacters === 0 && html.signals.scripts > 0 ? 'script_shell' : 'html_unclassified';
      if (html.flight) candidates.push({ format: 'html_embedded_rsc', body: html.flight });
      diagnostic.strategies.push({ name: 'html_embedded_rsc', status: html.flight ? 'found' : 'not_found' });
      for (const model of html.json) candidates.push({ format: 'html_embedded_json', body: '0:' + JSON.stringify(model) });
      diagnostic.strategies.push({ name: 'html_embedded_json', status: html.json.length ? 'found' : 'not_found', candidates: html.json.length });
    } else if (looksRsc || diagnostic.contentType === 'text/x-component') {
      diagnostic.format = 'rsc'; candidates.push({ format: 'rsc', body });
    } else if (looksJson) {
      diagnostic.format = 'json';
      try { candidates.push({ format: 'json', body: '0:' + JSON.stringify(JSON.parse(body)) }); }
      catch { fail('COUPANG_RETAIL_JSON_INVALID'); }
    }
    if (status !== 200) fail('COUPANG_RETAIL_HTTP_' + (Number.isInteger(status) ? status : 'UNKNOWN'));
    if (['access_denied', 'challenge'].includes(diagnostic.classification)) fail('COUPANG_RETAIL_CHALLENGE');
    if (diagnostic.classification === 'login') fail('COUPANG_RETAIL_LOGIN_HTML');
    if (!candidates.length && !cardLists.length) {
      diagnostic.parseStatus = 'unsupported';
      fail(isHtml ? 'COUPANG_RETAIL_HTML_UNSUPPORTED' : 'COUPANG_RETAIL_FORMAT_UNSUPPORTED');
    }
    if (typeof parseRsc !== 'function') fail('COUPANG_RETAIL_PARSER_MISSING');
    diagnostic.parseAttempted = true;
    const validated = new Map(); let lastError = null;
    for (const candidate of candidates) {
      try {
        const data = parseRsc(candidate.body, sourceUrl);
        if (!Array.isArray(data?.products) || !data.products.length) fail('COUPANG_RETAIL_EMPTY_UNVERIFIED');
        const key = createHash('sha256').update(JSON.stringify(data.products)).digest('hex');
        validated.set(key, { data, format: candidate.format });
        diagnostic.strategies.push({ name: candidate.format, status: 'validated' });
      } catch (error) {
        lastError = safeError(error);
        diagnostic.strategies.push({ name: candidate.format, status: 'rejected', code: lastError });
      }
    }
    // DOM is a fallback, not a second differently-shaped list to merge into Flight results.
    if (validated.size === 0 && cardLists.length) {
      try {
        const data = parseRsc('0:' + JSON.stringify(domListing(cardLists)), sourceUrl);
        data.kind = 'retail_html_listing';
        for (const product of data.products) product.price.basis = 'html_displayed_sales_price';
        validated.set('html_dom', { data, format: 'html_dom' });
        diagnostic.strategies.push({ name: 'html_dom_cards', status: 'validated' });
      } catch (error) {
        lastError = safeError(error); diagnostic.strategies.push({ name: 'html_dom_cards', status: 'rejected', code: lastError });
      }
    }
    if (validated.size !== 1) fail(validated.size > 1 ? 'COUPANG_RETAIL_LIST_AMBIGUOUS' : lastError ?? 'COUPANG_RETAIL_SCHEMA_UNRECOGNIZED');
    const { data, format } = validated.values().next().value;
    result.data = data; result.ok = true;
    Object.assign(diagnostic, { classification: 'validated_listing', parseStatus: 'validated', parserFormat: format,
      productCount: data.products.length, dataValidated: true });
  } catch (error) {
    result.code = safeError(error);
    if (diagnostic.parseAttempted) diagnostic.parseStatus = 'failed';
  }
  return result;
}
