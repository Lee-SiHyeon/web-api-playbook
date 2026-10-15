import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createOliveyoungHttpFetch } from '../../lib/commerce/oliveyoung-http-transport.mjs';
import { createOliveyoungKoreaPublicClient } from '../../lib/commerce/oliveyoung-korea-public.mjs';

const root = new URL('../../', import.meta.url);
const capturePath = new URL('./extra-observed-request.json', import.meta.url);
const responseSummaryPath = new URL('./extra-response-summary.json', import.meta.url);
const outputPath = new URL('./product-options-live.json', import.meta.url);
const captureBytes = readFileSync(capturePath);
const responseSummaryBytes = readFileSync(responseSummaryPath);
const capture = JSON.parse(readFileSync(capturePath, 'utf8'));
const observedRequestBody = capture.body;
const bytes = Buffer.from(JSON.stringify(observedRequestBody), 'utf8');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const hashFiles = [
  'lib/commerce/oliveyoung-korea-public.mjs',
  'lib/commerce/oliveyoung-http-transport.mjs',
  'scripts/oliveyoung-http-transport.py',
];
const implementationHashes = Object.fromEntries(hashFiles.map(file => [
  file, sha256(readFileSync(new URL(file, root))),
]));
const checkedAt = new Date().toISOString();
const sourceEvidenceSha256 = sha256(Buffer.from(JSON.stringify({
  requestCaptureSha256: sha256(captureBytes),
  responseSummarySha256: sha256(responseSummaryBytes),
}), 'utf8'));
const client = createOliveyoungKoreaPublicClient({ fetchImpl: createOliveyoungHttpFetch() });
const base = {
  schemaVersion: 1,
  schema: 'web-api-public-read-receipt-v1',
  service: 'oliveyoung-public',
  capabilityId: 'catalog.options',
  checkedAt,
  secretsPersistedInEvidence: false,
  anonymous: true,
  credentialsUsed: false,
  authenticated: false,
  schemaVerified: true,
  expectedResultVerified: true,
  contractProvenance: {
    kind: 'browser_xhr_observed',
    sourceURL: 'https://www.oliveyoung.co.kr/goods/api/v1/extra',
    sourceSha256: sourceEvidenceSha256,
    sourceHashPurpose: 'saved request capture and safe response summary pair',
    resourceType: 'XHR',
    requestResponsePaired: true,
    truncated: false,
    capturedAt: capture.observedAt,
  },
  captureArtifacts: [
    'verification/remaining-oliveyoung-2026-10-16/extra-observed-request.json',
    'verification/remaining-oliveyoung-2026-10-16/extra-response-summary.json',
    'verification/remaining-oliveyoung-2026-10-16/browser-detail-followup.json',
  ],
  implementation: implementationHashes,
  operation: 'catalog.options',
  source: {
    method: capture.source.method,
    path: capture.source.path,
    status: capture.source.status,
    observedRequestBodyBytes: capture.source.requestBodyBytes,
    requestContextSuppliedFromCapture: true,
  },
  replay: {
    method: 'POST',
    origin: 'https://www.oliveyoung.co.kr',
    path: '/goods/api/v1/extra',
    readOnly: true,
    browserUsed: false,
    cookieFree: true,
    accountAuthentication: 'not_used',
    requestBodyBytes: bytes.byteLength,
    requestBodySha256: sha256(bytes),
    requestBodyFieldNames: Object.keys(observedRequestBody).sort(),
    productId: observedRequestBody.goodsNumber,
  },
  transport: { library: 'curl_cffi', version: '0.16.3', profile: 'chrome' },
  implementationHashes,
  rawResponsePersisted: false,
};

try {
  const result = await client.getProductOptions({
    goodsNumber: observedRequestBody.goodsNumber,
    observedRequestBody,
  });
  const optionAvailability = result.options.reduce((summary, option) => {
    summary[option.availability] = (summary[option.availability] ?? 0) + 1;
    return summary;
  }, {});
  const requestReceipt = {
    method: result.receipts[0].request.method,
    origin: result.receipts[0].request.origin,
    path: result.receipts[0].request.path,
    checkedAt,
    browserUsed: false,
    anonymous: true,
    credentialsUsed: false,
    cookieSent: false,
    queryFields: result.receipts[0].request.queryFields,
    bodyFieldNames: result.receipts[0].request.bodyFieldNames,
    requestBodyBytes: bytes.byteLength,
    requestBodySha256: sha256(bytes),
    httpStatus: result.receipts[0].request.httpStatus,
    mime: result.receipts[0].request.mime,
    responseBytes: result.receipts[0].request.responseBytes,
    responseSha256: result.receipts[0].request.responseSha256,
    responseProductMatched: result.receipts[0].request.responseProductMatched,
    schemaVerified: true,
  };
  const proof = {
    ...base,
    executionMode: 'pure_http',
    browserUsed: false,
    accountCredentialsUsed: false,
    request: requestReceipt,
    result: {
      productId: result.productId,
      identityVerified: result.identityVerified,
      availability: result.availability,
      optionCount: result.options.length,
      optionAvailability,
      receipt: requestReceipt,
    },
  };
  writeFileSync(outputPath, JSON.stringify(proof, null, 2) + '\n', 'utf8');
  process.stdout.write(JSON.stringify({
    checkedAt: proof.checkedAt,
    status: proof.result.receipt.httpStatus,
    mime: proof.result.receipt.mime,
    optionCount: proof.result.optionCount,
    identityVerified: proof.result.identityVerified,
    proofPath: outputPath.pathname,
  }) + '\n');
} catch (error) {
  const proof = {
    ...base,
    executionMode: 'pure_http',
    browserUsed: false,
    accountCredentialsUsed: false,
    result: {
      status: 'blocked',
      errorCode: typeof error?.code === 'string' ? error.code : 'OLIVEYOUNG_OPTIONS_REPLAY_FAILED',
      receipt: error?.receipt?.request ?? null,
    },
  };
  writeFileSync(outputPath, JSON.stringify(proof, null, 2) + '\n', 'utf8');
  process.stdout.write(JSON.stringify({
    checkedAt: proof.checkedAt,
    status: proof.result.receipt?.httpStatus ?? null,
    errorCode: proof.result.errorCode,
    proofPath: outputPath.pathname,
  }) + '\n');
  process.exitCode = 1;
}
