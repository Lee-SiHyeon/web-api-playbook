import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  BROWSER_UA,
  createPublicClient,
  decodeHtml,
  parseHtml,
  findAll,
  attr,
  hasClass,
  textContent,
  links,
  structuralFingerprint,
  assertLayout
} from '../gov-discount-events/html-public.mjs';

export { BROWSER_UA, decodeHtml, parseHtml, findAll, attr, hasClass, textContent, links, structuralFingerprint, assertLayout };

export const cleanText = value => String(value ?? '').replace(/[\u00a0\u200b]/g, ' ').replace(/\s+/g, ' ').trim();

export function asDate(value) {
  const raw = cleanText(value);
  const ymd = /\b(20\d{2})[.\-/년]\s*(\d{1,2})[.\-/월]\s*(\d{1,2})(?:\s*일)?(?=$|[^\d])/.exec(raw);
  if (!ymd) return null;
  const year = Number(ymd[1]);
  const month = Number(ymd[2]);
  const day = Number(ymd[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const checked = new Date(Date.UTC(year, month - 1, day));
  if (checked.getUTCFullYear() !== year || checked.getUTCMonth() !== month - 1 || checked.getUTCDate() !== day) return null;
  return `${ymd[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function pageTitle(document) {
  return cleanText(findAll(document, node => node.tagName === 'title')[0] ? textContent(findAll(document, node => node.tagName === 'title')[0]) : '');
}

export function classifyDocumentError(document) {
  const title = pageTitle(document);
  const passwordField = findAll(document, node => node.tagName === 'input' && String(attr(node, 'type') ?? '').toLowerCase() === 'password').length > 0;
  const loginTitle = /(?:로그인|sign\s*in|log\s*in)/i.test(title);
  return passwordField || loginTitle ? 'LOGIN_HTML' : null;
}

export function classifyChallengeHtml(html) {
  const document = parseHtml(html);
  const title = pageTitle(document);
  const bodyText = textContent(document).slice(0, 10000);
  const titleBlocked = /^(?:just a moment|attention required|access denied|verify you are human|robot check|보안 확인|접근 차단)/i.test(title);
  const smallChallenge = bodyText.length < 5000 && /(?:verify (?:that )?you are human|checking your browser|enable javascript and cookies to continue|captcha verification required)/i.test(bodyText);
  return titleBlocked || smallChallenge ? { reason: 'challenge_html' } : null;
}

export function sanitizedUrl(input) {
  try {
    const url = new URL(input);
    return { origin: url.origin, path: url.pathname, queryKeys: [...url.searchParams.keys()].sort() };
  } catch {
    return null;
  }
}

function headerOf(response, name) {
  return response?.headers?.get?.(name) ?? null;
}

function responseDigest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function boundedResponse(response, maxBodyBytes) {
  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    throw Object.assign(new Error('PUBLIC_BODY_TOO_LARGE'), { code: 'PUBLIC_BODY_TOO_LARGE' });
  }
  if (!response.body) return response;
  let seen = 0;
  const body = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > maxBodyBytes) {
        controller.error(Object.assign(new Error('PUBLIC_BODY_TOO_LARGE'), { code: 'PUBLIC_BODY_TOO_LARGE' }));
        return;
      }
      controller.enqueue(chunk);
    }
  }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/**
 * Anonymous same-origin public-document transport. GETs use the shared HTTP
 * primitive; an explicitly observed public HTML form can be submitted as a
 * bounded urlencoded POST. Raw captures are deleted before the call returns.
 */
export async function createRentalPublicReader({
  sourceId,
  allowedHosts,
  fetchImpl = fetch,
  minIntervalMs = 2000,
  timeoutMs = 20000,
  maxBodyBytes = 5 * 1024 * 1024,
  requestLimit = 40
}) {
  const captureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rental-public-html-'));
  let seenUrls = new Set();
  let requests = 0;
  let allCaptureCleanupVerified = true;
  const lastStarted = new Map();
  const guardedFetch = async (input, init) => {
    const url = String(input);
    if (seenUrls.has(url)) throw Object.assign(new Error('HTTP_307_SELF_REDIRECT'), { code: 'HTTP_307_SELF_REDIRECT' });
    seenUrls.add(url);
    await pace(new URL(url).hostname);
    return boundedResponse(await fetchImpl(input, init), maxBodyBytes);
  };
  const publicClient = createPublicClient({
    captureDir,
    requestLimit,
    minIntervalMs: 0,
    timeoutMs,
    allowedHosts,
    fetchImpl: guardedFetch
  });

  async function pace(host) {
    const wait = Math.max(0, minIntervalMs - (Date.now() - (lastStarted.get(host) ?? 0)));
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    lastStarted.set(host, Date.now());
  }

  async function isAbsent(file) {
    try {
      await fs.lstat(file);
      return false;
    } catch (error) {
      return error?.code === 'ENOENT';
    }
  }

  async function removeCapture(result) {
    const files = new Set([result?.captureFiles?.rawPath, result?.captureFiles?.metaPath]);
    for (const entry of result?.meta?.redirectChain ?? []) {
      files.add(entry?.captureFiles?.rawPath);
      files.add(entry?.captureFiles?.metaPath);
    }
    let verified = true;
    for (const file of files) {
      if (!file) continue;
      try {
        await fs.rm(file, { force: true });
        if (!await isAbsent(file)) verified = false;
      } catch {
        verified = false;
      }
    }
    allCaptureCleanupVerified &&= verified;
    return { cleanupVerified: verified, cleanupErrorCode: verified ? null : 'CAPTURE_CLEANUP_FAILED' };
  }

  function record(result, method, url, pageType, cleanup) {
    return {
      method,
      url: sanitizedUrl(result?.requestedUrl ?? url),
      finalUrl: sanitizedUrl(result?.url ?? url),
      pageType,
      status: result?.status ?? null,
      contentType: result?.contentType ?? null,
      charset: result?.charset ?? null,
      bytes: result?.bytes?.length ?? 0,
      sha256: null,
      error: result?.error ?? null,
      challenge: result?.challenge ? { reason: result.challenge.reason ?? 'challenge_html' } : null,
      captureCleanupVerified: cleanup?.cleanupVerified ?? true,
      captureCleanupErrorCode: cleanup?.cleanupErrorCode ?? null,
      credentialState: 'not_applicable_public_anonymous'
    };
  }

  async function get(url, pageType = 'list') {
    if (++requests > requestLimit) return { html: '', error: 'PUBLIC_REQUEST_BUDGET_EXHAUSTED', record: { method: 'GET', url: sanitizedUrl(url), pageType, status: null, error: 'PUBLIC_REQUEST_BUDGET_EXHAUSTED' } };
    seenUrls = new Set();
    const result = await publicClient.get(url, { sourceId, pageType });
    const cleanup = await removeCapture(result);
    const rec = record(result, 'GET', url, pageType, cleanup);
    if (result.bytes?.length) rec.sha256 = await responseDigest(result.bytes);
    return {
      html: result.html,
      status: result.status,
      httpStatus: result.httpStatus,
      url: result.url,
      requestedUrl: result.requestedUrl,
      contentType: result.contentType,
      charset: result.charset,
      error: result.error,
      challenge: result.challenge,
      checkedAt: result.checkedAt,
      captureCleanupVerified: cleanup.cleanupVerified,
      captureCleanupErrorCode: cleanup.cleanupErrorCode,
      record: rec
    };
  }

  async function postObservedForm(url, fields, { referer, pageType = 'list' } = {}) {
    if (++requests > requestLimit) return { html: '', bytes: Buffer.alloc(0), status: null, error: 'PUBLIC_REQUEST_BUDGET_EXHAUSTED', record: { method: 'POST', url: sanitizedUrl(url), pageType, status: null, error: 'PUBLIC_REQUEST_BUDGET_EXHAUSTED' } };
    let target;
    try { target = new URL(url); } catch { return { html: '', bytes: Buffer.alloc(0), status: null, error: 'PUBLIC_DOCUMENT_URL_REJECTED', record: { method: 'POST', url: null, pageType, status: null, error: 'PUBLIC_DOCUMENT_URL_REJECTED' } }; }
    if (target.protocol !== 'https:' || !allowedHosts.includes(target.hostname) || target.username || target.password) {
      return { html: '', bytes: Buffer.alloc(0), status: null, error: 'PUBLIC_DOCUMENT_URL_REJECTED', record: { method: 'POST', url: sanitizedUrl(url), pageType, status: null, error: 'PUBLIC_DOCUMENT_URL_REJECTED' } };
    }
    let response;
    let bytes = Buffer.alloc(0);
    let decoded = { html: '', charset: null };
    let error = null;
    try {
      seenUrls = new Set();
      response = await guardedFetch(target.href, {
        method: 'POST',
        redirect: 'manual',
        credentials: 'omit',
        headers: {
          'user-agent': BROWSER_UA,
          'accept-language': 'ko-KR,ko;q=0.9,en;q=0.6',
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          ...(referer ? { referer } : {})
        },
        body: new URLSearchParams(fields).toString(),
        signal: AbortSignal.timeout(timeoutMs)
      });
      bytes = Buffer.from(await response.arrayBuffer());
      decoded = decodeHtml(bytes, headerOf(response, 'content-type') ?? '');
    } catch (caught) {
      error = caught?.code ?? (['TimeoutError', 'AbortError'].includes(caught?.name) ? 'TIMEOUT' : 'FETCH_FAILED');
    }
    const status = response?.status ?? null;
    const contentType = headerOf(response, 'content-type');
    let challenge = decoded.html ? classifyChallengeHtml(decoded.html) : null;
    if (!challenge && decoded.html && [403, 418, 429, 503].includes(status)) challenge = { reason: 'challenge_or_access_denial_unresolved' };
    if (!error && status >= 300 && status < 400) error = `HTTP_${status}_REDIRECT_NOT_FOLLOWED`;
    if (!error && status !== 200) error = `HTTP_${status}`;
    if (!error && !/(?:text\/html|application\/xhtml\+xml)/i.test(contentType ?? '')) error = 'HTML_CONTENT_TYPE_INVALID';
    if (!error && challenge) error = 'CHALLENGE_HTML';
    const rec = { method: 'POST', url: sanitizedUrl(target.href), finalUrl: sanitizedUrl(response?.url || target.href), pageType, status, contentType, charset: decoded.charset, bytes: bytes.length, sha256: bytes.length ? await responseDigest(bytes) : null, error, challenge, captureCleanupVerified: true, captureCleanupErrorCode: null, credentialState: 'not_applicable_public_anonymous' };
    return { html: decoded.html, status, contentType, charset: decoded.charset, url: response?.url || target.href, requestedUrl: target.href, error, challenge, captureCleanupVerified: true, captureCleanupErrorCode: null, record: rec };
  }

  async function close() {
    let verified = allCaptureCleanupVerified;
    try {
      await fs.rm(captureDir, { recursive: true, force: true });
      if (!await isAbsent(captureDir)) verified = false;
    } catch {
      verified = false;
    }
    return { cleanupVerified: verified, cleanupErrorCode: verified ? null : 'CAPTURE_CLEANUP_FAILED' };
  }

  return { get, postObservedForm, close };
}

export function failReceipt(status, operation, error, detail = {}) {
  return { status, ok: false, liveReplay: false, operation, error, ...detail };
}

export function rowLayout(selectors, labels = []) {
  return structuralFingerprint(selectors, labels);
}

export function ensureLayout(actual, expected, options) {
  return assertLayout(actual, expected, options);
}
