import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { decimalString, decimalToMinor, isSupportedCurrency, observedCount, observedNumber } from './cps-values.mjs';

const hash = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
const text = (value, limit = 2000) => typeof value === 'string' && value.trim() ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit) : null;
const first = (...values) => values.find(value => value !== null && value !== undefined) ?? null;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const secretKey = /token|auth|session|password|secret|csrf|email|phone|account|credential|inventoryRateKey|api.?key|private.?key/i;
const availability = value => ({ instock: 'in_stock', outofstock: 'out_of_stock', soldout: 'out_of_stock', preorder: 'preorder', backorder: 'backorder', in_stock: 'in_stock', out_of_stock: 'out_of_stock' })[String(value ?? '').replace(/^https?:\/\/schema.org\//, '').toLowerCase()] ?? 'unknown';

export function publicEvidenceUrl(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (secretKey.test(key)) url.searchParams.set(key, 'REDACTED');
    return url.href;
  } catch { return null; }
}

function safeMetadata(value, depth = 0) {
  if (depth > 18) return null;
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return /^https?:\/\//i.test(value) ? publicEvidenceUrl(value) : text(value, 4000);
  if (Array.isArray(value)) return value.slice(0, 1000).map(row => safeMetadata(row, depth + 1));
  if (typeof value !== 'object') return null;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !secretKey.test(key)
    || ['authorizationSent', 'cookiesSent', 'credentialsRequired', 'credentialsUsed', 'issuedWithoutAccount'].includes(key)).map(([key, child]) => [key, safeMetadata(child, depth + 1)]));
}

const subtype = raw => {
  const name = String(raw ?? '').replace(/^https?:\/\/schema.org\//, '').toLowerCase();
  if (['retailproduct', 'product', 'productgroup', 'book', 'individualproduct'].includes(name)) return 'RetailProduct';
  if (['traveloffering', 'travelactivity', 'hotel', 'lodgingbusiness', 'touristtrip', 'trip', 'flight', 'touristdestination', 'vehicle', 'rentalcar', 'travelpackage'].includes(name)) return 'TravelOffering';
  if (['serviceoffering', 'service', 'professionalservice', 'subscription', 'softwareapplication', 'mobileapplication'].includes(name)) return 'ServiceOffering';
  if (['digitalcontent', 'digitalpublication', 'course', 'creativework', 'videogame', 'comicstory', 'tvseries', 'bookseries', 'comicseries', 'webtoon', 'webtoonseries'].includes(name)) return 'DigitalContent';
  return 'UnclassifiedOffering';
};

export function loadReverificationBatches(directory) {
  return readdirSync(directory).filter(name => /^batch-\d{2}\.json$/.test(name)).sort().map(name => ({
    filename: name,
    ...JSON.parse(readFileSync(path.join(directory, name), 'utf8').replace(/^\uFEFF/, '')),
  }));
}

function normalizeReceipt(raw, sourceId, merchantId, index) {
  const originalId = first(raw.id, raw.receiptId, `${merchantId}:receipt:${index}`);
  const id = `receipt:${hash(`${sourceId}|${originalId}`)}`;
  const requestUrl = publicEvidenceUrl(first(raw.requestUrl, raw.requestedUrl, raw.url, raw.finalUrl));
  const finalUrl = publicEvidenceUrl(first(raw.finalUrl, raw.url, raw.requestUrl));
  return {
    id, type: 'EvidenceReceipt', sourceId, originalId: String(originalId),
    requestMethod: first(raw.requestMethod, raw.method, 'GET'), requestUrl, finalUrl,
    responseStatus: observedCount(first(raw.responseStatus, raw.httpStatus, raw.status)),
    contentType: text(first(raw.contentType, raw.mime), 200),
    responseSha256: /^[a-f0-9]{64}$/i.test(first(raw.responseSha256, raw.sha256) ?? '') ? first(raw.responseSha256, raw.sha256).toLowerCase() : null,
    responseBytes: observedCount(first(raw.bytes, raw.responseBytes)),
    observedAt: iso(first(raw.observedAt, raw.checkedAt)),
    browserUsed: typeof raw.browserUsed === 'boolean' ? raw.browserUsed : null,
    cookiesSent: typeof raw.cookiesSent === 'boolean' ? raw.cookiesSent : null,
    authorizationSent: typeof raw.authorizationSent === 'boolean' ? raw.authorizationSent : null,
    authenticationMode: raw.authenticationMode === 'protected_first_party_session' ? raw.authenticationMode : null,
    credentialProvider: raw.credentialProvider === 'windows_dpapi' ? raw.credentialProvider : null,
    ownerReadbackVerified: raw.ownerReadbackVerified === true,
    publicRequestTokenSent: typeof raw.publicRequestTokenSent === 'boolean' ? raw.publicRequestTokenSent : null,
    publicClientHeaderSent: typeof raw.publicClientHeaderSent === 'boolean' ? raw.publicClientHeaderSent : null,
    anonymousBootstrap: safeMetadata(raw.anonymousBootstrap),
    bootstrapReceiptId: raw.bootstrapReceiptId ? `receipt:${hash(`${sourceId}|${raw.bootstrapReceiptId}`)}` : null,
    publicClientConfigReceiptId: first(raw.publicClientConfigReceiptId, raw.configSourceReceiptId, raw.configReceiptId) ? `receipt:${hash(`${sourceId}|${first(raw.publicClientConfigReceiptId, raw.configSourceReceiptId, raw.configReceiptId)}`)}` : null,
    secureTransport: requestUrl ? new URL(requestUrl).protocol === 'https:' && (!finalUrl || new URL(finalUrl).protocol === 'https:') : null,
    stopReason: text(first(raw.stopReason, raw.errorCode, raw.error), 250),
  };
}

const publicReplay = receipt => receipt && receipt.responseStatus >= 200 && receipt.responseStatus < 300
  && receipt.browserUsed === false && receipt.cookiesSent === false && receipt.authorizationSent === false
  && !receipt.stopReason && Boolean(receipt.responseSha256 && receipt.observedAt && receipt.requestUrl);

// This is the user's maintained, owner-checked web catalog, a distinct origin
// from the rejected public www.coupang.com search. No other authenticated path
// is admitted by this policy and session values never enter the dataset.
const protectedCatalogReplay = receipt => {
  if (!receipt || receipt.sourceId !== 'coupang' || receipt.authenticationMode !== 'protected_first_party_session'
    || receipt.credentialProvider !== 'windows_dpapi' || receipt.ownerReadbackVerified !== true
    || receipt.browserUsed !== false || ![receipt.cookiesSent, receipt.authorizationSent].includes(true)
    || receipt.cookiesSent === null || receipt.authorizationSent === null || receipt.responseStatus !== 200
    || receipt.stopReason || !receipt.responseSha256 || !receipt.observedAt || !receipt.requestUrl) return false;
  const url = new URL(receipt.requestUrl);
  return url.origin === 'https://partners.coupang.com' && url.pathname === '/api/v1/search'
    && receipt.requestMethod === 'POST' && (!receipt.finalUrl || receipt.finalUrl === receipt.requestUrl);
};
const verifiedReplay = receipt => publicReplay(receipt) || protectedCatalogReplay(receipt);

function normalizePrice(price, record) {
  if (price == null) return null;
  if (typeof price !== 'object') price = { amount: price };
  const amount = decimalString(first(price.amount, price.price));
  const rawCurrency = text(first(price.currency, price.priceCurrency), 30)?.toUpperCase();
  const currency = isSupportedCurrency(rawCurrency) ? rawCurrency : null;
  const amountMinor = decimalToMinor(amount, currency);
  const low = decimalString(first(price.lowAmount, price.lowPrice));
  const high = decimalString(first(price.highAmount, price.highPrice));
  const listAmount = decimalString(first(price.listAmount, price.listPrice));
  const priceText = text(first(price.priceText, record.priceText), 1500);
  const sourceOfferType = text(first(price.sourceOfferType, price.type), 120);
  const explicitKind = text(first(price.priceKind, price.kind, sourceOfferType), 120);
  const priceRole = /adjustment|discount_amount|coupon_amount/i.test(explicitKind ?? '') ? 'adjustment'
    : /^(?:Original(?:Sale)?Price|ObservedListPrice|PortalOriginPrice|original_price|list_price|crossed_list_price|reference_price|regularPrice)$/i.test(explicitKind ?? '') ? 'reference'
      : /^(?:customerPrice|source_secondary_metric)$/i.test(explicitKind ?? '') ? 'source_secondary_price' : 'quoted_price';
  if (amount == null && low == null && high == null && listAmount == null && priceText == null) return null;
  return {
    amount, amountMinor, currency, priceText, sourceCurrencyText: currency === null ? rawCurrency ?? null : null,
    lowAmount: low, highAmount: high,
    lowAmountMinor: decimalToMinor(low, currency), highAmountMinor: decimalToMinor(high, currency),
    priceKind: explicitKind ?? (low != null || high != null ? 'range' : 'displayed'), sourceOfferType, priceRole,
    billingPeriod: text(first(price.billingPeriod, price.unit, price.unitText), 250),
    discountCondition: text(first(price.discountCondition, price.condition, price.conditions, record.priceCondition), 2000),
    conditions: safeMetadata(first(price.conditions, price.condition, record.priceCondition)),
    qualifiers: safeMetadata(first(price.qualifiers, record.priceQualifiers)),
    sellerName: text(first(price.sellerName, price.seller), 300),
    offerUrl: publicEvidenceUrl(price.url),
    validFrom: text(price.validFrom, 80),
    listAmount, listAmountMinor: decimalToMinor(listAmount, currency),
    availability: availability(first(price.availability, record.availability)),
    validUntil: text(first(price.validUntil, price.priceValidUntil), 80),
  };
}

/** Build a portable, evidence-linked graph. No network or authentication is used. */
export function buildOntologyDataset({ sourceMap, crosswalk, batches, generatedAt = new Date().toISOString() }) {
  if (!Array.isArray(sourceMap?.merchants) || !Array.isArray(batches)) throw new Error('CPS_DATASET_INPUT_INVALID');
  const rawById = new Map();
  for (const batch of batches) for (const report of batch.merchants ?? []) {
    if (rawById.has(report.merchantId)) throw new Error(`DUPLICATE_MERCHANT_REPORT:${report.merchantId}`);
    rawById.set(report.merchantId, { ...report, batchId: batch.batchId, checkedAt: report.checkedAt ?? batch.checkedAt });
  }
  const knownIds = new Set(sourceMap.merchants.map(row => row.affiliateProgram.merchantId));
  for (const id of rawById.keys()) if (!knownIds.has(id)) throw new Error(`UNKNOWN_MERCHANT_REPORT:${id}`);
  const mappingById = new Map((crosswalk?.mappings ?? []).map(row => [row.merchantId, row]));
  const collections = Object.fromEntries(['affiliatePrograms', 'consumerSources', 'commercialOfferings', 'productVariants', 'offerObservations', 'ratingAggregates', 'reviewObservations', 'evidenceReceipts', 'fieldEvidence', 'capabilityAssessments'].map(name => [name, new Map()]));
  const relations = new Map();
  const put = (collection, entity) => {
    if (!collections[collection].has(entity.id)) collections[collection].set(entity.id, entity);
    return collections[collection].get(entity.id);
  };
  const relate = (subject, predicate, object) => {
    const id = `relation:${hash(`${subject}|${predicate}|${object}`)}`;
    relations.set(id, { id, subject, predicate, object });
  };
  const coverage = [];
  const quarantine = [];
  for (const mapped of sourceMap.merchants) {
    const program = mapped.affiliateProgram;
    const merchantId = program.merchantId;
    const report = rawById.get(merchantId);
    const mapping = mappingById.get(merchantId);
    const sourceId = mapping?.consumerSourceId ?? `linkprice-consumer:${merchantId}`;
    put('affiliatePrograms', { ...program, type: 'AffiliateProgram' });
    const source = put('consumerSources', {
      id: sourceId, type: 'ConsumerSource', sourceId,
      siteUrl: publicEvidenceUrl(program.siteUrl),
      mappingState: mapping ? 'explicit_merchant_id_crosswalk' : 'merchant_scoped_source_identity',
      classificationHint: program.verticalClassification ?? null,
      affiliateProgramIds: [], contractEvidence: [],
    });
    source.affiliateProgramIds.push(program.id);
    relate(program.id, 'targetsConsumerSource', sourceId);
    const receiptMap = new Map();
    for (const [index, raw] of (report?.receipts ?? []).entries()) {
      const normalized = normalizeReceipt(raw, sourceId, merchantId, index);
      receiptMap.set(normalized.originalId, normalized);
      // Alias legacy IDs, but never fabricate evidence for an unrecorded request.
      if (raw.id) receiptMap.set(String(raw.id), normalized);
      if (raw.receiptId) receiptMap.set(String(raw.receiptId), normalized);
      put('evidenceReceipts', normalized);
      if (normalized.bootstrapReceiptId) relate(normalized.id, 'bootstrappedFrom', normalized.bootstrapReceiptId);
      if (normalized.publicClientConfigReceiptId) relate(normalized.id, 'configuredFrom', normalized.publicClientConfigReceiptId);
      source.contractEvidence.push(normalized.id);
    }
    const counts = { offerings: 0, variants: 0, prices: 0, priceObservations: 0, ratings: 0, reviews: 0, rejectedRecords: 0 };
    const merchantOfferingIds = new Set();
    for (const [position, record] of (report?.records ?? []).entries()) {
      const rawUrl = publicEvidenceUrl(first(record.url, record.canonicalUrl));
      const title = text(record.title, 1000);
      const localId = first(record.sourceLocalId, record.id);
      const hasRawLocalId = localId != null && String(localId).trim().length > 0;
      const sourcePageUrl = publicEvidenceUrl(record.sourcePageUrl);
      const observationScoped = record.identityScope === 'observation' && sourcePageUrl !== null;
      const proofs = list(record.evidence).filter(row => row && typeof row === 'object').map(row => ({
        raw: row, receipt: receiptMap.get(String(first(row.receiptId, row.id))),
      })).filter(row => verifiedReplay(row.receipt) && text(row.raw.locator, 2000));
      const supportedFields = new Set(proofs.flatMap(row => list(row.raw.fields)));
      const supported = (...fields) => fields.some(field => supportedFields.has(field));
      const hasLocalId = hasRawLocalId && supported('sourceLocalId', 'id', 'sku', 'productId', 'goodsId', 'identifiers');
      const url = supported('url', 'canonicalUrl') ? rawUrl : null;
      if (!title || (!hasLocalId && !url && !observationScoped) || proofs.length === 0 || !supported('title', 'name')) {
        quarantine.push({ merchantId, recordPosition: position, title, reason: !title ? 'title_missing' : proofs.length === 0 || !supported('title', 'name') ? 'public_receipt_or_locator_missing' : 'identity_missing' });
        counts.rejectedRecords += 1;
        continue;
      }
      const identity = observationScoped ? `observation:${proofs[0].receipt.id}|${proofs[0].raw.locator}|${title}`
        : hasLocalId ? String(localId).trim() : url;
      const offeringId = `${sourceId}:offering:${hash(identity)}`;
      const offering = put('commercialOfferings', {
        id: offeringId, type: 'CommercialOffering', offeringType: subtype(record.ontologyType ?? record.type), sourceId,
        sourceLocalId: hasLocalId ? text(String(localId), 300) : null,
        identityScope: observationScoped ? 'observation' : hasLocalId ? 'source_local_id' : 'source_url', sourcePageUrl,
        title, canonicalUrl: url, brand: supported('brand') ? text(record.brand, 300) : null, description: supported('description') ? text(record.description, 4000) : null,
        attributes: supported('attributes', 'specifications') ? safeMetadata(record.attributes ?? record.specifications) ?? [] : [],
        sourceSchemaType: supported('sourceSchemaType', 'type') ? text(record.sourceSchemaType, 100) : null, identifiers: supported('identifiers') && record.identifiers && typeof record.identifiers === 'object' ? Object.fromEntries(Object.entries(record.identifiers).filter(([key, value]) => /^(gtin(?:8|12|13|14)?|isbn|mpn|sku)$/i.test(key) && typeof value === 'string')) : {},
        offeringTypeBasis: text(record.offeringTypeBasis ?? record.ontologyBasis, 2000),
        affiliateProgramIds: [], evidenceIds: [], retrievalContexts: [],
      });
      if (!offering.affiliateProgramIds.includes(program.id)) offering.affiliateProgramIds.push(program.id);
      if (!offering.canonicalUrl && url) offering.canonicalUrl = url;
      if (!offering.brand && supported('brand')) offering.brand = text(record.brand, 300);
      if (!offering.description && supported('description')) offering.description = text(record.description, 4000);
      if (!Object.keys(offering.attributes ?? {}).length && supported('attributes', 'specifications')) offering.attributes = safeMetadata(record.attributes ?? record.specifications) ?? [];
      if (!merchantOfferingIds.has(offeringId)) { merchantOfferingIds.add(offeringId); counts.offerings += 1; }
      relate(sourceId, 'offers', offeringId);
      const evidenceIds = proofs.map(({ raw, receipt }) => {
        const locator = text(raw.locator, 2000);
        const fields = list(raw.fields).filter(value => typeof value === 'string').map(value => value.slice(0, 150));
        const id = `evidence:${hash(`${offeringId}|${receipt.id}|${locator}|${fields.join(',')}`)}`;
        put('fieldEvidence', { id, type: 'FieldEvidence', offeringId, sourceId, receiptId: receipt.id, locator, fields, observedAt: receipt.observedAt });
        relate(offeringId, 'supportedBy', id);
        return id;
      });
      offering.evidenceIds = [...new Set([...offering.evidenceIds, ...evidenceIds])];
      const retrievalContext = safeMetadata(first(record.retrievalContext, record.relevance));
      if (retrievalContext) offering.retrievalContexts.push({ ...retrievalContext, evidenceIds });
      const addObservation = (collection, kind, raw, suffix, predicate) => {
        const evidenceFields = kind === 'OfferObservation' ? (raw.variantId ? ['variants', 'productVariants'] : ['price', 'prices', 'offers'])
          : kind === 'RatingAggregate' ? ['rating', 'ratingAggregate', 'reviewCount', 'ratingCount'] : ['reviewSamples', 'reviews'];
        const indexes = proofs.flatMap((proof, index) => list(proof.raw.fields).some(field => evidenceFields.some(prefix => field === prefix || String(field).startsWith(prefix + '.'))) ? [index] : []);
        const relevantIndexes = indexes.length ? indexes : proofs.map((_, index) => index);
        const observationEvidenceIds = relevantIndexes.map(index => evidenceIds[index]);
        const primaryIndexes = relevantIndexes.filter(index => list(proofs[index].raw.fields).some(field => evidenceFields.includes(field)));
        const observedAt = (primaryIndexes.length ? primaryIndexes : relevantIndexes).map(index => proofs[index].receipt.observedAt).sort().at(-1);
        const id = `${sourceId}:${kind}:${hash(`${offeringId}|${observedAt}|${suffix}|${JSON.stringify(raw)}`)}`;
        put(collection, { id, type: kind, sourceId, offeringId, observedAt, evidenceIds: observationEvidenceIds, ...raw });
        relate(offeringId, predicate, id);
        for (const evidenceId of observationEvidenceIds) relate(id, 'supportedBy', evidenceId);
        return id;
      };
      const prices = Array.isArray(record.prices) && record.prices.length ? record.prices
        : Array.isArray(record.offers) && record.offers.length ? record.offers : list(record.price);
      for (const [index, raw] of (supported('price', 'prices', 'offers') ? prices : []).entries()) {
        const price = normalizePrice(raw, record);
        if (price) {
          addObservation('offerObservations', 'OfferObservation', price, `price:${index}`, 'hasOfferObservation'); counts.priceObservations += 1;
          if (price.priceRole === 'quoted_price' && (price.amountMinor != null || price.lowAmountMinor != null || price.highAmountMinor != null)) counts.prices += 1;
        }
      }
      const rating = record.rating ?? record.ratingAggregate;
      if (rating && typeof rating === 'object' && supported('rating', 'ratingAggregate', 'reviewCount', 'ratingCount')) {
        const normalized = { ratingValue: observedNumber(first(rating.value, rating.ratingValue)), bestRating: observedNumber(first(rating.best, rating.bestRating)), worstRating: observedNumber(first(rating.worst, rating.worstRating)), reviewCount: observedCount(rating.reviewCount), ratingCount: observedCount(rating.ratingCount), coverage: 'aggregate_displayed', sourceMetrics: safeMetadata(rating.sourceMetrics) };
        if (normalized.ratingValue === 0 && (normalized.ratingCount === 0 || normalized.ratingCount === null && normalized.reviewCount === 0)) {
          normalized.ratingValue = null;
          normalized.sourceMetrics = { ...(normalized.sourceMetrics && typeof normalized.sourceMetrics === 'object' && !Array.isArray(normalized.sourceMetrics) ? normalized.sourceMetrics : {}),
            displayedZeroValue: 0, normalizationReason: 'zero_display_with_no_confirmed_rating_population' };
        }
        if (['ratingValue', 'bestRating', 'worstRating', 'reviewCount', 'ratingCount'].some(key => normalized[key] !== null)) {
          addObservation('ratingAggregates', 'RatingAggregate', normalized, 'rating', 'hasRatingAggregate'); counts.ratings += 1;
        }
      }
      for (const [index, raw] of (supported('variants', 'productVariants') ? list(record.variants) : []).entries()) {
        if (!raw || typeof raw !== 'object') continue;
        const variantLocalId = first(raw.sourceLocalId, raw.variantLocalId, raw.sku);
        const attributes = raw.attributes && typeof raw.attributes === 'object' ? Object.fromEntries(Object.entries(raw.attributes).filter(([key, value]) => !secretKey.test(key) && ['string', 'number'].includes(typeof value))) : {};
        const variantTitle = text(first(raw.title, raw.name), 1000);
        // Catalog flags alone do not identify a purchasable option.
        if (variantLocalId == null && !publicEvidenceUrl(raw.url) && !variantTitle && !Object.keys(attributes).length) continue;
        const variantIdentity = variantLocalId ?? publicEvidenceUrl(raw.url) ?? JSON.stringify({ title: variantTitle, attributes });
        const id = `${sourceId}:variant:${hash(`${offeringId}|${variantIdentity}|${variantLocalId == null ? index : ''}`)}`;
        put('productVariants', { id, type: 'ProductVariant', sourceId, parentOfferingId: offeringId, variantLocalId: variantLocalId == null ? null : String(variantLocalId), title: variantTitle,
          description: text(first(raw.description, raw.text), 4000), identityScope: variantLocalId != null ? 'source_local_id' : publicEvidenceUrl(raw.url) ? 'source_url' : 'observed_option_label',
          canonicalUrl: publicEvidenceUrl(raw.url), attributes, availability: availability(raw.availability), evidenceIds });
        relate(offeringId, 'hasVariant', id); counts.variants += 1;
        for (const [priceIndex, rawPrice] of list(raw.prices ?? (raw.offers?.length ? raw.offers : raw.price)).entries()) {
          const price = normalizePrice(rawPrice, raw);
          if (price) {
            addObservation('offerObservations', 'OfferObservation', { ...price, variantId: id }, `variant:${index}:price:${priceIndex}`, 'hasOfferObservation'); counts.priceObservations += 1;
            if (price.priceRole === 'quoted_price' && (price.amountMinor != null || price.lowAmountMinor != null || price.highAmountMinor != null)) counts.prices += 1;
          }
        }
      }
      for (const [index, raw] of (supported('reviewSamples', 'reviews') ? list(record.reviewSamples) : []).entries()) {
        if (!raw || typeof raw !== 'object') continue;
        const normalized = { ratingValue: observedNumber(first(raw.rating, raw.ratingValue)), publishedAt: text(raw.publishedAt, 80), title: null, body: null, bodyAvailable: raw.bodyAvailable === true || Boolean(text(raw.body)), reviewLocalId: raw.reviewLocalId ? text(String(raw.reviewLocalId), 200) : null, helpfulCount: observedCount(raw.helpfulCount), hasMedia: typeof raw.hasMedia === 'boolean' ? raw.hasMedia : null, sampleCompleteness: 'partial', reviewerIdentity: null };
        addObservation('reviewObservations', 'ReviewObservation', normalized, `review:${index}`, 'hasReviewObservation'); counts.reviews += 1;
      }
    }
    counts.canonicalUrls = [...merchantOfferingIds].filter(id => collections.commercialOfferings.get(id)?.canonicalUrl).length;
    const sourceReceipts = [...new Map([...receiptMap.values()].map(row => [row.id, row])).values()];
    const hasRequest = sourceReceipts.some(row => row.responseStatus != null || row.stopReason);
    const blocked = /block|challenge|reject|rate.limit|http_(401|403|418|429)/i.test(String(report?.status ?? ''))
      || sourceReceipts.some(row => [401, 403, 418, 429].includes(row.responseStatus))
      || /challenge/i.test(String(report?.stopReason ?? ''));
    const status = counts.offerings ? 'data_observed' : blocked ? 'blocked' : hasRequest ? 'reachable_without_offering_data' : report ? 'attempt_without_response' : 'not_reverified';
    const capabilities = Object.fromEntries(['offerings', 'variants', 'prices', 'ratings', 'reviews'].map(key => [key,
      counts[key] ? 'live_replay_verified' : blocked ? 'blocked_or_not_observed' : 'not_observed']));
    const assessmentId = `assessment:linkprice:${merchantId}`;
    put('capabilityAssessments', { id: assessmentId, type: 'CapabilityAssessment', merchantId, sourceId, status,
      accessMode: sourceReceipts.some(protectedCatalogReplay) ? 'protected_first_party_session' : 'public_anonymous',
      capabilities, reportedOperations: safeMetadata(report?.operations ?? {}), checkedAt: iso(report?.checkedAt),
      reportedStatus: report?.status ?? null, catalogComplete: false, reviewsComplete: false,
      frontier: safeMetadata(report?.frontier ?? []), contracts: safeMetadata(report?.contracts ?? []),
      receiptIds: sourceReceipts.map(row => row.id),
    });
    relate(program.id, 'hasCapabilityAssessment', assessmentId);
    coverage.push({ merchantId, name: program.name, sourceId, batchId: report?.batchId ?? null, status,
      inspected: hasRequest, blockedEncountered: blocked, counts, receiptCount: sourceReceipts.length,
      lastRequestObservedAt: sourceReceipts.map(row => row.observedAt).filter(Boolean).sort().at(-1) ?? null,
      datedReceiptCount: sourceReceipts.filter(row => row.observedAt).length,
      undatedReceiptCount: sourceReceipts.filter(row => !row.observedAt).length,
      capabilities, sourceReport: report ? `cps-reverify/batch-${report.batchId}.json` : null });
  }
  for (const source of collections.consumerSources.values()) {
    source.affiliateProgramIds = [...new Set(source.affiliateProgramIds)];
    source.contractEvidence = [...new Set(source.contractEvidence)];
  }
  const entities = Object.fromEntries(Object.entries(collections).map(([key, rows]) => [key, [...rows.values()]]));
  const protectedSourceIds = [...new Set(entities.evidenceReceipts.filter(protectedCatalogReplay).map(row => row.sourceId))];
  const summary = {
    merchantCount: coverage.length,
    reportedMerchants: coverage.filter(row => row.sourceReport).length,
    inspectedMerchants: coverage.filter(row => row.inspected).length,
    merchantsWithoutDatedReceipts: coverage.filter(row => row.inspected && !row.lastRequestObservedAt).length,
    dataMerchants: coverage.filter(row => row.counts.offerings > 0).length,
    priceMerchants: coverage.filter(row => row.counts.prices > 0).length,
    ratingMerchants: coverage.filter(row => row.counts.ratings > 0).length,
    reviewSampleMerchants: coverage.filter(row => row.counts.reviews > 0).length,
    blockedMerchantsWithoutData: coverage.filter(row => row.status === 'blocked').length,
    blockedEncounteredMerchants: coverage.filter(row => row.blockedEncountered).length,
    unresolvedMerchants: coverage.filter(row => !['data_observed', 'blocked'].includes(row.status)).length,
    quarantinedRecords: quarantine.length,
    offeringsWithCanonicalUrl: entities.commercialOfferings.filter(row => row.canonicalUrl).length,
    offeringsWithoutCanonicalUrl: entities.commercialOfferings.filter(row => !row.canonicalUrl).length,
    entityCounts: Object.fromEntries(Object.entries(entities).map(([name, rows]) => [name, rows.length])),
  };
  return { ontologyId: 'acada:cps-commerce', schemaVersion: 2, generatedAt: iso(generatedAt),
    catalogObservedAt: sourceMap.checkedAt, summary,
    scope: { transport: protectedSourceIds.length ? 'direct_http' : 'direct_public_http', browserRequired: false, credentialsRequired: protectedSourceIds.length > 0, protectedSourceIds,
      catalogComplete: false, reviewsComplete: false, reviewBodyRetention: 'omitted',
      definition: 'Observed offering samples and individual capability evidence for every catalog program. Source registration and a successful homepage are not product coverage.' },
    entities, relations: [...relations.values()], coverage, quarantine };
}

export function ontologyJsonLines(dataset) {
  const header = { type: 'DatasetManifest', ontologyId: dataset.ontologyId, schemaVersion: dataset.schemaVersion, generatedAt: dataset.generatedAt, catalogObservedAt: dataset.catalogObservedAt, summary: dataset.summary, scope: dataset.scope };
  return [header, ...Object.values(dataset.entities).flat(), ...dataset.relations.map(row => ({ type: 'Relation', ...row }))].map(row => JSON.stringify(row)).join('\n') + '\n';
}

export function validateOntologyDataset(dataset, { expectedMerchants = 112 } = {}) {
  const errors = [];
  if (dataset.summary.merchantCount !== expectedMerchants) errors.push(`merchant_count:${dataset.summary.merchantCount}`);
  if (dataset.summary.reportedMerchants !== expectedMerchants) errors.push(`report_count:${dataset.summary.reportedMerchants}`);
  const entities = Object.values(dataset.entities).flat();
  const ids = new Set();
  for (const entity of entities) { if (ids.has(entity.id)) errors.push(`duplicate_id:${entity.id}`); ids.add(entity.id); }
  for (const relation of dataset.relations) {
    if (!ids.has(relation.subject)) errors.push(`relation_subject_missing:${relation.subject}`);
    if (!ids.has(relation.object)) errors.push(`relation_object_missing:${relation.object}`);
  }
  const receipts = new Map(dataset.entities.evidenceReceipts.map(row => [row.id, row]));
  const referencedTypes = { sourceId: 'ConsumerSource', offeringId: 'CommercialOffering', parentOfferingId: 'CommercialOffering', variantId: 'ProductVariant', receiptId: 'EvidenceReceipt' };
  const referencedLists = { evidenceIds: 'FieldEvidence', affiliateProgramIds: 'AffiliateProgram', receiptIds: 'EvidenceReceipt', contractEvidence: 'EvidenceReceipt' };
  const byId = new Map(entities.map(row => [row.id, row]));
  for (const entity of entities) {
    for (const [key, expectedType] of Object.entries(referencedTypes)) if (entity[key] != null && byId.get(entity[key])?.type !== expectedType) errors.push(`reference_missing:${key}:${entity.id}`);
    for (const [key, expectedType] of Object.entries(referencedLists)) for (const id of entity[key] ?? []) if (byId.get(id)?.type !== expectedType) errors.push(`reference_missing:${key}:${entity.id}`);
  }
  for (const receipt of receipts.values()) {
    for (const key of ['bootstrapReceiptId', 'publicClientConfigReceiptId']) {
      if (!receipt[key]) continue;
      const predecessor = receipts.get(receipt[key]);
      if (!publicReplay(predecessor) || predecessor.sourceId !== receipt.sourceId || predecessor.id === receipt.id) errors.push(`invalid_${key}:${receipt.id}`);
    }
    if (receipt.publicRequestTokenSent === true && (!receipt.bootstrapReceiptId || receipt.anonymousBootstrap?.issuedWithoutAccount !== true)) errors.push(`anonymous_bootstrap_proof_missing:${receipt.id}`);
    if (receipt.publicClientHeaderSent === true && !receipt.publicClientConfigReceiptId) errors.push(`public_client_config_proof_missing:${receipt.id}`);
  }
  for (const row of dataset.entities.capabilityAssessments) if (/^(pending|not_started|in_progress)$/i.test(String(row.reportedStatus))) errors.push(`unfinished_assessment:${row.merchantId}`);
  for (const evidence of dataset.entities.fieldEvidence) if (!verifiedReplay(receipts.get(evidence.receiptId))) errors.push(`evidence_not_verified_replay:${evidence.id}`);
  for (const row of dataset.entities.offerObservations) if (row.amountMinor !== decimalToMinor(row.amount, row.currency)) errors.push(`price_conversion:${row.id}`);
  for (const row of dataset.entities.reviewObservations) if (row.body !== null || row.reviewerIdentity !== null) errors.push(`review_privacy:${row.id}`);
  return { ok: errors.length === 0, errors };
}
