const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15000;

export const SITES = Object.freeze({
  tripcom: Object.freeze({ seller: '트립닷컴', sourceUrl: 'https://kr.trip.com/sale/deals/?locale=ko-KR&curr=KRW' }),
  yeogi: Object.freeze({ seller: '여기어때', sourceUrl: 'https://www.yeogi.com/' }),
  nol: Object.freeze({ seller: 'NOL', sourceUrl: 'https://www.yanolja.com/' }),
  // www.ttang.com/ is a meta-refresh shell; index.do only links out. The data sits in two server-rendered
  // table pages (verified 2026-09-24): last-minute airfares and urgent (긴급특가) package lists.
  ttang: Object.freeze({ seller: '땡처리닷컴', sourceUrl: 'https://www.ttang.com/ttangair/search/ttang/list.do?arr0=A2ALL',
    urgentUrls: ['C001', 'C003', 'C005'].map(code => `https://www.ttang.com/product/pkg/themeList.do?themeKind=URGENT&majorCategoryCd=${code}`) }),
  myrealtrip: Object.freeze({ seller: '마이리얼트립', sourceUrl: 'https://www.myrealtrip.com/' }),
  agoda: Object.freeze({ seller: 'Agoda', sourceUrl: 'https://www.agoda.com/ko-kr/' }),
});

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decodeHtml(value) {
  return String(value ?? '')
    .replace(/&nbsp;|&#160;|&#xA0;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_match, number) => {
      const codePoint = Number(number);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '\uFFFD';
    })
    .replace(/&#x([\da-f]+);/gi, (_match, number) => {
      const codePoint = Number.parseInt(number, 16);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '\uFFFD';
    });
}

function cleanText(value) {
  return decodeHtml(String(value ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(?:script|style)\b[\s\S]*?<\/(?:script|style)\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function readAttribute(tag, name) {
  const match = String(tag ?? '').match(new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\\x27([^\\x27]*)\\x27|([^\\s>]+))', 'i'));
  return match ? decodeHtml(match[1] ?? match[2] ?? match[3] ?? '') : '';
}

function htmlScripts(html) {
  return [...String(html ?? '').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .map(match => ({ attributes: match[1], content: match[2] }));
}

function nextData(html) {
  const script = htmlScripts(html).find(({ attributes }) => readAttribute(attributes, 'id') === '__NEXT_DATA__');
  if (!script) return null;
  try { return JSON.parse(script.content); }
  catch { throw fail('EMBEDDED_JSON_INVALID'); }
}

function safeHttpsUrl(rawUrl, baseUrl, allowedHost) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  try {
    const url = new URL(rawUrl, baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (allowedHost && !allowedHost(url.hostname.toLowerCase())) return null;
    return url.href;
  } catch { return null; }
}

function isTripComHost(host) {
  return host === 'trip.com' || host.endsWith('.trip.com');
}

function isYeogiHost(host) {
  return host === 'yeogi.com' || host.endsWith('.yeogi.com');
}

function isNolHost(host) {
  return host === 'nol.yanolja.com';
}

function isTtangHost(host) {
  return host === 'ttang.com' || host.endsWith('.ttang.com');
}

function isMyrealtripHost(host) {
  return host === 'myrealtrip.com' || host.endsWith('.myrealtrip.com');
}

function seoulYear(now) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', year: 'numeric' }).format(now));
}

function isoDay(year, month, day) {
  if (![year, month, day].every(Number.isInteger)) return null;
  const value = new Date(Date.UTC(year, month - 1, day));
  if (value.getUTCFullYear() !== year || value.getUTCMonth() + 1 !== month || value.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function parseKoreanDate(value, now = new Date()) {
  if (value === null || value === undefined || value === '') return null;
  const current = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(current.getTime())) return null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime())
      ? `${String(value.getUTCFullYear()).padStart(4, '0')}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`
      : null;
  }
  if (typeof value === 'number') {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? parseKoreanDate(date, now) : null;
  }

  const text = String(value).trim();
  const full = text.match(/^(\d{4})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,2})(?:[T\s].*)?$/u);
  if (full) return isoDay(Number(full[1]), Number(full[2]), Number(full[3]));
  const year = seoulYear(current);
  const korean = text.match(/^(\d{1,2})\s*월\s*(\d{1,2})\s*일(?:\s*\([^)]*\))?$/u);
  if (korean) return isoDay(year, Number(korean[1]), Number(korean[2]));
  const short = text.match(/^(\d{1,2})\s*[./-]\s*(\d{1,2})(?:\s*\([^)]*\))?$/u);
  return short ? isoDay(year, Number(short[1]), Number(short[2])) : null;
}

function pick(record, keys) {
  for (const key of keys) {
    const value = record?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function parsePrice(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  const match = value.replace(/\s+/g, '').match(/(\d[\d,]*)\s*원/u);
  if (!match) return null;
  const amount = Number(match[1].replace(/,/g, ''));
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : null;
}

function textValue(value) {
  if (typeof value === 'string') return cleanText(value) || null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function priceLabel(record) {
  const value = pick(record, ['priceText', 'displayPrice', 'priceLabel', 'priceFromText', 'lowestPriceText', 'minPriceText', 'discountText']);
  if (typeof value === 'string') {
    const label = cleanText(value);
    return parsePrice(label) === null ? null : label;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return `${value.toLocaleString('en-US')}원`;
  const numeric = pick(record, ['priceFrom', 'lowestPrice', 'minPrice', 'couponAppliedPrice', 'salePrice', 'price']);
  return typeof numeric === 'number' && Number.isFinite(numeric) ? `${numeric.toLocaleString('en-US')}원` : null;
}

function tagTexts(value) {
  if (!Array.isArray(value)) return [];
  return value.map(tag => typeof tag === 'string'
    ? cleanText(tag)
    : isRecord(tag) ? textValue(pick(tag, ['text', 'title', 'label', 'name'])) : null)
    .filter(Boolean);
}

function formatPeriod(start, end) {
  if (!start && !end) return '미정';
  return `${start ? start.replace(/-/g, '.') : '미정'}~${end ? end.replace(/-/g, '.') : '미정'}`;
}

function buildItem({ site, title, url, record = {}, now, fields = {} }) {
  const config = SITES[site];
  const cleanTitle = cleanText(title).slice(0, 300);
  if (!cleanTitle || !url) return null;
  const seller = config.seller;
  const bookingStart = parseKoreanDate(fields.bookingStart ?? pick(record, ['bookingStart', 'bookingStartDate', 'saleStart', 'saleStartDate', 'startDate', 'promotionStartDate']), now);
  const bookingEnd = parseKoreanDate(fields.bookingEnd ?? pick(record, ['bookingEnd', 'bookingEndDate', 'saleEnd', 'saleEndDate', 'endDate', 'promotionEndDate']), now);
  const travelStart = parseKoreanDate(fields.travelStart ?? pick(record, ['travelStart', 'travelStartDate', 'stayStart', 'checkInDate']), now);
  const travelEnd = parseKoreanDate(fields.travelEnd ?? pick(record, ['travelEnd', 'travelEndDate', 'stayEnd', 'checkOutDate']), now);
  const destination = textValue(fields.destination ?? pick(record, ['destination', 'destinationName', 'cityName', 'city', 'regionName', 'countryName']));
  const priceText = textValue(fields.priceText ?? priceLabel(record));
  const priceFrom = fields.priceFrom !== undefined ? fields.priceFrom : parsePrice(priceText) ?? parsePrice(pick(record, ['priceFrom', 'lowestPrice', 'minPrice', 'couponAppliedPrice', 'salePrice', 'price']));
  const badges = [...new Set([...(fields.badges ?? tagTexts(pick(record, ['badges', 'tags', 'labels']))).map(cleanText).filter(Boolean)])].slice(0, 12);
  const summary = `여행지 ${destination || '미확인'} · 최저가 ${priceText || '미확인'} · 예약기간 ${formatPeriod(bookingStart, bookingEnd)} · 여행기간 ${formatPeriod(travelStart, travelEnd)}`;
  return {
    title: cleanTitle.startsWith(`[${seller}]`) ? cleanTitle : `[${seller}] ${cleanTitle}`,
    url,
    publishedAt: bookingStart,
    publisher: seller,
    summary,
    deal: { seller, destination, priceFrom: Number.isSafeInteger(priceFrom) && priceFrom >= 0 ? priceFrom : null,
      priceText, bookingStart, bookingEnd, travelStart, travelEnd, badges },
  };
}

function dateEnded(item, now) {
  const end = item.deal.bookingEnd;
  if (!end) return false;
  const todayParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const today = `${todayParts.find(part => part.type === 'year').value}-${todayParts.find(part => part.type === 'month').value}-${todayParts.find(part => part.type === 'day').value}`;
  return end < today;
}

function challengePage(html) {
  const sample = String(html ?? '').slice(0, 40000).toLowerCase();
  return /cf_chl_|__cf\$cv\$params|cdn-cgi\/challenge-platform|verify you are human|checking your browser|just a moment\.\.\.|captcha verification|access denied|pardon our interruption/.test(sample);
}

async function getPage(url, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      // Same browser UA + Korean locale as the repo's other collectors; without them some sites (Trip.com)
      // serve a reduced page with no listings (observed 2026-09-24).
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36', 'accept-language': 'ko-KR,ko;q=0.9', accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw fail(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'FETCH_TIMEOUT' : 'FETCH_FAILED');
  }
  const status = Number.isInteger(response?.status) ? response.status : null;
  if (status !== 200) throw Object.assign(fail(status ? `HTTP_${status}` : 'HTTP_STATUS_INVALID'), { httpStatus: status });
  let html;
  try { html = await response.text(); }
  catch { throw Object.assign(fail('FETCH_FAILED'), { httpStatus: status }); }
  if (Buffer.byteLength(html) > MAX_SOURCE_BYTES) throw Object.assign(fail('SOURCE_TOO_LARGE'), { httpStatus: status });
  if (challengePage(html)) throw Object.assign(fail('CHALLENGE_PAGE'), { httpStatus: status });
  return { html, response, status };
}

function metaRefreshUrl(html, baseUrl) {
  const tag = String(html).match(/<meta\b[^>]*http-equiv\s*=\s*(?:"refresh"|'refresh'|refresh)[^>]*>/i)?.[0];
  if (!tag) return null;
  const content = readAttribute(tag, 'content');
  const target = content.match(/(?:^|;)\s*\d+\s*;\s*url\s*=\s*["']?([^"']+?)["']?\s*$/i)?.[1]?.trim();
  if (!target) return null;
  try {
    const source = new URL(baseUrl);
    const destination = new URL(target, source);
    if (destination.protocol !== 'https:' || destination.hostname !== source.hostname || destination.username || destination.password) return null;
    return destination.href;
  } catch { return null; }
}

function parseTripcom(html, now) {
  const data = nextData(html);
  const ads = data?.props?.pageProps?.initialState?.adsData?.adsList;
  if (Array.isArray(ads)) {
    const items = ads.map(row => {
      if (!isRecord(row)) return null;
      const url = safeHttpsUrl(row.canonicalUrl ?? row.url, SITES.tripcom.sourceUrl, isTripComHost);
      return buildItem({ site: 'tripcom', title: row.title, url, record: row, now });
    }).filter(Boolean);
    return { observedItems: ads.length, items, dataSource: 'embedded_json', skipped: items.length ? null : 'NO_DEAL_LISTINGS' };
  }

  const anchors = [];
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    if (!readAttribute(match[1], 'class').split(/\s+/).includes('top-deals_link-item')) continue;
    const url = safeHttpsUrl(readAttribute(match[1], 'href'), SITES.tripcom.sourceUrl, isTripComHost);
    const titleNode = match[2].match(/<(?:strong|h[1-6]|span|div)\b[^>]*class\s*=\s*["'][^"']*(?:title|name)[^"']*["'][^>]*>([\s\S]*?)<\/(?:strong|h[1-6]|span|div)\s*>/i);
    const fullText = cleanText(match[2]);
    const title = titleNode ? cleanText(titleNode[1]) : fullText.split(/\s{2,}/)[0];
    const item = buildItem({ site: 'tripcom', title, url, record: {}, now });
    if (item) anchors.push(item);
  }
  return { observedItems: anchors.length, items: anchors, dataSource: anchors.length ? 'html' : null,
    skipped: anchors.length ? null : 'NO_DEAL_LISTINGS' };
}

function parseYeogi(html, now) {
  const data = nextData(html);
  const queries = data?.props?.pageProps?.dehydratedState?.queries;
  if (!Array.isArray(queries)) return { observedItems: 0, items: [], dataSource: data ? 'embedded_json' : null, skipped: 'NO_DEAL_LISTINGS' };
  const query = queries.find(row => Array.isArray(row?.queryKey) && row.queryKey[0] === 'web-home-event-banners');
  const promos = query?.state?.data?.content?.items;
  if (!Array.isArray(promos)) return { observedItems: 0, items: [], dataSource: 'embedded_json', skipped: 'NO_DEAL_LISTINGS' };
  const items = promos.map(row => {
    if (!isRecord(row)) return null;
    const url = safeHttpsUrl(row.scheme ?? row.linkUrl ?? row.url, SITES.yeogi.sourceUrl, isYeogiHost);
    return buildItem({ site: 'yeogi', title: row.title, url, record: row, now,
      fields: { bookingStart: row.startDate, bookingEnd: row.endDate } });
  }).filter(Boolean);
  return { observedItems: promos.length, items, dataSource: 'embedded_json', skipped: items.length ? null : 'NO_DEAL_LISTINGS' };
}

function parseNol(html, now) {
  const rows = [];
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const url = safeHttpsUrl(readAttribute(match[1], 'href'), SITES.nol.sourceUrl, isNolHost);
    if (!url || !/^\/stay\/(?:domestic|overseas)\//.test(new URL(url).pathname)) continue;
    const text = cleanText(match[2]);
    const priceMatch = text.match(/(\d[\d,]*)\s*원\s*~?/u);
    if (!priceMatch) continue;
    const title = cleanText(text.slice(0, priceMatch.index).replace(/\d{1,3}\s*%/g, ' '));
    const badges = [...text.matchAll(/\b\d{1,3}\s*%/g)].map(item => item[0].replace(/\s+/g, ''));
    const priceText = `${priceMatch[1].replace(/,/g, ',')}원${/\s*원\s*~/.test(priceMatch[0]) ? '~' : ''}`;
    const item = buildItem({ site: 'nol', title, url, now,
      fields: { priceText, priceFrom: Number(priceMatch[1].replace(/,/g, '')), badges } });
    if (item) rows.push(item);
  }
  return { observedItems: rows.length, items: rows, dataSource: rows.length ? 'html' : null,
    skipped: rows.length ? null : 'NO_PRICED_STAY_CARDS' };
}

const ttangCells = row => [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);
const ttangPrice = text => { const m = cleanText(text).match(/(\d{1,3}(?:,\d{3})+)\s*원/u); return m ? Number(m[1].replace(/,/g, '')) : null; };
const ttangDate = value => { const m = String(value ?? '').match(/(\d{4})\.(\d{2})\.(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };

// Last-minute airfare table: 출발지 | 도착지 | 항공사 | 직항/경유 | 출발일~귀국일 | 여정 | 요금 | 예약(data-* attrs)
export function parseTtangAirfares(html, now) {
  const rows = [...String(html ?? '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => m[1]).filter(r => /class="price"/.test(r));
  const items = rows.map(row => {
    const cells = ttangCells(row).map(cleanText);
    const attr = name => row.match(new RegExp(`data-${name}="([^"]*)"`, 'i'))?.[1] ?? null;
    const [dep, arr, airline, via, period, trip] = cells;
    const [start, end] = String(period ?? '').split('~');
    const fare = Number(attr('adtFare')); const priceFrom = Number.isSafeInteger(fare) && fare > 0 ? fare : ttangPrice(row);
    // The listed fare is the base fare; fuel surcharge (data-adtQcharge) is added at booking.
    const fuel = Number(attr('adtQcharge'));
    const fuelNote = Number.isSafeInteger(fuel) && fuel > 0 ? ` + 유류할증료 ${fuel.toLocaleString('ko-KR')}원` : '';
    if (!arr || !priceFrom || !/^[A-Z]{3}$/.test(attr('arrCity') ?? '')) return null;
    const query = new URLSearchParams({ arr0: attr('arrCity'), dep0: attr('depCity') || 'ICN', srhCar: attr('airlineCode') || '', gubun: attr('gubun') || 'VV' });
    return buildItem({ site: 'ttang', title: `${dep}→${arr} ${airline} ${via} ${trip} 땡처리 항공권`, now,
      url: `https://www.ttang.com/ttangair/search/ttang/list.do?${query}`,
      fields: { destination: arr, priceFrom, priceText: `${priceFrom.toLocaleString('ko-KR')}원~ (${trip}, 기본운임${fuelNote})`,
        travelStart: ttangDate(start), travelEnd: ttangDate(end) || ttangDate(start),
        badges: ['땡처리항공', airline, via, trip, fuelNote ? '유류할증료 별도' : null].filter(Boolean) } });
  }).filter(Boolean);
  return { observedItems: rows.length, items };
}

// Urgent package table: 출발/도착 일시 | 출발지 | 국가·도시 | 항공사 | 일정 | 상품명(ddId, pnum) | 가격(요금포함내역) | 예약
export function parseTtangUrgent(html, now) {
  const rows = [...String(html ?? '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => m[1]).filter(r => /class="price"/.test(r) && /pnum="/.test(r));
  const items = rows.map(row => {
    const cells = ttangCells(row);
    const link = row.match(/<a\b[^>]*ddId="(\d+)"[^>]*pnum="([A-Za-z0-9-]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) return null;
    const priceFrom = ttangPrice(cells.find(c => /js_tooltip_btn/.test(c)) ?? '');
    const fuel = row.match(/유류할증료:\s*([\d,]+)원/)?.[1];
    const dates = [...cleanText(cells[0] ?? '').matchAll(/(\d{2})\/(\d{2})/g)];
    // Rows show MM/DD only. A month more than one month before the current Seoul month belongs to next year.
    const [year, currentMonth] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit' })
      .format(now).split('-').map(Number);
    const iso = m => { if (!m) return null; const y = Number(m[1]) < currentMonth - 1 ? year + 1 : year; return `${y}-${m[1]}-${m[2]}`; };
    return buildItem({ site: 'ttang', title: `${cleanText(cells[2] ?? '')} ${cleanText(cells[4] ?? '')} ${cleanText(link[3])}`.trim(), now,
      url: `https://www.ttang.com/product/common/pkg/getGoodsInfo.do?ddId=${link[1]}&pnum=${encodeURIComponent(link[2])}`,
      fields: { destination: cleanText(cells[2] ?? '').replace(/\[[^\]]*\]\s*/, '') || null, priceFrom,
        priceText: priceFrom ? `${priceFrom.toLocaleString('ko-KR')}원${fuel && fuel !== '0' ? ` (유류할증료 별도 ${fuel}원)` : ''}` : null,
        travelStart: iso(dates[0]), travelEnd: iso(dates[1]) || iso(dates[0]),
        badges: ['긴급특가', cleanText(cells[3] ?? ''), fuel && fuel !== '0' ? '유류할증료 별도' : null].filter(Boolean) } });
  }).filter(Boolean);
  return { observedItems: rows.length, items };
}

function parseTtang(html, now) {
  const items = [];
  let observedItems = 0;
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const classes = readAttribute(match[1], 'class').split(/\s+/);
    const text = cleanText(match[2]);
    if (!classes.includes('shortCut') || !/\d[\d,]*\s*원/u.test(text)) continue;
    observedItems++;
    const url = safeHttpsUrl(readAttribute(match[1], 'href'), 'https://www.ttang.com/index.do', isTtangHost);
    if (!url || /#|javascript:/i.test(readAttribute(match[1], 'href'))) continue;
    const priceMatch = text.match(/(\d[\d,]*)\s*원\s*~?/u);
    const priceText = priceMatch ? `${priceMatch[1]}원${/\s*원\s*~/.test(priceMatch[0]) ? '~' : ''}` : null;
    const item = buildItem({ site: 'ttang', title: text, url, now,
      fields: { priceText, priceFrom: priceMatch ? Number(priceMatch[1].replace(/,/g, '')) : null } });
    if (item) items.push(item);
  }
  return { observedItems, items, dataSource: observedItems ? 'html' : null,
    skipped: items.length ? null : (observedItems ? 'NO_VERIFIED_DETAIL_URLS' : 'AIRFARE_LIST_NOT_FOUND') };
}

function parsePercent(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/(\d+(?:\.\d+)?)\s*%/u);
  if (!match) return null;
  const percent = Number(match[1]);
  return Number.isFinite(percent) ? percent : null;
}

function isConsumerPromotion(title, url) {
  let path = '';
  try { path = new URL(url).pathname; } catch { return false; }
  return /\/(?:instants\/)?promotions?\//i.test(path)
    && /특가|세일|할인|쿠폰|프로모션|페스타|sale|deal/i.test(title);
}

function parseMyrealtrip(html, now) {
  const data = nextData(html);
  const queries = data?.props?.pageProps?.dehydratedState?.queries;
  if (!Array.isArray(queries)) return { observedItems: 0, items: [], dataSource: data ? 'embedded_json' : null, skipped: 'NO_CONSUMER_PROMOTION_DATA' };
  const query = queries.find(row => Array.isArray(row?.queryKey) && row.queryKey[0] === 'main' && row.queryKey[1] === 'contents');
  const content = query?.state?.data;
  if (!isRecord(content)) return { observedItems: 0, items: [], dataSource: 'embedded_json', skipped: 'NO_CONSUMER_PROMOTION_DATA' };

  const raw = [];
  for (const section of content.rankProduct?.list ?? []) {
    for (const product of section?.products ?? []) {
      if (!isRecord(product)) continue;
      const tags = tagTexts(product.tags);
      const percent = parsePercent(product.discountPercent);
      const hasPromoTag = tags.some(tag => /특가|세일|할인|쿠폰|프로모션|페스타/i.test(tag));
      if (product.adProduct === true || (!hasPromoTag && !(percent > 0))) continue;
      const url = safeHttpsUrl(product.productUrl, SITES.myrealtrip.sourceUrl, isMyrealtripHost);
      if (!url || /partner|affiliate|partners/i.test(new URL(url).pathname)) continue;
      const badges = [...tags];
      if (percent > 0) badges.push(String(product.discountPercent).replace(/\s+/g, ''));
      const item = buildItem({ site: 'myrealtrip', title: product.title, url, record: product, now,
        fields: { destination: product.cityName ?? product.city, priceText: product.discountText,
          priceFrom: parsePrice(product.discountText) ?? parsePrice(product.couponAppliedPrice) ?? parsePrice(product.salePrice), badges } });
      if (item) raw.push(item);
    }
  }
  for (const shortcut of content.shortCut?.shortcuts ?? []) {
    if (!isRecord(shortcut)) continue;
    const title = textValue(shortcut.title);
    const url = safeHttpsUrl(shortcut.linkWeb, SITES.myrealtrip.sourceUrl, isMyrealtripHost);
    if (!title || !url || !isConsumerPromotion(title, url)) continue;
    const item = buildItem({ site: 'myrealtrip', title, url, record: shortcut, now });
    if (item) raw.push(item);
  }
  const unique = new Map(raw.map(item => [item.url, item]));
  const items = [...unique.values()];
  const observedItems = (content.rankProduct?.list ?? []).reduce((total, section) => total + (Array.isArray(section?.products) ? section.products.length : 0), 0)
    + (Array.isArray(content.shortCut?.shortcuts) ? content.shortCut.shortcuts.length : 0);
  return { observedItems, items, dataSource: 'embedded_json', skipped: items.length ? null : 'NO_CONSUMER_PROMOTION_DATA' };
}

function parseAgoda(html) {
  // The fetched homepage had no confirmed public deal-listing structure to extract.
  return { observedItems: 0, items: [], dataSource: null, skipped: 'NO_VERIFIED_EMBEDDED_DEALS' };
}

async function collectSite(site, { fetchImpl, now }) {
  const config = SITES[site];
  let sourceUrl = config.sourceUrl;
  let httpStatus = null;
  let dataSource = null;
  let observedItems = 0;
  let parsed = 0;
  let skippedEnded = 0;
  try {
    let page = await getPage(config.sourceUrl, fetchImpl);
    httpStatus = page.status;
    let result;
    if (site === 'ttang') {
      const air = parseTtangAirfares(page.html, now);
      const urgent = [];
      for (const url of config.urgentUrls) {
        try { urgent.push(parseTtangUrgent((await getPage(url, fetchImpl)).html, now)); } catch { /* one list failing keeps the others */ }
      }
      const all = [air, ...urgent];
      const merged = [...new Map(all.flatMap(r => r.items).map(item => [item.url, item])).values()];
      result = { observedItems: all.reduce((n, r) => n + r.observedItems, 0), items: merged, dataSource: 'html',
        skipped: merged.length ? null : 'AIRFARE_LIST_NOT_FOUND' };
    }
    if (result) { /* ttang handled above */ }
    else if (site === 'tripcom') result = parseTripcom(page.html, now);
    else if (site === 'yeogi') result = parseYeogi(page.html, now);
    else if (site === 'nol') result = parseNol(page.html, now);
    else if (site === 'myrealtrip') result = parseMyrealtrip(page.html, now);
    else result = parseAgoda(page.html);
    dataSource = result.dataSource;
    observedItems = result.observedItems;
    parsed = result.items.length;
    const items = result.items.filter(item => !dateEnded(item, now));
    skippedEnded = result.items.length - items.length;
    return { items, receipt: { site, sourceUrl, httpStatus, dataSource,
      observedItems, parsed, skippedEnded, skipped: result.skipped ?? null } };
  } catch (error) {
    httpStatus = Number.isInteger(error?.httpStatus) ? error.httpStatus : httpStatus;
    const reason = error?.code && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'COLLECTION_FAILED';
    return { items: [], receipt: { site, sourceUrl, httpStatus, dataSource,
      observedItems, parsed, skippedEnded, skipped: reason } };
  }
}

export async function fetchPlatformDeals(limit, { fetchImpl = globalThis.fetch, sites = Object.keys(SITES), now = new Date() } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw fail('SOURCE_LIMIT');
  if (typeof fetchImpl !== 'function') throw fail('FETCH_IMPL');
  if (!Array.isArray(sites)) throw fail('SITES');
  const selected = [...new Set(sites)];
  for (const site of selected) if (!Object.hasOwn(SITES, site)) throw fail('SITE');
  const checkedAt = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (!Number.isFinite(checkedAt.getTime())) throw fail('NOW');

  const results = await Promise.all(selected.map(site => collectSite(site, { fetchImpl, now: checkedAt })));
  const seen = new Set();
  const perSiteItems = results.map(result => result.items.filter(item => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  }));
  const items = [];
  // Round-robin keeps one large homepage section from crowding every other selected seller out.
  for (let index = 0; items.length < limit; index++) {
    let added = false;
    for (const rows of perSiteItems) {
      if (rows[index] && items.length < limit) { items.push(rows[index]); added = true; }
    }
    if (!added) break;
  }
  return { items, receipt: { perSite: results.map(result => result.receipt), browserUsed: false } };
}
