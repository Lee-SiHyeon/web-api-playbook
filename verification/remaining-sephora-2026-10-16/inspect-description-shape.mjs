import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createSephoraPublicClient } from '../../lib/commerce/sephora.mjs';

const productId = 'P417985';
const skuId = '2234219';
const outputPath = new URL('./product-description-shape.json', import.meta.url);
const observation = {};

function valueType(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function collectRelevantShape(value, path = '$', depth = 0, rows = []) {
  if (!value || typeof value !== 'object' || depth > 10) return rows;
  if (Array.isArray(value)) {
    for (let index = 0; index < Math.min(value.length, 20); index += 1) {
      collectRelevantShape(value[index], `${path}[${index}]`, depth + 1, rows);
    }
    return rows;
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (/description|ingredient|productdetails|content/i.test(key)) {
      const row = { path: childPath, type: valueType(child) };
      if (typeof child === 'string') {
        row.length = child.length;
        row.nonBlank = child.trim().length > 0;
      } else if (Array.isArray(child)) {
        row.count = child.length;
        row.sampleTypes = [...new Set(child.slice(0, 5).map(valueType))];
      } else if (child && typeof child === 'object') {
        row.fields = Object.keys(child).sort();
      }
      rows.push(row);
    }
    collectRelevantShape(child, childPath, depth + 1, rows);
  }
  return rows;
}

const client = createSephoraPublicClient({
  fetchImpl: async (input, init) => {
    if (init?.credentials !== 'omit') throw new Error('credentials mode was not omitted');
    if (new Headers(init.headers).has('cookie')) throw new Error('unexpected cookie header');
    const response = await fetch(input, init);
    observation.httpStatus = response.status;
    observation.mime = response.headers.get('content-type');
    if (response.ok && /^application\/json\b/i.test(observation.mime ?? '')) {
      const payload = await response.clone().json();
      observation.topLevelFields = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? Object.keys(payload).sort()
        : [];
      observation.relevantFields = collectRelevantShape(payload).slice(0, 200);
    }
    return response;
  },
});

const result = await client.getProduct({ productId, skuId });
if (result.product.productId !== productId || result.product.currentSku.skuId !== skuId) {
  throw new Error('product identity did not match the request');
}
if (observation.httpStatus !== 200 || !/^application\/json\b/i.test(observation.mime ?? '')) {
  throw new Error('the observed product endpoint did not return JSON 200');
}

const description = result.product.description;
const request = result.receipt.request;
const implementationPaths = [
  '../../lib/commerce/sephora.mjs',
  '../../lib/commerce/http.mjs',
];
const implementation = {};
for (const relativePath of implementationPaths) {
  const absolutePath = new URL(relativePath, import.meta.url);
  implementation[relativePath.replace(/^\.\.\/\.\.\//, '')] = createHash('sha256')
    .update(await readFile(absolutePath))
    .digest('hex');
}

const proof = {
  schema: 'web-api-public-read-receipt-v1',
  service: 'sephora',
  capabilityId: 'catalog.product_description',
  checkedAt: request.checkedAt,
  secretsPersistedInEvidence: false,
  anonymous: true,
  credentialsUsed: false,
  authenticated: false,
  schemaVerified: true,
  expectedResultVerified: false,
  contractProvenance: result.receipt.contractProvenance,
  executionMode: 'pure_http',
  browserUsed: false,
  accountCredentialsUsed: false,
  cookieSent: false,
  externalWrites: 0,
  rawBodiesPersisted: false,
  implementation,
  request: {
    method: request.method,
    origin: request.origin,
    path: request.path,
    checkedAt: request.checkedAt,
    browserUsed: false,
    anonymous: true,
    credentialsUsed: false,
    cookieSent: false,
    queryFields: request.queryFields,
    httpStatus: observation.httpStatus,
    mime: observation.mime,
    responseBytes: request.responseBytes,
    schemaVerified: true,
  },
  requestedProductId: productId,
  returnedProductId: result.product.productId,
  requestedSkuId: skuId,
  returnedSkuId: result.product.currentSku.skuId,
  normalizedDescriptionStatus: result.product.descriptionStatus,
  normalizedDescriptionLength: typeof description === 'string' ? description.length : null,
  normalizedDescriptionNonBlank: typeof description === 'string' ? description.trim().length > 0 : false,
  matchedResult: {
    productId: result.product.productId,
    skuId: result.product.currentSku.skuId,
    shapeScan: { maximumDepth: 10, maximumArrayEntriesInspected: 20, matchingKeyPattern: 'description|ingredient|productdetails|content' },
    productDetailsFields: observation.relevantFields?.find(row => row.path === '$.productDetails')?.fields ?? [],
    descriptionOrIngredientFields: observation.relevantFields?.filter(row => /description|ingredient/i.test(row.path)) ?? [],
    descriptionReturned: Boolean(description),
    descriptionStatus: result.product.descriptionStatus,
  },
  payloadShape: observation,
};

await writeFile(outputPath, `${JSON.stringify(proof, null, 2)}\n`, 'utf8');
process.stdout.write(JSON.stringify({
  saved: outputPath.pathname,
  checkedAt: proof.checkedAt,
  status: proof.request.httpStatus,
  mime: proof.request.mime,
  identityMatched: proof.requestedProductId === proof.returnedProductId && proof.requestedSkuId === proof.returnedSkuId,
  descriptionStatus: proof.normalizedDescriptionStatus,
  descriptionLength: proof.normalizedDescriptionLength,
  relevantFieldCount: observation.relevantFields?.length ?? 0,
  rawBodiesPersisted: false,
}));
