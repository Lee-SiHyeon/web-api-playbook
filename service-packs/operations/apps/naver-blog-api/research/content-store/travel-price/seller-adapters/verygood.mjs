import { readPublic } from '../probes/anonymous-http.mjs';
import { parseVerygood as parseVerygoodList } from '../package-collect.mjs';

const ORIGIN = 'https://www.verygoodtour.com';
const DESTINATIONS = new Map([
  ['danang', '\uB2E4\uB0AD'], ['da nang', '\uB2E4\uB0AD'], ['\uB2E4\uB0AD', '\uB2E4\uB0AD'],
  ['nhatrang', '\uB098\uD2B8\uB791'], ['nha trang', '\uB098\uD2B8\uB791'], ['\uB098\uD2B8\uB791', '\uB098\uD2B8\uB791'],
]);
const CHALLENGE = /captcha|cloudflare|attention required|cf-chl-|challenge-platform|cf-turnstile|verify you are (?:human|a person)|automated requests|bot detection|checking your browser/i;
const READ_CONTRACT = 'Observed public Verygoodtour search/detail contract from anonymous PackageList HTML and Product.min.js. This is a read-only search/detail lookup.';

function htmlText(value) {
  return String(value ?? '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&#x27;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#183;|&middot;/gi, '\u00B7')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/\s+/g, ' ').trim();
}

function dateFromProductCode(code) {
  const match = typeof code === 'string' && code.match(/-(\d{2})(\d{2})(\d{2})(?=[A-Z])/i);
  if (!match) return null;
  const year = Number(match[1]) + (Number(match[1]) >= 70 ? 1900 : 2000);
  const value = `${year}-${match[2]}-${match[3]}`;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}

function duration(text) {
  const match = text.match(/(\d+)\s*박\s*(\d+)\s*일/u);
  return match ? { nights: Number(match[1]), days: Number(match[2]) } : { nights: null, days: null };
}

function dateTime(text, label, direction) {
  const start = text.indexOf(label);
  if (start < 0) return null;
  const routeText = text.slice(start, start + 360);
  const routes = [...routeText.matchAll(/(20\d{2})[./-](\d{2})[./-](\d{2})\s*\([^)]*\)\s*(\d{1,2}):(\d{2})\s*(.{1,24}?)\s*(출발|도착)/gu)];
  const match = direction === '도착'
    ? [...routes].reverse().find((row) => row[7] === direction)
    : routes.find((row) => row[7] === direction);
  if (!match) return null;
  return { dateTime: `${match[1]}-${match[2]}-${match[3]}T${match[4].padStart(2, '0')}:${match[5]}`, place: match[6].trim() || null };
}

function routeSegments(text) {
  const start = text.indexOf('한국출발');
  if (start < 0) return [];
  const end = text.indexOf('요약설명', start);
  const block = text.slice(start, end >= 0 ? end : start + 900);
  return [...block.matchAll(/(20\d{2})[./-](\d{2})[./-](\d{2})\s*\([^)]*\)\s*(\d{1,2}):(\d{2})\s*(.{1,24}?)\s*(출발|도착)/gu)]
    .map((m) => ({ dateTime: `${m[1]}-${m[2]}-${m[3]}T${m[4].padStart(2, '0')}:${m[5]}`, place: m[6].trim() || null, action: m[7] }));
}

function section(text, start, endMarkers) {
  const at = text.indexOf(start);
  if (at < 0) return null;
  const from = at + start.length;
  const ends = endMarkers.map((marker) => text.indexOf(marker, from)).filter((n) => n >= 0);
  return text.slice(from, ends.length ? Math.min(...ends) : Math.min(text.length, from + 1600)).trim() || null;
}

function inclusionColumns(input) {
  const tables = [...input.matchAll(/<table\b[\s\S]*?<\/table>/gi)].map((match) => match[0]);
  const table = tables.find((candidate) => candidate.includes('포함사항') && candidate.includes('불포함사항'));
  if (!table) return null;
  const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => match[1]);
  const headerRow = rows.find((row) => row.includes('포함사항') && row.includes('불포함사항'));
  if (!headerRow) return null;
  const headings = [...headerRow.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((match) => htmlText(match[1]));
  const includedIndex = headings.findIndex((heading) => heading.includes('포함사항') && !heading.includes('불포함사항'));
  const excludedIndex = headings.findIndex((heading) => heading.includes('불포함사항'));
  const contentRow = rows.find((row) => [...row.matchAll(/<td\b[^>]*>/gi)].length >= headings.length);
  const cells = contentRow ? [...contentRow.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => htmlText(match[1])) : [];
  if (includedIndex < 0 || excludedIndex < 0 || !cells[includedIndex] || !cells[excludedIndex]) return null;
  return { includedText: cells[includedIndex], excludedText: cells[excludedIndex] };
}

/** Recover the seller's two cost columns before HTML tag stripping collapses their headings. */
export function parseVerygoodCostSections(input) {
  if (typeof input !== 'string') throw new TypeError('Verygood detail must be HTML text');
  const columns = inclusionColumns(input);
  if (!columns) return { includedText: null, excludedText: null, fuelIncluded: null, fuelChangeCaveat: null, taxesIncluded: null, taxInclusionText: null, guideFeeCandidates: [] };
  const { includedText, excludedText } = columns;
  const guideFee = excludedText.match(/가이드\s*[,·]?\s*기사\s*경비\s*\$\s*([\d,]+)\s*\/\s*인/u);
  const includedGuide = includedText.match(/(?:기사\s*가이드|가이드\s*기사)\s*경비\s*포함/u);
  const guideFeeCandidates = guideFee ? [{
    name: 'guide and driver fee', amount: Number(guideFee[1].replaceAll(',', '')), currency: 'USD',
    unit: 'per_person', mandatory: null, includedInBasePrice: false, sourceText: guideFee[0],
  }] : includedGuide ? [{
    name: 'guide and driver fee', amount: 0, currency: null, unit: 'additional_charge',
    mandatory: false, includedInBasePrice: true, sourceText: includedGuide[0],
  }] : [];
  const fuelChangeCaveat = excludedText.match(/유류할증료\s*변동에\s*따른\s*증감분[^.]{0,100}/u)?.[0] ?? null;
  const taxInclusionText = includedText.match(/왕복항공요금\s*및\s*제세공과금/u)?.[0] ?? null;
  return {
    includedText, excludedText,
    fuelIncluded: /유류할증료/u.test(includedText) ? true : null,
    fuelChangeCaveat,
    taxesIncluded: taxInclusionText ? true : null,
    taxInclusionText,
    guideFeeCandidates,
  };
}

/** Parse the seller's public detail HTML. Ambiguous statuses and amounts remain unnormalized. */
export function parseVerygoodDetail(input) {
  if (typeof input !== 'string') throw new TypeError('Verygood detail must be HTML text');
  const text = htmlText(input);
  if (!text || /attention required|cf-chl-|captcha/i.test(text)) throw new TypeError('Verygood detail is empty or challenge HTML');
  const productCode = text.match(/상품코드\s*([A-Z0-9-]+)/u)?.[1] ?? null;
  const { nights, days } = duration(text);
  const departure = dateTime(text, '한국출발', '출발');
  const returning = dateTime(text, '한국도착', '도착');
  const flightCodes = [...new Map([...input.matchAll(/\[([^\]]{1,40}?)\s+([A-Z]{2}\d{2,4})편\]/g)]
    .map((m) => [m[2], { airlineLabel: htmlText(m[1]), flightCode: m[2] }])).values()];
  const segments = routeSegments(text);
  const head = text.slice(Math.max(0, text.indexOf('상품코드') - 800), Math.max(0, text.indexOf('상품코드')) + 500);
  const airlineName = flightCodes[0]?.airlineLabel
    ?? head.match(/([\p{Script=Hangul}]{2,12}(?:항공|에어))/u)?.[1]?.trim()
    ?? null;
  const shoppingStops = Number(text.match(/쇼핑\s*(\d+)\s*회/u)?.[1] ?? NaN);
  const gradeMatches = [...text.matchAll(/([3-5])\s*성(?:급)?/gu)].map((m) => Number(m[1]));
  const hotelGradeBand = gradeMatches.length ? Math.max(...gradeMatches) : null;
  const costSections = parseVerygoodCostSections(input);
  const included = costSections.includedText ?? section(text, '포함사항', ['불포함사항', '상품평점']);
  const excluded = costSections.excludedText ?? section(text, '불포함사항', ['상품평점', '여행후기']);
  const guideFee = excluded?.match(/가이드\s*[,·]?\s*기사\s*경비\s*\$\s*([\d,]+)\s*\/\s*인/u);
  const includedGuide = included?.match(/(?:기사\s*가이드|가이드\s*기사)\s*경비\s*포함/u);
  const localFeeCandidates = costSections.guideFeeCandidates.length ? costSections.guideFeeCandidates
    : guideFee ? [{ name: 'guide and driver fee', amount: Number(guideFee[1].replaceAll(',', '')), currency: 'USD', unit: 'per_person', mandatory: null, includedInBasePrice: false, sourceText: guideFee[0] }]
      : includedGuide ? [{ name: 'guide and driver fee', amount: 0, currency: null, unit: 'additional_charge', mandatory: false, includedInBasePrice: true, sourceText: includedGuide[0] }] : [];
  const optionalToursExplicitlyOptional = /선택관광\s*참여여부는\s*자유롭게\s*선택/u.test(text)
    && /미\s*참여시\s*추가적인\s*비용\s*또는\s*일정상\s*불이익(?:이|은)\s*없/u.test(text);
  const headerText = text.slice(0, Math.min(text.length, 4500));
  const booked = text.match(/현재예약\s*(\d+)\s*명\s*최소출발\s*(\d+)\s*명/u);
  const caveat = text.match(/(?:※\s*)?본\s*상품은\s*확정된\s*상품이\s*아닙니다[^.]{0,180}/u)?.[0]
    ?? text.match(/항공\s*및\s*객실\s*실시간\s*확인\s*후\s*가능여부\s*안내드립니다[^.]{0,100}/u)?.[0]
    ?? null;
  const hotelText = section(text, '2. 호텔', ['3. 상품', '상품 CHECK POINT', 'POINT1.'])
    ?? section(text, '\u25A0 호텔 :', ['\u25A0 상품 CHECK POINT', 'POINT1.']);
  const mealClaims = [...text.matchAll(/(?:조식|중식|석식|식사)[^.!?]{0,100}/gu)].map((m) => m[0].trim()).filter(Boolean).slice(0, 24);
  const fuelMentionedIncluded = Boolean(included && /유류할증료/u.test(included));
  const fuelChangeCaveat = costSections.fuelChangeCaveat ?? text.match(/유류할증료\s*변동에\s*따른\s*증감분[^.]{0,100}/u)?.[0] ?? null;
  const priceStatus = /가격예정/u.test(headerText) ? 'price_pending' : null;
  const candidatePriceKrw = Number(text.match(/promotionView\((\d+)\)/u)?.[1] ?? NaN);
  const flights = [];
  for (let i = 0; i + 1 < segments.length; i += 2) {
    flights.push({
      flightCode: flightCodes[flights.length]?.flightCode ?? null,
      airlineLabel: flightCodes[flights.length]?.airlineLabel ?? airlineName,
      departureAt: segments[i].dateTime,
      departureAirportText: segments[i].place,
      arrivalAt: segments[i + 1].dateTime,
      arrivalAirportText: segments[i + 1].place,
    });
  }

  return {
    sellerProductId: productCode?.split('-')[0] ?? null,
    sellerDepartureId: productCode,
    departureDate: departure?.dateTime?.slice(0, 10) ?? dateFromProductCode(productCode),
    departureAt: departure?.dateTime ?? null,
    returnAt: returning?.dateTime ?? null,
    departureAirportText: departure?.place ?? null,
    returnAirportText: returning?.place ?? null,
    airlineName,
    flightCodes,
    nights,
    days,
    hotelGradeBand,
    hotelText,
    hotelAssignmentConfirmed: false,
    shoppingStops: Number.isFinite(shoppingStops) ? shoppingStops : null,
    shoppingStopBand: Number.isFinite(shoppingStops) ? (shoppingStops === 0 ? '0' : shoppingStops <= 2 ? '1-2' : '3+') : null,
    mealsIncluded: null,
    mealClaims: [...new Set(mealClaims)],
    includedText: included,
    excludedText: excluded,
    fuelIncluded: fuelMentionedIncluded ? true : null,
    fuelSurchargeKrw: null,
    fuelChangeCaveat,
    taxesIncluded: costSections.taxesIncluded ?? (included && /제세공과금/u.test(included) ? true : null),
    localFeesComplete: false,
    airportTaxIncluded: null,
    taxInclusionText: included?.match(/왕복항공요금\s*및\s*제세공과금/u)?.[0] ?? null,
    localFees: null,
    localFeeCandidates,
    mandatoryOptions: optionalToursExplicitlyOptional || /노옵션/u.test(headerText) ? [] : null,
    optionalToursExplicitlyOptional,
    singleSupplementKrw: null,
    guaranteed: null,
    guaranteedLabel: /출발확정/u.test(headerText) ? '출발확정' : null,
    confirmationCaveat: caveat,
    reservationCountRaw: booked ? Number(booked[1]) : null,
    minimumDepartureCountRaw: booked ? Number(booked[2]) : null,
    seatsLeft: null,
    priceStatus,
    detailPriceCandidateKrw: Number.isFinite(candidatePriceKrw) ? candidatePriceKrw : null,
    itinerary: {
      mealsIncluded: null,
      mealClaims: [...new Set(mealClaims)],
      sights: null,
      freeTimeHours: null,
      shoppingStops: Number.isFinite(shoppingStops) ? shoppingStops : null,
      hotels: null,
      hotelOptionsText: hotelText,
      flights,
    },
    rawTextSample: text.slice(0, 1200),
  };
}

function parsePriceFloor(text) {
  const match = text.match(/([\d,]+)\s*만원\s*~/u);
  return match ? Number(match[1].replaceAll(',', '')) * 10000 : null;
}

/** Parse calendar date-cell starting prices separately from exact event quotes. */
export function parseVerygoodCalendar(input) {
  if (typeof input !== 'string') throw new TypeError('Verygood calendar must be HTML text');
  if (CHALLENGE.test(input)) throw new TypeError('Verygood calendar is challenge HTML');
  const displayMonth = htmlText(input).match(/(?:이전달|다음달)\s*(20\d{2})[./](\d{1,2})/u);
  const year = displayMonth?.[1] ?? null;
  const month = displayMonth?.[2]?.padStart(2, '0') ?? null;
  const dateCells = [...input.matchAll(/<td\b[^>]*class=["'][^"']*jq_cl_day[^"']*["'][^>]*>([\s\S]*?)<\/td>/gi)]
    .map((m) => {
      const cell = m[1];
      const day = htmlText(cell.match(/<span\b[^>]*class=["'][^"']*date[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? '').match(/\d{1,2}/)?.[0];
      if (!day || !year || !month) return null;
      const priceText = htmlText(cell.match(/<p\b[^>]*class=["'][^"']*price[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? '') || null;
      return {
        date: `${year}-${month}-${day.padStart(2, '0')}`,
        hasSchedule: !/jq_cl_noneSchedule/i.test(cell),
        priceDisplay: priceText,
        priceFromKrw: priceText ? parsePriceFloor(priceText) : null,
        exactPriceKrw: null,
        priceBasis: priceText?.includes('~') ? 'calendar_from_price' : null,
      };
    }).filter(Boolean);
  const events = [...input.matchAll(/<div\b[^>]*class=["'][^"']*dep_event_wrap[^"']*["'][^>]*>([\s\S]*?)(?=<div\b[^>]*class=["'][^"']*dep_right_wrap|<div\b[^>]*class=["'][^"']*dep_event_wrap|$)/gi)]
    .map((m) => {
      const whole = m[0];
      const productCode = whole.match(/PackageDetail\?ProCode=([^&'"\s]+)/i)?.[1] ?? null;
      const text = htmlText(whole);
      const dates = text.match(/(20\d{2})\.(\d{2})\.(\d{2})\([^)]*\)\s*(\d{2}):(\d{2})\s*~\s*(20\d{2})\.(\d{2})\.(\d{2})\([^)]*\)\s*(\d{2}):(\d{2})/u);
      const amount = whole.match(/class=["']price_wrap["'][^>]*>[\s\S]*?([\d,]+)\s*<span[^>]*>원<\/span>/i)?.[1];
      const airline = whole.match(/class=["']dep_ev_tit["'][^>]*>([\s\S]*?)<\/span>/i)?.[1];
      const status = whole.match(/class=["']start_status[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1];
      return {
        sellerDepartureId: productCode,
        departureDate: dates ? `${dates[1]}-${dates[2]}-${dates[3]}` : null,
        departureAt: dates ? `${dates[1]}-${dates[2]}-${dates[3]}T${dates[4]}:${dates[5]}` : null,
        returnAt: dates ? `${dates[6]}-${dates[7]}-${dates[8]}T${dates[9]}:${dates[10]}` : null,
        airlineName: airline ? htmlText(airline) : null,
        reservationStatusRaw: status ? htmlText(status) : null,
        basePriceKrw: amount ? Number(amount.replaceAll(',', '')) : null,
        priceBasis: amount ? 'dated_calendar_price' : null,
      };
    });
  return { displayMonth: year && month ? `${year}-${month}` : null, dateCells, events };
}

/** Parse the separate air-schedule fragment. Empty rows stay empty; detail-page flights are separate evidence. */
export function parseVerygoodAirSchedule(input) {
  if (typeof input !== 'string') throw new TypeError('Verygood air schedule must be HTML text');
  if (CHALLENGE.test(input)) throw new TypeError('Verygood air schedule is challenge HTML');
  const flights = [...input.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((m) => {
      const cells = [...m[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((x) => htmlText(x[1]));
      const flightCode = cells.join(' ').match(/\b[A-Z]{2}\d{2,4}\b/)?.[0] ?? null;
      if (!flightCode) return null;
      return { flightCode, cells, departureAt: null, arrivalAt: null, departureAirport: null, arrivalAirport: null };
    }).filter(Boolean);
  return { flights, responseText: htmlText(input).slice(0, 300), flightRowsRecovered: flights.length > 0 };
}

function requestDateFromCode(value) { return dateFromProductCode(value); }
function inWindow(value, anchor, windowDays) {
  if (!value || !anchor) return false;
  return Math.abs(Date.parse(`${value}T00:00:00Z`) - Date.parse(`${anchor}T00:00:00Z`)) <= windowDays * 86400000;
}

function publicFailure(response) {
  if (response.meta?.error || response.meta?.status === 429 || response.meta?.status === 403 || response.meta?.status === 418 || response.meta?.status === 401 || response.meta?.status >= 500 || CHALLENGE.test(response.text ?? '')) {
    throw new Error(`Verygood public request stopped: HTTP ${response.meta?.status ?? 'transport error'}${CHALLENGE.test(response.text ?? '') ? ' challenge' : ''}`);
  }
}

async function read(readImpl, name, url, options = {}) {
  const result = await readImpl('verygood', name, url, { ...options, readContract: options.method === 'POST' ? READ_CONTRACT : options.readContract });
  publicFailure(result);
  return result;
}

/** Collect one destination with verified routes and one dated product detail within the window. */
export async function collectVerygoodLive({
  destination, anchor, anchorDate, windowDays = 3, readImpl = readPublic,
} = {}) {
  const term = DESTINATIONS.get(String(destination ?? '').trim().toLocaleLowerCase('en-US'))
    ?? DESTINATIONS.get(String(destination ?? '').trim());
  const center = anchorDate ?? anchor;
  if (!term) throw new TypeError('destination must be Da Nang/다낭 or Nha Trang/나트랑');
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(center ?? '')) throw new TypeError('anchor or anchorDate must be YYYY-MM-DD');
  const slug = term === '\uB2E4\uB0AD' ? 'danang' : 'nhatrang';
  const requests = [];
  const record = async (name, url, options) => {
    const result = await read(readImpl, name, url, options);
    requests.push({ name, method: options?.method ?? 'GET', url, requestBody: options?.body ?? null, status: result.meta?.status ?? null, checkedAt: result.meta?.checkedAt ?? null, capture: result.meta?.capture ?? null, sha256: result.meta?.sha256 ?? null, bytes: result.meta?.bytes ?? null });
    return result;
  };
  const autocomplete = await record(`autocomplete-${slug}`, `${ORIGIN}/Search/SearchKeyWordAjaxList?${new URLSearchParams({ keyword: term })}`, { accept: 'application/json, text/javascript, */*; q=0.01' });
  const autocompleteJson = autocomplete.json();
  const menu = autocompleteJson.info2?.find((row) => row.mainCode === '101' && row.menuName?.includes(term));
  if (!menu?.menuCode) throw new Error(`Verygood destination menu missing for ${slug}`);
  const menuPage = await record(`destination-menu-${slug}`, `${ORIGIN}/Product/PackageList?MenuCode=${encodeURIComponent(menu.menuCode)}`, { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' });
  if (!menuPage.text.includes(`value="${menu.menuCode}"`)) throw new Error(`Verygood menu form did not confirm ${menu.menuCode}`);
  const filterBody = new URLSearchParams({ keyword: '', menuCode: menu.menuCode, regionCode: '' }).toString();
  const filterResponse = await record(`filters-${slug}`, `${ORIGIN}/Product/GetSearchFilter`, { method: 'POST', body: filterBody, accept: 'application/json, text/javascript, */*; q=0.01', headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', referer: `${ORIGIN}/Product/PackageList?MenuCode=${menu.menuCode}` } });
  const filters = filterResponse.json();
  const listBody = new URLSearchParams({ keyword: '', menuCode: menu.menuCode, regionCode: '', orderby: '1', CfmYN: '', depdate: '', weekday: '', day: '', price: '' }).toString();
  const listResponse = await record(`list-${slug}`, `${ORIGIN}/Product/GetPackageList?pageIndex=1&pageSize=15`, { method: 'POST', body: listBody, accept: 'application/json, text/javascript, */*; q=0.01', headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', referer: `${ORIGIN}/Product/PackageList?MenuCode=${menu.menuCode}` } });
  const payload = listResponse.json();
  const parsed = parseVerygoodList(payload);
  const sourceRows = payload.packageList;
  const targetRows = sourceRows.map((raw) => {
    const productText = [raw.masterName, raw.eventName, raw.packageSummary, raw.packageComment, raw.masterKeyword, raw.koreaName].filter(Boolean).join(' ');
    if (!productText.includes(term)) return null;
    const dates = [raw.eventProCode, raw.deptProcode, raw.proCode].map((code) => ({ code, date: requestDateFromCode(code) }))
      .filter((x) => x.date && inWindow(x.date, center, windowDays));
    const exactEvent = dates.find((x) => x.code === raw.eventProCode && raw.eventPrice !== '' && inWindow(raw.eventDepartureDate?.slice(0, 10), center, windowDays));
    const selected = exactEvent ?? dates.find((x) => x.code === raw.deptProcode) ?? dates[0];
    return selected ? { raw, date: selected.date, productCode: selected.code, exactEvent: Boolean(exactEvent) } : null;
  }).filter(Boolean).sort((a, b) => Number(b.exactEvent) - Number(a.exactEvent)).slice(0, 1);
  const products = [];
  for (const candidate of targetRows) {
    const raw = candidate.raw;
    const detailUrl = `${ORIGIN}/Product/PackageDetail?MenuCode=101&proCode=${encodeURIComponent(candidate.productCode)}`;
    const detailResponse = await record(`detail-${slug}-${candidate.productCode}`, detailUrl, { accept: 'text/html,application/xhtml+xml,*/*;q=0.8', headers: { referer: `${ORIGIN}/Product/PackageList?MenuCode=${menu.menuCode}` } });
    const detail = parseVerygoodDetail(detailResponse.text);
    if (detail.sellerDepartureId !== candidate.productCode || detail.departureDate !== candidate.date) continue;
    const calendarUrl = `${ORIGIN}/Product/ProductCalendarSearch?${new URLSearchParams({ MasterCode: raw.masterCode, MenuCode: '101', Year: center.slice(0, 4), Month: center.slice(5, 7) })}`;
    const calendarResponse = await record(`calendar-${slug}-${raw.masterCode}`, calendarUrl, { accept: 'text/html,application/xhtml+xml,*/*;q=0.8', headers: { referer: detailUrl } });
    const calendar = parseVerygoodCalendar(calendarResponse.text);
    const airUrl = `${ORIGIN}/Product/ProductAirScheduleSearch?${new URLSearchParams({ ProCode: candidate.productCode })}`;
    const airResponse = await record(`air-${slug}-${candidate.productCode}`, airUrl, { accept: 'text/html,application/xhtml+xml,*/*;q=0.8', headers: { referer: detailUrl } });
    const airSchedule = parseVerygoodAirSchedule(airResponse.text);
    const base = parsed.find((p) => p.sellerProductId === raw.masterCode);
    const calendarEvent = calendar.events.find((event) => event.sellerDepartureId?.includes(candidate.productCode));
    const cell = calendar.dateCells.find((day) => day.date === candidate.date);
    const basePriceKrw = candidate.exactEvent ? Number(raw.eventPrice) : calendarEvent?.basePriceKrw ?? null;
    const departure = {
      ...(base?.departures?.find((item) => item.sellerDepartureId === raw.eventProCode) ?? {}),
      sellerDepartureId: candidate.productCode,
      departureDate: candidate.date,
      departureAt: detail.departureAt,
      returnAt: detail.returnAt,
      basePriceKrw: Number.isFinite(basePriceKrw) ? basePriceKrw : null,
      priceBasis: candidate.exactEvent ? 'dated_event_price' : calendarEvent?.priceBasis ?? null,
      fuelIncluded: detail.fuelIncluded,
      fuelSurchargeKrw: detail.fuelSurchargeKrw,
      fuelChangeCaveat: detail.fuelChangeCaveat,
      taxesIncluded: detail.taxesIncluded,
      airportTaxIncluded: detail.airportTaxIncluded,
      taxInclusionText: detail.taxInclusionText,
      localFees: detail.localFees,
      localFeeCandidates: detail.localFeeCandidates,
      localFeesComplete: false,
      mandatoryOptions: detail.mandatoryOptions,
      mandatoryOptionsComplete: false,
      discounts: null,
      singleSupplementKrw: detail.singleSupplementKrw,
      guaranteed: detail.guaranteed,
      seatsLeft: detail.seatsLeft,
      observedAt: detailResponse.meta?.checkedAt ?? null,
      calendarPriceFromKrw: cell?.priceFromKrw ?? null,
      raw: { listRow: raw, detailCandidatePriceKrw: detail.detailPriceCandidateKrw, reservationCountRaw: detail.reservationCountRaw, minimumDepartureCountRaw: detail.minimumDepartureCountRaw },
    };
    products.push({
      ...base,
      title: raw.masterName ?? raw.eventName ?? base?.title ?? null,
      destinationText: [raw.masterName, raw.eventName, raw.packageSummary, raw.packageComment, raw.masterKeyword, raw.koreaName].filter(Boolean).join(' '),
      nights: detail.nights ?? base?.nights ?? null,
      days: detail.days ?? base?.days ?? null,
      destinationCitySet: null,
      departureAirport: null,
      departureAirportText: detail.departureAirportText ?? base?.departureAirportText ?? null,
      departureAt: detail.departureAt,
      returnAt: detail.returnAt,
      airlineName: detail.airlineName ?? base?.airlineName ?? null,
      airlineClass: null,
      directness: null,
      hotelGradeBand: detail.hotelGradeBand ?? null,
      shoppingStopBand: detail.shoppingStopBand,
      summaryPriceMinKrw: Number.isFinite(Number(raw.lowPrice)) ? Number(raw.lowPrice) : null,
      summaryPriceMaxKrw: Number.isFinite(Number(raw.highPrice)) ? Number(raw.highPrice) : null,
      departures: [departure],
      detail,
      calendar,
      airSchedule,
      itinerary: detail.itinerary,
      raw: { listRow: raw, evidence: { detailCapture: detailResponse.meta?.capture ?? null, calendarCapture: calendarResponse.meta?.capture ?? null, airCapture: airResponse.meta?.capture ?? null } },
    });
  }
  return {
    schemaVersion: 1,
    sourceId: 'verygood-package',
    checkedAt: new Date().toISOString(),
    anchorDate: center,
    windowDays,
    destination: term,
    destinationMenu: { menuCode: menu.menuCode, menuName: menu.menuName, pathName: menu.pathName },
    verdict: products.length ? 'usable_limited' : 'no_dated_products_in_window',
    requestCount: requests.length,
    requests,
    filters,
    products,
    fieldCoverage: {
      observed: ['sellerProductId', 'title', 'summary price range', 'dated event price when present', 'duration', 'airline label and times from detail', 'hotel grade claim', 'shopping count', 'fuel inclusion wording', 'guide/driver amount candidate when shown', 'calendar date-cell from-price', 'calendar event price when shown'],
      unresolved: ['exact all-in mandatory cost', 'fuel amount', 'mandatory status of excluded guide/driver amount', 'seats left', 'guaranteed departure status', 'selected hotel property', 'mandatory option amounts', 'single supplement', 'operating airline class', 'normalized city set'],
    },
  };
}

export { parseVerygoodList };
