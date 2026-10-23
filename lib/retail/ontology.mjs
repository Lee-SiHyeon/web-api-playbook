import { createHash } from 'node:crypto';

const sha = value => createHash('sha256').update(value).digest('hex');
const fail = () => { throw Object.assign(new Error(), { code: 'ONTOLOGY_INPUT_INVALID' }); };
const id = value => typeof value === 'string' && /^\d{1,20}$/.test(value);

// This projection currently accepts the observed KRW cards only. Never round
// fractional won or infer a currency from a locale or a displayed symbol.
export function krwMinor(price) {
  if (!price || price.currency !== 'KRW' || price.currencyVerified !== true
    || typeof price.amount !== 'string' || !/^\d{1,12}(?:\.0{1,4})?$/.test(price.amount)) fail();
  return Number(price.amount);
}

/** Project a verified CLI result into acada:cps-commerce fields without DB writes. */
export function projectOverseasRetail(run) {
  if (run?.schema !== 'web-api-overseas-retail-result-v1' || run.ok !== true
    || run.executionMode !== 'pure_http' || run.browserUsed !== false || run.credentialsUsed !== false
    || run.anonymous !== true || run.writesSubmitted !== 0 || !Number.isFinite(Date.parse(run.checkedAt))) fail();
  const sourceId = run.service;
  if (!['shein', 'iherb'].includes(sourceId)) fail();
  const expectedOrigin = sourceId === 'shein' ? 'https://kr.shein.com' : 'https://www.iherb.com';
  const request = run.requests?.at(-1);
  if (request?.origin !== expectedOrigin || request.method !== 'GET' || request.httpStatus !== 200
    || request.cookieSent !== false || request.credentialsUsed !== false
    || (sourceId === 'shein' ? request.path !== '/' : !/^\/sitemaps\/products-[\w-]+\.xml$/.test(request.path))) fail();
  const rows = sourceId === 'shein' ? run.data?.products : run.data?.items;
  if (!Array.isArray(rows) || !rows.length || rows.some(row => !id(row?.externalProductId))
    || new Set(rows.map(row => row.externalProductId)).size !== rows.length) fail();
  const evidence = { id: `http:${sha(JSON.stringify(request))}`, sourceId, requestMethod: 'GET', requestUrl: request.origin + request.path,
    responseStatus: request.httpStatus, contentType: request.mime, responseSha256: null,
    observedAt: run.checkedAt, browserUsed: false, cookiesSent: false, authorizationSent: false,
    projectionSha256: sha(JSON.stringify(run.data)),
    pagination: { pagesRead: 1, nextPageCandidate: run.data.frontier?.next ?? null,
      complete: false, stopReason: sourceId === 'shein' ? 'home_cards_only' : 'bounded_identity_sample' } };
  const result = { schema: 'web-api-cps-commerce-projection-v1', ontologyId: 'acada:cps-commerce',
    networkUsed: false, databaseWrites: 0, sourceId, observedAt: run.checkedAt, completeCatalog: false,
    consumerSources: [{ sourceId, origin: expectedOrigin, contractState: 'verified_public_http',
      scope: sourceId === 'shein' ? 'home_cards_and_displayed_prices' : 'sitemap_identities_only', contractEvidence: [evidence] }],
    offerings: [], offers: [], identityCandidates: [], variants: [], reviews: [] };
  if (sourceId === 'iherb') {
    if (run.data.priceVerified !== false || run.data.completeCatalog !== false) fail();
    result.identityCandidates = rows.map(row => {
      if (row.source !== 'iherb' || !/^[a-z0-9-]{1,200}$/.test(row.slug ?? '')
        || row.url !== `https://www.iherb.com/pr/${row.slug}/${row.externalProductId}`) fail();
      return { consumerSourceId: sourceId, sourceLocalId: row.externalProductId, canonicalUrl: row.url,
        title: null, state: 'needs_product_detail', evidenceRef: evidence.id };
    });
    return result;
  }
  if (run.data.context?.currency !== 'KRW' || run.data.coverage?.completeCatalog !== false) fail();
  for (const row of rows) {
    if (typeof row.title !== 'string' || !row.title.trim() || row.title.length > 1500
      || row.productUrl !== null || row.options !== null || row.stock !== null
      || row.salePrice?.basis !== 'displayed_home_card') fail();
    if (row.imageUrl !== null) {
      let image;
      try { image = new URL(row.imageUrl); } catch { fail(); }
      if (image.origin !== 'https://img.ltwebstatic.com' || image.search || image.hash || image.username || image.password) fail();
    }
    const offeringId = `${sourceId}:${row.externalProductId}`;
    result.offerings.push({ id: offeringId, consumerSourceId: sourceId, sourceLocalId: row.externalProductId,
      offeringType: 'RetailProduct', title: row.title, brand: null, description: null,
      canonicalUrl: null, images: row.imageUrl === null ? [] : [row.imageUrl], evidenceRef: evidence.id });
    result.offers.push({ id: `${offeringId}:${run.checkedAt}`, sourceId, offeringId,
      amountMinor: krwMinor(row.salePrice), currency: 'KRW',
      listAmountMinor: row.retailPrice === null ? null : krwMinor(row.retailPrice),
      shippingAmountMinor: null, discountCondition: null, availability: 'unknown', observedAt: run.checkedAt,
      validUntil: null, externalProductId: row.externalProductId, externalSkuId: null,
      marketplace: 'kr.shein.com', shipToCountry: null, shipsFromCountry: null,
      importDutyMinor: null, importTaxMinor: null, landedCostMinor: null, landedCostKrwMinor: null, fxRateId: null,
      priceBasis: 'displayed_home_card', evidenceRef: evidence.id });
  }
  return result;
}
