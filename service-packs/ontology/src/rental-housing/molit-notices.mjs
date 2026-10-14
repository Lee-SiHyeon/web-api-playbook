import { pathToFileURL } from 'node:url';
import {
  createRentalPublicReader,
  parseHtml,
  findAll,
  attr,
  hasClass,
  textContent,
  links,
  cleanText,
  asDate,
  classifyDocumentError,
  rowLayout,
  ensureLayout
} from './rental-housing-public-html.mjs';

export const MOLIT_NOTICES_URL = 'https://www.molit.go.kr/USR/NEWS/m_71/lst.jsp';
export const MOLIT_SOURCE = Object.freeze({
  id: 'molit-press',
  name: '국토교통부 보도자료',
  domain: 'www.molit.go.kr',
  url: MOLIT_NOTICES_URL,
  requestKind: 'top_level_document',
  authentication: 'anonymous_public'
});

const ALLOWED_HOSTS = ['www.molit.go.kr', 'molit.go.kr'];
const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_PAGES = 1;
const DEFAULT_DETAIL_LIMIT = 2;
const MAX_LIMIT = 100;
const MAX_PAGES = 10;
const MAX_DETAIL_LIMIT = 20;

function cellsOf(row, tag) {
  return (row?.childNodes ?? []).filter(node => node.tagName === tag);
}

function within(node, ancestor) {
  for (let current = node; current; current = current.parentNode) if (current === ancestor) return true;
  return false;
}

function identityFromUrl(input) {
  const url = new URL(input);
  for (const [key, value] of url.searchParams) {
    if (/^(?:id|seq|newsid|ntt(?:id)?|article(?:id)?|bbs(?:id)?|doc(?:id)?)$/i.test(key) && value) return value;
  }
  return url.href;
}

function safeItemUrl(href, baseUrl) {
  try {
    const itemUrl = new URL(href, baseUrl);
    const base = new URL(baseUrl);
    if (itemUrl.protocol !== 'https:' || itemUrl.origin !== base.origin || itemUrl.pathname === base.pathname) return null;
    if (!itemUrl.pathname.startsWith('/USR/NEWS/')) return null;
    return itemUrl.href;
  } catch { return null; }
}

function parseTableList(document, baseUrl) {
  const tables = findAll(document, node => node.tagName === 'table');
  for (const table of tables) {
    const rows = findAll(table, node => node.tagName === 'tr');
    const headerRow = rows.find(row => cellsOf(row, 'th').length > 0);
    if (!headerRow) continue;
    const headers = cellsOf(headerRow, 'th').map(cell => cleanText(textContent(cell)));
    const titleColumn = headers.findIndex(value => /제목|보도자료명|공지명/.test(value));
    if (titleColumn < 0) continue;
    const dateColumn = headers.findIndex(value => /등록|작성|게시|날짜/.test(value));
    const summaryColumn = headers.findIndex(value => /요약|내용|설명|비고/.test(value));
    const records = [];
    for (const row of rows) {
      const cells = cellsOf(row, 'td');
      if (cells.length <= titleColumn) continue;
      const titleCell = cells[titleColumn];
      const candidate = links(titleCell, baseUrl).find(link => safeItemUrl(link.url, baseUrl));
      if (!candidate || !candidate.text) continue;
      const url = safeItemUrl(candidate.url, baseUrl);
      const rawLabels = Object.fromEntries(headers.map((label, index) => [label || `column_${index + 1}`, cleanText(textContent(cells[index])) || null]));
      const rawDate = dateColumn >= 0 ? cleanText(textContent(cells[dateColumn])) : '';
      const rawSummary = summaryColumn >= 0 ? cleanText(textContent(cells[summaryColumn])) : '';
      records.push({
        id: identityFromUrl(url),
        title: cleanText(candidate.text),
        url,
        publishedAt: asDate(rawDate),
        summary: rawSummary || null,
        rawLabels
      });
    }
    if (records.length) {
      const fingerprint = rowLayout(['table', 'tr[header]', 'th', 'tr[data]', 'td', 'a[detail]'], headers);
      ensureLayout(fingerprint, fingerprint, { rowCount: records.length, minRows: 1, maxRows: 1000 });
      return { items: records, fingerprint, headers };
    }
  }
  throw Object.assign(new Error('HTML_LAYOUT_CHANGED'), { code: 'HTML_LAYOUT_CHANGED' });
}

function observedPageUrls(document, baseUrl) {
  const base = new URL(baseUrl);
  return links(document, baseUrl).flatMap(link => {
    try {
      const next = new URL(link.url);
      const pageKey = [...next.searchParams.keys()].find(key => /^(?:page|pageindex|pageno|lcmspage)$/i.test(key));
      if (next.protocol !== 'https:' || next.origin !== base.origin || next.pathname !== base.pathname || !pageKey || next.href === base.href) return [];
      return [next.href];
    } catch { return []; }
  });
}

function pageError(result) {
  if (result.error === 'CHALLENGE_HTML' || result.challenge) return 'challenge_blocked';
  if (result.error === 'LOGIN_HTML') return 'login_required';
  if (result.error === 'PUBLIC_BODY_TOO_LARGE' || result.error === 'HTML_CONTENT_TYPE_INVALID') return 'response_invalid';
  if (result.error === 'HTTP_307_SELF_REDIRECT' || /_REDIRECT/.test(result.error ?? '') || (result.status >= 300 && result.status < 400)) return 'redirect_blocked';
  if (result.error === 'HTML_LAYOUT_CHANGED') return 'layout_changed';
  if (result.error === 'PUBLIC_REQUEST_BUDGET_EXHAUSTED') return 'request_budget_exhausted';
  return result.error ? 'fetch_error' : null;
}

function requestStatus(result) {
  return { ...result.record, credentialState: 'not_applicable_public_anonymous' };
}

function limited(value, fallback, maximum) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(Math.floor(number), maximum) : fallback;
}

/** Parse the public MOLIT notices table using its header labels and observed detail anchors. */
export function parseMolitNoticeList(html, { baseUrl = MOLIT_NOTICES_URL } = {}) {
  const document = parseHtml(html);
  const login = classifyDocumentError(document);
  if (login) throw Object.assign(new Error(login), { code: login });
  const parsed = parseTableList(document, baseUrl);
  return { ...parsed, observedPageUrls: observedPageUrls(document, baseUrl) };
}

/** Parse a server-rendered MOLIT detail document without assigning unstated facts. */
export function parseMolitNoticeDetail(html, { url = MOLIT_NOTICES_URL } = {}) {
  const document = parseHtml(html);
  const login = classifyDocumentError(document);
  if (login) throw Object.assign(new Error(login), { code: login });
  const heading = findAll(document, node => node.tagName === 'h1')[0] ?? findAll(document, node => node.tagName === 'h2' && !hasClass(node, 'sr-only'))[0];
  const title = cleanText(textContent(heading));
  if (!title) throw Object.assign(new Error('HTML_LAYOUT_CHANGED'), { code: 'HTML_LAYOUT_CHANGED' });

  const rawLabels = {};
  const timeNode = findAll(document, node => node.tagName === 'time')[0];
  let rawDate = timeNode ? cleanText(attr(timeNode, 'datetime') ?? textContent(timeNode)) : '';
  if (timeNode) rawLabels.time = cleanText(textContent(timeNode));
  if (!rawDate) {
    for (const row of findAll(document, node => node.tagName === 'tr')) {
      const header = cellsOf(row, 'th')[0];
      const value = cellsOf(row, 'td')[0];
      const label = cleanText(textContent(header));
      if (header && value && /등록|작성|게시|날짜/.test(label)) {
        rawDate = cleanText(textContent(value));
        rawLabels[label] = rawDate;
        break;
      }
    }
  }
  for (const meta of findAll(document, node => node.tagName === 'meta')) {
    const name = (attr(meta, 'property') ?? attr(meta, 'name') ?? '').toLowerCase();
    if (['article:published_time', 'datepublished', 'date'].includes(name) && attr(meta, 'content')) {
      rawDate ||= cleanText(attr(meta, 'content'));
      rawLabels[name] = cleanText(attr(meta, 'content'));
    }
  }
  const bodyNode = findAll(document, node => node.tagName === 'article' ||
    (['view_cont', 'view_content', 'article_body', 'content_area'].some(name => hasClass(node, name))) ||
    ['content', 'contents'].includes(attr(node, 'id')))[0];
  const bodyText = cleanText(textContent(bodyNode));
  const rawSummary = bodyText && !/공공누리|저작권정책|개인정보처리방침/.test(bodyText) ? bodyText : '';
  rawLabels.title = title;
  if (rawSummary) rawLabels.summary = rawSummary;
  return {
    id: identityFromUrl(url),
    title,
    url,
    publishedAt: asDate(rawDate),
    summary: rawSummary ? rawSummary.slice(0, 1600) : null,
    rawLabels
  };
}

export async function collectMolitNotices({
  fetchImpl = fetch,
  now = new Date(),
  limit = DEFAULT_LIMIT,
  maxPages = DEFAULT_MAX_PAGES,
  detailLimit = DEFAULT_DETAIL_LIMIT,
  minIntervalMs = 2000,
  timeoutMs = 20000,
  maxBodyBytes = 5 * 1024 * 1024,
  url = MOLIT_NOTICES_URL
} = {}) {
  const checkedAt = (typeof now === 'function' ? now() : now).toISOString();
  const safeLimit = limited(limit, DEFAULT_LIMIT, MAX_LIMIT);
  const safeMaxPages = Math.max(1, limited(maxPages, DEFAULT_MAX_PAGES, MAX_PAGES));
  const safeDetailLimit = limited(detailLimit, DEFAULT_DETAIL_LIMIT, MAX_DETAIL_LIMIT);
  const reader = await createRentalPublicReader({ sourceId: MOLIT_SOURCE.id, allowedHosts: ALLOWED_HOSTS, fetchImpl, minIntervalMs, timeoutMs, maxBodyBytes, requestLimit: Math.min(40, safeMaxPages + safeDetailLimit + 12) });
  const items = [];
  const requests = [];
  const details = [];
  const pageUrls = [url];
  const visited = new Set();
  let pagesRead = 0;
  let firstError = null;
  let layoutFingerprint = null;
  let output = null;
  try {
    while (pageUrls.length && visited.size < safeMaxPages && items.length < safeLimit) {
      const currentUrl = pageUrls.shift();
      if (visited.has(currentUrl)) continue;
      visited.add(currentUrl);
      const response = await reader.get(currentUrl, 'list');
      requests.push(requestStatus(response));
      if (response.error) { firstError = pageError(response); break; }
      const documentError = classifyDocumentError(parseHtml(response.html));
      if (documentError) { firstError = 'login_required'; requests.at(-1).error = documentError; break; }
      let parsed;
      try { parsed = parseMolitNoticeList(response.html, { baseUrl: response.url }); }
      catch (error) { firstError = error.code === 'LOGIN_HTML' ? 'login_required' : 'layout_changed'; requests.at(-1).error = error.code ?? 'HTML_LAYOUT_CHANGED'; break; }
      if (layoutFingerprint) {
        try { ensureLayout(parsed.fingerprint, layoutFingerprint, { rowCount: parsed.items.length, minRows: 1, maxRows: 1000 }); }
        catch { firstError = 'layout_changed'; requests.at(-1).error = 'HTML_LAYOUT_CHANGED'; break; }
      }
      layoutFingerprint ??= parsed.fingerprint;
      pagesRead += 1;
      items.push(...parsed.items.map(item => ({ ...item, source: MOLIT_SOURCE.id, domain: new URL(item.url).hostname })));
      for (const nextUrl of parsed.observedPageUrls) if (!visited.has(nextUrl) && !pageUrls.includes(nextUrl)) pageUrls.push(nextUrl);
    }
    const listItems = items.slice(0, safeLimit);
    for (const item of listItems.slice(0, safeDetailLimit)) {
      const result = await reader.get(item.url, 'detail');
      requests.push(requestStatus(result));
      if (result.error) {
        details.push({ id: item.id, status: pageError(result) ?? 'fetch_error', error: result.error });
        continue;
      }
      try {
        const parsed = parseMolitNoticeDetail(result.html, { url: result.url });
        item.title = parsed.title || item.title;
        item.publishedAt = parsed.publishedAt || item.publishedAt;
        item.summary = parsed.summary || item.summary;
        item.rawLabels = { ...item.rawLabels, detail: parsed.rawLabels };
        details.push({ id: item.id, status: 'read' });
      } catch (error) {
        details.push({ id: item.id, status: error.code === 'LOGIN_HTML' ? 'login_required' : 'layout_changed', error: error.code ?? 'HTML_LAYOUT_CHANGED' });
      }
    }
    const listParsed = listItems.length > 0;
    const detailFailures = details.some(item => item.status !== 'read');
    const status = firstError ?? (listParsed && detailFailures ? 'partial' : listParsed ? 'read' : 'layout_changed');
    const receipt = {
      status,
      ok: listParsed,
      liveReplay: listParsed,
      clientExists: true,
      remnantFree: true,
      remnantFreeScope: 'http_browser_dependency',
      captured: false,
      browserXhrCaptured: false,
      requestKind: 'top_level_document',
      executionMode: 'pure_http',
      maxBodyBytes,
      credentialPropagation: 'not_applicable_public_anonymous',
      checkedAt,
      sourceEvidence: 'registered_public_document_seed',
      listPagesRead: pagesRead,
      listPageLimit: safeMaxPages,
      itemLimit: safeLimit,
      itemCount: listItems.length,
      detailLimit: safeDetailLimit,
      detailReadCount: details.filter(item => item.status === 'read').length,
      detailErrorCount: details.filter(item => item.status !== 'read').length,
      details,
      requests,
      layoutFingerprint,
      error: firstError
    };
    output = { source: MOLIT_SOURCE, items: listItems, receipt };
    return output;
  } finally {
    const cleanup = await reader.close();
    if (output?.receipt) {
      output.receipt.captureCleanupVerified = cleanup.cleanupVerified && requests.every(request => request.captureCleanupVerified !== false);
      output.receipt.captureCleanupErrorCode = output.receipt.captureCleanupVerified ? null : (cleanup.cleanupErrorCode ?? 'CAPTURE_CLEANUP_FAILED');
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  collectMolitNotices().then(({ source, items, receipt }) => {
    process.stdout.write(`${JSON.stringify({ source, count: items.length, receipt }, null, 2)}\n`);
    if (!receipt.ok) process.exitCode = 1;
  }).catch(error => {
    process.stderr.write(`${error?.code ?? error?.message ?? 'MOLIT_NOTICES_FAILED'}\n`);
    process.exitCode = 1;
  });
}
