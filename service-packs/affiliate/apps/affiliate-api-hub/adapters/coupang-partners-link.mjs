// Issues Coupang Partners short links through the owner's stored partners session.
// The portal contract is the observed GET /api/v1/url/any?coupangUrl=… call.
// Never open the returned link.coupang.com URL: that can count as a click.
import {
  existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLAYBOOK = fileURLToPath(new URL('../../../../../', import.meta.url));
const ORIGIN = 'https://partners.coupang.com';
const ORIGINS = [ORIGIN, 'https://login.coupang.com'];
const NAME = 'coupang-web-state';
const DATA_DIR = path.join(process.env.LOCALAPPDATA ?? '.', 'affiliate-content-operations', 'coupang-partners');
const CACHE = path.join(DATA_DIR, 'links.json');
const JOURNAL = path.join(DATA_DIR, 'link-operations.json');
const RECONCILIATION_CAPTURE_SKEW_MS = 10_000;
// Public consumer source: https://partners.coupang.com/static/js/main.aefc650b.js
// `convertCoupangUrlToTrackingUrl` URL-encodes the product URL and calls GET
// `/api/v1/url/any?coupangUrl=…`; its resolved response reads data.{type,shortUrl,title,description,imageUrl}.
// That proves a provider-returned short URL only; it does not prove its destination or attribution.
const OBSERVED_PROVIDER_LINK_VERIFICATION = 'observed_provider_short_url';
const fail = (code, receipt) => { throw Object.assign(new Error(code), { code, ...(receipt ? { receipt } : {}) }); };
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);

function readJsonObject(file, code) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (!isRecord(value)) fail(code);
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (/^COUPANG_LINK_[A-Z0-9_]+$/.test(error?.code ?? '')) throw error;
    fail(code);
  }
}

function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    renameSync(temporary, file);
  } catch {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* keep the original safe state */ }
    fail('COUPANG_LINK_STATE_WRITE_FAILED');
  }
}

function cacheAt(file) {
  const value = readJsonObject(file, 'COUPANG_LINK_CACHE_INVALID');
  return value ?? {};
}

function journalAt(file) {
  const value = readJsonObject(file, 'COUPANG_LINK_JOURNAL_INVALID');
  if (value === null) return { schemaVersion: 1, operations: {} };
  if (value.schemaVersion !== 1 || !isRecord(value.operations)) fail('COUPANG_LINK_JOURNAL_INVALID');
  return value;
}

function saveOperation(file, journal, key, operation) {
  const next = { schemaVersion: 1, operations: { ...journal.operations, [key]: operation } };
  writeJsonAtomic(file, next);
  return next;
}

export function normalizeCoupangProductUrl(input) {
  let url;
  try { url = new URL(input); } catch { fail('COUPANG_URL_INVALID'); }
  if (url.protocol !== 'https:' || url.origin !== 'https://www.coupang.com'
    || url.username || url.password || url.hash || !/^\/vp\/products\/([1-9]\d{0,19})$/.test(url.pathname)) {
    fail('COUPANG_URL_INVALID');
  }
  const productId = url.pathname.split('/').at(-1);
  const itemIds = url.searchParams.getAll('itemId');
  const vendorItemIds = url.searchParams.getAll('vendorItemId');
  if (url.searchParams.size !== 2 || itemIds.length !== 1 || vendorItemIds.length !== 1
    || !validId(itemIds[0]) || !validId(vendorItemIds[0])) fail('COUPANG_URL_VARIANT_REQUIRED');
  const canonical = new URL(`/vp/products/${productId}`, 'https://www.coupang.com');
  canonical.search = new URLSearchParams({ itemId: itemIds[0], vendorItemId: vendorItemIds[0] }).toString();
  return {
    productId,
    itemId: itemIds[0],
    vendorItemId: vendorItemIds[0],
    key: `${productId}:${itemIds[0]}:${vendorItemIds[0]}`,
    productUrl: canonical.href,
  };
}

function productIdentity(input, { allowedQueryKeys = ['itemId', 'vendorItemId'] } = {}) {
  let url;
  try { url = new URL(input); } catch { return null; }
  if (url.protocol !== 'https:' || url.origin !== 'https://www.coupang.com'
    || url.username || url.password || url.hash || !/^\/vp\/products\/([1-9]\d{0,19})$/.test(url.pathname)) return null;
  const queryEntries = [...url.searchParams.entries()];
  if (queryEntries.some(([key]) => !allowedQueryKeys.includes(key))
    || queryEntries.some(([key]) => url.searchParams.getAll(key).length !== 1)) return null;
  const productId = url.pathname.split('/').at(-1);
  const itemIds = url.searchParams.getAll('itemId');
  const vendorItemIds = url.searchParams.getAll('vendorItemId');
  if (itemIds.length !== 1 || vendorItemIds.length !== 1 || !validId(itemIds[0]) || !validId(vendorItemIds[0])) return null;
  return { productId, itemId: itemIds[0], vendorItemId: vendorItemIds[0] };
}

function observedRedirectLanding(input, target, responseType) {
  if (responseType !== 'sdp') return null;
  let url;
  try { url = new URL(input); } catch { return null; }
  if (url.protocol !== 'https:' || url.origin !== 'https://link.coupang.com'
    || url.username || url.password || url.hash || url.pathname !== '/re/AFFSDP') return null;
  const expectedKeys = new Set(['lptag', 'pageKey', 'itemId', 'vendorItemId', 'traceid']);
  const entries = [...url.searchParams.entries()];
  if (entries.length !== expectedKeys.size) return null;
  const values = new Map();
  for (const [key, value] of entries) {
    if (!expectedKeys.has(key) || values.has(key)) return null;
    values.set(key, value);
  }
  const traceid = values.get('traceid');
  if (values.get('pageKey') !== target.productId
    || values.get('itemId') !== target.itemId
    || values.get('vendorItemId') !== target.vendorItemId
    || typeof values.get('lptag') !== 'string' || !values.get('lptag') || values.get('lptag').length > 256
    || typeof traceid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(traceid)) return null;
  return { lptag: values.get('lptag') };
}

function observedLanding(input, target, responseType) {
  const identity = productIdentity(input, { allowedQueryKeys: ['itemId', 'vendorItemId', 'lptag'] });
  if (sameIdentity(identity, target)) {
    const lptags = new URL(input).searchParams.getAll('lptag');
    return { lptag: lptags.length === 1 ? lptags[0] : null };
  }
  return observedRedirectLanding(input, target, responseType);
}

function sameIdentity(left, right) {
  return left?.productId === right.productId && left?.itemId === right.itemId
    && left?.vendorItemId === right.vendorItemId;
}

function validShortUrl(input) {
  let url;
  try { url = new URL(input); } catch { return null; }
  if (url.protocol !== 'https:' || url.origin !== 'https://link.coupang.com'
    || url.username || url.password || url.search || url.hash || !/^\/a\/[A-Za-z0-9]+$/.test(url.pathname)) return null;
  return url.href;
}

function validatedStoredLink(record, target, expectedAffiliateCode, errorCode) {
  const shortUrl = validShortUrl(record?.shortUrl);
  const identity = productIdentity(record?.productUrl);
  if (!shortUrl || !sameIdentity(identity, target) || typeof record.issuedAt !== 'string'
    || !Number.isFinite(Date.parse(record.issuedAt))) fail(errorCode);
  if (record.expectedAffiliateCode != null && record.expectedAffiliateCode !== expectedAffiliateCode) {
    fail('COUPANG_LINK_ATTRIBUTION_MISMATCH');
  }
  if (typeof record.lptag !== 'string' || record.lptag !== expectedAffiliateCode) {
    fail('COUPANG_LINK_ATTRIBUTION_UNVERIFIED');
  }
  const generationResponseProof = record.destinationVerified === true
    && ['generation_response_only', 'generation-response-landing-url-identity'].includes(record.destinationVerification ?? record.verification);
  return {
    shortUrl,
    lptag: record.lptag,
    productUrl: target.productUrl,
    expectedAffiliateCode,
    attributionVerified: true,
    destinationVerified: generationResponseProof,
    destinationVerification: generationResponseProof ? 'generation_response_only' : 'recorded_target_only',
    independentReadbackVerified: false,
  };
}

function validatedProviderStoredLink(record, target, expectedAffiliateCode, errorCode) {
  const shortUrl = validShortUrl(record?.shortUrl);
  const identity = productIdentity(record?.productUrl);
  if (!shortUrl || record.productUrl !== target.productUrl || !sameIdentity(identity, target) || typeof record.issuedAt !== 'string'
    || !Number.isFinite(Date.parse(record.issuedAt)) || record.ownerVerified !== true
    || record.verification !== OBSERVED_PROVIDER_LINK_VERIFICATION
    || record.expectedAffiliateCode !== expectedAffiliateCode
    || record.independentReadbackVerified !== false
    || typeof record.destinationVerified !== 'boolean'
    || typeof record.attributionVerified !== 'boolean'
    || (record.attributionVerified && !record.destinationVerified)) fail(errorCode);
  if (record.destinationVerified
    ? record.destinationVerification !== 'generation_response_only'
    : record.destinationVerification !== OBSERVED_PROVIDER_LINK_VERIFICATION) fail(errorCode);
  if (record.attributionVerified) {
    if (typeof record.lptag !== 'string' || record.lptag !== expectedAffiliateCode) {
      fail('COUPANG_LINK_ATTRIBUTION_UNVERIFIED');
    }
  } else if (record.lptag !== null) {
    fail('COUPANG_LINK_ATTRIBUTION_UNVERIFIED');
  }
  return {
    shortUrl,
    lptag: record.lptag,
    productUrl: target.productUrl,
    expectedAffiliateCode,
    ownerVerified: true,
    verification: OBSERVED_PROVIDER_LINK_VERIFICATION,
    destinationVerified: record.destinationVerified,
    destinationVerification: record.destinationVerification,
    attributionVerified: record.attributionVerified,
    independentReadbackVerified: false,
  };
}

function priorJournalLink(record, target, expectedAffiliateCode) {
  if (!record) return null;
  if (record.target?.productUrl !== target.productUrl || !sameIdentity(record.target, target)) {
    fail('COUPANG_LINK_JOURNAL_CONFLICT');
  }
  if (record.expectedAffiliateCode != null && record.expectedAffiliateCode !== expectedAffiliateCode) {
    fail('COUPANG_LINK_ATTRIBUTION_MISMATCH');
  }
  if (record.status === 'issued' && record.verification === OBSERVED_PROVIDER_LINK_VERIFICATION) {
    return { ...validatedProviderStoredLink(record, target, expectedAffiliateCode, 'COUPANG_LINK_JOURNAL_UNVERIFIED'), cached: true };
  }
  if (record.status === 'issued' || record.status === 'cached_legacy') {
    const stored = validatedStoredLink(record, target, expectedAffiliateCode, 'COUPANG_LINK_JOURNAL_UNVERIFIED');
    if (record.status === 'issued' && !stored.destinationVerified) {
      return { ...stored, destinationVerified: false, destinationVerification: 'recorded_target_only', cached: true };
    }
    return { ...stored, cached: true };
  }
  if (record.status === 'write_started' || record.status === 'outcome_unknown') fail('COUPANG_LINK_OUTCOME_UNCERTAIN');
  fail('COUPANG_LINK_ALREADY_ATTEMPTED');
}

function readProtectedState(store) {
  const raw = store.read(NAME);
  if (!raw) fail('COUPANG_AUTH_STATE_MISSING');
  let state;
  try { state = JSON.parse(raw); } catch { fail('COUPANG_AUTH_STATE_INVALID'); }
  if (![1, 2].includes(state?.version) || typeof state.affiliateCode !== 'string' || !state.affiliateCode
    || typeof state.email !== 'string' || !state.email.includes('@')) {
    fail('COUPANG_AUTH_STATE_INVALID');
  }
  return state;
}

function validateFreshAuthState(state) {
  const expectedOrigins = state.version === 2 ? [ORIGIN] : ORIGINS;
  if (JSON.stringify(state.session?.allowedOrigins) !== JSON.stringify(expectedOrigins)
    || JSON.stringify(state.session?.cookieOrigins) !== JSON.stringify(expectedOrigins)) fail('COUPANG_AUTH_STATE_INVALID');
}

function serializeAttestedSession(session, allowedCookieNames) {
  let serialized;
  try { serialized = JSON.parse(JSON.stringify(session.toJSON())); } catch { fail('COUPANG_OWNER_BINDING_INVALID'); }
  if (!isRecord(serialized) || !isRecord(serialized.cookieJar) || !Array.isArray(serialized.cookieJar.cookies)
    || !Array.isArray(allowedCookieNames)) fail('COUPANG_OWNER_BINDING_INVALID');
  const allowed = new Set(allowedCookieNames);
  const seen = new Set();
  serialized.cookieJar.cookies = serialized.cookieJar.cookies.filter(cookie => {
    if (!isRecord(cookie) || typeof cookie.key !== 'string') fail('COUPANG_OWNER_BINDING_INVALID');
    if (!allowed.has(cookie.key)) return false;
    if (seen.has(cookie.key)) fail('COUPANG_OWNER_BINDING_INVALID');
    seen.add(cookie.key);
    return true;
  });
  return serialized;
}

function persistAttestedSession(state, session, dependencies, updatedAt) {
  const sessionState = serializeAttestedSession(session, dependencies.attestedCookieNames);
  const nextState = { ...state, session: sessionState, updatedAt };
  // Validate the exact filtered snapshot being saved, rather than serializing
  // the live jar again after checking it. Never rebind unverified auth cookies.
  try {
    if (dependencies.assertCoupangOwnerBinding({ toJSON: () => sessionState }, nextState) !== true) {
      fail('COUPANG_OWNER_BINDING_INVALID');
    }
  } catch (error) { attestedOwnerFailure(error); }
  dependencies.store.write(NAME, JSON.stringify(nextState));
}

function responseJson(response, code) {
  try { return JSON.parse(response.raw.toString('utf8')); } catch { fail(code); }
}

function validateOwnerResponse(response, state, coupangForbiddenCode) {
  if (response.status === 401) fail('COUPANG_REAUTH_REQUIRED');
  if (response.status === 403) {
    let code = 'COUPANG_AUTH_FORBIDDEN';
    try {
      if (coupangForbiddenCode?.(response) === 'COUPANG_HTTP_ACCESS_DENIED') code = 'COUPANG_HTTP_ACCESS_DENIED';
    } catch { /* keep generic forbidden classification if parsing the response fails */ }
    fail(code, { operation: 'owner-health', httpStatus: 403 });
  }
  if (response.status === 429) fail('COUPANG_AUTH_THROTTLED');
  if (response.status !== 200 || !/^application\/json(?:;|$)/i.test(response.headers?.['content-type'] ?? '')) {
    fail('COUPANG_CONFIG_RESPONSE_INVALID', { operation: 'owner-health', httpStatus: response.status });
  }
  const body = responseJson(response, 'COUPANG_CONFIG_RESPONSE_INVALID');
  if (body?.rCode !== '0') fail('COUPANG_AUTH_APPLICATION_REJECTED');
  const data = body.data;
  if (!data?.member?.valid || typeof data.member.email !== 'string'
    || typeof data.affiliate?.affiliateCode !== 'string') fail('COUPANG_REAUTH_REQUIRED');
  if (data.member.email.toLowerCase() !== state.email.toLowerCase()
    || data.affiliate.affiliateCode !== state.affiliateCode) fail('COUPANG_OWNER_MISMATCH');
  return { authenticated: true, ownerVerified: true };
}

function attestedOwnerFailure(error) {
  switch (error?.code) {
    case 'COUPANG_ATTESTATION_INVALID': fail('COUPANG_ATTESTATION_INVALID'); break;
    case 'COUPANG_OWNER_BINDING_INVALID': fail('COUPANG_OWNER_BINDING_INVALID'); break;
    case 'REAUTH_REQUIRED': fail('COUPANG_REAUTH_REQUIRED'); break;
    case 'AUTH_RESPONSE_INVALID': fail('COUPANG_OWNER_AUTH_RESPONSE_INVALID'); break;
    case 'DASHBOARD_SCHEMA_INVALID': fail('COUPANG_DASHBOARD_SCHEMA_INVALID'); break;
    case 'AUTH_THROTTLED': fail('COUPANG_AUTH_THROTTLED'); break;
    case 'COUPANG_HTTP_ACCESS_DENIED': fail('COUPANG_HTTP_ACCESS_DENIED'); break;
    default: fail('COUPANG_OWNER_HEALTH_UNAVAILABLE');
  }
}

async function validateAttestedOwner(session, state, dependencies) {
  try {
    if (dependencies.assertCoupangOwnerBinding(session, state) !== true) fail('COUPANG_OWNER_BINDING_INVALID');
  } catch (error) { attestedOwnerFailure(error); }
  let result;
  try { result = await dependencies.verifyCoupangBoundOwner(session, state); }
  catch (error) { attestedOwnerFailure(error); }
  if (result?.authenticated !== true || result?.ownerVerified !== true || result?.browserUsed !== false
    || result?.ownerVerificationSource !== 'authorized_browser_config_session_binding'
    || result?.freshHttpIdentityRead !== false) fail('COUPANG_OWNER_BINDING_INVALID');
  try {
    if (dependencies.assertCoupangOwnerBinding(session, state) !== true) fail('COUPANG_OWNER_BINDING_INVALID');
  } catch (error) { attestedOwnerFailure(error); }
  return result;
}

function validateIssuedResponse(response, target, expectedAffiliateCode) {
  const body = responseJson(response, 'COUPANG_LINK_OUTCOME_UNCERTAIN');
  if (body?.rCode !== '0') fail('COUPANG_LINK_OUTCOME_UNCERTAIN', { operation: 'link-issue', httpStatus: 200 });
  const data = body?.data;
  const shortUrl = validShortUrl(data?.shortUrl);
  if (!shortUrl) {
    fail('COUPANG_LINK_OUTCOME_UNCERTAIN', { operation: 'link-issue', httpStatus: 200 });
  }
  let destinationVerified = false;
  let lptag = null;
  let attributionVerified = false;
  let attributionMismatch = false;
  if (Object.hasOwn(data, 'landingUrl')) {
    const landing = observedLanding(data.landingUrl, target, data.type);
    if (!landing) {
      fail('COUPANG_LINK_OUTCOME_UNCERTAIN', { operation: 'link-issue', httpStatus: 200 });
    }
    destinationVerified = true;
    if (landing.lptag !== null) {
      lptag = landing.lptag;
      attributionVerified = lptag === expectedAffiliateCode;
      attributionMismatch = !attributionVerified;
    }
  }
  return {
    shortUrl,
    productUrl: target.productUrl,
    lptag,
    expectedAffiliateCode,
    verification: attributionMismatch ? 'observed_provider_attribution_mismatch' : OBSERVED_PROVIDER_LINK_VERIFICATION,
    destinationVerified,
    destinationVerification: destinationVerified ? 'generation_response_only' : OBSERVED_PROVIDER_LINK_VERIFICATION,
    attributionVerified,
    attributionMismatch,
  };
}

async function resolveDependencies(injected = {}) {
  if (injected.store && injected.sessionFromJSON && injected.withSessionLock && injected.coupangForbiddenCode
    && injected.createCoupangServiceFetch && injected.assertCoupangOwnerBinding && injected.verifyCoupangBoundOwner
    && injected.attestedCookieNames) return injected;
  const importPlaybook = part => import(pathToFileURL(path.join(PLAYBOOK, 'lib', part)).href);
  const [{ ScopedSession }, { ProtectedStore }, { withSessionLock }, { coupangForbiddenCode }, attested] = await Promise.all([
    importPlaybook('scoped-session.mjs'), importPlaybook('protected-store.mjs'), importPlaybook('session-lock.mjs'),
    importPlaybook('web-auth/coupang-response.mjs'),
    importPlaybook('web-auth/coupang-attested-session.mjs'),
  ]);
  const createCoupangServiceFetch = injected.createCoupangServiceFetch ?? attested.createCoupangServiceFetch;
  return {
    store: injected.store ?? new ProtectedStore(),
    sessionFromJSON: injected.sessionFromJSON ?? ((state, fetchImpl) => ScopedSession.fromJSON(state.session, {
      fetchImpl: createCoupangServiceFetch(fetchImpl),
    })),
    withSessionLock: injected.withSessionLock ?? withSessionLock,
    coupangForbiddenCode: injected.coupangForbiddenCode ?? coupangForbiddenCode,
    createCoupangServiceFetch,
    attestedCookieNames: injected.attestedCookieNames
      ?? [...attested.COUPANG_AUTH_COOKIE_NAMES, ...attested.COUPANG_ROUTING_COOKIE_NAMES],
    assertCoupangOwnerBinding: injected.assertCoupangOwnerBinding ?? attested.assertCoupangOwnerBinding,
    verifyCoupangBoundOwner: injected.verifyCoupangBoundOwner ?? attested.verifyCoupangBoundOwner,
    now: injected.now ?? (() => new Date().toISOString()),
  };
}

export async function issueCoupangLink(productUrl, { cacheFile = CACHE, journalFile = JOURNAL, dependencies = {} } = {}) {
  const target = normalizeCoupangProductUrl(productUrl);
  const deps = await resolveDependencies(dependencies);
  const now = deps.now ?? (() => new Date().toISOString());
  const lockRoot = path.join(deps.store.directory ?? path.dirname(cacheFile), 'locks');

  return deps.withSessionLock(async () => {
    const state = readProtectedState(deps.store);
    const expectedAffiliateCode = state.affiliateCode;
    const cache = cacheAt(cacheFile);
    const journal = journalAt(journalFile);
    const prior = priorJournalLink(journal.operations[target.key], target, expectedAffiliateCode);
    const cachedRecord = cache[target.key];
    const providerPrior = prior?.verification === OBSERVED_PROVIDER_LINK_VERIFICATION;
    const cacheHasVerification = cachedRecord != null && Object.hasOwn(cachedRecord, 'verification');
    const providerCache = cachedRecord?.verification === OBSERVED_PROVIDER_LINK_VERIFICATION;
    if (prior && cachedRecord && providerPrior !== providerCache) fail('COUPANG_LINK_CACHE_CONFLICT');
    if (!prior && cacheHasVerification) fail('COUPANG_LINK_CACHE_UNVERIFIED');
    const cachedLink = prior && cachedRecord
      ? (providerPrior
        ? validatedProviderStoredLink(cachedRecord, target, expectedAffiliateCode, 'COUPANG_LINK_CACHE_CONFLICT')
        : validatedStoredLink(cachedRecord, target, expectedAffiliateCode, 'COUPANG_LINK_CACHE_CONFLICT'))
      : null;
    if (prior && cachedLink) {
      const legacyConflict = cachedLink.shortUrl !== prior.shortUrl || cachedLink.lptag !== prior.lptag;
      const providerConflict = providerPrior && (
        cachedLink.productUrl !== prior.productUrl
        || cachedLink.expectedAffiliateCode !== prior.expectedAffiliateCode
        || cachedLink.ownerVerified !== prior.ownerVerified
        || cachedLink.verification !== prior.verification
        || cachedLink.destinationVerified !== prior.destinationVerified
        || cachedLink.destinationVerification !== prior.destinationVerification
        || cachedLink.attributionVerified !== prior.attributionVerified
        || cachedLink.independentReadbackVerified !== prior.independentReadbackVerified
      );
      if (legacyConflict || providerConflict) fail('COUPANG_LINK_CACHE_CONFLICT');
    }
    const legacy = prior ? undefined : cachedRecord;
    const legacyLink = legacy !== undefined
      ? validatedStoredLink(legacy, target, expectedAffiliateCode, 'COUPANG_LINK_CACHE_UNVERIFIED')
      : null;

    validateFreshAuthState(state);
    let session;
    try { session = deps.sessionFromJSON(state, fetch); } catch { fail('COUPANG_AUTH_STATE_INVALID'); }
    let v2OwnerVerified = false;
    try {
      let ownerCheck;
      if (state.version === 2) {
        ownerCheck = await validateAttestedOwner(session, state, deps);
        v2OwnerVerified = true;
      } else {
        let ownerResponse;
        try { ownerResponse = await session.request(`${ORIGIN}/api/v1/config`); }
        catch { fail('COUPANG_OWNER_HEALTH_UNAVAILABLE'); }
        ownerCheck = validateOwnerResponse(ownerResponse, state, deps.coupangForbiddenCode);
      }

      if (prior) {
        if (!cachedRecord) {
          const restoredCache = {
            shortUrl: prior.shortUrl,
            lptag: prior.lptag,
            productUrl: prior.productUrl,
            expectedAffiliateCode,
            attributionVerified: prior.attributionVerified,
            destinationVerified: prior.destinationVerified,
            destinationVerification: prior.destinationVerification,
            issuedAt: journal.operations[target.key].issuedAt,
            ...(providerPrior ? {
              ownerVerified: prior.ownerVerified,
              verification: prior.verification,
              independentReadbackVerified: prior.independentReadbackVerified,
            } : {}),
          };
          writeJsonAtomic(cacheFile, {
            ...cache,
            [target.key]: restoredCache,
          });
        }
        const operation = journal.operations[target.key];
        if (providerPrior) {
          if (operation.expectedAffiliateCode !== expectedAffiliateCode
            || operation.ownerVerified !== prior.ownerVerified
            || operation.verification !== prior.verification
            || operation.attributionVerified !== prior.attributionVerified
            || operation.destinationVerified !== prior.destinationVerified
            || operation.destinationVerification !== prior.destinationVerification
            || operation.independentReadbackVerified !== prior.independentReadbackVerified
            || operation.lptag !== prior.lptag
            || operation.productUrl !== prior.productUrl
            || operation.shortUrl !== prior.shortUrl) {
            fail('COUPANG_LINK_JOURNAL_UNVERIFIED');
          }
        } else if (operation.expectedAffiliateCode !== expectedAffiliateCode || operation.attributionVerified !== true
          || operation.destinationVerification !== prior.destinationVerification
          || operation.independentReadbackVerified !== false) {
          saveOperation(journalFile, journal, target.key, {
            ...operation,
            expectedAffiliateCode,
            attributionVerified: true,
            independentReadbackVerified: false,
            lptag: prior.lptag,
            destinationVerified: prior.destinationVerified,
            destinationVerification: prior.destinationVerification,
            verification: prior.destinationVerified ? 'generation_response_only' : 'legacy-cache-attribution-and-recorded-target',
          });
        }
        return prior;
      }

      if (legacy !== undefined) {
        const operation = {
          target,
          expectedAffiliateCode,
          status: 'cached_legacy',
          issuedAt: legacy.issuedAt,
          attributionVerified: true,
          destinationVerified: false,
          destinationVerification: 'recorded_target_only',
          independentReadbackVerified: false,
          verification: 'legacy-cache-attribution-and-recorded-target',
          shortUrl: legacyLink.shortUrl,
          productUrl: legacyLink.productUrl,
          lptag: legacyLink.lptag,
        };
        saveOperation(journalFile, journal, target.key, operation);
        writeJsonAtomic(cacheFile, {
          ...cache,
          [target.key]: {
            ...legacy,
            expectedAffiliateCode,
            attributionVerified: true,
            destinationVerified: false,
            destinationVerification: 'recorded_target_only',
          },
        });
        return {
          ...legacyLink,
          attributionVerified: true,
          destinationVerified: false,
          destinationVerification: 'recorded_target_only',
          independentReadbackVerified: false,
          cached: true,
        };
      }

      const endpoint = new URL(`${ORIGIN}/api/v1/url/any`);
      endpoint.searchParams.set('coupangUrl', target.productUrl);
      const startedAt = now();
      const started = {
        target,
        expectedAffiliateCode,
        status: 'write_started',
        startedAt,
        method: 'GET',
        origin: ORIGIN,
        path: '/api/v1/url/any',
        ownerVerified: ownerCheck.ownerVerified,
      };
      saveOperation(journalFile, journal, target.key, started);

      let response;
      try {
        response = await session.request(endpoint.href, { headers: { accept: 'application/json', lang: 'ko' } });
      } catch {
        saveOperation(journalFile, journalAt(journalFile), target.key, {
          ...started, status: 'outcome_unknown', updatedAt: now(), failure: 'transport_after_dispatch',
        });
        fail('COUPANG_LINK_OUTCOME_UNCERTAIN');
      }
      if (response.status !== 200) {
        saveOperation(journalFile, journalAt(journalFile), target.key, {
          ...started, status: 'outcome_unknown', updatedAt: now(), responseStatus: response.status,
        });
        fail('COUPANG_LINK_OUTCOME_UNCERTAIN', { operation: 'link-issue', httpStatus: response.status });
      }

      let issued;
      try { issued = validateIssuedResponse(response, target, expectedAffiliateCode); } catch {
        saveOperation(journalFile, journalAt(journalFile), target.key, {
          ...started, status: 'outcome_unknown', updatedAt: now(), responseStatus: response.status,
          failure: 'success_response_unverified',
        });
        fail('COUPANG_LINK_OUTCOME_UNCERTAIN', { operation: 'link-issue', httpStatus: response.status });
      }

      const issuedAt = now();
      const operation = {
        target,
        expectedAffiliateCode,
        status: 'issued',
        startedAt,
        issuedAt,
        method: 'GET',
        origin: ORIGIN,
        path: '/api/v1/url/any',
        responseStatus: response.status,
        ownerVerified: true,
        verification: issued.verification,
        destinationVerified: issued.destinationVerified,
        destinationVerification: issued.destinationVerification,
        attributionVerified: issued.attributionVerified,
        independentReadbackVerified: false,
        shortUrl: issued.shortUrl,
        productUrl: issued.productUrl,
        lptag: issued.lptag,
      };
      try { saveOperation(journalFile, journalAt(journalFile), target.key, operation); } catch {
        fail('COUPANG_LINK_OUTCOME_UNCERTAIN', { operation: 'link-issue', httpStatus: response.status });
      }
      const nextCache = {
        ...cache,
        [target.key]: {
          shortUrl: issued.shortUrl,
          lptag: issued.lptag,
          productUrl: issued.productUrl,
          expectedAffiliateCode,
          ownerVerified: true,
          verification: issued.verification,
          attributionVerified: issued.attributionVerified,
          destinationVerified: issued.destinationVerified,
          destinationVerification: issued.destinationVerification,
          independentReadbackVerified: false,
          issuedAt,
        },
      };
      try { writeJsonAtomic(cacheFile, nextCache); } catch { /* the issued journal is sufficient for a safe read-back */ }
      if (issued.attributionMismatch) {
        fail('COUPANG_LINK_ATTRIBUTION_UNVERIFIED', {
          operation: 'link-issue', httpStatus: response.status,
          destinationVerified: issued.destinationVerified, attributionVerified: false,
        });
      }
      const { attributionMismatch, ...result } = issued;
      return {
        ...result,
        ownerVerified: true,
        cached: false,
        independentReadbackVerified: false,
      };
    } finally {
      if (state.version === 1) {
        deps.store.write(NAME, JSON.stringify({ ...state, session: session.toJSON(), updatedAt: now() }));
      } else if (v2OwnerVerified) {
        persistAttestedSession(state, session, deps, now());
      }
    }
  }, { root: lockRoot, key: NAME });
}

function validateReconciliationCapture(capture, target, operation) {
  const captureKeys = new Set(['version', 'productUrl', 'observedAt', 'httpStatus', 'body']);
  if (!isRecord(capture) || Object.keys(capture).some(key => !captureKeys.has(key))
    || Object.keys(capture).length !== captureKeys.size || capture.version !== 1
    || capture.productUrl !== target.productUrl || capture.httpStatus !== 200
    || typeof capture.observedAt !== 'string' || !isRecord(capture.body)) {
    fail('COUPANG_LINK_RECONCILIATION_CAPTURE_INVALID');
  }
  const observedAtMs = Date.parse(capture.observedAt);
  const startedAtMs = Date.parse(operation.startedAt);
  const updatedAtMs = Date.parse(operation.updatedAt);
  if (![observedAtMs, startedAtMs, updatedAtMs].every(Number.isFinite)
    || startedAtMs > updatedAtMs
    || observedAtMs < startedAtMs - RECONCILIATION_CAPTURE_SKEW_MS
    || observedAtMs > updatedAtMs + RECONCILIATION_CAPTURE_SKEW_MS) {
    fail('COUPANG_LINK_RECONCILIATION_TIME_MISMATCH');
  }
  let bodyText;
  try { bodyText = JSON.stringify(capture.body); } catch { fail('COUPANG_LINK_RECONCILIATION_CAPTURE_INVALID'); }
  if (typeof bodyText !== 'string' || bodyText.length > 131_072) fail('COUPANG_LINK_RECONCILIATION_CAPTURE_INVALID');
  return {
    observedAt: new Date(observedAtMs).toISOString(),
    response: { status: 200, raw: Buffer.from(bodyText, 'utf8') },
  };
}

/**
 * Reconcile only an outcome-unknown journal entry using a local, operator-controlled
 * capture loaded from protected storage. This is a trust boundary for that local
 * capture, not a cryptographic proof of the provider response's network origin.
 */
export async function reconcileCoupangObservedResponse(productUrl, protectedCapture, {
  cacheFile = CACHE, journalFile = JOURNAL, dependencies = {},
} = {}) {
  const target = normalizeCoupangProductUrl(productUrl);
  const deps = await resolveDependencies(dependencies);
  const now = deps.now ?? (() => new Date().toISOString());
  const lockRoot = path.join(deps.store.directory ?? path.dirname(cacheFile), 'locks');

  return deps.withSessionLock(async () => {
    const state = readProtectedState(deps.store);
    if (state.version !== 2) fail('COUPANG_LINK_RECONCILIATION_REQUIRES_ATTESTED_STATE');
    validateFreshAuthState(state);
    const journal = journalAt(journalFile);
    const operation = journal.operations[target.key];
    if (!isRecord(operation) || operation.status !== 'outcome_unknown'
      || operation.method !== 'GET' || operation.origin !== ORIGIN || operation.path !== '/api/v1/url/any'
      || operation.responseStatus !== 200 || operation.failure !== 'success_response_unverified'
      || operation.ownerVerified !== true || operation.expectedAffiliateCode !== state.affiliateCode
      || operation.target?.productUrl !== target.productUrl || !sameIdentity(operation.target, target)) {
      fail('COUPANG_LINK_RECONCILIATION_NOT_APPLICABLE');
    }
    const capture = validateReconciliationCapture(protectedCapture, target, operation);
    const cache = cacheAt(cacheFile);
    if (Object.hasOwn(cache, target.key)) fail('COUPANG_LINK_CACHE_CONFLICT');

    let session;
    try { session = deps.sessionFromJSON(state, fetch); } catch { fail('COUPANG_AUTH_STATE_INVALID'); }
    let ownerCheck;
    try { ownerCheck = await validateAttestedOwner(session, state, deps); }
    catch (error) { attestedOwnerFailure(error); }

    const issued = validateIssuedResponse(capture.response, target, state.affiliateCode);
    if (issued.attributionMismatch) {
      fail('COUPANG_LINK_ATTRIBUTION_UNVERIFIED', {
        operation: 'link-reconcile', httpStatus: 200,
        destinationVerified: issued.destinationVerified, attributionVerified: false,
      });
    }
    try {
      if (deps.assertCoupangOwnerBinding(session, state) !== true) fail('COUPANG_OWNER_BINDING_INVALID');
    } catch (error) { attestedOwnerFailure(error); }

    const reconciledAt = now();
    const { failure: _failure, ...operationWithoutFailure } = operation;
    const reconciledOperation = {
      ...operationWithoutFailure,
      status: 'issued',
      updatedAt: reconciledAt,
      issuedAt: capture.observedAt,
      ownerVerified: ownerCheck.ownerVerified,
      verification: issued.verification,
      destinationVerified: issued.destinationVerified,
      destinationVerification: issued.destinationVerification,
      attributionVerified: issued.attributionVerified,
      independentReadbackVerified: false,
      shortUrl: issued.shortUrl,
      productUrl: issued.productUrl,
      lptag: issued.lptag,
      reconciliationSource: 'protected_operator_capture',
      reconciledAt,
    };
    saveOperation(journalFile, journal, target.key, reconciledOperation);

    const nextCache = {
      ...cache,
      [target.key]: {
        shortUrl: issued.shortUrl,
        lptag: issued.lptag,
        productUrl: issued.productUrl,
        expectedAffiliateCode: state.affiliateCode,
        ownerVerified: ownerCheck.ownerVerified,
        verification: issued.verification,
        attributionVerified: issued.attributionVerified,
        destinationVerified: issued.destinationVerified,
        destinationVerification: issued.destinationVerification,
        independentReadbackVerified: false,
        issuedAt: capture.observedAt,
        reconciliationSource: 'protected_operator_capture',
      },
    };
    try { writeJsonAtomic(cacheFile, nextCache); } catch { /* the reconciled journal is sufficient for a safe read-back */ }

    persistAttestedSession(state, session, deps, reconciledAt);
    const { attributionMismatch: _attributionMismatch, ...result } = issued;
    return {
      ...result,
      ownerVerified: true,
      cached: false,
      independentReadbackVerified: false,
      reconciliationSource: 'protected_operator_capture',
      reconciledAt,
    };
  }, { root: lockRoot, key: NAME });
}

export function safeCoupangLinkReceipt(result) {
  return {
    ok: true,
    shortUrl: result.shortUrl,
    productUrl: result.productUrl,
    cached: result.cached,
    ownerVerified: result.ownerVerified,
    verification: result.verification,
    destinationVerified: result.destinationVerified,
    destinationVerification: result.destinationVerification,
    attributionVerified: result.attributionVerified,
    independentReadbackVerified: result.independentReadbackVerified,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  issueCoupangLink(process.argv[2]).then(
    result => console.log(JSON.stringify(safeCoupangLinkReceipt(result))),
    error => {
      console.log(JSON.stringify({
        ok: false,
        code: /^COUPANG_LINK_[A-Z0-9_]+$/.test(error?.code ?? '') || /^COUPANG_[A-Z0-9_]+$/.test(error?.code ?? '')
          ? error.code : 'COUPANG_LINK_FAILED',
        ...(error?.receipt ? { receipt: error.receipt } : {}),
      }));
      process.exitCode = 1;
    },
  ).catch(() => { process.exitCode = 1; });
}
