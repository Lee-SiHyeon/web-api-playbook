import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { GeminiClientError } from './errors.mjs';
import { validateMedia } from './media.mjs';

const MAX_MEDIA_BYTES = 256 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 45_000;
const FORBIDDEN_COOKIE_NAMES = new Set(['authorization', 'proxy-authorization', 'host', 'content-length']);
const FORBIDDEN_CHALLENGE_COOKIE = /(?:clearance|challenge|captcha|cf[_-]|datadome)/i;
const OBSERVED_MEDIA_HEADER_NAMES = new Set([
  'accept', 'accept-language', 'cache-control', 'pragma', 'priority', 'referer', 'user-agent',
  'sec-ch-ua', 'sec-ch-ua-arch', 'sec-ch-ua-bitness', 'sec-ch-ua-form-factors',
  'sec-ch-ua-full-version', 'sec-ch-ua-full-version-list', 'sec-ch-ua-mobile',
  'sec-ch-ua-model', 'sec-ch-ua-platform', 'sec-ch-ua-platform-version', 'sec-ch-ua-wow64',
  'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-storage-access',
  'x-browser-channel', 'x-browser-copyright', 'x-browser-validation', 'x-browser-year', 'x-client-data',
]);

function normalizedMime(value) {
  return String(value || '').split(';', 1)[0].trim().toLowerCase();
}

function isApprovedGoogleMediaHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'lh3.google.com'
    || host === 'googleusercontent.com' || host.endsWith('.googleusercontent.com')
    || host === 'gstatic.com' || host.endsWith('.gstatic.com')
    || host === 'usercontent.google.com' || host.endsWith('.usercontent.google.com');
}

function safeRef(value) {
  let url;
  try { url = value instanceof URL ? value : new URL(value); }
  catch { throw new GeminiClientError('MEDIA_DOWNLOAD_URL_INVALID', 'The task media URL is invalid.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new GeminiClientError('MEDIA_DOWNLOAD_URL_INVALID', 'The task media URL must use HTTPS without credentials or fragments.');
  }
  const pathFamily = url.pathname.split('/').map((part) => (
    part.length > 40 || /^[0-9a-f-]{16,}$/i.test(part) ? '{id}' : part
  )).join('/');
  return Object.freeze({
    origin: url.origin,
    pathFamily,
    queryKeyNames: Object.freeze([...new Set(url.searchParams.keys())].sort()),
  });
}

function exactOriginAllowlist(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 8) {
    throw new GeminiClientError('MEDIA_DOWNLOAD_ORIGIN_NOT_OBSERVED', 'An exact observed task media origin allowlist is required.');
  }
  const allowed = new Set();
  for (const value of values) {
    const ref = safeRef(value);
    const url = new URL(value);
    if (url.pathname !== '/' || url.search || !url.origin.startsWith('https://') || !isApprovedGoogleMediaHost(url.hostname)) {
      throw new GeminiClientError('MEDIA_DOWNLOAD_ORIGIN_NOT_OBSERVED', 'The media origin allowlist contains a URL instead of an exact HTTPS origin.');
    }
    allowed.add(ref.origin);
  }
  return allowed;
}

function domainMatches(cookieDomain, host) {
  if (typeof cookieDomain !== 'string' || !cookieDomain) return false;
  const domain = cookieDomain.toLowerCase().replace(/^\./, '');
  const normalizedHost = String(host || '').toLowerCase();
  return normalizedHost === domain || normalizedHost.endsWith(`.${domain}`);
}

function pathMatches(cookiePath, requestPath) {
  if (typeof cookiePath !== 'string' || !cookiePath.startsWith('/')) return false;
  if (requestPath === cookiePath) return true;
  const prefix = cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`;
  return requestPath.startsWith(prefix);
}

function selectScopedCookies(cookies, observedCookieNames, targetUrl) {
  if (!Array.isArray(cookies) || !Array.isArray(observedCookieNames)) {
    throw new GeminiClientError('MEDIA_COOKIE_SCOPE_INVALID', 'Observed native cookie metadata is required.');
  }
  const observedNames = [...new Set(observedCookieNames.map((name) => String(name)))].sort();
  if (observedNames.some((name) => !/^[A-Za-z0-9_.$-]{1,128}$/.test(name)
      || FORBIDDEN_COOKIE_NAMES.has(name.toLowerCase()) || FORBIDDEN_CHALLENGE_COOKIE.test(name))) {
    throw new GeminiClientError('MEDIA_COOKIE_SCOPE_INVALID', 'A native media request cookie name is invalid.');
  }
  const now = Date.now() / 1000;
  const applicable = new Map();
  for (const cookie of cookies) {
    if (!cookie || typeof cookie !== 'object' || typeof cookie.name !== 'string' || typeof cookie.value !== 'string') continue;
    if (!observedNames.includes(cookie.name) || !domainMatches(cookie.domain, targetUrl.hostname)
        || !pathMatches(cookie.path, targetUrl.pathname)) continue;
    if (typeof cookie.expires === 'number' && cookie.expires > 0 && cookie.expires <= now) continue;
    if (cookie.value.includes(';') || /[\r\n\0]/.test(cookie.value)) continue;
    const existing = applicable.get(cookie.name);
    if (existing && (existing.value !== cookie.value || existing.domain !== cookie.domain || existing.path !== cookie.path)) {
      throw new GeminiClientError('MEDIA_COOKIE_SCOPE_AMBIGUOUS', 'Multiple different scoped cookies share an observed media cookie name.');
    }
    if (!existing) applicable.set(cookie.name, Object.freeze({
      name: cookie.name, value: cookie.value,
      domain: cookie.domain, path: cookie.path, secure: cookie.secure === true,
    }));
  }
  const missing = observedNames.filter((name) => !applicable.has(name));
  if (missing.length) {
    throw new GeminiClientError('MEDIA_COOKIE_SCOPE_MISMATCH', 'The current HTTPS session has no domain- and path-scoped cookie for every name observed on the task media request.');
  }
  return Object.freeze([...applicable.values()]);
}

function validateNativeObservation(url, observed) {
  if (!observed || typeof observed !== 'object' || observed.exactUrlMatched !== true
      || observed.method !== 'GET' || ![200, 206].includes(observed.httpStatus)) {
    throw new GeminiClientError('MEDIA_NATIVE_GET_NOT_OBSERVED', 'A successful exact task-owned native GET observation is required.');
  }
  const sourceRef = safeRef(url);
  if (observed.origin !== sourceRef.origin || observed.pathFamily !== sourceRef.pathFamily
      || !Array.isArray(observed.queryKeyNames)
      || JSON.stringify([...new Set(observed.queryKeyNames)].sort()) !== JSON.stringify([...sourceRef.queryKeyNames])) {
    throw new GeminiClientError('MEDIA_NATIVE_GET_MISMATCH', 'The native media GET did not match the exact task URL contract.');
  }
  if (typeof observed.mime !== 'string' || !normalizedMime(observed.mime).startsWith(`${observed.capability || 'video'}/`)) {
    throw new GeminiClientError('MEDIA_NATIVE_GET_MISMATCH', 'The native media response did not report a media MIME type.');
  }
  return sourceRef;
}

function sameRef(left, right) {
  return left.origin === right.origin && left.pathFamily === right.pathFamily
    && JSON.stringify(left.queryKeyNames) === JSON.stringify(right.queryKeyNames);
}

function resourceIdentityDigest(value) {
  const url = value instanceof URL ? value : new URL(value);
  const segments = url.pathname.split('/').filter(Boolean);
  const resource = segments.at(-1) ?? '';
  // Native Gemini image redirects change /gg to /rd-gg while keeping the opaque
  // terminal resource segment; retain the exact query so signing values cannot drift.
  return createHash('sha256').update(`${resource}\0${url.search}`).digest('hex');
}

function observedGgRedirectFamily(edge) {
  if (!edge?.from || !edge?.to || edge.from.queryKeyNames?.length !== 0 || edge.to.queryKeyNames?.length !== 0) return false;
  return (edge.from.origin === 'https://lh3.googleusercontent.com' && edge.from.pathFamily === '/gg/{id}'
      && edge.to.origin === 'https://lh3.google.com' && edge.to.pathFamily === '/rd-gg/{id}')
    || (edge.from.origin === 'https://lh3.google.com' && edge.from.pathFamily === '/rd-gg/{id}'
      && edge.to.origin === 'https://lh3.googleusercontent.com' && edge.to.pathFamily === '/rd-gg/{id}');
}

function terminalResourceSegment(url) {
  return url.pathname.split('/').filter(Boolean).at(-1) ?? '';
}

function sameTerminalResourceAndQuery(fromUrl, toUrl) {
  return terminalResourceSegment(fromUrl) !== ''
    && terminalResourceSegment(fromUrl) === terminalResourceSegment(toUrl)
    && fromUrl.search === toUrl.search;
}

function redirectTargetMatches(edge, currentRef, currentUrl, requireExactIdentity, sourceUrl) {
  if (!edge?.to || !sameRef(currentRef, edge.to)) return false;
  if (edge.resourceIdentity === 'task_bound_source_reference_with_observed_path_family') return true;
  if (edge.resourceIdentity === 'same_terminal_resource_segment_and_query') {
    return sameTerminalResourceAndQuery(sourceUrl, currentUrl);
  }
  return !requireExactIdentity || edge.toResourceIdentitySha256 === resourceIdentityDigest(currentUrl)
    || observedGgRedirectFamily(edge);
}

function inspectRedirectEdge(fromUrl, toUrl, fromRef, toRef, status, edges, requireExactIdentity) {
  if (!Array.isArray(edges) || edges.length > MAX_REDIRECTS) return { referenceMatched: false };
  const candidate = edges.find((edge) => edge && edge.httpStatus === status
    && edge.from && edge.to && sameRef(fromRef, edge.from) && sameRef(toRef, edge.to));
  if (!candidate) return { referenceMatched: false };
  const fromIdentityMatched = candidate.fromResourceIdentitySha256 === resourceIdentityDigest(fromUrl);
  const toIdentityMatched = candidate.toResourceIdentitySha256 === resourceIdentityDigest(toUrl);
  const contractResourceIdentityMatched = candidate.resourceIdentity === 'same_terminal_resource_segment_and_query'
    && sameTerminalResourceAndQuery(fromUrl, toUrl);
  const taskBoundObservedPathFamily = candidate.resourceIdentity === 'task_bound_source_reference_with_observed_path_family';
  const querylessGgRedirectNormalization = observedGgRedirectFamily(candidate)
    && /^[a-f0-9]{64}$/.test(candidate.fromResourceIdentitySha256 ?? '')
    && /^[a-f0-9]{64}$/.test(candidate.toResourceIdentitySha256 ?? '');
  const normalizedIdentityAccepted = fromIdentityMatched && toIdentityMatched
    || querylessGgRedirectNormalization || contractResourceIdentityMatched || taskBoundObservedPathFamily;
  return {
    referenceMatched: true,
    ...(requireExactIdentity ? { fromIdentityMatched, toIdentityMatched } : {}),
    identityNormalization: fromIdentityMatched && toIdentityMatched ? 'exact_resource_identity'
      : contractResourceIdentityMatched ? 'same_terminal_resource_segment_and_query'
      : taskBoundObservedPathFamily ? 'hNv_bound_source_and_observed_redirect_path_family'
      : querylessGgRedirectNormalization ? 'observed_queryless_gg_rd_gg_redirect_family' : 'opaque_resource_identity_mismatch',
    accepted: !requireExactIdentity || normalizedIdentityAccepted,
  };
}

function selectObservedMediaHeaders(values, observedHeaderNames) {
  if (values === undefined) return Object.freeze({});
  if (!values || typeof values !== 'object' || Array.isArray(values) || !Array.isArray(observedHeaderNames)) {
    throw new GeminiClientError('MEDIA_NATIVE_HEADERS_INVALID', 'Native media request header evidence is malformed.');
  }
  const observed = new Set(observedHeaderNames.map((name) => String(name).toLowerCase()));
  const result = {};
  for (const [rawName, value] of Object.entries(values)) {
    const name = rawName.toLowerCase();
    if (!OBSERVED_MEDIA_HEADER_NAMES.has(name) || !observed.has(name)
        || typeof value !== 'string' || value.length > 8192 || /[\r\n\0]/.test(value)) {
      throw new GeminiClientError('MEDIA_NATIVE_HEADERS_INVALID', 'Only bounded headers captured on the exact task media GET can be forwarded.');
    }
    result[name] = value;
  }
  return Object.freeze(result);
}

function detectDeclaredMedia(body, mime, kind) {
  const declared = normalizedMime(mime);
  try {
    const verified = validateMedia(body, declared, kind);
    return { mime: verified.mime, kind: verified.kind };
  } catch {
    if (kind === 'image' && declared === 'image/svg+xml') {
      const sample = body.subarray(0, Math.min(body.length, 4096)).toString('utf8').replace(/^\uFEFF/, '').trimStart();
      if (/^(?:<\?xml[^>]*>\s*)?<svg\b/i.test(sample)) return { mime: declared, kind };
    }
    if (kind === 'image' && declared === 'image/avif'
        && body.length >= 12 && body.toString('ascii', 4, 8) === 'ftyp'
        && ['avif', 'avis'].includes(body.toString('ascii', 8, 12))) return { mime: declared, kind };
    if (kind === 'video' && declared === 'video/quicktime'
        && body.length >= 12 && body.toString('ascii', 4, 8) === 'ftyp'
        && body.toString('ascii', 8, 12) === 'qt  ') return { mime: declared, kind };
    throw new GeminiClientError('MEDIA_FORMAT_INVALID', 'The downloaded media did not match its declared MIME type and signature.');
  }
}

function imageDimensions(body, mime) {
  if (mime === 'image/png' && body.length >= 24
      && body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    const width = body.readUInt32BE(16);
    const height = body.readUInt32BE(20);
    return width > 0 && height > 0 ? Object.freeze({ width, height }) : null;
  }
  return null;
}

async function readBoundedBody(response, { maxBytes, deadline, abortController }) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new GeminiClientError('MEDIA_DOWNLOAD_TOO_LARGE', 'The media response exceeds the configured size limit.');
  }
  if (!response.body) throw new GeminiClientError('MEDIA_DOWNLOAD_BODY_MISSING', 'The media response has no body.');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      if (Date.now() > deadline) {
        abortController.abort();
        await reader.cancel().catch(() => {});
        throw new GeminiClientError('MEDIA_DOWNLOAD_TIMEOUT', 'The media response exceeded its total time limit.');
      }
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        abortController.abort();
        await reader.cancel().catch(() => {});
        throw new GeminiClientError('MEDIA_DOWNLOAD_TOO_LARGE', 'The media response exceeds the configured size limit.');
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof GeminiClientError) throw error;
    throw new GeminiClientError('MEDIA_DOWNLOAD_READ_FAILED', 'The media response could not be read.');
  }
  return Buffer.concat(chunks, length);
}

async function persistAndReadback({ body, mime, kind, artifactRoot, artifactName, previousArtifactPath }) {
  const metadata = detectDeclaredMedia(body, mime, kind);
  const dimensions = kind === 'image' ? imageDimensions(body, metadata.mime) : null;
  if (typeof artifactRoot !== 'string' || !path.isAbsolute(artifactRoot)
      || typeof artifactName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(artifactName)) {
    throw new GeminiClientError('MEDIA_OUTPUT_INVALID', 'An absolute artifact directory and safe filename are required.');
  }
  const root = path.resolve(artifactRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = path.join(root, artifactName);
  let handle;
  try {
    handle = await open(target, 'wx', 0o600);
    await handle.writeFile(body);
    await handle.sync();
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (error?.code === 'EEXIST') throw new GeminiClientError('MEDIA_OUTPUT_EXISTS', 'The direct HTTP artifact path already exists.');
    throw new GeminiClientError('MEDIA_WRITE_FAILED', 'The direct HTTP media artifact could not be saved.');
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
  const readback = await readFile(target);
  const readbackMetadata = detectDeclaredMedia(readback, metadata.mime, kind);
  const readbackDimensions = kind === 'image' ? imageDimensions(readback, readbackMetadata.mime) : null;
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const fileHash = createHash('sha256').update(readback).digest('hex');
  let previousHash = null;
  if (previousArtifactPath) {
    try { previousHash = createHash('sha256').update(await readFile(previousArtifactPath)).digest('hex'); }
    catch { previousHash = null; }
  }
  if (body.length !== readback.length || bodyHash !== fileHash || readbackMetadata.mime !== metadata.mime) {
    throw new GeminiClientError('MEDIA_FILE_READBACK_MISMATCH', 'The saved media did not match its independent file readback.');
  }
  return Object.freeze({
    filename: path.basename(target),
    path: target,
    mime: metadata.mime,
    kind: metadata.kind,
    bytes: readback.length,
    sha256: fileHash,
    magicVerified: true,
    independentFileReadback: true,
    previousArtifactHashMatched: previousHash !== null && previousHash === fileHash,
    ...(dimensions ? { dimensions, independentDimensionReadback: JSON.stringify(dimensions) === JSON.stringify(readbackDimensions) } : {}),
  });
}

async function downloadWithPlan({
  url, capability, sourceRef, expectedMimeTypes, sourceHeaderNames, sourceHeaders, sourceCookieNames,
  cookieCookies, observedRedirectEdges, requireExactRedirectIdentity, allowedOrigins,
  artifactRoot, artifactName, previousArtifactPath, fetchImpl, maxBytes, timeoutMs,
  downloadAuthorization,
} = {}) {
  if (!['image', 'video'].includes(capability) || typeof fetchImpl !== 'function'
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_MEDIA_BYTES
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new GeminiClientError('MEDIA_DOWNLOAD_OPTIONS_INVALID', 'The media download options are invalid.');
  }
  const source = new URL(url);
  const allowed = exactOriginAllowlist(allowedOrigins);
  if (!allowed.has(source.origin)) {
    throw new GeminiClientError('MEDIA_DOWNLOAD_ORIGIN_NOT_OBSERVED', 'The exact task media origin is not allowlisted.');
  }
  const sourceCookies = selectScopedCookies(cookieCookies, sourceCookieNames, source);
  const browserCookieNames = [...sourceCookies.map((cookie) => cookie.name)].sort();
  const observedCookieNames = [...new Set(sourceCookieNames)].sort();
  if (JSON.stringify(browserCookieNames) !== JSON.stringify(observedCookieNames)) {
    throw new GeminiClientError('MEDIA_COOKIE_SCOPE_MISMATCH', 'The cookie names and scopes do not match the owned task native GET.');
  }
  const edges = Array.isArray(observedRedirectEdges) ? observedRedirectEdges.slice(0, MAX_REDIRECTS) : [];
  if (requireExactRedirectIdentity && edges.some((edge) => {
    const names = Array.isArray(edge?.cookieNames) ? edge.cookieNames : [];
    return edge?.cookieHeaderPresent !== (names.length > 0);
  })) {
    throw new GeminiClientError('MEDIA_NATIVE_COOKIE_EVIDENCE_INVALID', 'A native redirect hop had inconsistent cookie metadata.');
  }
  let current = source;
  const redirects = [];
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let response;
  let sourceCookiesForwarded = false;
  const sentObservedHeaderNames = new Set();
  const forwardedCookies = new Map();
  const cookiesByRequestHop = [];
  let finalAbortController = null;
  let finalTimeout = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (Date.now() > deadline) throw new GeminiClientError('MEDIA_DOWNLOAD_TIMEOUT', 'The media download exceeded its total time limit.');
    const currentRef = safeRef(current);
    const redirectEvidence = current.origin === source.origin && sameRef(currentRef, sourceRef)
      ? null : edges.find((edge) => redirectTargetMatches(edge, currentRef, current, requireExactRedirectIdentity, source));
    const currentCookieNames = redirectEvidence
      ? [...new Set(redirectEvidence.cookieNames ?? [])].sort()
      : current.origin === source.origin && sameRef(currentRef, sourceRef) ? observedCookieNames : [];
    const sendCookies = selectScopedCookies(cookieCookies, currentCookieNames, current);
    const headers = new Headers();
    const requestObservedHeaders = current.origin === source.origin && sameRef(currentRef, sourceRef)
      ? sourceHeaders
      : (redirectEvidence?.observedHeaders ?? {});
    const redirectHeaderNames = current.origin === source.origin && sameRef(currentRef, sourceRef)
      ? sourceHeaderNames
      : (redirectEvidence?.headerNames ?? []);
    const observedHeaders = selectObservedMediaHeaders(requestObservedHeaders, redirectHeaderNames);
    for (const [name, value] of Object.entries(observedHeaders)) {
      headers.set(name, value);
      sentObservedHeaderNames.add(name);
    }
    if (sendCookies.length) {
      headers.set('cookie', sendCookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '));
      if (current.origin === source.origin && sameRef(currentRef, sourceRef)) sourceCookiesForwarded = true;
      for (const cookie of sendCookies) {
        forwardedCookies.set(`${cookie.name}\0${cookie.domain}\0${cookie.path}`, cookie);
      }
    }
    cookiesByRequestHop.push(Object.freeze({
      origin: current.origin,
      pathFamily: currentRef.pathFamily,
      cookieNames: Object.freeze(sendCookies.map((cookie) => cookie.name).sort()),
    }));
    const abortController = new AbortController();
    const remaining = Math.max(1, Math.min(timeoutMs, deadline - Date.now()));
    const timeout = setTimeout(() => abortController.abort(), remaining);
    try {
      response = await fetchImpl(current, {
        method: 'GET', headers, redirect: 'manual', signal: abortController.signal,
      });
    } catch {
      clearTimeout(timeout);
      throw new GeminiClientError('MEDIA_DOWNLOAD_TRANSPORT_FAILED', 'The task media HTTP request failed.');
    }
    if (response.status >= 300 && response.status < 400) {
      clearTimeout(timeout);
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location || hop === MAX_REDIRECTS) {
        throw new GeminiClientError('MEDIA_REDIRECT_LIMIT', 'The task media redirect limit was reached.');
      }
      let next;
      try { next = new URL(location, current); }
      catch { throw new GeminiClientError('MEDIA_REDIRECT_INVALID', 'The task media redirect URL is invalid.'); }
      if (next.protocol !== 'https:' || next.username || next.password || next.hash) {
        throw new GeminiClientError('MEDIA_REDIRECT_BLOCKED', 'The task media redirect did not remain on HTTPS.');
      }
      const targetRef = safeRef(next);
      const redirectProof = inspectRedirectEdge(
        current, next, currentRef, targetRef, response.status, edges, requireExactRedirectIdentity,
      );
      if (!allowed.has(next.origin) || redirectProof.accepted !== true) {
        throw new GeminiClientError('MEDIA_REDIRECT_NOT_TASK_OBSERVED', 'The redirect destination was not observed on the exact task media request.', {
          httpStatus: response.status,
          from: currentRef,
          to: targetRef,
          targetOriginAllowed: allowed.has(next.origin),
          redirectProof,
        });
      }
      redirects.push(Object.freeze({
        httpStatus: response.status,
        from: currentRef,
        to: targetRef,
        resourceIdentityNormalization: redirectProof.identityNormalization,
        cookieNamesSentOnFromHop: Object.freeze(sendCookies.map((cookie) => cookie.name).sort()),
        cookieNamesObservedOnTargetHop: Object.freeze([...new Set(edges.find((edge) => redirectTargetMatches(
          edge, targetRef, next, requireExactRedirectIdentity, source,
        ))?.cookieNames ?? [])].sort()),
      }));
      current = next;
      continue;
    }
    if (response.status !== 200) {
      clearTimeout(timeout);
      await response.body?.cancel().catch(() => {});
      throw new GeminiClientError('MEDIA_DOWNLOAD_HTTP_REJECTED', 'The task media request returned a non-success status.', {
        httpStatus: response.status,
        origin: currentRef.origin,
        pathFamily: currentRef.pathFamily,
        queryKeyNames: currentRef.queryKeyNames,
      });
    }
    finalAbortController = abortController;
    finalTimeout = timeout;
    break;
  }
  const contentType = normalizedMime(response.headers.get('content-type'));
  if (!expectedMimeTypes.includes(contentType)) {
    if (finalTimeout) clearTimeout(finalTimeout);
    await response.body?.cancel().catch(() => {});
    throw new GeminiClientError('MEDIA_NATIVE_RESPONSE_MISMATCH', 'The direct task media response MIME did not match its installed asset contract.');
  }
  let body;
  try {
    body = await readBoundedBody(response, {
      maxBytes, deadline, abortController: finalAbortController,
    });
  } catch (error) {
    if (error instanceof GeminiClientError) throw error;
    throw new GeminiClientError('MEDIA_DOWNLOAD_READ_FAILED', 'The task media response could not be read.');
  } finally {
    if (finalTimeout) clearTimeout(finalTimeout);
  }
  try {
    const metadata = detectDeclaredMedia(body, contentType, capability);
    const artifact = await persistAndReadback({
      body, mime: metadata.mime, kind: metadata.kind,
      artifactRoot, artifactName, previousArtifactPath,
    });
    return Object.freeze({
      httpStatus: response.status,
      contentType,
      mime: metadata.mime,
      capability,
      bytes: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
      mimeMagicMatched: true,
      ...(metadata.kind === 'image' && imageDimensions(body, metadata.mime)
        ? { dimensions: imageDimensions(body, metadata.mime) } : {}),
      independentFileReadback: artifact.independentFileReadback,
      credentialForwarding: Object.freeze({
        sourceOrigin: source.origin,
        cookieNames: Object.freeze([...new Set([...forwardedCookies.values()].map((cookie) => cookie.name))].sort()),
        cookieDomainScopes: Object.freeze([...forwardedCookies.values()].map(({ name, domain, path: cookiePath, secure }) => Object.freeze({
          name, domain, path: cookiePath, secure,
        }))),
        cookiesForwardedToSource: sourceCookiesForwarded,
        cookiesForwardedToCrossOriginRedirects: cookiesByRequestHop.some((hop, index) => index > 0
          && hop.origin !== source.origin && hop.cookieNames.length > 0),
        cookiesByRequestHop: Object.freeze(cookiesByRequestHop),
      }),
      observedRequestHeaderNamesForwarded: Object.freeze([...sentObservedHeaderNames].sort()),
      redirects: Object.freeze(redirects),
      downloadAuthorization,
      browserAssetGetPerformed: downloadAuthorization === 'native_get_observation',
      artifact,
    });
  } finally {
    body.fill(0);
  }
}

/** Download one task-bound media URL after an exact native GET observation. */
export async function downloadGeminiMediaAssetOnce({
  url,
  capability,
  observedNativeRequest,
  observedNativeHeaders = {},
  cookieCookies = [],
  observedRedirectEdges = [],
  requireExactRedirectIdentity = false,
  allowedOrigins = [],
  artifactRoot,
  artifactName,
  previousArtifactPath = null,
  fetchImpl = globalThis.fetch,
  maxBytes = MAX_MEDIA_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const sourceRef = validateNativeObservation(url, { ...observedNativeRequest, capability });
  const sourceHeaders = selectObservedMediaHeaders(observedNativeHeaders, observedNativeRequest.headerNames ?? []);
  return downloadWithPlan({
    url, capability, sourceRef,
    expectedMimeTypes: [normalizedMime(observedNativeRequest.mime)],
    sourceHeaderNames: observedNativeRequest.headerNames ?? [],
    sourceHeaders,
    sourceCookieNames: observedNativeRequest.cookieNames ?? [],
    cookieCookies,
    observedRedirectEdges,
    requireExactRedirectIdentity,
    allowedOrigins,
    artifactRoot,
    artifactName,
    previousArtifactPath,
    fetchImpl,
    maxBytes,
    timeoutMs,
    downloadAuthorization: 'native_get_observation',
  });
}

/**
 * Download an hNvQHb-owned asset using its installed source/redirect contract and current scoped session.
 * The caller must first prove the asset URL came from an exact prompt+API-ID-bound detail result.
 */
export async function downloadGeminiTaskMediaAssetOnce({
  url,
  capability,
  mediaAssetContract,
  cookieCookies = [],
  allowedOrigins = [],
  artifactRoot,
  artifactName,
  previousArtifactPath = null,
  fetchImpl = globalThis.fetch,
  maxBytes = MAX_MEDIA_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!mediaAssetContract || mediaAssetContract.version !== 1
      || mediaAssetContract.taskBinding !== 'hNvQHb_prompt_and_api_id') {
    throw new GeminiClientError('MEDIA_TASK_CONTRACT_NOT_CAPTURED', 'An observed hNvQHb task media contract is required.');
  }
  let sourceUrl;
  try { sourceUrl = new URL(url); }
  catch { throw new GeminiClientError('MEDIA_DOWNLOAD_URL_INVALID', 'The task media URL is invalid.'); }
  const sourceRef = safeRef(sourceUrl);
  const candidates = mediaAssetContract.sources.filter((item) => item.capability === capability
    && item.origin === sourceRef.origin && item.pathFamily === sourceRef.pathFamily
    && JSON.stringify(item.queryKeyNames) === JSON.stringify(sourceRef.queryKeyNames));
  if (candidates.length !== 1) {
    throw new GeminiClientError('MEDIA_TASK_ASSET_NOT_OBSERVED', 'The hNvQHb asset does not match one installed media source family.');
  }
  const sourceContract = candidates[0];
  const edges = mediaAssetContract.redirectEdges.map((edge) => ({
    ...edge,
    cookieHeaderPresent: edge.cookieNames.length > 0,
    observedHeaders: Object.freeze({}),
  }));
  const contractOrigins = [...new Set([
    sourceContract.origin,
    ...edges.flatMap((edge) => [edge.from.origin, edge.to.origin]),
  ])];
  if (contractOrigins.some((origin) => !allowedOrigins.includes(origin))) {
    throw new GeminiClientError('MEDIA_DOWNLOAD_ORIGIN_NOT_OBSERVED', 'The task media contract includes an origin outside the observed asset allowlist.');
  }
  const cookieScopes = new Map(mediaAssetContract.cookieScopes.map((scope) => [scope.name, scope]));
  for (const cookie of cookieCookies) {
    const scope = cookieScopes.get(cookie?.name);
    if (scope && (cookie.domain !== scope.domain || cookie.path !== scope.path || cookie.secure !== scope.secure)) {
      throw new GeminiClientError('MEDIA_COOKIE_SCOPE_MISMATCH', 'The current session media cookie does not match its installed scope.');
    }
  }
  return downloadWithPlan({
    url: sourceUrl.href,
    capability,
    sourceRef,
    expectedMimeTypes: sourceContract.mimeTypes,
    sourceHeaderNames: sourceContract.headerNames,
    sourceHeaders: Object.freeze({}),
    sourceCookieNames: [],
    cookieCookies,
    observedRedirectEdges: edges,
    requireExactRedirectIdentity: true,
    allowedOrigins: contractOrigins,
    artifactRoot,
    artifactName,
    previousArtifactPath,
    fetchImpl,
    maxBytes,
    timeoutMs,
    downloadAuthorization: 'hNv_task_contract_and_current_session',
  });
}
