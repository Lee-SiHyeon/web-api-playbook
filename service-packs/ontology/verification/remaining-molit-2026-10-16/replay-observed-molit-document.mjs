import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectMolitNotices } from '../../src/rental-housing/molit-notices.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
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
const observedRedirects = [];

function sanitizedUrl(input) {
  try {
    const url = new URL(input);
    return { origin: url.origin, path: url.pathname, queryKeys: [...url.searchParams.keys()].sort() };
  } catch {
    return null;
  }
}

const result = await collectMolitNotices({
  url: observedUrl.href,
  limit: 20,
  maxPages: 1,
  detailLimit: 0,
  fetchImpl: async (input, init) => {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(observedHeaders)) headers.set(name, value);
    headers.delete('cookie');
    headers.delete('authorization');
    const response = await fetch(input, { ...init, headers, credentials: 'omit' });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      const target = location ? new URL(location, String(input)) : null;
      observedRedirects.push({
        from: sanitizedUrl(input),
        status: response.status,
        locationPresent: location !== null,
        to: target ? sanitizedUrl(target.href) : null,
        sameOrigin: target?.origin === new URL(String(input)).origin,
        samePath: target?.pathname === new URL(String(input)).pathname,
      });
    }
    return response;
  },
});

const requestEvidence = result.receipt.requests.map(request => ({
  method: request.method,
  url: request.url,
  finalUrl: request.finalUrl,
  status: request.status,
  mime: request.contentType?.split(';')[0] ?? null,
  charset: request.charset ?? null,
  bytes: request.bytes ?? 0,
  sha256: request.sha256 ?? null,
  error: request.error ?? null,
  challenge: request.challenge ?? null,
  credentialState: request.credentialState,
  captureCleanupVerified: request.captureCleanupVerified,
}));
const usableBody = result.receipt.ok === true && result.items.length > 0
  && requestEvidence.some(request => request.status === 200 && /^text\/html$/i.test(request.mime ?? '') && request.bytes > 0 && request.sha256);
const evidence = {
  schemaVersion: 1,
  operation: 'MOLIT observed page-two public notice Document GET',
  checkedAt: result.receipt.checkedAt,
  execution: { mode: 'pure_http', browserUsed: false, authentication: 'anonymous', credentials: 'omitted' },
  request: { method: 'GET', ...sanitizedUrl(observedUrl.href) },
  observedNonSecretHeaderProfile: observedHeaders,
  omittedCookieNames: ['ACEUCI', 'TMOSHCooKie', 'clientid', 'SCOUTER', 'ACEFCID', 'JSESSIONID', 'AUAH6A47309598944', 'AUFAH6A47309598944', 'ACEUACS', 'ARAH6A47309598944', 'ASAH6A47309598944'],
  sentCookieHeader: false,
  sentAuthorizationHeader: false,
  redirects: observedRedirects,
  responseAndParser: {
    status: result.receipt.requests[0]?.status ?? null,
    mime: result.receipt.requests[0]?.contentType?.split(';')[0] ?? null,
    bytes: result.receipt.requests[0]?.bytes ?? 0,
    sha256: result.receipt.requests[0]?.sha256 ?? null,
    error: result.receipt.error,
    collectorStatus: result.receipt.status,
    liveReplay: usableBody,
    listPagesRead: result.receipt.listPagesRead,
    returnedItemCount: result.items.length,
    layoutFingerprintPresent: Boolean(result.receipt.layoutFingerprint),
    challenge: result.receipt.requests[0]?.challenge ?? null,
    captureCleanupVerified: result.receipt.captureCleanupVerified,
  },
  requests: requestEvidence,
  rawBodyPersisted: false,
  titleTextLogged: false,
  cookieValuesLogged: false,
};
const outputPath = path.join(here, 'observed-header-replay.json');
await mkdir(here, { recursive: true });
await writeFile(outputPath, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ output: outputPath, status: evidence.responseAndParser.status,
  mime: evidence.responseAndParser.mime, bytes: evidence.responseAndParser.bytes,
  returnedItemCount: evidence.responseAndParser.returnedItemCount,
  liveReplay: evidence.responseAndParser.liveReplay, redirects: observedRedirects.length }));
