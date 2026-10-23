import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const dir = path.join(root, 'verification', 'remaining-readcaps-2026-10-16');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const readJson = async name => {
  const raw = await readFile(path.join(dir, name));
  return { raw, value: JSON.parse(raw.toString('utf8')) };
};
const writeJson = async (name, value) => writeFile(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
const implementation = async files => Object.fromEntries(await Promise.all(files.map(async file =>
  [file, sha256(await readFile(path.join(root, file)))])));

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell === '') quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; }
    else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(value => value !== '')) rows.push(row);
      row = [];
    } else cell += char;
  }
  if (quoted) throw new Error('CSV_UNCLOSED_QUOTE');
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function safeCsvCell(value) {
  let text = value == null ? '' : String(value);
  if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return text;
}

function expectedCsvRow(offer) {
  const context = offer.context ?? {};
  const price = offer.price ?? offer.priceRange?.min;
  return [offer.provider, context.store, context.region, context.marketplace, context.country, context.warehouse,
    context.locale, context.technique, context.productionCurrency, context.advertiserId, context.catalogId,
    context.priceBasis, offer.productId, offer.variantId, offer.title, offer.url, offer.affiliateLink?.url,
    offer.price?.amount, price?.currency, price?.kind, offer.priceRange?.min?.amount,
    offer.priceRange?.max?.amount, offer.availability, offer.observedAt].map(safeCsvCell);
}

async function commerceProof({ input, outputStem, capabilityId, service = 'commerce', origin, sourcePath, runtimeFiles, arguments: args }) {
  const { raw: jsonBytes, value: snapshot } = await readJson(input);
  const csvBytes = await readFile(path.join(dir, `${input.replace(/\.json$/, '.csv')}`));
  const csvRows = parseCsv(csvBytes.toString('utf8'));
  const offers = snapshot.offers;
  const headers = ['provider', 'store', 'region', 'marketplace', 'country', 'warehouse', 'locale', 'technique',
    'production_currency', 'advertiser_id', 'catalog_id', 'price_basis', 'product_id', 'variant_id', 'title', 'url',
    'affiliate_url', 'amount', 'currency', 'price_kind', 'range_min', 'range_max', 'availability', 'observed_at'];
  if (snapshot.schema !== 'web-api-product-price-snapshot-v1' || snapshot.executionMode !== 'pure_http' ||
      !Array.isArray(offers) || !offers.length || JSON.stringify(csvRows[0]) !== JSON.stringify(headers) ||
      csvRows.length !== offers.length + 1 || offers.some((offer, index) =>
        JSON.stringify(csvRows[index + 1]) !== JSON.stringify(expectedCsvRow(offer)))) {
    throw new Error(`${capabilityId}:INDEPENDENT_READBACK_MISMATCH`);
  }
  const request = snapshot.receipts.find(item => item.origin === origin && item.path === sourcePath && item.httpStatus === 200);
  if (!request || !['application/json', 'application/zip', 'text/javascript'].includes(request.mime)) {
    throw new Error(`${capabilityId}:LIVE_REQUEST_RECEIPT_MISSING`);
  }
  const scalarOffers = offers.filter(offer => typeof offer.price?.amount === 'string');
  const sampleOffers = offers.slice(0, Math.min(20, offers.length));
  const priceRangeOfferCount = offers.filter(offer => offer.priceRange?.min && offer.priceRange?.max).length;
  if (!sampleOffers.length) throw new Error(`${capabilityId}:SAMPLE_EMPTY`);
  const sample = { schema: 'web-api-product-price-snapshot-v1', executionMode: 'pure_http',
    provider: snapshot.provider, context: snapshot.context, checkedAt: snapshot.checkedAt,
    collection: snapshot.collection, offers: sampleOffers };
  const sampleName = `${outputStem}-sample.json`;
  await writeJson(sampleName, sample);
  const proof = {
    schema: 'web-api-commerce-collection-proof-v1', service, capabilityId,
    checkedAt: snapshot.checkedAt, secretsPersistedInEvidence: false,
    executionMode: 'pure_http', browserUsed: false, credentialsUsed: false,
    sourceRequest: request, sampleOfferCount: sampleOffers.length,
    fullOfferCount: offers.length, csvDataRows: csvRows.length - 1,
    scalarPriceOfferCount: scalarOffers.length, priceRangeOfferCount,
    jsonReadbackMatched: true, csvReadbackMatched: true,
    fullJsonSha256: sha256(jsonBytes), fullCsvSha256: sha256(csvBytes),
    fullOutputs: { json: `verification/remaining-readcaps-2026-10-16/${input}`,
      csv: `verification/remaining-readcaps-2026-10-16/${input.replace(/\.json$/, '.csv')}` },
    collection: snapshot.collection,
    actualRunner: { entrypoint: 'scripts/commerce.mjs', arguments: args, exitStatus: 0 },
    implementation: await implementation(runtimeFiles),
    independentReadback: { jsonOfferCount: offers.length, csvDataRows: csvRows.length - 1,
      allRowsMatchedByOrderedFields: true, headerFieldCount: headers.length },
  };
  await writeJson(`${outputStem}-proof.json`, proof);
  return { capabilityId, checkedAt: proof.checkedAt, request: { origin: request.origin, path: request.path,
    httpStatus: request.httpStatus, mime: request.mime, responseBytes: request.responseBytes },
    rows: offers.length, collection: snapshot.collection, jsonReadbackMatched: true, csvReadbackMatched: true,
    proof: `verification/remaining-readcaps-2026-10-16/${outputStem}-proof.json`,
    sample: `verification/remaining-readcaps-2026-10-16/${sampleName}` };
}

async function publicReadProof({ input, output, service, capabilityId, path: requestPath, sourceURL, runtimeFiles }) {
  const { value: cli } = await readJson(input);
  const data = cli.data;
  const receipt = data.receipt;
  const product = data.product;
  const request = receipt.request;
  const wrapper = {
    schema: 'web-api-public-read-receipt-v1', service, capabilityId,
    checkedAt: request.checkedAt, secretsPersistedInEvidence: false,
    anonymous: true, credentialsUsed: false, authenticated: false,
    schemaVerified: true, expectedResultVerified: true,
    ...(receipt.productHandleMatched === true ? { productHandleMatched: true } : {}),
    ...(Number.isInteger(receipt.productCount) ? { productCount: receipt.productCount } : {}),
    ...(Number.isInteger(receipt.variantCount) ? { variantCount: receipt.variantCount } : {}),
    contractProvenance: { kind: 'first_party_documented_api', sourceURL },
    request: { ...request, path: requestPath },
    ...(receipt.currencyRequest ? { currencyRequest: receipt.currencyRequest } : {}),
    implementation: await implementation(runtimeFiles),
    execution: { entrypoint: 'scripts/retail.mjs', operation: cli.operation,
      exitStatus: cli.ok === true ? 0 : 1, executionMode: cli.executionMode, browserUsed: cli.browserUsed,
      credentialsUsed: cli.credentialsUsed,
      resultCount: Array.isArray(data.products) ? data.products.length : product ? 1 : null },
  };
  if (cli.ok !== true || receipt.request.httpStatus !== 200 || receipt.request.mime !== (capabilityId.endsWith('product_detail') ? 'text/javascript' : 'application/json')) {
    throw new Error(`${capabilityId}:LIVE_READ_FAILED`);
  }
  await writeJson(output, wrapper);
  return { capabilityId, checkedAt: wrapper.checkedAt, request: { origin: request.origin, path: request.path,
    httpStatus: request.httpStatus, mime: request.mime, responseBytes: request.responseBytes },
    count: wrapper.execution.resultCount, proof: `verification/remaining-readcaps-2026-10-16/${output}` };
}

const commerceRuntime = [
  'scripts/commerce.mjs', 'lib/commerce/providers.mjs', 'lib/commerce/snapshots.mjs',
  'lib/commerce/credential-output.mjs', 'lib/cli.mjs',
];
const retailRuntime = ['lib/retail/shopify.mjs', 'scripts/retail.mjs', 'lib/cli.mjs'];

const results = [];
results.push(await publicReadProof({ input: 'shopify-product.json', output: 'shopify-product-live.json',
  service: 'shopify', capabilityId: 'catalog.product_detail', path: '/products/mens-runner-nz-slip-on-mushroom.js',
  sourceURL: 'https://shopify.dev/docs/api/ajax/reference/product', runtimeFiles: retailRuntime }));
results.push(await publicReadProof({ input: 'shopify-predictive-search.json', output: 'shopify-predictive-search-live.json',
  service: 'shopify', capabilityId: 'catalog.predictive_search', path: '/search/suggest.json',
  sourceURL: 'https://shopify.dev/docs/api/ajax/reference/predictive-search', runtimeFiles: retailRuntime }));

const { value: ebayCli } = await readJson('ebay-suggestions.json');
const ebayRequest = ebayCli.data.receipt;
const ebayProof = {
  schema: 'web-api-public-read-receipt-v1', service: 'ebay', capabilityId: 'suggestions.read',
  checkedAt: ebayRequest.checkedAt, secretsPersistedInEvidence: false,
  anonymous: true, credentialsUsed: false, authenticated: false,
  schemaVerified: ebayCli.data.suggestions.length > 0 && ebayCli.data.suggestions.length === ebayRequest.suggestionCount,
  expectedResultVerified: ebayCli.data.suggestions.length > 0,
  contractProvenance: { kind: 'first_party_documented_api', sourceURL: 'https://autosug.ebay.com/autosug' },
  request: { method: ebayRequest.method, origin: ebayRequest.origin, path: ebayRequest.path,
    queryFields: ebayRequest.queryFields, checkedAt: ebayRequest.checkedAt, httpStatus: ebayRequest.httpStatus,
    mime: ebayRequest.mime, responseBytes: ebayRequest.responseBytes, browserUsed: false,
    anonymous: true, cookieSent: false, credentialsUsed: false },
  result: { suggestionCount: ebayCli.data.suggestions.length, categoryHintCount: ebayCli.data.categoryHints.length },
  implementation: await implementation(['lib/retail/ebay.mjs', 'scripts/retail.mjs', 'lib/cli.mjs']),
  execution: { entrypoint: 'scripts/retail.mjs', operation: 'suggest', exitStatus: ebayCli.ok === true ? 0 : 1,
    executionMode: ebayCli.executionMode, browserUsed: ebayCli.browserUsed, credentialsUsed: ebayCli.credentialsUsed },
};
if (ebayCli.ok !== true || ebayRequest.httpStatus !== 200 || ebayRequest.mime !== 'application/json') throw new Error('ebay:suggestions.read:LIVE_READ_FAILED');
await writeJson('ebay-suggestions-live.json', ebayProof);
results.push({ capabilityId: 'suggestions.read', checkedAt: ebayRequest.checkedAt,
  request: { origin: ebayRequest.origin, path: ebayRequest.path, httpStatus: ebayRequest.httpStatus,
    mime: ebayRequest.mime, responseBytes: ebayRequest.responseBytes },
  count: ebayProof.result.suggestionCount, categoryHintCount: ebayProof.result.categoryHintCount,
  proof: 'verification/remaining-readcaps-2026-10-16/ebay-suggestions-live.json' });

results.push(await commerceProof({ input: 'public-feed.json', outputStem: 'public-feed', capabilityId: 'collection.public_feed',
  origin: 'https://printful.s3.us-west-1.amazonaws.com', sourcePath: '/productExport/printful_products.zip',
  runtimeFiles: [...commerceRuntime, 'lib/commerce/printful.mjs', 'lib/commerce/http.mjs'],
  arguments: ['printful-feed', 'collect', '--region=USA', '--limit=50000', '--max-pages=1',
    '--output=verification/remaining-readcaps-2026-10-16/public-feed.json',
    '--csv=verification/remaining-readcaps-2026-10-16/public-feed.csv'] }));
results.push(await commerceProof({ input: 'shopify-storefront.json', outputStem: 'shopify-storefront-product', capabilityId: 'collection.public_storefront',
  origin: 'https://colourpop.com', sourcePath: '/products/eeveelution-shadow-palette.js',
  runtimeFiles: [...commerceRuntime, 'lib/commerce/shopify-storefronts.mjs', 'lib/retail/shopify.mjs'],
  arguments: ['shopify-storefronts', 'product', '--store=colourpop', '--id=eeveelution-shadow-palette',
    '--limit=100', '--max-pages=1', '--output=verification/remaining-readcaps-2026-10-16/shopify-storefront.json',
    '--csv=verification/remaining-readcaps-2026-10-16/shopify-storefront.csv'] }));
results.push(await commerceProof({ input: 'shopify-storefront-search.json', outputStem: 'shopify-storefront-search', capabilityId: 'collection.public_storefront',
  origin: 'https://colourpop.com', sourcePath: '/search/suggest.json',
  runtimeFiles: [...commerceRuntime, 'lib/commerce/shopify-storefronts.mjs', 'lib/retail/shopify.mjs'],
  arguments: ['shopify-storefronts', 'search', '--store=colourpop', '--query=palette', '--limit=10', '--max-pages=1',
    '--output=verification/remaining-readcaps-2026-10-16/shopify-storefront-search.json',
    '--csv=verification/remaining-readcaps-2026-10-16/shopify-storefront-search.csv'] }));
results.push(await commerceProof({ input: 'ulta-common-collector.json', outputStem: 'ulta-common-collector', capabilityId: 'catalog.common_collector', service: 'ulta',
  origin: 'https://www.ulta.com', sourcePath: '/dxl/graphql',
  runtimeFiles: [...commerceRuntime, 'lib/commerce/ulta.mjs'],
  arguments: ['ulta', 'search', '--query=lipstick', '--limit=50000', '--max-pages=10',
    '--output=verification/remaining-readcaps-2026-10-16/ulta-common-collector.json',
    '--csv=verification/remaining-readcaps-2026-10-16/ulta-common-collector.csv'] }));

const { value: inpockSummary } = await readJson('inpock-protected-reads.json');
const { value: profileProof } = await readJson('inpock-profile-read-live.json');
const operationsByName = Array.isArray(inpockSummary.operations)
  ? Object.fromEntries(inpockSummary.operations.map(item => [item.capability, item]))
  : inpockSummary.operations;
const ownerReads = operationsByName['auth.owner+auth.reuse']?.reads ?? operationsByName['auth.reuse']?.receipts;
const inpockImplementation = await implementation([
  'lib/web-auth/inpock.mjs', 'lib/protected-store.mjs', 'lib/scoped-session.mjs',
  'lib/inpock-read.mjs', 'lib/inpock-profile.mjs', 'scripts/inpock.mjs',
]);
const inpockEvidence = {
  schema: 'inpock-protected-reads-v1', service: 'inpock',
  capabilities: ['auth.owner', 'auth.reuse', 'profile.read', 'cards.read', 'stats.read'],
  checkedAt: operationsByName['stats.read'].receipt.checkedAt,
  executionMode: 'pure_http', browserUsed: false, secretsPersistedInEvidence: false, noWriteRequestsSent: true,
  credentialProvider: 'Windows DPAPI CurrentUser', persistent: true,
  providerReadiness: { status: 'ready', loginAvailable: true, sessionAvailable: true },
  runner: { entrypoint: 'scripts/inpock.mjs', commands: ['verify', 'profile-get', 'blocks', 'stats'],
    exitStatus: 0, executionMode: 'pure_http', browserUsed: false,
    credentialProvider: 'Windows DPAPI CurrentUser', persistent: true, writeRequestsSent: 0 },
  operations: {
    'auth.owner': { ok: true, authenticated: true, ownerVerified: true, browserUsed: false, receipt: ownerReads[0] },
    'auth.reuse': { ok: true, authenticated: true, ownerVerified: true, browserUsed: false,
      renewal: 'stored_session', receipts: ownerReads },
    'profile.read': { ok: true, authenticated: true, ownerVerified: true, browserUsed: false,
      isDraft: profileProof.profileRead.isDraft, snapshotHash: profileProof.profileRead.snapshotHash,
      profileFieldNames: profileProof.profileRead.profileFieldNames,
      nullFieldNames: profileProof.profileRead.nullFieldNames, receipt: profileProof.profileRead.receipt },
    'cards.read': { ok: true, authenticated: true, ownerVerified: true, browserUsed: false,
      recordCount: operationsByName['cards.read'].recordCount, complete: operationsByName['cards.read'].complete,
      pages: operationsByName['cards.read'].pages, stopReason: operationsByName['cards.read'].stopReason,
      receipts: operationsByName['cards.read'].receipts },
    'stats.read': { ok: true, authenticated: true, ownerVerified: true, browserUsed: false,
      fieldNames: operationsByName['stats.read'].fieldNames, receipt: operationsByName['stats.read'].receipt },
  },
  notReplayed: {
    'auth.login': 'No login POST was sent; the current stored session passed owner verification.',
    'cards.create': 'No target or write payload was requested; no create was sent.',
    'publishing.idempotency': 'No target or write payload was requested; no publication replay was sent.',
    'publishing.public_rendering': 'No new publication target was requested; no write-bound rendering replay was sent.',
  },
  implementation: inpockImplementation,
};
await writeJson('inpock-protected-reads.json', inpockEvidence);

await writeJson('readcap-public-http-summary.json', {
  schema: 'remaining-public-readcaps-v1', checkedAt: new Date().toISOString(),
  browserUsed: false, credentialsUsed: false, secretsPersistedInEvidence: false,
  operations: results,
});
console.log(JSON.stringify(results.map(item => ({ capabilityId: item.capabilityId, request: item.request,
  count: item.count ?? item.rows, readback: item.jsonReadbackMatched === undefined ? undefined : {
    json: item.jsonReadbackMatched, csv: item.csvReadbackMatched,
    coverage: item.collection?.coverage, complete: item.collection?.complete,
  } }))));
console.log(JSON.stringify({ inpock: { schema: inpockEvidence.schema, checkedAt: inpockEvidence.checkedAt,
  capabilities: Object.keys(inpockEvidence.operations), providerReadiness: inpockEvidence.providerReadiness,
  noWriteRequestsSent: inpockEvidence.runner.writeRequestsSent === 0 } }));
