import { createHash } from 'node:crypto';
const ORIGIN = 'https://www.amazon.com';
const ASIN = /^[A-Z0-9]{10}$/;
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = () => { throw Object.assign(new Error(), { code: 'AMAZON_ONTOLOGY_INPUT_INVALID' }); };
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

function minor(price) {
  if (!price || price.currencyVerified !== true || !['KRW', 'USD', 'EUR', 'GBP', 'JPY'].includes(price.currencyCode)) return null;
  if (typeof price.amount !== 'string' || !/^\d{1,12}(?:\.\d{1,3})?$/.test(price.amount)) fail();
  const places = ['KRW', 'JPY'].includes(price.currencyCode) ? 0 : 2;
  const [whole, fraction = ''] = price.amount.split('.');
  if (/[^0]/.test(fraction.slice(places))) return null;
  const amount = Number(whole) * 10 ** places + Number(fraction.slice(0, places).padEnd(places, '0'));
  if (!Number.isSafeInteger(amount)) fail();
  return amount;
}

/** Local projection of verified saved HTTP runs; does not fetch or write to a DB. */
export function projectAmazonRetail(runs) {
  if (!Array.isArray(runs) || !runs.length || runs.length > 100) fail();
  const offerings = new Map(), offers = new Map(), evidence = new Map(), variants = new Map();
  const detailAsins = new Set(), searchAsins = new Set();
  const searchPages = [];
  let observedAt = null;
  function addEvidence(receipt, kind, asin = null) {
    if (!receipt || receipt.origin !== ORIGIN || receipt.httpStatus !== 200 || receipt.browserUsed !== false
      || receipt.readOnly !== true || receipt.schemaVerified !== true || receipt.expectedResultVerified !== true
      || !time(receipt.checkedAt) || !/^[a-f0-9]{64}$/.test(receipt.responseSha256 ?? '')
      || !Number.isInteger(receipt.responseBytes) || receipt.responseBytes <= 0) fail();
    if (kind === 'product' ? receipt.path !== `/-/ko/dp/${asin}/` || receipt.method !== 'GET' || receipt.mime !== 'text/html'
      || receipt.credentialsUsed !== true || receipt.cookieSent !== true || receipt.cookieHeaderMatchedOnWire !== true
      || receipt.credentialPropagated !== true || receipt.sessionPersisted !== true || receipt.authenticationVerified !== false
      : receipt.path !== '/s/query' || receipt.method !== 'POST' || receipt.mime !== 'application/json-amazonui-streaming'
        || receipt.credentialsUsed !== false || receipt.cookieSent !== false) fail();
    const id = `http:${sha(JSON.stringify(receipt))}`;
    evidence.set(id, { id, sourceId: 'amazon', ...receipt });
    if (observedAt === null || Date.parse(receipt.checkedAt) > Date.parse(observedAt)) observedAt = receipt.checkedAt;
    return id;
  }
  function addProduct(row, receipt, detail) {
    if (!ASIN.test(row?.asin ?? '') || typeof row.title !== 'string' || !row.title.trim() || row.title.length > 2000) fail();
    const asin = row.asin, id = `amazon:${asin}`, evidenceRef = addEvidence(receipt, detail ? 'product' : 'search', asin);
    if (![`https://www.amazon.com/dp/${asin}`, `https://www.amazon.com/-/ko/dp/${asin}/`].includes(row.productUrl)) fail();
    const images = detail ? row.images?.map(i => i.url) : row.thumbnailUrl ? [row.thumbnailUrl] : [];
    if (!Array.isArray(images) || images.some(url => {
      try { const u = new URL(url); return u.origin !== 'https://m.media-amazon.com' || !u.pathname.startsWith('/images/I/') || u.username || u.password || u.search || u.hash; }
      catch { return true; }
    })) fail();
    const previous = offerings.get(id);
    if (!previous || detail || !detailAsins.has(asin)) offerings.set(id, {
      id, consumerSourceId: 'amazon', sourceLocalId: asin, offeringType: 'RetailProduct', title: row.title,
      canonicalUrl: `${ORIGIN}/dp/${asin}`, brand: null, brandDisplayText: detail ? row.brandDisplayText : null,
      description: detail ? row.description : null, features: detail ? row.features : [],
      specifications: detail ? row.specifications : [], images, imagesAreCompleteGallery: false,
      evidenceRef, evidenceRefs: [...new Set([...(previous?.evidenceRefs ?? []), evidenceRef])],
    });
    else if (!previous.evidenceRefs.includes(evidenceRef)) previous.evidenceRefs.push(evidenceRef);
    const price = detail ? row.displayedPrice : row.currentDisplayPrice;
    const amountMinor = minor(price);
    if (amountMinor !== null) {
      const offerId = `${id}:${receipt.checkedAt}:${detail ? 'product' : 'search'}`;
      offers.set(offerId, { id: offerId, sourceId: 'amazon', offeringId: id, amountMinor,
        currency: price.currencyCode, listAmountMinor: null, referencePriceDisplay: detail ? row.displayedReferencePrice?.displayText ?? null : row.struckDisplayPrice?.displayText ?? null,
        shippingAmountMinor: null, discountCondition: null, availability: detail ? row.availability?.status ?? 'unknown' : 'unknown',
        observedAt: receipt.checkedAt, validUntil: null, externalProductId: asin, externalSkuId: null,
        marketplace: 'amazon.com', shipToCountry: null, shipsFromCountry: null,
        importDutyMinor: null, importTaxMinor: null, landedCostMinor: null, landedCostKrwMinor: null, fxRateId: null,
        priceBasis: detail ? 'displayed_product_page' : 'displayed_search_card', checkoutPriceVerified: false, evidenceRef });
    }
    if (detail) {
      if (row.coverage?.identityVerified !== true || row.coverage?.optionOffersVerified !== false
        || row.coverage?.completeGallery !== false || !Array.isArray(row.dimensions)) fail();
      detailAsins.add(asin);
      for (const group of row.dimensions) {
        if (!/^[a-z_]{1,80}$/.test(group.dimension ?? '') || !Array.isArray(group.choices)) fail();
        for (const choice of group.choices) {
          if (!ASIN.test(choice.asin ?? '') || typeof choice.label !== 'string' || !choice.label
            || choice.priceVerified !== false || choice.stockVerified !== false || choice.selected !== (choice.asin === asin)) fail();
          const variantId = `${id}:${group.dimension}:${choice.asin}`;
          variants.set(variantId, { id: variantId, offeringId: id, sourceLocalId: choice.asin, dimension: group.dimension,
            label: choice.label, selected: choice.selected, priceVerified: false, stockVerified: false,
            relatedOfferingId: null, evidenceRef });
        }
      }
    } else searchAsins.add(asin);
  }
  for (const run of runs) {
    if (run?.schema !== 'web-api-retail-result-v1' || run.service !== 'amazon' || run.ok !== true
      || run.executionMode !== 'pure_http' || run.browserUsed !== false) fail();
    if (run.operation === 'product') {
      if (run.credentialsUsed !== true || run.anonymous !== false) fail();
      addProduct(run.data, run.data.receipt, true);
    } else if (['search', 'crawl'].includes(run.operation)) {
      if (run.credentialsUsed !== false || run.anonymous !== true) fail();
      const pages = run.operation === 'search' ? [run.data] : run.data?.pages;
      if (!Array.isArray(pages) || !pages.length || run.data.failure) fail();
      for (const page of pages) {
        if (!Array.isArray(page.items) || !page.items.length || typeof page.mainResultFrameCountMatched !== 'boolean'
          || page.mainResultFrameCountMatched === false && page.partial !== true
          || !Number.isInteger(page.page) || page.page < 1 || page.page > 20 || typeof page.query !== 'string') fail();
        const evidenceRef = addEvidence(page.receipt, 'search');
        searchPages.push({ query: page.query, page: page.page, itemCount: page.items.length, partial: page.partial,
          mainResultFrameCountMatched: page.mainResultFrameCountMatched, namedResultFrameCount: page.namedResultFrameCount,
          observedAsinCount: page.observedAsinCount, allAsinsOnPageCovered: page.allAsinsOnPageCovered,
          nextPage: page.pagination?.nextPage ?? null, terminationVerified: page.pagination?.terminationVerified === true, evidenceRef });
        for (const row of page.items) addProduct(row, page.receipt, false);
      }
    } else fail();
  }
  for (const variant of variants.values()) if (offerings.has(`amazon:${variant.sourceLocalId}`)) variant.relatedOfferingId = `amazon:${variant.sourceLocalId}`;
  return { schema: 'web-api-cps-commerce-projection-v1', ontologyId: 'acada:cps-commerce', sourceId: 'amazon',
    networkUsed: false, databaseWrites: 0, observedAt, completeCatalog: false,
    consumerSources: [{ sourceId: 'amazon', origin: ORIGIN, contractState: 'verified_bounded_http',
      scope: 'main_search_cards_and_observed_product_documents', contractEvidence: [...evidence.values()] }],
    coverage: { uniqueSearchProducts: searchAsins.size, productDetailsRead: detailAsins.size, searchPages,
      allOptionOffersVerified: false, reviewCollectionVerified: false, sessionRenewalVerified: false },
    offerings: [...offerings.values()], offers: [...offers.values()], variants: [...variants.values()], identityCandidates: [], reviews: [] };
}
