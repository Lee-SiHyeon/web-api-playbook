const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const DATE_TOKEN = '(?:\\d{4}\\s*[./-]\\s*\\d{1,2}\\s*[./-]\\s*\\d{1,2}|\\d{1,2}\\s*월\\s*\\d{1,2}\\s*일|\\d{1,2}\\s*[./-]\\s*\\d{1,2}(?:\\s*\\([^)]{1,12}\\))?)';
const GENERIC_DESTINATIONS = new Set(['프로모션', '이벤트', '기획전', '전체', '해외여행', '패키지']);

export const SITES = Object.freeze({
  hanatour: Object.freeze({
    seller: '하나투어',
    // The homepage is a Nuxt shell whose __NUXT__ holds only menus. Its product sections come from the
    // public exhibition gateway the page itself calls (bundle 445: ajaxGateway('/front/exhibit/pages',
    // {domain, device, path, homeType})). Anonymous GET verified 2026-09-24; only path=/main is public.
    // Promotion-plan details live on api.hanatour.com behind a JWT and are not used.
    url: 'https://gw.hanatour.com/front/exhibit/pages?domain=www.hanatour.com&device=PC&path=%2Fmain&homeType=',
    linkBase: 'https://www.hanatour.com/',
    accept: 'application/json',
    allowedHosts: ['www.hanatour.com', 'hanatour.com', 'gw.hanatour.com'],
  }),
  modetour: Object.freeze({
    seller: '모두투어',
    url: 'https://www.modetour.com/special-exhibition',
    urls: [
      'https://www.modetour.com/special-exhibition',
      'https://www.modetour.com/event',
    ],
    allowedHosts: ['www.modetour.com', 'modetour.com'],
  }),
  ybtour: Object.freeze({
    seller: '노랑풍선',
    // The pkg promotion list response contains unpopulated templates. The public homepage
    // carries the actual promotion detail links; this is the list page discovered from it.
    url: 'https://www.ybtour.co.kr/',
    promotionListUrl: 'https://pkg.ybtour.co.kr/promotion/promotion.yb',
    allowedHosts: ['www.ybtour.co.kr', 'pkg.ybtour.co.kr'],
  }),
  verygoodtour: Object.freeze({
    seller: '참좋은여행',
    url: 'https://www.verygoodtour.com/Event/EventPlanReview?evtSeq=15238',
    allowedHosts: ['www.verygoodtour.com', 'verygoodtour.com'],
  }),
});

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUsableText(value) {
  return typeof value === 'string' && value.trim() !== '' && !/^(?:null|undefined|none)$/i.test(value.trim());
}

function validNow(now) {
  const date = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error('NOW');
  return date;
}

function seoulYear(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric',
  }).formatToParts(now);
  return Number(parts.find(part => part.type === 'year')?.value);
}

function validIsoDate(year, month, day) {
  if (![year, month, day].every(Number.isInteger)) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function parseKoreanDate(value, now = new Date()) {
  const yearDefault = seoulYear(validNow(now));
  const input = String(value ?? '').trim().replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ');
  let match = input.match(/^(\d{4})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,2})$/);
  if (match) return validIsoDate(Number(match[1]), Number(match[2]), Number(match[3]));

  match = input.match(/^(\d{1,2})\s*월\s*(\d{1,2})\s*일$/);
  if (match) return validIsoDate(yearDefault, Number(match[1]), Number(match[2]));

  match = input.match(/^(\d{1,2})\s*[./-]\s*(\d{1,2})$/);
  if (match) return validIsoDate(yearDefault, Number(match[1]), Number(match[2]));
  return null;
}

export function parseKoreanDateRange(value, now = new Date()) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  const tokens = [...text.matchAll(new RegExp(DATE_TOKEN, 'gu'))];
  if (tokens.length === 0) return { start: null, end: null };
  const start = parseKoreanDate(tokens[0][0], now);
  if (!start || tokens.length < 2) return { start, end: null };

  const between = text.slice(tokens[0].index + tokens[0][0].length, tokens[1].index);
  if (!/(?:~|∼|～|–|—|−|\bto\b|부터|까지)/iu.test(between)) return { start, end: null };
  return { start, end: parseKoreanDate(tokens[1][0], now) };
}

function decodeEntities(value) {
  return String(value ?? '').replace(/&(#(?:x[\da-f]+|\d+)|amp|lt|gt|quot|apos|nbsp);/gi, (whole, key) => {
    if (key[0] !== '#') {
      return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[key.toLowerCase()] ?? whole;
    }
    const codePoint = key[1]?.toLowerCase() === 'x'
      ? Number.parseInt(key.slice(2), 16)
      : Number.parseInt(key.slice(1), 10);
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff
      || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return '\uFFFD';
    return String.fromCodePoint(codePoint);
  });
}

function cleanText(value) {
  return decodeEntities(String(value ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function readAttribute(openingTag, name) {
  const pattern = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\\x27([^\\x27]*)\\x27|([^\\s>]+))', 'i');
  const match = String(openingTag ?? '').match(pattern);
  return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? '') : '';
}

function openingTag(value) {
  return String(value ?? '').match(/^<[^>]+>/)?.[0] ?? '';
}

function contentByClass(html, tagName, className) {
  for (const match of String(html ?? '').matchAll(new RegExp('<' + tagName + '\\b[^>]*>', 'gi'))) {
    if (!readAttribute(match[0], 'class').split(/\s+/).includes(className)) continue;
    const contentStart = match.index + match[0].length;
    const closing = new RegExp('<\\/' + tagName + '\\s*>', 'i').exec(String(html).slice(contentStart));
    if (closing) return String(html).slice(contentStart, contentStart + closing.index);
  }
  return '';
}

function cleanHttpsUrl(rawUrl, baseUrl, allowedHosts) {
  try {
    const url = new URL(rawUrl, baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || !allowedHosts.includes(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

function datePart(value, now) {
  if (typeof value === 'string') {
    const isoDate = value.trim().match(/^(\d{4}-\d{2}-\d{2})(?:[T ].*)?$/)?.[1];
    return parseKoreanDate(isoDate || value, now);
  }
  if (typeof value === 'number') return parseKoreanDate(String(value), now);
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10);
  return null;
}

function firstDeepValue(value, keyPattern, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 12) return undefined;
  for (const [key, child] of Object.entries(value)) {
    if (keyPattern.test(key) && child !== undefined) return child;
  }
  for (const child of Object.values(value)) {
    const found = firstDeepValue(child, keyPattern, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function periodFrom(value, now) {
  if (isRecord(value)) {
    const startValue = firstDeepValue(value, /^(?:start|from|begin|startDate|startDateTime|bookingStart|saleStart)$/i);
    const endValue = firstDeepValue(value, /^(?:end|to|until|endDate|endDateTime|bookingEnd|saleEnd)$/i);
    return { start: datePart(startValue, now), end: datePart(endValue, now) };
  }
  return parseKoreanDateRange(value, now);
}

function firstDeepArray(value, keyPattern, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 12) return [];
  for (const [key, child] of Object.entries(value)) {
    if (keyPattern.test(key) && Array.isArray(child)) return child;
  }
  for (const child of Object.values(value)) {
    const found = firstDeepArray(child, keyPattern, depth + 1);
    if (found.length) return found;
  }
  return [];
}

function parseExplicitPrice(value, rawText = null) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return { priceFrom: value, priceText: rawText || `${new Intl.NumberFormat('ko-KR').format(value)}원~` };
  }
  if (typeof value === 'string' && /^\s*\d[\d,]*\s*$/.test(value)) {
    const number = Number(value.replace(/,/g, '').trim());
    if (Number.isSafeInteger(number) && number >= 0) {
      return { priceFrom: number, priceText: rawText || `${new Intl.NumberFormat('ko-KR').format(number)}원~` };
    }
  }
  const match = String(rawText ?? value ?? '').match(/(?:₩\s*)?(\d[\d,]*)\s*원/);
  if (!match) return { priceFrom: null, priceText: null };
  const number = Number(match[1].replace(/,/g, ''));
  return Number.isSafeInteger(number) && number >= 0
    ? { priceFrom: number, priceText: cleanText(match[0]) }
    : { priceFrom: null, priceText: null };
}

function labeledPeriod(text, labels, now) {
  const cleaned = cleanText(text);
  const labelPattern = new RegExp('(?:' + labels.join('|') + ')\\s*(?:期間|기간|일정)?\\s*[:：]?\\s*([^|]{0,180})', 'iu');
  const match = labelPattern.exec(cleaned);
  return match ? parseKoreanDateRange(match[1], now) : { start: null, end: null };
}

const DESTINATIONS = [
  '이탈리아', '프랑스', '스위스', '스페인', '포르투갈', '영국', '아일랜드', '그리스', '튀르키예',
  '일본', '오사카', '도쿄', '후쿠오카', '큐슈', '대마도', '태국', '방콕', '파타야', '베트남',
  '나트랑', '푸꾸옥', '다낭', '대만', '홍콩', '마카오', '중국', '장가계', '몽골', '미국', '괌',
  '호주', '뉴질랜드', '동유럽', '서유럽', '유럽', '동남아', '북유럽', '발칸',
];

function destinationFrom(text, explicit = null) {
  const category = cleanText(explicit);
  if (isUsableText(category) && !GENERIC_DESTINATIONS.has(category)) return category;
  const source = String(text ?? '');
  let selected = null;
  for (const destination of DESTINATIONS) {
    const index = source.indexOf(destination);
    if (index >= 0 && (!selected || index < selected.index || (index === selected.index && destination.length > selected.value.length))) {
      selected = { value: destination, index };
    }
  }
  return selected?.value ?? null;
}

function collectStrings(value, depth = 0, out = []) {
  if (!value || typeof value !== 'object' || depth > 8 || out.length > 40) return out;
  if (Array.isArray(value)) {
    for (const child of value) collectStrings(child, depth + 1, out);
  } else {
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:label|name|title|text|value|badge|hashtag)$/i.test(key) && typeof child === 'string') out.push(cleanText(child));
      else if (child && typeof child === 'object') collectStrings(child, depth + 1, out);
    }
  }
  return out;
}

function normalizeBadges(values) {
  return [...new Set((values || []).map(cleanText).filter(Boolean))].slice(0, 8);
}

function dateLabel(start, end) {
  if (!start && !end) return '미확인';
  const format = value => value ? value.replace(/-/g, '.') : '미확인';
  return start && end ? `${format(start)}~${format(end)}` : format(start || end);
}

function makeSummary(deal) {
  const destination = deal.destination || '목적지 미확인';
  let price = deal.priceText;
  if (!price && deal.priceFrom !== null) price = `${new Intl.NumberFormat('ko-KR').format(deal.priceFrom)}원~`;
  return `${destination} / ${price || '가격 미확인'} / 예약 ${dateLabel(deal.bookingStart, deal.bookingEnd)} · 여행 ${dateLabel(deal.travelStart, deal.travelEnd)}`;
}

function makeItem({ seller, rawTitle, rawUrl, baseUrl, allowedHosts, destination = null, priceValue = null,
  priceText = null, booking = { start: null, end: null }, travel = { start: null, end: null }, badges = [], now }) {
  const titleText = cleanText(rawTitle);
  const safeUrl = cleanHttpsUrl(rawUrl, baseUrl, allowedHosts);
  if (!isUsableText(titleText) || !safeUrl) return null;
  const price = parseExplicitPrice(priceValue, priceText);
  const deal = {
    seller,
    destination: destinationFrom(titleText, null) || destinationFrom('', destination),
    priceFrom: price.priceFrom,
    priceText: price.priceText,
    bookingStart: booking.start || null,
    bookingEnd: booking.end || null,
    travelStart: travel.start || null,
    travelEnd: travel.end || null,
    badges: normalizeBadges(badges),
  };
  const prefix = `[${seller}]`;
  const title = titleText.startsWith(prefix) ? titleText : `${prefix} ${titleText}`;
  return {
    title,
    url: safeUrl.href,
    publishedAt: deal.bookingStart,
    publisher: seller,
    summary: makeSummary(deal),
    deal,
  };
}

function isChallengePage(html) {
  const sample = String(html ?? '').slice(0, 50000).toLowerCase();
  return /captcha|cf_chl_|cdn-cgi\/challenge-platform|just a moment|verify you are human|checking your browser|access denied|automated access|robot check/.test(sample)
    || /\uC790\uB3D9\uC785\uB825 \uBC29\uC9C0|\uBE44\uC815\uC0C1\uC801\uC778 \uC811\uADFC|\uBCF4\uC548 \uD655\uC778/i.test(sample);
}

function extractJsonScripts(html) {
  const found = [];
  for (const match of String(html ?? '').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = match[1];
    const body = match[2].trim();
    const isState = /\bid\s*=\s*["'](?:__NEXT_DATA__|__NUXT__|__INITIAL_STATE__|__NUXT_DATA__)["']/i.test(attrs);
    const isJson = /\btype\s*=\s*["']application\/(?:ld\+)?json["']/i.test(attrs);
    if (!isState && !isJson) continue;
    try { found.push(JSON.parse(body)); } catch { /* Non-JSON scripts are not treated as data. */ }
  }
  return found;
}

function firstDeepString(value, keyPattern, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 12) return null;
  for (const [key, child] of Object.entries(value)) {
    if (keyPattern.test(key) && isUsableText(child)) return child;
  }
  for (const child of Object.values(value)) {
    const found = firstDeepString(child, keyPattern, depth + 1);
    if (found) return found;
  }
  return null;
}

function collectModeTourRows(value, out = [], seen = new WeakSet(), depth = 0) {
  if (!value || typeof value !== 'object' || depth > 20 || seen.has(value)) return out;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const row of value) {
      if (!isRecord(row)) continue;
      const title = row.specialExhibitionTitle || row.specialExhibitionUserDefineTitle;
      const link = firstDeepString(row, /^(?:contentMappingLinkUrl|specialExhibitionUserDefineUrl|detailUrl)$/i);
      if (typeof title === 'string' && title.trim() && link) out.push(row);
    }
    for (const row of value) collectModeTourRows(row, out, seen, depth + 1);
  } else {
    for (const child of Object.values(value)) collectModeTourRows(child, out, seen, depth + 1);
  }
  return out;
}

function parseModeTour(html, now) {
  const scripts = extractJsonScripts(html);
  const rows = [];
  const seenLinks = new Set();
  for (const data of scripts) {
    for (const row of collectModeTourRows(data)) {
      const rawUrl = firstDeepString(row, /^(?:contentMappingLinkUrl|specialExhibitionUserDefineUrl|detailUrl)$/i);
      if (!rawUrl || seenLinks.has(rawUrl)) continue;
      seenLinks.add(rawUrl);
      rows.push(row);
    }
  }
  const items = rows.map(row => {
    const title = isUsableText(row.specialExhibitionUserDefineTitle)
      ? row.specialExhibitionUserDefineTitle
      : row.specialExhibitionTitle;
    const rawUrl = firstDeepString(row, /^(?:contentMappingLinkUrl|specialExhibitionUserDefineUrl|detailUrl)$/i);
    const booking = periodFrom(firstDeepValue(row, /^salePeriod$/i), now);
    const travel = periodFrom(firstDeepValue(row, /^(?:travelPeriod|travelDate|travelDates)$/i), now);
    const priceValue = firstDeepValue(row, /^(?:lowestPrice|priceFrom|minimumPrice|adtPrice)$/i);
    const priceText = firstDeepValue(row, /^(?:priceText|lowestPriceText)$/i);
    const categories = firstDeepArray(row, /^specialExhibitionCategorys?$/i);
    const category = categories.map(entry => isRecord(entry) ? entry.categoryName : entry).find(value => typeof value === 'string' && value.trim());
    const badgeValues = [
      ...collectStrings(firstDeepArray(row, /^(?:badges|hashtags|specialExhibitionUserDefineTag)$/i)),
    ];
    return makeItem({ seller: SITES.modetour.seller, rawTitle: title, rawUrl,
      baseUrl: SITES.modetour.url, allowedHosts: SITES.modetour.allowedHosts,
      destination: category, priceValue, priceText, booking, travel, badges: badgeValues, now });
  }).filter(Boolean);
  return { items, observedItems: rows.length, dataSource: rows.length ? 'embedded_json' : null };
}

function canonicalYbUrl(rawUrl) {
  const url = cleanHttpsUrl(rawUrl, SITES.ybtour.url, SITES.ybtour.allowedHosts);
  if (!url || url.hostname !== 'pkg.ybtour.co.kr' || url.pathname !== '/promotion/promotionDetail.yb') return null;
  const mstNo = url.searchParams.get('mstNo');
  if (!/^\d+$/.test(mstNo || '')) return null;
  url.search = '';
  url.searchParams.set('mstNo', mstNo);
  return url.href;
}

function parseYbTour(html, now) {
  const itemsByUrl = new Map();
  let observedItems = 0;
  for (const match of String(html ?? '').matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = readAttribute(match[1], 'href');
    if (!/promotionDetail\.yb/i.test(href)) continue;
    observedItems++;
    const url = canonicalYbUrl(href);
    const title = cleanText(match[2]);
    if (!url || !title || /@(?:webLinkUrl|goodsNm|imageThumb|startYm)/i.test(title)) continue;
    const visibleText = cleanText(match[0]);
    const booking = labeledPeriod(visibleText, ['예약', '판매'], now);
    const travel = labeledPeriod(visibleText, ['여행', '출발'], now);
    const price = parseExplicitPrice(null, visibleText);
    const badges = [...match[2].matchAll(/<[^>]*class=["'][^"']*\bbadge\b[^"']*["'][^>]*>([\s\S]*?)<\//gi)]
      .map(badge => cleanText(badge[1]));
    const item = makeItem({ seller: SITES.ybtour.seller, rawTitle: title, rawUrl: url,
      baseUrl: SITES.ybtour.url, allowedHosts: SITES.ybtour.allowedHosts,
      destination: null, priceValue: price.priceFrom, priceText: price.priceText,
      booking, travel, badges, now });
    if (item) itemsByUrl.set(item.url, item);
  }
  const items = [...itemsByUrl.values()];
  return { items, observedItems, dataSource: observedItems ? 'html' : null };
}

function divBlocksByClass(html, className) {
  const starts = [];
  for (const match of String(html ?? '').matchAll(/<div\b[^>]*>/gi)) {
    if (readAttribute(match[0], 'class').split(/\s+/).includes(className)) starts.push({ index: match.index, tag: match[0] });
  }
  return starts.map((entry, index) => ({
    ...entry,
    html: String(html).slice(entry.index, starts[index + 1]?.index ?? String(html).length),
  }));
}

function dateFromMarkup(value, now) {
  const match = String(value ?? '').match(new RegExp(DATE_TOKEN, 'u'));
  return match ? parseKoreanDate(match[0], now) : null;
}

function parseVerygoodTour(html, now) {
  const blocks = divBlocksByClass(html, 'right_body_div');
  const items = [];
  for (const { html: block } of blocks) {
    const title = cleanText(contentByClass(block, 'span', 'title'));
    const favoriteTag = openingTag(block.match(/<span\b[^>]*class=["'][^"']*\bfav\b[^"']*["'][^>]*>/i)?.[0]);
    const productCodeTag = openingTag(block.match(/<div\b[^>]*class=["'][^"']*\bright_prod_div\b[^"']*["'][^>]*>/i)?.[0]);
    const productCode = readAttribute(productCodeTag, 'data-code');
    const masterCode = block.match(/PackageDetail\?masterCode=([A-Za-z0-9-]+)/i)?.[1];
    const detailUrl = masterCode
      ? `/Product/PackageDetail?masterCode=${masterCode}`
      : productCode ? `/Product/PackageDetail?ProCode=${encodeURIComponent(productCode)}` : null;
    const region = readAttribute(favoriteTag, 'data-region');
    const priceValue = readAttribute(favoriteTag, 'data-price');
    const displayedPrice = cleanText(contentByClass(block, 'span', 'price'));
    const priceText = displayedPrice ? `${displayedPrice}원~` : null;
    const eventBadge = [...block.matchAll(/<span\b[^>]*class=["'][^"']*\bevent_badge\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi)]
      .map(badge => cleanText(badge[1]));
    const dateDescription = block.match(/<span\b[^>]*\bdesc=["'][^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] || '';
    const travelStart = dateFromMarkup(cleanText(dateDescription), now);
    const bookingText = /(?:예약기간|판매기간)[^<]{0,100}/.exec(block)?.[0] || '';
    const booking = parseKoreanDateRange(bookingText, now);
    const item = makeItem({ seller: SITES.verygoodtour.seller, rawTitle: title,
      rawUrl: detailUrl, baseUrl: SITES.verygoodtour.url,
      allowedHosts: SITES.verygoodtour.allowedHosts, destination: region,
      priceValue, priceText, booking, travel: { start: travelStart, end: null },
      badges: eventBadge, now });
    if (item) items.push(item);
  }
  return { items, observedItems: blocks.length, dataSource: blocks.length ? 'html' : null };
}

function parseGenericEmbeddedRows(html, siteKey, now) {
  const data = extractJsonScripts(html);
  const rows = [];
  function visit(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 16) return;
    if (Array.isArray(value)) {
      for (const child of value) {
        if (!isRecord(child)) continue;
        const title = firstDeepString(child, /^(?:title|name|subject|promotionTitle|dealTitle)$/i);
        const url = firstDeepString(child, /^(?:url|href|link|linkUrl|detailUrl|promotionUrl)$/i);
        if (title && url && /(?:promotion|deal|event|special|plan|promo)/i.test(url)) rows.push({ row: child, title, url });
        visit(child, depth + 1);
      }
    } else for (const child of Object.values(value)) visit(child, depth + 1);
  }
  for (const value of data) visit(value);
  const config = SITES[siteKey];
  const seen = new Set();
  const items = [];
  for (const { row, title, url } of rows) {
    if (seen.has(url)) continue;
    seen.add(url);
    const booking = periodFrom(firstDeepValue(row, /^(?:salePeriod|bookingPeriod|reservationPeriod)$/i), now);
    const travel = periodFrom(firstDeepValue(row, /^(?:travelPeriod|travelDate|tripPeriod)$/i), now);
    const priceValue = firstDeepValue(row, /^(?:lowestPrice|priceFrom|minimumPrice|adtPrice)$/i);
    const priceText = firstDeepValue(row, /^(?:priceText|lowestPriceText)$/i);
    const item = makeItem({ seller: config.seller, rawTitle: title, rawUrl: url,
      baseUrl: config.url, allowedHosts: config.allowedHosts,
      destination: firstDeepString(row, /^(?:destination|destinationName|areaName|categoryName)$/i),
      priceValue, priceText, booking, travel,
      badges: collectStrings(firstDeepArray(row, /^(?:badges|tags|hashtags)$/i)), now });
    if (item) items.push(item);
  }
  return { items, observedItems: rows.length, dataSource: rows.length ? 'embedded_json' : null };
}

// strtDepDay/endDepDay=YYYYMMDD in a product anchor give its departure window.
function hanatourDepartures(anchorUrl) {
  const query = String(anchorUrl ?? '').split('?')[1] || '';
  const params = new URLSearchParams(query);
  const iso = value => /^\d{8}$/.test(value || '') ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}` : null;
  return { start: iso(params.get('strtDepDay')), end: iso(params.get('endDepDay')) };
}

function parseHanatourExhibit(data, now) {
  const rows = [];
  for (const container of data?.containers ?? []) for (const component of container?.components ?? []) {
    for (const content of component?.contents ?? []) for (const category of content?.categories ?? []) {
      for (const item of category?.items ?? []) rows.push({ component: component.frontComponentName, item });
    }
  }
  const items = rows.map(({ component, item }) => {
    const info = item?.displayInfo || {};
    const priceValue = item?.price?.afterDiscount ?? item?.price?.origin ?? null;
    if (!isUsableText(info.title) || !item?.anchor?.url) return null;
    return makeItem({ seller: SITES.hanatour.seller, rawTitle: info.title, rawUrl: item.anchor.url,
      baseUrl: SITES.hanatour.linkBase, allowedHosts: SITES.hanatour.allowedHosts,
      destination: null, priceValue, priceText: null, travel: hanatourDepartures(item.anchor.url),
      badges: [info.subtitle, info.description, component].filter(isUsableText), now });
  }).filter(Boolean);
  return { items, observedItems: rows.length, dataSource: 'json_endpoint' };
}

function parseHanatour(html, now) {
  let json = null;
  try { json = JSON.parse(html); } catch { /* not the gateway JSON; fall back to HTML parsing */ }
  if (json?.data?.containers) return parseHanatourExhibit(json.data, now);
  const embedded = parseGenericEmbeddedRows(html, 'hanatour', now);
  if (embedded.items.length) return embedded;
  const rows = [];
  for (const match of String(html ?? '').matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = readAttribute(match[1], 'href');
    if (!/(?:promotion|deal|hot[-_/]?deal|special|plan)/i.test(href)) continue;
    const title = cleanText(match[2]);
    if (!title || /^#|^javascript:/i.test(href)) continue;
    rows.push({ href, title, attrs: match[1], body: match[2] });
  }
  const items = rows.map(row => {
    const visible = cleanText(row.body);
    const booking = labeledPeriod(visible, ['예약', '판매'], now);
    const travel = labeledPeriod(visible, ['여행', '출발'], now);
    const price = parseExplicitPrice(null, visible);
    return makeItem({ seller: SITES.hanatour.seller, rawTitle: row.title, rawUrl: row.href,
      baseUrl: SITES.hanatour.url, allowedHosts: SITES.hanatour.allowedHosts,
      destination: null, priceValue: price.priceFrom, priceText: price.priceText,
      booking, travel, badges: [], now });
  }).filter(Boolean);
  return { items, observedItems: rows.length, dataSource: rows.length ? 'html' : null };
}

function parseSitePage(siteKey, html, now) {
  if (siteKey === 'modetour') return parseModeTour(html, now);
  if (siteKey === 'ybtour') return parseYbTour(html, now);
  if (siteKey === 'verygoodtour') return parseVerygoodTour(html, now);
  return parseHanatour(html, now);
}

function errorReason(error) {
  if (typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)) return error.code;
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'FETCH_TIMEOUT';
  return 'FETCH_FAILED';
}

async function fetchPage(url, config, fetchImpl) {
  let httpStatus = null;
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      // Same browser UA + Korean locale as the repo's other collectors; without them some sites (Trip.com)
      // serve a reduced page with no listings (observed 2026-09-24).
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36', 'accept-language': 'ko-KR,ko;q=0.9', accept: config.accept || 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      credentials: 'omit',
      signal: AbortSignal.timeout(15000),
    });
    httpStatus = Number.isInteger(response?.status) ? response.status : null;
    if (!httpStatus) return { httpStatus: null, html: '', skipped: 'HTTP_STATUS_INVALID' };
    if (httpStatus !== 200) return { httpStatus, html: '', skipped: `HTTP_${httpStatus}` };

    const finalUrl = response.url || url;
    const checkedFinalUrl = cleanHttpsUrl(finalUrl, url, config.allowedHosts);
    if (!checkedFinalUrl) return { httpStatus, html: '', skipped: 'UNEXPECTED_REDIRECT' };
    const contentLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_SOURCE_BYTES) {
      return { httpStatus, html: '', skipped: 'SOURCE_TOO_LARGE' };
    }
    const html = await response.text();
    if (Buffer.byteLength(html) > MAX_SOURCE_BYTES) return { httpStatus, html: '', skipped: 'SOURCE_TOO_LARGE' };
    if (isChallengePage(html)) return { httpStatus, html: '', skipped: 'CHALLENGE_PAGE' };
    return { httpStatus, html, skipped: null };
  } catch (error) {
    return { httpStatus, html: '', skipped: errorReason(error) };
  }
}

function seoulToday(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

async function collectSite(siteKey, fetchImpl, now) {
  const config = SITES[siteKey];
  const urls = config.urls || [config.url];
  const candidates = [];
  let primaryStatus = null;
  let dataSource = null;
  let observedItems = 0;
  let skipped = null;

  for (const [index, url] of urls.entries()) {
    const response = await fetchPage(url, config, fetchImpl);
    if (index === 0) primaryStatus = response.httpStatus;
    if (response.skipped) {
      skipped = response.skipped;
      break;
    }
    try {
      const parsed = parseSitePage(siteKey, response.html, now);
      observedItems += parsed.observedItems;
      if (!dataSource && parsed.dataSource) dataSource = parsed.dataSource;
      candidates.push(...parsed.items);
    } catch {
      skipped = 'PARSE_FAILED';
      break;
    }
  }

  const byUrl = new Map();
  for (const item of candidates) if (!byUrl.has(item.url)) byUrl.set(item.url, item);
  const uniqueItems = [...byUrl.values()];
  const today = seoulToday(now);
  const items = uniqueItems.filter(item => !item.deal.bookingEnd || item.deal.bookingEnd >= today);
  const skippedEnded = uniqueItems.length - items.length;
  const parsedCount = uniqueItems.length;
  if (!skipped && parsedCount === 0 && skippedEnded === 0) skipped = 'NO_PUBLIC_DEAL_DATA';

  return {
    items,
    receipt: {
      site: siteKey,
      sourceUrl: config.url,
      httpStatus: primaryStatus,
      dataSource,
      observedItems,
      parsed: parsedCount,
      skippedEnded,
      skipped,
    },
  };
}

export async function fetchAgencyDeals(limit, {
  fetchImpl = globalThis.fetch,
  sites = Object.keys(SITES),
  now = new Date(),
} = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('SOURCE_LIMIT');
  if (typeof fetchImpl !== 'function') throw new Error('FETCH_IMPL');
  if (!Array.isArray(sites)) throw new Error('SITES');
  const selected = [...new Set(sites)];
  for (const site of selected) if (!Object.hasOwn(SITES, site)) throw new Error('SITE');
  const checkedNow = validNow(now);

  const results = await Promise.all(selected.map(site => collectSite(site, fetchImpl, checkedNow)));
  const seen = new Set();
  const items = [];
  for (let offset = 0; items.length < limit; offset++) {
    let hasCandidate = false;
    for (const result of results) {
      const item = result.items[offset];
      if (!item) continue;
      hasCandidate = true;
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      items.push(item);
      if (items.length >= limit) break;
    }
    if (!hasCandidate) break;
  }
  return {
    items,
    receipt: {
      perSite: results.map(result => result.receipt),
      browserUsed: false,
    },
  };
}
