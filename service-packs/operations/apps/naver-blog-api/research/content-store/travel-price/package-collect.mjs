import { pathToFileURL } from 'node:url';
import { readPublic } from './probes/anonymous-http.mjs';

const VERYGOOD_ORIGIN = 'https://www.verygoodtour.com';
const YELLOW_ORIGIN = 'https://papi.ybtour.co.kr';
const LOTTE_ORIGIN = 'https://www.lottetour.com';
const TARGET_DESTINATION = '\uB2E4\uB0AD';
const DESTINATION_ALIASES = new Map([
  [TARGET_DESTINATION, [TARGET_DESTINATION, 'danang', 'da nang']],
  ['나트랑', ['나트랑', '냐짱', 'nha trang', 'nhatrang']],
  ['오사카', ['오사카', 'osaka']],
]);
const FORBIDDEN_HEADER = /cookie|authorization|token|api[-_]?key|session/i;
const CLUSTER_DIMENSIONS = [
  'destinationCitySet', 'nights', 'days', 'departureAirport', 'airlineClass',
  'directness', 'hotelGradeBand', 'shoppingStopBand',
];
const CITY_IDS = new Map([
  ['다낭', 'VN-DAD'], ['da nang', 'VN-DAD'], ['danang', 'VN-DAD'], ['dad', 'VN-DAD'], ['vn-dad', 'VN-DAD'],
  ['호이안', 'VN-HOI'], ['hoi an', 'VN-HOI'], ['hoian', 'VN-HOI'], ['vn-hoi', 'VN-HOI'],
  ['후에', 'VN-HUE'], ['hue', 'VN-HUE'], ['vn-hue', 'VN-HUE'],
  ['나트랑', 'VN-NHA'], ['냐짱', 'VN-NHA'], ['nha trang', 'VN-NHA'], ['nhatrang', 'VN-NHA'], ['vn-nha', 'VN-NHA'],
  ['달랏', 'VN-DLI'], ['da lat', 'VN-DLI'], ['dalat', 'VN-DLI'], ['vn-dli', 'VN-DLI'],
]);

function objectPayload(payload) {
  if (typeof payload === 'string') return JSON.parse(payload);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('expected a JSON object');
  return payload;
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[\s,₩원]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function priceKrw(value) {
  const n = numeric(value);
  return n !== null && n > 0 ? n : null;
}

function nonnegativeKrw(value) {
  const n = numeric(value);
  return n !== null && n >= 0 ? n : null;
}

function dateOnly(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  const m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date ? null : date;
}

function positiveInt(value) {
  const n = numeric(value);
  return n !== null && Number.isInteger(n) && n > 0 ? n : null;
}

function durationFromVerygood(value) {
  const m = typeof value === 'string' && value.match(/(\d+)\s*박\s*(\d+)\s*일/u);
  return m ? { nights: positiveInt(m[1]), days: positiveInt(m[2]) } : { nights: null, days: null };
}

function costUnknowns() {
  return {
    fuelSurchargeKrw: null,
    fuelIncluded: null,
    localFees: null,
    mandatoryOptions: null,
    discounts: null,
    singleSupplementKrw: null,
    guaranteed: null,
    seatsLeft: null,
  };
}

function productBase({ sellerId, sellerProductId, title, destinationText, raw }) {
  return {
    sellerId,
    sellerProductId: text(sellerProductId),
    title: text(title),
    destinationText: text(destinationText),
    destinationCitySet: null,
    nights: null,
    days: null,
    departureAirport: null,
    departureAirportText: null,
    airlineName: null,
    airlineClass: null,
    directness: null,
    hotelGradeBand: null,
    shoppingStopBand: null,
    summaryPriceMinKrw: null,
    summaryPriceMaxKrw: null,
    raw,
  };
}

function dateVariant(date, basePriceKrw, priceBasis, raw) {
  return {
    sellerDepartureId: null,
    departureDate: date,
    departureAt: null,
    returnAt: null,
    basePriceKrw,
    priceBasis,
    ...costUnknowns(),
    raw,
  };
}

/** Parse only fields evidenced in the captured Verygood list response. */
export function parseVerygood(input) {
  const payload = objectPayload(input);
  const packageListShape = Array.isArray(payload.packageList);
  const hasPriceBounds = Object.hasOwn(payload, 'lowPrice') && Object.hasOwn(payload, 'highPrice');
  const successShape = payload.code === '0000' && packageListShape;
  if (!packageListShape || (!hasPriceBounds && !successShape)) throw new TypeError('invalid Verygood list response envelope');
  const items = payload.packageList;
  return items.map((item) => {
    const duration = durationFromVerygood(item.tourNightDay);
    const product = productBase({
      sellerId: 'verygood-package',
      sellerProductId: item.masterCode,
      title: item.masterName ?? item.eventName,
      destinationText: [item.masterName, item.eventName, item.packageSummary, item.packageComment, item.masterKeyword].filter(Boolean).join(' '),
      raw: item,
    });
    return {
      ...product,
      ...duration,
      departureAirportText: text(item.branchNameExt),
      airlineName: text(item.airlineName),
      summaryPriceMinKrw: priceKrw(item.lowPrice),
      summaryPriceMaxKrw: priceKrw(item.highPrice),
      hotelGradeSummaryText: text(item.hotelGradeSummary),
      departures: [
        {
          ...dateVariant(dateOnly(item.eventDepartureDate), priceKrw(item.eventPrice), dateOnly(item.eventDepartureDate) ? 'dated_event_price' : null, item),
          sellerDepartureId: text(item.eventProCode),
        },
      ],
    };
  });
}

/** Parse the verified Yellowballoon menu response; its min/max are product summaries, not dated fares. */
export function parseYellowballoon(input) {
  const payload = objectPayload(input);
  if (payload.code !== '0000' || !Array.isArray(payload.body)) throw new TypeError('invalid Yellowballoon list response envelope');
  const items = payload.body;
  return items.map((item) => {
    const product = productBase({
      sellerId: 'yellowballoon-package',
      sellerProductId: item.goodsCd,
      title: item.goodsNm,
      destinationText: [item.goodsTourInfo, item.goodsNm, item.keyWordList].filter(Boolean).join(' '),
      raw: item,
    });
    const dates = [...new Set(String(item.outStartDateList ?? '').split(',').map(dateOnly).filter(Boolean))];
    return {
      ...product,
      departureAirportText: text(item.outCityDiviNm),
      airlineName: text(item.airName),
      summaryPriceMinKrw: priceKrw(item.minPrice),
      summaryPriceMaxKrw: priceKrw(item.maxPrice),
      durationOptionsDays: typeof item.evDayCntList === 'string'
        ? item.evDayCntList.split(',').map(positiveInt).filter((n) => n !== null)
        : [],
      departures: (dates.length ? dates : [null]).map((date) => dateVariant(date, null, null, item)),
    };
  });
}

/** Parse the Lotte search JSON even when the server omits the JSON content type. */
export function parseLotte(input) {
  const payload = objectPayload(input);
  if (!Array.isArray(payload.ITEMS) || numeric(payload.TOTAL_CNT) === null) throw new TypeError('invalid Lotte list response envelope');
  const items = payload.ITEMS;
  return items.map((item) => ({
    ...productBase({
      sellerId: 'lotte-package',
      sellerProductId: item.god_id,
      title: item.god_nm1 ?? item.evt_nm1,
      destinationText: [item.area_sc_nm, item.city_list, item.god_nm1, item.evt_nm1, item.srchwd].filter(Boolean).join(' '),
      raw: item,
    }),
    nights: positiveInt(item.evt_night_cnt),
    days: positiveInt(item.evt_dt_cnt),
    departureAirportText: text(item.dep_place_nm),
    airlineName: text(item.carrer_nm),
    summaryPriceMinKrw: null,
    summaryPriceMaxKrw: null,
    hotelMarketingText: text(item.god_nm2),
    departures: [
      {
        ...dateVariant(dateOnly(item.dep_dt), priceKrw(item.price_adt), dateOnly(item.dep_dt) ? 'dated_adult_starting_price' : null, item),
        sellerDepartureId: text(item.evevt_cd ?? item.evt_seq),
        departureTimeRaw: text(item.depart_deptm),
        returnDate: dateOnly(item.arr_dt),
        returnTimeRaw: text(item.retn_deptm),
        airlineCodeRaw: text(item.carrer_abbr),
      },
    ],
  }));
}

function urlEncoded(pairs) {
  return new URLSearchParams(pairs).toString();
}

function verygoodBody(destination) {
  return urlEncoded([
    ['keyword', destination], ['menuCode', '101'], ['regionCode', ''], ['orderby', '1'],
    ['CfmYN', ''], ['depdate', ''], ['weekday', ''], ['day', ''], ['price', ''],
  ]);
}

function lotteQuery(destination) {
  return urlEncoded([
    ['kwd', destination], ['subkwd', ''], ['subdatekwd', ''], ['minprice', ''], ['maxprice', ''],
    ['checkdtcnt', ''], ['checkday', ''], ['checkcomm', ''], ['checkairline', ''], ['checkclass', ''],
    ['checkstatus', ''], ['calenderKwd', ''], ['pageSize', '10'], ['pageNum', '1'], ['selectKey', 'KEY'],
    ['startPrice', ''], ['endPrice', ''], ['category', 'globalpackage'], ['selectcategory', 'globalpackage'],
    ['subcategory', '857'],
  ]);
}

/** Fixed requests copied from each seller's verified public list contract. */
export function buildRequests(destination = TARGET_DESTINATION) {
  if (destination !== TARGET_DESTINATION) throw new Error('Only the verified Da Nang list request is allowlisted.');
  const lotteQueryString = lotteQuery(destination);
  const requests = [
    {
      seller: 'verygood-cluster',
      sourceId: 'verygood-package',
      method: 'POST',
      url: `${VERYGOOD_ORIGIN}/Product/GetPackageList?pageIndex=1&pageSize=15`,
      body: verygoodBody(destination),
      params: {
        pageIndex: '1', pageSize: '15',
        body: Object.fromEntries(new URLSearchParams(verygoodBody(destination))),
      },
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        accept: 'application/json, text/javascript, */*; q=0.01',
      },
      readContract: 'Verified public PackageList inline script: POST serialized #detail_search fields to /Product/GetPackageList?pageIndex=...&pageSize=.... keyword, menuCode, regionCode, orderby, CfmYN, depdate, weekday, day, price are observed form fields; date remains blank.',
      parse: parseVerygood,
    },
    {
      seller: 'yellowballoon-cluster',
      sourceId: 'yellowballoon-package',
      method: 'GET',
      url: `${YELLOW_ORIGIN}/pkg/goods/by-menu/AABF000`,
      params: { menuDisplayId: 'AABF000' },
      headers: { accept: 'application/json' },
      readContract: 'Verified anonymous public GET /pkg/goods/by-menu/AABF000; observed menu AABF000 is the Da Nang/Hoian/Hue package category.',
      parse: parseYellowballoon,
    },
    {
      seller: 'lotte-cluster',
      sourceId: 'lotte-package',
      method: 'GET',
      url: `${LOTTE_ORIGIN}/search/json?${lotteQueryString}`,
      params: Object.fromEntries(new URLSearchParams(lotteQueryString)),
      headers: { accept: 'application/json, text/javascript, */*; q=0.01' },
      readContract: 'Verified public GET /search/json. Query key set and blank search/date/filter fields follow the captured Lotte request; category=globalpackage, selectcategory=globalpackage, subcategory=857, pageSize=10, pageNum=1; kwd=Da Nang.',
      parse: parseLotte,
    },
  ];
  for (const request of requests) assertAllowlistedRequest(request);
  return requests;
}

function assertAllowlistedRequest(request) {
  const url = new URL(request.url);
  const allowed = request.sourceId === 'verygood-package'
    ? request.method === 'POST' && url.origin === VERYGOOD_ORIGIN && url.pathname === '/Product/GetPackageList'
      && url.search === '?pageIndex=1&pageSize=15' && request.body === verygoodBody(TARGET_DESTINATION)
    : request.sourceId === 'yellowballoon-package'
      ? request.method === 'GET' && url.origin === YELLOW_ORIGIN && url.pathname === '/pkg/goods/by-menu/AABF000' && !url.search
      : request.sourceId === 'lotte-package'
        ? request.method === 'GET' && url.origin === LOTTE_ORIGIN && url.pathname === '/search/json'
          && url.search === `?${lotteQuery(TARGET_DESTINATION)}`
        : false;
  if (!allowed) throw new Error(`request is outside the ${request.sourceId} read allowlist`);
  for (const name of Object.keys(request.headers ?? {})) {
    if (FORBIDDEN_HEADER.test(name)) throw new Error(`prohibited request header: ${name}`);
  }
  if (request.method === 'POST' && !request.readContract) throw new Error('POST lacks a verified read contract');
}

function classifyResponse(result) {
  if (result.meta.error) return 'transport_error';
  if (/captcha|verify you are (?:human|a person)|automated requests|bot detection|robot check|security check|attention required|cf-chl-|__cf_chl|challenge-platform|cf-turnstile|checking your browser/i.test(result.text)) {
    return 'challenge_blocked';
  }
  if (result.meta.status === 401) return 'login_or_key_required';
  if (result.meta.status === 403 || result.meta.status === 418) return 'endpoint_rejected';
  if (result.meta.status === 429) return 'rate_limited';
  if (result.meta.status === 503) return 'server_error';
  if (result.meta.status >= 400) return 'endpoint_error';
  return null;
}

function withinWindow(date, anchor, days) {
  if (!date) return false;
  const candidate = Date.parse(`${date}T00:00:00Z`);
  const center = Date.parse(`${anchor}T00:00:00Z`);
  return Number.isFinite(candidate) && Number.isFinite(center) && Math.abs(candidate - center) <= days * 86400000;
}

function normalizedSearchText(value) {
  return typeof value === 'string' ? value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, '') : '';
}

function matchesDestination(product, destination) {
  const aliases = DESTINATION_ALIASES.get(destination) ?? [destination];
  const haystack = normalizedSearchText(product.destinationText);
  return aliases.some((alias) => haystack.includes(normalizedSearchText(alias)));
}

function normalizedDimensionValue(row, name) {
  const value = row[name];
  if (name === 'destinationCitySet') {
    if (!Array.isArray(value) || value.length === 0 || value.some((v) => !text(v))) return null;
    return [...new Set(value.map((v) => CITY_IDS.get(text(v).toLowerCase()) ?? text(v)))].sort();
  }
  if (name === 'nights' || name === 'days') return positiveInt(value);
  if (name === 'hotelGradeBand') return ['3', '4', '5', 3, 4, 5].includes(value) ? String(value) : null;
  if (name === 'airlineClass') return ['FSC', 'LCC', 'mixed'].includes(value) ? value : null;
  if (name === 'directness') return ['direct', 'connecting', 'mixed'].includes(value) ? value : null;
  if (name === 'shoppingStopBand') return ['0', '1-2', '3+'].includes(value) ? value : null;
  return text(value);
}

function completeCosts(row) {
  const missing = [];
  if (priceKrw(row.basePriceKrw) === null) missing.push('basePriceKrw');
  if (typeof row.fuelIncluded !== 'boolean') missing.push('fuelIncluded');
  if (row.fuelIncluded === false && nonnegativeKrw(row.fuelSurchargeKrw) === null) missing.push('fuelSurchargeKrw');
  if (row.airportTaxIncluded !== true) missing.push('airportTaxIncluded');
  for (const key of ['localFees', 'mandatoryOptions', 'discounts']) {
    if (!Array.isArray(row[key])) missing.push(key);
  }
  // Explicit false wins over an array of the few costs successfully extracted.
  for (const key of ['localFeesComplete', 'mandatoryOptionsComplete']) {
    if (row[key] === false) missing.push(key);
  }
  if (Array.isArray(row.localFees) && row.localFees.some((fee) => nonnegativeKrw(fee.amountKrw) === null)) missing.push('localFees.amountKrw');
  if (Array.isArray(row.mandatoryOptions) && row.mandatoryOptions.some((option) => nonnegativeKrw(option.amountKrw) === null)) missing.push('mandatoryOptions.amountKrw');
  if (Array.isArray(row.discounts) && row.discounts.some((discount) => typeof discount.eligible !== 'boolean' || nonnegativeKrw(discount.amountKrw) === null)) missing.push('discounts.eligibility_or_amount');
  return [...new Set(missing)];
}

function truePayable(row) {
  let total = priceKrw(row.basePriceKrw) + (row.fuelIncluded ? 0 : nonnegativeKrw(row.fuelSurchargeKrw));
  for (const fee of row.localFees) total += nonnegativeKrw(fee.amountKrw);
  for (const option of row.mandatoryOptions) total += nonnegativeKrw(option.amountKrw);
  for (const discount of row.discounts) if (discount.eligible) total -= nonnegativeKrw(discount.amountKrw);
  return total;
}

/** Twin-share total; a partial cost extraction never becomes a zero-cost quote. */
export function calculateTruePayable(row) {
  const missing = completeCosts(row);
  const total = missing.length ? null : truePayable(row);
  if (total !== null && (!Number.isFinite(total) || total <= 0)) missing.push('positive_true_payable');
  return {
    perPersonTruePayableKrw: missing.length ? null : total,
    missingMandatoryCosts: missing,
    hiddenCosts: {
      fuelIncluded: row.fuelIncluded ?? null,
      fuelSurchargeKrw: row.fuelSurchargeKrw ?? null,
      airportTaxKrw: row.airportTaxKrw ?? null,
      airportTaxIncluded: row.airportTaxIncluded ?? null,
      localFees: row.localFees ?? null,
      mandatoryOptions: row.mandatoryOptions ?? null,
      discounts: row.discounts ?? null,
      singleSupplementKrw: row.singleSupplementKrw ?? null,
      fx: row.fx ?? null,
    },
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const center = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[center] : (sorted[center - 1] + sorted[center]) / 2;
}

/** Editorial scoring, with component coverage reported separately from the score. */
export function scorePackageQuality(row) {
  const itinerary = row.itinerary ?? row;
  const meals = typeof itinerary.mealsIncluded === 'number' ? itinerary.mealsIncluded
    : Array.isArray(itinerary.mealsIncluded) ? itinerary.mealsIncluded.filter(m => m === true || m?.included === true).length : null;
  const sights = Array.isArray(itinerary.sights) ? itinerary.sights.length : null;
  const freeTime = nonnegativeKrw(itinerary.freeTimeHours);
  const grade = normalizedDimensionValue(row, 'hotelGradeBand');
  const distance = nonnegativeKrw(itinerary.hotelCityCenterDistanceKm ?? row.hotelCityCenterDistanceKm);
  const shopping = normalizedDimensionValue(row, 'shoppingStopBand');
  const components = {
    meals: meals === null || !positiveInt(row.days) ? null : 15 * Math.min(1, meals / (row.days * 3)),
    sights: sights === null ? null : 20 * Math.min(1, sights / 5),
    freeTime: freeTime === null ? null : 15 * Math.min(1, freeTime / 12),
    hotel: grade === null ? null : Number(grade) * 3,
    location: distance === null ? null : distance <= 3 ? 15 : distance <= 10 ? 8 : 3,
    guaranteed: typeof row.guaranteed !== 'boolean' ? null : row.guaranteed ? 10 : 0,
    seats: nonnegativeKrw(row.seatsLeft) === null ? null : row.seatsLeft > 0 ? 10 : 0,
    shoppingPenalty: shopping === null ? null : shopping === '0' ? 0 : shopping === '1-2' ? 8 : 20,
  };
  const known = Object.values(components).filter(v => v !== null).length;
  const sum = Object.entries(components).reduce((s, [key, value]) => s + (value ?? 0) * (key === 'shoppingPenalty' ? -1 : 1), 0);
  return {
    qualityScore: Math.round(Math.max(0, Math.min(100, sum)) * 100) / 100,
    qualityCoverage: known / Object.keys(components).length,
    qualityComponents: components,
    qualityMissing: Object.entries(components).filter(([, value]) => value === null).map(([key]) => key),
    qualityMethod: 'editorial-v1; missing components contribute zero with coverage disclosed',
  };
}

function dimensionFingerprint(row) {
  const dimensions = Object.fromEntries(CLUSTER_DIMENSIONS.map((name) => [name, normalizedDimensionValue(row, name)]));
  return { dimensions, key: JSON.stringify(dimensions) };
}

/** Select date/destination rows locally, then apply ontology dimensions and cost gates. */
export function evaluateCluster(products, { destination = TARGET_DESTINATION, anchor, windowDays = 3 } = {}) {
  if (!dateOnly(anchor) || dateOnly(anchor) !== anchor) throw new TypeError('anchor must be YYYY-MM-DD');
  const selected = [];
  for (const product of products) {
    if (!matchesDestination(product, destination)) continue;
    for (const departure of product.departures ?? []) {
      if (!withinWindow(departure.departureDate, anchor, windowDays)) continue;
      selected.push({ ...product, ...departure });
    }
  }

  const excluded = [];
  const ready = [];
  for (const row of selected) {
    const missingDimensions = CLUSTER_DIMENSIONS.filter((name) => normalizedDimensionValue(row, name) === null);
    const payable = calculateTruePayable(row);
    const missingCosts = payable.missingMandatoryCosts;
    const reasons = [];
    if (priceKrw(row.basePriceKrw) === null || !['dated_event_price', 'dated_adult_starting_price', 'dated_calendar_price', 'dated_detail_price'].includes(row.priceBasis)) {
      reasons.push('dated_price_missing_or_summary_only');
    }
    if (missingDimensions.length) reasons.push('cluster_dimensions_unknown');
    if (missingCosts.length) reasons.push('mandatory_costs_unknown');
    if (row.seatsLeft === 0 || row.bookable === false) reasons.push('unavailable_departure');
    if (reasons.length) {
      const quality = scorePackageQuality(row);
      excluded.push({
        sellerId: row.sellerId,
        sellerProductId: row.sellerProductId,
        sellerDepartureId: row.sellerDepartureId,
        title: row.title,
        departureDate: row.departureDate,
        basePriceKrw: priceKrw(row.basePriceKrw),
        priceBasis: row.priceBasis,
        summaryPriceMinKrw: row.summaryPriceMinKrw,
        summaryPriceMaxKrw: row.summaryPriceMaxKrw,
        reasons,
        missingClusterDimensions: missingDimensions,
        missingMandatoryCosts: missingCosts,
        truePayableKrw: payable.perPersonTruePayableKrw,
        hiddenCosts: payable.hiddenCosts,
        ...quality,
        valueScore: payable.perPersonTruePayableKrw === null ? null : quality.qualityScore / (payable.perPersonTruePayableKrw / 100000),
        raw: row.raw,
      });
      continue;
    }
    const { dimensions, key } = dimensionFingerprint(row);
    const quality = scorePackageQuality(row);
    ready.push({ ...row, dimensions, dimensionKey: key, truePayableKrw: payable.perPersonTruePayableKrw,
      hiddenCosts: payable.hiddenCosts, ...quality,
      payablePerNightKrw: payable.perPersonTruePayableKrw / row.nights,
      valueScore: quality.qualityScore / (payable.perPersonTruePayableKrw / 100000),
    });
  }

  const groups = new Map();
  const productDepartures = new Map();
  for (const row of ready) {
    const key = JSON.stringify([row.sellerId, row.sellerProductId, row.dimensionKey]);
    if (!productDepartures.has(key)) productDepartures.set(key, []);
    productDepartures.get(key).push(row.truePayableKrw);
  }
  for (const row of ready) {
    const key = JSON.stringify([row.sellerId, row.sellerProductId, row.dimensionKey]);
    const productMedian = median(productDepartures.get(key));
    row.departureDatePositionPct = 100 * (row.truePayableKrw - productMedian) / productMedian;
    if (!groups.has(row.dimensionKey)) groups.set(row.dimensionKey, []);
    groups.get(row.dimensionKey).push(row);
  }
  const clusters = [...groups.values()].map((rows) => {
    const sellerIds = [...new Set(rows.map((row) => row.sellerId))].sort();
    const lowest = [...rows].sort((a, b) => a.truePayableKrw - b.truePayableKrw)[0] ?? null;
    // A seller with many dated variants must not dominate the cross-seller median.
    const sellerBestQuotes = sellerIds.map(sellerId => [...rows].filter(row => row.sellerId === sellerId)
      .sort((a, b) => a.truePayableKrw - b.truePayableKrw)[0]);
    const medianPayableKrw = median(sellerBestQuotes.map(row => row.truePayableKrw));
    return {
      dimensions: rows[0].dimensions,
      sellerCount: sellerIds.length,
      sellerIds,
      gateOpen: sellerIds.length >= 3,
      medianPayableKrw: sellerIds.length >= 3 ? medianPayableKrw : null,
      medianBasis: 'one minimum true payable per distinct seller within the anchor window',
      rawDepartureMedianPayableKrw: sellerIds.length >= 3 ? median(rows.map(row => row.truePayableKrw)) : null,
      lowest: sellerIds.length >= 3 && lowest ? {
        sellerId: lowest.sellerId,
        sellerProductId: lowest.sellerProductId,
        departureDate: lowest.departureDate,
        truePayableKrw: lowest.truePayableKrw,
        gapToMedianKrw: lowest.truePayableKrw - medianPayableKrw,
        gapToMedianPct: 100 * (lowest.truePayableKrw - medianPayableKrw) / medianPayableKrw,
        hiddenCosts: lowest.hiddenCosts,
        qualityScore: lowest.qualityScore,
        qualityCoverage: lowest.qualityCoverage,
        valueScore: lowest.valueScore,
      } : null,
      rows: rows.map((row) => ({
        sellerId: row.sellerId,
        sellerProductId: row.sellerProductId,
        departureDate: row.departureDate,
        truePayableKrw: row.truePayableKrw,
        qualityScore: row.qualityScore,
        qualityCoverage: row.qualityCoverage,
        valueScore: row.valueScore,
      })),
    };
  });
  return {
    destination,
    anchor,
    windowDays,
    window: {
      from: new Date(Date.parse(`${anchor}T00:00:00Z`) - windowDays * 86400000).toISOString().slice(0, 10),
      through: new Date(Date.parse(`${anchor}T00:00:00Z`) + windowDays * 86400000).toISOString().slice(0, 10),
    },
    selectedCount: selected.length,
    selectedRows: selected.map((row) => ({
      sellerId: row.sellerId,
      sellerProductId: row.sellerProductId,
      sellerDepartureId: row.sellerDepartureId,
      title: row.title,
      destinationText: row.destinationText,
      departureDate: row.departureDate,
      basePriceKrw: priceKrw(row.basePriceKrw),
      priceBasis: row.priceBasis,
      summaryPriceMinKrw: row.summaryPriceMinKrw,
      summaryPriceMaxKrw: row.summaryPriceMaxKrw,
      raw: row.raw,
    })),
    excluded,
    comparableRows: ready.map(({ dimensionKey, ...row }) => row),
    clusters,
    qualifyingClusterCount: clusters.filter(cluster => cluster.gateOpen).length,
    topClusters: clusters.filter(cluster => cluster.gateOpen).sort((a, b) => a.lowest.gapToMedianPct - b.lowest.gapToMedianPct).slice(0, 5),
    gateOpen: clusters.some((cluster) => cluster.gateOpen),
    lowestClaimAllowed: clusters.some((cluster) => cluster.gateOpen),
  };
}

export async function collectListLive({ destination = TARGET_DESTINATION, anchor } = {}) {
  const requests = buildRequests(destination);
  const captured = [];
  const products = [];
  let stopReason = null;
  for (const request of requests) {
    const result = await readPublic(request.seller, 'package-list', request.url, {
      method: request.method,
      body: request.body,
      headers: request.headers,
      readContract: request.readContract,
      accept: request.headers.accept,
    });
    captured.push({
      sourceId: request.sourceId,
      method: request.method,
      url: request.url,
      params: request.params,
      status: result.meta.status,
      contentType: result.meta.contentType,
      bytes: result.meta.bytes,
      sha256: result.meta.sha256,
      capture: result.meta.capture,
      error: result.meta.error ?? null,
    });
    const responseKind = classifyResponse(result);
    if (responseKind) {
      captured[captured.length - 1].responseKind = responseKind;
      captured[captured.length - 1].verdict = responseKind;
      stopReason = responseKind;
      break;
    }
    let payload;
    try {
      payload = JSON.parse(result.text);
    } catch {
      captured[captured.length - 1].parseError = 'response was not valid JSON';
      captured[captured.length - 1].verdict = /text\/html/i.test(result.meta.contentType ?? '') || /<html|<!doctype/i.test(result.text)
        ? 'html_only'
        : 'endpoint_error';
      continue;
    }
    let parsed;
    try {
      parsed = request.parse(payload);
    } catch (error) {
      captured[captured.length - 1].parseError = error.message;
      captured[captured.length - 1].verdict = 'endpoint_error';
      continue;
    }
    const validRows = parsed.filter((product) => text(product.sellerProductId) && text(product.title));
    captured[captured.length - 1].parsedProductCount = parsed.length;
    captured[captured.length - 1].validRowCount = validRows.length;
    captured[captured.length - 1].validJsonEnvelope = true;
    captured[captured.length - 1].verdict = validRows.length ? 'usable' : 'empty_result';
    products.push(...validRows);
  }
  const cluster = anchor && !stopReason
    ? evaluateCluster(products, { destination, anchor })
    : { gateOpen: false, lowestClaimAllowed: false, selectedCount: 0, excluded: [], clusters: [] };
  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    mode: 'live-list-only',
    verdict: stopReason ?? (captured.some((entry) => entry.validRowCount > 0)
      ? 'usable_limited'
      : captured.length === requests.length && captured.every((entry) => entry.validJsonEnvelope)
        ? 'empty_result'
        : captured.some((entry) => entry.verdict === 'endpoint_error') ? 'endpoint_error' : 'html_only'),
    requestCount: captured.length,
    requests: captured,
    parsedProductCount: products.length,
    cluster,
    limitations: [
      'Only the three verified public list contracts were requested, once each. No detail, calendar, option, or availability endpoint is called.',
      'Unknown mandatory costs and unverified cluster dimensions remain null and close the comparison gate.',
    ],
  };
}

const SELLER_PIPELINES = [
  ['yellowballoon', 'collectYellowballoonLive'],
  ['verygood', 'collectVerygoodLive'],
  ['lotte', 'collectLotteLive'],
];

/** Normalize fee currencies using the recorded ECB reference cross rate. */
export async function applyPackageFx(products, fx) {
  const { convertLocalFee } = await import('./fx-rates.mjs');
  const convertCharge = fee => {
    const currency = String(fee.currency ?? '').toUpperCase();
    const nativeAmount = currency === 'KRW' ? nonnegativeKrw(fee.amount ?? fee.amountKrw) : null;
    return { ...fee, amountKrw: currency === 'KRW' ? nativeAmount
      : currency ? convertLocalFee(fee, fx) : nonnegativeKrw(fee.amountKrw),
      fxReferenceDate: currency && currency !== 'KRW' ? fx?.referenceDate ?? null : null };
  };
  return products.map(product => ({
    ...product,
    departures: (product.departures ?? []).map(departure => ({
      ...departure,
      fx: fx ?? null,
      localFees: Array.isArray(departure.localFees) ? departure.localFees.map(convertCharge) : departure.localFees ?? null,
      mandatoryOptions: Array.isArray(departure.mandatoryOptions) ? departure.mandatoryOptions.map(convertCharge) : departure.mandatoryOptions ?? null,
    })),
  }));
}

/** Live list → detail → calendar via the separately fixture-tested seller parsers. */
export async function collectLive({ destination = TARGET_DESTINATION, anchor, listOnly = false, sellers, fx, ...options } = {}) {
  if (listOnly) return collectListLive({ destination, anchor });
  if (!dateOnly(anchor) || anchor !== dateOnly(anchor)) throw new TypeError('anchor must be YYYY-MM-DD');
  if (!['다낭', '나트랑'].includes(destination)) throw new Error('Detail pipelines currently support 다낭 and 나트랑');
  const sellerResults = [];
  for (const [seller, method] of SELLER_PIPELINES) {
    if (sellers && !sellers.includes(seller)) continue;
    const adapter = await import(`./seller-adapters/${seller}.mjs`);
    try {
      const result = await adapter[method]({ ...options, destination, anchor, anchorDate: anchor });
      sellerResults.push(result);
    } catch (error) {
      sellerResults.push({ seller, verdict: 'collector_error', error: error.message,
        products: [], requests: [], requestCount: null,
        limitations: ['Collector stopped; any preceding request metadata remains in the capture directory. The number of attempted requests is not inferred.'] });
    }
  }
  const reference = fx ?? await (await import('./fx-rates.mjs')).fetchUsdKrwReferenceWithFallback({ observationDate: new Date().toISOString().slice(0, 10) });
  const products = await applyPackageFx(sellerResults.flatMap(result => result.products ?? []), reference);
  const cluster = evaluateCluster(products, { destination, anchor });
  return {
    schemaVersion: 2,
    checkedAt: new Date().toISOString(),
    mode: 'live-list-detail-calendar',
    destination, anchor,
    sellerResults,
    requests: sellerResults.flatMap(result => result.requests ?? []),
    requestCount: sellerResults.reduce((n, result) => n + (result.requests?.length ?? 0), 0),
    parsedProductCount: products.length,
    products,
    fx: reference,
    cluster,
    verdict: cluster.gateOpen ? 'comparable' : 'usable_limited',
    limitations: ['Anonymous seller quotes; availability and checkout totals were not independently verified.',
      'Unknown costs or cluster dimensions exclude rows; no provisional quote is called a lowest price.'],
  };
}

function parseCli(argv) {
  const options = { live: false, listOnly: false, destination: TARGET_DESTINATION, anchor: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--live') options.live = true;
    else if (arg === '--list-only') options.listOnly = true;
    else if (arg === '--destination') options.destination = argv[++i];
    else if (arg === '--anchor') options.anchor = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.live && !options.anchor) throw new Error('--anchor is required with --live');
  return options;
}

async function main() {
  try {
    const options = parseCli(process.argv.slice(2));
    if (!options.live) {
      process.stdout.write(`${JSON.stringify({ usage: 'node package-collect.mjs --live [--list-only] --destination 다낭|나트랑 --anchor YYYY-MM-DD' })}\n`);
      return;
    }
    const result = await collectLive(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: error.message, gateOpen: false, lowestClaimAllowed: false })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
