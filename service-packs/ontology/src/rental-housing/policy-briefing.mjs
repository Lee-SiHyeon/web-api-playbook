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

export const POLICY_BRIEFING_URL = 'https://www.korea.kr/briefing/pressReleaseList.do';
export const POLICY_SOURCE = Object.freeze({
  id: 'korea-policy-briefing',
  name: '대한민국 정책브리핑 보도자료',
  domain: 'www.korea.kr',
  url: POLICY_BRIEFING_URL,
  requestKind: 'top_level_document',
  authentication: 'anonymous_public'
});

const ALLOWED_HOSTS = ['www.korea.kr'];
const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_PAGES = 1;
const DEFAULT_DETAIL_LIMIT = 2;
const MAX_LIMIT = 100;
const MAX_PAGES = 10;
const MAX_DETAIL_LIMIT = 20;
const EXPECTED_LIST_SELECTORS = ['div.list_type', 'li', 'a[pressReleaseView]', 'span.text', 'strong', 'span.lead', 'span.source'];

function sameOriginDetailUrl(href, baseUrl) {
  try {
    const url = new URL(href, baseUrl);
    return url.protocol === 'https:' && url.origin === new URL(baseUrl).origin && url.pathname === '/briefing/pressReleaseView.do' && Boolean(url.searchParams.get('newsId'))
      ? url.href : null;
  } catch { return null; }
}

function getFormEntries(form) {
  const values = [];
  for (const control of findAll(form, node => ['input', 'select', 'textarea'].includes(node.tagName))) {
    const name = attr(control, 'name');
    if (!name || attr(control, 'disabled') !== null) continue;
    if (control.tagName === 'input') {
      const type = String(attr(control, 'type') ?? 'text').toLowerCase();
      if (['checkbox', 'radio'].includes(type) && attr(control, 'checked') === null) continue;
      if (['submit', 'button', 'image', 'file', 'reset'].includes(type)) continue;
      values.push([name, attr(control, 'value') ?? '']);
    } else if (control.tagName === 'textarea') {
      values.push([name, cleanText(textContent(control))]);
    } else {
      const options = findAll(control, node => node.tagName === 'option');
      const selected = options.filter(option => attr(option, 'selected') !== null);
      for (const option of (selected.length ? selected : options.slice(0, 1))) values.push([name, attr(option, 'value') ?? cleanText(textContent(option))]);
    }
  }
  return values;
}

function parseObservedPageNumber(link) {
  const onclick = attr(link.node, 'onclick') ?? '';
  const match = /^\s*pageLink\s*\(\s*(\d+)\s*\)\s*;/.exec(onclick);
  return match ? Number(match[1]) : null;
}

function pageContext(document, baseUrl) {
  const form = findAll(document, node => node.tagName === 'form' && attr(node, 'id') === 'mainForm')[0];
  if (!form) return { currentPage: 1, pages: [], form: null, error: null };
  const fields = getFormEntries(form);
  const pageEntry = fields.find(([name]) => name === 'pageIndex');
  const currentPage = Number(pageEntry?.[1] ?? 1);
  const base = new URL(baseUrl);
  const actionValue = attr(form, 'action') || base.pathname;
  let action;
  try { action = new URL(actionValue, baseUrl); } catch { return { currentPage, pages: [], form: null, error: 'HTML_LAYOUT_CHANGED' }; }
  if (action.protocol !== 'https:' || action.origin !== base.origin || action.pathname !== '/briefing/pressReleaseList.do' || !Number.isInteger(currentPage) || currentPage < 1) {
    return { currentPage, pages: [], form: null, error: 'HTML_LAYOUT_CHANGED' };
  }
  const paging = findAll(document, node => node.tagName === 'div' && hasClass(node, 'paging'))[0];
  const pageLinks = paging ? links(paging, baseUrl) : [];
  const pages = pageLinks.map(link => ({ pageNo: parseObservedPageNumber(link), label: cleanText(link.text), onclick: attr(link.node, 'onclick') })).filter(page => Number.isInteger(page.pageNo) && page.pageNo > currentPage);
  return { currentPage, pages, form: { method: String(attr(form, 'method') ?? 'get').toLowerCase(), action: action.href, fields }, error: null };
}

function listingFingerprint(document, cards) {
  const present = ['div.list_type'];
  if (cards.length) present.push('li', 'a[pressReleaseView]', 'span.text', 'strong');
  if (cards.some(item => item.rawLabels.summary)) present.push('span.lead');
  if (cards.some(item => item.rawLabels.publishedAt)) present.push('span.source');
  return rowLayout(present, []);
}

function identityFromUrl(url) {
  return new URL(url).searchParams.get('newsId');
}

function summaryText(raw, title) {
  let value = cleanText(raw);
  if (title && value.startsWith(title)) value = cleanText(value.slice(title.length));
  return value && value !== title ? value : null;
}

function limited(value, fallback, maximum) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(Math.floor(number), maximum) : fallback;
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

/** Parse one public press-release listing page and only its in-scope detail/page links. */
export function parsePolicyBriefingList(html, { baseUrl = `${POLICY_BRIEFING_URL}?pageIndex=1` } = {}) {
  const document = parseHtml(html);
  const login = classifyDocumentError(document);
  if (login) throw Object.assign(new Error(login), { code: login });
  const list = findAll(document, node => node.tagName === 'div' && hasClass(node, 'list_type'))[0];
  if (!list) throw Object.assign(new Error('HTML_LAYOUT_CHANGED'), { code: 'HTML_LAYOUT_CHANGED' });
  const items = [];
  const listItems = findAll(list, node => node.tagName === 'li');
  for (const listItem of listItems) {
    const anchor = findAll(listItem, node => node.tagName === 'a').find(node => sameOriginDetailUrl(attr(node, 'href') ?? '', baseUrl));
    if (!anchor) continue;
    const url = sameOriginDetailUrl(attr(anchor, 'href'), baseUrl);
    const title = cleanText(textContent(findAll(anchor, node => node.tagName === 'strong')[0]));
    if (!title) continue;
    const leadNode = findAll(anchor, node => node.tagName === 'span' && hasClass(node, 'lead'))[0];
    const sourceNode = findAll(anchor, node => node.tagName === 'span' && hasClass(node, 'source'))[0];
    const rawLead = cleanText(textContent(leadNode));
    const rawSource = cleanText(textContent(sourceNode));
    items.push({
      id: identityFromUrl(url),
      title,
      url,
      publishedAt: asDate(rawSource),
      summary: summaryText(rawLead, title),
      rawLabels: { title, summary: rawLead || null, publishedAt: rawSource || null }
    });
  }
  if (!items.length) throw Object.assign(new Error('HTML_LAYOUT_CHANGED'), { code: 'HTML_LAYOUT_CHANGED' });
  const fingerprint = listingFingerprint(document, items);
  ensureLayout(fingerprint, rowLayout(EXPECTED_LIST_SELECTORS, []), { rowCount: items.length, minRows: 1, maxRows: 1000 });
  const pagination = pageContext(document, baseUrl);
  return { items, pagination, fingerprint };
}

/** Parse a server-rendered press-release detail page; empty or boilerplate body stays null. */
export function parsePolicyBriefingDetail(html, { url } = {}) {
  const document = parseHtml(html);
  const login = classifyDocumentError(document);
  if (login) throw Object.assign(new Error(login), { code: login });
  const title = cleanText(textContent(findAll(document, node => node.tagName === 'h1')[0]));
  const parsedId = url ? identityFromUrl(url) : null;
  if (!title || !parsedId) throw Object.assign(new Error('HTML_LAYOUT_CHANGED'), { code: 'HTML_LAYOUT_CHANGED' });
  const articleHead = findAll(document, node => node.tagName === 'div' && hasClass(node, 'article_head'))[0];
  const headText = cleanText(textContent(articleHead));
  const timeNode = findAll(document, node => node.tagName === 'time')[0];
  const rawDate = (timeNode ? cleanText(attr(timeNode, 'datetime') ?? textContent(timeNode)) : '') || headText;
  const bodyNode = findAll(document, node => node.tagName === 'div' && hasClass(node, 'article_body'))[0] ??
    findAll(document, node => node.tagName === 'div' && hasClass(node, 'view_cont'))[0];
  const bodyText = cleanText(textContent(bodyNode));
  const substantive = bodyText && !/^(?:[“"']?이 자료는 .*?(?:전재|알려드립니다)|이 자료는 텍스트에 한하여|저작권정책)/.test(bodyText)
    ? bodyText.slice(0, 1600) : null;
  return {
    id: parsedId,
    title,
    url,
    publishedAt: asDate(rawDate),
    summary: substantive,
    rawLabels: { title, articleHead: headText || null, publishedAt: rawDate || null, summary: bodyText || null }
  };
}

function responseForPageRequest(fetchResult, requestedPage) {
  if (fetchResult.error) return { ...fetchResult, record: { ...fetchResult.record, requestedPage } };
  return { ...fetchResult, record: { ...fetchResult.record, requestedPage } };
}

export async function collectPolicyBriefings({
  fetchImpl = fetch,
  now = new Date(),
  limit = DEFAULT_LIMIT,
  maxPages = DEFAULT_MAX_PAGES,
  detailLimit = DEFAULT_DETAIL_LIMIT,
  minIntervalMs = 2000,
  timeoutMs = 20000,
  maxBodyBytes = 5 * 1024 * 1024,
  url = `${POLICY_BRIEFING_URL}?pageIndex=1`
} = {}) {
  const checkedAt = (typeof now === 'function' ? now() : now).toISOString();
  const safeLimit = limited(limit, DEFAULT_LIMIT, MAX_LIMIT);
  const safeMaxPages = Math.max(1, limited(maxPages, DEFAULT_MAX_PAGES, MAX_PAGES));
  const safeDetailLimit = limited(detailLimit, DEFAULT_DETAIL_LIMIT, MAX_DETAIL_LIMIT);
  const reader = await createRentalPublicReader({ sourceId: POLICY_SOURCE.id, allowedHosts: ALLOWED_HOSTS, fetchImpl, minIntervalMs, timeoutMs, maxBodyBytes, requestLimit: Math.min(40, safeMaxPages + safeDetailLimit + 12) });
  const items = [];
  const requests = [];
  const details = [];
  const visitedPages = new Set();
  const pageQueue = [{ url, pageNo: 1, form: null, referer: null }];
  let firstError = null;
  let pageTraversalStatus = 'not_requested';
  let layoutFingerprint = null;
  let output = null;
  try {
    while (pageQueue.length && visitedPages.size < safeMaxPages && items.length < safeLimit) {
      const page = pageQueue.shift();
      if (visitedPages.has(page.pageNo)) continue;
      let response;
      if (page.form?.method === 'post') {
        const fields = page.form.fields.map(([name, value]) => [name, name === 'pageIndex' ? String(page.pageNo) : value]);
        response = await reader.postObservedForm(page.form.action, fields, { referer: page.referer ?? page.url, pageType: 'list' });
      } else {
        const requestUrl = new URL(page.url);
        requestUrl.searchParams.set('pageIndex', String(page.pageNo));
        response = await reader.get(requestUrl.href, 'list');
      }
      response = responseForPageRequest(response, page.pageNo);
      requests.push(requestStatus(response));
      if (response.error) { firstError = pageError(response); break; }
      const documentError = classifyDocumentError(parseHtml(response.html));
      if (documentError) { firstError = 'login_required'; requests.at(-1).error = documentError; break; }
      let parsed;
      try { parsed = parsePolicyBriefingList(response.html, { baseUrl: response.url }); }
      catch (error) { firstError = error.code === 'LOGIN_HTML' ? 'login_required' : 'layout_changed'; requests.at(-1).error = error.code ?? 'HTML_LAYOUT_CHANGED'; break; }
      if (layoutFingerprint) {
        try { ensureLayout(parsed.fingerprint, layoutFingerprint, { rowCount: parsed.items.length, minRows: 1, maxRows: 1000 }); }
        catch { firstError = 'layout_changed'; requests.at(-1).error = 'HTML_LAYOUT_CHANGED'; break; }
      }
      layoutFingerprint ??= parsed.fingerprint;
      items.push(...parsed.items.map(item => ({ ...item, source: POLICY_SOURCE.id, domain: new URL(item.url).hostname })));
      visitedPages.add(page.pageNo);
      if (visitedPages.size === 1) pageTraversalStatus = parsed.pagination.form?.method === 'post' ? 'observed_form_post' : parsed.pagination.form?.method === 'get' ? 'observed_form_get' : 'unavailable';
      if (visitedPages.size < safeMaxPages && parsed.pagination.form && parsed.pagination.pages.length) {
        const pageNo = parsed.pagination.pages.map(option => option.pageNo).filter(number => number > page.pageNo).sort((a, b) => a - b)[0];
        if (pageNo) pageQueue.push({ url: response.url, pageNo, form: parsed.pagination.form, referer: response.url });
      }
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
        const parsed = parsePolicyBriefingDetail(result.html, { url: result.url });
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
      listPagesRead: visitedPages.size,
      listPageLimit: safeMaxPages,
      pageTraversal: pageTraversalStatus,
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
    output = { source: POLICY_SOURCE, items: listItems, receipt };
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
  collectPolicyBriefings().then(({ source, items, receipt }) => {
    process.stdout.write(`${JSON.stringify({ source, count: items.length, receipt }, null, 2)}\n`);
    if (!receipt.ok) process.exitCode = 1;
  }).catch(error => {
    process.stderr.write(`${error?.code ?? error?.message ?? 'POLICY_BRIEFING_FAILED'}\n`);
    process.exitCode = 1;
  });
}
