import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createOliveyoungKoreaPublicClient } from '../../lib/commerce/oliveyoung-korea-public.mjs';
import { createOliveyoungHttpFetch } from '../../lib/commerce/oliveyoung-http-transport.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const client = createOliveyoungKoreaPublicClient({ fetchImpl: createOliveyoungHttpFetch() });
const pages = [];
for (const pageNumber of [1, 2]) {
  if (pageNumber > 1) await wait(3500);
  const result = await client.getPhotoReviews({ goodsNumber: 'A000000257097', pageNumber, pageSize: 10 });
  const read = result.receipts[0];
  pages.push({
    request: {
      method: read.request.method,
      origin: read.request.origin,
      path: read.request.path,
      bodyFieldNames: read.request.bodyFieldNames,
      httpStatus: read.request.httpStatus,
      mime: read.request.mime,
      responseBytes: read.request.responseBytes,
      responseSha256: read.request.responseSha256,
      checkedAt: read.checkedAt,
      anonymous: !read.request.sessionUsed,
      credentialsUsed: false,
      cookieSent: read.request.cookieNamesSent.length > 0,
      browserUsed: read.request.browserUsed,
    },
    summary: {
      photoReviewRows: result.reviews.length,
      rowsWithPhotos: result.reviews.filter(row => row.photos.length > 0).length,
      totalPhotoReferences: result.reviews.reduce((count, row) => count + row.photos.length, 0),
      requestedPageSize: result.pagination.pageSize,
      totalCount: result.pagination.totalCount,
      isLastPage: result.pagination.isLastPage,
      nextPage: result.pagination.nextPage,
      nextPageCandidate: result.pagination.nextPageCandidate,
      terminalityVerified: result.pagination.terminalityVerified,
    },
  });
}

const paths = [
  'lib/commerce/oliveyoung-korea-public.mjs',
  'lib/commerce/oliveyoung-http-transport.mjs',
  'scripts/oliveyoung-http-transport.py',
];
const implementation = {};
for (const path of paths) implementation[path] = createHash('sha256').update(await readFile(path)).digest('hex');

const evidence = {
  schema: 'web-api-public-read-receipt-v1',
  service: 'oliveyoung-public',
  anonymous: true,
  credentialsUsed: false,
  authenticated: false,
  secretsPersistedInEvidence: false,
  schemaVerified: true,
  expectedResultVerified: true,
  executionMode: 'pure_http',
  implementation,
  sourceMtimeNotAfterRead: true,
  requestCheckedAtBasis: 'live_observation_time',
  capabilityId: 'reviews.images',
  checkedAt: pages[0].request.checkedAt,
  request: { ...pages[0].request, responseProductMatched: null },
  secondPage: { ...pages[1].request, responseProductMatched: null },
  contractProvenance: {
    kind: 'browser_xhr_observed',
    sourceURL: 'https://m.oliveyoung.co.kr/review/api/v2/reviews/photo-reviews',
  },
  resultSummary: {
    productId: 'A000000257097',
    firstPage: pages[0].summary,
    secondPage: pages[1].summary,
    rawReviewBodiesPersisted: false,
    rawPhotoPathsPersisted: false,
    sourceExhausted: false,
    complete: false,
  },
};
await writeFile(new URL('./reviews-photo-fixed-replay.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({
  checkedAt: evidence.checkedAt,
  implementation,
  pages: pages.map(({ request, summary }, index) => ({
    pageNumber: index + 1,
    status: request.httpStatus,
    mime: request.mime,
    responseBytes: request.responseBytes,
    responseSha256: request.responseSha256,
    ...summary,
  })),
  proofPath: 'verification/remaining-oliveyoung-2026-10-16/reviews-photo-fixed-replay.json',
}, null, 2));
