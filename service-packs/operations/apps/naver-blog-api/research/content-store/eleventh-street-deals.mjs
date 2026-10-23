import { createHash } from 'node:crypto';

const SOURCE_URL = 'https://www.11st.co.kr/html/nc/deal/main.html';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const PUBLISHER = '11번가 쇼킹딜';

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function validateLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1) throw fail('SOURCE_LIMIT');
}

function header(response, name) {
  return response?.headers?.get?.(name) || '';
}

function attribute(tag, name) {
  const attributes = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const match of String(tag).matchAll(attributes)) {
    if (match[1].toLowerCase() === name.toLowerCase()) {
      return decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
    }
  }
  return '';
}

function declaredCharset(contentType) {
  const match = String(contentType).match(/(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i);
  return (match?.[1] || match?.[2] || match?.[3] || '').trim();
}

function metaCharset(bytes) {
  const prefix = Buffer.from(bytes.subarray(0, Math.min(bytes.byteLength, 8192))).toString('latin1');
  for (const tag of prefix.match(/<meta\b[^>]*>/gi) || []) {
    const direct = attribute(tag, 'charset');
    if (direct) return direct;
    const content = attribute(tag, 'content');
    const match = content.match(/\bcharset\s*=\s*([^\s;]+)/i);
    if (match?.[1]) return match[1].replace(/^["']|["']$/g, '');
  }
  return '';
}

function decodeHtml(bytes, contentType) {
  const charset = declaredCharset(contentType) || metaCharset(bytes) || 'utf-8';
  let decoder;
  try { decoder = new TextDecoder(charset); }
  catch { throw fail('SOURCE_CHARSET'); }
  return { text: decoder.decode(bytes), charset: decoder.encoding };
}

async function readBoundedBody(response) {
  const length = header(response, 'content-length');
  if (/^\d+$/.test(length) && Number(length) > MAX_BODY_BYTES) throw fail('SOURCE_TOO_LARGE');

  const stream = response?.body;
  if (!stream?.getReader) {
    let bytes;
    try { bytes = new Uint8Array(await response.arrayBuffer()); }
    catch { throw fail('SOURCE_TRANSPORT'); }
    if (bytes.byteLength > MAX_BODY_BYTES) throw fail('SOURCE_TOO_LARGE');
    return bytes;
  }

  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > MAX_BODY_BYTES) {
        try { await reader.cancel(); } catch { /* Ignore cancellation after the bound is reached. */ }
        throw fail('SOURCE_TOO_LARGE');
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error?.code) throw error;
    throw fail('SOURCE_TRANSPORT');
  } finally {
    try { reader.releaseLock(); } catch { /* Some test streams do not expose a releasable lock. */ }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function decodeEntities(value) {
  return String(value).replace(/&(#(?:x[\da-f]{1,6}|\d{1,7})|amp|lt|gt|quot|apos|nbsp);/gi, (entity, key) => {
    if (key[0] !== '#') {
      return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[key.toLowerCase()] ?? entity;
    }
    const codePoint = key[1]?.toLowerCase() === 'x'
      ? Number.parseInt(key.slice(2), 16)
      : Number.parseInt(key.slice(1), 10);
    if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff
      || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return '\uFFFD';
    return String.fromCodePoint(codePoint);
  });
}

function cleanText(value) {
  return decodeEntities(String(value || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, ' '))
    .replace(/[\s\u00a0]+/g, ' ')
    .trim();
}

function isBlockedPage(status, html) {
  if (status === 403) return true;
  const sample = html.slice(0, 100_000);
  return /captcha|cf-chl-|challenge-platform|checking your browser|verify (?:that )?you are human|not a robot|access denied|bot detection|security verification|akamai bot|incapsula|perimeterx|datadome|접근이 차단|접속이 제한|비정상적인 접근|보안 확인|자동입력방지|요청이 차단/i.test(sample);
}

function collectRanges(html, tagName) {
  const token = new RegExp('<\\/?' + tagName + '\\b[^>]*>', 'gi');
  const stack = [];
  const ranges = [];
  for (const match of html.matchAll(token)) {
    if (match[0].startsWith('</')) {
      const start = stack.pop();
      if (start !== undefined) ranges.push({ start, end: match.index + match[0].length });
    } else if (!/\/\s*>$/.test(match[0])) {
      stack.push(match.index);
    }
  }
  return ranges;
}

function containingRange(ranges, position) {
  let closest = null;
  for (const range of ranges) {
    if (range.start <= position && range.end > position
      && (!closest || range.end - range.start < closest.end - closest.start)) closest = range;
  }
  return closest;
}

function matchingElementEnd(html, tagName, start) {
  const token = new RegExp('<\\/?' + tagName + '\\b[^>]*>', 'gi');
  token.lastIndex = start;
  let depth = 0;
  let match;
  while ((match = token.exec(html))) {
    if (match[0].startsWith('</')) depth--;
    else if (!/\/\s*>$/.test(match[0])) depth++;
    if (depth === 0) return token.lastIndex;
  }
  return -1;
}

function classElements(html, tagName, className) {
  const token = new RegExp('<' + tagName + '\\b[^>]*>', 'gi');
  const elements = [];
  for (const match of html.matchAll(token)) {
    const classes = attribute(match[0], 'class').split(/\s+/);
    if (!classes.includes(className)) continue;
    const end = matchingElementEnd(html, tagName, match.index);
    if (end >= 0) elements.push(html.slice(match.index, end));
  }
  return elements;
}

function elementInnerHtml(element) {
  if (!element) return '';
  const openingEnd = element.indexOf('>');
  const closingStart = element.lastIndexOf('</');
  return openingEnd >= 0 && closingStart >= openingEnd
    ? element.slice(openingEnd + 1, closingStart)
    : '';
}

function firstClassText(html, className, tagNames) {
  for (const tagName of tagNames) {
    const element = classElements(html, tagName, className)[0];
    if (element) return cleanText(elementInnerHtml(element));
  }
  return '';
}

function secureProductUrl(rawUrl) {
  if (!rawUrl) return null;
  let parsed;
  try { parsed = new URL(rawUrl, SOURCE_URL); }
  catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password
    || !(parsed.hostname === '11st.co.kr' || parsed.hostname.endsWith('.11st.co.kr'))) return null;
  const match = parsed.pathname.match(/^\/products?\/(\d+)(?:\/|$)/i);
  if (!match) return null;
  return { url: parsed.href, productId: match[1] };
}

function amount(value) {
  const digits = String(value || '').replace(/[^\d]/g, '');
  if (!digits) return null;
  const parsed = Number(digits);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function percentage(value) {
  const match = String(value || '').match(/(\d+(?:\.\d+)?)\s*%/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function deliveryFromCard(card) {
  const info = classElements(card, 'div', 'info_flag').map(elementInnerHtml).join(' ');
  const matches = info.match(/(?:무료\s*배송|배송\s*비?\s*(?:(?:무료|포함|불가)|(?:\d[\d,]*\s*원))?|오늘\s*(?:출발|도착)|당일\s*(?:발송|출고)|도착\s*보장|무료\s*설치)/gi) || [];
  return [...new Set(matches.map(cleanText).filter(Boolean))].join(' · ') || null;
}

function titleFromAnchor(anchorTag) {
  const logBody = attribute(anchorTag, 'data-log-body');
  if (!logBody) return '';
  try {
    const parsed = JSON.parse(logBody);
    return typeof parsed.content_name === 'string' ? cleanText(parsed.content_name) : '';
  } catch {
    return '';
  }
}

function formatWon(value) {
  return value === null ? null : value.toLocaleString('en-US') + '원';
}

function summaryFor(deal) {
  const parts = [];
  if (deal.price !== null && deal.salePrice !== null) {
    parts.push('정상가 ' + formatWon(deal.price) + '에서 판매가 ' + formatWon(deal.salePrice));
  } else if (deal.salePrice !== null) {
    parts.push('판매가 ' + formatWon(deal.salePrice));
  } else if (deal.price !== null) {
    parts.push('정상가 ' + formatWon(deal.price));
  }
  if (deal.discountRate !== null) parts.push(deal.discountRate + '% 할인');
  if (deal.deliveryText) parts.push(deal.deliveryText);
  return parts.length ? '쇼킹딜 ' + parts.join(', ') + '.' : '쇼킹딜 상품의 가격 정보를 확인할 수 없습니다.';
}

function productRows(html) {
  if (!/<html\b/i.test(html) || !/<body\b/i.test(html)) throw fail('SCHEMA');
  const markup = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ');
  const listRanges = collectRanges(markup, 'li');
  const rows = [];
  for (const match of markup.matchAll(/<a\b[^>]*>/gi)) {
    const anchorTag = match[0];
    const product = secureProductUrl(attribute(anchorTag, 'href'));
    if (!product) continue;
    const range = containingRange(listRanges, match.index);
    const card = range ? markup.slice(range.start, range.end)
      : markup.slice(Math.max(0, match.index - 2000), Math.min(markup.length, match.index + 3000));
    const title = firstClassText(card, 'name', ['p', 'span', 'strong', 'div']) || titleFromAnchor(anchorTag);
    if (!title) throw fail('SCHEMA');
    const priceText = firstClassText(card, 'normal_price', ['s', 'span', 'strong']);
    const salePriceText = firstClassText(card, 'sale_price', ['strong', 'span', 's']);
    const discountText = firstClassText(card, 'sale', ['span', 'em', 'strong']);
    const deal = {
      productId: product.productId,
      price: amount(priceText),
      salePrice: amount(salePriceText),
      discountRate: percentage(discountText),
      deliveryText: deliveryFromCard(card),
      quantityText: firstClassText(card, 'num', ['span', 'em', 'strong']) || null,
    };
    rows.push({
      title,
      url: product.url,
      publishedAt: null,
      publisher: PUBLISHER,
      summary: summaryFor(deal),
      deal,
    });
  }
  return rows;
}

export async function fetchEleventhStreetDeals(limit, { fetchImpl = globalThis.fetch } = {}) {
  validateLimit(limit);
  if (typeof fetchImpl !== 'function') throw fail('SOURCE_TRANSPORT');

  let response;
  try {
    response = await fetchImpl(SOURCE_URL, {
      method: 'GET',
      redirect: 'follow',
      headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    throw fail('SOURCE_TRANSPORT');
  }

  if (response.status === 403) throw fail('ACCESS_BLOCKED');
  const bytes = await readBoundedBody(response);
  if (isBlockedPage(response.status, Buffer.from(bytes).toString('latin1'))) throw fail('ACCESS_BLOCKED');
  const { text, charset } = decodeHtml(bytes, header(response, 'content-type'));
  if (isBlockedPage(response.status, text)) throw fail('ACCESS_BLOCKED');
  if (response.status !== 200) throw fail('HTTP_STATUS');

  const observed = productRows(text);
  const seen = new Set();
  const unique = [];
  for (const item of observed) {
    if (seen.has(item.deal.productId)) continue;
    seen.add(item.deal.productId);
    unique.push(item);
  }

  return {
    items: unique.slice(0, limit),
    receipt: {
      httpStatus: response.status,
      sourceUrl: SOURCE_URL,
      charset,
      dataSource: 'html',
      observedItems: observed.length,
      uniqueProducts: unique.length,
      responseSha256: createHash('sha256').update(bytes).digest('hex'),
      browserUsed: false,
    },
  };
}
