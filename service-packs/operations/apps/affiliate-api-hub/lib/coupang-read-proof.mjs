const ORIGIN = 'https://www.coupang.com';
const ID = /^[1-9]\d{0,19}$/;
const MIME_TYPES = new Set(['application/json', 'text/html', 'application/xhtml+xml', 'text/plain']);
const SERVERS = new Map([
  ['envoy', 'envoy'],
  ['akamaighost', 'AkamaiGHost'],
  ['cloudflare', 'cloudflare'],
]);
const ROUTES = new Map([
  ['offer_list', '/next-api/offer-list'],
  ['quantity_info', '/next-api/products/quantity-info'],
]);
const QUERY_KEYS = Object.freeze({
  offer_list: Object.freeze(['productId', 'itemId', 'selectedVendorItemId']),
  quantity_info: Object.freeze(['productId', 'vendorItemId']),
});
const VISITOR_COOKIE_NAMES = new Set(['PCID', 'x-coupang-target-market', 'x-coupang-accept-language']);

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function dataValue(record, key) {
  if (!isRecord(record)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function plainRecord(value) {
  if (!isRecord(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function safeKeys(value, operation) {
  if (!plainRecord(value)) return [];
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { return []; }
  const allowed = QUERY_KEYS[operation] ?? [];
  return keys.filter(key => typeof key === 'string' && allowed.includes(key)).sort();
}

function exactIdentityMatch(receipt, operation, expectedIdentity) {
  if (!plainRecord(expectedIdentity)
    || ![expectedIdentity.productId, expectedIdentity.itemId, expectedIdentity.vendorItemId]
      .every(value => typeof value === 'string' && ID.test(value))) return false;
  if (!ROUTES.has(operation)
    || dataValue(receipt, 'origin') !== ORIGIN
    || dataValue(receipt, 'path') !== ROUTES.get(operation)
    || dataValue(receipt, 'method') !== 'GET') return false;

  const query = dataValue(receipt, 'query');
  if (!plainRecord(query)) return false;
  let keys;
  try { keys = Reflect.ownKeys(query); } catch { return false; }
  const expectedKeys = QUERY_KEYS[operation];
  if (keys.length !== expectedKeys.length || keys.some(key => typeof key !== 'string' || !expectedKeys.includes(key)))
    return false;

  const values = Object.fromEntries(expectedKeys.map(key => [key, dataValue(query, key)]));
  if (operation === 'offer_list') {
    return values.productId === expectedIdentity.productId
      && values.itemId === expectedIdentity.itemId
      && values.selectedVendorItemId === expectedIdentity.vendorItemId;
  }
  return values.productId === expectedIdentity.productId
    && values.vendorItemId === expectedIdentity.vendorItemId;
}

function safeCheckedAt(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? value : null;
}

function safeStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}

function safeBoundedInteger(value, maximum) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
}

function safeBoolean(value) {
  return typeof value === 'boolean' ? value : null;
}

function safeVisitorCookieNames(value) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > VISITOR_COOKIE_NAMES.size) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1 || !keys.includes('length')) return null;
    const names = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
      const name = descriptor.value;
      if (typeof name !== 'string' || !VISITOR_COOKIE_NAMES.has(name) || names.includes(name)) return null;
      names.push(name);
    }
    return names.sort();
  } catch {
    return null;
  }
}

function safeMimetype(value) {
  return typeof value === 'string' && MIME_TYPES.has(value.toLowerCase()) ? value.toLowerCase() : null;
}

function safeServer(value) {
  return typeof value === 'string' ? SERVERS.get(value.trim().toLowerCase()) ?? null : null;
}

function safeEnum(value, allowed) {
  return typeof value === 'string' && allowed.has(value) ? value : null;
}

const DENIAL_SIGNAL_NAMES = Object.freeze([
  'requestBlocked',
  'automatedAccess',
  'permissionDenied',
  'loginPage',
]);

/**
 * Reduce a consumer-read receipt to a fixed, non-sensitive proof record.
 * Query values, request/response text, headers, cookies, tokens and hashes are never copied.
 */
export function projectCoupangReadProof(receipt, expectedIdentity) {
  if (!isRecord(receipt)) return null;

  const operation = safeEnum(dataValue(receipt, 'operation'), new Set(ROUTES.keys()));
  const allowedPath = operation ? ROUTES.get(operation) : null;
  const path = dataValue(receipt, 'path') === allowedPath ? allowedPath : null;
  const origin = dataValue(receipt, 'origin') === ORIGIN ? ORIGIN : null;
  const method = dataValue(receipt, 'method') === 'GET' ? 'GET' : null;
  const query = dataValue(receipt, 'query');
  const rawKeys = plainRecord(query) ? safeKeys(query, operation) : [];
  const denialSignals = dataValue(receipt, 'denialSignals');
  const bootstrap = dataValue(receipt, 'visitorBootstrap');
  const server = safeServer(dataValue(receipt, 'server'));
  const execution = safeEnum(dataValue(receipt, 'execution'), new Set(['pure_http', 'browser_observed_fixture']));
  const transport = safeEnum(dataValue(receipt, 'transport'), new Set(['native_fetch', 'injected', 'browser_observed_fixture']));
  const authenticationMode = safeEnum(dataValue(receipt, 'authenticationMode'), new Set(['protected', 'visitor', 'anonymous']));
  const exactRequestIdentityMatched = exactIdentityMatch(receipt, operation, expectedIdentity);
  const identityFieldsMatched = exactRequestIdentityMatched
    ? operation === 'offer_list' ? ['productId', 'itemId', 'vendorItemId'] : ['productId', 'vendorItemId']
    : [];

  const projectedSignals = {};
  for (const name of DENIAL_SIGNAL_NAMES) projectedSignals[name] = safeBoolean(dataValue(denialSignals, name));

  return {
    method,
    operation,
    origin,
    path,
    queryKeys: rawKeys,
    exactRequestIdentityMatched,
    identityFieldsMatched,
    checkedAt: safeCheckedAt(dataValue(receipt, 'checkedAt')),
    status: safeStatus(dataValue(receipt, 'status')),
    execution,
    transport,
    authMode: authenticationMode,
    credentialSent: safeBoolean(dataValue(receipt, 'credentialSent')),
    credentialPropagated: safeBoolean(dataValue(receipt, 'credentialPropagated')),
    authenticatedOwnerVerified: safeBoolean(dataValue(receipt, 'authenticatedOwnerVerified')),
    applicationAuthenticated: safeBoolean(dataValue(receipt, 'applicationAuthenticated')),
    browserUsed: safeBoolean(dataValue(receipt, 'browserUsed')),
    contentType: safeMimetype(dataValue(receipt, 'contentType')),
    server,
    bytes: safeBoundedInteger(dataValue(receipt, 'bytes'), 8 * 1024 * 1024 + 64 * 1024),
    bodyComplete: safeBoolean(dataValue(receipt, 'bodyComplete')),
    bodyError: safeEnum(dataValue(receipt, 'bodyError'), new Set(['response_size', 'response_stream'])),
    challengeConfirmed: safeBoolean(dataValue(receipt, 'challengeConfirmed')),
    accessDeniedTitle: safeBoolean(dataValue(receipt, 'accessDeniedTitle')),
    dpopChallengePresent: safeBoolean(dataValue(receipt, 'dpopChallengePresent')),
    denialSignals: projectedSignals,
    cookieRotationApplied: safeBoolean(dataValue(receipt, 'cookieRotationApplied')),
    cookieRotationPersisted: safeBoolean(dataValue(receipt, 'cookieRotationPersisted')),
    visitorCookieRotationApplied: safeBoolean(dataValue(receipt, 'visitorCookieRotationApplied')),
    visitorCookiesSent: safeBoolean(dataValue(receipt, 'visitorCookiesSent')),
    visitorCookieNames: safeVisitorCookieNames(dataValue(receipt, 'visitorCookieNames')),
    visitorBootstrapStatus: safeStatus(dataValue(bootstrap, 'status')),
    retry: safeBoolean(dataValue(receipt, 'retry')),
    redirectsFollowed: safeBoolean(dataValue(receipt, 'redirectsFollowed')),
    responseCookieHeadersAvailable: safeBoolean(dataValue(receipt, 'responseCookieHeadersAvailable')),
    responseCookieCount: safeBoundedInteger(dataValue(receipt, 'responseCookieCount'), 100),
    retryAfterSeconds: safeBoundedInteger(dataValue(receipt, 'retryAfterSeconds'), 3600),
    durationMs: safeBoundedInteger(dataValue(receipt, 'durationMs'), 120_000),
  };
}
