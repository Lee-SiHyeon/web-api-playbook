import { GeminiClientError } from './errors.mjs';
import { executeMutationOnce } from './mutation.mjs';
import { consumeMutationDispatch, digestBody, JOB_DIR } from './journal.mjs';
import { makeCookieHeader, validateSessionBundle } from './session.mjs';
import { httpsFetch } from './https-transport.mjs';
import { validateMediaCapture } from './media-capture.mjs';
import path from 'node:path';

const SERVICE_ORIGIN = 'https://gemini.google.com';
const MAX_MEDIA_RESPONSE_BYTES = 64 * 1024 * 1024;

async function readBoundedBody(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_MEDIA_RESPONSE_BYTES) {
    response.body?.destroy?.();
    throw new GeminiClientError('RESPONSE_TOO_LARGE', 'The Gemini media response exceeded the configured limit.');
  }
  const chunks = [];
  let length = 0;
  try {
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > MAX_MEDIA_RESPONSE_BYTES) {
        response.body?.destroy?.();
        throw new GeminiClientError('RESPONSE_TOO_LARGE', 'The Gemini media response exceeded the configured limit.');
      }
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    if (error instanceof GeminiClientError) throw error;
    throw new GeminiClientError('RESPONSE_READ_FAILED', 'The Gemini media response could not be read.');
  }
  return Buffer.concat(chunks, length);
}

function mediaSessionContract(baseContract, capability, capture) {
  return Object.freeze({
    version: baseContract.version,
    service: baseContract.service,
    origin: baseContract.origin,
    observedAt: baseContract.observedAt,
    auth: baseContract.auth,
    assetOrigins: baseContract.assetOrigins,
    operations: Object.freeze({
      [capability]: Object.freeze({
        observation: Object.freeze({ requestObserved: true, responseObserved: false }),
        request: Object.freeze({
          method: capture.method,
          origin: capture.origin,
          path: capture.path,
          queryKeys: capture.queryKeys,
          headerNames: capture.headerNames,
          contentType: capture.contentType,
          bodyFieldNames: capture.inspection.fieldNames,
        }),
      }),
    }),
  });
}

function validateDirectUrl(capture) {
  const url = new URL(capture.url);
  if (url.origin !== SERVICE_ORIGIN || url.pathname !== capture.path
      || [...url.searchParams.keys()].some((key, index) => key !== capture.queryKeys[index])
      || url.searchParams.size !== capture.queryKeys.length) {
    throw new GeminiClientError('MEDIA_REQUEST_SCOPE_INVALID', 'The captured Gemini media URL did not match its observed origin and query contract.');
  }
  return url;
}

function makeHeaders(session, capture, targetUrl) {
  const headers = new Headers();
  const allowed = new Set(capture.headerNames.map((name) => name.toLowerCase()));
  for (const [name, value] of Object.entries(capture.headerValues)) {
    const normalized = name.toLowerCase();
    if (!allowed.has(normalized) || ['cookie', 'authorization', 'proxy-authorization', 'host', 'content-length'].includes(normalized)) {
      throw new GeminiClientError('MEDIA_REQUEST_HEADER_BLOCKED', 'A captured media header was outside the observed allowlist.');
    }
    headers.set(normalized, value);
  }
  if (headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') {
    throw new GeminiClientError('MEDIA_REQUEST_CONTENT_TYPE_INVALID', 'The captured media form content type was unavailable.');
  }
  headers.set('cookie', makeCookieHeader(session, targetUrl));
  return headers;
}

export async function submitCapturedMediaOnce({
  baseContract,
  sessionBundle,
  capture: rawCapture,
  capability,
  actor,
  callerIntent,
  expectedIntent,
  journalRoot = JOB_DIR,
  fetchImpl = httpsFetch,
}) {
  const capture = validateMediaCapture(rawCapture, { capability, expectedIntent });
  const url = validateDirectUrl(capture);
  const contract = mediaSessionContract(baseContract, capability, capture);
  const operationSessionInput = {
    version: sessionBundle.version,
    service: sessionBundle.service,
    origin: sessionBundle.origin,
    capturedAt: sessionBundle.capturedAt,
    cookies: sessionBundle.cookies,
    headers: sessionBundle.headers,
    requestHeaders: { [capability]: capture.headerValues },
  };
  const session = validateSessionBundle(operationSessionInput, contract);
  if (typeof fetchImpl !== 'function') {
    throw new GeminiClientError('MEDIA_TRANSPORT_INVALID', 'An HTTPS transport function is required.');
  }
  const requestSpec = Object.freeze({
    method: capture.method,
    path: capture.path,
    url: capture.url,
    query: capture.query,
    headers: capture.headerValues,
    contentType: capture.contentType,
    body: capture.body,
  });
  const transport = {
    async request(requestCapability, spec, { dispatchTicket, wireBodyDigest } = {}) {
      if (requestCapability !== capability || spec.url !== capture.url || spec.method !== 'POST'
          || spec.path !== capture.path || !Buffer.isBuffer(spec.body)
          || digestBody(spec.body) !== wireBodyDigest) {
        throw new GeminiClientError('MEDIA_REQUEST_SPEC_MISMATCH', 'The media request no longer matches the browser capture.');
      }
      consumeMutationDispatch(dispatchTicket, capability, wireBodyDigest);
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: makeHeaders(session, capture, url),
          body: spec.body,
          timeoutMs: capability === 'video' ? 120000 : 60000,
        });
      } catch (error) {
        throw error instanceof GeminiClientError ? error : new GeminiClientError('MEDIA_TRANSPORT_FAILED', 'The captured media request failed before a response was available.');
      }
      const body = await readBoundedBody(response);
      return Object.freeze({
        httpStatus: response.status,
        contentType: response.headers.get('content-type') || '',
        responseBytes: body.length,
        body,
        credentialPropagated: true,
        redirectsFollowed: false,
      });
    },
  };
  const mutation = await executeMutationOnce({
    transport,
    capability,
    requestSpec,
    actor,
    callerIntent,
    root: path.resolve(journalRoot),
  });
  return Object.freeze({
    jobId: mutation.jobId,
    journalPath: mutation.journalPath,
    intentKeyHash: mutation.intentKeyHash,
    wireBodyDigest: mutation.wireBodyDigest,
    httpStatus: mutation.response.httpStatus,
    contentType: mutation.response.contentType,
    responseBytes: mutation.response.responseBytes,
    body: mutation.response.body,
    credentialPropagated: mutation.response.credentialPropagated,
    redirectsFollowed: mutation.response.redirectsFollowed,
    dispatchCount: 1,
  });
}
