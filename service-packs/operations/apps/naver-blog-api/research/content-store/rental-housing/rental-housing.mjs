#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  assertLayout,
  attr,
  createPublicClient,
  findAll,
  hasClass,
  parseHtml,
  structuralFingerprint,
  textContent
} from '../gov-discount-events/html-public.mjs';

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
export const RONE_SAMPLE_URL = 'https://www.reb.or.kr/r-one/openapi/SttsApiTblData.do?STATBL_ID=A_2024_00903&DTACYCLE_CD=MM&CLS_ID=500001&ITM_ID=100001&START_WRTTIME=2024&Type=json';
export const SH_NOTICE_LIST_URL = 'https://www.i-sh.co.kr/main/lay2/program/S1T294C297/www/brd/m_247/list.do?multi_itm_seq=2';
export const SH_NOTICE_DETAIL_URL = 'https://www.i-sh.co.kr/main/lay2/program/S1T294C297/www/brd/m_247/view.do';
export const MOLIT_PRESS_LIST_URL = 'https://www.molit.go.kr/USR/NEWS/m_71/lst.jsp';

const SH_LIST_HEADER_LABELS = ['번호', '제목', '담당부서', '등록일', '조회수'];
const SH_LIST_SELECTORS = [
  'form#mainform[method=post]',
  'input[name=page]',
  'table[header-labels=번호|제목|담당부서|등록일|조회수]',
  'div.mentcount[total-page-summary]'
];
const SH_LIST_FINGERPRINT = structuralFingerprint(SH_LIST_SELECTORS, SH_LIST_HEADER_LABELS);
const SH_DETAIL_HEADER_LABELS = ['등록일 :', '조회수 :'];
const SH_DETAIL_SELECTORS = [
  'table:tr.single-th-title',
  'table ul li strong:metadata-labels',
  'td.cont:body'
];
const SH_DETAIL_FINGERPRINT = structuralFingerprint(SH_DETAIL_SELECTORS, SH_DETAIL_HEADER_LABELS);
const SH_LIST_PAGE_SIZE = 10;

const cleanPublicText = node => textContent(node).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
const directCells = row => (row.childNodes ?? []).filter(node => node.tagName === 'th' || node.tagName === 'td');

function expectedLayoutFailure(reason) {
  return Object.assign(new Error('HTML_LAYOUT_CHANGED'), { code: 'HTML_LAYOUT_CHANGED', reason });
}

function parseShDetailId(anchor) {
  const match = /getDetailView\s*\(\s*(['"])(\d+)\1\s*\)/.exec(attr(anchor, 'onclick') ?? '');
  return match?.[2] ?? null;
}

function parsePageTarget(anchor) {
  const match = /getPaging\s*\(\s*(\d+)/.exec(attr(anchor, 'onclick') ?? '');
  return match ? Number(match[1]) : null;
}

export function parseShNoticeList(html, { url = SH_NOTICE_LIST_URL } = {}) {
  const document = parseHtml(html);
  const rows = findAll(document, node => node.tagName === 'tr');
  const headerRow = rows.find(row => directCells(row).map(cleanPublicText).join('|') === SH_LIST_HEADER_LABELS.join('|'));
  if (!headerRow) throw expectedLayoutFailure('SH_NOTICE_LIST_HEADER_MISSING');

  const listTable = findAll(document, node => node.tagName === 'table').find(table => findAll(table, node => node === headerRow).length > 0);
  const form = findAll(document, node => node.tagName === 'form' && attr(node, 'id') === 'mainform')[0];
  const pageInput = findAll(form ?? document, node => node.tagName === 'input' && attr(node, 'name') === 'page')[0];
  const countSummary = findAll(document, node => node.tagName === 'div' && hasClass(node, 'mentcount'))
    .map(cleanPublicText)
    .map(text => ({ text, match: /^총\s*([\d,]+)\s*건\s*\[\s*(\d+)\s*\/\s*(\d+)페이지\s*\]$/.exec(text) }))
    .find(item => item.match);
  const dataRows = findAll(listTable, node => node.tagName === 'tr').filter(row => {
    if (row === headerRow) return false;
    const cells = directCells(row);
    return cells.length === SH_LIST_HEADER_LABELS.length && /^\d+$/.test(cleanPublicText(cells[0]));
  });
  const emptyState = findAll(listTable, node => node.tagName === 'tr').some(row => /검색된 내용이 없습니다|등록된 게시물이 없습니다/.test(cleanPublicText(row)));
  if (!form || attr(form, 'method')?.toLowerCase() !== 'post' || !pageInput || !listTable || !countSummary) {
    throw expectedLayoutFailure('SH_NOTICE_LIST_REQUIRED_HOOK_MISSING');
  }
  const pageFromUrl = new URL(url).searchParams.get('page');
  const pageValue = Number(pageFromUrl ?? attr(pageInput, 'value') ?? '1');
  const totalRecords = Number(countSummary.match[1].replace(/,/g, ''));
  const summaryPage = Number(countSummary.match[2]);
  const totalPages = Number(countSummary.match[3]);
  const expectedTotalPages = Math.max(1, Math.ceil(totalRecords / SH_LIST_PAGE_SIZE));
  if (!Number.isInteger(pageValue) || pageValue < 1 || pageValue !== summaryPage || totalRecords < 0 || totalPages !== expectedTotalPages || pageValue > totalPages) {
    throw expectedLayoutFailure('SH_NOTICE_LIST_PAGINATION_SUMMARY_CHANGED');
  }
  const expectedRowCount = Math.max(0, Math.min(SH_LIST_PAGE_SIZE, totalRecords - ((pageValue - 1) * SH_LIST_PAGE_SIZE)));
  if (dataRows.length === 0 && (!emptyState || expectedRowCount !== 0)) throw expectedLayoutFailure('SH_NOTICE_LIST_EMPTY_WITHOUT_VALID_EMPTY_STATE');
  if (dataRows.length > 0 && emptyState) throw expectedLayoutFailure('SH_NOTICE_LIST_DATA_AND_EMPTY_STATE_CONFLICT');

  const items = dataRows.map(row => {
    const cells = directCells(row);
    const anchor = findAll(row, node => node.tagName === 'a').find(node => parseShDetailId(node));
    const rawValues = {
      noticeNo: cleanPublicText(cells[0]),
      title: cleanPublicText(cells[1]),
      department: cleanPublicText(cells[2]),
      registeredAt: cleanPublicText(cells[3]),
      viewCount: cleanPublicText(cells[4])
    };
    const detailId = anchor ? parseShDetailId(anchor) : null;
    if (!detailId || !rawValues.title) throw expectedLayoutFailure('SH_NOTICE_LIST_DETAIL_LINK_MISSING');
    const numericViews = Number(rawValues.viewCount.replace(/[^0-9]/g, ''));
    return {
      noticeNo: rawValues.noticeNo,
      detailId,
      title: rawValues.title,
      department: rawValues.department,
      registeredAt: rawValues.registeredAt,
      viewCount: Number.isFinite(numericViews) ? numericViews : null,
      rawLabels: {
        noticeNo: SH_LIST_HEADER_LABELS[0],
        title: SH_LIST_HEADER_LABELS[1],
        department: SH_LIST_HEADER_LABELS[2],
        registeredAt: SH_LIST_HEADER_LABELS[3],
        viewCount: SH_LIST_HEADER_LABELS[4]
      },
      rawValues,
      detailGetUrl: buildShNoticeDetailUrl(detailId)
    };
  });

  const actualSelectors = [];
  if (attr(form, 'id') === 'mainform' && attr(form, 'method')?.toLowerCase() === 'post') actualSelectors.push('form#mainform[method=post]');
  if (attr(pageInput, 'name') === 'page') actualSelectors.push('input[name=page]');
  if (listTable && directCells(headerRow).map(cleanPublicText).join('|') === SH_LIST_HEADER_LABELS.join('|')) {
    actualSelectors.push(`table[header-labels=${SH_LIST_HEADER_LABELS.join('|')}]`);
  }
  if (countSummary) actualSelectors.push('div.mentcount[total-page-summary]');
  const actualFingerprint = structuralFingerprint(actualSelectors, directCells(headerRow).map(cleanPublicText));
  assertLayout(actualFingerprint, SH_LIST_FINGERPRINT, {
    rowCount: items.length,
    minRows: expectedRowCount,
    maxRows: expectedRowCount,
    expectedRows: expectedRowCount,
    rowTolerance: 0
  });

  const pageTargets = [...new Set(findAll(document, node => node.tagName === 'a')
    .map(parsePageTarget).filter(Number.isInteger))].sort((a, b) => a - b);
  return {
    page: Number.isFinite(pageValue) && pageValue > 0 ? pageValue : 1,
    items,
    rowCount: items.length,
    empty: items.length === 0,
    headerLabels: [...SH_LIST_HEADER_LABELS],
    pagination: {
      pageField: attr(pageInput, 'name'),
      observedPageTargets: pageTargets,
      formMethod: attr(form, 'method').toUpperCase(),
      anonymousGetPageParameter: 'page',
      pageSize: SH_LIST_PAGE_SIZE,
      totalRecords,
      totalPages
    },
    fingerprint: actualFingerprint
  };
}

function safeShUrl(href, baseUrl) {
  if (!href) return null;
  try {
    const url = new URL(href, baseUrl);
    return url.protocol === 'https:' && url.hostname === 'www.i-sh.co.kr' ? url.href : null;
  } catch { return null; }
}

export function buildShNoticeDetailUrl(seq, multiItemSeq = '2') {
  const id = String(seq ?? '');
  if (!/^\d+$/.test(id)) throw new TypeError('SH_NOTICE_SEQ_INVALID');
  const category = String(multiItemSeq);
  if (!/^\d+$/.test(category)) throw new TypeError('SH_NOTICE_CATEGORY_INVALID');
  const url = new URL(SH_NOTICE_DETAIL_URL);
  url.searchParams.set('seq', id);
  url.searchParams.set('multi_itm_seq', category);
  return url.href;
}

export function parseShNoticeDetail(html, { url } = {}) {
  const document = parseHtml(html);
  const tables = findAll(document, node => node.tagName === 'table');
  const detailTable = tables.find(table => findAll(table, node => node.tagName === 'td' && hasClass(node, 'cont')).length > 0);
  if (!detailTable) throw expectedLayoutFailure('SH_NOTICE_DETAIL_BODY_HOOK_MISSING');
  const tableRows = findAll(detailTable, node => node.tagName === 'tr');
  const titleRow = tableRows.find(row => {
    const cells = directCells(row);
    return cells.length === 1 && cells[0].tagName === 'th' && cleanPublicText(cells[0]);
  });
  const metaRow = tableRows.find(row => findAll(row, node => node.tagName === 'strong').length >= 2);
  const contentCell = findAll(detailTable, node => node.tagName === 'td' && hasClass(node, 'cont'))[0];
  if (!titleRow || !metaRow || !contentCell) throw expectedLayoutFailure('SH_NOTICE_DETAIL_REQUIRED_HOOK_MISSING');

  const metadata = findAll(metaRow, node => node.tagName === 'li').map(item => {
    const labelNode = findAll(item, node => node.tagName === 'strong')[0];
    const rawLabel = cleanPublicText(labelNode);
    const rawItem = cleanPublicText(item);
    const rawValue = rawItem.slice(rawLabel.length).replace(/^\s*[:：]?\s*/, '').trim();
    return { rawLabel, rawValue };
  });
  const registeredAt = metadata.find(item => item.rawLabel.includes('등록일'));
  const views = metadata.find(item => item.rawLabel.includes('조회수'));
  if (!registeredAt || !views) throw expectedLayoutFailure('SH_NOTICE_DETAIL_METADATA_LABELS_CHANGED');

  const attachments = tableRows.flatMap(row => {
    const labels = directCells(row);
    if (!labels.some(cell => cell.tagName === 'th' && cleanPublicText(cell) === '첨부')) return [];
    const fileAnchor = findAll(row, node => node.tagName === 'a' && (attr(node, 'class') ?? '').split(/\s+/).includes('btnAttach'))[0];
    const previewAnchor = findAll(row, node => node.tagName === 'a' && (attr(node, 'class') ?? '').split(/\s+/).includes('icoView'))[0];
    if (!fileAnchor) return [];
    const fileIndexMatch = /existFile\s*\(\s*(['"])(\d+)\1\s*\)/.exec(attr(fileAnchor, 'onclick') ?? '');
    return [{
      fileName: cleanPublicText(fileAnchor),
      fileIndex: fileIndexMatch ? Number(fileIndexMatch[2]) : null,
      previewUrl: previewAnchor ? safeShUrl(attr(previewAnchor, 'href'), url ?? SH_NOTICE_DETAIL_URL) : null,
      rawLabel: '첨부'
    }];
  });

  const rawTitle = cleanPublicText(directCells(titleRow)[0]);
  const rawViews = views.rawValue;
  const numericViews = Number(rawViews.replace(/[^0-9]/g, ''));
  const sourceUrl = url ? new URL(url) : null;
  const detailHeaderLabels = [registeredAt.rawLabel, views.rawLabel];
  const actualSelectors = [];
  if (titleRow && directCells(titleRow).length === 1 && directCells(titleRow)[0].tagName === 'th') actualSelectors.push('table:tr.single-th-title');
  if (metadata.length > 0 && metadata.every(item => item.rawLabel)) actualSelectors.push('table ul li strong:metadata-labels');
  if (contentCell && hasClass(contentCell, 'cont')) actualSelectors.push('td.cont:body');
  const actualFingerprint = structuralFingerprint(actualSelectors, detailHeaderLabels);
  assertLayout(actualFingerprint, SH_DETAIL_FINGERPRINT, {
    rowCount: metadata.length,
    minRows: SH_DETAIL_HEADER_LABELS.length,
    maxRows: SH_DETAIL_HEADER_LABELS.length,
    expectedRows: SH_DETAIL_HEADER_LABELS.length,
    rowTolerance: 0
  });
  return {
    id: sourceUrl?.searchParams.get('seq') ?? null,
    title: rawTitle,
    registeredAt: registeredAt.rawValue,
    viewCount: Number.isFinite(numericViews) ? numericViews : null,
    body: cleanPublicText(contentCell),
    attachments,
    rawLabels: {
      title: '게시글 제목 셀',
      registeredAt: registeredAt.rawLabel,
      viewCount: views.rawLabel,
      attachment: attachments.length ? '첨부' : null
    },
    rawValues: { title: rawTitle, registeredAt: registeredAt.rawValue, viewCount: rawViews },
    sourceUrl: sourceUrl?.href ?? null,
    headerLabels: detailHeaderLabels,
    fingerprint: actualFingerprint
  };
}

function preventRepeatedSelfRedirect(fetchImpl) {
  let redirectTarget = null;
  return async (input, options) => {
    const currentUrl = String(input);
    if (redirectTarget === currentUrl) {
      redirectTarget = null;
      throw Object.assign(new Error('HTTP_307_SELF_REDIRECT'), { code: 'HTTP_307_SELF_REDIRECT' });
    }
    const response = await fetchImpl(input, options);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      let target = null;
      try { target = location ? new URL(location, currentUrl).href : null; } catch { /* the client classifies malformed redirects */ }
      redirectTarget = target === currentUrl ? target : null;
    } else {
      redirectTarget = null;
    }
    return response;
  };
}

export function createRentalPublicClient(options = {}) {
  return createPublicClient({
    ...options,
    allowedHosts: ['www.i-sh.co.kr', 'www.molit.go.kr'],
    fetchImpl: preventRepeatedSelfRedirect(options.fetchImpl ?? fetch)
  });
}

function requireUsableHtml(result, sourceId) {
  if (result.error) throw Object.assign(new Error(`${sourceId}_${result.error}`), { code: result.error, responseMeta: result.meta });
  if (!result.html) throw Object.assign(new Error(`${sourceId}_HTML_EMPTY`), { code: 'HTML_EMPTY', responseMeta: result.meta });
  return result;
}

export async function collectShNoticeList({ client = createRentalPublicClient(), page = 1 } = {}) {
  if (!Number.isInteger(page) || page < 1) throw new TypeError('SH_NOTICE_PAGE_INVALID');
  const url = new URL(SH_NOTICE_LIST_URL);
  if (page > 1) url.searchParams.set('page', String(page));
  const response = requireUsableHtml(await client.get(url.href, { sourceId: 'sh-main-notices', pageType: 'list' }), 'SH_NOTICE_LIST');
  return { response, parsed: parseShNoticeList(response.html, { url: response.url }) };
}

export async function collectShNoticeDetail({ client = createRentalPublicClient(), seq, multiItemSeq = '2' } = {}) {
  const url = buildShNoticeDetailUrl(seq, multiItemSeq);
  const response = requireUsableHtml(await client.get(url, { sourceId: 'sh-main-notices', pageType: 'detail' }), 'SH_NOTICE_DETAIL');
  return { response, parsed: parseShNoticeDetail(response.html, { url: response.url }) };
}

export async function collectShNoticePages({ client = createRentalPublicClient(), firstPage = 1, maxPages = 1 } = {}) {
  if (!Number.isInteger(firstPage) || firstPage < 1) throw new TypeError('SH_NOTICE_FIRST_PAGE_INVALID');
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 40) throw new TypeError('SH_NOTICE_PAGE_BUDGET_INVALID');
  const pages = [];
  for (let page = firstPage; page < firstPage + maxPages; page++) {
    const result = await collectShNoticeList({ client, page });
    pages.push(result);
    if (result.parsed.empty || page >= result.parsed.pagination.totalPages) break;
  }
  return { pages, itemCount: pages.reduce((total, result) => total + result.parsed.items.length, 0) };
}

export async function collectMolitPressList({ client = createRentalPublicClient() } = {}) {
  const response = await client.get(MOLIT_PRESS_LIST_URL, { sourceId: 'molit-press', pageType: 'list' });
  const verdict = response.error ? `blocked_${response.error.toLowerCase()}` : 'html_only';
  const detail = response.error
    ? { verdict: 'blocked_upstream_list_unavailable', url: null, reason: `No list HTML or detail link was returned (${response.error}).` }
    : { verdict: 'html_only', url: null, reason: 'List response is available but the detail URL has not been parsed.' };
  const reason = response.error === 'HTTP_307_SELF_REDIRECT'
    ? 'Anonymous GET received HTTP 307 with Location equal to the requested URL and an empty body; no press-list fields or detail link were returned.'
    : response.error ? `Anonymous GET failed at ${response.error}.` : 'The direct GET response has not been parsed yet.';
  return { response, parsed: null, verdict, reason, detail };
}

export function parseRoneStatData(value) {
  const root = typeof value === 'string' ? JSON.parse(value) : value;
  const blocks = root?.SttsApiTblData;
  if (!Array.isArray(blocks)) throw new Error('RONE_SCHEMA');
  const total = Number(blocks[0]?.head?.[0]?.list_total_count ?? 0);
  const result = blocks[0]?.head?.[1]?.RESULT ?? null;
  const rows = (blocks.find(block => Array.isArray(block.row))?.row ?? []).map(row => ({
    tableId: row.STATBL_ID ?? null,
    cycle: row.DTACYCLE_CD ?? null,
    period: row.WRTTIME_IDTFR_ID ?? null,
    periodLabel: row.WRTTIME_DESC ?? null,
    regionId: row.CLS_ID == null ? null : String(row.CLS_ID),
    region: row.CLS_FULLNM ?? row.CLS_NM ?? null,
    itemId: row.ITM_ID == null ? null : String(row.ITM_ID),
    item: row.ITM_FULLNM ?? row.ITM_NM ?? null,
    value: row.DTA_VAL == null || row.DTA_VAL === '' ? null : Number(row.DTA_VAL),
    unit: row.UI_NM ?? null
  }));
  return { total, result, rows };
}

export async function collectRoneSample({ fetchImpl = fetch, url = RONE_SAMPLE_URL } = {}) {
  const response = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  if (response.status >= 300 && response.status < 400) throw new Error('RONE_REDIRECT');
  if (!response.ok) throw new Error(`RONE_HTTP_${response.status}`);
  const raw = await response.text();
  return { raw, parsed: parseRoneStatData(raw), status: response.status, contentType: response.headers.get('content-type') };
}

async function main() {
  const out = process.argv.find(arg => arg.startsWith('--out='))?.slice(6);
  if (!out) throw new Error('OUT_REQUIRED');
  const capturedAt = new Date().toISOString();
  const source = process.argv.find(arg => arg.startsWith('--source='))?.slice(9);
  if (source === 'sh-notices') {
    const client = createRentalPublicClient();
    const list = await collectShNoticeList({ client });
    const relevant = list.parsed.items.find(item => /장기전세|미리내집|SHift/.test(item.title));
    const detail = relevant ? await collectShNoticeDetail({ client, seq: relevant.detailId }) : null;
    const summary = {
      schemaVersion: 1,
      checkedAt: new Date().toISOString(),
      source: 'sh-main-notices',
      list: { page: list.parsed.page, count: list.parsed.rowCount, fingerprint: list.parsed.fingerprint },
      detail: detail ? { id: detail.parsed.id, title: detail.parsed.title, registeredAt: detail.parsed.registeredAt, attachments: detail.parsed.attachments.length } : null,
      captures: [list.response.captureFiles, ...(detail ? [detail.response.captureFiles] : [])]
    };
    await mkdir(`${out}/captures`, { recursive: true });
    await writeFile(`${out}/sh-notices-live.json`, JSON.stringify(summary, null, 2) + '\n');
    console.log(JSON.stringify(summary));
    return;
  }
  if (source === 'molit-press') {
    const result = await collectMolitPressList();
    const summary = {
      schemaVersion: 1,
      checkedAt: result.response.checkedAt,
      source: 'molit-press',
      verdict: result.verdict,
      status: result.response.status,
      error: result.response.error,
      reason: result.reason,
      url: result.response.url,
      captures: result.response.captureFiles ? [result.response.captureFiles] : [],
      detail: result.detail
    };
    await mkdir(`${out}/captures`, { recursive: true });
    await writeFile(`${out}/molit-press-live.json`, JSON.stringify(summary, null, 2) + '\n');
    console.log(JSON.stringify(summary));
    return;
  }

  const result = await collectRoneSample();
  await mkdir(`${out}/captures`, { recursive: true });
  await writeFile(`${out}/captures/rone-live-data-1.json`, result.raw);
  await writeFile(`${out}/captures/rone-live-data-1.meta.json`, JSON.stringify({ capturedAt, method: 'GET', url: RONE_SAMPLE_URL, status: result.status, contentType: result.contentType, credential: false, mode: 'official_keyless_sample' }, null, 2) + '\n');
  const summary = { schemaVersion: 1, checkedAt: capturedAt, source: 'rone-openapi-sample', count: result.parsed.rows.length, advertisedTotal: result.parsed.total, sampleLimited: true };
  await writeFile(`${out}/live-run.json`, JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; });
