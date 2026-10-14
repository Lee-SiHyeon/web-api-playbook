import { createHash } from 'node:crypto';

const ORIGIN = 'https://hermes-hotel-svc-api.naver.com';
const GRAPHQL_PATH = '/graphql';
const ENDPOINT = `${ORIGIN}${GRAPHQL_PATH}`;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_PAGE_SIZE = 20;
const MIN_HOST_INTERVAL_MS = 2000;
let lastRequestAt = 0;

const OVERSEAS_HOTEL_LIST_QUERY = `query overseasHotelList($input: OverseasHotelListInput!, $withDistance: Boolean! = true) {
  overseasHotelList(input: $input) {
    total
    pageInfo { pageSize totalPages }
    recommendedBnbSearchContext { placeId }
    itemList {
      id
      serviceType
      hotel {
        id nHotelId title location { latitude longitude } distance @include(if: $withDistance) starRating overallRating
        priceMinRate reviewQuotes images openedYear taAwards { type year } userContext { isVisited }
        features { isSuperWeek isNewlyOpened isPetFriendly isBookedMany isClickedMany isAccompanyChild }
      }
      bnb {
        id title name location { latitude longitude } imageUrls reviewSummary { rating count }
        roomInfo { maxGuests bedrooms beds bathrooms } features { isGuestFavorite isLuxe }
        policies { isPetFriendly } userContext { isVisited } sellingTitle countryNameKo priceAvg
      }
    }
    nearByAttractions { id name }
  }
}`;

const OVERSEAS_HOTEL_RATES_QUERY = `query overseasHotelListRatesV2($xbuIds: [String!]!, $checkIn: String!, $checkOut: String!, $adultCnt: Int!, $childAges: [Int!], $impArea: MultiImpArea!, $nPlaceId: String, $isCpcExcluded: Boolean, $query: String!, $includeTax: Boolean!) {
  overseasHotelListRates(xbuIds: $xbuIds, checkIn: $checkIn, checkOut: $checkOut, adultCnt: $adultCnt, childAges: $childAges, impArea: $impArea, nPlaceId: $nPlaceId, isCpcExcluded: $isCpcExcluded) {
    xbuId
    otaMinRates(xbuIds: $xbuIds, checkIn: $checkIn, checkOut: $checkOut, adultCnt: $adultCnt, childAges: $childAges, impArea: $impArea, nPlaceId: $nPlaceId, isCpcExcluded: $isCpcExcluded) {
      otaCode
      stay {
        id roomId roomName isSponsored
        ota { code npay isOfficialSite }
        productFeatures { freeCancelDeadline isFreeCancel isLast isPayLater isSecretDeal roomUsageType }
        rate {
          bookUrl
          discounts { krFestival { amount } travelClub { amount grade percent } coupons { percent amount } }
          localRate { currencyCode rate }
          original
          promotionBookUrl
          rewards { details { amount percent fixedAmount title type } total }
          userRate
        }
        roomFeatures { bedType optionType roomType viewType }
        nlog(query: $query, checkIn: $checkIn, checkOut: $checkOut, includeTax: $includeTax) {
          impression { cssSelector content }
          click { eventName content }
        }
        promotionEventLabels {
          eventKey
          label { type text displayLevel }
          action {
            type linkUrl { mo pc } linkText promoCode popupTitle popupBody popupBodyEmphasis
            popupLinkUrl { mo pc } popupLinkText popupBookingUrl { mo pc } popupBookingText
          }
        }
      }
    }
    cpcRates(xbuIds: $xbuIds, checkIn: $checkIn, checkOut: $checkOut, adultCnt: $adultCnt, childAges: $childAges, impArea: $impArea, nPlaceId: $nPlaceId, isCpcExcluded: $isCpcExcluded) {
      bookUrl
      rate
      ota { code npay }
    }
    freeCancelDeadline(xbuIds: $xbuIds, checkIn: $checkIn, checkOut: $checkOut, adultCnt: $adultCnt, childAges: $childAges, impArea: $impArea, nPlaceId: $nPlaceId, isCpcExcluded: $isCpcExcluded)
  }
}`;

function fail(code, message, metadata) {
  return Object.assign(new Error(message), { code, ...(metadata ? { metadata } : {}) });
}

function isoDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw fail('NAVER_OVERSEAS_HOTEL_INVALID_INPUT', `${label} must be YYYY-MM-DD`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw fail('NAVER_OVERSEAS_HOTEL_INVALID_INPUT', `${label} is not a calendar date`);
  }
  return value;
}

function validateStay({ checkIn, checkOut, adultCnt, childAges = [] }) {
  const arrival = isoDate(checkIn, 'checkIn');
  const departure = isoDate(checkOut, 'checkOut');
  if (departure <= arrival) throw fail('NAVER_OVERSEAS_HOTEL_INVALID_INPUT', 'checkOut must be after checkIn');
  if (!Number.isInteger(adultCnt) || adultCnt < 1 || adultCnt > 9) {
    throw fail('NAVER_OVERSEAS_HOTEL_INVALID_INPUT', 'adultCnt must be an integer from 1 to 9');
  }
  if (!Array.isArray(childAges) || childAges.length > 8 || childAges.some(age => !Number.isInteger(age) || age < 0 || age > 17)) {
    throw fail('NAVER_OVERSEAS_HOTEL_INVALID_INPUT', 'childAges must contain up to 8 integer ages from 0 to 17');
  }
  return { checkIn: arrival, checkOut: departure };
}

function validateDestination(query, placeId) {
  if (typeof query !== 'string' || !query.trim() || query.trim().length > 80) {
    throw fail('NAVER_OVERSEAS_HOTEL_INVALID_INPUT', 'query must be a non-empty destination up to 80 characters');
  }
  if (typeof placeId !== 'string' || !/^WOF:\d{1,12}$/.test(placeId)) {
    throw fail('NAVER_OVERSEAS_HOTEL_INVALID_INPUT', 'placeId must match the observed overseas place identifier shape');
  }
  return { query: query.trim(), placeId };
}

function validateRatesDestination(query, nPlaceId) {
  if (typeof query !== 'string' || !query.trim() || query.trim().length > 80) {
    throw fail('NAVER_OVERSEAS_HOTEL_INVALID_INPUT', 'query must be a non-empty destination up to 80 characters');
  }
  if (typeof nPlaceId !== 'string' || !nPlaceId.trim() || nPlaceId.trim().length > 80) {
    throw fail('NAVER_OVERSEAS_HOTEL_INVALID_INPUT', 'nPlaceId must be the observed destination string');
  }
  return { query: query.trim(), nPlaceId: nPlaceId.trim() };
}

function cleanString(value, max = 300) {
  return typeof value === 'string' && value.length <= max ? value : null;
}

function cleanNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function cleanMoney(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.length > 18 || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanBoolean(value) {
  return typeof value === 'boolean' ? value : null;
}

function cleanLocation(value) {
  if (!value || typeof value !== 'object') return null;
  return { latitude: cleanNumber(value.latitude), longitude: cleanNumber(value.longitude) };
}

function cleanFeatures(value, allowed) {
  if (!value || typeof value !== 'object') return null;
  return Object.fromEntries(allowed.map(key => [key, cleanBoolean(value[key])])) ;
}

function cleanImageUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function cleanHotel(value) {
  if (!value || typeof value !== 'object') return null;
  const taAwards = Array.isArray(value.taAwards)
    ? value.taAwards.slice(0, 12).map(item => ({ type: cleanString(item?.type, 80), year: cleanNumber(item?.year) }))
    : [];
  const reviewQuotes = Array.isArray(value.reviewQuotes)
    ? value.reviewQuotes.slice(0, 12).map(item => typeof item === 'string' ? cleanString(item, 500) : null).filter(Boolean)
    : [];
  const images = Array.isArray(value.images)
    ? value.images.slice(0, 12).map(cleanImageUrl).filter(Boolean)
    : [];
  return {
    id: cleanString(value.id, 40),
    nHotelId: cleanString(value.nHotelId, 40),
    title: cleanString(value.title, 300),
    location: cleanLocation(value.location),
    distance: cleanNumber(value.distance),
    starRating: cleanNumber(value.starRating),
    overallRating: cleanNumber(value.overallRating),
    priceMinRate: cleanMoney(value.priceMinRate),
    reviewQuotes,
    images,
    openedYear: cleanNumber(value.openedYear),
    taAwards,
    userContext: value.userContext && typeof value.userContext === 'object'
      ? { isVisited: cleanBoolean(value.userContext.isVisited) }
      : null,
    features: cleanFeatures(value.features, ['isSuperWeek', 'isNewlyOpened', 'isPetFriendly', 'isBookedMany', 'isClickedMany', 'isAccompanyChild']),
  };
}

function cleanBnb(value) {
  if (!value || typeof value !== 'object') return null;
  const imageUrls = Array.isArray(value.imageUrls) ? value.imageUrls.slice(0, 12).map(cleanImageUrl).filter(Boolean) : [];
  return {
    id: cleanString(value.id, 40),
    title: cleanString(value.title, 300),
    name: cleanString(value.name, 300),
    location: cleanLocation(value.location),
    imageUrls,
    reviewSummary: value.reviewSummary && typeof value.reviewSummary === 'object'
      ? { rating: cleanNumber(value.reviewSummary.rating), count: cleanNumber(value.reviewSummary.count) }
      : null,
    roomInfo: value.roomInfo && typeof value.roomInfo === 'object'
      ? { maxGuests: cleanNumber(value.roomInfo.maxGuests), bedrooms: cleanNumber(value.roomInfo.bedrooms), beds: cleanNumber(value.roomInfo.beds), bathrooms: cleanNumber(value.roomInfo.bathrooms) }
      : null,
    features: cleanFeatures(value.features, ['isGuestFavorite', 'isLuxe']),
    policies: value.policies && typeof value.policies === 'object' ? { isPetFriendly: cleanBoolean(value.policies.isPetFriendly) } : null,
    userContext: value.userContext && typeof value.userContext === 'object' ? { isVisited: cleanBoolean(value.userContext.isVisited) } : null,
    sellingTitle: cleanString(value.sellingTitle, 300),
    countryNameKo: cleanString(value.countryNameKo, 100),
    priceAvg: cleanMoney(value.priceAvg),
  };
}

function cleanListItem(value) {
  if (!value || typeof value !== 'object') return null;
  const hotel = cleanHotel(value.hotel);
  const bnb = cleanBnb(value.bnb);
  if (!hotel && !bnb) return null;
  return {
    id: cleanString(value.id, 80),
    serviceType: cleanString(value.serviceType, 40),
    hotel,
    bnb,
  };
}

function cleanDiscounts(value) {
  if (!value || typeof value !== 'object') return null;
  const amount = item => item && typeof item === 'object' ? cleanMoney(item.amount) : null;
  const club = value.travelClub;
  const coupons = Array.isArray(value.coupons) ? value.coupons.slice(0, 12).map(item => ({ percent: cleanNumber(item?.percent), amount: cleanMoney(item?.amount) })) : [];
  return {
    krFestival: amount(value.krFestival),
    travelClub: club && typeof club === 'object'
      ? { amount: cleanMoney(club.amount), grade: cleanString(club.grade, 40), percent: cleanNumber(club.percent) }
      : null,
    coupons,
  };
}

function cleanRewards(value) {
  if (!value || typeof value !== 'object') return null;
  const details = Array.isArray(value.details) ? value.details.slice(0, 12).map(item => ({
    amount: cleanMoney(item?.amount),
    percent: cleanNumber(item?.percent),
    fixedAmount: cleanMoney(item?.fixedAmount),
    title: cleanString(item?.title, 120),
    type: cleanString(item?.type, 40),
  })) : [];
  return { details, total: cleanMoney(value.total) };
}

function cleanStay(value, otaCode) {
  if (!value || typeof value !== 'object') return null;
  const rate = value.rate && typeof value.rate === 'object' ? value.rate : {};
  const ota = value.ota && typeof value.ota === 'object' ? value.ota : {};
  const localRate = rate.localRate && typeof rate.localRate === 'object' ? rate.localRate : {};
  const productFeatures = value.productFeatures && typeof value.productFeatures === 'object' ? value.productFeatures : {};
  const roomFeatures = value.roomFeatures && typeof value.roomFeatures === 'object' ? value.roomFeatures : {};
  const id = cleanString(value.id, 100);
  const roomId = cleanString(value.roomId, 100);
  return {
    id,
    roomId,
    roomName: cleanString(value.roomName, 300),
    isSponsored: cleanBoolean(value.isSponsored),
    ota: { code: cleanString(ota.code ?? otaCode, 20), npay: cleanBoolean(ota.npay), isOfficialSite: cleanBoolean(ota.isOfficialSite) },
    productFeatures: {
      freeCancelDeadline: cleanString(productFeatures.freeCancelDeadline, 80),
      isFreeCancel: cleanBoolean(productFeatures.isFreeCancel),
      isLast: cleanBoolean(productFeatures.isLast),
      isPayLater: cleanBoolean(productFeatures.isPayLater),
      isSecretDeal: cleanBoolean(productFeatures.isSecretDeal),
      roomUsageType: cleanString(productFeatures.roomUsageType, 60),
    },
    rate: {
      userRate: cleanMoney(rate.userRate),
      original: cleanMoney(rate.original),
      localRate: { currencyCode: cleanString(localRate.currencyCode, 12), rate: cleanMoney(localRate.rate) },
      discounts: cleanDiscounts(rate.discounts),
      rewards: cleanRewards(rate.rewards),
    },
    roomFeatures: {
      bedType: cleanString(roomFeatures.bedType, 80),
      optionType: cleanString(roomFeatures.optionType, 80),
      roomType: cleanString(roomFeatures.roomType, 80),
      viewType: cleanString(roomFeatures.viewType, 80),
    },
  };
}

function cleanRateRow(value) {
  if (!value || typeof value !== 'object') return null;
  const xbuId = cleanString(value.xbuId, 40);
  const otaMinRates = Array.isArray(value.otaMinRates) ? value.otaMinRates.slice(0, 30).map(row => {
    const otaCode = cleanString(row?.otaCode, 20);
    const sourceStay = row?.stay;
    const stays = sourceStay && typeof sourceStay === 'object' && !Array.isArray(sourceStay)
      ? [cleanStay(sourceStay, otaCode)].filter(Boolean)
      : [];
    return { otaCode, stays };
  }) : [];
  return xbuId ? { xbuId, otaMinRates } : null;
}

function dateNights(checkIn, checkOut) {
  return Math.round((Date.parse(`${checkOut}T00:00:00.000Z`) - Date.parse(`${checkIn}T00:00:00.000Z`)) / 86400000);
}

async function readBoundedBody(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw fail('NAVER_OVERSEAS_HOTEL_RESPONSE_TOO_LARGE', 'Naver overseas hotel response exceeded the configured size limit');
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw fail('NAVER_OVERSEAS_HOTEL_RESPONSE_TOO_LARGE', 'Naver overseas hotel response exceeded the configured size limit');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    size += chunk.length;
    if (size > maxBytes) {
      await reader.cancel();
      throw fail('NAVER_OVERSEAS_HOTEL_RESPONSE_TOO_LARGE', 'Naver overseas hotel response exceeded the configured size limit');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function pacedRequest(minHostIntervalMs) {
  const delay = minHostIntervalMs - (Date.now() - lastRequestAt);
  if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
  lastRequestAt = Date.now();
}

export class NaverOverseasHotelClient {
  constructor({ fetchImpl = fetch, timeoutMs = 20000, responseByteLimit = MAX_RESPONSE_BYTES, minHostIntervalMs = MIN_HOST_INTERVAL_MS } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw new TypeError('timeoutMs must be from 1000 to 60000');
    if (!Number.isInteger(responseByteLimit) || responseByteLimit < 1024 || responseByteLimit > 16 * 1024 * 1024) throw new TypeError('responseByteLimit must be from 1024 to 16777216');
    if (!Number.isInteger(minHostIntervalMs) || minHostIntervalMs < 0 || minHostIntervalMs > 60000) throw new TypeError('minHostIntervalMs must be from 0 to 60000');
    this.fetchImpl = fetchImpl;
    this.nativeFetch = fetchImpl === fetch;
    this.timeoutMs = timeoutMs;
    this.responseByteLimit = responseByteLimit;
    this.minHostIntervalMs = minHostIntervalMs;
  }

  async #request(operationName, query, variables) {
    await pacedRequest(this.minHostIntervalMs);
    const checkedAt = new Date().toISOString();
    let response;
    try {
      response = await this.fetchImpl(ENDPOINT, {
        method: 'POST',
        redirect: 'manual',
        credentials: 'omit',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-naver-client-name': 'gaza-next-hotel',
          'x-naver-client-version': '1.0.0',
        },
        body: JSON.stringify({ operationName, query, variables }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw fail('NAVER_OVERSEAS_HOTEL_TRANSPORT_ERROR', 'Naver overseas hotel anonymous request failed', {
        operation: operationName,
        origin: ORIGIN,
        path: GRAPHQL_PATH,
        method: 'POST',
        checkedAt,
        auth: 'anonymous',
        transport: this.nativeFetch ? 'Node fetch default User-Agent' : 'injected fetchImpl; direct network not asserted',
        causeName: cleanString(cause?.name, 80),
      });
    }

    let bytes;
    try {
      bytes = await readBoundedBody(response, this.responseByteLimit);
    } catch (error) {
      if (error?.code === 'NAVER_OVERSEAS_HOTEL_RESPONSE_TOO_LARGE') {
        error.metadata = { operation: operationName, origin: ORIGIN, path: GRAPHQL_PATH, method: 'POST', checkedAt, status: response.status, auth: 'anonymous' };
        throw error;
      }
      throw fail('NAVER_OVERSEAS_HOTEL_RESPONSE_READ_ERROR', 'Naver overseas hotel response could not be read safely', {
        operation: operationName, origin: ORIGIN, path: GRAPHQL_PATH, method: 'POST', checkedAt, status: response.status, auth: 'anonymous',
      });
    }

    const receipt = {
      operation: operationName,
      origin: ORIGIN,
      path: GRAPHQL_PATH,
      method: 'POST',
      checkedAt,
      status: response.status,
      contentType: cleanString(response.headers?.get?.('content-type') ?? '', 100),
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      auth: 'anonymous',
      credentials: 'omitted',
      transport: this.nativeFetch ? 'Node fetch default User-Agent' : 'injected fetchImpl; direct network not asserted',
      userAgent: this.nativeFetch ? 'runtime default; no User-Agent override' : 'not assessed for injected fetchImpl',
      sourceEvidence: 'browser_captured_contract+first_party_static_bundle_query',
      requestAttempted: true,
      liveReplay: false,
    };

    if (response.status !== 200 || !/application\/json/i.test(receipt.contentType ?? '')) {
      throw fail('NAVER_OVERSEAS_HOTEL_HTTP_ERROR', 'Naver overseas hotel endpoint did not return JSON HTTP 200', receipt);
    }
    let payload;
    try {
      payload = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw fail('NAVER_OVERSEAS_HOTEL_INVALID_JSON', 'Naver overseas hotel endpoint returned invalid JSON', receipt);
    }
    if (Array.isArray(payload?.errors) && payload.errors.length) {
      const codes = [...new Set(payload.errors.map(error => cleanString(error?.extensions?.code, 80)).filter(Boolean))].slice(0, 10);
      throw fail('NAVER_OVERSEAS_HOTEL_GRAPHQL_ERROR', 'Naver overseas hotel GraphQL operation returned errors', { ...receipt, errorCount: payload.errors.length, errorCodes: codes });
    }
    return { data: payload?.data ?? null, receipt };
  }

  async search({
    query,
    placeId,
    from = 0,
    size = MAX_PAGE_SIZE,
    sort = 'RELEVANCE_DESC',
    checkIn,
    checkOut,
    adultCnt,
    childAges = [],
    includeRecommendedBnb = true,
    accommodationTypeIds = [],
    chainIds = [],
    facilityIds = [],
    priceRangeKey = 'PRICE_AVG',
    starRatings = [],
    deviceType = 'PC',
  } = {}) {
    const destination = validateDestination(query, placeId);
    const stay = validateStay({ checkIn, checkOut, adultCnt, childAges });
    if (!Number.isInteger(from) || from < 0 || from > 2000 || from % MAX_PAGE_SIZE !== 0) {
      throw fail('NAVER_OVERSEAS_HOTEL_INVALID_INPUT', 'from must be a non-negative multiple of 20 up to 2000');
    }
    if (size !== MAX_PAGE_SIZE || sort !== 'RELEVANCE_DESC' || includeRecommendedBnb !== true || deviceType !== 'PC') {
      throw fail('NAVER_OVERSEAS_HOTEL_INVALID_INPUT', 'Only the browser-observed list size, sort, BnB and device settings are supported');
    }
    for (const [key, list] of Object.entries({ accommodationTypeIds, chainIds, facilityIds, starRatings })) {
      if (!Array.isArray(list) || list.length > 30 || list.some(value => !(typeof value === 'string' || Number.isInteger(value)))) {
        throw fail('NAVER_OVERSEAS_HOTEL_INVALID_INPUT', `${key} must be a bounded array of observed filter values`);
      }
    }
    if (priceRangeKey !== 'PRICE_AVG') throw fail('NAVER_OVERSEAS_HOTEL_INVALID_INPUT', 'Only the browser-observed PRICE_AVG filter is supported');

    const input = {
      from,
      size,
      sort,
      includeRecommendedBnb,
      checkIn: stay.checkIn,
      checkOut: stay.checkOut,
      adultCnt,
      accommodationTypeIds,
      chainIds,
      facilityIds,
      priceRangeKey,
      starRatings,
      deviceType,
      query: destination.query,
      placeId: destination.placeId,
    };
    if (childAges.length) input.childAges = [...childAges];
    const { data, receipt } = await this.#request('overseasHotelList', OVERSEAS_HOTEL_LIST_QUERY, { withDistance: true, input });
    const source = data?.overseasHotelList;
    if (!source || !Array.isArray(source.itemList) || !source.pageInfo) {
      throw fail('NAVER_OVERSEAS_HOTEL_SCHEMA_CHANGED', 'Naver overseas hotel list response did not match the observed schema', receipt);
    }
    const validatedReceipt = { ...receipt, liveReplay: this.nativeFetch, validatedPayload: true };
    const items = source.itemList.map(cleanListItem).filter(Boolean);
    if (!items.length) throw fail('NAVER_OVERSEAS_HOTEL_EMPTY', 'Naver overseas hotel list contained no hotel or BnB items', receipt);
    return {
      checkedAt: receipt.checkedAt,
      query: destination.query,
      placeId: destination.placeId,
      stay: { checkIn: stay.checkIn, checkOut: stay.checkOut, nights: dateNights(stay.checkIn, stay.checkOut), adultCnt, childAges: [...childAges] },
      total: cleanNumber(source.total),
      pageInfo: { pageSize: cleanNumber(source.pageInfo.pageSize), totalPages: cleanNumber(source.pageInfo.totalPages) },
      recommendedBnbSearchContext: source.recommendedBnbSearchContext && typeof source.recommendedBnbSearchContext === 'object'
        ? { placeId: cleanString(source.recommendedBnbSearchContext.placeId, 40) }
        : null,
      items,
      nearByAttractions: Array.isArray(source.nearByAttractions)
        ? source.nearByAttractions.slice(0, 30).map(row => ({ id: cleanString(row?.id, 80), name: cleanString(row?.name, 200) }))
        : [],
      receipt: { ...validatedReceipt, returnedItems: items.length, returnedHotels: items.filter(item => item.hotel).length, returnedBnbs: items.filter(item => item.bnb).length },
    };
  }

  async rates({
    xbuIds,
    query,
    nPlaceId,
    checkIn,
    checkOut,
    adultCnt,
    childAges = [],
    impArea = 'renewalMulti',
    includeTax = true,
  } = {}) {
    const destination = validateRatesDestination(query, nPlaceId);
    const stay = validateStay({ checkIn, checkOut, adultCnt, childAges });
    if (!Array.isArray(xbuIds) || xbuIds.length < 1 || xbuIds.length > MAX_PAGE_SIZE || xbuIds.some(id => typeof id !== 'string' || !/^\d{1,20}$/.test(id)) || new Set(xbuIds).size !== xbuIds.length) {
      throw fail('NAVER_OVERSEAS_HOTEL_INVALID_INPUT', 'xbuIds must be 1 to 20 unique observed numeric hotel identifiers');
    }
    if (impArea !== 'renewalMulti' || includeTax !== true) {
      throw fail('NAVER_OVERSEAS_HOTEL_INVALID_INPUT', 'Only the browser-observed multi-list, tax-included rate query is supported');
    }
    const variables = {
      xbuIds: [...xbuIds],
      checkIn: stay.checkIn,
      checkOut: stay.checkOut,
      adultCnt,
      childAges,
      impArea,
      nPlaceId: destination.nPlaceId,
      query: destination.query,
      includeTax,
    };
    const { data, receipt } = await this.#request('overseasHotelListRatesV2', OVERSEAS_HOTEL_RATES_QUERY, variables);
    const source = data?.overseasHotelListRates;
    if (!Array.isArray(source)) throw fail('NAVER_OVERSEAS_HOTEL_SCHEMA_CHANGED', 'Naver overseas hotel rates response did not match the observed schema', receipt);
    const validatedReceipt = { ...receipt, liveReplay: this.nativeFetch, validatedPayload: true };
    const rows = source.map(cleanRateRow).filter(Boolean);
    const otaMinRateCount = rows.reduce((sum, row) => sum + row.otaMinRates.length, 0);
    const isPositiveAmount = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
    const hasNumericRate = stay => isPositiveAmount(stay.rate.userRate) || isPositiveAmount(stay.rate.localRate.rate);
    const otaQuoteCount = rows.reduce((sum, row) => sum + row.otaMinRates.reduce((n, ota) => n + ota.stays.filter(hasNumericRate).length, 0), 0);
    const unpricedOtaMinRateCount = Math.max(0, otaMinRateCount - otaQuoteCount);
    const returnedXbuIds = new Set(rows.map(row => row.xbuId));
    const missingHotelCount = xbuIds.filter(id => !returnedXbuIds.has(id)).length;
    const duplicateRateRowCount = rows.length - returnedXbuIds.size;
    if (xbuIds.length && otaMinRateCount > 0 && otaQuoteCount === 0) {
      throw fail('NAVER_OVERSEAS_HOTEL_SCHEMA_CHANGED', 'Naver overseas hotel returned OTA rate rows without a normalized numeric quote', {
        ...validatedReceipt,
        requestedHotelCount: xbuIds.length,
        returnedHotelRows: rows.length,
        otaMinRateCount,
        otaQuoteCount,
        unpricedOtaMinRateCount,
        missingHotelCount,
        duplicateRateRowCount,
      });
    }
    return {
      checkedAt: receipt.checkedAt,
      query: destination.query,
      nPlaceId: destination.nPlaceId,
      stay: { checkIn: stay.checkIn, checkOut: stay.checkOut, nights: dateNights(stay.checkIn, stay.checkOut), adultCnt, childAges: [...childAges] },
      includeTax,
      quoteBasis: 'listing rate response for the requested stay; includeTax is passed to the response tracking selection and does not establish tax arithmetic or a checkout total',
      priceCoverage: {
        status: otaQuoteCount === 0 ? 'no_quotes' : unpricedOtaMinRateCount > 0 || missingHotelCount > 0 || duplicateRateRowCount > 0 ? 'partial' : 'quoted',
        requestedHotels: xbuIds.length,
        returnedHotelRows: rows.length,
        otaMinRateCount,
        pricedQuoteCount: otaQuoteCount,
        unpricedOtaMinRateCount,
        missingHotelCount,
        duplicateRateRowCount,
      },
      rows,
      receipt: { ...validatedReceipt, requestedHotelCount: xbuIds.length, returnedHotelRows: rows.length, otaMinRateCount, otaQuoteCount, unpricedOtaMinRateCount, missingHotelCount, duplicateRateRowCount },
    };
  }
}

export const NAVER_OVERSEAS_HOTEL_CONTRACT = Object.freeze({
  origin: ORIGIN,
  path: GRAPHQL_PATH,
  endpoint: ENDPOINT,
  listOperation: 'overseasHotelList',
  ratesOperation: 'overseasHotelListRatesV2',
  maxPageSize: MAX_PAGE_SIZE,
});
