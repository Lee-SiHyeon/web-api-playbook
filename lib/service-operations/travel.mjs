// Only named reads from existing clients. No login/renewal, link creation, tab
// creation, session persistence, media download, or caller-supplied HTTP routes.
// Loader options: fetchImpl, credentialProvider(serviceId), sessionName and
// storeDirectory. MyRealTrip accepts its existing client session shape
// {token, expectedPartnerId, expectedEmail} or sealed auth-state shape
// {accessToken, partnerId, email}. Video browser credentials use {cdpEndpoint};
// video HTTP credentials use the existing AliExpress {cookies, userAgent} state.
// Additional store/createFetcher/now/minIntervalMs hooks are for local fixtures.
const agodaSource = 'lib/travel/agoda.mjs';
const marketingSource = 'service-packs/affiliate/apps/affiliate-api-hub/adapters/myrealtrip-marketing.mjs';
const probeSource = 'service-packs/affiliate/apps/affiliate-api-hub/adapters/partner-account-probes.mjs';
const ontologySource = 'service-packs/ontology/src/travel-price/seller-adapters/';
const operationName = value => value.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
const text = (required = true, maxLength = 100) => ({ type: 'string', required, minLength: 1, maxLength });
const integer = (minimum, maximum, defaultValue) => ({ type: 'integer', minimum, maximum,
  ...(defaultValue === undefined ? { required: true } : { default: defaultValue }) });
const array = (items, minItems = 0, maxItems = 30, defaultValue) => ({ schema: { type: 'array', items, minItems, maxItems },
  ...(defaultValue === undefined ? { required: true } : { default: defaultValue }) });
const read = (adapter, evidence, description, query = {}) => ({ adapter: operationName(adapter), semantics: 'read', evidence, description,
  ...(Object.keys(query).length ? { inputs: { query } } : {}) });
const profile = (serviceId, operations) => ({ schemaVersion: 2, serviceId, allowedOrigins: [],
  operations: Object.fromEntries(Object.entries(operations).map(([name, operation]) => [operationName(name), operation])) });
const fail = code => { throw Object.assign(new Error(code), { code }); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Preserve source projections (including price/date/source caveats), but never
// silently turn invalid numeric prices into JSON null. Omit optional undefined
// object fields; valid Dates, if supplied by an injected client, become strings.
function finiteJson(value, ancestors = new Set(), depth = 0) {
  if (depth > 40) fail('OPERATION_ADAPTER_RESULT_INVALID');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('OPERATION_ADAPTER_RESULT_INVALID');
    return value;
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value !== 'object' || ancestors.has(value) ||
      !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('OPERATION_ADAPTER_RESULT_INVALID');
  ancestors.add(value);
  const result = Array.isArray(value)
    ? Array.from(value, item => item === undefined ? null : finiteJson(item, ancestors, depth + 1))
    : Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, finiteJson(item, ancestors, depth + 1)]));
  ancestors.delete(value);
  return result;
}

function injectedEvidence(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    // Some older collectors infer these flags from successful HTTP-shaped
    // responses even with fetch injection. Fixtures cannot establish live IO.
    if (['liveReplay', 'live_replay', 'httpIndependentLive'].includes(key) && typeof item === 'boolean') value[key] = false;
    else injectedEvidence(item);
  }
}

function runtime(serviceId, actions, options, dispatch) {
  const lifetime = new AbortController();
  const adapters = Object.fromEntries(actions.map(action => [`${serviceId}.${operationName(action)}`, async (input = {}, { signal } = {}) => {
    if (lifetime.signal.aborted) fail('SESSION_CLOSED');
    const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    if (combined.aborted) fail('OPERATION_ABORTED');
    const baseFetch = options.fetchImpl ?? globalThis.fetch;
    const fetchImpl = (url, init = {}) => {
      if (combined.aborted) fail('OPERATION_ABORTED');
      return baseFetch(url, { ...init, signal: init.signal ? AbortSignal.any([combined, init.signal]) : combined });
    };
    try {
      const result = await dispatch(action, input.query ?? {}, { options, fetchImpl, signal: combined });
      if (combined.aborted) fail('OPERATION_ABORTED');
      // A supplied transport can be a local fixture. Never claim it was live.
      const injected = Boolean(options.createFetcher || options.fetchImpl && options.fetchImpl !== globalThis.fetch);
      const output = finiteJson({ ...result, receipt: { ...result.receipt, networkUsed: !injected,
        ...(injected ? { transportEvidence: 'injected_transport_network_not_asserted' } : {}) } });
      if (injected) injectedEvidence(output);
      return output;
    } catch (error) {
      if (combined.aborted) fail('OPERATION_ABORTED');
      if (error?.code === 'ERR_MODULE_NOT_FOUND') fail('DEPENDENCY_MISSING');
      // Error messages, causes, raw headers and provider state never escape.
      fail(typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,80}$/.test(error.code)
        ? error.code : `${serviceId.replaceAll('-', '_').toUpperCase()}_OPERATION_FAILED`);
    }
  }]));
  return { adapters, close() { lifetime.abort(); } };
}
const native = result => ({ data: result, receipt: result.receipt ?? result.metadata ?? {},
  ...(record(result.pageInfo) ? { pageInfo: result.pageInfo } : {}) });

async function storedCredential(serviceId, options, defaultName) {
  if (options.credentialProvider !== undefined) {
    if (typeof options.credentialProvider !== 'function') fail('PROVIDER_INVALID');
    let credential;
    try { credential = await options.credentialProvider(serviceId); }
    catch (error) { fail(error?.code === 'PROVIDER_MISSING' ? 'PROVIDER_MISSING' : 'PROVIDER_FAILED'); }
    if (!record(credential)) fail('PROVIDER_MISSING');
    return credential;
  }
  const { ProtectedStore } = await import('../protected-store.mjs');
  let raw;
  try { raw = (options.store ?? new ProtectedStore({ directory: options.storeDirectory })).read(options.sessionName ?? defaultName); }
  catch (error) {
    fail(['PROTECTED_STORE_PROVIDER_REQUIRED', 'PROTECTED_STORE_PROVIDER_UNSUPPORTED'].includes(error?.code)
      ? 'PROVIDER_MISSING' : 'SESSION_READ_FAILED');
  }
  if (!raw) fail('PROVIDER_MISSING');
  let credential;
  try { credential = JSON.parse(raw); } catch { fail('SESSION_INVALID'); }
  if (!record(credential)) fail('SESSION_INVALID');
  return credential;
}

function agodaAdapters(options = {}) {
  return runtime('agoda', ['campaigns', 'rates'], options, async (action, query, { fetchImpl }) => {
    const { AgodaHotelClient } = await import('../travel/agoda.mjs');
    const client = new AgodaHotelClient({ fetchImpl,
      ...(options.minIntervalMs === undefined ? {} : { minHostIntervalMs: options.minIntervalMs }),
      ...(options.now ? { now: options.now } : {}) });
    return native(await (action === 'campaigns' ? client.campaigns() : client.rates(query)));
  });
}

const marketingReads = ['searchAirports', 'searchAirlines', 'reservations', 'flightReservations',
  'sales', 'salesSummary', 'flightSales', 'flightSalesSummary'];
function myrealtripAdapters(options = {}) {
  return runtime('myrealtrip', ['verify', 'verifyLink', ...marketingReads], options, async (action, query, { fetchImpl, signal }) => {
    const dependencies = { fetchImpl };
    if (action === 'verifyLink') {
      const { verifyMyrealtripLink } = await import('../../service-packs/affiliate/apps/affiliate-api-hub/adapters/myrealtrip-marketing.mjs');
      return native(await verifyMyrealtripLink(query.link, query.expectedTarget, { ...dependencies, expectedLinkId: query.expectedLinkId }));
    }
    // withSession()/ensure() can log in or rotate tokens. Read existing sealed
    // state directly instead, then reuse the existing identity probe/client.
    const credential = await storedCredential('myrealtrip', options, 'myrealtrip-state');
    if (signal.aborted) fail('OPERATION_ABORTED');
    const session = { token: credential.token ?? credential.accessToken,
      expectedPartnerId: credential.expectedPartnerId ?? credential.partnerId,
      expectedEmail: credential.expectedEmail ?? credential.email };
    if (!session.token) fail('SESSION_MISSING');
    try {
      if (action === 'verify') {
        const { probeMyrealtripAccount } = await import('../../service-packs/affiliate/apps/affiliate-api-hub/adapters/partner-account-probes.mjs');
        return native(await probeMyrealtripAccount(session, dependencies));
      }
      const { createMyrealtripClient } = await import('../../service-packs/affiliate/apps/affiliate-api-hub/adapters/myrealtrip-marketing.mjs');
      const client = await createMyrealtripClient(session, dependencies);
      try { return await client.execute(action, query); }
      finally { client.close(); }
    } finally { session.token = ''; }
  });
}

const videoActions = ['amazonAsinDiscovery', 'amazonSearch', 'amazonProductVideos', 'aliexpressSearch', 'aliexpressProductMedia', 'alibaba1688Search', 'alibaba1688OfferMedia'];
function videoAdapters(options = {}) {
  return runtime('video-sources', videoActions, options, async (action, query, { fetchImpl, signal }) => {
    if (action === 'amazonAsinDiscovery') {
      // Separate explicit HTTP action, never a fallback for the CDP readers.
      // ASIN candidates can feed amazon-product-videos later; search does not
      // establish video presence, inspect a PDP or retrieve any media bytes.
      const { createAmazonPublicClient } = await import('../retail/amazon.mjs');
      const result = await createAmazonPublicClient({ fetchImpl }).searchProducts(query);
      return { ...native(result), pageInfo: result.pagination, receipt: { ...result.receipt,
        sourcingStage: 'asin_discovery', videoMetadataFetched: false, videoPresenceVerified: false, mediaDownloaded: false } };
    }
    const settings = { ...(options.minIntervalMs === undefined ? {} : { minIntervalMs: options.minIntervalMs }),
      ...(options.now ? { now: options.now } : {}) };
    if (action === 'aliexpressProductMedia' && query.transport === 'http') {
      const { aliExpressHttpTransport, createAliExpressMediaClient, ALIEXPRESS_SESSION_STORE } = await import('../video-sources/aliexpress-media.mjs');
      const credential = await storedCredential('video-sources', options, ALIEXPRESS_SESSION_STORE);
      if (signal.aborted) fail('OPERATION_ABORTED');
      // Existing HTTP transport, in-memory view only; do not persist rotated cookies.
      const store = { read: () => JSON.stringify(credential) };
      const transport = aliExpressHttpTransport({ store, fetchImpl, persistRotation: false });
      const { transport: ignored, ...input } = query;
      return native(await createAliExpressMediaClient({ ...settings, transport }).getProductMedia(input));
    }
    // An existing automation profile is the source runner's default provider.
    // Optional injected credential has the existing client's cdpEndpoint option.
    let cdpEndpoint = 'http://127.0.0.1:9333';
    if (options.credentialProvider !== undefined) {
      const credential = await storedCredential('video-sources', options);
      if (typeof credential.cdpEndpoint !== 'string') fail('PROVIDER_INVALID');
      cdpEndpoint = credential.cdpEndpoint;
    }
    const { createCdpPageFetcher } = await import('../video-sources/cdp-cookies.mjs');
    const createFetcher = config => (options.createFetcher ?? createCdpPageFetcher)({ ...config, fetchImpl,
      // Unlike the source CLI default, verification may not create a new tab.
      openUrl: undefined });
    Object.assign(settings, { cdpEndpoint, createFetcher });
    if (action === 'amazonSearch' || action === 'amazonProductVideos') {
      const { createAmazonMediaClient } = await import('../video-sources/amazon-media.mjs');
      const client = createAmazonMediaClient(settings);
      return native(await (action === 'amazonSearch' ? client.search(query) : client.productVideos(query)));
    }
    if (action === 'aliexpressSearch') {
      const { createAliExpressSearchClient } = await import('../video-sources/aliexpress-search.mjs');
      return native(await createAliExpressSearchClient(settings).search(query));
    }
    if (action === 'aliexpressProductMedia') {
      const { aliExpressBrowserTransport, createAliExpressMediaClient } = await import('../video-sources/aliexpress-media.mjs');
      const { transport: ignored, ...input } = query;
      return native(await createAliExpressMediaClient({ ...settings, transport: aliExpressBrowserTransport(settings) }).getProductMedia(input));
    }
    const { create1688Client } = await import('../video-sources/alibaba-1688.mjs');
    const client = create1688Client(settings);
    return native(await (action === 'alibaba1688Search' ? client.search(query) : client.offerMedia(query)));
  });
}

function ontologyAdapters(options = {}) {
  return runtime('travel-ontology', ['yanoljaSearch', 'modetourPackages', 'naverOverseasSearch', 'naverOverseasRates'], options,
    async (action, query, { fetchImpl }) => {
      if (action === 'yanoljaSearch') {
        const { searchYanoljaAccommodation } = await import('../../service-packs/ontology/src/travel-price/seller-adapters/yanolja-search.mjs');
        return native(await searchYanoljaAccommodation({ ...query, fetchImpl }));
      }
      if (action === 'modetourPackages') {
        const { collectModetourLive } = await import('../../service-packs/ontology/src/travel-price/seller-adapters/modetour.mjs');
        const maxProductsPerDestination = query.maxProductsPerDestination ?? 0;
        const result = await collectModetourLive({ ...query, maxProductsPerDestination,
          requestBudget: 2 + maxProductsPerDestination, fetchImpl,
          ...(options.minIntervalMs === undefined ? {} : { minIntervalMs: options.minIntervalMs }) });
        if (!['usable_limited', 'list_only', 'empty_result'].includes(result.verdict)) {
          fail(result.verdict === 'challenge_blocked' ? 'MODETOUR_CHALLENGE_REQUIRED'
            : result.verdict === 'anonymous_context_unavailable' ? 'MODETOUR_CONTEXT_UNAVAILABLE' : 'MODETOUR_LIVE_READ_FAILED');
        }
        // A list-only read is not a completed detail replay. Keep fiveStates,
        // unknown price basis/currency, dates and limited-feed scope intact.
        return native(result);
      }
      const { NaverOverseasHotelClient } = await import('../../service-packs/ontology/src/travel-price/seller-adapters/naver-overseas-hotel.mjs');
      const client = new NaverOverseasHotelClient({ fetchImpl,
        ...(options.minIntervalMs === undefined ? {} : { minHostIntervalMs: options.minIntervalMs }) });
      return native(await (action === 'naverOverseasSearch' ? client.search(query) : client.rates(query)));
    });
}

const stay = { checkIn: text(true, 10), checkOut: text(true, 10), adultCnt: integer(1, 9),
  childAges: array({ type: 'integer', minimum: 0, maximum: 17 }, 0, 8, []) };
const dateRange = { startDate: text(true, 10), endDate: text(true, 10) };
const salesRange = { fromDate: text(true, 10), toDate: text(true, 10) };
const filterValues = () => array({ type: 'json' }, 0, 30, []);

export const definitions = [
  {
    id: 'agoda', title: 'Agoda anonymous hotel reads',
    profile: profile('agoda', {
      campaigns: read('agoda.campaigns', `${agodaSource} AgodaHotelClient.campaigns(); scripts/agoda.mjs campaigns`,
        'Read public display-only campaign cards (bootstrap GET + observed POST; no coupon activation).'),
      rates: read('agoda.rates', `${agodaSource} AgodaHotelClient.rates(); lib/travel/contracts/agoda/public-request-template.json`,
        'Read rates for observed properties and caller-supplied dates; 2 adults, 0 children, 1 room, KRW only.', {
          checkIn: text(true, 10), checkOut: text(true, 10),
          propertyIds: { ...array({ type: 'integer', minimum: 1 }, 1, 16), required: false },
          adults: { type: 'integer', enum: [2], default: 2 }, children: { type: 'integer', enum: [0], default: 0 },
          rooms: { type: 'integer', enum: [1], default: 1 }, currency: { type: 'string', enum: ['KRW'], default: 'KRW' },
        }),
    }),
    verificationChecks: [{ operation: 'campaigns', input: {}, kind: 'live_read' }],
    createAdapters: agodaAdapters,
  },
  {
    id: 'myrealtrip', title: 'MyRealTrip stored-session reads and verification',
    profile: profile('myrealtrip', {
      verify: read('myrealtrip.verify', `${probeSource} probeMyrealtripAccount(); lib/web-auth/myrealtrip.mjs stored myrealtrip-state`,
        'Check stored-session owner with one GET; no ensure, refresh, login or raw account output.'),
      verifyLink: read('myrealtrip.verifyLink', `${marketingSource} verifyMyrealtripLink()`,
        'Read an existing short-link redirect without credentials or following it; verify target and attribution.', {
          link: text(true, 4096), expectedTarget: text(true, 4096), expectedLinkId: integer(1, Number.MAX_SAFE_INTEGER),
        }),
      ...Object.fromEntries(marketingReads.map(action => [action, read(`myrealtrip.${action}`,
        `${marketingSource} MYREALTRIP_OPERATIONS.${action}; createMyrealtripClient().execute('${action}', input)`,
        `Read ${action} through the existing owner-checked client; no session renewal; source sanitization retained.`,
        action === 'searchAirports' || action === 'searchAirlines' ? { keyword: text() }
          : action === 'reservations' ? { ...dateRange, page: integer(1, 10000, 1) }
            : action === 'flightReservations' ? dateRange : salesRange)])),
    }),
    verificationChecks: [{ operation: 'verify', input: {}, kind: 'live_read' }],
    createAdapters: myrealtripAdapters,
  },
  {
    id: 'video-sources', title: 'Video source metadata and public search (no downloads)', checklistIds: ['video-sources'],
    profile: profile('video-sources', {
      amazonAsinDiscovery: read('video-sources.amazonAsinDiscovery', 'lib/retail/amazon.mjs createAmazonPublicClient().searchProducts(); lib/video-sources/amazon-media.mjs productVideos({asin})',
        'One anonymous HTTP streaming search for ASIN candidates; no browser, video inspection or video-presence proof. Candidates can feed amazon-product-videos separately.', {
          query: text(true, 120), page: integer(1, 20, 1),
        }),
      amazonSearch: read('video-sources.amazonSearch', 'lib/video-sources/amazon-media.mjs createAmazonMediaClient().search(); references/video-sources.md',
        'CDP only: one public Amazon search document through an existing first-party tab; no implicit HTTP fallback.', { keyword: text(true, 120) }),
      amazonProductVideos: read('video-sources.amazonProductVideos', 'lib/video-sources/amazon-media.mjs createAmazonMediaClient().productVideos()',
        'CDP only, existing Amazon tab required: read video metadata; seller/vendor uploads by default; no HLS/MP4 downloads.', {
          asin: text(true, 10), includeCreator: { type: 'boolean', default: false },
        }),
      aliexpressSearch: read('video-sources.aliexpressSearch', 'lib/video-sources/aliexpress-search.mjs createAliExpressSearchClient().search()',
        'Read public KR storefront cards with source price/currency through an existing tab.', { keyword: text(true, 120) }),
      aliexpressProductMedia: read('video-sources.aliexpressProductMedia', 'lib/video-sources/aliexpress-media.mjs createAliExpressMediaClient().getProductMedia(); scripts/video-sources.mjs',
        'Read seller video and image metadata; existing tab or stored HTTP cookies; never persist rotation.', {
          productId: text(true, 20), transport: { type: 'string', enum: ['browser', 'http'], default: 'browser' },
          locale: { type: 'string', default: 'ko_KR' }, currency: { type: 'string', default: 'KRW' }, country: { type: 'string', default: 'KR' },
        }),
      alibaba1688Search: read('video-sources.alibaba1688Search', 'lib/video-sources/alibaba-1688.mjs create1688Client().search()',
        'Read one source page (60 offers); preserve decimal CNY strings; existing tab required.', {
          keyword: text(true, 60), page: integer(1, 50, 1),
        }),
      alibaba1688OfferMedia: read('video-sources.alibaba1688OfferMedia', 'lib/video-sources/alibaba-1688.mjs create1688Client().offerMedia()',
        'Read an observed offer document for seller video metadata; no media downloads.', { offerId: text(true, 15) }),
    }),
    // This exact keyword is an existing source-backed CLI example, not an ID guess.
    verificationChecks: [{ operation: 'amazon-asin-discovery', input: { query: { query: 'folding piano keyboard', page: 1 } }, kind: 'live_read' }],
    createAdapters: videoAdapters,
  },
  {
    id: 'travel-ontology', title: 'Travel ontology public seller reads', checklistIds: ['ontology-modetour'],
    profile: profile('travel-ontology', {
      yanoljaSearch: read('travel-ontology.yanoljaSearch', `${ontologySource}yanolja-search.mjs searchYanoljaAccommodation()`,
        'One q-only anonymous document; source dates/occupancy are observed context, not caller filters; jsdom required.', { keyword: text(true, 50) }),
      modetourPackages: read('travel-ontology.modetourPackages', `${ontologySource}modetour.mjs collectModetourLive(); service-packs/ontology/src/travel-price/collect-live.mjs`,
        'Read a limited recommendation feed, not full inventory. Two reads by default; at most one observed detail (three reads).', {
          destination: { type: 'string', minLength: 1, maxLength: 80, default: '다낭' },
          maxProductsPerDestination: integer(0, 1, 0),
        }),
      naverOverseasSearch: read('travel-ontology.naverOverseasSearch', `${ontologySource}naver-overseas-hotel.mjs NaverOverseasHotelClient.search()`,
        'One observed overseasHotelList GraphQL read; caller supplies destination/place/date context; listing only.', {
          query: text(true, 80), placeId: text(true, 16), ...stay,
          from: integer(0, 2000, 0), size: { type: 'integer', enum: [20], default: 20 },
          sort: { type: 'string', enum: ['RELEVANCE_DESC'], default: 'RELEVANCE_DESC' },
          includeRecommendedBnb: { type: 'boolean', enum: [true], default: true },
          accommodationTypeIds: filterValues(), chainIds: filterValues(), facilityIds: filterValues(), starRatings: filterValues(),
          priceRangeKey: { type: 'string', enum: ['PRICE_AVG'], default: 'PRICE_AVG' }, deviceType: { type: 'string', enum: ['PC'], default: 'PC' },
        }),
      naverOverseasRates: read('travel-ontology.naverOverseasRates', `${ontologySource}naver-overseas-hotel.mjs NaverOverseasHotelClient.rates()`,
        'One observed rates read for caller-supplied listing hotel IDs; preserve local currency and tax/checkout caveats.', {
          query: text(true, 80), nPlaceId: text(true, 80), ...stay,
          xbuIds: array({ type: 'string', minLength: 1, maxLength: 20 }, 1, 20),
          impArea: { type: 'string', enum: ['renewalMulti'], default: 'renewalMulti' }, includeTax: { type: 'boolean', enum: [true], default: true },
        }),
    }),
    // Existing runner default destination, no invented product/place IDs or dates.
    verificationChecks: [{ operation: 'modetour-packages', input: { query: { destination: '다낭', maxProductsPerDestination: 0 } }, kind: 'live_read' }],
    createAdapters: ontologyAdapters,
  },
];
