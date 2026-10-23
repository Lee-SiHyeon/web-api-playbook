import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parse } from 'parse5';
import iconv from 'iconv-lite';

export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
export const DEFAULT_CAPTURE_DIR = 'C:/Users/User/AppData/Local/Temp/html-parser-captures';
const GOOGLE_MAPS_API_KEY_LITERAL = /AIza[0-9A-Za-z_-]{20,}/g;
const hostQueues = new Map();
const hostLastStarted = new Map();
const digest = value => createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export const parseHtml = html => parse(String(html));
export function* walk(node) {
  yield node;
  for (const child of node.childNodes ?? []) yield* walk(child);
  if (node.content) yield* walk(node.content);
}
export const findAll = (node, predicate) => [...walk(node)].filter(predicate);
export const attr = (node, name) => node.attrs?.find(item => item.name === name)?.value ?? null;
export const hasClass = (node, name) => (attr(node, 'class') ?? '').split(/\s+/).includes(name);
export function textContent(node) {
  if (!node || ['script', 'style', 'template'].includes(node.tagName)) return '';
  if (node.nodeName === '#text') return node.value;
  if (node.tagName === 'br') return '\n';
  const content = (node.childNodes ?? []).map(textContent).join('');
  return /^(p|div|li|tr|h[1-6]|dt|dd|section|article)$/.test(node.tagName ?? '') ? `${content}\n` : content;
}
export function links(node, baseUrl) {
  return findAll(node, item => item.tagName === 'a' && attr(item, 'href')).flatMap(item => {
    try {
      const url = new URL(attr(item, 'href'), baseUrl);
      if (!['https:', 'http:'].includes(url.protocol)) return [];
      return [{ text: textContent(item).replace(/\s+/g, ' ').trim(), url: url.href, node: item }];
    } catch { return []; }
  });
}

/** Use the explicit CP949 decoder: Node/ICU euc-kr misses Windows-949 extensions. */
export function decodeHtml(bytes, contentType = '') {
  const buffer = Buffer.from(bytes);
  const transportCharset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1];
  const probe = parse(buffer.subarray(0, 65536).toString('latin1'));
  const metas = findAll(probe, node => node.tagName === 'meta');
  const metaCharset = metas.map(node => attr(node, 'charset') ||
    (/^content-type$/i.test(attr(node, 'http-equiv') ?? '') ? /charset\s*=\s*([^\s;]+)/i.exec(attr(node, 'content') ?? '')?.[1] : null)).find(Boolean);
  const bomCharset = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? 'utf-8' :
    buffer[0] === 0xff && buffer[1] === 0xfe ? 'utf-16le' : buffer[0] === 0xfe && buffer[1] === 0xff ? 'utf-16be' : null;
  const requested = String(bomCharset || transportCharset || metaCharset || 'utf-8').toLowerCase().replace(/["']/g, '');
  const charset = /^(cp949|windows-949|ms949|ks_c_5601-1987|ks_c_5601-1989|euc_kr)$/.test(requested) ? 'euc-kr' : requested;
  try { return { html: charset === 'euc-kr' ? iconv.decode(buffer, 'cp949') : new TextDecoder(charset).decode(buffer), charset }; }
  catch { throw Object.assign(new Error(`HTML_CHARSET_UNSUPPORTED: ${charset}`), { code: 'HTML_CHARSET_UNSUPPORTED' }); }
}

export function structuralFingerprint(selectors, headerLabels = []) {
  const selectorSet = [...new Set(selectors)].sort();
  const labels = headerLabels.map(label => String(label).replace(/\s+/g, ' ').trim());
  const headerHash = digest(JSON.stringify(labels));
  return { selectors: selectorSet, headerLabels: labels, headerHash, hash: digest(JSON.stringify([selectorSet, headerHash])) };
}
export function assertLayout(actual, expected, { rowCount, minRows = 1, maxRows = null, expectedRows = null, rowTolerance = 0 } = {}) {
  if (!expected || actual.hash !== expected.hash ||
      (rowCount != null && (rowCount < minRows || (maxRows != null && rowCount > maxRows) ||
        (expectedRows != null && Math.abs(rowCount - expectedRows) > rowTolerance)))) {
    throw Object.assign(new Error('HTML_LAYOUT_CHANGED'), { code: 'HTML_LAYOUT_CHANGED', actual, expected, rowCount });
  }
  return actual;
}

function validatePublicUrl(input, allowedHosts) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      /(?:^|\/)(?:admin|administrator|manage|manager|login|signin)(?:\/|\.|$)/i.test(url.pathname) ||
      [...url.searchParams.keys()].some(key => /^(?:token|access_token|csrf|authorization|password|session|cookie)$/i.test(key)) ||
      (allowedHosts && !allowedHosts.includes(url.hostname))) {
    throw Object.assign(new Error('PUBLIC_DOCUMENT_URL_REJECTED'), { code: 'PUBLIC_DOCUMENT_URL_REJECTED' });
  }
  url.hash = '';
  return url;
}
function challengeSignal(html) {
  const doc = parseHtml(html);
  const title = textContent(findAll(doc, node => node.tagName === 'title')[0]).trim();
  const bodyText = textContent(doc).slice(0, 10000);
  // A navigation link mentioning login, or an unused CAPTCHA library, is not a challenge.
  const titleBlocked = /^(?:just a moment|attention required|access denied|verify you are human|robot check|보안 확인|접근 차단)/i.test(title);
  const smallChallenge = bodyText.length < 5000 && /(?:verify (?:that )?you are human|checking your browser|enable javascript and cookies to continue|captcha verification required)/i.test(bodyText);
  return titleBlocked || smallChallenge ? { title, reason: 'challenge_html' } : null;
}
async function paced(host, interval, operation) {
  const preceding = hostQueues.get(host) ?? Promise.resolve();
  let release;
  const mine = new Promise(resolve => { release = resolve; });
  hostQueues.set(host, mine);
  await preceding;
  try {
    await sleep(Math.max(0, interval - (Date.now() - (hostLastStarted.get(host) ?? 0))));
    hostLastStarted.set(host, Date.now());
    return await operation();
  } finally {
    release();
    if (hostQueues.get(host) === mine) hostQueues.delete(host);
  }
}

/** Anonymous public Document GET only. No cookie jar, credential provider, or browser. */
export function createPublicClient({ captureDir = DEFAULT_CAPTURE_DIR, requestLimit = 40, minIntervalMs = 2000,
  timeoutMs = 20000, allowedHosts, fetchImpl = fetch, userAgent = BROWSER_UA,
  redactGoogleMapsApiKeysBeforeCapture = false } = {}) {
  const counts = new Map();
  async function saveRaw(bytes, meta) {
    const base = `${String(meta.sourceId).replace(/[^a-z0-9_-]/gi, '-')}-${String(meta.pageType).replace(/[^a-z0-9_-]/gi, '-')}-${meta.checkedAt.replace(/[^0-9]/g, '')}-${randomUUID().slice(0, 8)}`;
    const captureFiles = { rawPath: path.join(captureDir, `${base}.raw`), metaPath: path.join(captureDir, `${base}.meta.json`) };
    let storedBytes = bytes;
    if (redactGoogleMapsApiKeysBeforeCapture) {
      const latin1 = bytes.toString('latin1');
      const redactionCount = [...latin1.matchAll(/AIza[0-9A-Za-z_-]{20,}/g)].length;
      if (redactionCount) storedBytes = Buffer.from(latin1.replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_GOOGLE_MAPS_API_KEY]'), 'latin1');
      const rawOriginalSha256 = meta.sha256 ?? digest(bytes);
      Object.assign(meta, {
        rawOriginalSha256,
        sanitizedStoredSha256: digest(storedBytes),
        redacted: redactionCount > 0,
        redactionType: redactionCount > 0 ? 'google_maps_api_key_literal' : null,
        redactionCount,
        sanitizedStoredBytes: storedBytes.length,
      });
    }
    await fs.mkdir(captureDir, { recursive: true });
    await fs.writeFile(captureFiles.rawPath, storedBytes);
    await fs.writeFile(captureFiles.metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    return captureFiles;
  }
  return {
    counts,
    async get(input, { sourceId = 'public', pageType = 'document' } = {}) {
      const original = validatePublicUrl(input, allowedHosts);
      const checkedAt = new Date().toISOString();
      let current = original;
      let response;
      let bytes = Buffer.alloc(0);
      let html = '';
      let charset = null;
      let error = null;
      let requestStartedAt = null;
      const redirectChain = [];
      try {
        for (let hop = 0; hop <= 5; hop++) {
          const used = counts.get(sourceId) ?? 0;
          if (used >= requestLimit) throw Object.assign(new Error('PUBLIC_REQUEST_BUDGET_EXHAUSTED'), { code: 'PUBLIC_REQUEST_BUDGET_EXHAUSTED' });
          counts.set(sourceId, used + 1);
          response = await paced(current.hostname, minIntervalMs, () => {
            requestStartedAt = new Date().toISOString();
            return fetchImpl(current.href, {
            method: 'GET', redirect: 'manual', credentials: 'omit',
            headers: { ...(userAgent ? { 'user-agent': userAgent } : {}), 'accept-language': 'ko-KR,ko;q=0.9,en;q=0.6', accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
            signal: AbortSignal.timeout(timeoutMs)
            });
          });
          bytes = Buffer.from(await response.arrayBuffer());
          if (![301, 302, 303, 307, 308].includes(response.status)) break;
          const location = response.headers.get('location');
          if (!location || hop === 5) throw Object.assign(new Error('PUBLIC_REDIRECT_INVALID'), { code: 'PUBLIC_REDIRECT_INVALID' });
          const next = validatePublicUrl(new URL(location, current).href, allowedHosts);
          const captureFiles = await saveRaw(bytes, { sourceId, pageType: `${pageType}-redirect`, method: 'GET', requestedUrl: current.href,
            finalUrl: current.href, checkedAt: new Date().toISOString(), requestStartedAt, status: response.status,
            contentType: response.headers.get('content-type'), bytes: bytes.length, sha256: digest(bytes), location: next.href,
            executionMode: 'pure_http', credentialState: 'not_applicable_public_anonymous' });
          redirectChain.push({ from: current.href, status: response.status, to: next.href, captureFiles });
          current = next;
        }
        ({ html, charset } = decodeHtml(bytes, response?.headers.get('content-type') ?? ''));
      } catch (caught) {
        error = caught.code ?? (['TimeoutError', 'AbortError'].includes(caught.name) ? 'TIMEOUT' : 'FETCH_FAILED');
      }
      const status = response?.status ?? null;
      const contentType = response?.headers.get('content-type') ?? null;
      const challenge = html ? challengeSignal(html) : null;
      if (!error && status !== 200) error = `HTTP_${status}`;
      if (!error && !/(?:text\/html|application\/xhtml\+xml)/i.test(contentType ?? '')) error = 'HTML_CONTENT_TYPE_INVALID';
      if (!error && challenge) error = 'CHALLENGE_HTML';
      const meta = { sourceId, pageType, method: 'GET', requestedUrl: original.href, finalUrl: current.href,
        checkedAt, requestStartedAt, status, contentType, charset, bytes: bytes.length, sha256: digest(bytes), redirectChain,
        requestHeaderNames: [...(userAgent ? ['user-agent'] : []), 'accept-language', 'accept'], executionMode: 'pure_http',
        credentialState: 'not_applicable_public_anonymous', error, challenge };
      let captureFiles = null;
      try {
        captureFiles = await saveRaw(bytes, meta);
      } catch { error ||= 'CAPTURE_SAVE_FAILED'; }
      return { html, bytes, status, httpStatus: status, url: current.href, requestedUrl: original.href,
        contentType, charset, captureFiles, error, challenge, checkedAt, meta };
    }
  };
}
