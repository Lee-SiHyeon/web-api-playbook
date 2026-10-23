const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const HTML_ACCEPT = 'text/html,application/xhtml+xml';

export const SITES = Object.freeze({
  kyowontour: Object.freeze({
    name: '교원투어',
    url: 'https://www.kyowontour.com/etc/promotion/promotionList',
  }),
  lottetour: Object.freeze({
    name: '롯데관광',
    url: 'https://www.lottetour.com/promotion',
  }),
  onlinetourAir: Object.freeze({
    name: '온라인투어',
    airUrl: 'https://www.onlinetour.co.kr/flight/w/international/dcair/dcairList?TabGubun=AS',
    promotionUrl: 'https://www.onlinetour.co.kr/promotion/w/exhibition/theme?gu=A2',
  }),
  webtour: Object.freeze({
    name: '웹투어',
    homeUrl: 'https://www.webtour.com/',
  }),
});

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value) {
  return decodeHtml(String(value ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtml(value) {
  return String(value ?? '').replace(/&(#(?:x[\da-f]+|\d+)|amp|lt|gt|quot|apos|nbsp);/gi, (entity, key) => {
    if (key[0] !== '#') {
      return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[key.toLowerCase()] ?? entity;
    }
    const codePoint = key[1]?.toLowerCase() === 'x'
      ? Number.parseInt(key.slice(2), 16)
      : Number.parseInt(key.slice(1), 10);
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff
      || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return '\uFFFD';
    return String.fromCodePoint(codePoint);
  });
}

function readAttribute(openingTag, name) {
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = String(openingTag ?? '').match(pattern);
  return match ? decodeHtml(match[1] ?? match[2] ?? match[3] ?? '').trim() : '';
}

function hasClass(openingTag, className) {
  return readAttribute(openingTag, 'class').split(/\s+/).includes(className);
}

function firstElementByClass(source, className) {
  const openingPattern = /<([a-z][\w:-]*)\b[^>]*>/gi;
  for (const match of String(source ?? '').matchAll(openingPattern)) {
    if (!hasClass(match[0], className)) continue;
    const tagName = match[1];
    const contentStart = match.index + match[0].length;
    const tags = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'gi');
    tags.lastIndex = contentStart;
    let depth = 1;
    let token;
    while ((token = tags.exec(source))) {
      if (/^<\//.test(token[0])) depth--;
      else if (!/\/\s*>$/.test(token[0])) depth++;
      if (depth === 0) return source.slice(contentStart, token.index);
    }
  }
  return '';
}

function allMatchingBlocks(html, tagName, predicate) {
  const result = [];
  const openPattern = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  for (const match of String(html ?? '').matchAll(openPattern)) {
    if (!predicate(match[0])) continue;
    const closing = new RegExp(`<\\/${tagName}\\s*>`, 'gi');
    closing.lastIndex = match.index + match[0].length;
    const end = closing.exec(html);
    if (end) result.push({ opening: match[0], html: html.slice(match.index, end.index + end[0].length), index: match.index });
  }
  return result;
}

function safeHttpsUrl(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function currentSeoulDate(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function currentSeoulYear(now) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', year: 'numeric' }).format(now));
}

function validIsoDate(year, month, day) {
  if (![year, month, day].every(Number.isInteger)) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function parseKoreanDate(value, now = new Date()) {
  const checkedNow = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(checkedNow.getTime())) return null;
  const text = String(value ?? '').trim().replace(/\([^)]{1,12}\)/g, '').replace(/\s+/g, ' ');
  let match = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (match) return validIsoDate(Number(match[1]), Number(match[2]), Number(match[3]));

  match = text.match(/^(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일?$/u)
    || text.match(/^(\d{4})\s*(?:[./-])\s*(\d{1,2})\s*(?:[./-])\s*(\d{1,2})\s*일?$/u);
  if (match) return validIsoDate(Number(match[1]), Number(match[2]), Number(match[3]));

  match = text.match(/^(\d{1,2})\s*월\s*(\d{1,2})\s*일?$/u);
  if (match) return validIsoDate(currentSeoulYear(checkedNow), Number(match[1]), Number(match[2]));

  match = text.match(/^(\d{1,2})\s*[./-]\s*(\d{1,2})$/u);
  if (match) return validIsoDate(currentSeoulYear(checkedNow), Number(match[1]), Number(match[2]));
  return null;
}

function dateTokens(text) {
  const patterns = [
    /\d{4}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*일?/gu,
    /\d{4}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{1,2}\s*일?/gu,
    /\d{1,2}\s*월\s*\d{1,2}\s*일?/gu,
    /\d{8}/g,
    /\d{1,2}\s*[./-]\s*\d{1,2}(?:\s*\([^)]{1,12}\))?/gu,
  ];
  const found = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const end = match.index + match[0].length;
      if (found.some(token => match.index < token.end && end > token.index)) continue;
      found.push({ index: match.index, end, value: match[0] });
    }
  }
  return found.sort((left, right) => left.index - right.index);
}

export function parseKoreanDateRange(value, now = new Date()) {
  const text = String(value ?? '');
  const matches = dateTokens(text);
  const start = matches.length ? parseKoreanDate(matches[0].value, now) : null;
  if (!start) return { start: null, end: null };
  for (let index = 1; index < matches.length; index++) {
    const between = text.slice(matches[index - 1].end, matches[index].index);
    if (!/(?:~|～|〜|–|—|－|\s+-\s+|부터|까지|\bto\b)/iu.test(between)) continue;
    return { start, end: parseKoreanDate(matches[index].value, now) };
  }
  return { start, end: null };
}

function periodFromLabeledText(text, labelPattern, now) {
  const match = labelPattern.exec(text);
  if (!match) return { start: null, end: null };
  return parseKoreanDateRange(text.slice(match.index, match.index + 180), now);
}

function cardPeriods(text, now) {
  const booking = periodFromLabeledText(text, /(?:예약|판매|구매|모집)\s*(?:기간|일정|일자)?/u, now);
  const travel = periodFromLabeledText(text, /(?:여행|출발|이용)\s*(?:기간|일정|일자)/u, now);
  return { booking, travel };
}

export function filterEndedDeals(items, now = new Date()) {
  const checkedNow = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(checkedNow.getTime())) throw fail('NOW');
  const today = currentSeoulDate(checkedNow);
  return items.filter(item => !item?.deal?.bookingEnd || item.deal.bookingEnd >= today);
}

function formatPeriod(start, end) {
  if (!start && !end) return '미확인';
  const left = start ? start.replace(/-/g, '.') : '미확인';
  const right = end ? end.replace(/-/g, '.') : '미확인';
  return `${left}~${right}`;
}

function normalizePriceText(value) {
  return cleanText(value).replace(/(\d)\s+(원)/gu, '$1$2').replace(/\s+([~～])/gu, '$1') || null;
}

function makeItem({ seller, title, url, destination = null, priceFrom = null, priceText = null,
  bookingStart = null, bookingEnd = null, travelStart = null, travelEnd = null }) {
  const cleanTitle = cleanText(title);
  const safeUrl = safeHttpsUrl(url);
  if (!cleanTitle || !safeUrl) return null;
  const safeDestination = cleanText(destination) || null;
  const safePriceText = normalizePriceText(priceText);
  const summary = `여행지: ${safeDestination || '미확인'} / 최저가: ${safePriceText || '미확인'} / 예약 기간: ${formatPeriod(bookingStart, bookingEnd)} / 여행 기간: ${formatPeriod(travelStart, travelEnd)}`;
  return {
    title: `[${seller}] ${cleanTitle}`,
    url: safeUrl,
    publishedAt: bookingStart || null,
    publisher: seller,
    summary,
    deal: {
      seller,
      destination: safeDestination,
      priceFrom: Number.isFinite(priceFrom) ? priceFrom : null,
      priceText: safePriceText,
      bookingStart: bookingStart || null,
      bookingEnd: bookingEnd || null,
      travelStart: travelStart || null,
      travelEnd: travelEnd || null,
      badges: [],
    },
  };
}

function destinationFrom(value) {
  const text = cleanText(value);
  const parenthetical = text.match(/\(([^()]{2,80})\)/u)?.[1]?.trim();
  if (parenthetical && /[\/,&·]/u.test(parenthetical)) return parenthetical;
  const suffix = text.match(/([가-힣A-Za-z]+(?:\s*[\/,&·]\s*[가-힣A-Za-z]+)+)\s*\d{0,2}\s*일?$/u)?.[1];
  if (suffix) return suffix.replace(/\s+/g, '');
  const bracket = text.match(/^\[([^\]]+)\]/u)?.[1];
  if (bracket) {
    const region = bracket.split(/[\/,&·\s]/u)[0];
    if (['강원', '경상', '충청', '전라', '제주', '부산', '인천', '서울', '울릉도'].includes(region)) return region;
  }
  return null;
}

function priceFromText(text) {
  const match = String(text ?? '').replace(/,/g, '').match(/\d{1,9}/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function numericPrice(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const text = String(value).replace(/[₩원,\s]/gu, '');
  if (!/^\d+$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function itemPeriods(text, now) {
  const { booking, travel } = cardPeriods(text, now);
  return {
    bookingStart: booking.start,
    bookingEnd: booking.end,
    travelStart: travel.start,
    travelEnd: travel.end,
  };
}

function parseKyowontour(html, now) {
  const starts = [...html.matchAll(/<div\b[^>]*\bname=["']eventItem["'][^>]*>/gi)]
    .filter(match => hasClass(match[0], 'list-item') && readAttribute(match[0], 'data-seq'));
  const rows = starts.map((match, index) => {
    const next = starts[index + 1]?.index ?? html.length;
    const block = html.slice(match.index, next);
    const sequence = readAttribute(match[0], 'data-seq');
    const category = cleanText(firstElementByClass(block, 'category'));
    const eventTitle = cleanText(firstElementByClass(block, 'tit'));
    const description = cleanText(firstElementByClass(block, 'txt'));
    const title = eventTitle || [category, description].filter(Boolean).join(' ');
    const fullText = cleanText(block);
    const periods = itemPeriods(fullText, now);
    const destination = category && !['전체', '공통'].includes(category) ? category : destinationFrom(title);
    const item = makeItem({
      seller: SITES.kyowontour.name,
      title,
      url: `https://www.kyowontour.com/etc/promotion/promotionView?eventSeq=${encodeURIComponent(sequence)}`,
      destination,
      priceText: firstElementByClass(block, 'price') ? cleanText(firstElementByClass(block, 'price')) : null,
      priceFrom: priceFromText(firstElementByClass(block, 'price')),
      ...periods,
    });
    return item;
  }).filter(Boolean);
  return { items: rows, observedItems: starts.length, dataSource: 'html' };
}

function parseLottetour(html, now) {
  const blocks = allMatchingBlocks(html, 'li', opening => /\bbn\d+\b/.test(readAttribute(opening, 'class')));
  const items = [];
  for (const entry of blocks) {
    const href = entry.html.match(/<a\b[^>]*href=["']([^"']*\/promotion\/\d+)["'][^>]*>/i)?.[1];
    const title = entry.html.match(/<img\b[^>]*\balt=["']([^"']+)["'][^>]*>/i)?.[1]
      || cleanText(entry.html.match(/<a\b[^>]*>[\s\S]*?<\/a>/i)?.[0]);
    const url = href ? safeHttpsUrl(href, SITES.lottetour.url) : null;
    if (!url || !title) continue;
    const text = cleanText(entry.html);
    const periods = itemPeriods(text, now);
    items.push(makeItem({
      seller: SITES.lottetour.name,
      title,
      url,
      destination: destinationFrom(title),
      priceText: firstElementByClass(entry.html, 'price') ? cleanText(firstElementByClass(entry.html, 'price')) : null,
      priceFrom: priceFromText(firstElementByClass(entry.html, 'price')),
      ...periods,
    }));
  }
  return { items: items.filter(Boolean), observedItems: blocks.length, dataSource: 'html' };
}

function decodeJsSingleQuoted(value) {
  let output = '';
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char !== '\\' || index + 1 >= value.length) {
      output += char;
      continue;
    }
    const next = value[++index];
    if (next === 'n') output += '\n';
    else if (next === 'r') output += '\r';
    else if (next === 't') output += '\t';
    else if (next === 'b') output += '\b';
    else if (next === 'f') output += '\f';
    else if (next === 'u' && /^[\da-f]{4}$/i.test(value.slice(index + 1, index + 5))) {
      output += String.fromCharCode(Number.parseInt(value.slice(index + 1, index + 5), 16));
      index += 4;
    } else output += next;
  }
  return output;
}

function parseOnlineTourAirJson(html, now) {
  const match = html.match(/\b(?:var|let|const)\s+dCairAllListStr\s*=\s*'((?:\\.|[^'])*)'/i);
  if (!match) throw fail('SCHEMA');
  let rows;
  try { rows = JSON.parse(decodeJsSingleQuoted(match[1])); }
  catch { throw fail('SCHEMA'); }
  if (!Array.isArray(rows) || rows.some(row => !record(row))) throw fail('SCHEMA');

  const items = [];
  for (const row of rows) {
    const destination = cleanText(row.start_city_code_name2 || '') || null;
    const origin = cleanText(row.start_city_code_name || '') || null;
    const routeText = origin && destination ? `${origin}-${destination}` : destination || '공동구매 항공권';
    const priceFrom = numericPrice(row.adult_price);
    const priceText = priceFrom === null ? null : `${priceFrom.toLocaleString('ko-KR')}원`;
    const travelStart = parseKoreanDate(row.dep_start_date, now);
    const travelEnd = parseKoreanDate(row.arr_start_date || row.dep_end_date, now);
    const eventCode = typeof row.event_code === 'string' || typeof row.event_code === 'number'
      ? String(row.event_code).trim()
      : '';
    const url = new URL(SITES.onlinetourAir.airUrl);
    if (eventCode) url.searchParams.set('eventCode', eventCode);
    const item = makeItem({
      seller: SITES.onlinetourAir.name,
      title: `${routeText} 공동구매 항공권`,
      url: url.href,
      destination,
      priceFrom,
      priceText,
      travelStart,
      travelEnd,
    });
    if (item) items.push(item);
  }
  return { items, observedItems: rows.length, dataSource: 'embedded_json' };
}

function isNavigationLink(html, index) {
  const from = Math.max(0, index - 800);
  const prefix = html.slice(from, index);
  const itemStart = Math.max(prefix.lastIndexOf('<li'), prefix.lastIndexOf('<nav'), prefix.lastIndexOf('<header'));
  const context = itemStart >= 0 ? prefix.slice(itemStart) : prefix;
  return /\bclass=["'][^"']*(?:sub_menu|main_menu|gnb|header|navigation|nav-item)/i.test(context);
}

function parseOnlineTourPromotions(html, now) {
  const matches = [...html.matchAll(/<a\b[^>]*href=["']([^"']*\/promotion\/w\/exhibition\/view\?[^"']*)["'][^>]*>[\s\S]*?<\/a>/gi)];
  const items = [];
  let observedItems = 0;
  for (const match of matches) {
    if (isNavigationLink(html, match.index)) continue;
    const href = decodeHtml(match[1]);
    const url = safeHttpsUrl(href, SITES.onlinetourAir.promotionUrl);
    if (!url || /idx=\s*(?:&|#|$)/i.test(url)) continue;
    observedItems++;
    const title = cleanText(match[0]) || cleanText(match[0].match(/<img\b[^>]*\balt=["']([^"']+)["']/i)?.[1]);
    if (!title) continue;
    const text = cleanText(match[0]);
    const periods = itemPeriods(text, now);
    const priceText = firstElementByClass(match[0], 'price') ? cleanText(firstElementByClass(match[0], 'price')) : null;
    items.push(makeItem({
      seller: SITES.onlinetourAir.name,
      title,
      url,
      destination: destinationFrom(title),
      priceText,
      priceFrom: priceFromText(priceText),
      ...periods,
    }));
  }
  return { items: items.filter(Boolean), observedItems, dataSource: 'html' };
}

function currentWebtourFestaUrl(html) {
  const pattern = /href=["'](https?:)?\/\/www2\.webtour\.com(\/gevent\/festa\/(\d{4})\/index\.asp)["']/gi;
  for (const match of html.matchAll(pattern)) {
    const month = Number(match[3].slice(-2));
    if (month < 1 || month > 12) continue;
    return `https://www2.webtour.com${match[2]}`;
  }
  return null;
}

const WEBTOUR_DETAIL_PATHS = Object.freeze({
  AG: ['AG/ag_detail.asp', 'GdsCode'],
  AH: ['AH/ah_detail.asp', 'hotelcode'],
  DG: ['dg/dg_detail.asp', 'GdsCode'],
  DJ: ['dj/dj_detail.asp', 'GdsCode'],
  DGH: ['dgh/dgh_detail.asp', 'GdsCode'],
  DGB: ['dgb/dgb_detail.asp', 'GdsCode'],
  DH: ['dh/dh_detail.asp', 'GdsCode'],
  DHT: ['dht/dh_detail.asp', 'GdsCode'],
  DR: ['DR/dr_detail.asp', 'GdsCode'],
  DGN: ['dgn/dgn_detail.asp', 'GdsCode'],
  GT: ['GT/gt_detail.asp', 'GdsCode'],
});

function webtourDetailUrl(kind, productCode) {
  const route = WEBTOUR_DETAIL_PATHS[kind];
  if (!route || !/^[A-Za-z0-9_-]{2,40}$/.test(productCode || '')) return null;
  const url = new URL(route[0], 'https://www2.webtour.com/');
  url.searchParams.set(route[1], productCode);
  return url.href;
}

function parseWebtourFesta(html, sourceUrl, now) {
  const cards = allMatchingBlocks(html, 'a', opening => hasClass(opening, 'list'));
  const items = [];
  for (const entry of cards) {
    const click = readAttribute(entry.opening, 'onclick');
    const route = click.match(/goEvtGdsDetail_Pop\(\s*['"]([A-Z0-9]+)['"]\s*,\s*['"]G['"]\s*,\s*['"]([A-Za-z0-9_-]+)['"]\s*,\s*['"]blank['"]/i);
    if (!route) continue;
    const url = webtourDetailUrl(route[1], route[2]);
    const title = cleanText(firstElementByClass(entry.html, 'name'));
    if (!url || !title) continue;
    const text = cleanText(entry.html);
    const priceMarkup = firstElementByClass(entry.html, 'm');
    const priceText = priceMarkup ? cleanText(priceMarkup) : null;
    const periods = itemPeriods(text, now);
    items.push(makeItem({
      seller: SITES.webtour.name,
      title,
      url,
      destination: destinationFrom(title),
      priceFrom: priceFromText(priceText),
      priceText,
      ...periods,
    }));
  }
  return { items: items.filter(Boolean), observedItems: cards.length, dataSource: 'html', sourceUrl };
}

function charsetFrom(response, bytes) {
  const contentType = response.headers?.get?.('content-type') || '';
  const header = contentType.match(/charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i);
  if (header) return (header[1] || header[2] || header[3]).trim();
  const prefix = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.byteLength, 4096)));
  return prefix.match(/<meta\b[^>]*charset\s*=\s*["']?([^\s"'/>]+)/i)?.[1]?.trim() || 'utf-8';
}

function isChallengePage(text) {
  return /cf_chl_|cdn-cgi\/challenge-platform|captcha|verify you are human|just a moment|checking your browser|access denied|bot challenge/i
    .test(String(text ?? '').slice(0, 30000));
}

function safeErrorCode(error) {
  if (typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)) return error.code;
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'FETCH_TIMEOUT';
  return 'FETCH_FAILED';
}

async function fetchPublicHtml(url, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      credentials: 'omit',
      // Same browser UA + Korean locale as the repo's other collectors; without them some sites (Trip.com)
      // serve a reduced page with no listings (observed 2026-09-24).
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36', 'accept-language': 'ko-KR,ko;q=0.9', accept: HTML_ACCEPT },
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw Object.assign(fail(safeErrorCode(error)), { httpStatus: null });
  }
  const httpStatus = Number.isInteger(response?.status) ? response.status : null;
  if (httpStatus !== 200) {
    throw Object.assign(fail(httpStatus ? `HTTP_${httpStatus}` : 'HTTP_STATUS_INVALID'), { httpStatus });
  }
  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_SOURCE_BYTES) {
    throw Object.assign(fail('SOURCE_TOO_LARGE'), { httpStatus });
  }

  let bytes;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    throw Object.assign(fail('FETCH_BODY'), { httpStatus });
  }
  if (bytes.byteLength > MAX_SOURCE_BYTES) throw Object.assign(fail('SOURCE_TOO_LARGE'), { httpStatus });

  let text;
  try { text = new TextDecoder(charsetFrom(response, bytes)).decode(bytes); }
  catch { throw Object.assign(fail('CHARSET'), { httpStatus }); }
  if (isChallengePage(text)) throw Object.assign(fail('CHALLENGE_PAGE'), { httpStatus });
  return { text, httpStatus };
}

function emptyReceipt(site, sourceUrl, httpStatus, skipped, dataSource = null, extra = {}) {
  return {
    site,
    sourceUrl,
    httpStatus,
    dataSource,
    observedItems: 0,
    parsed: 0,
    skippedEnded: 0,
    skipped: skipped || null,
    ...extra,
  };
}

async function collectHtmlSource({ siteKey, sourceUrl, fetchImpl, now, parser }) {
  const site = siteKey;
  let page;
  try {
    page = await fetchPublicHtml(sourceUrl, fetchImpl);
  } catch (error) {
    return {
      items: [],
      receipt: emptyReceipt(site, sourceUrl, error.httpStatus ?? null, safeErrorCode(error)),
    };
  }

  let parsed;
  try { parsed = parser(page.text, now, sourceUrl); }
  catch (error) {
    return {
      items: [],
      receipt: emptyReceipt(site, sourceUrl, page.httpStatus, safeErrorCode(error)),
    };
  }
  const accepted = parsed.items;
  const filtered = filterEndedDeals(accepted, now);
  return {
    items: filtered,
    receipt: {
      site,
      sourceUrl,
      httpStatus: page.httpStatus,
      dataSource: parsed.dataSource,
      observedItems: parsed.observedItems,
      parsed: accepted.length,
      skippedEnded: accepted.length - filtered.length,
      skipped: null,
    },
  };
}

function dedupeItems(items) {
  const result = [];
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    result.push(item);
  }
  return result;
}

export async function fetchOnlineAgencyDeals(
  limit,
  { fetchImpl = globalThis.fetch, sites = Object.keys(SITES), now = new Date() } = {},
) {
  if (!Number.isInteger(limit) || limit < 1) throw fail('SOURCE_LIMIT');
  if (typeof fetchImpl !== 'function') throw fail('FETCH_IMPL');
  if (!Array.isArray(sites)) throw fail('SITES');
  const selected = [...new Set(sites)];
  for (const site of selected) if (!Object.hasOwn(SITES, site)) throw fail('SITE');
  const checkedNow = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(checkedNow.getTime())) throw fail('NOW');

  const perSite = [];
  const allItems = [];
  for (const siteKey of selected) {
    if (siteKey === 'kyowontour') {
      const result = await collectHtmlSource({
        siteKey, sourceUrl: SITES.kyowontour.url, fetchImpl, now: checkedNow, parser: parseKyowontour,
      });
      perSite.push(result.receipt);
      allItems.push(...result.items);
      continue;
    }
    if (siteKey === 'lottetour') {
      const result = await collectHtmlSource({
        siteKey, sourceUrl: SITES.lottetour.url, fetchImpl, now: checkedNow, parser: parseLottetour,
      });
      perSite.push(result.receipt);
      allItems.push(...result.items);
      continue;
    }
    if (siteKey === 'onlinetourAir') {
      const air = await collectHtmlSource({
        siteKey, sourceUrl: SITES.onlinetourAir.airUrl, fetchImpl, now: checkedNow, parser: parseOnlineTourAirJson,
      });
      perSite.push(air.receipt);
      if (air.receipt.skipped === 'CHALLENGE_PAGE' || air.receipt.httpStatus === 403 || air.receipt.httpStatus === 429) continue;
      const promotions = await collectHtmlSource({
        siteKey, sourceUrl: SITES.onlinetourAir.promotionUrl, fetchImpl, now: checkedNow, parser: parseOnlineTourPromotions,
      });
      perSite.push(promotions.receipt);
      allItems.push(...air.items, ...promotions.items);
      continue;
    }

    let home;
    try { home = await fetchPublicHtml(SITES.webtour.homeUrl, fetchImpl); }
    catch (error) {
      perSite.push(emptyReceipt(siteKey, SITES.webtour.homeUrl, error.httpStatus ?? null, safeErrorCode(error)));
      continue;
    }
    const festaUrl = currentWebtourFestaUrl(home.text);
    if (!festaUrl) {
      perSite.push(emptyReceipt(siteKey, SITES.webtour.homeUrl, home.httpStatus, 'CURRENT_FESTA_NOT_FOUND', 'html'));
      continue;
    }
    const result = await collectHtmlSource({
      siteKey,
      sourceUrl: festaUrl,
      fetchImpl,
      now: checkedNow,
      parser: parseWebtourFesta,
    });
    perSite.push(result.receipt);
    allItems.push(...result.items);
  }

  return {
    items: dedupeItems(allItems).slice(0, limit),
    receipt: { perSite, browserUsed: false },
  };
}
