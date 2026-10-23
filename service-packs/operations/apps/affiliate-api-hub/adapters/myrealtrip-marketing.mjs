import { probeMyrealtripAccount, PartnerProbeError } from './partner-account-probes.mjs';

const ORIGIN = 'https://api3-backoffice.myrealtrip.com';
const sales = '/settle-v2/api/v1/partner/marketing/partnership/sales-overview';
export const MYREALTRIP_OPERATIONS = Object.freeze(Object.fromEntries(Object.entries({
  createLink: ['POST', '/partner/v2/mylink'],
  createFlightLanding: ['POST', '/flight/api/partner/shopping/fare/query-landing-url'],
  searchAirports: ['GET', '/search/flight/v1/ac'],
  searchAirlines: ['GET', '/flight/api/partner/shopping/airline'],
  reservations: ['GET', '/order-admin/partner/partnership-marketing/reservations'],
  flightReservations: ['GET', '/order-admin/partner/partnership-marketing/flight-reservations'],
  sales: ['GET', `${sales}/payments`],
  salesSummary: ['GET', `${sales}/payments/aggregation`],
  flightSales: ['GET', `${sales}/flight/payments`],
  flightSalesSummary: ['GET', `${sales}/flight/payments/aggregation`],
}).map(([name, [method, path]]) => [name, Object.freeze({ method, origin: ORIGIN, path })])));

export class MyrealtripError extends Error {
  constructor(code, { outcome = 'not_sent', causeCode } = {}) {
    super(code); this.name = 'MyrealtripError'; this.code = code; this.outcome = outcome;
    if (causeCode) this.causeCode = causeCode;
  }
}
const fail = (code, options) => { throw new MyrealtripError(code, options); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const fields = (input, allowed) => {
  if (!record(input) || Object.keys(input).some(key => !allowed.includes(key))) fail('INPUT');
};
const date = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('DATE');
  const parsed = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail('DATE');
  return value;
};
function range(input, start, end) {
  date(input[start]); date(input[end]);
  if (input[start] > input[end] || Date.parse(input[end]) - Date.parse(input[start]) > 366 * 86400000) fail('DATE_RANGE');
  return { [start]: input[start], [end]: input[end] };
}
function httpsUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x20\x7f\\]/.test(value)) fail('URL');
  let url; try { url = new URL(value); } catch { fail('URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) fail('URL');
  return url;
}
function targetUrl(value) {
  const url = httpsUrl(value);
  if (!(url.origin === 'https://www.myrealtrip.com' && /^\/offers\/\d+$/.test(url.pathname)) &&
      !(url.origin === 'https://air-web.myrealtrip.com' && url.pathname === '/results')) fail('TARGET_SCOPE');
  return url.href;
}
function flightInput(input) {
  const keys = ['depAirportCd', 'arrAirportCd', 'airline', 'depDate', 'arrDate', 'tripTypeCd', 'adult', 'child', 'infant', 'cabinClass'];
  fields(input, keys);
  if (!['depAirportCd', 'arrAirportCd'].every(k => typeof input[k] === 'string' && /^[A-Z]{3}$/.test(input[k])) || input.depAirportCd === input.arrAirportCd) fail('AIRPORT');
  if (typeof input.airline !== 'string' || !/^[A-Z0-9]{2}$/.test(input.airline)) fail('AIRLINE');
  range(input, 'depDate', 'arrDate');
  // Only the browser-observed round-trip economy variant is enabled.
  if (input.tripTypeCd !== 'RT' || input.cabinClass !== 'ECONOMY') fail('UNOBSERVED_VARIANT');
  if (!integer(input.adult, 1, 9) || !integer(input.child, 0, 8) || !integer(input.infant, 0, input.adult) || input.adult + input.child > 9) fail('PASSENGERS');
  return Object.fromEntries(keys.map(key => [key, input[key]]));
}
function prepare(operation, input) {
  if (!Object.hasOwn(MYREALTRIP_OPERATIONS, operation)) fail('SCOPE');
  if (operation === 'createLink') { fields(input, ['targetUrl']); return { targetUrl: targetUrl(input.targetUrl) }; }
  if (operation === 'createFlightLanding') return flightInput(input);
  if (operation === 'searchAirports' || operation === 'searchAirlines') {
    fields(input, ['keyword']);
    if (typeof input.keyword !== 'string' || !input.keyword.trim() || input.keyword.length > 100 || /[\x00-\x1f\x7f]/.test(input.keyword)) fail('KEYWORD');
    return { keyword: input.keyword };
  }
  if (operation === 'reservations') {
    fields(input, ['startDate', 'endDate', 'page']);
    range(input, 'startDate', 'endDate');
    const page = input.page ?? 1;
    if (!integer(page, 1, 10000)) fail('PAGE');
    return { dateSearchType: 'TRIP_END_DATE', endDate: input.endDate, page, pageSize: 15, reservationStatus: '', startDate: input.startDate };
  }
  if (operation === 'flightReservations') {
    fields(input, ['startDate', 'endDate']); return range(input, 'startDate', 'endDate');
  }
  fields(input, ['fromDate', 'toDate']); return range(input, 'fromDate', 'toDate');
}

async function request(operation, input, token, { fetchImpl = globalThis.fetch, timeoutMs = 12000 } = {}) {
  if (!integer(timeoutMs, 1, 30000)) fail('INPUT');
  const spec = MYREALTRIP_OPERATIONS[operation];
  const url = new URL(spec.origin + spec.path);
  if (spec.method === 'GET') for (const [key, value] of Object.entries(input)) url.searchParams.set(key, String(value));
  let response, chunks = [], bytes = 0;
  try {
    response = await fetchImpl(url.href, {
      method: spec.method, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json', 'partner-access-token': token, ...(spec.method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      ...(spec.method === 'POST' ? { body: JSON.stringify(input) } : {}),
    });
    if (response.redirected || (response.url && response.url !== url.href) || (response.status >= 300 && response.status < 400)) fail('REDIRECT');
    if (response.status === 401) fail('REAUTH_REQUIRED');
    if (response.status === 403) fail('FORBIDDEN');
    if (response.status === 429) fail('THROTTLED');
    if (response.status !== 200) fail('HTTP_STATUS');
    if (!/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') || '')) fail('MIME');
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > 1024 * 1024)) fail('SIZE');
    if (!response.body) fail('SCHEMA');
    for await (const chunk of response.body) {
      bytes += chunk.byteLength; if (bytes > 1024 * 1024) fail('SIZE'); chunks.push(chunk);
    }
    let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('JSON'); }
    if (!record(body) || !record(body.result) || typeof body.result.status !== 'number') fail('SCHEMA');
    if (body.result.status === 401) fail('REAUTH_REQUIRED');
    if (body.result.status === 403) fail('FORBIDDEN');
    if (body.result.status === 429) fail('THROTTLED');
    if (body.result.status !== 200) fail('SERVICE_STATUS');
    return { body, receipt: { operation, ...spec, httpStatus: 200, applicationStatus: 200, responseBytes: bytes, checkedAt: new Date().toISOString(), browserUsed: false } };
  } catch (error) {
    const code = error instanceof MyrealtripError ? error.code : 'TRANSPORT';
    // A missing/invalid successful response cannot establish that a POST failed.
    const rejected = ['REAUTH_REQUIRED', 'FORBIDDEN', 'THROTTLED', 'SERVICE_STATUS'].includes(code);
    if (spec.method === 'POST' && !rejected) fail('WRITE_OUTCOME_UNKNOWN', { outcome: 'unknown', causeCode: code });
    fail(code, { outcome: rejected ? 'rejected' : 'read_failed' });
  } finally {
    chunks = []; await response?.body?.cancel().catch(() => {});
  }
}

const airportFields = ['airportCode', 'airportKoName', 'airportEnName', 'cityCode', 'cityKoName', 'cityEnName', 'countryCode', 'countryKoName', 'countryEnName', 'isoCode'];
const airlineFields = ['airlineCd', 'airlineKorNm', 'airlineEngNm', 'airlineImgUrl'];
function publicRows(rows, keys) {
  if (!Array.isArray(rows) || rows.some(row => !record(row) || keys.some(key => typeof row[key] !== 'string'))) fail('SCHEMA');
  return rows.map(row => Object.fromEntries(keys.map(key => [key, row[key]])));
}
function decode(operation, body, input) {
  const data = body.data;
  if (operation === 'createLink') {
    if (!record(data) || !integer(data.id, 1, Number.MAX_SAFE_INTEGER) || !integer(data.expirationMinutes, 1, Number.MAX_SAFE_INTEGER)) fail('SCHEMA');
    const link = httpsUrl(data.mylink);
    if (link.origin !== 'https://myrealt.rip' || !/^\/[A-Za-z0-9]+$/.test(link.pathname) || link.search) fail('SCHEMA');
    return { id: data.id, mylink: link.href, expirationMinutes: data.expirationMinutes };
  }
  if (operation === 'createFlightLanding') {
    // The captured contract says number; gid is not an account or link identity.
    if (!record(data) || typeof data.gid !== 'number' || !Number.isFinite(data.gid)) fail('SCHEMA');
    const url = httpsUrl(data.url);
    if (url.origin !== 'https://air-web.myrealtrip.com' || url.pathname !== '/results') fail('SCHEMA');
    // Check user-supplied travel fields before using the response as another API input.
    for (const [key, value] of Object.entries({ adult: input.adult, child: input.child, infant: input.infant, cabins: input.cabinClass, airlines: input.airline, tripType: 'ROUND_TRIP' })) {
      if (url.searchParams.getAll(key).length !== 1 || url.searchParams.get(key) !== String(value)) fail('FLIGHT_MISMATCH');
    }
    const trip = url.searchParams.get('trip');
    const legs = typeof trip === 'string' ? trip.split('/') : [];
    const pattern = /^([AC])\.([A-Z]{3})\.([AC])\.([A-Z]{3})\.(\d{4}-\d{2}-\d{2})$/;
    const outward = legs[0]?.match(pattern), inward = legs[1]?.match(pattern);
    if (legs.length !== 2 || !outward || !inward || outward[2] !== input.depAirportCd || outward[4] !== input.arrAirportCd || outward[5] !== input.depDate || inward[2] !== input.arrAirportCd || inward[4] !== input.depAirportCd || inward[5] !== input.arrDate) fail('FLIGHT_MISMATCH');
    return { url: url.href, gid: data.gid };
  }
  if (operation === 'searchAirports') return { airports: publicRows(data, airportFields) };
  if (operation === 'searchAirlines') return { airlines: publicRows(data?.airlines, airlineFields) };
  if (operation.endsWith('Summary')) {
    const keys = ['quantity', 'commissionBase', 'salePrice', 'partnershipCommission', 'settlementAmount', 'taxCharges'];
    if (!record(data) || keys.some(key => typeof data[key] !== 'number' || !Number.isFinite(data[key]))) fail('SCHEMA');
    return Object.fromEntries(keys.map(key => [key, data[key]]));
  }
  if (!Array.isArray(data) || data.some(row => !record(row))) fail('SCHEMA');
  const result = { recordCount: data.length, rowsReturned: false, rowSchemaVerified: false };
  // Real captures contained empty lists. Return counts until detail rows are observed.
  if (operation === 'reservations') {
    const p = body.meta?.pagination;
    if (!record(p) || p.page !== input.page || p.pageSize !== 15 || !integer(p.totalCount, 0, Number.MAX_SAFE_INTEGER) || data.length > 15 || p.totalCount < data.length) fail('SCHEMA');
    result.pagination = { page: p.page, pageSize: p.pageSize, totalCount: p.totalCount };
  }
  return result;
}

export async function createMyrealtripClient(session, dependencies = {}) {
  const account = await probeMyrealtripAccount(session, dependencies);
  let token = session.token;
  async function execute(operation, input) {
    if (!token) fail('SESSION_CLOSED');
    const prepared = prepare(operation, input);
    const { body, receipt } = await request(operation, prepared, token, dependencies);
    try { return { data: decode(operation, body, prepared), receipt }; }
    catch (error) {
      if (MYREALTRIP_OPERATIONS[operation].method === 'POST') fail('WRITE_OUTCOME_UNKNOWN', { outcome: 'unknown', causeCode: error instanceof MyrealtripError ? error.code : 'SCHEMA' });
      throw error;
    }
  }
  return {
    account, execute,
    async createFlightLink(input) {
      const landing = await execute('createFlightLanding', input);
      try {
        const link = await execute('createLink', { targetUrl: landing.data.url });
        return { data: { ...link.data, landingUrl: landing.data.url }, receipts: [landing.receipt, link.receipt] };
      } catch (error) {
        // Retain the completed first step; never resubmit the whole workflow automatically.
        error.completedStep = 'createFlightLanding'; error.resumeTargetUrl = landing.data.url; throw error;
      }
    },
    close() { token = ''; },
  };
}

export async function verifyMyrealtripLink(link, expectedTarget, { fetchImpl = globalThis.fetch, expectedLinkId } = {}) {
  if (!integer(expectedLinkId, 1, Number.MAX_SAFE_INTEGER)) fail('INPUT');
  const short = httpsUrl(link), target = new URL(targetUrl(expectedTarget));
  if (short.origin !== 'https://myrealt.rip' || !/^\/[A-Za-z0-9]+$/.test(short.pathname) || short.search) fail('URL');
  let response;
  try {
    // This read has no partner credential. Stop at the observed marketing bridge.
    response = await fetchImpl(short.href, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(12000), headers: { accept: 'text/html' } });
    if (response.redirected || (response.url && response.url !== short.href) || ![301, 302, 303, 307, 308].includes(response.status)) fail('LINK_REDIRECT');
    const bridge = httpsUrl(response.headers.get('location'));
    if (bridge.origin !== 'https://www.myrealtrip.com' || bridge.pathname !== '/main/bridge/marketing' || bridge.searchParams.getAll('return_url').length !== 1) fail('LINK_DESTINATION');
    const destination = httpsUrl(bridge.searchParams.get('return_url'));
    if (destination.origin !== target.origin || destination.pathname !== target.pathname) fail('LINK_DESTINATION');
    for (const key of new Set(target.searchParams.keys())) {
      if (JSON.stringify(destination.searchParams.getAll(key)) !== JSON.stringify(target.searchParams.getAll(key))) fail('LINK_DESTINATION');
    }
    if (destination.searchParams.getAll('mylink_id').length !== 1 || destination.searchParams.get('mylink_id') !== String(expectedLinkId)) fail('LINK_ATTRIBUTION');
    return { verified: true, destinationMatches: true, attributionMatches: true, credentialSent: false, followedRedirect: false, httpStatus: response.status };
  } catch (error) { if (error instanceof MyrealtripError) throw error; fail('LINK_TRANSPORT'); }
  finally { await response?.body?.cancel().catch(() => {}); }
}

export async function runMyrealtripEnvelope(envelope, dependencies = {}) {
  fields(envelope, ['schemaVersion', 'acquiredAt', 'session', 'operation', 'input']);
  if (envelope.schemaVersion !== 1) fail('INPUT');
  const age = (dependencies.now?.() ?? Date.now()) - (typeof envelope.acquiredAt === 'string' ? Date.parse(envelope.acquiredAt) : NaN);
  if (!Number.isFinite(age) || age < 0 || age > 5 * 60000) fail('HANDOFF_EXPIRED');
  if (envelope.operation === 'createFlightLink') flightInput(envelope.input);
  else prepare(envelope.operation, envelope.input);
  const client = await createMyrealtripClient(envelope.session, dependencies);
  try {
    const result = envelope.operation === 'createFlightLink' ? await client.createFlightLink(envelope.input) : await client.execute(envelope.operation, envelope.input);
    let verification;
    if (envelope.operation === 'createLink' || envelope.operation === 'createFlightLink') {
      try { verification = await verifyMyrealtripLink(result.data.mylink, result.data.landingUrl ?? envelope.input.targetUrl, { ...dependencies, expectedLinkId: result.data.id }); }
      catch (error) { verification = { verified: false, code: error instanceof MyrealtripError ? error.code : 'LINK_VERIFY_FAILED' }; }
    }
    return { ok: true, schemaVersion: 1, operation: envelope.operation, identityVerified: client.account.identityVerified, ...result, ...(verification ? { verification } : {}), execution: { mode: 'pure_http', browserUsed: false, credentialProvider: 'memory_stdin', renewal: 'unverified' } };
  } finally { client.close(); }
}

export function marketingErrorResult(error) {
  return { ok: false, code: error instanceof MyrealtripError || error instanceof PartnerProbeError ? error.code : 'OPERATION_FAILED',
    ...(error instanceof MyrealtripError ? { outcome: error.outcome, ...(error.causeCode ? { causeCode: error.causeCode } : {}) } : {}),
    ...(error.completedStep ? { completedStep: error.completedStep, resumeTargetUrl: error.resumeTargetUrl } : {}) };
}
