import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const ORIGIN = 'https://www.agoda.com';
const HOME_URL = `${ORIGIN}/ko-kr/`;
const PROPERTY_SUMMARY_URL = `${ORIGIN}/graphql/search`;
const CAMPAIGNS_URL = `${ORIGIN}/api/card/campaigns`;
const MIN_HOST_INTERVAL_MS = 2000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_BOOTSTRAP_SCRIPT_BYTES = 1536 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FIXTURE_DIR = new URL('../fixtures/agoda/', import.meta.url);
const REQUEST_TEMPLATE = JSON.parse(readFileSync(new URL('public-request-template.json', FIXTURE_DIR), 'utf8'));
const PROPERTY_SUMMARY_QUERY = readFileSync(new URL('property-summary-query.graphql', FIXTURE_DIR), 'utf8').trim();
const OBSERVED_PROPERTY_IDS = Object.freeze([...REQUEST_TEMPLATE.PropertySummarySearchRequest.propertyIds]);

let lastRequestAt = 0;

function fail(code, message, metadata) {
  return Object.assign(new Error(message), { code, ...(metadata ? { metadata } : {}) });
}

function safeText(value, maxLength = 1000) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) || null : null;
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positiveMoney(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateDate(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw fail('AGODA_INPUT_INVALID', `${field} must be a calendar date in YYYY-MM-DD format`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw fail('AGODA_INPUT_INVALID', `${field} must be a valid calendar date`);
  }
  return value;
}

function validateRateInput(input, now) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw fail('AGODA_INPUT_INVALID', 'Rate input must be an object');
  }
  const allowed = new Set(['propertyIds', 'checkIn', 'checkOut', 'adults', 'children', 'rooms', 'currency']);
  if (Object.keys(input).some(key => !allowed.has(key))) {
    throw fail('AGODA_INPUT_INVALID', 'Rate input contains an unobserved field');
  }

  const checkIn = validateDate(input.checkIn, 'checkIn');
  const checkOut = validateDate(input.checkOut, 'checkOut');
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(nowMs)) throw fail('AGODA_CLOCK_INVALID', 'Local request clock did not return a valid date');
  const todayKst = new Date(nowMs + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (checkIn < todayKst) throw fail('AGODA_INPUT_INVALID', 'checkIn must be today in Korea or a later date');
  const nights = (Date.parse(`${checkOut}T00:00:00.000Z`) - Date.parse(`${checkIn}T00:00:00.000Z`)) / 86400000;
  if (nights < 1 || nights > 30) {
    throw fail('AGODA_INPUT_INVALID', 'checkOut must be 1 to 30 nights after checkIn');
  }

  for (const [field, expected] of [['adults', 2], ['children', 0], ['rooms', 1], ['currency', 'KRW']]) {
    if (input[field] !== undefined && input[field] !== expected) {
      throw fail('AGODA_INPUT_INVALID', `${field} differs from the observed public request contract`);
    }
  }

  const propertyIds = input.propertyIds ?? OBSERVED_PROPERTY_IDS;
  if (!Array.isArray(propertyIds) || propertyIds.length < 1 || propertyIds.length > OBSERVED_PROPERTY_IDS.length) {
    throw fail('AGODA_INPUT_INVALID', 'propertyIds must contain 1 to 16 observed property IDs');
  }
  const allowedIds = new Set(OBSERVED_PROPERTY_IDS);
  if (propertyIds.some(id => !Number.isSafeInteger(id) || !allowedIds.has(id))
    || new Set(propertyIds).size !== propertyIds.length) {
    throw fail('AGODA_INPUT_INVALID', 'propertyIds must be unique IDs from the observed public listing');
  }

  return { checkIn, checkOut, propertyIds: [...propertyIds] };
}

function findJsonObjectAfterResolve(scriptText, assignmentEnd) {
  const resolveMatch = /\bresolve\s*\(/g;
  resolveMatch.lastIndex = assignmentEnd;
  const match = resolveMatch.exec(scriptText);
  if (!match) return null;
  let start = match.index + match[0].length;
  while (/\s/.test(scriptText[start] ?? '')) start += 1;
  if (scriptText[start] !== '{') return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let cursor = start; cursor < scriptText.length; cursor += 1) {
    const char = scriptText[cursor];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) return scriptText.slice(start, cursor + 1);
      if (depth < 0) return null;
    }
  }
  return null;
}

function extractBootstrapUserId(html) {
  const dom = new JSDOM(String(html), { url: HOME_URL });
  try {
    const candidates = [];
    for (const script of dom.window.document.querySelectorAll('script')) {
      const text = script.textContent ?? '';
      const assignments = [...text.matchAll(/window\s*\.\s*agBootstrap\s*=\s*new\s+Promise\s*\(/g)];
      for (const assignment of assignments) {
        const scriptBytes = Buffer.byteLength(text, 'utf8');
        if (scriptBytes > MAX_BOOTSTRAP_SCRIPT_BYTES) {
          throw fail('AGODA_BOOTSTRAP_TOO_LARGE', 'Agoda public bootstrap script exceeded the bounded parser size');
        }
        const assignmentEnd = assignment.index + assignment[0].length;
        const jsonText = findJsonObjectAfterResolve(text, assignmentEnd);
        if (!jsonText) throw fail('AGODA_BOOTSTRAP_INVALID', 'Agoda public bootstrap did not contain a literal JSON object');
        let payload;
        try {
          payload = JSON.parse(jsonText);
        } catch {
          throw fail('AGODA_BOOTSTRAP_INVALID', 'Agoda public bootstrap JSON was malformed');
        }
        candidates.push(payload?.core?.userId);
      }
    }
    if (candidates.length !== 1 || typeof candidates[0] !== 'string' || !UUID_RE.test(candidates[0])) {
      throw fail('AGODA_BOOTSTRAP_INVALID', 'Agoda page did not expose one valid public bootstrap issuer');
    }
    return candidates[0];
  } finally {
    dom.window.close();
  }
}

async function boundedBytes(response, maxBytes, stage) {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    try { await response.body?.cancel(); } catch { /* no body data is retained */ }
    throw fail('AGODA_RESPONSE_TOO_LARGE', `Agoda ${stage} response exceeded the body limit`);
  }
  if (!response.body?.getReader) throw fail('AGODA_RESPONSE_INVALID', `Agoda ${stage} response had no readable body`);

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* retain no oversized body */ }
        throw fail('AGODA_RESPONSE_TOO_LARGE', `Agoda ${stage} response exceeded the body limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error?.code === 'AGODA_RESPONSE_TOO_LARGE') throw error;
    throw fail('AGODA_RESPONSE_INVALID', `Agoda ${stage} response body could not be read`);
  } finally {
    try { reader.releaseLock(); } catch { /* already released by the stream */ }
  }
  return Buffer.concat(chunks, total);
}

function requireObjectOrNull(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw fail('AGODA_PRICE_SCHEMA', `Agoda price response field ${field} had an unexpected type`);
  }
  return value;
}

function amountValue(value, field) {
  if (value === undefined || value === null) return { amount: null, invalid: false, present: false };
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw fail('AGODA_PRICE_SCHEMA', `Agoda price response field ${field} had an unexpected type`);
  }
  const number = typeof value === 'number'
    ? value
    : (/^(?:\d+)(?:\.\d+)?$/.test(value.trim()) ? Number(value.trim()) : Number.NaN);
  if (!Number.isFinite(number) || number <= 0) return { amount: null, invalid: true, present: true };
  return { amount: number, invalid: false, present: true };
}

function normalizePriceField(group, field, path) {
  const object = requireObjectOrNull(group, path);
  if (!object) return { value: null, hasPositive: false, invalidAmount: false };
  const display = amountValue(object.display, `${path}.display`);
  const crossedOut = amountValue(object.crossedOutPrice, `${path}.crossedOutPrice`);
  return {
    value: { amount: display.amount, crossedOutAmount: crossedOut.amount },
    hasPositive: display.amount !== null,
    invalidAmount: display.invalid,
  };
}

function normalizePrice(priceValue, currency) {
  const price = requireObjectOrNull(priceValue, 'price');
  if (!price) return { quote: null, hasPositive: false, invalidAmount: false };
  const perRoom = requireObjectOrNull(price.perRoomPerNight, 'price.perRoomPerNight');
  const exclusive = normalizePriceField(perRoom?.exclusive, 'exclusive', 'price.perRoomPerNight.exclusive');
  const inclusive = normalizePriceField(perRoom?.inclusive, 'inclusive', 'price.perRoomPerNight.inclusive');
  const perBook = requireObjectOrNull(price.perBook, 'price.perBook');
  const perBookInclusive = normalizePriceField(perBook?.inclusive, 'inclusive', 'price.perBook.inclusive');
  return {
    quote: {
      currency,
      basis: 'perRoomPerNight',
      exclusive: exclusive.value,
      inclusive: inclusive.value,
      perBook: perBookInclusive.value
        ? { ...perBookInclusive.value, basis: 'perBook inclusive' }
        : null,
      totalDiscount: typeof price.totalDiscount === 'number' && Number.isFinite(price.totalDiscount)
        ? price.totalDiscount
        : null,
    },
    hasPositive: exclusive.hasPositive || inclusive.hasPositive || perBookInclusive.hasPositive,
    invalidAmount: exclusive.invalidAmount || inclusive.invalidAmount || perBookInclusive.invalidAmount,
  };
}

function normalizeHotel(row, observedAt, stay) {
  const content = row?.content?.informationSummary;
  const address = content?.address;
  const pricing = row?.pricing;
  if (pricing !== null && pricing !== undefined
    && (typeof pricing !== 'object' || Array.isArray(pricing))) {
    throw fail('AGODA_PRICE_SCHEMA', 'Agoda property pricing had an unexpected type');
  }
  const isAvailable = pricing?.isAvailable === true;
  const isReady = pricing?.isReady === true;
  const canQuote = isAvailable && isReady;
  const rooms = [];
  const currenciesObserved = new Set();
  let krwEntryFound = false;
  let invalidKrwAmount = false;
  let foreignCurrencyPriceFound = false;
  let roomOfferCount = 0;
  let priceEntryCount = 0;
  let unpricedReason = null;

  if (pricing === null || pricing === undefined) {
    unpricedReason = 'pricing_missing_or_no_offers';
  } else if (pricing.isAvailable === false) {
    unpricedReason = 'unavailable';
  } else if (pricing.isReady === false) {
    unpricedReason = 'not_ready';
  } else if (!canQuote) {
    unpricedReason = 'availability_unknown';
  } else {
    let offers;
    if (pricing.offers === undefined || pricing.offers === null) offers = [];
    else if (!Array.isArray(pricing.offers)) throw fail('AGODA_PRICE_SCHEMA', 'Agoda available property offers were not an array');
    else offers = pricing.offers;

    const roomOffers = [];
    for (const offer of offers) {
      if (!offer || typeof offer !== 'object' || Array.isArray(offer)) {
        throw fail('AGODA_PRICE_SCHEMA', 'Agoda available property offer had an unexpected type');
      }
      if (offer.roomOffers === undefined || offer.roomOffers === null) continue;
      if (!Array.isArray(offer.roomOffers)) throw fail('AGODA_PRICE_SCHEMA', 'Agoda available property roomOffers were not an array');
      roomOffers.push(...offer.roomOffers);
    }
    roomOfferCount = roomOffers.length;

    for (const roomOffer of roomOffers) {
      if (!roomOffer || typeof roomOffer !== 'object' || Array.isArray(roomOffer)) {
        throw fail('AGODA_PRICE_SCHEMA', 'Agoda available room offer had an unexpected type');
      }
      const room = roomOffer.room;
      if (!room || typeof room !== 'object' || Array.isArray(room)) {
        throw fail('AGODA_PRICE_SCHEMA', 'Agoda available room offer omitted its room object');
      }
      let normalizedPrices = [];
      if (room.pricing !== undefined && room.pricing !== null) {
        if (!Array.isArray(room.pricing)) throw fail('AGODA_PRICE_SCHEMA', 'Agoda room pricing was not an array');
        priceEntryCount += room.pricing.length;
        normalizedPrices = room.pricing.map(entry => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.currency !== 'string' || !entry.currency) {
            throw fail('AGODA_PRICE_SCHEMA', 'Agoda currency price row had an unexpected type');
          }
          const currency = entry.currency.toUpperCase();
          currenciesObserved.add(currency);
          const normalized = normalizePrice(entry.price, currency);
          if (currency === 'KRW') {
            krwEntryFound = true;
            invalidKrwAmount ||= normalized.invalidAmount;
            return normalized.hasPositive ? normalized.quote : null;
          }
          foreignCurrencyPriceFound ||= normalized.hasPositive;
          return null;
        }).filter(Boolean);
      }
      rooms.push({
        availableRooms: safeInteger(room.availableRooms),
        isPromoEligible: typeof room.isPromoEligible === 'boolean' ? room.isPromoEligible : null,
        discountDeals: Array.isArray(room.discount?.deals)
          ? room.discount.deals.filter(value => typeof value === 'string').map(value => value.slice(0, 100)).slice(0, 20)
          : [],
        prices: normalizedPrices,
      });
    }

    if (!roomOfferCount || !priceEntryCount) unpricedReason = 'pricing_missing_or_no_offers';
    else if (!rooms.some(room => room.prices.length > 0)) {
      if (invalidKrwAmount) unpricedReason = 'invalid_amounts';
      else if (!krwEntryFound && foreignCurrencyPriceFound) unpricedReason = 'unsupported_currency';
      else unpricedReason = 'pricing_missing_or_no_offers';
    }
  }

  const hasKrwQuote = rooms.some(room => room.prices.length > 0);
  const propertyPage = safeAgodaUrl(content?.propertyLinks?.propertyPage);
  const name = safeText(content?.localeName) ?? safeText(content?.displayName) ?? safeText(content?.defaultName);
  return {
    propertyId: safeInteger(row?.propertyId),
    name,
    city: safeText(address?.city?.name),
    country: safeText(address?.country?.name),
    countryCode: safeText(address?.countryCode, 8),
    rating: typeof content?.rating === 'number' && Number.isFinite(content.rating) ? content.rating : null,
    reviewCount: safeInteger(row?.content?.reviews?.cumulative?.reviewCount),
    reviewScore: typeof row?.content?.reviews?.cumulative?.score === 'number'
      && Number.isFinite(row.content.reviews.cumulative.score)
      ? row.content.reviews.cumulative.score
      : null,
    propertyUrl: propertyPage,
    observedAt,
    availability: {
      isAvailable: typeof pricing?.isAvailable === 'boolean' ? pricing.isAvailable : null,
      isReady: typeof pricing?.isReady === 'boolean' ? pricing.isReady : null,
      quotePermitted: canQuote,
    },
    priceCoverage: {
      quoted: hasKrwQuote,
      reason: hasKrwQuote ? null : unpricedReason ?? 'pricing_missing_or_no_offers',
      currenciesObserved: [...currenciesObserved].sort(),
    },
    stay: {
      checkIn: stay.checkIn,
      checkOut: stay.checkOut,
      nights: stay.nights,
      adults: 2,
      children: 0,
      rooms: 1,
      currency: 'KRW',
    },
    rooms,
  };
}

function safeAgodaUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  try {
    const url = new URL(raw, HOME_URL);
    if (url.protocol !== 'https:' || url.hostname !== 'www.agoda.com' || url.username || url.password) return null;
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function parsePropertySummaryPayload(payload, { requestedIds, observedAt, input }) {
  if (payload?.errors !== undefined && payload.errors !== null && !Array.isArray(payload.errors)) {
    throw fail('AGODA_GRAPHQL_SCHEMA', 'Agoda property summary errors field had an unexpected type');
  }
  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    throw fail('AGODA_GRAPHQL_ERRORS', 'Agoda property summary returned GraphQL errors');
  }
  const rows = payload?.data?.propertySummarySearch?.properties;
  if (!Array.isArray(rows)) throw fail('AGODA_GRAPHQL_SCHEMA', 'Agoda property summary response omitted properties');
  const seen = new Set();
  const requested = new Set(requestedIds);
  const properties = [];
  for (const row of rows) {
    const id = row?.propertyId;
    if (!Number.isSafeInteger(id) || !requested.has(id)) {
      throw fail('AGODA_PROPERTY_SET_MISMATCH', 'Agoda property response contained an unexpected property identifier');
    }
    if (seen.has(id)) throw fail('AGODA_PROPERTY_SET_MISMATCH', 'Agoda property response contained a duplicate property identifier');
    seen.add(id);
    const property = normalizeHotel(row, observedAt, input);
    if (!property.name) throw fail('AGODA_GRAPHQL_SCHEMA', 'Agoda property response omitted a hotel display name');
    properties.push(property);
  }
  if (properties.length === 0) throw fail('AGODA_GRAPHQL_SCHEMA', 'Agoda property summary response contained no properties');
  const missingPropertyIds = requestedIds.filter(id => !seen.has(id));
  const priceCount = properties.reduce((sum, property) => sum + property.rooms.reduce((roomSum, room) => roomSum + room.prices.length, 0), 0);
  const pricedPropertyCount = properties.filter(property => property.priceCoverage.quoted).length;
  const unpricedPropertyCount = properties.length - pricedPropertyCount;
  const unpricedReasonCounts = {};
  for (const property of properties) {
    if (!property.priceCoverage.quoted) {
      const reason = property.priceCoverage.reason;
      unpricedReasonCounts[reason] = (unpricedReasonCounts[reason] ?? 0) + 1;
    }
  }
  const unsupportedCurrencies = [...new Set(properties
    .filter(property => property.priceCoverage.reason === 'unsupported_currency')
    .flatMap(property => property.priceCoverage.currenciesObserved))].sort();
  const priceCoverageStatus = pricedPropertyCount === 0
    ? 'no_quotes'
    : missingPropertyIds.length === 0 && pricedPropertyCount === properties.length ? 'quoted' : 'partial';
  return {
    sourceId: 'agoda-hotel',
    operation: 'propertySummarySearch',
    sourceUrl: PROPERTY_SUMMARY_URL,
    observedAt,
    returnedPropertyCount: properties.length,
    pricedPropertyCount,
    unpricedPropertyCount,
    quoteCount: priceCount,
    missingPropertyIds,
    identityCoverage: {
      status: missingPropertyIds.length ? 'partial' : 'complete',
      requestedPropertyCount: requestedIds.length,
      returnedPropertyCount: properties.length,
      missingPropertyCount: missingPropertyIds.length,
      missingPropertyIds,
    },
    priceCoverage: {
      status: priceCoverageStatus,
      pricedPropertyCount,
      unpricedPropertyCount,
      quoteCount: priceCount,
      unsupportedCurrencyCount: unpricedReasonCounts.unsupported_currency ?? 0,
      invalidAmountCount: unpricedReasonCounts.invalid_amounts ?? 0,
      unsupportedCurrencies,
      unpricedReasonCounts,
      byProperty: properties.map(property => ({
        propertyId: property.propertyId,
        quoted: property.priceCoverage.quoted,
        reason: property.priceCoverage.reason,
        currenciesObserved: property.priceCoverage.currenciesObserved,
      })),
    },
    coverage: {
      paginationReplayed: false,
      stayDates: 'caller-supplied dates were sent in the observed public request',
      occupancy: '2 adults, 0 children, 1 room from the observed public request',
      priceBasis: 'KRW values preserve exclusive, inclusive and per-book fields; per-room-per-night is the request basis',
      quoteEligibility: 'numeric offers are retained only when both isAvailable and isReady are true',
      taxesAndFees: 'both displayed inclusive and exclusive values are retained; no checkout total was verified',
      checkoutPriceVerified: false,
    },
    execution: { mode: 'pure_http', representation: 'observed GraphQL JSON', auth: 'anonymous', browserUsed: false },
    properties,
  };
}

function sanitizeCampaignCard(card) {
  const categories = Array.isArray(card?.categories) ? card.categories.slice(0, 30).map(category => ({
    categoryId: safeInteger(category?.categoryId),
    name: safeText(category?.categoryName, 120),
    description: safeText(category?.categoryDescription, 300),
  })) : [];
  const content = card?.content ?? {};
  return {
    cardId: safeInteger(card?.cardId),
    cardName: safeText(card?.cardName, 160),
    cardType: safeText(card?.cardType, 80),
    productFunnel: safeText(card?.productFunnel, 80),
    categories,
    content: {
      title: safeText(content?.title),
      description: safeText(content?.description),
      buttonText: safeText(content?.buttonText, 200),
      buttonUrl: safeAgodaUrl(content?.buttonUrl),
    },
  };
}

function parseCampaignPayload(payload, observedAt) {
  if (payload?.isSuccess !== true || (payload.error !== undefined && payload.error !== null)) {
    throw fail('AGODA_CAMPAIGN_ERROR', 'Agoda campaign endpoint did not report success');
  }
  const sections = payload?.result?.sections;
  if (!Array.isArray(sections)) throw fail('AGODA_CAMPAIGN_SCHEMA', 'Agoda campaign response omitted sections');
  const matching = sections.filter(section => section?.sectionName === 'entire_page');
  if (matching.length !== 1 || !Array.isArray(matching[0].cards)) {
    throw fail('AGODA_CAMPAIGN_SCHEMA', 'Agoda campaign response did not contain one entire-page card section');
  }
  const cards = matching[0].cards.map(sanitizeCampaignCard);
  const cardIds = cards.map(card => card.cardId).filter(id => id !== null);
  if (new Set(cardIds).size !== cardIds.length) throw fail('AGODA_CAMPAIGN_SCHEMA', 'Agoda campaign response contained duplicate card identifiers');
  return {
    sourceId: 'agoda-hotel',
    operation: 'campaigns',
    sourceUrl: CAMPAIGNS_URL,
    observedAt,
    sectionName: 'entire_page',
    returnedCardCount: cards.length,
    cards,
    coverage: {
      rows: 'cards in the observed entire_page campaign response only',
      productOffers: 'campaign cards may include informational or coupon cards; hotel offer prices are not included',
      couponEligibility: 'not verified; no coupon claim or action was performed',
      expiry: 'relative expiry text is preserved in each card description without converting it to a calendar date',
    },
    execution: { mode: 'pure_http', representation: 'observed JSON', auth: 'anonymous', browserUsed: false },
  };
}

export class AgodaHotelClient {
  constructor({
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    minHostIntervalMs = MIN_HOST_INTERVAL_MS,
    maxBodyBytes = MAX_BODY_BYTES,
    randomUUIDImpl = randomUUID,
    now = () => new Date(),
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
      throw new TypeError('timeoutMs must be an integer from 1 to 120000');
    }
    if (!Number.isSafeInteger(minHostIntervalMs) || minHostIntervalMs < 0 || minHostIntervalMs > 60000) {
      throw new TypeError('minHostIntervalMs must be an integer from 0 to 60000');
    }
    if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > MAX_BODY_BYTES) {
      throw new TypeError('maxBodyBytes must be an integer from 1024 to 4194304');
    }
    if (typeof randomUUIDImpl !== 'function' || typeof now !== 'function') throw new TypeError('ID and clock providers must be functions');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.minHostIntervalMs = minHostIntervalMs;
    this.maxBodyBytes = maxBodyBytes;
    this.randomUUIDImpl = randomUUIDImpl;
    this.now = now;
  }

  async #request(url, { method, headers, body, expectedType, stage }) {
    const delay = this.minHostIntervalMs - (Date.now() - lastRequestAt);
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    lastRequestAt = Date.now();
    const observedAt = this.now().toISOString();
    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        credentials: 'omit',
        redirect: 'manual',
        headers,
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw fail('AGODA_NETWORK_ERROR', `Agoda ${stage} request failed before a response was read`, {
        origin: ORIGIN,
        path: new URL(url).pathname,
        method,
        auth: 'anonymous',
      });
    }

    const contentType = response.headers.get('content-type') ?? '';
    const metadata = {
      origin: ORIGIN,
      path: new URL(url).pathname,
      method,
      status: response.status,
      contentType,
      auth: 'anonymous',
      observedAt,
    };
    if (response.status !== 200 || !expectedType.test(contentType)) {
      try { await response.body?.cancel(); } catch { /* response details stay out of errors */ }
      throw fail('AGODA_RESPONSE_UNAVAILABLE', `Agoda ${stage} did not return the observed response type with HTTP 200`, metadata);
    }
    const bytes = await boundedBytes(response, this.maxBodyBytes, stage);
    metadata.bytes = bytes.byteLength;
    return { bytes, metadata };
  }

  async #issuerUserId() {
    const { bytes, metadata } = await this.#request(HOME_URL, {
      method: 'GET',
      headers: {
        accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        'accept-language': 'ko-KR,ko;q=0.9,en;q=0.5',
      },
      expectedType: /text\/html/i,
      stage: 'public bootstrap',
    });
    const html = bytes.toString('utf8');
    const userId = extractBootstrapUserId(html);
    return { userId, metadata };
  }

  async rates(input) {
    const validationTime = this.now();
    const validated = validateRateInput(input, validationTime);
    const stay = {
      ...validated,
      nights: (Date.parse(`${validated.checkOut}T00:00:00.000Z`) - Date.parse(`${validated.checkIn}T00:00:00.000Z`)) / 86400000,
    };
    const { userId } = await this.#issuerUserId();
    const searchId = this.randomUUIDImpl();
    if (typeof searchId !== 'string' || !UUID_RE.test(searchId)) throw fail('AGODA_REQUEST_ID_INVALID', 'Local search request ID provider returned an invalid value');

    const variables = cloneJson(REQUEST_TEMPLATE);
    variables.PropertySummarySearchRequest.propertyIds = validated.propertyIds;
    const pricing = variables.PricingSummaryRequest;
    pricing.context.clientInfo.userId = userId;
    pricing.context.clientInfo.searchId = searchId;
    pricing.pricing.bookingDate = this.now().toISOString();
    pricing.pricing.checkIn = `${validated.checkIn}T00:00:00.000Z`;
    pricing.pricing.checkout = `${validated.checkOut}T00:00:00.000Z`;
    pricing.pricing.localCheckInDate = validated.checkIn;
    pricing.pricing.localCheckoutDate = validated.checkOut;
    pricing.pricing.occupancy = { adults: 2, children: 0, childAges: [], rooms: 1, childrenTypes: [] };
    pricing.pricing.currency = 'KRW';
    const requestBody = JSON.stringify({
      operationName: 'propertySummarySearch',
      variables,
      query: PROPERTY_SUMMARY_QUERY,
    });
    if (Buffer.byteLength(requestBody, 'utf8') > 256 * 1024) throw fail('AGODA_REQUEST_TOO_LARGE', 'Agoda property request exceeded its bounded size');

    const { bytes, metadata } = await this.#request(PROPERTY_SUMMARY_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'ag-language-locale': 'ko-kr',
        'ag-page-type-id': '90000',
      },
      body: requestBody,
      expectedType: /application\/json/i,
      stage: 'property summary',
    });
    let payload;
    try {
      payload = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw fail('AGODA_GRAPHQL_SCHEMA', 'Agoda property summary response was not valid JSON', metadata);
    }
    const result = parsePropertySummaryPayload(payload, {
      requestedIds: validated.propertyIds,
      observedAt: metadata.observedAt,
      input: stay,
    });
    return {
      metadata,
      result: {
        ...result,
        execution: { ...result.execution, liveReplay: this.fetchImpl === globalThis.fetch },
      },
    };
  }

  async campaigns() {
    const { userId } = await this.#issuerUserId();
    const requestBody = JSON.stringify({
      userSettings: { currencyCode: 'KRW', languageId: 1, languageLocale: 'en-us' },
      clientInfo: { userId, memberId: 0, clientVersion: '1.0', applicationName: 3 },
      platformInfo: { platform: 'web-desktop', pageTypeId: 88, sections: ['entire_page'] },
      sessionInfo: { cid: -1, origin: 'KR' },
      extraProperties: {},
    });
    const { bytes, metadata } = await this.#request(CAMPAIGNS_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'ag-language-id': '1',
        'ag-language-locale': 'en-us',
        'cr-currency-code': 'KRW',
        'cr-currency-id': '26',
        'x-client-id': '2000',
      },
      body: requestBody,
      expectedType: /application\/json/i,
      stage: 'campaign cards',
    });
    let payload;
    try {
      payload = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw fail('AGODA_CAMPAIGN_SCHEMA', 'Agoda campaign response was not valid JSON', metadata);
    }
    const result = parseCampaignPayload(payload, metadata.observedAt);
    return {
      metadata,
      result: {
        ...result,
        execution: { ...result.execution, liveReplay: this.fetchImpl === globalThis.fetch },
      },
    };
  }
}

export const AGODA_PUBLIC_ROUTES = Object.freeze({
  home: HOME_URL,
  propertySummary: PROPERTY_SUMMARY_URL,
  campaigns: CAMPAIGNS_URL,
});

export const AGODA_OBSERVED_PROPERTY_IDS = OBSERVED_PROPERTY_IDS;
