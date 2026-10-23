import { createHash } from 'node:crypto';
import { isVerificationChallenge } from './naver-shopping.mjs';

const ALLOWED_OPERATIONS = new Map([
  [
    'POST https://flight-api.naver.com/flight/international/searchFlights',
    { transport: 'sse' },
  ],
  [
    'POST https://flight-api.naver.com/flight/domestic/searchFlights',
    { transport: 'sse' },
  ],
  [
    'POST https://flight-api.naver.com/graphql',
    { transport: 'graphql', allowedOperations: new Set(['flightsCards', 'minPricesByDate', 'GET_PRICE_GRAPH']) },
  ],
  [
    'POST https://hermes-hotel-svc-api.naver.com/graphql',
    { transport: 'graphql', allowedOperations: new Set(['domesticHotelList', 'domesticHotelRates', 'HotelDailyMinPrices']) },
  ],
  [
    'POST https://travelsearch-api.naver.com/graphql',
    { transport: 'graphql', allowedOperations: new Set(['SEARCH_DOMESTIC']) },
  ],
  [
    'GET https://travel.naver.com/domestic',
    { transport: 'document' },
  ],
]);

const MAX_BYTES = 8 * 1024 * 1024;
// International flight SSE streams grew past 8 MiB on 2026-09-30 (ICN-NRT, ICN-KIX); documents keep the 8 MiB cap.
const MAX_SSE_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20000;

export class NaverTravelError extends Error {
  constructor(code, message, receipt = null) {
    super(message);
    this.name = 'NaverTravelError';
    this.code = code;
    this.receipt = receipt;
  }
}

function input(message) {
  throw new NaverTravelError('INPUT', message);
}

function integer(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    input(`${name} is out of range (${minimum}-${maximum})`);
  }
  return value;
}

function stringNonEmpty(value, name, maxLength = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || /[\u0000-\u001f]/.test(value)) {
    input(`${name} must contain 1-${maxLength} printable characters`);
  }
  return value.trim();
}

function airportCode(value, name = 'airport') {
  const code = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    input(`${name} must be a 3-letter IATA code`);
  }
  return code;
}

function getKoreaTodayIso() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function normalizeDateStr(value, name = 'date') {
  const str = String(value ?? '').trim();
  let y, m, d;
  if (/^\d{8}$/.test(str)) {
    y = Number(str.slice(0, 4));
    m = Number(str.slice(4, 6));
    d = Number(str.slice(6, 8));
  } else if (/^(\d{4})-(\d{2})-(\d{2})$/.test(str)) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
    y = Number(match[1]);
    m = Number(match[2]);
    d = Number(match[3]);
  } else {
    input(`${name} must be in YYYYMMDD or YYYY-MM-DD format`);
  }

  const normalized = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const dateObj = new Date(Date.UTC(y, m - 1, d));
  if (dateObj.toISOString().slice(0, 10) !== normalized) {
    input(`${name} is an invalid calendar date`);
  }

  const todayKst = getKoreaTodayIso();
  if (normalized < todayKst) {
    input(`${name} cannot be in the past (must be on or after ${todayKst} KST)`);
  }

  return {
    isoDate: normalized,
    compactDate: normalized.replace(/-/g, ''),
  };
}

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function observedBoolean(value) {
  return typeof value === 'boolean' ? value : null;
}

function sanitizeText(value, limit = 5000) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, x => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' }[x]))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function safePublicUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    return u.origin + u.pathname;
  } catch {
    return null;
  }
}

async function boundedBody(response, limit) {
  const cl = response.headers.get('content-length');
  if (cl && Number(cl) > limit) {
    await response.body?.cancel();
    throw new NaverTravelError('SIZE_LIMIT', 'Naver response exceeded the byte limit');
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new NaverTravelError('SIZE_LIMIT', 'Naver response exceeded the byte limit');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

async function boundedSseStream(response, { maxMessages = 250, timeoutMs = DEFAULT_TIMEOUT_MS, byteLimit = MAX_BYTES } = {}) {
  const reader = response.body?.getReader();
  if (!reader) return { messages: [], bytes: Buffer.alloc(0), isCompleted: false };

  const decoder = new TextDecoder();
  const chunks = [];
  let totalBytes = 0;
  let buffer = '';
  const messages = [];
  const startTime = Date.now();
  let isCompleted = false;

  try {
    while (true) {
      if (Date.now() - startTime > timeoutMs) break;

      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > byteLimit) {
        await reader.cancel();
        throw new NaverTravelError('SIZE_LIMIT', 'Naver SSE stream exceeded the byte limit');
      }

      chunks.push(Buffer.from(value));
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep last incomplete line

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data:')) {
          const jsonStr = trimmed.slice(5).trim();
          if (!jsonStr) continue; // skip heartbeat/empty
          let data;
          try {
            data = JSON.parse(jsonStr);
          } catch {
            await reader.cancel();
            throw new NaverTravelError('SCHEMA_CHANGED', 'Naver SSE event data frame was malformed JSON');
          }
          messages.push(data);
          if (data.status?.isCompleted === true || data.status?.isComplete === true) {
            isCompleted = true;
          }
          if (messages.length >= maxMessages || isCompleted) {
            await reader.cancel();
            return { messages, bytes: Buffer.concat(chunks), isCompleted };
          }
        }
      }
    }

    if (buffer.trim().startsWith('data:')) {
      const jsonStr = buffer.trim().slice(5).trim();
      if (jsonStr) {
        let data;
        try {
          data = JSON.parse(jsonStr);
        } catch {
          throw new NaverTravelError('SCHEMA_CHANGED', 'Naver SSE event trailing data frame was malformed JSON');
        }
        messages.push(data);
        if (data.status?.isCompleted === true || data.status?.isComplete === true) {
          isCompleted = true;
        }
      }
    }
  } finally {
    try { await reader.cancel(); } catch {}
    reader.releaseLock();
  }

  return { messages, bytes: Buffer.concat(chunks), isCompleted };
}

export function extractNextData(html) {
  const match = /<script\s+id="__NEXT_DATA__"\s+type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!match) {
    throw new NaverTravelError('SCHEMA_CHANGED', 'Naver travel document did not contain __NEXT_DATA__');
  }
  try {
    return JSON.parse(match[1]);
  } catch {
    throw new NaverTravelError('SCHEMA_CHANGED', 'Naver __NEXT_DATA__ was malformed JSON');
  }
}

/** Pure: shape one priceGraph payload like the flight.naver.com graph block (exported for tests). */
export function summarizeFlightPriceGraph(graph, { currentMinFare = null, receipt = null } = {}) {
  if (graph === null) return { available: false, averageLowestFare2w: null, series: [], summary: null, vs2WeekAvg: null };
  if (!graph || typeof graph !== 'object' || !Array.isArray(graph.fares)) throw new NaverTravelError('SCHEMA_CHANGED', 'priceGraph response structure changed', receipt);
  const series = graph.fares.map(f => {
    if (!f || typeof f !== 'object' || !/^\d{4}-\d{2}-\d{2}$/.test(String(f.searchDate ?? ''))) throw new NaverTravelError('SCHEMA_CHANGED', 'priceGraph fare entry changed', receipt);
    const v = Number(f.lowestFare);
    return { searchDate: f.searchDate, lowestFareKrw: Number.isFinite(v) && v > 0 ? v : null };
  });
  const avg2w = Number(graph.averageLowestFare);
  const averageLowestFare2w = Number.isFinite(avg2w) && avg2w > 0 ? Math.round(avg2w) : null;
  const current = Number.isFinite(currentMinFare) && currentMinFare > 0 ? currentMinFare : null;
  const values = series.map(s => s.lowestFareKrw).filter(v => v !== null).concat(current !== null ? [current] : []);
  const summary = values.length ? { minFareKrw: Math.min(...values), maxFareKrw: Math.max(...values),
    averageFareKrw: Math.round(values.reduce((a, b) => a + b, 0) / values.length), points: values.length, includesCurrent: current !== null } : null;
  let vs2WeekAvg = null;
  if (current !== null && averageLowestFare2w !== null) {
    const raw = (current - avg2w) / avg2w * 100;
    vs2WeekAvg = { currentMinFareKrw: current, pct: Math.round(Math.abs(raw)), direction: Math.abs(raw) <= 2 ? 'similar' : raw > 0 ? 'higher' : 'lower' };
  }
  return { available: series.length > 0, averageLowestFare2w, series, summary, vs2WeekAvg };
}

export class NaverTravelClient {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, responseByteLimit = MAX_BYTES, sseByteLimit = MAX_SSE_BYTES } = {}) {
    if (typeof fetchImpl !== 'function') input('fetchImpl must be a function');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = integer(timeoutMs, 'timeoutMs', 100, 60000);
    this.responseByteLimit = integer(responseByteLimit, 'responseByteLimit', 1, MAX_BYTES);
    this.sseByteLimit = integer(sseByteLimit, 'sseByteLimit', 1, MAX_SSE_BYTES);
  }

  async #request(url, { method = 'GET', payload, sse = false, json = false, referer = 'https://travel.naver.com/' } = {}) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.port || target.username || target.password || target.hash || target.search) {
      input('request target URL must be an https endpoint without port, credentials or hash');
    }

    const endpointKey = `${method.toUpperCase()} ${target.origin}${target.pathname}`;
    const endpointConfig = ALLOWED_OPERATIONS.get(endpointKey);
    if (!endpointConfig) {
      input(`destination ${endpointKey} is not an allowed Naver travel production endpoint`);
    }

    if (endpointConfig.transport === 'graphql') {
      if (!payload || typeof payload !== 'object' || typeof payload.query !== 'string') {
        input('GraphQL payload must be an object containing a query string');
      }
      const trimmedQuery = payload.query.trim();
      const opMatch = trimmedQuery.match(/^query\s+([A-Za-z0-9_]+)/);
      if (!opMatch || !endpointConfig.allowedOperations.has(opMatch[1])) {
        input(`GraphQL query operation is not in the allowed read-only operations for ${endpointKey}`);
      }
      if (/\b(?:mutation|subscription)\b/i.test(trimmedQuery)) {
        input('GraphQL mutation/subscription is strictly prohibited');
      }
    }

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      Accept: sse ? 'text/event-stream, application/json' : json ? 'application/json, text/plain, */*' : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      Origin: target.origin,
      Referer: referer,
      ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}),
    };

    let response;
    try {
      response = await this.fetchImpl(target, {
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers,
        ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
      });
    } catch {
      throw new NaverTravelError('TRANSPORT', 'Naver travel HTTP request failed');
    }

    // Evaluate HTTP rate-limiting immediately before reading large body
    if (response.status === 429) {
      await response.body?.cancel();
      throw new NaverTravelError('RATE_LIMITED', 'Naver travel returned HTTP 429; no automatic retry was made', {
        method,
        origin: target.origin,
        path: target.pathname,
        httpStatus: 429,
        responseContentType: response.headers.get('content-type') ?? '',
        responseDate: response.headers.get('date') ?? null,
        checkedAt: new Date().toISOString(),
      });
    }

    // Evaluate redirect rejection without exposing destination Location URL
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new NaverTravelError('REDIRECT_REJECTED', `Naver travel returned redirect status ${response.status}`, {
        method,
        origin: target.origin,
        path: target.pathname,
        httpStatus: response.status,
        responseContentType: response.headers.get('content-type') ?? '',
        responseDate: response.headers.get('date') ?? null,
        checkedAt: new Date().toISOString(),
      });
    }

    // Validate MIME types before stream or body processing
    const contentType = response.headers.get('content-type') ?? '';
    const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
    if (sse && [200, 201].includes(response.status) && mediaType !== 'text/event-stream') {
      await response.body?.cancel();
      throw new NaverTravelError('SCHEMA_CHANGED', `Expected text/event-stream but received ${contentType.split(';')[0] || 'empty'}`, {
        method,
        origin: target.origin,
        path: target.pathname,
        httpStatus: response.status,
        responseContentType: contentType,
        responseDate: response.headers.get('date') ?? null,
        checkedAt: new Date().toISOString(),
      });
    }
    if (json && [200, 201].includes(response.status) && mediaType !== 'application/json') {
      await response.body?.cancel();
      throw new NaverTravelError('SCHEMA_CHANGED', `Expected application/json but received ${contentType.split(';')[0] || 'empty'}`, {
        method,
        origin: target.origin,
        path: target.pathname,
        httpStatus: response.status,
        responseContentType: contentType,
        responseDate: response.headers.get('date') ?? null,
        checkedAt: new Date().toISOString(),
      });
    }

    let bytes;
    let sseResult = null;

    if (sse && (response.status === 200 || response.status === 201)) {
      try {
        sseResult = await boundedSseStream(response, {
          maxMessages: 200,
          timeoutMs: this.timeoutMs,
          byteLimit: this.sseByteLimit,
        });
        bytes = sseResult.bytes;
      } catch (err) {
        if (err instanceof NaverTravelError) throw err;
        throw new NaverTravelError('TRANSPORT', 'Naver travel SSE stream reading failed');
      }
    } else {
      try {
        bytes = await boundedBody(response, this.responseByteLimit);
      } catch (err) {
        if (err instanceof NaverTravelError) throw err;
        throw new NaverTravelError('TRANSPORT', 'Naver travel response could not be read');
      }
    }

    const bodyText = bytes.toString('utf8');
    const receipt = {
      method,
      origin: target.origin,
      path: target.pathname,
      queryFields: [...target.searchParams.keys()],
      bodyFields: payload && typeof payload === 'object' ? Object.keys(payload) : [],
      httpStatus: response.status,
      responseContentType: contentType,
      responseDate: response.headers.get('date') ?? null,
      responseBytes: bytes.length,
      responseSha256: createHash('sha256').update(bytes).digest('hex'),
      checkedAt: new Date().toISOString(),
      browserUsed: false,
      credentialsUsed: this.fetchImpl === globalThis.fetch ? false : null,
      transport: this.fetchImpl === globalThis.fetch ? 'anonymous_native_fetch' : 'caller_supplied_http',
    };

    const fail = (code, msg) => {
      throw new NaverTravelError(code, msg, receipt);
    };

    if (response.status === 418 || /접속이 일시적으로 제한/.test(bodyText)) fail('WAF_BLOCKED', 'Naver travel restricted this request');
    if (isVerificationChallenge(bodyText)) fail('CAPTCHA_REQUIRED', 'Naver returned a verification challenge');
    if (response.status === 401 || /<title[^>]*>\s*네이버\s*로그인/.test(bodyText)) {
      fail('AUTH_REQUIRED', 'Naver requires an authorized session');
    }
    if (response.status !== 200 && response.status !== 201) {
      fail('HTTP_STATUS', `Naver returned HTTP ${response.status}`);
    }

    if (sse) {
      return { sseData: sseResult, receipt };
    }
    if (json) {
      let parsed;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        fail('SCHEMA_CHANGED', 'Naver returned malformed JSON');
      }
      if (parsed && Array.isArray(parsed.errors) && parsed.errors.length > 0) {
        fail('GRAPHQL_ERROR', 'Naver travel GraphQL endpoint returned operation errors');
      }
      return { data: parsed, receipt };
    }

    return { data: bodyText, receipt };
  }

  /**
   * Search real-time flights via the production-observed Naver Flight SSE contract.
   */
  async flightSearch({
    type,
    departureAirport: rawDep,
    arrivalAirport: rawArr,
    departureDate: rawDepDate,
    returnDate: rawRetDate = null,
    tripType: rawTripType = null,
    adult = 1,
    child = 0,
    infant = 0,
    seatClass = 'Y',
    isNonstop = false,
    leg = null,
  } = {}) {
    // Domestic round trips list each leg separately: the site sends flightFilter.filter.type departure|arrival.
    if (leg !== null && !(type === 'domestic' && ['departure', 'arrival'].includes(leg))) input('leg is departure or arrival, for domestic searches only');
    if (type !== 'international' && type !== 'domestic') {
      input('type must be either "international" or "domestic"');
    }
    const flightType = type;

    const depCode = airportCode(rawDep, 'departureAirport');
    const arrCode = airportCode(rawArr, 'arrivalAirport');
    if (depCode === arrCode) input('departureAirport and arrivalAirport must be different');

    const depD = normalizeDateStr(rawDepDate, 'departureDate');
    const retD = rawRetDate ? normalizeDateStr(rawRetDate, 'returnDate') : null;
    const tripType = rawTripType ?? (retD ? 'RT' : 'OW');

    if (tripType !== 'OW' && tripType !== 'RT') {
      input('tripType must be "OW" (one-way) or "RT" (round-trip)');
    }
    if (rawTripType === 'OW' && retD) {
      input('returnDate must not be provided for one-way (OW) trip');
    }
    if (tripType === 'RT' && !retD) {
      input('returnDate is required for round-trip (RT) trip');
    }
    if (retD && retD.compactDate < depD.compactDate) {
      input('returnDate must be on or after departureDate');
    }

    if (typeof isNonstop !== 'boolean') {
      input('isNonstop must be a boolean');
    }
    if (flightType === 'domestic' && isNonstop) {
      input('isNonstop is supported only by the observed international flight contract');
    }

    integer(adult, 'adult', 1, 9);
    integer(child, 'child', 0, 8);
    integer(infant, 'infant', 0, 9);
    if (adult + child > 9) {
      input('Total seated passengers (adult + child) cannot exceed 9');
    }
    if (infant > adult) {
      input('Infant count cannot exceed adult count (each infant requires an adult)');
    }

    const allowedClasses = new Set(['Y', 'C', 'F', 'W']);
    if (!allowedClasses.has(seatClass)) input('seatClass must be one of Y, C, F, W');

    let endpointUrl;
    let payload;

    if (flightType === 'international') {
      endpointUrl = 'https://flight-api.naver.com/flight/international/searchFlights';
      const itineraries = [
        {
          departureLocationCode: depCode,
          departureLocationType: 'airport',
          arrivalLocationCode: arrCode,
          arrivalLocationType: 'airport',
          departureDate: depD.compactDate,
        },
      ];
      if (tripType === 'RT' && retD) {
        itineraries.push({
          departureLocationCode: arrCode,
          departureLocationType: 'airport',
          arrivalLocationCode: depCode,
          arrivalLocationType: 'airport',
          departureDate: retD.compactDate,
        });
      }

      payload = {
        tripType,
        device: 'pc',
        seatClass,
        adultCount: adult,
        childCount: child,
        infantCount: infant,
        isNonstop,
        openReturnDays: 0,
        itineraries,
        initialRequest: true,
      };
    } else {
      endpointUrl = 'https://flight-api.naver.com/flight/domestic/searchFlights';
      const itineraries = [
        {
          departureAirport: depCode,
          arrivalAirport: arrCode,
          departureDate: depD.compactDate,
        },
      ];
      if (tripType === 'RT' && retD) {
        itineraries.push({
          departureAirport: arrCode,
          arrivalAirport: depCode,
          departureDate: retD.compactDate,
        });
      }

      payload = {
        type: 'domestic',
        device: 'pc',
        fareType: seatClass,
        person: { adult, child, infant },
        tripType,
        itineraries,
        ...(leg ? { flightFilter: { filter: { type: leg }, limit: 50, skip: 0, sort: { minFare: 1 } } } : {}),
      };
    }

    const { sseData, receipt } = await this.#request(endpointUrl, {
      method: 'POST',
      payload,
      sse: true,
      referer: `https://flight.naver.com/flights/${flightType}/${depCode}-${arrCode}-${depD.compactDate}/${tripType === 'RT' && retD ? `${arrCode}-${depCode}-${retD.compactDate}` : ''}`,
    });

    const messages = sseData.messages;
    if (!messages.length) {
      throw new NaverTravelError('SCHEMA_CHANGED', 'Flight stream returned zero event messages', receipt);
    }
    if (messages.some(m => !m || typeof m !== 'object' || Array.isArray(m) || m.error || (Array.isArray(m.errors) && m.errors.length))) {
      throw new NaverTravelError('SCHEMA_CHANGED', 'Flight stream returned an invalid or failed event schema', receipt);
    }
    const inventoryObserved = messages.some(m => flightType === 'international'
      ? Array.isArray(m.itineraries) || Array.isArray(m.fareMappings)
      : Array.isArray(m.flights) || Array.isArray(m.schedules));
    if (!inventoryObserved) {
      throw new NaverTravelError('SCHEMA_CHANGED', 'Flight stream did not contain an observed inventory schema', receipt);
    }

    const items = [];
    const airlinesMap = {};

    if (flightType === 'international') {
      const itinerariesMap = new Map();
      const fareMappingsMap = new Map();

      for (const msg of messages) {
        if (msg.status?.airlinesCodeMap) {
          Object.assign(airlinesMap, msg.status.airlinesCodeMap);
        }
        if (Array.isArray(msg.itineraries)) {
          for (const it of msg.itineraries) {
            if (it?.itineraryId) itinerariesMap.set(it.itineraryId, it);
          }
        }
        if (Array.isArray(msg.fareMappings)) {
          for (const fm of msg.fareMappings) {
            if (fm?.itineraryIds) fareMappingsMap.set(fm.itineraryIds, fm);
          }
        }
      }

      for (const [itineraryIds, fm] of fareMappingsMap.entries()) {
        const legIds = typeof itineraryIds === 'string' ? itineraryIds.split('-') : [];
        const fare = fm.fares?.[0];
        const adultFare = numeric(fare?.adult?.totalFare);
        const childFare = numeric(fare?.child?.totalFare);
        const infantFare = numeric(fare?.infant?.totalFare);
        const partnerCode = fare?.partnerCode ?? null;
        // Every seller's adult fare for this itinerary, cheapest first. The stream carries partner codes only
        // (status has no name map and reservationUrl is empty until a click).
        const partnerOffers = (Array.isArray(fm.fares) ? fm.fares : [])
          .map(f => ({ partnerCode: f?.partnerCode ?? null, adultTotalFareKrw: numeric(f?.adult?.totalFare) }))
          .filter(o => o.partnerCode && o.adultTotalFareKrw !== null)
          .sort((a, b) => a.adultTotalFareKrw - b.adultTotalFareKrw);

        const resolvedLegs = legIds.map((legId, idx) => {
          const it = itinerariesMap.get(legId);
          if (!it) {
            return {
              legIndex: idx,
              itineraryId: legId,
              status: 'missing_definition',
              departureAirport: null,
              arrivalAirport: null,
              departureDateTime: null,
              arrivalDateTime: null,
              airlineCode: null,
              airlineName: null,
              flightNumber: null,
              durationMinutes: null,
              stops: null,
            };
          }
          const segs = Array.isArray(it.segments) ? it.segments : [];
          const fSeg = segs[0] ?? {};
          const lSeg = segs[segs.length - 1] ?? fSeg;
          const depDt = fSeg.departure?.date && fSeg.departure?.time ? `${fSeg.departure.date}T${fSeg.departure.time}` : null;
          const arrDt = lSeg.arrival?.date && lSeg.arrival?.time ? `${lSeg.arrival.date}T${lSeg.arrival.time}` : null;
          const mCarrier = fSeg.marketingCarrier?.airlineCode ?? null;
          return {
            legIndex: idx,
            itineraryId: legId,
            status: segs.length ? 'resolved' : 'missing_segment_definitions',
            airlineCode: mCarrier,
            airlineName: airlinesMap[mCarrier] ?? mCarrier ?? null,
            flightNumber: fSeg.marketingCarrier?.flightNumber ?? null,
            departureAirport: fSeg.departure?.airportCode ?? null,
            arrivalAirport: lSeg.arrival?.airportCode ?? null,
            departureDateTime: depDt,
            arrivalDateTime: arrDt,
            durationMinutes: typeof it.duration === 'number' ? Math.round(it.duration / 60) : null,
            stops: segs.length ? segs.length - 1 : null,
          };
        });

        const outbound = resolvedLegs[0] ?? {};
        const isAllResolved = resolvedLegs.length > 0 && resolvedLegs.every(l => l.status === 'resolved');

        items.push({
          provider: 'naver-flight',
          type: 'international',
          itineraryIds,
          airlineCode: outbound.airlineCode ?? null,
          airlineName: outbound.airlineName ?? null,
          flightNumber: outbound.flightNumber ?? null,
          departureAirport: outbound.departureAirport ?? null,
          arrivalAirport: outbound.arrivalAirport ?? null,
          departureDateTime: outbound.departureDateTime ?? null,
          arrivalDateTime: outbound.arrivalDateTime ?? null,
          durationMinutes: outbound.durationMinutes ?? null,
          stops: outbound.stops ?? null,
          legs: resolvedLegs,
          metadataStatus: isAllResolved ? 'fully_resolved' : 'partial_or_missing_definition',
          currency: 'KRW',
          listingPriceKrw: adultFare,
          childPriceKrw: childFare,
          infantPriceKrw: infantFare,
          priceScope: 'per_adult',
          sourcePriceField: 'adult.totalFare',
          occupancyPricingVerified: false,
          partnerCode,
          partnerOffers,
          isConfirmed: observedBoolean(fare?.isConfirmed),
          curation: Array.isArray(fm.curation) ? fm.curation : [],
          payablePriceVerified: false,
          optionsVerified: false,
          checkoutVerified: false,
          contentTrust: 'untrusted_external_text',
        });
      }
    } else {
      const domesticItems = new Map();
      for (const msg of messages) {
        if (msg.status?.airlinesCodeMap) {
          Object.assign(airlinesMap, msg.status.airlinesCodeMap);
        }
        const flightList = Array.isArray(msg.flights) ? msg.flights : Array.isArray(msg.schedules) ? msg.schedules : [];
        for (const s of flightList) {
          const seg = s.segment ?? {};
          const minFare = numeric(s.minFare) ?? numeric(s.fares?.[0]?.adultTotalFare);
          const flightId = seg.segmentId ?? `${seg.airlineCode}${seg.flightNumber}_${seg.departure?.time}`;
          domesticItems.set(flightId, {
            provider: 'naver-flight',
            type: 'domestic',
            legType: s.type ?? null,
            itineraryId: flightId,
            airlineCode: seg.airlineCode ?? null,
            airlineName: airlinesMap[seg.airlineCode] ?? seg.airlineCode ?? null,
            flightNumber: seg.flightNumber ?? null,
            departureAirport: seg.departure?.airportCode ?? depCode,
            arrivalAirport: seg.arrival?.airportCode ?? arrCode,
            departureDate: seg.departure?.date ?? null,
            departureTime: seg.departure?.time ?? null,
            arrivalDate: seg.arrival?.date ?? null,
            arrivalTime: seg.arrival?.time ?? null,
            durationMinutes: numeric(seg.flightDuration) ?? numeric(s.duration),
            currency: 'KRW',
            listingPriceKrw: minFare,
            priceScope: 'per_leg',
            sourcePriceField: 's.minFare',
            occupancyPricingVerified: false,
            seatClass: s.seatClass ?? seatClass,
            seatCount: numeric(s.seatCount),
            fareCount: Array.isArray(s.fares) ? s.fares.length : 0,
            payablePriceVerified: false,
            optionsVerified: false,
            checkoutVerified: false,
            contentTrust: 'untrusted_external_text',
          });
        }
      }
      items.push(...domesticItems.values());
    }

    return {
      scope: `naver_flight_${flightType}`,
      searchCriteria: {
        flightType,
        departureAirport: depCode,
        arrivalAirport: arrCode,
        departureDate: depD.isoDate,
        returnDate: retD ? retD.isoDate : null,
        tripType,
        seatClass,
        adult,
        child,
        infant,
        isNonstop,
      },
      streamCompleted: sseData.isCompleted,
      currency: 'KRW',
      checkedAt: receipt.checkedAt,
      totalCount: items.length,
      items,
      receipt,
    };
  }

  /**
   * Lowest fare per departure date for one route, about a year ahead (the flight.naver.com price calendar).
   * Variables follow the site's own calendar call: OW sends no dates; RT sends tripDays [n, n] (n = trip length in days).
   */
  async flightCalendar({ departure, departureType = 'CITY', arrival, arrivalType = 'CITY', tripType = 'RT', tripDays = 4, nonstop = false } = {}) {
    for (const code of [departure, arrival]) if (typeof code !== 'string' || !/^[A-Z]{3}$/.test(code)) input('Location codes must be 3-letter IATA city or airport codes');
    for (const type of [departureType, arrivalType]) if (!['CITY', 'AIRPORT'].includes(type)) input('Location type must be CITY or AIRPORT');
    if (!['OW', 'RT'].includes(tripType)) input('tripType must be OW or RT');
    const days = tripType === 'RT' ? integer(tripDays, 'tripDays', 2, 30) : null;
    const query = `query minPricesByDate($departureLocationCode: String $departureLocationType: String $arrivalLocationCode: String $arrivalLocationType: String $departureDate: String $groupByDepartureDate: Boolean $isNonstop: Boolean $timeCategories: [DepartureTimeCategory!] $tripDays: [Int!] $tripType: String) { minPricesByDate(departureLocationCode: $departureLocationCode departureLocationType: $departureLocationType arrivalLocationCode: $arrivalLocationCode arrivalLocationType: $arrivalLocationType departureDate: $departureDate groupByDepartureDate: $groupByDepartureDate isNonstop: $isNonstop timeCategories: $timeCategories tripDays: $tripDays tripType: $tripType) { departureDate returnDate minPrice tripType } }`;
    const variables = { departureLocationCode: departure, departureLocationType: departureType, arrivalLocationCode: arrival, arrivalLocationType: arrivalType,
      ...(nonstop ? { isNonstop: true } : {}), ...(days ? { tripDays: [days, days] } : {}), tripType };
    const { data, receipt } = await this.#request('https://flight-api.naver.com/graphql', {
      method: 'POST', payload: { query, variables }, json: true, referer: 'https://flight.naver.com/',
    });
    if (Array.isArray(data?.errors) && data.errors.length) throw new NaverTravelError('GRAPHQL_ERROR', 'Naver flight calendar returned errors', receipt);
    const rows = data?.data?.minPricesByDate;
    if (!Array.isArray(rows)) throw new NaverTravelError('SCHEMA_CHANGED', 'minPricesByDate response structure changed', receipt);
    const items = rows.map(r => {
      if (!r || typeof r !== 'object' || !/^\d{8}$/.test(String(r.departureDate ?? ''))) throw new NaverTravelError('SCHEMA_CHANGED', 'minPricesByDate entry changed', receipt);
      return { departureDate: r.departureDate, returnDate: r.returnDate ?? null, listingPriceKrw: numeric(r.minPrice) || null, tripType: r.tripType ?? tripType };
    });
    return {
      scope: 'naver_flight_price_calendar', route: { departure, departureType, arrival, arrivalType, tripType, tripDays: days, nonstop },
      priceScope: 'calendar_min_fare_per_adult', checkedAt: receipt.checkedAt, totalCount: items.length, items,
      payablePriceVerified: false, receipt,
    };
  }

  /**
   * The flight.naver.com results page's "항공권 가격 변동 그래프" (GET_PRICE_GRAPH on flight-api.naver.com/graphql):
   * the lowest fare Naver saw for this exact itinerary on each of the last `period` search days, plus the 2-week
   * average of those lowest fares. The site builds searchKey as fareType + per leg (yyyymmdd + origin + destination),
   * e.g. Y20261026ICNSPN20261030SPNICN, sends location types as lowercase `airport`/`city`, and defaults the
   * "카드요금" toggle on (includeEventFare). Summary mirrors the page: min/max/average over the series plus the current
   * fare when given (rounded average); vs2WeekAvg uses the page's rule ((current-avg)/avg, |x|<=2% is "similar").
   */
  async flightPriceGraph({ itinerary, fareType = 'Y', includeEventFare = true, nonstop = false, period = 60,
    departureLocationType = 'airport', arrivalLocationType = 'airport', currentMinFare = null } = {}) {
    if (!Array.isArray(itinerary) || itinerary.length < 1 || itinerary.length > 6) input('itinerary must list 1-6 legs');
    if (!['Y', 'P', 'C', 'F'].includes(fareType)) input('fareType must be Y, P, C or F');
    for (const t of [departureLocationType, arrivalLocationType]) if (!['airport', 'city'].includes(t)) input('location type must be airport or city');
    const days = integer(period, 'period', 7, 365);
    const legs = itinerary.map(leg => {
      const date = String(leg?.departureDate ?? '').replace(/-/g, '');
      if (!/^\d{8}$/.test(date)) input('leg departureDate must be YYYYMMDD or YYYY-MM-DD');
      for (const code of [leg.origin, leg.destination]) if (typeof code !== 'string' || !/^[A-Z]{3}$/.test(code)) input('leg origin/destination must be 3-letter IATA codes');
      return { departureDate: date, origin: leg.origin, destination: leg.destination };
    });
    const searchKey = fareType + legs.map(l => `${l.departureDate}${l.origin}${l.destination}`).join('');
    const current = currentMinFare == null ? null : Number(currentMinFare);
    if (current !== null && !(Number.isFinite(current) && current > 0)) input('currentMinFare must be a positive number');
    const query = 'query GET_PRICE_GRAPH($searchKey: String!, $includeEventFare: Boolean!, $nonstop: Boolean!, $period: Int!, $departureLocationType: LocationType, $arrivalLocationType: LocationType) { priceGraph(searchKey: $searchKey, includeEventFare: $includeEventFare, nonstop: $nonstop, period: $period, departureLocationType: $departureLocationType, arrivalLocationType: $arrivalLocationType) { averageLowestFare fares { lowestFare searchDate } } }';
    const variables = { searchKey, includeEventFare: Boolean(includeEventFare), nonstop: Boolean(nonstop), period: days, departureLocationType, arrivalLocationType };
    const { data, receipt } = await this.#request('https://flight-api.naver.com/graphql', {
      method: 'POST', payload: { operationName: 'GET_PRICE_GRAPH', query, variables }, json: true, referer: 'https://flight.naver.com/',
    });
    if (Array.isArray(data?.errors) && data.errors.length) throw new NaverTravelError('GRAPHQL_ERROR', 'Naver flight price graph returned errors', receipt);
    return { ...summarizeFlightPriceGraph(data?.data?.priceGraph, { currentMinFare: current, receipt }),
      scope: 'naver_flight_price_graph', searchKey, legs, fareType, includeEventFare: Boolean(includeEventFare), nonstop: Boolean(nonstop), period: days,
      checkedAt: receipt.checkedAt, receipt };
  }

  /**
   * hotels.naver.com detail page "1박 최저가 추이" (HotelDailyMinPrices on hermes-hotel-svc-api): the 1-night lowest
   * room price Naver logged for this check-in date on each of the last ~30 days. The page averages all points and
   * compares the current per-night price (total / nights) with it: ratio = round((current - avg) / avg * 100).
   */
  async hotelPriceTrend({ hotelId, checkIn, currentNightlyPrice = null } = {}) {
    if (typeof hotelId !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(hotelId)) input('hotelId must be an id string');
    if (typeof checkIn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(checkIn)) input('checkIn must be YYYY-MM-DD');
    const current = currentNightlyPrice == null ? null : Number(currentNightlyPrice);
    if (current !== null && !(Number.isFinite(current) && current > 0)) input('currentNightlyPrice must be a positive number');
    const query = 'query HotelDailyMinPrices($hotelId: String!, $checkIn: String!) { hotelDailyMinPrices(hotelId: $hotelId, checkIn: $checkIn) { checkIn price roomName logDate } }';
    const { data, receipt } = await this.#request('https://hermes-hotel-svc-api.naver.com/graphql', {
      method: 'POST', payload: { operationName: 'HotelDailyMinPrices', query, variables: { hotelId, checkIn } }, json: true, referer: 'https://hotels.naver.com/',
    });
    if (Array.isArray(data?.errors) && data.errors.length) throw new NaverTravelError('GRAPHQL_ERROR', 'Naver hotel price trend returned errors', receipt);
    const rows = data?.data?.hotelDailyMinPrices;
    if (!Array.isArray(rows)) throw new NaverTravelError('SCHEMA_CHANGED', 'hotelDailyMinPrices response structure changed', receipt);
    const series = rows.map(r => {
      if (!r || typeof r !== 'object' || !/^\d{4}-\d{2}-\d{2}$/.test(String(r.logDate ?? ''))) throw new NaverTravelError('SCHEMA_CHANGED', 'hotelDailyMinPrices entry changed', receipt);
      return { logDate: r.logDate, nightlyPriceKrw: numeric(r.price), roomName: r.roomName != null ? sanitizeText(r.roomName) : null };
    });
    const values = series.map(x => x.nightlyPriceKrw).filter(v => Number.isFinite(v) && v > 0);
    const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    return {
      scope: 'naver_hotel_price_trend', hotelId, checkIn, series,
      summary: values.length ? { minNightlyKrw: Math.min(...values), maxNightlyKrw: Math.max(...values), averageNightlyKrw: Math.round(avg), points: values.length } : null,
      vsAverage: current !== null && avg ? { currentNightlyKrw: current, ratioPct: Math.round((current - avg) / avg * 100) } : null,
      checkedAt: receipt.checkedAt, receipt,
    };
  }

  /**
   * Flight promotion cards/categories.
   */
  async flightCards() {
    const query = `
      query flightsCards {
        flightsCards {
          code
          name
          category
          naverPaySaving
        }
      }
    `;
    const { data, receipt } = await this.#request('https://flight-api.naver.com/graphql', {
      method: 'POST',
      payload: { query },
      json: true,
      referer: 'https://flight.naver.com/',
    });

    const cards = data?.data?.flightsCards;
    if (!Array.isArray(cards)) {
      throw new NaverTravelError('SCHEMA_CHANGED', 'flightsCards response structure changed', receipt);
    }

    const cleanCards = cards.map(c => {
      if (!c || typeof c !== 'object') throw new NaverTravelError('SCHEMA_CHANGED', 'flightsCards entry was not an object', receipt);
      const code = c.code != null ? String(c.code) : null;
      const name = c.name != null ? sanitizeText(c.name) : null;
      if (!code || !name) throw new NaverTravelError('SCHEMA_CHANGED', 'flightsCards entry lacked code or name', receipt);
      return {
        code,
        name,
        category: c.category != null ? String(c.category) : '',
        naverPaySaving: observedBoolean(c.naverPaySaving),
      };
    });

    return {
      scope: 'naver_flight_cards',
      checkedAt: receipt.checkedAt,
      totalCount: cleanCards.length,
      cards: cleanCards,
      receipt,
    };
  }

  /**
   * Search domestic hotels via Hermes Hotel GraphQL API.
   */
  async hotelSearch({
    query: searchKeyword = '서울',
    from = 0,
    size = 10,
    sort = 'POPULAR_DESC',
    centerLat = 37.5665,
    centerLon = 126.9780,
    searchRadius = 20000,
  } = {}) {
    const q = stringNonEmpty(searchKeyword, 'query');
    integer(from, 'from', 0, 1000);
    integer(size, 'size', 1, 100);

    const allowedSorts = new Set([
      'POPULAR_DESC',
      'DISTANCE_ASC',
      'PRICE_ASC',
      'PRICE_DESC',
      'PRICE_MINRATE_ASC',
      'PRICE_MINRATE_DESC',
      'RATING_DESC',
      'STAR_RATING_DESC',
    ]);
    if (!allowedSorts.has(sort)) input('sort must be one of the observed DomesticHotelSortOrder values');

    if (typeof centerLat !== 'number' || !Number.isFinite(centerLat) || centerLat < -90 || centerLat > 90) {
      input('centerLat must be a valid latitude between -90 and 90');
    }
    if (typeof centerLon !== 'number' || !Number.isFinite(centerLon) || centerLon < -180 || centerLon > 180) {
      input('centerLon must be a valid longitude between -180 and 180');
    }
    integer(searchRadius, 'searchRadius', 100, 100000);

    const gql = `
      query domesticHotelList(
        $from: Int!
        $query: String!
        $size: Int!
        $sort: DomesticHotelSortOrder!
        $centerCoordinate: Coordinate
        $deviceType: DeviceType!
        $searchRadius: Int
      ) {
        domesticHotelList(
          from: $from
          query: $query
          size: $size
          sort: $sort
          centerCoordinate: $centerCoordinate
          deviceType: $deviceType
          searchRadius: $searchRadius
        ) {
          total
          from
          size
          itemList {
            id
            title
            hotelStarCount
            hotelOverallRating
            hotelPriceMinRate
            location {
              latitude
              longitude
            }
            hotelDescription
          }
        }
      }
    `;

    const variables = {
      from,
      size,
      query: q,
      sort,
      deviceType: 'PC',
      centerCoordinate: { lat: centerLat, lon: centerLon },
      searchRadius,
    };

    const { data, receipt } = await this.#request('https://hermes-hotel-svc-api.naver.com/graphql', {
      method: 'POST',
      payload: { query: gql, variables },
      json: true,
      referer: 'https://hotels.naver.com/',
    });

    const dhl = data?.data?.domesticHotelList;
    if (!dhl || !Array.isArray(dhl.itemList)) {
      throw new NaverTravelError('SCHEMA_CHANGED', 'domesticHotelList response schema changed', receipt);
    }

    const items = dhl.itemList.map(item => {
      if (!item || typeof item !== 'object') throw new NaverTravelError('SCHEMA_CHANGED', 'domesticHotelList item was not an object', receipt);
      const hid = item.id != null ? String(item.id) : null;
      const title = item.title != null ? sanitizeText(item.title, 200) : null;
      if (!hid || !title) throw new NaverTravelError('SCHEMA_CHANGED', 'domesticHotelList item lacked required id or title', receipt);
      return {
        provider: 'naver-hotel',
        hotelId: hid,
        title,
        currency: 'KRW',
        listingPriceKrw: numeric(item.hotelPriceMinRate),
        priceScope: 'indicative_hotel_min_rate_without_dates',
        sourcePriceField: 'hotelPriceMinRate',
        starCount: item.hotelStarCount != null ? String(item.hotelStarCount) : null,
        rating: numeric(item.hotelOverallRating),
        latitude: numeric(item.location?.latitude),
        longitude: numeric(item.location?.longitude),
        description: sanitizeText(item.hotelDescription, 500),
        payablePriceVerified: false,
        optionsVerified: false,
        checkoutVerified: false,
        contentTrust: 'untrusted_external_text',
      };
    });

    return {
      scope: 'naver_domestic_hotel_search',
      searchCriteria: {
        query: q,
        from,
        size,
        sort,
        centerCoordinate: { lat: centerLat, lon: centerLon },
        searchRadius,
      },
      currency: 'KRW',
      checkedAt: receipt.checkedAt,
      totalCount: numeric(dhl.total) ?? items.length,
      matchedCount: items.length,
      items,
      receipt,
    };
  }

  /**
   * Query real-time room rates and booking options for a specific hotel.
   */
  async hotelRates({
    hotelId: rawId,
    checkIn: checkInDate,
    checkOut: checkOutDate,
    adult = 2,
    childrenAges = [],
    queryName = '',
  } = {}) {
    const idStr = String(rawId ?? '').trim();
    if (!/^[1-9]\d{0,18}$/.test(idStr)) {
      input('hotelId must be a positive integer ID string');
    }
    const inD = normalizeDateStr(checkInDate, 'checkIn');
    const outD = normalizeDateStr(checkOutDate, 'checkOut');
    if (outD.compactDate <= inD.compactDate) input('checkOut must be strictly after checkIn');

    integer(adult, 'adult', 1, 9);
    if (!Array.isArray(childrenAges) || childrenAges.length > 8) {
      input('childrenAges must be an array of length 0-8');
    }
    for (const age of childrenAges) {
      integer(age, 'childrenAge', 0, 17);
    }

    if (typeof queryName !== 'string' || queryName.length > 100 || /[\u0000-\u001f]/.test(queryName)) {
      input('queryName must be a printable string up to 100 characters');
    }

    const gql = `
      query domesticHotelRates(
        $adultCnt: Int!
        $checkIn: String!
        $checkOut: String!
        $id: String!
        $includeTax: Boolean!
        $query: String!
        $impArea: SingleImpArea!
        $childrenAges: [Int]
      ) {
        domesticHotelRates(
          adultCnt: $adultCnt
          checkIn: $checkIn
          checkOut: $checkOut
          id: $id
          includeTax: $includeTax
          childrenAges: $childrenAges
          impArea: $impArea
        ) {
          nHotelId
          xbuId
          totalCount
          rates {
            id
            roomId
            roomName
            ota {
              code
              npay
              isOfficialSite
            }
            nlog(
              query: $query
              checkIn: $checkIn
              checkOut: $checkOut
              includeTax: $includeTax
            ) {
              impression {
                cssSelector
              }
            }
            productFeatures {
              isFreeCancel
              freeCancelDeadline
              isNpayPoint
              freeBreakfast
              freeDinner
            }
            roomFeatures {
              roomType
              viewType
              bedType
            }
            rate {
              userRate
              original
            }
          }
        }
      }
    `;

    const variables = {
      id: idStr,
      checkIn: inD.isoDate,
      checkOut: outD.isoDate,
      adultCnt: adult,
      childrenAges,
      includeTax: true,
      query: queryName || idStr,
      impArea: 'renewalSingle',
    };

    const { data, receipt } = await this.#request('https://hermes-hotel-svc-api.naver.com/graphql', {
      method: 'POST',
      payload: { query: gql, variables },
      json: true,
      referer: 'https://hotels.naver.com/',
    });

    const dhr = data?.data?.domesticHotelRates;
    if (!dhr || !Array.isArray(dhr.rates)) {
      throw new NaverTravelError('SCHEMA_CHANGED', 'domesticHotelRates response schema changed', receipt);
    }

    const rates = dhr.rates.map(r => {
      if (!r || typeof r !== 'object') throw new NaverTravelError('SCHEMA_CHANGED', 'rate item was not an object', receipt);
      const rateId = r.id != null ? String(r.id) : null;
      if (!rateId) throw new NaverTravelError('SCHEMA_CHANGED', 'rate item lacked required id', receipt);

      return {
        rateId,
        roomId: r.roomId != null ? String(r.roomId) : '',
        roomName: sanitizeText(r.roomName, 200),
        otaCode: String(r.ota?.code ?? ''),
        isOfficialSite: observedBoolean(r.ota?.isOfficialSite),
        npaySupport: observedBoolean(r.ota?.npay),
        currency: 'KRW',
        listingPriceKrw: numeric(r.rate?.userRate),
        originalPriceKrw: numeric(r.rate?.original),
        priceScope: 'quoted_listing_rate',
        sourcePriceField: 'rate.userRate',
        occupancyPricingVerified: false,
        isFreeCancel: observedBoolean(r.productFeatures?.isFreeCancel),
        freeCancelDeadline: r.productFeatures?.freeCancelDeadline ?? null,
        freeBreakfast: observedBoolean(r.productFeatures?.freeBreakfast),
        roomType: Array.isArray(r.roomFeatures?.roomType) ? r.roomFeatures.roomType : [],
        viewType: Array.isArray(r.roomFeatures?.viewType) ? r.roomFeatures.viewType : [],
        bedType: Array.isArray(r.roomFeatures?.bedType) ? r.roomFeatures.bedType : [],
        payablePriceVerified: false,
        optionsVerified: false,
        checkoutVerified: false,
        contentTrust: 'untrusted_external_text',
      };
    });

    return {
      scope: 'naver_domestic_hotel_rates',
      hotelId: idStr,
      stayPeriod: { checkIn: inD.isoDate, checkOut: outD.isoDate },
      occupancy: { adult, childrenAges },
      currency: 'KRW',
      checkedAt: receipt.checkedAt,
      totalCount: numeric(dhr.totalCount) ?? rates.length,
      rates,
      receipt,
    };
  }

  /**
   * Domestic curated feed (tour products and hotels).
   */
  async domesticFeed({ category = 'all', limit = 20 } = {}) {
    const allowed = new Set(['all', 'tour', 'hotel']);
    if (!allowed.has(category)) {
      input('category must be one of "all", "tour", "hotel"');
    }
    integer(limit, 'limit', 1, 100);

    const { data: html, receipt } = await this.#request('https://travel.naver.com/domestic', {
      method: 'GET',
    });

    const nextData = extractNextData(html);
    const queries = nextData?.props?.pageProps?.dehydratedState?.queries;
    if (!Array.isArray(queries)) {
      throw new NaverTravelError('SCHEMA_CHANGED', 'dehydratedState.queries is missing in domestic page', receipt);
    }

    const cardsEntry = queries.find(q => Array.isArray(q?.queryKey) && q.queryKey[0] === 'CARDS');
    const cardsQuery = cardsEntry?.state?.data;
    if (!cardsQuery || typeof cardsQuery !== 'object') {
      throw new NaverTravelError('SCHEMA_CHANGED', 'CARDS data missing in dehydrated state', receipt);
    }

    const cards = cardsQuery?.domestic?.cards || cardsQuery?.cards || (Array.isArray(cardsQuery) ? cardsQuery : []);
    const tourCard = cards.find(c => c.type === 'tourProduct');
    const hotelCard = cards.find(c => c.type === 'hotelProduct');
    const rawTours = tourCard?.templateData?.tourProduct?.products || cardsQuery?.tourProduct || [];
    const rawHotels = hotelCard?.templateData?.hotelProduct?.hotels || cardsQuery?.hotelProduct || [];

    let tourItems = [];
    let hotelItems = [];

    if (category === 'all' || category === 'tour') {
      tourItems = rawTours.map(p => {
        if (!p || typeof p !== 'object') throw new NaverTravelError('SCHEMA_CHANGED', 'tourProduct entry was not an object', receipt);
        const pid = p.productId != null ? String(p.productId) : null;
        const title = (p.productName || p.productTitle) != null ? sanitizeText(p.productName || p.productTitle, 200) : null;
        if (!pid || !title) throw new NaverTravelError('SCHEMA_CHANGED', 'tourProduct entry lacked required productId or title', receipt);
        const priceVal = numeric(p.price) ?? numeric(p.productPrice);
        const agtCode = p.agtCode || p.agencyCode;
        const agtName = p.agtName || p.agencyName;
        const imgUrl = safePublicUrl(p.image || p.productImgUrl);
        const reward = numeric(p.totalPromoAccRate) ?? numeric(p.rewardRate);

        return {
          provider: 'naver-travel',
          recordType: 'tourProduct',
          productId: pid,
          title,
          currency: 'KRW',
          listingPriceKrw: priceVal,
          priceScope: 'indicative_starting_price',
          sourcePriceField: 'price',
          agencyCode: agtCode ? String(agtCode) : null,
          agencyName: agtName ? sanitizeText(agtName, 100) : null,
          imageUrl: imgUrl,
          dayPeriod: numeric(p.dayPeriod),
          nightPeriod: numeric(p.nightPeriod),
          rewardRate: reward,
          payablePriceVerified: false,
          optionsVerified: false,
          checkoutVerified: false,
          contentTrust: 'untrusted_external_text',
        };
      });
    }

    if (category === 'all' || category === 'hotel') {
      hotelItems = rawHotels.map(h => {
        if (!h || typeof h !== 'object') throw new NaverTravelError('SCHEMA_CHANGED', 'hotelProduct entry was not an object', receipt);
        const hid = h.hotelId != null ? String(h.hotelId) : null;
        const title = (h.name || h.hotelName) != null ? sanitizeText(h.name || h.hotelName, 200) : null;
        if (!hid || !title) throw new NaverTravelError('SCHEMA_CHANGED', 'hotelProduct entry lacked required hotelId or title', receipt);
        const img = typeof h.image === 'string' ? h.image : h.image?.url;

        return {
          provider: 'naver-travel',
          recordType: 'hotelProduct',
          hotelId: hid,
          title,
          currency: 'KRW',
          listingPriceKrw: numeric(h.lowestRate),
          priceScope: 'indicative_starting_price',
          sourcePriceField: 'lowestRate',
          starRating: numeric(h.starRating) ?? numeric(h.star),
          guestRating: numeric(h.guestRating) ?? numeric(h.guestScore),
          imageUrl: safePublicUrl(img),
          payablePriceVerified: false,
          optionsVerified: false,
          checkoutVerified: false,
          contentTrust: 'untrusted_external_text',
        };
      });
    }

    const combined = [...tourItems, ...hotelItems];
    const resultItems = combined.slice(0, limit);

    return {
      scope: 'naver_travel_domestic_feed',
      category,
      checkedAt: receipt.checkedAt,
      counts: {
        toursDiscovered: tourItems.length,
        hotelsDiscovered: hotelItems.length,
        returned: resultItems.length,
      },
      items: resultItems,
      receipt,
    };
  }

  /**
   * Domestic location autocomplete.
   */
  async domesticAutocomplete({ keyword }) {
    const kw = stringNonEmpty(keyword, 'keyword');
    const gql = `
      query SEARCH_DOMESTIC($keyword: String!) {
        domesticAutocompleteSearch(keyword: $keyword) {
          rcode
          nameKo
          exposeTitle
        }
      }
    `;

    const { data, receipt } = await this.#request('https://travelsearch-api.naver.com/graphql', {
      method: 'POST',
      payload: { query: gql, variables: { keyword: kw } },
      json: true,
      referer: 'https://travel.naver.com/',
    });

    const list = data?.data?.domesticAutocompleteSearch;
    if (!Array.isArray(list)) {
      throw new NaverTravelError('SCHEMA_CHANGED', 'domesticAutocompleteSearch response schema changed', receipt);
    }

    const suggestions = list.map(item => {
      if (!item || typeof item !== 'object') throw new NaverTravelError('SCHEMA_CHANGED', 'autocomplete entry was not an object', receipt);
      const rcode = item.rcode != null ? String(item.rcode) : null;
      const nameKo = item.nameKo != null ? sanitizeText(item.nameKo, 100) : null;
      if (!rcode || !nameKo) throw new NaverTravelError('SCHEMA_CHANGED', 'autocomplete entry lacked rcode or nameKo', receipt);
      return {
        rcode,
        nameKo,
        exposeTitle: item.exposeTitle != null ? sanitizeText(item.exposeTitle, 200) : nameKo,
      };
    });

    return {
      scope: 'naver_travel_domestic_autocomplete',
      keyword: kw,
      checkedAt: receipt.checkedAt,
      totalCount: suggestions.length,
      suggestions,
      receipt,
    };
  }
}

NaverTravelClient.prototype.travelProducts = NaverTravelClient.prototype.domesticFeed;
NaverTravelClient.prototype.travelAutocomplete = NaverTravelClient.prototype.domesticAutocomplete;
