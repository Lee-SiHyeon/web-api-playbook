// Bind existing, read-only implementations. No endpoint discovery, login, link
// issuance, environment credential lookup, or persistent session updates here.
import os from 'node:os';
import path from 'node:path';
import { validateOperationValue } from '../operation-registry.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const scalar = true;
const fields = names => Object.fromEntries(names.split(' ').map(name => [name, scalar]));
const text = (maxLength = 256) => ({ type: 'string', minLength: 1, maxLength });
const integer = (maximum, defaultValue, minimum = 1) => ({ type: 'integer', minimum, maximum,
  ...(defaultValue === undefined ? {} : { default: defaultValue }) });
const required = schema => ({ ...schema, required: true });

// Explicit output shapes: native clients sometimes retain arbitrary upstream tag
// objects or undefined option fields. Neither is safe as an adapter JSON result.
function project(value, shape, secrets = new Set(), depth = 0) {
  if (value === undefined || depth > 20) return undefined;
  if (value === null) return null;
  if (shape === scalar) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value === 'boolean') return value;
    if (typeof value !== 'string') return undefined;
    let decoded = value;
    for (let index = 0; index < 8; index++) {
      for (const secret of secrets) if (secret && decoded.includes(secret)) return '[redacted]';
      let next;
      try { next = decodeURIComponent(decoded); } catch { break; }
      if (next === decoded) break;
      decoded = next;
    }
    for (const secret of secrets) if (secret && decoded.includes(secret)) return '[redacted]';
    return value;
  }
  if (Array.isArray(shape)) {
    if (!Array.isArray(value)) return undefined;
    return value.slice(0, 1000).map(item => project(item, shape[0], secrets, depth + 1)).filter(item => item !== undefined);
  }
  if (!object(value)) return undefined;
  const out = {};
  for (const [key, child] of Object.entries(shape)) {
    if (!Object.hasOwn(value, key)) continue;
    const clean = project(value[key], child, secrets, depth + 1);
    if (clean !== undefined) out[key] = clean;
  }
  return out;
}

const requestShape = { ...fields('method origin path httpStatus mime responseContentType responseBytes checkedAt browserUsed credentialsUsed'),
  queryFields: [scalar], queryFieldNames: [scalar] };
const receiptShape = { ...requestShape, ...fields('schema service capabilityId authenticated ownerVerified schemaVerified expectedResultVerified secretsPersistedInEvidence operation executionMode responseSha256 priorRead'),
  request: requestShape, requests: [requestShape], contractProvenance: fields('kind sourceURL') };
const videoShape = { ...fields('provider videoId channelId channelTitle title url publishedAt description descriptionSha256'),
  promotionHints: [fields('kind field matchedText startUtf16 endUtf16 interpretation')],
  creatorClaims: fields('basis status checkedAt'), source: fields('kind url contractURL observedAt') };
const healthShape = fields('authenticated identityMatched ownerMatched creator activeSpaceVerified ownerVerified browserUsed renewal httpStatus resultType transport sectionCount itemCount todayDealEntryCount checkedAt');
// Brand Connect returns endpoint-specific envelopes. Keep only known catalogue
// display fields, never account/session data or arbitrary nested response keys.
const brandItem = { ...fields('id affiliateProductId affiliateStoreId storeId productId title name productName storeName url productUrl imageUrl thumbnailUrl salePrice discountedSalePrice commissionRate'),
  images: [scalar] };
const brandData = { ...brandItem, items: [brandItem], content: [brandItem], contents: [brandItem], products: [brandItem], stores: [brandItem],
  ...fields('total totalCount count'), paging: fields('hasNext page pageSize') };

const missingCodes = new Set(['PROTECTED_STORE_PROVIDER_REQUIRED', 'PROTECTED_STORE_PROVIDER_UNSUPPORTED']);
const errorCodes = new Set(`PROVIDER_MISSING PROVIDER_INVALID OPERATION_ABORTED OPERATION_INPUT_INVALID OPERATION_INPUT_REQUIRED READ_SCOPE_REJECTED
OPERATION_ADAPTER_RESULT_INVALID CREATOR_GOOGLE_SCHEMA_INVALID CREATOR_GOOGLE_TRANSPORT_FAILED CREATOR_GOOGLE_BODY_LIMIT
ELEVENLABS_STATE_INVALID ELEVENLABS_STATE_SCOPE ELEVENLABS_ORIGIN_INVALID ELEVENLABS_ORIGIN_SCOPE
TOSS_REAUTH_REQUIRED TOSS_STATE_INVALID TOSS_COOKIE_SCOPE_REJECTED TOSS_OPERATION_REJECTED TOSS_REQUEST_SCOPE_REJECTED TOSS_OWNER_REQUEST_INVALID
TOSS_OPERATION_NOT_CAPTURED TOSS_HTTP_FAILED TOSS_RESPONSE_INVALID TOSS_SERVICE_REJECTED TOSS_OWNER_MISMATCH TOSS_CURATION_SCHEMA_INVALID
AUTH_STATE_INVALID REAUTH_REQUIRED AUTH_SESSION_INVALIDATED TRANSPORT_FAILED FORBIDDEN THROTTLED HTTP_STATUS RESPONSE_SCHEMA_INVALID
RESPONSE_MIME_INVALID RESPONSE_JSON_INVALID OWNER_SCHEMA_INVALID ACCOUNT_MISMATCH ENTITLEMENT_REQUIRED SPACE_NOT_ACTIVE INPUT_INVALID
YOUTUBE_CHANNEL_ID_INVALID YOUTUBE_FEED_SCHEMA_INVALID YOUTUBE_VIDEO_ID_INVALID YOUTUBE_VIDEO_SCHEMA_INVALID YOUTUBE_XML_INVALID
YOUTUBE_XML_ENTITY_INVALID YOUTUBE_XML_DTD_REJECTED YOUTUBE_XML_PI_REJECTED YOUTUBE_XML_DECLARATION_REJECTED YOUTUBE_XML_LIMIT_EXCEEDED
YOUTUBE_REQUEST_TIMEOUT YOUTUBE_TRANSPORT_ERROR YOUTUBE_REDIRECT_REJECTED YOUTUBE_HTTP_ERROR YOUTUBE_CONTENT_TYPE_INVALID YOUTUBE_BODY_TOO_LARGE
PROTECTED_STORE_READ_FAILED PROTECTED_STORE_NAME_INVALID PROTECTED_STORE_DIRECTORY_INVALID SESSION_LOCK_TIMEOUT SESSION_LOCK_ABORTED`.split(/\s+/));

function context(options, signal, scope) {
  const requests = [], secrets = new Set();
  const checkAbort = () => { if (signal?.aborted) fail('OPERATION_ABORTED'); };
  const fetchImpl = async (target, init = {}) => {
    checkAbort();
    const url = new URL(target);
    if ((init.method ?? 'GET') !== 'GET' || init.body !== undefined || url.username || url.password || url.hash || !scope(url)) fail('READ_SCOPE_REJECTED');
    const headers = new Headers(init.headers);
    for (const [name, value] of headers) {
      if (name === 'cookie') {
        for (const pair of value.split(';')) {
          const index = pair.indexOf('='); if (index >= 0) secrets.add(pair.slice(index + 1).trim());
        }
      }
      else if (/authorization|api[-_]?key|auth[-_]?token|anonymous[-_]?token/i.test(name)) {
        secrets.add(value); secrets.add(value.replace(/^Bearer\s+/i, ''));
      }
    }
    const entry = { method: 'GET', origin: url.origin,
      path: url.pathname,
      queryFields: [...url.searchParams.keys()], browserUsed: false };
    const combined = signal && init.signal ? AbortSignal.any([signal, init.signal]) : signal ?? init.signal;
    requests.push(entry);
    const response = await (options.fetchImpl ?? globalThis.fetch)(target, { ...init, ...(combined ? { signal: combined } : {}) });
    for (const cookie of response.headers?.getSetCookie?.() ?? []) {
      const pair = cookie.split(';')[0], index = pair.indexOf('=');
      if (index >= 0) secrets.add(pair.slice(index + 1).trim());
    }
    entry.httpStatus = response.status;
    entry.mime = response.headers?.get?.('content-type')?.split(';')[0];
    checkAbort(); return response;
  };
  const receipt = native => ({ ...(project(native, receiptShape, secrets) ?? {}),
    networkUsed: requests.length > 0, browserUsed: false, writesSubmitted: 0,
    ...(requests.length ? { requestCount: requests.length,
      ...(Number.isFinite(requests.at(-1).httpStatus) ? { httpStatus: requests.at(-1).httpStatus } : {}),
      requests: requests.map(request => project(request, requestShape, secrets)) } : {}) });
  return { fetchImpl, secrets, checkAbort, receipt };
}

function inputFor(operation, input = {}) {
  if (!object(input) || Object.keys(input).some(key => !['query', 'path', 'body'].includes(key) || !object(input[key]))) fail('OPERATION_INPUT_INVALID');
  const result = {};
  for (const group of ['query', 'path', 'body']) {
    const supplied = input[group] ?? {}, definitions = operation.inputs?.[group] ?? {};
    if (Object.keys(supplied).some(key => !Object.hasOwn(definitions, key))) fail('OPERATION_INPUT_INVALID');
    for (const [key, schema] of Object.entries(definitions)) {
      const value = supplied[key] === undefined ? schema.default : supplied[key];
      if (value === undefined) { if (schema.required) fail('OPERATION_INPUT_REQUIRED'); continue; }
      result[key] = validateOperationValue(value, schema);
    }
  }
  return result;
}

// credentialProvider accepts a native saved state (object/JSON), {state},
// {bundle}, or {store}.
// Omission uses the existing protected store for session-backed services, never
// an environment variable, fresh login, browser export or key discovery.
async function preparedStore(id, nativeName, options, ctx) {
  ctx.checkAbort();
  let supplied, source;
  if (options.credentialProvider !== undefined) {
    if (typeof options.credentialProvider !== 'function') fail('PROVIDER_INVALID');
    try { supplied = await options.credentialProvider(id); } catch { fail('PROVIDER_MISSING'); }
    ctx.checkAbort();
    if (supplied == null) fail('PROVIDER_MISSING');
    if (object(supplied) && supplied.store) source = supplied.store;
  } else {
    const { ProtectedStore } = await import('../protected-store.mjs');
    try { source = new ProtectedStore({ directory: options.storeDirectory }); }
    catch (error) { if (missingCodes.has(error.code)) fail('PROVIDER_MISSING'); throw error; }
  }
  let raw;
  if (source) {
    if (typeof source.read !== 'function') fail('PROVIDER_INVALID');
    raw = await source.read(options.sessionName ?? nativeName);
  } else {
    const state = supplied.state ?? supplied.bundle ?? supplied;
    try { raw = typeof state === 'string' ? state : JSON.stringify(state); } catch { fail('PROVIDER_INVALID'); }
  }
  if (!raw) fail('PROVIDER_MISSING');
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 1024 * 1024) fail('PROVIDER_INVALID');
  let value = raw;
  return {
    directory: options.storeDirectory ?? source?.directory ?? path.join(os.tmpdir(), 'playbook-extras-prepared'),
    read(name) { if (name !== nativeName) fail('READ_SCOPE_REJECTED'); return value; },
    // Native readers may save cookie rotations in finally; keep those solely in
    // the per-call overlay, never write through to the supplied credential store.
    write(name, next) { if (name !== nativeName) fail('READ_SCOPE_REJECTED'); value = next; return { stored: true, provider: 'process-memory', persistent: false }; },
    status(name) { if (name !== nativeName) fail('READ_SCOPE_REJECTED'); return { available: true, provider: 'prepared-session', persistent: false }; },
  };
}

function definition(id, title, specs, execute, { verificationChecks = [], aliases = [], checklistIds = [id], requires = [] } = {}) {
  const operations = Object.fromEntries(Object.entries(specs).map(([action, inputs]) => [action, {
    adapter: `${id}.${action}`, semantics: 'read', evidence: execute.evidence, inputs,
  }]));
  return { id, title, aliases, checklistIds, requires, profile: { schemaVersion: 2, serviceId: id, allowedOrigins: [], operations }, verificationChecks,
    createAdapters(options = {}) {
      return { adapters: Object.fromEntries(Object.entries(operations).map(([action, operation]) => [`${id}.${action}`, async (input = {}, { signal } = {}) => {
        const ctx = context(options, signal, execute.scope);
        try {
          ctx.checkAbort();
          const params = inputFor(operation, input);
          const result = await execute.run(action, params, options, ctx);
          ctx.checkAbort();
          const data = project(result.data, result.shape, ctx.secrets);
          if (data === undefined) fail('OPERATION_ADAPTER_RESULT_INVALID');
          return { data, receipt: ctx.receipt(result.receipt) };
        } catch (error) {
          const code = signal?.aborted ? 'OPERATION_ABORTED' : errorCodes.has(error?.code) ? error.code : `${id.toUpperCase().replaceAll('-', '_')}_READ_FAILED`;
          const receipt = ctx.receipt(error?.receipt);
          for (const key of Object.keys(receipt)) if (receipt[key] === undefined) delete receipt[key];
          throw Object.assign(new Error(code), { code, receipt });
        }
      }])) };
    },
  };
}

const elevenlabs = definition('elevenlabs', 'ElevenLabs prepared session status (local only)', { status: {} }, {
  evidence: 'lib/elevenlabs-session.mjs:elevenLabsSessionStatus; no observed API read endpoint', scope: () => false,
  async run(_action, _params, options, ctx) {
    const { elevenLabsSessionStatus, ELEVENLABS_STORE } = await import('../elevenlabs-session.mjs');
    const store = await preparedStore('elevenlabs', ELEVENLABS_STORE, options, ctx);
    const status = await elevenLabsSessionStatus({ store });
    if (!status.stored) fail(errorCodes.has(status.code) ? status.code : 'ELEVENLABS_STATE_INVALID');
    return { data: status, shape: { ...fields('stored capturedAt liveCheckPerformed authenticatedOwnerVerified optionsRead generationPerformed'), observedOrigins: [scalar] } };
  },
}, { verificationChecks: [{ operation: 'status', input: {}, kind: 'local' }], requires: ['existing observed session; no live API endpoint implemented'] });

const toss = definition('toss-sharelink', 'Toss Sharelink existing-session health and curation counts', { health: {} }, {
  evidence: 'lib/web-auth/toss.mjs:createTossAuth.health; lib/web-auth/toss/client-core.mjs',
  scope: url => url.origin === 'https://sharelink.toss.im' && [
    '/api-public/v3/shopping-growth/sharelink/member', '/api-public/v3/shopping/sharelink/curation-sections',
  ].includes(url.pathname),
  async run(_action, _params, options, ctx) {
    const { createTossAuth } = await import('../web-auth/toss.mjs');
    const store = await preparedStore('toss-sharelink', 'toss-sharelink-state', options, ctx);
    const data = await createTossAuth({ store, fetchImpl: ctx.fetchImpl }).health();
    return { data, shape: healthShape };
  },
}, { verificationChecks: [{ operation: 'health', input: {}, kind: 'live_read' }], requires: ['existing owner-bound protected session with captured member and curation reads'] });

const creator = definition('creator-youtube', 'Creator public YouTube channel feed (no dashboard access)', {
  feed: { query: { channelId: required(text(24)) } },
}, {
  evidence: 'lib/creator-promotions/youtube.mjs:createYouTubeDiscoveryClient.getChannelFeed',
  scope: url => url.origin === 'https://www.youtube.com' && url.pathname === '/feeds/videos.xml',
  async run(_action, params, _options, ctx) {
    const { createYouTubeDiscoveryClient } = await import('../creator-promotions/youtube.mjs');
    const data = await createYouTubeDiscoveryClient({ fetchImpl: ctx.fetchImpl }).getChannelFeed(params);
    return { data, shape: { ...fields('provider channelId channelUrl'), videos: [videoShape],
      collection: fields('source pagesRead entriesSeen descriptionCount complete limitation') }, receipt: data.receipt };
  },
}, { checklistIds: [], requires: ['caller-supplied public channelId; feed is recent entries only, not a protected creator dashboard'] });

const google = definition('creator-google', 'Creator public Google Trends RSS', {
  rss: { query: { geo: { type: 'string', minLength: 2, maxLength: 2, default: 'KR' } } },
}, {
  evidence: 'service-packs/naver/apps/naver-blog-api/research/trend-radar/sources/google-trends-rss.mjs:fetchGoogleTrending',
  scope: url => url.origin === 'https://trends.google.com' && url.pathname === '/trending/rss',
  async run(_action, params, _options, ctx) {
    const { fetchGoogleTrending } = await import('../../service-packs/naver/apps/naver-blog-api/research/trend-radar/sources/google-trends-rss.mjs');
    let data, bodyLimited = false;
    const fetchImpl = async (...args) => {
      if (bodyLimited) fail('CREATOR_GOOGLE_BODY_LIMIT');
      const response = await ctx.fetchImpl(...args);
      return { status: response.status, headers: response.headers, async text() {
        if (!response.body) return '';
        const reader = response.body.getReader(), chunks = [];
        let bytes = 0;
        try {
          for (;;) {
            ctx.checkAbort();
            const next = await reader.read();
            if (next.done) break;
            bytes += next.value.byteLength;
            if (bytes > 2 * 1024 * 1024) { bodyLimited = true; fail('CREATOR_GOOGLE_BODY_LIMIT'); }
            chunks.push(Buffer.from(next.value));
          }
          return Buffer.concat(chunks, bytes).toString('utf8');
        } finally { await reader.cancel().catch(() => {}); }
      } };
    };
    try { data = await fetchGoogleTrending({ ...params, fetchImpl }); }
    catch (error) {
      if (bodyLimited) fail('CREATOR_GOOGLE_BODY_LIMIT');
      const code = { INPUT: 'OPERATION_INPUT_INVALID', SCHEMA: 'CREATOR_GOOGLE_SCHEMA_INVALID',
        TRANSPORT: 'CREATOR_GOOGLE_TRANSPORT_FAILED', HTTP_STATUS: 'HTTP_STATUS' }[error?.code];
      if (code) fail(code);
      throw error;
    }
    return { data, shape: { geo: scalar, trends: [{ ...fields('keyword approxTrafficLabel approxTraffic publishedAt pictureSource'),
      news: [fields('title url source')] }] }, receipt: data.receipt };
  },
}, { verificationChecks: [{ operation: 'rss', input: { query: { geo: 'KR' } }, kind: 'live_read' }],
  requires: ['public RSS; approximate traffic only; geo syntax does not establish market support'] });

const brandconnect = definition('brandconnect', 'Naver Brand Connect existing-session owner and shopping reads', {
  health: {},
  'shopping-search': { query: { query: required(text()), limit: integer(100, 10) } },
  'shopping-stores': { query: { query: required(text()), pageSize: integer(100, 20) } },
  'shopping-featured': {},
}, {
  evidence: 'lib/web-auth/brandconnect.mjs:createBrandconnectAuth health/shoppingSearch/shoppingStores/shoppingFeatured',
  scope: url => url.origin === 'https://gw-brandconnect.naver.com' && [
    '/brand-connect/query/me', '/brand-connect/query/space/check-owner',
    '/affiliate/query/affiliate-products/search-by-query', '/affiliate/query/affiliate-stores/search', '/affiliate/query/popup-stores',
  ].includes(url.pathname),
  async run(action, params, options, ctx) {
    const { createBrandconnectAuth } = await import('../web-auth/brandconnect.mjs');
    const store = await preparedStore('brandconnect', 'brandconnect-state', options, ctx);
    const auth = createBrandconnectAuth({ store, fetchImpl: ctx.fetchImpl });
    const method = { health: 'health', 'shopping-search': 'shoppingSearch', 'shopping-stores': 'shoppingStores', 'shopping-featured': 'shoppingFeatured' }[action];
    const result = await auth[method](params);
    const data = action === 'health' ? result : result.data;
    return { data, shape: action === 'health' ? healthShape : Array.isArray(data) ? [brandItem] : brandData,
      receipt: { ...result.receipt, authenticated: result.authenticated, ownerVerified: result.ownerVerified } };
  },
}, { aliases: ['naver-brandconnect'], checklistIds: [], verificationChecks: [{ operation: 'health', input: {}, kind: 'live_read' }],
  requires: ['existing owner-bound Brand Connect state; no login or renewal; cookie rotations kept in memory only'] });

export const definitions = [elevenlabs, toss, creator, google, brandconnect];
