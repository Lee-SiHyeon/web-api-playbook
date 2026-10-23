import { readPublic } from '../probes/anonymous-http.mjs';

const ORIGIN = 'https://papi.ybtour.co.kr';
const DESTINATIONS = new Map([
  ['다낭', { menuCode: 'AABF000', aliases: ['다낭', '호이안', '후에'] }],
  ['나트랑', { menuCode: 'AABE000', aliases: ['나트랑', '달랏', '무이네', '판랑', '퀴논'] }],
]);

const text = (v) => typeof v === 'string' && v.trim() ? v.trim() : null;
const number = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[\s,₩원]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const positive = (v) => { const n = number(v); return n !== null && n > 0 ? n : null; };
const nonnegative = (v) => { const n = number(v); return n !== null && n >= 0 ? n : null; };
const dateOnly = (v) => {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  if (!m) return null;
  const d = `${m[1]}-${m[2]}-${m[3]}`;
  return !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d ? d : null;
};
const asInput = (input) => typeof input === 'string' ? JSON.parse(input) : input;

function envelope(input, name, allowObjectBody = false) {
  const payload = asInput(input);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.code !== '0000'
      || !Object.hasOwn(payload, 'body')) throw new TypeError(`invalid Yellowballoon ${name} envelope`);
  const b = payload.body;
  if (!(Array.isArray(b) || (allowObjectBody && b && typeof b === 'object'))) {
    throw new TypeError(`invalid Yellowballoon ${name} body`);
  }
  return b;
}

function bodyRows(input, name) {
  const b = envelope(input, name, true);
  return Array.isArray(b) ? b : [b];
}

function stripPrivateContacts(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const copy = { ...row };
  for (const key of ['mgmUserInfo', 'mgmUserNm', 'mgmDeptNm', 'phoneDirect', 'mgmUserTelNo', 'mgmUserEmail']) delete copy[key];
  return copy;
}

function destinationCities(route, destination) {
  if (typeof route !== 'string') return null;
  const known = DESTINATIONS.get(destination)?.aliases ?? [];
  const cities = known.filter((city) => route.includes(city));
  return cities.length ? [...new Set(cities)] : null;
}

function duration(raw) {
  const s = text(raw?.dayStayInfo);
  const m = s?.match(/(\d+)\s*박\s*(\d+)\s*일/u);
  return { nights: m ? Number(m[1]) : positive(raw?.nightCnt), days: m ? Number(m[2]) : positive(raw?.dayCnt) };
}

function baseProduct(item, destination) {
  const route = text(item.goodsTourInfo);
  return {
    sellerId: 'yellowballoon-package',
    sellerProductId: text(item.goodsCd),
    title: text(item.goodsNm),
    destinationText: [route, item.goodsNm, item.keyWordList].filter(Boolean).join(' '),
    destinationCitySet: destinationCities(route, destination),
    nights: null,
    days: null,
    departureAirport: null,
    departureAirportText: text(item.outCityDiviNm),
    airlineName: null,
    airlineNamesSummaryText: text(item.airName),
    airlineClass: null,
    directness: null,
    hotelGradeBand: null,
    shoppingStopBand: null,
    summaryPriceMinKrw: positive(item.minPrice),
    summaryPriceMaxKrw: positive(item.maxPrice),
    durationOptionsDays: typeof item.evDayCntList === 'string' ? item.evDayCntList.split(',').map(positive).filter(Boolean) : [],
    hotelMarketingText: text(item.goodsFeaturesList),
    inclusionMarketingText: text(item.goodsTpointContents),
    raw: item,
    departures: [],
  };
}

/** Parse the anonymous `/pkg/goods/by-menu/{menuCode}` list response. */
export function parseYellowballoonList(input, { destination = '다낭' } = {}) {
  if (!DESTINATIONS.has(destination)) throw new TypeError('destination must be 다낭 or 나트랑');
  return envelope(input, 'list').map((item) => {
    const p = baseProduct(item, destination);
    const dates = [...new Set(String(item.outStartDateList ?? '').split(',').map(dateOnly).filter(Boolean))];
    return { ...p, departures: dates.map((departureDate) => blankDeparture(departureDate, item)) };
  });
}

function blankDeparture(departureDate, raw) {
  return {
    sellerDepartureId: null,
    departureDate,
    departureAt: null,
    returnAt: null,
    basePriceKrw: null,
    priceBasis: null,
    fuelSurchargeKrw: null,
    fuelIncluded: null,
    airportTaxKrw: null,
    airportTaxIncluded: null,
    localFees: null,
    localFeesComplete: false,
    mandatoryOptions: null,
    mandatoryOptionsComplete: false,
    discounts: null,
    singleSupplementKrw: null,
    guaranteed: null,
    seatsLeft: null,
    raw,
  };
}

/** Parse per-day rows from recent-event or by-goods month responses. */
export function parseYellowballoonEventRows(input, { source = 'calendar' } = {}) {
  const rows = bodyRows(input, source);
  return rows.map((row) => {
    const fare = nonnegative(row.adtPrice);
    const tax = nonnegative(row.airTaxAdtPrice ?? row.airTaxAdtCost);
    const fuel = nonnegative(row.bafAdtPrice ?? row.bafAdtCost);
    const completeSum = fare !== null && tax !== null && fuel !== null ? fare + tax + fuel : null;
    const tripDuration = duration(row);
    return {
    sellerDepartureId: text(row.evCd),
    departureDate: dateOnly(row.evStartDt ?? row.outStartDt ?? row.departureDate),
    nights: tripDuration.nights,
    days: tripDuration.days,
    departureAirport: text(row.outCityDiviNm),
    airlineName: text(row.trCompanyNm),
    departureAt: formatTime(row.outDeprtTm),
    returnDate: dateOnly(row.evArriveDt ?? row.inArriveDt),
    returnAt: formatTime(row.inArrvTm),
    basePriceKrw: completeSum,
    basicFareComponentKrw: fare,
    priceBasis: completeSum !== null ? 'dated_calendar_price' : null,
      rawPriceComponents: {
        adultPrice: fare,
        airTaxAdultPrice: tax,
        fuelAdultPrice: fuel,
        advertisedCalendarSum: completeSum,
      },
      basePriceIncludedComponents: completeSum === null ? null : ['adult_fare', 'airport_tax', 'fuel_surcharge'],
    fuelSurchargeKrw: fuel,
    // The UI's calendar adds adult price, air tax and BAF for its displayed sum;
    // preserve the separately quoted BAF and do not imply it is included in adtPrice.
      fuelIncluded: completeSum !== null ? true : null,
      airportTaxKrw: tax,
      airportTaxIncluded: completeSum !== null ? true : null,
    seatsLeft: null,
    availableBlockQuantityRaw: number(row.avlilBlockQty),
    reservationCountRaw: number(row.rervCnt),
    availabilityCodeRaw: text(row.evProgDivi),
    availabilityTextRaw: text(row.evProgDiviNm),
    guaranteed: null,
    localFees: null,
    localFeesComplete: false,
    mandatoryOptions: null,
    mandatoryOptionsComplete: false,
    discounts: null,
    singleSupplementKrw: null,
    raw: stripPrivateContacts(row),
  };
  });
}

/** Parse availability-calendar response while retaining unverified status codes. */
export function parseYellowballoonAvailability(input) {
  return bodyRows(input, 'availability').map((row) => ({
    date: dateOnly(row.evStartDt ?? row.outStartDt ?? row.date),
    eventCode: text(row.evCd),
    statusRaw: text(row.evProgDivi ?? row.status),
    blockQuantityRaw: number(row.avlilBlockQty),
    eventMonthList: row.eventMonthList ?? null,
    raw: row,
  }));
}

/** Parse `/option`; option mandatory status remains unknown unless explicitly returned. */
export function parseYellowballoonOptions(input) {
  const body = envelope(input, 'options', true);
  const candidates = [...(Array.isArray(body) ? body : []), ...(Array.isArray(body?.trafficList) ? body.trafficList : []), ...(Array.isArray(body?.accommodationList) ? body.accommodationList : [])];
  const options = candidates.map((row) => ({
    name: text(row.optionNm ?? row.optNm ?? row.name ?? row.trCompanyNm ?? row.accomNm),
    amount: number(row.optionAmt ?? row.optAmt ?? row.amount),
    currency: text(row.currency ?? row.expCurrCd),
    mandatory: [true, false].includes(row.mandatory) ? row.mandatory : ['Y', 'N'].includes(row.essentialYn) ? row.essentialYn === 'Y' : null,
    raw: row,
  }));
  return { options, mandatoryOptions: null, mandatoryOptionsComplete: false, raw: body };
}

/** Parse `/pkg/event/{evCd}`; event details may wrap one object or an array. */
export function parseYellowballoonEvent(input) {
  const body = envelope(input, 'event', true);
  const row = Array.isArray(body) ? body[0] : body;
  if (!row || typeof row !== 'object') throw new TypeError('empty Yellowballoon event body');
  const durationInfo = duration(row);
  const currency = text(row.expCurrCd);
  const localFees = ['guideExpAmt', 'driverAmt'].flatMap((key) => {
    const amount = positive(row[key]);
    return amount === null ? [] : [{ kind: key === 'guideExpAmt' ? 'guide_expense' : 'driver_expense', amount, currency, amountKrw: currency === 'KRW' ? amount : null, mandatory: null, sourceField: key }];
  });
  return {
    eventCode: text(row.evCd),
    departureDate: dateOnly(row.evStartDt),
    returnDate: dateOnly(row.evArriveDt),
    departureAt: formatTime(row.outDeprtTm),
    returnAt: formatTime(row.inArrvTm),
    duration: durationInfo,
    departureAirport: text(row.outDepartCityNm),
    arrivalAirport: text(row.inArrvCityNm),
    airlineName: text(row.trCompanyNm ?? row.outFlightNm),
    shoppingCountRaw: number(row.shopCnt),
    singleSupplementKrw: positive(row.singleChagAmt),
    guideExpenseRaw: number(row.guideExpAmt),
    driverExpenseRaw: number(row.driverAmt),
    expenseCurrencyRaw: currency,
    hotelNameRaw: text(row.accomNm),
    hotelGradeClaimRaw: text(row.accomGradeNm ?? row.goodsFeaturesList),
    mealsAndInclusionsRaw: text(row.goodsContents ?? row.inclInfo),
    itineraryRaw: row.goodsScheduleList ?? row.scheduleList ?? row.keypointContList ?? null,
    flightsRaw: [
      { direction: 'outbound', flightCode: text(row.outFlightNm), departureDate: dateOnly(row.evStartDt), departureTime: formatTime(row.outDeprtTm), arrivalAirport: text(row.outArrvCityNm), arrivalTime: formatTime(row.outArrvTm) },
      { direction: 'inbound', flightCode: text(row.inFlightNm), departureDate: dateOnly(row.evArriveDt), departureTime: formatTime(row.inDeprtTm), arrivalAirport: text(row.inArrvCityNm), arrivalTime: formatTime(row.inArrvTm) },
    ],
    hotelGradeClaimRaw: Array.isArray(row.keypointContList) ? row.keypointContList.map((x) => x.kpointCont).filter(Boolean).join('\n') : text(row.goodsFeaturesList),
    rawAvailability: { webStartConfYn: row.webStartConfYn, fixRervCd: row.fixRervCd, evProgDivi: row.evProgDivi, evProgDiviNm: row.evProgDiviNm, avlilBlockQty: row.avlilBlockQty, rervCnt: row.rervCnt },
    localFees,
    localFeesComplete: false,
    raw: stripPrivateContacts(row),
  };
}

function formatTime(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{2}):?(\d{2})$/);
  return m ? `${m[1]}:${m[2]}` : null;
}

function listDateMatches(item, anchor, windowDays) {
  const center = Date.parse(`${anchor}T00:00:00Z`);
  return String(item.outStartDateList ?? '').split(',').map(dateOnly).filter(Boolean)
    .filter((d) => Math.abs(Date.parse(`${d}T00:00:00Z`) - center) <= windowDays * 86400000);
}

function nearest(rows, anchor) {
  return [...rows].filter((r) => r.departureDate && r.sellerDepartureId).sort((a, b) =>
    Math.abs(Date.parse(`${a.departureDate}T00:00:00Z`) - Date.parse(`${anchor}T00:00:00Z`))
    - Math.abs(Date.parse(`${b.departureDate}T00:00:00Z`) - Date.parse(`${anchor}T00:00:00Z`)))[0] ?? null;
}

function inWindow(date, anchor, windowDays) {
  if (!date) return false;
  return Math.abs(Date.parse(`${date}T00:00:00Z`) - Date.parse(`${anchor}T00:00:00Z`)) <= windowDays * 86400000;
}

function blocked(result) {
  return Boolean(result.meta.error) || result.meta.status === 401 || result.meta.status === 403
    || result.meta.status === 418 || result.meta.status === 429
    || /captcha|verify you are human|bot detection|attention required|cf-chl-|challenge-platform|cf-turnstile|checking your browser/i.test(result.text);
}

/** Public read-only package detail collection. Maximum 40 requests for this seller run. */
export async function collectYellowballoonLive({ destination = '다낭', anchor, windowDays = 3, requestBudget = 40, maxProductsPerDestination = 1, readImpl = readPublic } = {}) {
  if (destination !== 'both' && !DESTINATIONS.has(destination)) throw new TypeError('destination must be 다낭, 나트랑, or both');
  if (!dateOnly(anchor) || dateOnly(anchor) !== anchor) throw new TypeError('anchor must be YYYY-MM-DD');
  const budget = Math.min(40, Math.max(1, Number(requestBudget) || 40));
  const startedAt = new Date().toISOString();
  const destinations = destination === 'both' ? ['다낭', '나트랑'] : [destination];
  const requests = [];
  const products = [];
  const byDestination = {};
  let stopReason = null;

  async function get(dest, name, path, parser) {
    if (requests.length >= budget || stopReason) return null;
    const url = `${ORIGIN}${path}`;
    const result = await readImpl('yellowballoon-package', name, url, { method: 'GET', accept: 'application/json' });
    const record = { destination: dest, name, method: 'GET', url, checkedAt: result.meta.checkedAt, status: result.meta.status, contentType: result.meta.contentType,
      bytes: result.meta.bytes, sha256: result.meta.sha256, capture: result.meta.capture, metaCapture: `${result.meta.capture?.replace(/\.(?:json|html|js)$/, '')}.meta.json`, error: result.meta.error ?? null };
    requests.push(record);
    if (blocked(result)) {
      record.verdict = 'challenge_or_request_blocked';
      stopReason = 'challenge_or_request_blocked';
      return null;
    }
    if (result.meta.status < 200 || result.meta.status >= 300) { record.verdict = `http_${result.meta.status}`; return null; }
    try {
      const payload = JSON.parse(result.text);
      record.validJsonEnvelope = true;
      const parsed = parser(payload);
      record.verdict = 'usable';
      return { payload, parsed, record };
    } catch (error) {
      record.verdict = 'endpoint_error';
      record.parseError = error.message;
      return null;
    }
  }

  for (const dest of destinations) {
    const cfg = DESTINATIONS.get(dest);
    const list = await get(dest, 'list', `/pkg/goods/by-menu/${cfg.menuCode}`, (x) => parseYellowballoonList(x, { destination: dest }));
    if (!list) { byDestination[dest] = { menuCode: cfg.menuCode, products: [] }; continue; }
    const items = envelope(list.payload, 'list');
    const candidates = items.filter((item) => listDateMatches(item, anchor, windowDays).length)
      .sort((a, b) => (positive(a.minPrice) ?? Infinity) - (positive(b.minPrice) ?? Infinity))
      .slice(0, Math.max(1, Math.min(2, Number(maxProductsPerDestination) || 1)));
    const productRows = [];
    for (const item of candidates) {
      if (stopReason || requests.length >= budget) break;
      const base = list.parsed.find((p) => p.sellerProductId === item.goodsCd);
      if (!base) continue;
      const goodsCd = encodeURIComponent(item.goodsCd);
      const month = anchor.slice(0, 7).replace('-', '');
      const availability = await get(dest, `availability-${goodsCd}`, `/pkg/goods/${goodsCd}/available-date/day`, parseYellowballoonAvailability);
      const recent = await get(dest, `recent-${goodsCd}`, `/pkg/goods/${goodsCd}/recent-event/amt?startDate=${anchor.replaceAll('-', '')}`,
        (x) => parseYellowballoonEventRows(x, { source: 'recent event' }));
      const options = await get(dest, `options-${goodsCd}`, `/pkg/goods/${goodsCd}/option`, parseYellowballoonOptions);
      const joined = await get(dest, `joined-${goodsCd}`, `/pkg/goods/join-event/${goodsCd}`, (x) => envelope(x, 'joined events', true));
      const calendar = await get(dest, `by-goods-${goodsCd}`, `/pkg/event/by-goods/${goodsCd}/${cfg.menuCode}/${month}`,
        (x) => parseYellowballoonEventRows(x, { source: 'by-goods month' }));

      const dedup = new Map();
      for (const row of recent?.parsed ?? []) if (row.departureDate && inWindow(row.departureDate, anchor, windowDays)) {
        dedup.set(row.sellerDepartureId ?? row.departureDate, row);
      }
      // The by-goods calendar is authoritative for its dated fare and itinerary
      // fields, including dayStayInfo; a recent-event summary must not replace them.
      for (const row of calendar?.parsed ?? []) if (row.departureDate && inWindow(row.departureDate, anchor, windowDays)) {
        dedup.set(row.sellerDepartureId ?? row.departureDate, row);
      }
      let departures = [...dedup.values()].sort((a, b) => a.departureDate.localeCompare(b.departureDate));
      // A singleton recent-event response can point at a different airline
      // variant on the same date. Use the dated month calendar as the detail
      // target when available so the event code remains tied to that row.
      const representative = nearest(calendar?.parsed ?? [], anchor) ?? nearest(departures, anchor);
      let detail = null;
      if (representative && requests.length < budget) {
        const ev = await get(dest, `event-${representative.sellerDepartureId}`, `/pkg/event/${encodeURIComponent(representative.sellerDepartureId)}`, parseYellowballoonEvent);
        detail = ev?.parsed ?? null;
      }
      const optionRows = options?.parsed?.options ?? [];
      departures = departures.map((row) => {
        const optionHasKnownRequired = optionRows.some((o) => o.mandatory === true);
        const mandatoryOptions = optionRows.filter((o) => o.mandatory === true).map((o) => ({ name: o.name, amount: o.amount, currency: o.currency, amountKrw: o.currency === 'KRW' ? o.amount : null, eligible: true }));
        const extra = detail && detail.eventCode === row.sellerDepartureId ? detail : null;
        const statusText = extra?.rawAvailability?.evProgDiviNm ?? row.availabilityTextRaw;
        const stopsOut = number(extra?.raw?.outStovCnt);
        const stopsIn = number(extra?.raw?.inStovCnt);
        return {
          ...blankDeparture(row.departureDate, row.raw),
          ...row,
          fuelSurchargeKrw: row.fuelSurchargeKrw ?? (extra ? nonnegative(extra.raw?.bafAdtCost) : null),
          airportTaxKrw: row.airportTaxKrw ?? (extra ? nonnegative(extra.raw?.airTaxAdtCost) : null),
          basicFareComponentKrw: row.basicFareComponentKrw ?? (extra ? nonnegative(extra.raw?.adtPrice) : null),
          localFees: extra?.localFees?.length ? extra.localFees : null,
          localFeesComplete: false,
          mandatoryOptions: optionHasKnownRequired ? mandatoryOptions : null,
          mandatoryOptionsComplete: optionRows.length > 0 && optionRows.every((o) => o.mandatory !== null),
          discounts: null,
          singleSupplementKrw: extra?.singleSupplementKrw ?? null,
          shoppingCountRaw: extra?.shoppingCountRaw ?? null,
          hotelNameRaw: extra?.hotelNameRaw ?? null,
          hotelGradeClaimRaw: extra?.hotelGradeClaimRaw ?? null,
          flightDetailsRaw: extra?.flightsRaw ?? null,
          eventItineraryRaw: extra?.itineraryRaw ?? null,
          guaranteed: null,
          bookable: statusText === '예약마감' ? false : null,
          seatsLeft: null,
          detailRaw: extra?.raw ?? null,
          optionsRaw: optionRows.map((o) => o.raw),
          availabilityEvidence: availability?.parsed ?? [],
          directness: stopsOut !== null && stopsIn !== null ? (stopsOut + stopsIn === 0 ? 'direct' : 'connecting') : null,
          stopoverCountRaw: { outbound: stopsOut, inbound: stopsIn },
        };
      });
      const joinedBody = joined?.parsed && !Array.isArray(joined.parsed) ? joined.parsed : null;
      const product = {
        ...base,
        hotelGradeBand: null,
        hotelGradeClaim: base.hotelMarketingText,
        shoppingStopBand: null,
        itinerary: joinedBody ? {
          summaryText: text(joinedBody?.goodsContents),
          inclusionMarketingText: text(joinedBody?.goodsTpointContents),
          hotels: [],
          hotelGradeClaim: text(joinedBody?.goodsFeaturesList),
          flights: null,
          highlights: null,
          dayByDay: null,
          mealsIncluded: text(joinedBody?.goodsContents),
        } : null,
        departures,
        detailCoverage: {
          availability: Boolean(availability), recentEvents: Boolean(recent), options: Boolean(options), joinedEvents: Boolean(joined), byGoodsMonth: Boolean(calendar), representativeEvent: Boolean(detail),
          localFeesComplete: false, mandatoryOptionsComplete: departures.some((d) => d.mandatoryOptionsComplete), discountsVerified: false,
        },
        rawEvidence: { list: item, availability: availability?.payload ?? null, recentEvents: recent?.payload ?? null, options: options?.payload ?? null, joinedEvents: joined?.payload ?? null, byGoodsMonth: calendar?.payload ?? null, representativeEvent: detail?.raw ?? null },
      };
      productRows.push(product);
      products.push(product);
    }
    byDestination[dest] = { menuCode: cfg.menuCode, listedProductCount: items.length, products: productRows };
  }
  return {
    schemaVersion: 1,
    sellerId: 'yellowballoon-package',
    seller: '노랑풍선',
    destination,
    anchor,
    windowDays,
    startedAt,
    window: { from: new Date(Date.parse(`${anchor}T00:00:00Z`) - windowDays * 86400000).toISOString().slice(0, 10), through: new Date(Date.parse(`${anchor}T00:00:00Z`) + windowDays * 86400000).toISOString().slice(0, 10) },
    checkedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    verdict: stopReason ?? (products.length ? 'usable_limited' : 'empty_result'),
    requestCount: requests.length,
    requestBudget: budget,
    requests,
    products,
    byDestination,
    fieldMappings: {
      productId: 'list.body[].goodsCd', title: 'goodsNm', destinationRoute: 'goodsTourInfo; only recognized destination cities are retained',
      summaryPriceKrw: 'list.minPrice/maxPrice (undated only)', datedPrice: 'by-goods.body[].adtPrice + airTaxAdtPrice + bafAdtPrice; all three must be observed; matches page calendar sum calculation',
      fuelSurchargeKrw: 'by-goods.body[].bafAdtPrice; already included in basePriceKrw advertised sum; fuelIncluded=true only when all sum components are numeric',
      airportTaxKrw: 'by-goods.body[].airTaxAdtPrice; included in basePriceKrw advertised sum',
      localFees: 'event.body.guideExpAmt + driverAmt with expCurrCd; candidate costs, mandatory status unknown, localFeesComplete=false',
      mandatoryOptions: 'option.body trafficList/accommodationList are filter candidates with no price/mandatory field; normalized mandatoryOptions stays null',
      guaranteed: 'event.webStartConfYn/fixRervCd retained raw; no normalized guarantee mapping',
      seatsLeft: 'avlilBlockQty/rervCnt retained raw; seatsLeft stays null',
      itinerary: 'joined-event.goodsContents/goodsTpointContents are seller marketing/inclusion text; structured day-by-day itinerary remains unknown',
      flight: 'event outFlightNm/inFlightNm, city names, HHmm times; stopover counts used for directness only when both are numeric',
    },
    fieldCoverage: {
      recovered: ['sellerProductId','title','destinationCitySet candidate','dated departure dates and event IDs','calendar adult price/tax/BAF components','airport tax','outbound/inbound flight code and time','departure airport','duration','guide/driver expense candidates with raw currency','single supplement when reported','seller inclusion text'],
      partiallyRecovered: ['local fees (mandatory status and completeness unknown)','itinerary (seller inclusion/marketing text only)','option candidates (no priced mandatory options observed)','hotel grade (seller claim, not exact property grade)'],
      unknown: ['discount eligibility and amount','guaranteed departure','seats left','complete mandatory local fees','exact selected hotel/property','airline class','tax checkout treatment beyond advertised calendar sum'],
    },
    limitations: [
      'Public anonymous reads only; no cookies, credentials, POSTs, or remote mutations.',
      'Calendar base price is the seller UI advertised sum of adult fare, air tax and BAF; these components are retained separately and BAF is already included in basePriceKrw.',
      'Discounts, guaranteed status, exact hotel grade and complete mandatory local costs remain unknown unless the response explicitly establishes them. Availability quantities are not treated as seats left.',
      'One summary-price-selected product with departures in the requested window is enriched per destination; list min/max remain undated product summaries.',
    ],
  };
}
