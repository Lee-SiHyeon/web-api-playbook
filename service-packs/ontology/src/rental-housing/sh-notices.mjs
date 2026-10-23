import { createHash } from 'node:crypto';
import {
  attr,
  decodeHtml,
  findAll,
  parseHtml,
  structuralFingerprint,
  textContent,
} from '../gov-discount-events/html-public.mjs';

export const SH_NOTICE_SOURCE_ID = 'sh-main-notices';
export const SH_NOTICE_HOME_URL = 'https://www.i-sh.co.kr/';
export const SH_NOTICE_HOST = 'www.i-sh.co.kr';
export const SH_NOTICE_CATEGORY = '주택임대';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const MAX_RESPONSE_BYTES = 6 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_REQUESTS = 32;
const LIST_HEADERS = ['번호', '제목', '담당부서', '등록일', '조회수'];
const DETAIL_LABELS = ['등록일', '조회수'];
const LIST_SELECTORS = [
  'form#mainform',
  'table>thead>tr>th',
  'table>tbody>tr>td',
  'a[onclick^="javascript:getDetailView("]',
];
const DETAIL_SELECTORS = [
  'div.detailTable',
  'div.detailTable table>caption',
  'div.detailTable td.cont',
];
const FORM_FIELDS = new Set([
  'page', 'seq', 'itm_seq_1', 'multi_itm_seq', 'multi_itm_seqsStr', 'isRecrnoti',
  'notType1', 'splyTy', 'annType1', 'recrnotiState', 'srchFr', 'srchTo',
  'recSrchFr', 'recSrchTo', 'srchTp', 'srchWord',
]);
const REQUIRED_FORM_FIELDS = ['page', 'seq', 'itm_seq_1', 'multi_itm_seq', 'multi_itm_seqsStr', 'isRecrnoti'];
const hostLastRequest = new Map();
const sha256 = value => createHash('sha256').update(value).digest('hex');
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function error(code, details = null) {
  const result = new Error(code);
  result.code = code;
  if (details) result.details = details;
  return result;
}

function checkedUrl(input, base = SH_NOTICE_HOME_URL) {
  let url;
  try { url = new URL(input, base); } catch { throw error('SH_NOTICE_URL_INVALID'); }
  if (url.protocol !== 'https:' || url.hostname !== SH_NOTICE_HOST || url.username || url.password) {
    throw error('SH_NOTICE_ORIGIN_REJECTED', { host: url.hostname, protocol: url.protocol });
  }
  return url;
}

function safeUrlReceipt(input) {
  const url = checkedUrl(input);
  return { url: url.origin + url.pathname, queryKeys: [...url.searchParams.keys()].sort() };
}

function nodesFor(html) {
  return findAll(parseHtml(html), () => true);
}

function titleFor(html) {
  return clean(textContent(nodesFor(html).find(node => node.tagName === 'title')));
}

function bodyFor(html) {
  return textContent(nodesFor(html).find(node => node.tagName === 'body'));
}

function challengeFor(html) {
  const title = titleFor(html);
  const body = clean(bodyFor(html)).slice(0, 8000);
  if (/^(?:just a moment|attention required|access denied|verify you are human|robot check|보안 확인|접근 차단|서비스 접속 대기)/i.test(title)) {
    return { title, reason: 'challenge_title' };
  }
  if (body.length < 5000 && /(?:verify (?:that )?you are human|checking your browser|captcha verification required|보안 확인을 진행|비정상적인 접근)/i.test(body)) {
    return { title, reason: 'challenge_body' };
  }
  return null;
}

function layoutFor(selectors, labels) {
  const value = structuralFingerprint(selectors, labels);
  return { selectors: value.selectors, headerLabels: labels, headerHash: value.headerHash, hash: value.hash };
}

export function expectedShNoticeLayout() {
  return {
    schemaVersion: 1,
    sourceId: SH_NOTICE_SOURCE_ID,
    list: layoutFor(LIST_SELECTORS, LIST_HEADERS),
    detail: layoutFor(DETAIL_SELECTORS, DETAIL_LABELS),
  };
}

function assertLayout(pageType, selectors, labels, expected) {
  const actual = layoutFor(selectors, labels);
  if (!expected || actual.hash !== expected.hash) {
    throw error('SH_NOTICE_LAYOUT_CHANGED', {
      pageType,
      actual: { selectors: actual.selectors, headerHash: actual.headerHash, hash: actual.hash },
      expected: expected ? { selectors: expected.selectors, headerHash: expected.headerHash, hash: expected.hash } : null,
    });
  }
  return actual;
}

function sameLabels(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isoDate(value) {
  const match = String(value ?? '').match(/(?:^|\D)(\d{4})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,2})(?:\D|$)/);
  if (!match) return null;
  const y = Number(match[1]), m = Number(match[2]), d = Number(match[3]);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

function formEntries(form) {
  if (!form || clean(attr(form, 'method')).toLowerCase() !== 'post') {
    throw error('SH_NOTICE_FORM_CONTRACT_CHANGED', { reason: 'mainform_post_required' });
  }
  const entries = [];
  for (const node of findAll(form, () => true)) {
    if (node.tagName === 'input') {
      const name = attr(node, 'name');
      const type = clean(attr(node, 'type') || 'text').toLowerCase();
      if (!name || attr(node, 'disabled') != null || ['button', 'submit', 'reset', 'image', 'file'].includes(type)) continue;
      if (!FORM_FIELDS.has(name)) throw error('SH_NOTICE_FORM_CONTRACT_CHANGED', { fieldName: name });
      if (['radio', 'checkbox'].includes(type) && attr(node, 'checked') == null) continue;
      entries.push([name, attr(node, 'value') ?? '']);
    } else if (node.tagName === 'select') {
      const name = attr(node, 'name');
      if (!name || attr(node, 'disabled') != null) continue;
      if (!FORM_FIELDS.has(name)) throw error('SH_NOTICE_FORM_CONTRACT_CHANGED', { fieldName: name });
      const options = findAll(node, child => child.tagName === 'option');
      const selected = options.find(option => attr(option, 'selected') != null) ?? options[0];
      if (selected) entries.push([name, attr(selected, 'value') ?? clean(textContent(selected))]);
    } else if (node.tagName === 'textarea') {
      const name = attr(node, 'name');
      if (!name || attr(node, 'disabled') != null) continue;
      if (!FORM_FIELDS.has(name)) throw error('SH_NOTICE_FORM_CONTRACT_CHANGED', { fieldName: name });
      entries.push([name, (node.childNodes ?? []).map(child => child.value ?? '').join('')]);
    }
  }
  const names = new Set(entries.map(([name]) => name));
  for (const name of REQUIRED_FORM_FIELDS) {
    if (!names.has(name)) throw error('SH_NOTICE_FORM_CONTRACT_CHANGED', { missingField: name });
  }
  return entries;
}

function detailAction(html, listUrl) {
  const scripts = nodesFor(html)
    .filter(node => node.tagName === 'script' && !attr(node, 'src'))
    .map(node => (node.childNodes ?? []).map(child => child.value ?? '').join(''));
  const snippets = scripts.flatMap(script => {
    const start = script.indexOf('function getDetailView');
    return start < 0 ? [] : [script.slice(start, start + 7000)];
  });
  const actions = snippets.flatMap(snippet =>
    [...snippet.matchAll(/(?:mainform|f)\.action\s*=\s*["']([^"']+)["']\s*;\s*(?:mainform|f)\.submit\s*\(/g)]
      .map(match => match[1]),
  );
  const unique = [...new Set(actions)];
  if (unique.length !== 1 || !/^(?:\.\/)?[a-z0-9_-]+\.do$/i.test(unique[0])) {
    throw error('SH_NOTICE_DETAIL_CONTRACT_CHANGED', { reason: 'observed_detail_action_missing_or_ambiguous' });
  }
  return checkedUrl(unique[0], listUrl).href;
}

function rentalListFromHomepage(html, baseUrl) {
  const found = nodesFor(html)
    .filter(node => node.tagName === 'a' && attr(node, 'href'))
    .map(node => {
      const label = clean(textContent(node));
      let url;
      try { url = checkedUrl(attr(node, 'href'), baseUrl); } catch { return null; }
      return { label, url };
    })
    .filter(item =>
      item &&
      item.label === SH_NOTICE_CATEGORY &&
      /\/brd\/[^/]+\/list\.do$/i.test(item.url.pathname) &&
      item.url.searchParams.get('multi_itm_seq') === '2',
    );
  const unique = [...new Map(found.map(item => [item.url.href, item])).values()];
  if (unique.length !== 1) throw error('SH_NOTICE_NAVIGATION_NOT_FOUND', { matchingLinks: unique.length });
  return unique[0].url.href;
}

export function parseShNoticeHomepage(html, { baseUrl = SH_NOTICE_HOME_URL } = {}) {
  const nodes = nodesFor(html);
  const refresh = nodes.find(node =>
    node.tagName === 'meta' && clean(attr(node, 'http-equiv')).toLowerCase() === 'refresh',
  );
  let refreshUrl = null;
  if (refresh) {
    const content = attr(refresh, 'content') ?? '';
    const match = content.match(/(?:^|;)\s*url\s*=\s*["']?([^"']+)["']?\s*$/i);
    if (match) refreshUrl = checkedUrl(match[1], baseUrl).href;
  }
  let listUrl = null;
  try { listUrl = rentalListFromHomepage(html, baseUrl); } catch (cause) {
    if (!refreshUrl) throw cause;
  }
  return {
    title: titleFor(html),
    refreshUrl,
    rentalListUrl: listUrl,
  };
}

function rowsIn(table) {
  return findAll(table, node => node.tagName === 'tr');
}

function cellsIn(row) {
  return (row.childNodes ?? []).filter(node => ['td', 'th'].includes(node.tagName));
}

function maximumPage(nodes) {
  const pages = nodes.flatMap(node => {
    const match = (attr(node, 'onclick') ?? '').match(/getPaging\(\s*(\d+)/);
    return match ? [Number(match[1])] : [];
  });
  return pages.length ? Math.max(...pages) : 1;
}

function listForm(html, baseUrl) {
  const nodes = nodesFor(html);
  const form = nodes.find(node => node.tagName === 'form' && attr(node, 'id') === 'mainform');
  const action = checkedUrl(attr(form, 'action') || '.', baseUrl).href;
  return { entries: formEntries(form), action, detailAction: detailAction(html, action) };
}

export function parseShNoticeList(html, { baseUrl = SH_NOTICE_HOME_URL, layout = expectedShNoticeLayout() } = {}) {
  const documentUrl = checkedUrl(baseUrl).href;
  const nodes = nodesFor(html);
  let selectedTable = null;
  let headers = [];
  for (const table of nodes.filter(node => node.tagName === 'table')) {
    const heading = rowsIn(table).find(row => cellsIn(row).some(cell => cell.tagName === 'th'));
    if (!heading) continue;
    const candidate = cellsIn(heading).map(textContent).map(clean);
    if (sameLabels(candidate, LIST_HEADERS)) {
      selectedTable = table;
      headers = candidate;
      break;
    }
  }
  if (!selectedTable) throw error('SH_NOTICE_LAYOUT_CHANGED', { pageType: 'list', reason: 'notice_table_headers_missing' });
  const fingerprint = assertLayout('list', LIST_SELECTORS, headers, layout.list);
  const headerIndex = Object.fromEntries(headers.map((label, index) => [label, index]));
  const rows = rowsIn(selectedTable).filter(row => cellsIn(row).some(cell => cell.tagName === 'td'));
  const items = [];
  for (const row of rows) {
    const cells = cellsIn(row);
    const anchor = findAll(row, node =>
      node.tagName === 'a' && /getDetailView\s*\(/i.test(attr(node, 'onclick') ?? ''),
    )[0];
    if (!anchor) continue;
    const handler = attr(anchor, 'onclick') ?? '';
    const id = handler.match(/getDetailView\s*\(\s*['"]?(\d+)['"]?\s*\)/i)?.[1];
    if (!id) throw error('SH_NOTICE_DETAIL_CONTRACT_CHANGED', { reason: 'sequence_id_missing' });
    const cell = index => clean(textContent(cells[index]));
    const title = clean(textContent(anchor)).replace(/^NEW\s+/i, '');
    if (!title) continue;
    const dateLabel = cell(headerIndex['등록일']);
    const rowNumber = cell(headerIndex['번호']).match(/^\d+/)?.[0] ?? null;
    items.push({
      source: SH_NOTICE_SOURCE_ID,
      id,
      title,
      // The source exposes this row through the observed list document and a
      // POST action. Keep a stable, self-contained public citation URL here;
      // the POST route and sequence field are recorded separately per detail.
      url: documentUrl,
      publishedAt: isoDate(dateLabel),
      summary: null,
      rawLabels: {
        rowNumber: { label: headers[headerIndex['번호']], value: rowNumber },
        title: { label: headers[headerIndex['제목']], value: cell(headerIndex['제목']) || title },
        department: { label: headers[headerIndex['담당부서']], value: cell(headerIndex['담당부서']) || null },
        publishedAt: { label: headers[headerIndex['등록일']], value: dateLabel },
        viewCount: { label: headers[headerIndex['조회수']], value: cell(headerIndex['조회수']) || null },
      },
    });
  }
  const empty = /검색된?\s*결과가?\s*없|등록된\s*게시물이\s*없/i.test(clean(bodyFor(html)));
  if (!items.length && !empty) throw error('SH_NOTICE_LAYOUT_CHANGED', { pageType: 'list', reason: 'notice_rows_missing' });
  const form = listForm(html, documentUrl);
  const page = Number(form.entries.find(([name]) => name === 'page')?.[1]) || 1;
  return {
    items,
    pageNumber: page,
    maximumPageObserved: maximumPage(nodes),
    emptyResult: empty,
    form,
    layout: { selectors: fingerprint.selectors, headerLabels: fingerprint.headerLabels, headerHash: fingerprint.headerHash, hash: fingerprint.hash },
  };
}

function parseFactLines(bodyText) {
  const lines = bodyText.split(/\r?\n/).map(clean).filter(Boolean);
  const definitions = [
    ['recruitmentAnnouncementDate', '모집공고일'],
    ['supplyUnits', '공급호수'],
    ['applicationPeriod', '접수기간'],
    ['winnerAnnouncement', '당첨자발표'],
    ['applicationEligibility', '신청자격'],
  ];
  const rawLabels = {};
  const values = {};
  for (const [key, label] of definitions) {
    const line = lines.find(value => new RegExp('^[■□◆▶●○※*]*\\s*' + label + '\\s*[:：]').test(value));
    if (!line) continue;
    const value = line.replace(new RegExp('^[■□◆▶●○※*]*\\s*' + label + '\\s*[:：]\\s*'), '').trim();
    rawLabels[key] = { label, value };
    values[key] = value;
  }
  const housingFacts = {};
  const noticeDate = isoDate(values.recruitmentAnnouncementDate);
  if (noticeDate) housingFacts.recruitmentAnnouncementDate = noticeDate;

  if (values.supplyUnits) {
    const total = values.supplyUnits.match(/총\s*(\d+)\s*세대/);
    const breakdown = [...values.supplyUnits.matchAll(/([가-힣A-Za-z0-9·_-]+)\s*(\d+)\s*세대/g)]
      .map(match => ({ label: match[1], count: Number(match[2]) }))
      .filter(item => item.label !== '총');
    const fact = { raw: values.supplyUnits };
    if (total) fact.total = Number(total[1]);
    if (breakdown.length) fact.breakdown = breakdown;
    housingFacts.supplyUnits = fact;
  }

  if (values.applicationPeriod) {
    const dates = [...values.applicationPeriod.matchAll(/(?:(\d{4})\s*[./-]\s*)?(\d{1,2})\s*[./-]\s*(\d{1,2})/g)];
    if (dates.length >= 2) {
      const startYear = dates[0][1] ? Number(dates[0][1]) : null;
      const endYear = dates[1][1] ? Number(dates[1][1]) : startYear;
      const startDate = startYear ? isoDate(startYear + '-' + dates[0][2] + '-' + dates[0][3]) : null;
      const endDate = endYear ? isoDate(endYear + '-' + dates[1][2] + '-' + dates[1][3]) : null;
      const rawStart = dates[0][0].trim();
      const rawEnd = dates[1][0].trim();
      const explicitEndYear = Boolean(dates[1][1]);
      const range = {
        raw: values.applicationPeriod,
        start: { value: null, raw: rawStart, precision: startYear ? 'day' : 'month_day', yearSource: startYear ? 'printed' : null },
        end: { value: null, raw: rawEnd, precision: dates[1][1] ? 'day' : 'month_day', yearSource: explicitEndYear ? 'printed' : null },
        resolution: null,
      };
      if (!startDate || !endDate) {
        range.resolution = 'invalid_or_yearless_date';
      } else if (endDate < startDate && explicitEndYear) {
        range.resolution = 'explicit_end_before_start';
      } else if (endDate < startDate) {
        range.start.value = startDate;
        range.start.yearSource = 'printed';
        range.end.reason = 'omitted_year_would_precede_start';
        range.resolution = 'end_year_unresolved';
        housingFacts.applicationStart = startDate;
      } else {
        range.start.value = startDate;
        range.start.yearSource = 'printed';
        range.end.value = endDate;
        range.end.yearSource = explicitEndYear ? 'printed' : 'range_start_context';
        range.resolution = explicitEndYear ? 'explicit_dates' : 'same_range_year';
        housingFacts.applicationStart = startDate;
        housingFacts.applicationEnd = endDate;
      }
      housingFacts.applicationPeriod = range;
    }
  }
  if (values.winnerAnnouncement) {
    const date = isoDate(values.winnerAnnouncement);
    if (date) housingFacts.winnerAnnouncementDate = date;
    if (/예정/.test(values.winnerAnnouncement)) housingFacts.winnerAnnouncementStatus = 'scheduled';
  }
  return { lines, rawLabels, housingFacts };
}

export function parseShNoticeDetail(html, { baseUrl = SH_NOTICE_HOME_URL, id = null, layout = expectedShNoticeLayout() } = {}) {
  checkedUrl(baseUrl);
  const nodes = nodesFor(html);
  const detail = nodes.find(node =>
    node.tagName === 'div' && (attr(node, 'class') ?? '').split(/\s+/).includes('detailTable'),
  );
  if (!detail) throw error('SH_NOTICE_LAYOUT_CHANGED', { pageType: 'detail', reason: 'detail_container_missing' });
  const caption = findAll(detail, node => node.tagName === 'caption')[0];
  if (!caption) throw error('SH_NOTICE_LAYOUT_CHANGED', { pageType: 'detail', reason: 'detail_caption_missing' });
  const metadata = clean(textContent(detail));
  const labels = DETAIL_LABELS.filter(label => new RegExp(label).test(metadata));
  if (!sameLabels(labels, DETAIL_LABELS)) {
    throw error('SH_NOTICE_LAYOUT_CHANGED', { pageType: 'detail', reason: 'detail_metadata_labels_missing', labels });
  }
  const fingerprint = assertLayout('detail', DETAIL_SELECTORS, DETAIL_LABELS, layout.detail);
  const content = findAll(detail, node =>
    node.tagName === 'td' && (attr(node, 'class') ?? '').split(/\s+/).includes('cont'),
  )[0] ?? null;
  if (!content) throw error('SH_NOTICE_LAYOUT_CHANGED', { pageType: 'detail', reason: 'detail_content_missing' });
  const bodyText = content ? textContent(content) : '';
  const facts = parseFactLines(bodyText);
  const publishedMatch = metadata.match(/등록일\s*[:：]\s*(\d{4}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{1,2})/);
  const publishedAt = publishedMatch ? isoDate(publishedMatch[1]) : null;
  const safeLines = facts.lines.filter(line =>
    !/(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:신청|계약|입주)?문의|☎|(?:^|\s)0\d{1,2}-\d{3,4}-\d{4})/i.test(line),
  );
  return {
    id: id == null ? null : String(id),
    title: clean(textContent(caption)),
    publishedAt,
    summary: safeLines.join(' | ').slice(0, 700) || null,
    rawLabels: {
      ...facts.rawLabels,
      ...(publishedAt ? { detailPublishedAt: { label: '등록일', value: publishedMatch[1] } } : {}),
    },
    ...(Object.keys(facts.housingFacts).length ? { housingFacts: facts.housingFacts } : {}),
    fingerprint: { selectors: fingerprint.selectors, headerLabels: fingerprint.headerLabels, headerHash: fingerprint.headerHash, hash: fingerprint.hash },
  };
}

async function request(fetchImpl, url, init, minIntervalMs) {
  const host = new URL(url).hostname;
  const delay = minIntervalMs - (Date.now() - (hostLastRequest.get(host) ?? 0));
  if (delay > 0) await sleep(delay);
  hostLastRequest.set(host, Date.now());
  return fetchImpl(url, init);
}

async function readBoundedResponse(response) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw error('SH_NOTICE_RESPONSE_TOO_LARGE', { bytes: declaredLength, maxBytes: MAX_RESPONSE_BYTES });
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw error('SH_NOTICE_RESPONSE_TOO_LARGE', { bytes: total, maxBytes: MAX_RESPONSE_BYTES });
      }
      chunks.push(chunk);
    }
  } catch (cause) {
    if (cause?.code) throw cause;
    throw error('SH_NOTICE_RESPONSE_READ_FAILED', { bytesRead: total });
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function fetchHtml(fetchImpl, initialUrl, {
  method = 'GET',
  body,
  minIntervalMs,
  timeoutMs,
  requestBudget,
  requests,
} = {}) {
  let url = checkedUrl(initialUrl).href;
  let verb = method;
  let requestBody = body;
  const redirects = [];
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (requests.length >= requestBudget || requests.length >= MAX_REQUESTS) {
      throw error('SH_NOTICE_REQUEST_BUDGET_EXHAUSTED', { requestCount: requests.length });
    }
    const parsedUrl = checkedUrl(url);
    const headerNames = ['accept', 'accept-language', 'user-agent', ...(verb === 'POST' ? ['content-type'] : [])];
    const init = {
      method: verb,
      redirect: 'manual',
      credentials: 'omit',
      headers: {
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
        'accept-language': 'ko-KR,ko;q=0.9,en;q=0.6',
        'user-agent': USER_AGENT,
        ...(verb === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
      ...(requestBody == null ? {} : { body: requestBody }),
    };
    let response;
    try {
      response = await request(fetchImpl, parsedUrl.href, init, minIntervalMs);
    } catch (cause) {
      const failureCode = cause?.name === 'TimeoutError' || cause?.name === 'AbortError' ? 'SH_NOTICE_TIMEOUT' : 'SH_NOTICE_FETCH_FAILED';
      requests.push({
        method: verb,
        url: parsedUrl.origin + parsedUrl.pathname,
        queryKeys: [...parsedUrl.searchParams.keys()].sort(),
        status: null,
        contentType: null,
        bytes: 0,
        sha256: null,
        requestHeaderNames: headerNames,
        requestedAt: new Date().toISOString(),
        error: failureCode,
      });
      throw error(failureCode, { method: verb, url: safeUrlReceipt(parsedUrl.href) });
    }
    const contentType = response.headers.get('content-type') ?? '';
    let bytes;
    try {
      bytes = await readBoundedResponse(response);
    } catch (cause) {
      requests.push({
        method: verb,
        url: parsedUrl.origin + parsedUrl.pathname,
        queryKeys: [...parsedUrl.searchParams.keys()].sort(),
        status: response.status,
        contentType,
        bytes: cause?.details?.bytes ?? cause?.details?.bytesRead ?? null,
        sha256: null,
        requestHeaderNames: headerNames,
        requestedAt: new Date().toISOString(),
        error: cause?.code ?? 'SH_NOTICE_RESPONSE_READ_FAILED',
      });
      throw cause;
    }
    requests.push({
      method: verb,
      url: parsedUrl.origin + parsedUrl.pathname,
      queryKeys: [...parsedUrl.searchParams.keys()].sort(),
      status: response.status,
      contentType,
      bytes: bytes.length,
      sha256: sha256(bytes),
      requestHeaderNames: headerNames,
      requestedAt: new Date().toISOString(),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location || hop === MAX_REDIRECTS) throw error('SH_NOTICE_REDIRECT_INVALID');
      const next = checkedUrl(location, parsedUrl.href);
      redirects.push({ from: parsedUrl.origin + parsedUrl.pathname, status: response.status, to: next.origin + next.pathname });
      if ([301, 302, 303].includes(response.status) && verb === 'POST') {
        verb = 'GET';
        requestBody = undefined;
      }
      url = next.href;
      continue;
    }
    const htmlMime = /(?:text\/html|application\/xhtml\+xml)/i.test(contentType);
    const decoded = htmlMime ? decodeHtml(bytes, contentType) : null;
    const challenge = decoded ? challengeFor(decoded.html) : null;
    if (challenge) throw error('SH_NOTICE_CHALLENGE_HTML', {
      challenge,
      status: response.status,
      url: safeUrlReceipt(parsedUrl.href),
    });
    if (!response.ok) throw error('SH_NOTICE_HTTP_' + response.status, {
      method: verb,
      url: safeUrlReceipt(parsedUrl.href),
      challenge,
    });
    if (!htmlMime) {
      throw error('SH_NOTICE_CONTENT_TYPE_INVALID', { contentType });
    }
    return {
      html: decoded.html,
      method: verb,
      url: parsedUrl.href,
      contentType,
      charset: decoded.charset,
      status: response.status,
      bytes: bytes.length,
      sha256: sha256(bytes),
      redirects,
    };
  }
  throw error('SH_NOTICE_REDIRECT_LIMIT');
}

function changeField(entries, field, value) {
  let found = false;
  const result = entries.map(([name, prior]) => {
    if (name !== field) return [name, prior];
    found = true;
    return [name, String(value)];
  });
  if (!found) throw error('SH_NOTICE_FORM_CONTRACT_CHANGED', { missingField: field });
  return result;
}

function receiptPage(result, pageType) {
  return {
    pageType,
    method: result.method,
    requested: safeUrlReceipt(result.url),
    status: result.status,
    contentType: result.contentType,
    charset: result.charset,
    bytes: result.bytes,
    sha256: result.sha256,
    redirects: result.redirects,
  };
}

function validateOptions(options) {
  const limits = [
    ['limit', options.limit, 1, 200],
    ['maxPages', options.maxPages, 1, 20],
    ['detailLimit', options.detailLimit, 0, 5],
    ['minIntervalMs', options.minIntervalMs, 0, 30_000],
    ['timeoutMs', options.timeoutMs, 1000, 60_000],
    ['requestBudget', options.requestBudget, 3, MAX_REQUESTS],
  ];
  for (const [name, value, min, max] of limits) {
    if (!Number.isInteger(value) || value < min || value > max) throw error('SH_NOTICE_OPTION_INVALID', { name, min, max });
  }
}

export async function collectShNotices({
  fetchImpl = fetch,
  now = new Date(),
  limit = 20,
  maxPages = 1,
  detailLimit = 2,
  minIntervalMs = 2000,
  timeoutMs = 20_000,
  requestBudget = MAX_REQUESTS,
} = {}) {
  const options = { limit, maxPages, detailLimit, minIntervalMs, timeoutMs, requestBudget };
  validateOptions(options);
  const receipt = {
    sourceId: SH_NOTICE_SOURCE_ID,
    checkedAt: new Date(now).toISOString(),
    executionMode: 'pure_http',
    authentication: 'anonymous_public',
    operations: {
      homepage: { method: 'GET', captured: false, clientExists: true, remnantFree: true, credentialPropagated: 'not_applicable_public_anonymous', liveReplay: false },
      noticeList: { method: 'HTML_GET_plus_observed_form_POST_pagination', captured: false, clientExists: true, remnantFree: true, credentialPropagated: 'not_applicable_public_anonymous', liveReplay: false },
      noticeDetail: { method: 'observed_form_POST', captured: false, clientExists: true, remnantFree: true, credentialPropagated: 'not_applicable_public_anonymous', liveReplay: false },
    },
    requests: [],
    pages: [],
    details: [],
    counts: { requests: 0, pages: 0, listed: 0, detailed: 0 },
    pagination: { requestedMaxPages: maxPages, visitedPages: [], nextPagePending: null, stoppedByBudget: false },
    layouts: {},
    error: null,
    ok: false,
    status: 'error',
    partialReasons: [],
  };
  try {
    const homepage = await fetchHtml(fetchImpl, SH_NOTICE_HOME_URL, { ...options, requests: receipt.requests });
    receipt.pages.push(receiptPage(homepage, 'homepage-entry'));
    let navigationPage = homepage;
    let homeInfo = parseShNoticeHomepage(homepage.html, { baseUrl: homepage.url });
    if (homeInfo.refreshUrl) {
      receipt.navigation = [{
        type: 'observed_meta_refresh',
        from: safeUrlReceipt(homepage.url),
        to: safeUrlReceipt(homeInfo.refreshUrl),
      }];
      navigationPage = await fetchHtml(fetchImpl, homeInfo.refreshUrl, { ...options, requests: receipt.requests });
      receipt.pages.push(receiptPage(navigationPage, 'homepage-main'));
      homeInfo = parseShNoticeHomepage(navigationPage.html, { baseUrl: navigationPage.url });
    }
    const listUrl = homeInfo.rentalListUrl;
    receipt.source = {
      id: SH_NOTICE_SOURCE_ID,
      owner: '서울주택도시개발공사(SH)',
      label: '공고 및 공지 · 주택임대',
      entryUrl: SH_NOTICE_HOME_URL,
      listUrl,
      transport: 'HTML Document GET plus observed read-only form POST',
    };

    const parsedPages = [];
    let formContract = null;
    let maxPageOnSite = 1;
    for (let pageNumber = 1; pageNumber <= maxPages && receipt.requests.length < requestBudget; pageNumber += 1) {
      let response;
      if (pageNumber === 1) {
        response = await fetchHtml(fetchImpl, listUrl, { ...options, requests: receipt.requests });
      } else {
        if (!formContract) break;
        const entries = changeField(formContract.entries, 'page', pageNumber);
        const body = new URLSearchParams(entries).toString();
        response = await fetchHtml(fetchImpl, formContract.action, { ...options, method: 'POST', body, requests: receipt.requests });
      }
      const parsed = parseShNoticeList(response.html, { baseUrl: response.url });
      if (pageNumber === 1) formContract = parsed.form;
      maxPageOnSite = Math.max(maxPageOnSite, parsed.maximumPageObserved);
      if (receipt.pagination.visitedPages.includes(parsed.pageNumber)) {
        throw error('SH_NOTICE_PAGINATION_STALLED', { page: parsed.pageNumber });
      }
      receipt.pagination.visitedPages.push(parsed.pageNumber);
      receipt.pages.push(receiptPage(response, 'notice-list'));
      receipt.layouts.list = parsed.layout;
      parsedPages.push(parsed);
      if (parsed.emptyResult || !parsed.items.length) break;
      if (pageNumber >= maxPages && pageNumber < maxPageOnSite) receipt.pagination.nextPagePending = pageNumber + 1;
      if (receipt.requests.length >= requestBudget && pageNumber < maxPageOnSite) {
        receipt.pagination.stoppedByBudget = true;
        receipt.pagination.nextPagePending = pageNumber + 1;
      }
    }
    if (!parsedPages.length) {
      throw error('SH_NOTICE_REQUEST_BUDGET_EXHAUSTED', { operation: 'notice_list', requestCount: receipt.requests.length });
    }
    const observedItems = parsedPages.flatMap(page => page.items);
    const items = observedItems.slice(0, limit);
    if (observedItems.length > limit) receipt.partialReasons.push('limit_truncated');
    receipt.counts.listed = items.length;
    receipt.counts.listedObserved = observedItems.length;
    if (!receipt.pagination.nextPagePending && Number(receipt.pagination.visitedPages.at(-1) ?? 0) < maxPageOnSite) {
      receipt.pagination.nextPagePending = Number(receipt.pagination.visitedPages.at(-1)) + 1;
    }
    receipt.operations.homepage.liveReplay = true;
    receipt.operations.noticeList.liveReplay = parsedPages.length > 0;

    const requestedDetails = items.slice(0, Math.min(detailLimit, items.length));
    if (requestedDetails.length < items.length) receipt.partialReasons.push('detail_sampling');
    for (const item of requestedDetails) {
      if (receipt.requests.length >= requestBudget) {
        receipt.pagination.stoppedByBudget = true;
        break;
      }
      const detailRequest = {
        id: item.id,
        method: 'POST',
        target: safeUrlReceipt(formContract.detailAction),
        requestFieldNames: formContract.entries.map(([name]) => name),
        sequenceField: 'seq',
      };
      try {
        const entries = changeField(formContract.entries, 'seq', item.id);
        const body = new URLSearchParams(entries).toString();
        const response = await fetchHtml(fetchImpl, formContract.detailAction, {
          ...options,
          method: 'POST',
          body,
          requests: receipt.requests,
        });
        const detail = parseShNoticeDetail(response.html, { baseUrl: response.url, id: item.id });
        if (detail.title && clean(detail.title) !== clean(item.title)) throw error('SH_NOTICE_DETAIL_TITLE_MISMATCH', { id: item.id });
        if (detail.publishedAt && item.publishedAt && detail.publishedAt !== item.publishedAt) {
          throw error('SH_NOTICE_DETAIL_DATE_MISMATCH', { id: item.id });
        }
        item.summary = detail.summary;
        if (detail.housingFacts && Object.keys(detail.housingFacts).length) item.housingFacts = detail.housingFacts;
        item.rawLabels = { ...item.rawLabels, ...detail.rawLabels };
        receipt.details.push({ ...receiptPage(response, 'notice-detail'), ...detailRequest });
        receipt.layouts.detail = detail.fingerprint;
        receipt.counts.detailed += 1;
      } catch (cause) {
        receipt.partialReasons.push('detail_unavailable');
        receipt.details.push({
          pageType: 'notice-detail',
          ...detailRequest,
          code: cause?.code ?? 'SH_NOTICE_DETAIL_FAILED',
          details: cause?.details ?? null,
        });
        // Detail failures remain visible as partial enrichment; no automatic retry is made.
      }
    }
    if (receipt.pagination.nextPagePending != null) receipt.partialReasons.push('pagination_pending');
    if (receipt.pagination.stoppedByBudget) receipt.partialReasons.push('request_budget');
    if (receipt.counts.detailed < requestedDetails.length && !receipt.partialReasons.includes('detail_unavailable')) {
      receipt.partialReasons.push('detail_incomplete');
    }
    receipt.operations.noticeDetail.liveReplay = receipt.counts.detailed > 0;
    receipt.counts.requests = receipt.requests.length;
    receipt.counts.pages = receipt.pages.length;
    receipt.ok = receipt.operations.noticeList.liveReplay;
    receipt.status = !receipt.ok ? 'error' : receipt.partialReasons.length ? 'partial' : 'read';
    return { source: receipt.source, items, receipt };
  } catch (cause) {
    receipt.error = { code: cause?.code ?? 'SH_NOTICE_FAILED', details: cause?.details ?? null };
    receipt.ok = false;
    receipt.status = 'error';
    receipt.counts.requests = receipt.requests.length;
    receipt.counts.pages = receipt.pages.length;
    if (cause && typeof cause === 'object') cause.receipt = receipt;
    throw cause;
  }
}
