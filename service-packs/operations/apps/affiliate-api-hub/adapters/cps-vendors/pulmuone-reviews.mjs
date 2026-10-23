import { createHash, randomUUID } from 'node:crypto';
import { isStrongPublicChallenge } from '../../lib/cps-public-reader.mjs';

const SITE = 'https://shop.pulmuone.co.kr';
const DETAIL_PATH = '/shop/goodsView/39271';
const REVIEW_PATH = '/goods/goods/getFeedbackListByGoods';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const CHALLENGE_TEXT = /(?:access denied|verify (?:that )?you are human|verify you are not a robot|checking your browser|unusual traffic|automated requests? detected|security challenge|요청이 차단|비정상적인 접근|자동\s*입력\s*방지|로봇이 아닙니다)/i;

function observedDate(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^\d{4}[-./]\d{1,2}[-./]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?/.test(trimmed)
    ? trimmed.slice(0, 80) : null;
}

function observedRating(value) {
  const number = typeof value === 'number' ? value
    : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 && number <= 5 ? number : null;
}

function hasMedia(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return typeof value === 'string' && value.trim().length > 0;
}

function typeCounts(rows, field) {
  const counts = {};
  for (const row of rows) {
    const value = row?.[field];
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

async function readBounded(response) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body ?? []) {
    bytes += chunk.length;
    if (bytes > MAX_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => {});
      throw new Error('PULMUONE_REVIEW_RESPONSE_TOO_LARGE');
    }
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks, bytes);
  return { raw, bytes, responseSha256: createHash('sha256').update(raw).digest('hex') };
}

function challengeHeaders(response) {
  return Object.fromEntries([...response.headers.entries()].map(([key, value]) => [key.toLowerCase(), value]));
}

function failureResult({ checkedAt, receipt, state, reason, status = null }) {
  if (receipt) receipt.stopReason = reason;
  return {
    merchantId: 'pulmuone', siteUrl: `${SITE}/`, checkedAt,
    receipts: receipt ? [receipt] : [],
    page: null, reviewSamples: [], state, stopReason: reason,
    operations: { reviews: { state, liveReplay: false, browserRequired: false, credentialsRequired: false } },
    contracts: [{ operation: 'reviews', method: 'POST', url: `${SITE}${REVIEW_PATH}`,
      receiptId: receipt?.id ?? null, state, httpStatus: status }],
  };
}

/**
 * Read one public Pulmuone product-review page using the observed first-party
 * consumer request. The source provides comment and loginId fields; neither
 * review text nor reviewer identity is returned or retained by this adapter.
 */
export async function readPulmuoneReviews(goodsId, { page = 1, limit = 10 } = {}) {
  const id = String(goodsId);
  if (!/^\d{1,12}$/.test(id)) throw new Error('PULMUONE_GOODS_ID_INVALID');
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000) throw new Error('PULMUONE_REVIEW_PAGE_INVALID');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error('PULMUONE_REVIEW_LIMIT_INVALID');

  const checkedAt = new Date().toISOString();
  const url = new URL(REVIEW_PATH, SITE);
  const form = new FormData();
  // The consumer hook constructs { page, limit, ...requests.reviews } in this order.
  for (const [key, value] of [
    ['page', page], ['limit', limit], ['ilGoodsId', id], ['photoYn', 'N'],
    ['sortCode', 'NEW'], ['sortSatisfaction', 'ALL'],
  ]) form.append(key, String(value));

  const request = new Request(url, {
    method: 'POST', body: form, credentials: 'omit', redirect: 'manual', cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
    headers: {
      accept: 'application/json, text/plain, */*',
      origin: SITE,
      referer: `${SITE}${DETAIL_PATH.replace('39271', id)}`,
    },
  });
  const requestHeaderNames = [...request.headers.keys()].map(name => name.toLowerCase()).sort();
  const requestContentType = request.headers.get('content-type')?.split(';', 1)[0]?.toLowerCase() ?? null;
  let response;
  try {
    response = await fetch(request);
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? 'request_timeout' : 'transport_error';
    return failureResult({ checkedAt, state: reason, reason: 'PULMUONE_REVIEW_REQUEST_FAILED' });
  }

  let captured;
  try {
    captured = await readBounded(response);
  } catch (error) {
    return failureResult({ checkedAt, state: 'response_too_large', reason: 'PULMUONE_REVIEW_RESPONSE_TOO_LARGE', status: response.status });
  }
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  const receipt = {
    id: randomUUID(), requestMethod: 'POST', requestUrl: url.href,
    requestHeaderNames, requestContentType,
    requestFieldNames: ['page', 'limit', 'ilGoodsId', 'photoYn', 'sortCode', 'sortSatisfaction'],
    responseStatus: response.status, contentType: response.headers.get('content-type') ?? null,
    bytes: captured.bytes, responseSha256: captured.responseSha256, observedAt: checkedAt,
    browserUsed: false, cookiesSent: false, authorizationSent: false,
  };
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    return failureResult({ checkedAt, receipt, state: 'redirect_rejected', reason: 'PULMUONE_REVIEW_REDIRECT_REJECTED', status: response.status });
  }
  const text = captured.raw.toString('utf8');
  const isTextResponse = contentType.startsWith('text/');
  if (isStrongPublicChallenge(challengeHeaders(response), contentType.startsWith('text/html') ? text : '')
    || (isTextResponse && CHALLENGE_TEXT.test(text))) {
    return failureResult({ checkedAt, receipt, state: 'stopped_at_challenge', reason: 'PULMUONE_REVIEW_CHALLENGE', status: response.status });
  }
  if ([401, 403, 418, 429].includes(response.status)) {
    return failureResult({ checkedAt, receipt, state: 'stopped_at_rejection', reason: `PULMUONE_REVIEW_HTTP_${response.status}`, status: response.status });
  }
  if (response.status !== 200 || !contentType.includes('json')) {
    return failureResult({ checkedAt, receipt, state: 'response_contract_unavailable', reason: 'PULMUONE_REVIEW_EXPECTED_JSON_200', status: response.status });
  }

  let envelope;
  try { envelope = JSON.parse(text); }
  catch { return failureResult({ checkedAt, receipt, state: 'response_contract_mismatch', reason: 'PULMUONE_REVIEW_JSON_INVALID', status: response.status }); }
  if (envelope?.code !== '0000') {
    return failureResult({ checkedAt, receipt, state: 'source_rejected', reason: 'PULMUONE_REVIEW_SUCCESS_CODE_MISMATCH', status: response.status });
  }
  const data = envelope.data;
  if (!data || !Number.isFinite(Number(data.total)) || !Array.isArray(data.dataList)) {
    return failureResult({ checkedAt, receipt, state: 'response_contract_mismatch', reason: 'PULMUONE_REVIEW_DATA_SHAPE_MISMATCH', status: response.status });
  }

  // The public consumer filters out any row not explicitly marked displayYn=Y.
  const visibleRows = data.dataList.filter(row => row && typeof row === 'object' && row.displayYn === 'Y');
  const reviewSamples = visibleRows.map(row => ({
    ratingValue: observedRating(row.satisfactionScore),
    publishedAt: observedDate(row.createDate),
    title: null,
    body: null,
    bodyAvailable: typeof row.comment === 'string' && row.comment.trim().length > 0,
    reviewLocalId: null,
    helpfulCount: null,
    hasMedia: hasMedia(row.image),
    sampleCompleteness: 'partial',
    reviewerIdentity: null,
  }));
  const fieldProof = {
    receiptId: receipt.id,
    responsePaths: { 'data.total': typeCounts([data], 'total'), 'data.dataList': 'array' },
    rowSampleCount: data.dataList.length,
    rowFields: [
      { sourceField: 'displayYn', observedTypes: typeCounts(data.dataList, 'displayYn'), mapping: 'public-row filter: Y only' },
      { sourceField: 'satisfactionScore', observedTypes: typeCounts(data.dataList, 'satisfactionScore'), mapping: 'ratingValue' },
      { sourceField: 'createDate', observedTypes: typeCounts(data.dataList, 'createDate'), mapping: 'publishedAt' },
      { sourceField: 'comment', observedTypes: typeCounts(data.dataList, 'comment'), mapping: 'bodyAvailable boolean only; text omitted' },
      { sourceField: 'image', observedTypes: typeCounts(data.dataList, 'image'), mapping: 'hasMedia boolean only; URLs omitted' },
    ],
    valueRetention: { reviewBody: 'omitted', reviewerIdentity: 'omitted', mediaUrls: 'omitted', reviewLocalId: 'omitted' },
  };
  return {
    merchantId: 'pulmuone', siteUrl: `${SITE}/`, checkedAt, receipts: [receipt],
    page: { page, limit, total: Number(data.total), returnedCount: data.dataList.length, publiclyDisplayedCount: visibleRows.length },
    reviewSamples, fieldProof, state: 'live_replay_verified', stopReason: null,
    operations: { reviews: { state: 'live_replay_verified', liveReplay: true, browserRequired: false,
      credentialsRequired: false, reviewBodyRetained: false, reviewerIdentityRetained: false,
      page, limit, total: Number(data.total), sampleCount: visibleRows.length } },
    contracts: [{ operation: 'reviews', method: 'POST', url: url.href, receiptId: receipt.id,
      state: 'live_replay_verified', successCode: '0000', requestContentType,
      requestFieldNames: receipt.requestFieldNames, responsePath: 'data.{total,dataList[]}',
      rowFilter: 'displayYn === Y', sortCode: 'NEW', sortSatisfaction: 'ALL', photoYn: 'N' }],
  };
}
