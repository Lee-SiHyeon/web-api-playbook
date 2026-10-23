import { parseLotte } from '../package-collect.mjs';
import { readPublic } from '../probes/anonymous-http.mjs';

const ORIGIN = 'https://www.lottetour.com';
let challengeObserved = false;

function asHtml(input) {
  return typeof input === 'string' ? input : String(input?.html ?? input?.text ?? '');
}

function stripHtml(value) {
  return String(value)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/[\s\u00a0]+/g, ' ')
    .trim();
}

function attr(attributes, name) {
  return attributes.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'))?.[2] ?? null;
}

function dateFromEventCode(code) {
  const match = typeof code === 'string' && code.match(/(\d{2})(\d{2})(\d{2})[A-Z]{2}\d+$/);
  return match ? `20${match[1]}-${match[2]}-${match[3]}` : null;
}

function yearFor(code, fallback = null) {
  const date = dateFromEventCode(code);
  return date ? Number(date.slice(0, 4)) : fallback;
}

function monthDay(year, month, day) {
  if (!year || !month || !day) return null;
  const value = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value ? null : value;
}

function number(value) {
  if (value == null || value === '') return null;
  const parsed = Number(String(value).replace(/[\s,원₩]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function section(text, startLabel, endLabel) {
  const start = text.indexOf(startLabel);
  if (start < 0) return null;
  const contentStart = start + startLabel.length;
  const end = endLabel ? text.indexOf(endLabel, contentStart) : -1;
  return text.slice(contentStart, end < 0 ? Math.min(text.length, contentStart + 5000) : end).trim() || null;
}

function findHotelCandidates(text) {
  const patterns = [
    ['윈덤 솔레일 다낭', /윈덤\s*솔레일\s*다낭(?:\s*\([^)]*\))?/g],
    ['힐튼 다낭', /힐튼\s*다낭(?:\s*\([^)]*\))?/g],
    ['모벤픽 리조트 캄란베이', /모벤픽\s*리조트\s*캄란베이(?:\s*\([^)]*\))?/g],
    ['멀펄 달랏 호텔', /멀펄\s*달랏\s*호텔(?:\s*\([^)]*\))?/g],
  ];
  const result = [];
  for (const [canonicalRaw, pattern] of patterns) {
    const match = pattern.exec(text);
    if (match) result.push({ nameRaw: match[0], nameEvidence: canonicalRaw, assignment: 'seller-listed candidate; selected property not verified' });
  }
  return result;
}

function dateTimeMatch(text, pattern, year) {
  const m = text.match(pattern);
  if (!m) return null;
  return {
    flightNo: m[1],
    departureDate: monthDay(year, m[2], m[3]),
    departureTime: `${String(m[4]).padStart(2, '0')}:${m[5]}`,
    departureAirportText: m[6].trim(),
    arrivalDate: monthDay(year, m[7], m[8]),
    arrivalTime: `${String(m[9]).padStart(2, '0')}:${m[10]}`,
    arrivalAirportText: m[11].trim(),
  };
}

/** Parse the previously observed Lotte list JSON, including JSON bodies served without a JSON MIME type. */
export function parseLotteList(input) {
  const payload = typeof input === 'string' ? JSON.parse(input) : input;
  return parseLotte(payload);
}

/** Parse an event-specific public detail document; only explicit seller labels become normalized facts. */
export function parseLotteDetail(input, context = {}) {
  const html = asHtml(input);
  if (!html.trim()) throw new TypeError('empty Lotte detail HTML');
  const text = stripHtml(html);
  const eventCode = text.match(/행사코드\s*([A-Z0-9-]+)/)?.[1] ?? context.sellerDepartureId ?? null;
  const departureDate = dateFromEventCode(eventCode);
  const year = yearFor(eventCode);
  const duration = text.match(/(\d+)\s*박\s*(\d+)\s*일/);
  const days = duration ? Number(duration[2]) : null;
  const nights = duration ? Number(duration[1]) : null;
  const seatsLeft = number(text.match(/남은좌석\s*([\d,]+)\s*석/)?.[1]);
  const journeyStart = text.indexOf('여행일정');
  const regionStart = journeyStart < 0 ? -1 : text.indexOf('여행지역', journeyStart);
  const journeyText = (journeyStart < 0 ? text : text.slice(journeyStart, regionStart < 0 ? journeyStart + 4000 : regionStart))
    .replace(/한국\s+출발/g, '한국출발')
    .replace(/한국\s+도착/g, '한국도착');
  const outbound = dateTimeMatch(section(journeyText, '한국출발', '한국도착') ?? '',
    /([A-Z]{2}\d+)\s+(\d{1,2})\/(\d{1,2})\s*\([^)]*\)\s*(\d{1,2}):(\d{2})\s+(.+?)\s+출발\s+(\d{1,2})\/(\d{1,2})\s*\([^)]*\)\s*(\d{1,2}):(\d{2})\s+(.+?)\s+도착/,
    year);
  const inbound = dateTimeMatch(section(journeyText, '한국도착', '여행지역') ?? '',
    /([A-Z]{2}\d+)\s+(\d{1,2})\/(\d{1,2})\s*\([^)]*\)\s*(\d{1,2}):(\d{2})\s+(.+?)\s+출발\s+(\d{1,2})\/(\d{1,2})\s*\([^)]*\)\s*(\d{1,2}):(\d{2})\s+(.+?)\s+도착/,
    year);
  const flights = [outbound, inbound].filter(Boolean).map((flight, index) => ({
    direction: index === 0 ? 'outbound' : 'return',
    airlineName: context.airlineName ?? null,
    ...flight,
  }));
  const includeText = section(text, '포함사항', '불포함사항');
  const excludeText = section(text, '불포함사항', '예약 시 유의사항');
  const mealText = section(text, '식사 ▣', '숙박 ▣') ?? section(text, '식사', '숙박');
  const sightseeingText = section(text, '관광 ▣', '식사 ▣') ?? section(text, '관광', '식사');
  const hotelText = section(text, '숙박 ▣', '보험 ▣') ?? section(text, '숙박', '보험');
  const hotelCandidates = findHotelCandidates(hotelText ?? text);
  const grade = text.match(/(?:([3-5])\s*성\s*급|([3-5])\s*성\b|★★★★★)/);
  const gradeBand = grade ? Number(grade[1] ?? grade[2] ?? 5) : null;
  const guideDriverUsd = number(includeText?.match(/가이드\s*\/\s*기사\s*경비[^0-9]{0,12}US\s*\$?\s*([\d,]+)/i)?.[1]);
  const singleText = text.match(/독실료[^.]{0,80}?([\d,]+)\s*(원|만원)/);
  const singleSupplementKrw = singleText ? number(singleText[1]) * (singleText[2] === '만원' ? 10000 : 1) : null;
  const hotelUpgrade = text.match(/(?:힐튼|호텔)\s*선택시\s*인당\s*추가금\s*([\d,]+)\s*만원/);
  const hotelUpgradeKrw = hotelUpgrade ? number(hotelUpgrade[1]) * 10000 : null;
  const marketingSights = sightseeingText ? [...sightseeingText.matchAll(/★\s*([^★▣]{2,140})/g)].map((m) => m[1].trim()).filter(Boolean).slice(0, 20) : [];
  const eventStatusText = text.match(/(일정미확정|출발확정)/)?.[1] ?? null;
  return {
    sellerDepartureId: eventCode,
    departureDate,
    returnDate: inbound?.arrivalDate ?? null,
    days,
    nights,
    departureAirportText: outbound?.departureAirportText ?? text.match(/미팅장소\s*([^ ]{1,30}공항[^ ]*)/)?.[1] ?? null,
    returnAirportText: inbound?.arrivalAirportText ?? null,
    airlineName: context.airlineName ?? null,
    airlineClass: null,
    directness: flights.length === 2 ? 'direct' : null,
    hotelGradeBand: gradeBand,
    hotelCandidates,
    hotelCandidateText: hotelText,
    hotelUpgradeSupplementKrw: hotelUpgradeKrw,
    seatsLeft,
    guaranteed: eventStatusText === '출발확정' ? true : null,
    sellerEventStatusText: eventStatusText,
    fuelIncluded: includeText?.includes('유류할증료') ?? null,
    fuelSurchargeKrw: null,
    localFees: null,
    localFeesComplete: false,
    mandatoryOptions: null,
    mandatoryOptionsComplete: false,
    singleSupplementKrw,
    guideDriverIncludedUsd: guideDriverUsd,
    includedText: includeText,
    excludedText: excludeText,
    surchargeDisclosure: excludeText?.match(/(?:써차지|서차지|갈라디너)[^▣]{0,120}/)?.[0]?.trim() ?? null,
    optionClaimNoOptions: /NO\s*옵션|NO옵션/i.test(text),
    shoppingClaimNoShopping: /NO\s*쇼핑|NO쇼핑/i.test(text),
    hotelGradeEvidence: grade ? grade[0] : null,
    itinerary: {
      mealsIncluded: null,
      mealHighlightsText: mealText,
      sights: marketingSights,
      freeTimeHours: null,
      shoppingStops: null,
      hotels: hotelCandidates,
      flights,
      marketingText: sightseeingText,
    },
    rawEvidence: {
      pageBytes: Buffer.byteLength(html),
      eventCode,
      flightScheduleText: journeyText.slice(0, 1200),
      seatsLabel: seatsLeft === null ? null : '남은좌석',
      priceCalculatorLabel: text.includes('기본상품가 유류할증료 총 상품가') ? 'basic fare/fuel/total labels shown; amounts blank' : null,
      includedFuelLabel: includeText?.includes('유류할증료') ? '유류할증료 listed under 포함사항' : null,
      guideDriverLabel: guideDriverUsd === null ? null : `가이드/기사 경비 US$${guideDriverUsd} listed under 포함사항`,
    },
  };
}

/** Parse Lotte's calendar cells. evt="on" is retained as a raw event-date signal, not a seat count. */
export function parseLotteCalendar(input) {
  const html = asHtml(input);
  const days = [];
  for (const match of html.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)) {
    const attributes = match[1];
    const date = attr(attributes, 'datefull');
    if (!date || !/^\d{8}$/.test(date)) continue;
    const eventSignal = attr(attributes, 'evt');
    days.push({
      departureDate: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
      eventDateListed: eventSignal === 'on',
      eventSignalRaw: eventSignal,
      classRaw: attr(attributes, 'class'),
      oldClassRaw: attr(attributes, 'oldcls'),
    });
  }
  return days;
}

/** Parse price-calendar anchors. The fare is taken only from observed scheInfo arguments. */
export function parseLottePriceList(input) {
  const html = asHtml(input);
  const rows = new Map();
  const pattern = /scheInfo\(\s*['"]([^'"]+)['"]\s*,\s*['"](\d{8})['"]\s*,\s*['"]([^'"]+)['"]\s*,\s*['"]([\d,]+)['"]\s*\)/g;
  for (const match of html.matchAll(pattern)) {
    const row = {
      sellerProductId: match[1],
      departureDate: `${match[2].slice(0, 4)}-${match[2].slice(4, 6)}-${match[2].slice(6, 8)}`,
      airlineCodeRaw: match[3],
      basePriceKrw: number(match[4]),
      priceBasis: 'dated_calendar_price',
      rawCall: match[0],
    };
    rows.set(`${row.sellerProductId}:${row.departureDate}:${row.airlineCodeRaw}:${row.basePriceKrw}`, row);
  }
  return [...rows.values()];
}

function listUrl(destination, pageNum) {
  const params = new URLSearchParams([
    ['kwd', destination], ['subkwd', ''], ['subdatekwd', ''], ['minprice', ''], ['maxprice', ''],
    ['checkdtcnt', ''], ['checkday', ''], ['checkcomm', ''], ['checkairline', ''], ['checkclass', ''],
    ['checkstatus', ''], ['calenderKwd', ''], ['pageSize', '10'], ['pageNum', String(pageNum)],
    ['selectKey', 'KEY'], ['startPrice', ''], ['endPrice', ''], ['category', 'globalpackage'],
    ['selectcategory', 'globalpackage'], ['subcategory', '857'],
  ]);
  return `${ORIGIN}/search/json?${params}`;
}

function inDateWindow(date, anchor, before, after) {
  if (!date) return false;
  const d = Date.parse(`${date}T00:00:00Z`);
  const a = Date.parse(`${anchor}T00:00:00Z`);
  return Number.isFinite(d) && Number.isFinite(a) && d >= a - before * 86400000 && d <= a + after * 86400000;
}

function challenge(result) {
  const body = result.text?.slice(0, 8000).toLowerCase() ?? '';
  return result.meta?.status === 403 || body.includes('attention required') || body.includes('captcha') || body.includes('cloudflare ray id');
}

/** Anonymous public Lotte collection with an injectable reader for deterministic offline tests. */
export async function collectLotteLive({
  destination,
  anchor,
  anchorDate,
  daysBefore = 3,
  daysAfter = 3,
  maxRequests = 12,
  maxProducts = 1,
  readImpl = readPublic,
} = {}) {
  const target = anchorDate ?? anchor ?? '2026-10-31';
  if (challengeObserved) return { schemaVersion: 1, sellerId: 'lotte-package', destination, anchor: target, verdict: 'challenge_blocked', requestCount: 0, requests: [], products: [], stopReason: 'Lotte challenge was previously observed in this process.' };
  if (!destination) throw new TypeError('destination is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) throw new TypeError('anchor must be YYYY-MM-DD');
  const cap = Math.max(1, Math.min(40, Number(maxRequests) || 12));
  const requests = [];
  const products = [];
  let stopReason = null;
  const request = async (name, url) => {
    if (requests.length >= cap) { stopReason = 'request_budget_reached'; return null; }
    const result = await readImpl('lotte-package', name, url);
    requests.push({ name, method: 'GET', url, status: result.meta.status, checkedAt: result.meta.checkedAt, contentType: result.meta.contentType, bytes: result.meta.bytes, sha256: result.meta.sha256, capture: result.meta.capture, error: result.meta.error ?? null });
    if (challenge(result)) { challengeObserved = true; stopReason = 'challenge_blocked'; return null; }
    return result;
  };

  const parsedById = new Map();
  for (let pageNum = 1; pageNum <= 2 && !stopReason; pageNum++) {
    const result = await request(`live-${destination}-list-${pageNum}`, listUrl(destination, pageNum));
    if (!result) break;
    let parsed;
    try { parsed = parseLotteList(result.text); }
    catch (error) { requests.at(-1).parseError = error.message; stopReason = 'invalid_list_response'; break; }
    for (const product of parsed) {
      if (!product.departures.some((departure) => inDateWindow(departure.departureDate, target, daysBefore, daysAfter))) continue;
      parsedById.set(`${product.sellerProductId}:${product.departures[0]?.departureDate}`, product);
    }
    if (parsedById.size) break;
  }

  const selected = [...parsedById.values()]
    .sort((a, b) => Math.abs(Date.parse(`${a.departures[0].departureDate}T00:00:00Z`) - Date.parse(`${target}T00:00:00Z`)) - Math.abs(Date.parse(`${b.departures[0].departureDate}T00:00:00Z`) - Date.parse(`${target}T00:00:00Z`)))
    .slice(0, Math.max(1, Math.min(4, Number(maxProducts) || 1)));

  for (const listed of selected) {
    if (stopReason) break;
    const listDeparture = listed.departures[0];
    const raw = listed.raw ?? {};
    const menu = [raw.menu_1lvl_id, raw.menu_2lvl_id, raw.menu_3lvl_id, raw.menu_4lvl_id].map(String);
    const detailUrl = `${ORIGIN}/evtList/${menu.join('/')}?godId=${encodeURIComponent(listed.sellerProductId)}`;
    const detailResponse = await request(`live-${destination}-${listed.sellerProductId}-detail`, detailUrl);
    if (!detailResponse) break;
    const calendarResponse = await request(`live-${destination}-${listed.sellerProductId}-calendar`, `${ORIGIN}/evtCal?godId=${encodeURIComponent(listed.sellerProductId)}&depDt=${listDeparture.departureDate.slice(0, 7).replace('-', '')}`);
    if (!calendarResponse) break;
    const priceResponse = await request(`live-${destination}-${listed.sellerProductId}-price-list`, `${ORIGIN}/priceList?godId=${encodeURIComponent(listed.sellerProductId)}&depDt=${listDeparture.departureDate.slice(0, 7).replace('-', '')}`);
    if (!priceResponse) break;
    const calendar = parseLotteCalendar(calendarResponse.text);
    const datedPrices = parseLottePriceList(priceResponse.text);
    const fare = datedPrices.find((row) => row.sellerProductId === listed.sellerProductId && row.departureDate === listDeparture.departureDate);
    const eventCode = listDeparture.sellerDepartureId;
    let event = null;
    if (eventCode) {
      const eventResponse = await request(`live-${destination}-${eventCode}-dated-detail`, `${ORIGIN}/evtDetail?evtCd=${encodeURIComponent(eventCode)}`);
      if (!eventResponse) break;
      event = parseLotteDetail(eventResponse.text, { sellerDepartureId: eventCode, airlineName: listed.airlineName });
    }
    const calendarRow = calendar.find((row) => row.departureDate === listDeparture.departureDate) ?? null;
    const departure = {
      ...listDeparture,
      basePriceKrw: fare?.basePriceKrw ?? listDeparture.basePriceKrw,
      priceBasis: fare?.priceBasis ?? listDeparture.priceBasis,
      fuelIncluded: event?.fuelIncluded ?? null,
      fuelSurchargeKrw: event?.fuelSurchargeKrw ?? null,
      localFees: event?.localFees ?? null,
      localFeesComplete: event?.localFeesComplete ?? false,
      mandatoryOptions: event?.mandatoryOptions ?? null,
      mandatoryOptionsComplete: event?.mandatoryOptionsComplete ?? false,
      singleSupplementKrw: event?.singleSupplementKrw ?? null,
      guaranteed: event?.guaranteed ?? null,
      seatsLeft: event?.seatsLeft ?? null,
      guideDriverIncludedUsd: event?.guideDriverIncludedUsd ?? null,
      hotelUpgradeSupplementKrw: event?.hotelUpgradeSupplementKrw ?? null,
      calendarEventListed: calendarRow?.eventDateListed ?? null,
      calendarEventSignalRaw: calendarRow?.eventSignalRaw ?? null,
      rawEvidence: {
        listCapture: requests.find((r) => r.name.includes('-list-'))?.capture ?? null,
        detailCapture: detailResponse.meta.capture,
        calendarCapture: calendarResponse.meta.capture,
        priceListCapture: priceResponse.meta.capture,
        datedDetailCapture: requests.at(-1)?.capture ?? null,
        priceListFareCall: fare?.rawCall ?? null,
        evtPersonCountRaw: raw.evt_person_cnt ?? null,
        departureConfirmedRaw: raw.dep_confrm_yn ?? null,
        warning: 'evt_person_cnt is preserved as an unverified raw counter and is never mapped to seatsLeft.',
      },
    };
    products.push({
      ...listed,
      nights: event?.nights ?? listed.nights,
      days: event?.days ?? listed.days,
      departureAirport: null,
      departureAirportText: event?.departureAirportText ?? listed.departureAirportText,
      airlineClass: null,
      directness: event?.directness ?? null,
      hotelGradeBand: event?.hotelGradeBand ?? null,
      hotelCandidates: event?.hotelCandidates ?? [],
      hotelUpgradeSupplementKrw: event?.hotelUpgradeSupplementKrw ?? null,
      itinerary: event?.itinerary ?? null,
      departures: [departure],
    });
  }
  return {
    schemaVersion: 1,
    sourceId: 'lotte-package',
    seller: '롯데관광',
    destination,
    anchor: target,
    window: { from: new Date(Date.parse(`${target}T00:00:00Z`) - daysBefore * 86400000).toISOString().slice(0, 10), through: new Date(Date.parse(`${target}T00:00:00Z`) + daysAfter * 86400000).toISOString().slice(0, 10) },
    checkedAt: requests.at(-1)?.checkedAt ?? null,
    verdict: stopReason === 'challenge_blocked' ? 'challenge_blocked' : products.length ? 'usable_limited' : stopReason ?? 'empty_result',
    requestCount: requests.length,
    requests,
    products,
    limitations: [
      'List and calendar fares are seller observations, not checkout guarantees.',
      'Fuel is reported included by the event page, but its amount is blank; local mandatory fees and mandatory options are incomplete and block true-payable comparison.',
      'Only explicit event-page remaining-seat text maps to seatsLeft; evt_person_cnt stays raw and unmapped.',
    ],
  };
}
