import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { classifyChallengeHtml, decodeHtml } from '../../src/rental-housing/rental-housing-public-html.mjs';
import { parseMolitNoticeList } from '../../src/rental-housing/molit-notices.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.join(here, 'observed-cookie-replay.json');
const observedUrl = new URL('https://www.molit.go.kr/USR/NEWS/m_71/lst.jsp?search_section=&search=&search_gubun=1&search_gubun1=all&srch_usr_titl=Y&srch_usr_ctnt=&psize=10&search_regdate_s=2025-10-16&search_regdate_e=2026-10-16&srch_cate=&srch_dept_nm=&search_kind=&search_gbn=&lst_gbn=T&lcmspage=2');
const observedHeaders = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/jxl,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7,ja;q=0.6,zh-CN;q=0.5,zh;q=0.4',
  referer: 'https://www.molit.go.kr/USR/NEWS/m_71/lst.jsp',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
};
const allowedObservedNames = new Set([
  'ACEUCI', 'TMOSHCooKie', 'clientid', 'SCOUTER', 'ACEFCID', 'JSESSIONID',
  'AUAH6A47309598944', 'AUFAH6A47309598944', 'ACEUACS', 'ARAH6A47309598944',
  'ASAH6A47309598944',
]);
const allowedDomains = new Set(['www.molit.go.kr', '.www.molit.go.kr', '.molit.go.kr']);
const allowedPaths = new Set(['/', '/USR/NEWS/m_71']);
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_STDIN_BYTES = 128 * 1024;

function pathMatches(requestPath, cookiePath) {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

function cookieValueIsSafe(value) {
  return typeof value === 'string' && /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/.test(value);
}

function validCookieForRequest(cookie) {
  if (!cookie || typeof cookie !== 'object' || Array.isArray(cookie)) return false;
  if (!allowedObservedNames.has(cookie.name)) return false;
  if (!allowedDomains.has(String(cookie.domain ?? '').toLowerCase())) return false;
  if (!allowedPaths.has(cookie.path) || !pathMatches(observedUrl.pathname, cookie.path)) return false;
  if (!cookieValueIsSafe(cookie.value)) return false;
  if (cookie.secure === true && observedUrl.protocol !== 'https:') return false;
  const expiry = Number(cookie.expires);
  if (cookie.session !== true && !(expiry === -1 || (Number.isFinite(expiry) && expiry > Date.now() / 1000))) return false;
  return true;
}

async function readEnvelope() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input, 'utf8') > MAX_STDIN_BYTES) throw new Error('INPUT_TOO_LARGE');
  }
  const envelope = JSON.parse(input);
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || !Array.isArray(envelope.cookies)) {
    throw new Error('INPUT_INVALID');
  }
  return envelope;
}

async function readBounded(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    try { await response.body?.cancel(); } catch {}
    return { bytes: Buffer.alloc(0), tooLarge: true };
  }
  if (!response.body) return { bytes: Buffer.alloc(0), tooLarge: false };
  const reader = response.body.getReader();
  const chunks = [];
  let count = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (count + value.byteLength > MAX_BODY_BYTES) {
        try { await reader.cancel(); } catch {}
        return { bytes: Buffer.alloc(0), tooLarge: true };
      }
      chunks.push(Buffer.from(value));
      count += value.byteLength;
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  return { bytes: Buffer.concat(chunks, count), tooLarge: false };
}

function emptyEvidence(cookieNames = []) {
  return { status: null, mime: null, bytes: 0, sha256: null, listCount: null, redirectSameUrl: null, cookieNames };
}

let evidence;
try {
  const envelope = await readEnvelope();
  const selected = envelope.cookies.filter(validCookieForRequest)
    .sort((left, right) => right.path.length - left.path.length);
  const duplicateScopes = new Set();
  for (const cookie of selected) {
    const scope = `${cookie.name}\0${String(cookie.domain).toLowerCase()}\0${cookie.path}`;
    if (duplicateScopes.has(scope)) throw new Error('COOKIE_SCOPE_DUPLICATE');
    duplicateScopes.add(scope);
  }
  const headers = new Headers(observedHeaders);
  headers.delete('origin');
  headers.delete('authorization');
  const cookieHeader = selected.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  if (cookieHeader) headers.set('cookie', cookieHeader);

  const response = await fetch(observedUrl, {
    method: 'GET',
    redirect: 'manual',
    credentials: 'omit',
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? null;
  let redirectSameUrl = null;
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location');
    if (location) {
      try { redirectSameUrl = new URL(location, observedUrl).href === observedUrl.href; }
      catch { redirectSameUrl = false; }
    }
  }
  const body = await readBounded(response);
  const sha256 = body.bytes.length ? createHash('sha256').update(body.bytes).digest('hex') : null;
  let listCount = null;
  if (!body.tooLarge && response.status === 200 && /^(?:text\/html|application\/xhtml\+xml)$/i.test(mime ?? '') && body.bytes.length) {
    const decoded = decodeHtml(body.bytes, response.headers.get('content-type') ?? '');
    if (!classifyChallengeHtml(decoded.html)) {
      try { listCount = parseMolitNoticeList(decoded.html, { baseUrl: observedUrl.href }).items.length; }
      catch { listCount = null; }
    }
  }
  evidence = {
    status: response.status,
    mime,
    bytes: body.bytes.length,
    sha256,
    listCount,
    redirectSameUrl,
    cookieNames: selected.map(cookie => cookie.name),
  };
} catch {
  evidence = emptyEvidence();
  process.exitCode = 2;
}

await mkdir(here, { recursive: true });
await writeFile(outputPath, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
process.stdout.write(JSON.stringify(evidence) + '\n');
