const ASIANA_URL = 'https://flyasiana.com/C/KR/KO/event/list';
const TRINITY_URL = 'https://www.trinityairways.com/app/promotion/event/being';
const PEACH_URL = 'https://www.flypeach.com/kr/um/specials/sale/sale';
const JEJUAIR_URL = 'https://www.jejuair.net/ko/event/pastEvent.do';
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const DATE_TOKEN = '(?:\\d{4}\\s*[./-]\\s*\\d{1,2}\\s*[./-]\\s*\\d{1,2}|\\d{1,2}\\s*[./-]\\s*\\d{1,2}(?:\\s*\\([^)]{1,8}\\))?)';

function makeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function decodeHtml(value) {
  return String(value ?? '')
    .replace(/&nbsp;|&#160;|&#xA0;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_match, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([\da-f]+);/gi, (_match, number) => String.fromCodePoint(parseInt(number, 16)));
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

function readAttribute(openingTag, name) {
  const pattern = new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\\x27([^\\x27]*)\\x27|([^\\s>]+))', 'i');
  const match = String(openingTag ?? '').match(pattern);
  return match ? decodeHtml(match[1] ?? match[2] ?? match[3] ?? '') : '';
}

function contentByClass(html, tagName, className) {
  const source = String(html ?? '');
  const pattern = new RegExp('<' + tagName + '\\b[^>]*>', 'gi');
  for (const match of source.matchAll(pattern)) {
    const opening = match[0];
    if (!readAttribute(opening, 'class').split(/\s+/).includes(className)) continue;
    const contentStart = match.index + opening.length;
    const closing = new RegExp('<\\/' + tagName + '\\s*>', 'i').exec(source.slice(contentStart));
    if (closing) return source.slice(contentStart, contentStart + closing.index);
  }
  return '';
}

function openingTag(element) {
  return String(element ?? '').match(/^<[^>]+>/)?.[0] ?? '';
}

function resolveHttps(rawUrl, baseUrl) {
  try {
    const url = new URL(rawUrl, baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function seoulParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

function validIsoDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null;
  return String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}

function parseDateToken(value, defaultYear) {
  const token = String(value ?? '').replace(/\([^)]*\)/g, '').trim();
  const full = token.match(/^(\d{4})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,2})$/);
  if (full) {
    const year = Number(full[1]);
    const month = Number(full[2]);
    const day = Number(full[3]);
    return { year, month, day, explicitYear: true, iso: validIsoDate(year, month, day) };
  }
  const short = token.match(/^(\d{1,2})\s*[./-]\s*(\d{1,2})$/);
  if (!short) return null;
  const month = Number(short[1]);
  const day = Number(short[2]);
  return { year: defaultYear, month, day, explicitYear: false, iso: validIsoDate(defaultYear, month, day) };
}

export function parseKoreanDateRange(value, now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) return { start: null, end: null };
  const year = Number(seoulParts(date).year);
  const normalized = cleanText(value).replace(/[～〜∼–—]/g, '~');
  const match = normalized.match(new RegExp('(' + DATE_TOKEN + ')\\s*~\\s*(' + DATE_TOKEN + ')?', 'u'));
  if (!match) return { start: null, end: null };

  let start = parseDateToken(match[1], year);
  let end = match[2] ? parseDateToken(match[2], year) : null;
  if (!start) return { start: null, end: null };

  if (!start.explicitYear && end?.explicitYear) {
    start.year = end.year - (end.month < start.month ? 1 : 0);
    start.iso = validIsoDate(start.year, start.month, start.day);
  }
  if (end && !end.explicitYear) {
    end.year = start.year + (end.month < start.month ? 1 : 0);
    end.iso = validIsoDate(end.year, end.month, end.day);
  }

  return { start: start.iso, end: end?.iso ?? null };
}

function findLabeledDateRange(value, now) {
  const text = cleanText(value);
  const label = /(?:탑승|여행|운항)\s*(?:기간|일정)|travel\s*(?:period|dates)?/iu.exec(text);
  return label
    ? parseKoreanDateRange(text.slice(label.index, label.index + 180), now)
    : { start: null, end: null };
}

function formatKoreanDate(value) {
  return value ? value.replace(/-/g, '.') : '미표기';
}

function extractRoutes(value) {
  const text = cleanText(value);
  const routes = new Set();
  for (const match of text.matchAll(/\b([A-Z]{3})\s*[-–—~→]\s*([A-Z]{3})\b/g)) {
    routes.add(match[1] + '-' + match[2]);
  }
  for (const match of text.matchAll(/\b([A-Z]{3})([A-Z]{3})\b/g)) {
    routes.add(match[1] + '-' + match[2]);
  }
  return [...routes];
}

function makePromo(config, { title, url, purchaseText, sourceText, now }) {
  const safeUrl = resolveHttps(url, config.url);
  const cleanTitle = cleanText(title);
  if (!safeUrl || !cleanTitle) return null;

  const purchase = parseKoreanDateRange(purchaseText, now);
  const travel = findLabeledDateRange(sourceText, now);
  const routes = extractRoutes(cleanTitle + ' ' + sourceText);
  const periodText = (label, start, end) => !start && !end
    ? label + ' 미표기'
    : label + ' ' + formatKoreanDate(start) + '~' + formatKoreanDate(end);
  const routeText = routes.length ? ' / 노선 ' + routes.join(', ') : '';

  return {
    title: '[' + config.name + '] ' + cleanTitle,
    url: safeUrl,
    publishedAt: purchase.start,
    publisher: config.name,
    summary: periodText('구매 기간', purchase.start, purchase.end)
      + ' / ' + periodText('탑승 기간', travel.start, travel.end) + routeText,
    deal: {
      airline: config.name,
      purchaseStart: purchase.start,
      purchaseEnd: purchase.end,
      travelStart: travel.start,
      travelEnd: travel.end,
      routes,
    },
  };
}

function parseAsiana(html, now) {
  const entries = new Map();
  for (const listItem of html.matchAll(/<li\b[^>]*>[\s\S]*?<\/li>/gi)) {
    const anchors = listItem[0].match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? [];
    for (const anchor of anchors) {
      const opening = openingTag(anchor);
      if (!/\binner_box\b/i.test(readAttribute(opening, 'class'))) continue;
      const href = readAttribute(opening, 'href');
      if (!/(?:\/event\/detail\/|(?:^|\/)detail\/)/i.test(href)) continue;
      const title = contentByClass(anchor, 'em', 'title');
      const purchaseText = contentByClass(anchor, 'span', 'date');
      const url = resolveHttps(href, ASIANA_URL);
      if (!url || entries.has(url)) continue;
      const item = makePromo(AIRLINE_CONFIG.asiana, {
        title,
        url,
        purchaseText,
        sourceText: cleanText(anchor),
        now,
      });
      if (item) entries.set(url, item);
    }
  }
  return [...entries.values()];
}

function parseTrinity(html, now) {
  const entries = new Map();
  for (const match of html.matchAll(/<a\b[^>]*data-eventSeq=["'][^"']+["'][^>]*>[\s\S]*?<\/a>/gi)) {
    const anchor = match[0];
    const opening = openingTag(anchor);
    const title = readAttribute(opening, 'data-eventTitle');
    const addInfo = readAttribute(opening, 'data-addInfo');
    if (!title || !addInfo) continue;

    // This is the public link generated by showEventContent() in the event list page.
    const token = addInfo.replace(/\+/g, '-').replace(/\//g, '_');
    const url = resolveHttps('/app/promotion/event/retrieve/' + token + '/being/n', TRINITY_URL);
    if (!url || entries.has(url)) continue;
    const item = makePromo(AIRLINE_CONFIG.trinity, {
      title,
      url,
      purchaseText: cleanText(anchor),
      sourceText: cleanText(anchor),
      now,
    });
    if (item) entries.set(url, item);
  }
  return [...entries.values()];
}

function parseJejuAir(html, now) {
  const entries = new Map();
  for (const match of html.matchAll(/<a\b[^>]*href=["'][^"']*eventDetail\.do\?eventNo=[^"']+["'][^>]*>[\s\S]*?<\/a>/gi)) {
    const anchor = match[0];
    const opening = openingTag(anchor);
    const href = readAttribute(opening, 'href');
    const url = resolveHttps(href, JEJUAIR_URL);
    if (!url || entries.has(url)) continue;
    const title = contentByClass(anchor, 'p', 'event-banner__title')
      || contentByClass(anchor, 'p', 'search-result__text-large');
    const purchaseText = contentByClass(anchor, 'span', 'date');
    const item = makePromo(AIRLINE_CONFIG.jejuair, {
      title,
      url,
      purchaseText,
      sourceText: cleanText(anchor),
      now,
    });
    if (item) entries.set(url, item);
  }
  return [...entries.values()];
}

function parsePeach(_html, { finalUrl }) {
  let finalPath = '';
  try { finalPath = new URL(finalUrl).pathname; } catch { /* handled as an unrecognized response below */ }
  if (finalPath !== '/kr/um/specials/sale/sale') throw makeError('UNEXPECTED_PAGE');
  throw makeError('UNVERIFIED_LAYOUT');
}

function isChallengePage(html) {
  const sample = String(html ?? '').slice(0, 30000).toLowerCase();
  return /cf_chl_|cdn-cgi\/challenge-platform|just a moment|verify you are human|checking your browser|access denied|captcha verification/.test(sample);
}

function errorCode(error) {
  if (typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)) return error.code;
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'FETCH_TIMEOUT';
  return 'FETCH_FAILED';
}

function makeFetcher(config, parser) {
  return async ({ fetchImpl = globalThis.fetch, now = new Date() } = {}) => {
    let httpStatus = null;
    try {
      const response = await fetchImpl(config.url, {
        headers: { accept: 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(15000),
      });
      httpStatus = Number.isInteger(response?.status) ? response.status : null;
      if (httpStatus !== 200) {
        return { httpStatus, rows: [], observedItems: 0, error: httpStatus ? 'HTTP_' + httpStatus : 'HTTP_STATUS_INVALID' };
      }

      const contentLength = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(contentLength) && contentLength > MAX_SOURCE_BYTES) {
        return { httpStatus, rows: [], observedItems: 0, error: 'SOURCE_TOO_LARGE' };
      }
      const html = await response.text();
      if (Buffer.byteLength(html) > MAX_SOURCE_BYTES) {
        return { httpStatus, rows: [], observedItems: 0, error: 'SOURCE_TOO_LARGE' };
      }
      if (isChallengePage(html)) {
        return { httpStatus, rows: [], observedItems: 0, error: 'CHALLENGE_PAGE' };
      }

      const finalUrl = response.url || config.url;
      const rows = parser(html, { finalUrl, now });
      return { httpStatus, rows, observedItems: rows.length, error: null };
    } catch (error) {
      return { httpStatus, rows: [], observedItems: 0, error: errorCode(error) };
    }
  };
}

const AIRLINE_CONFIG = {
  asiana: { name: '아시아나항공', url: ASIANA_URL },
  trinity: { name: '트리니티항공', url: TRINITY_URL },
  peach: { name: '피치항공', url: PEACH_URL },
  jejuair: { name: '제주항공', url: JEJUAIR_URL },
};

export const AIRLINES = Object.freeze({
  asiana: Object.freeze({ ...AIRLINE_CONFIG.asiana, fetcher: makeFetcher(AIRLINE_CONFIG.asiana, (html, context) => parseAsiana(html, context.now)) }),
  trinity: Object.freeze({ ...AIRLINE_CONFIG.trinity, fetcher: makeFetcher(AIRLINE_CONFIG.trinity, (html, context) => parseTrinity(html, context.now)) }),
  peach: Object.freeze({ ...AIRLINE_CONFIG.peach, fetcher: makeFetcher(AIRLINE_CONFIG.peach, parsePeach) }),
  jejuair: Object.freeze({ ...AIRLINE_CONFIG.jejuair, fetcher: makeFetcher(AIRLINE_CONFIG.jejuair, (html, context) => parseJejuAir(html, context.now)) }),
});

function endedBeforeNow(item, now) {
  const end = item.deal.purchaseEnd;
  if (!end) return false;
  const parts = seoulParts(now);
  const today = parts.year + '-' + parts.month + '-' + parts.day;
  return end < today;
}

export async function fetchAirlinePromos(
  limit,
  { fetchImpl = globalThis.fetch, airlines = Object.keys(AIRLINES), now = new Date() } = {},
) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('SOURCE_LIMIT');
  if (typeof fetchImpl !== 'function') throw new Error('FETCH_IMPL');
  if (!Array.isArray(airlines)) throw new Error('AIRLINES');
  const selected = [...new Set(airlines)];
  for (const key of selected) if (!Object.hasOwn(AIRLINES, key)) throw new Error('AIRLINE');
  const checkedAt = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(checkedAt.getTime())) throw new Error('NOW');

  const results = await Promise.all(selected.map(async key => {
    const config = AIRLINES[key];
    const fetched = await config.fetcher({ fetchImpl, now: checkedAt });
    const rows = fetched.rows ?? [];
    const items = rows.filter(item => !endedBeforeNow(item, checkedAt));
    return {
      items,
      receipt: {
        airline: config.name,
        httpStatus: fetched.httpStatus,
        observedItems: fetched.observedItems ?? rows.length,
        parsed: rows.length,
        skippedEnded: rows.length - items.length,
        error: fetched.error ?? null,
      },
    };
  }));

  return {
    items: results.flatMap(result => result.items).slice(0, limit),
    receipt: {
      perAirline: results.map(result => result.receipt),
      browserUsed: false,
    },
  };
}
