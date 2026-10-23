import {
  DEFAULT_CAPTURE_DIR,
  assertLayout,
  attr,
  createPublicClient,
  findAll,
  hasClass,
  links,
  parseHtml,
  structuralFingerprint,
  textContent
} from './html-public.mjs';

export const FSALE_HOME_URL = 'https://fsale.kr/';
export const FSALE_BOARD_URLS = Object.freeze({
  coupon: 'https://fsale.kr/bbs/board.php?bo_table=coupon',
  directmarket: 'https://fsale.kr/bbs/board.php?bo_table=directmarket',
  zero1: 'https://fsale.kr/bbs/board.php?bo_table=zero1',
  onnuri1: 'https://fsale.kr/bbs/board.php?bo_table=onnuri1'
});

const compact = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const nodesWithClass = (root, tagName, className) => findAll(root, node =>
  (!tagName || node.tagName === tagName) && hasClass(node, className));
const textByClass = (root, className) => compact(textContent(nodesWithClass(root, null, className)[0]));
const pageTitle = doc => compact(textContent(findAll(doc, node => node.tagName === 'title')[0]));

const LAYOUTS = Object.freeze({
  home: {
    selectors: ['title', 'a[href*="bo_table=coupon"]', 'a[href*="bo_table=directmarket"]', 'a[href*="bo_table=zero1"]', 'a[href*="bo_table=onnuri1"]'],
    // The directmarket carousel link is image-only and has no alt/title in the live HTML.
    labels: ['진행중인 기획전', '', '제로페이', '온누리 상품권']
  },
  coupon: {
    selectors: ['#gall_ul.gall_row', 'li.gall_li', '.coupon_box', '.bo_cnt', '.alink a[href]'],
    labels: []
  },
  directmarket: {
    selectors: ['table thead th', 'table tbody tr', '.mart_desc .subj', '.mart_desc .addr', '.mapLink a[href]'],
    labels: ['No', '상점 정보']
  },
  emptyBoard: {
    selectors: ['table thead th', 'table tbody tr', 'table td'],
    labels: ['No', '상점 정보']
  }
});

function fingerprint(doc, layoutId, presentSelectors) {
  const expectedSpec = LAYOUTS[layoutId];
  const actual = structuralFingerprint(presentSelectors, expectedSpec.labels);
  const expected = structuralFingerprint(expectedSpec.selectors, expectedSpec.labels);
  return { fingerprint: assertLayout(actual, expected, { rowCount: 0, minRows: 0, maxRows: 10000 }), expected };
}

function statusFor(response) {
  return response.error ? 'unavailable' : 'read';
}

function responseError(response) {
  return response.error ? { code: response.error, challenge: response.challenge, httpStatus: response.httpStatus } : null;
}

function parseCount(text) {
  const match = String(text ?? '').match(/Total\s*(\d+)\s*건/i);
  return match ? Number(match[1]) : null;
}

function queryPageNumber(url) {
  return Number(new URL(url).searchParams.get('page') || 1);
}

function isSameBoardPage(link, baseUrl, boardName) {
  const linkUrl = new URL(link.url);
  const base = new URL(baseUrl);
  linkUrl.hash = '';
  return linkUrl.origin === base.origin && linkUrl.pathname === base.pathname &&
    linkUrl.searchParams.get('bo_table') === boardName;
}

function discoveredPagination(doc, sourceUrl, boardName) {
  return [...new Set(links(doc, sourceUrl)
    .filter(link => isSameBoardPage(link, sourceUrl, boardName))
    .filter(link => link.node && (hasClass(link.node, 'pg_page') || /[?&]page=\d+/.test(link.url)))
    .map(link => {
      const url = new URL(link.url);
      url.hash = '';
      return url.href;
    }).filter(url => queryPageNumber(url) > 1))]
    .sort((left, right) => queryPageNumber(left) - queryPageNumber(right));
}

function detailLinksInBoard(doc, sourceUrl, boardName) {
  return [...new Map(links(doc, sourceUrl)
    .filter(link => isSameBoardPage(link, sourceUrl, boardName))
    .filter(link => new URL(link.url).searchParams.has('wr_id'))
    .map(link => [link.url, { text: link.text, url: link.url }])).values()];
}

function categoryViews(doc, sourceUrl) {
  return [...new Map(links(doc, sourceUrl)
    .filter(link => isSameBoardPage(link, sourceUrl, 'coupon'))
    .map(link => {
      const url = new URL(link.url);
      const category = url.searchParams.get('sca');
      return category ? [category, { categoryRaw: category, url: url.href, linkLabelRaw: link.text }] : null;
    }).filter(Boolean))].map(([, value]) => value);
}

function parseRate(value) {
  const match = String(value ?? '').match(/(\d+(?:\.\d+)?)\s*%/);
  return match ? Number(match[1]) : null;
}

function dateStatus(startDate, endDate, checkedAt) {
  if (!startDate || !endDate) return 'unknown';
  const today = String(checkedAt).slice(0, 10);
  if (endDate < today) return 'ended';
  if (startDate > today) return 'upcoming';
  return 'active';
}

function parseCouponRows(doc, sourceUrl) {
  const container = findAll(doc, node => node.tagName === 'ul' && attr(node, 'id') === 'gall_ul' && hasClass(node, 'gall_row'))[0];
  if (!container) return { error: 'HTML_LAYOUT_CHANGED', records: [], totalCount: null };
  const rowNodes = (container.childNodes ?? []).filter(node => node.tagName === 'li' && hasClass(node, 'gall_li'));
  const totalCount = parseCount(textContent(doc));
  const records = rowNodes.map((row, index) => {
    const maxDiscountLabelRaw = textByClass(row, 'coupon_box') || null;
    const descriptionRaw = textByClass(row, 'bo_cnt') || null;
    const cover = nodesWithClass(row, 'div', 'cover_none')[0] ?? null;
    const logo = findAll(row, node => node.tagName === 'img').find(node => {
      let parent = node.parentNode;
      while (parent && parent !== row) {
        if (hasClass(parent, 'member_logo')) return true;
        parent = parent.parentNode;
      }
      return false;
    }) ?? null;
    const retailerLogoUrl = logo ? new URL(attr(logo, 'src'), sourceUrl).href : null;
    const clickThrough = links(row, sourceUrl).find(link => {
      const url = new URL(link.url);
      return url.hostname === 'fsale.kr' && url.pathname === '/bbs/link.php';
    }) ?? null;
    const numberText = textByClass(row, 'sound_only') || null;
    return {
      id: clickThrough ? `fsale-coupon-${new URL(clickThrough.url).searchParams.get('wr_id')}` : `fsale-coupon-row-${numberText ?? index + 1}`,
      rowNumberRaw: numberText,
      maximumDiscountLabelRaw: maxDiscountLabelRaw,
      ratePercent: parseRate(maxDiscountLabelRaw),
      capAmountKrw: null,
      capLabelRaw: null,
      periodStart: null,
      periodEnd: null,
      periodRaw: null,
      status: 'unknown',
      campaignState: /행사 준비중/.test(descriptionRaw ?? '') ? 'advertised_preparing' : 'advertised_unknown_dates',
      retailerLabelRaw: null,
      retailerLogoUrl,
      statusLabelRaw: /행사 준비중|종료|마감/.test(descriptionRaw ?? '') ? descriptionRaw : null,
      statusClassRaw: cover ? attr(cover, 'class') : null,
      descriptionLabelRaw: descriptionRaw,
      promotionTextRaw: textByClass(row, 'gall_con'),
      clickThroughUrl: clickThrough?.url ?? null,
      sourceUrl,
      fieldLabels: {
        maximumDiscount: maxDiscountLabelRaw ? '최대 할인' : null,
        description: descriptionRaw ? '쿠폰 목록 설명(.bo_cnt)' : null,
        retailer: null
      },
      listIndex: index
    };
  });
  return { records, totalCount, container };
}

/** Parses one server-rendered Fsale coupon view. The post cards are previews, not dated terms. */
export function parseFsaleCoupon(html, { sourceUrl = FSALE_BOARD_URLS.coupon, checkedAt = new Date().toISOString() } = {}) {
  const doc = parseHtml(html);
  const parsed = parseCouponRows(doc, sourceUrl);
  if (parsed.error) throw Object.assign(new Error(parsed.error), { code: parsed.error });
  const present = [
    attr(parsed.container, 'id') === 'gall_ul' && hasClass(parsed.container, 'gall_row') ? '#gall_ul.gall_row' : null,
    parsed.records.length ? 'li.gall_li' : null,
    parsed.records.some(record => record.maximumDiscountLabelRaw) ? '.coupon_box' : null,
    parsed.records.some(record => record.descriptionLabelRaw) ? '.bo_cnt' : null,
    findAll(parsed.container, node => node.tagName === 'a' && attr(node, 'href')).length ? '.alink a[href]' : null
  ].filter(Boolean);
  const { fingerprint: layoutFingerprint } = fingerprint(doc, 'coupon', present);
  const pageLinks = discoveredPagination(doc, sourceUrl, 'coupon');
  if (!pageLinks.length && parsed.totalCount !== parsed.records.length) {
    throw Object.assign(new Error('HTML_LAYOUT_CHANGED'), { code: 'HTML_LAYOUT_CHANGED' });
  }
  const postDetails = detailLinksInBoard(doc, sourceUrl, 'coupon');
  const filterViews = categoryViews(doc, sourceUrl);
  const url = new URL(sourceUrl);
  return {
    checkedAt,
    sourceUrl,
    pageType: 'coupon-list',
    categoryRaw: url.searchParams.get('sca') ?? '전체',
    pageTitleRaw: pageTitle(doc),
    totalCount: parsed.totalCount,
    receivedCount: parsed.records.length,
    parsedCount: parsed.records.length,
    paginationUrls: pageLinks,
    detailPageUrls: postDetails,
    categoryViews: filterViews,
    records: parsed.records,
    layoutFingerprint
  };
}

function getTable(doc) {
  return findAll(doc, node => node.tagName === 'table').find(table => {
    const labels = findAll(table, node => node.tagName === 'th').map(node => compact(textContent(node)));
    return labels.includes('No') && labels.includes('상점 정보');
  }) ?? null;
}

function getHeaderLabels(table) {
  return findAll(table, node => node.tagName === 'th').map(node => compact(textContent(node))).filter(Boolean);
}

function rowCells(row) {
  return (row.childNodes ?? []).filter(node => node.tagName === 'td' || node.tagName === 'th');
}

function parseRowNumber(cell) {
  const raw = compact(textContent(cell));
  const match = raw.match(/\d+/);
  return { rowNumberRaw: raw, rowNumber: match ? Number(match[0]) : null };
}

function parseIsoDate(dateLabelRaw, contextYear) {
  const match = String(dateLabelRaw ?? '').match(/(\d{1,2})\.(\d{1,2})/);
  if (!match || !contextYear) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const date = new Date(Date.UTC(Number(contextYear), month - 1, day));
  if (date.getUTCFullYear() !== Number(contextYear) || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${contextYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseDirectmarketRow(row, sourceUrl, contextYear, checkedAt) {
  const cells = rowCells(row);
  if (cells.length < 2) return null;
  const number = parseRowNumber(cells[0]);
  if (!number.rowNumber) return null;
  const detail = nodesWithClass(cells[1], 'div', 'mart_desc')[0] ?? null;
  const dateNode = detail ? nodesWithClass(detail, 'span', 'subj')[0] : null;
  const addressNode = detail ? nodesWithClass(detail, 'div', 'addr')[0] : null;
  const dateLabelRaw = dateNode ? compact(textContent(dateNode)) : null;
  const addressRaw = addressNode ? compact(textContent(addressNode)) : null;
  const separatorRaw = detail ? (detail.childNodes ?? []).filter(node => node.nodeName === '#text').map(node => node.value).join(' ').replace(/\s+/g, ' ').trim() : '';
  const areaMatch = separatorRaw.match(/\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*$/);
  const mapLink = links(cells[1], sourceUrl).find(link => new URL(link.url).hostname === 'map.naver.com') ?? null;
  const eventDate = parseIsoDate(dateLabelRaw, contextYear);
  return {
    id: `fsale-directmarket-${number.rowNumber}`,
    rowNumber: number.rowNumber,
    rowNumberRaw: number.rowNumberRaw,
    eventDate,
    periodStart: eventDate,
    periodEnd: eventDate,
    periodRaw: dateLabelRaw,
    status: dateStatus(eventDate, eventDate, checkedAt),
    dateLabelRaw,
    region: areaMatch ? compact(areaMatch[1]) : null,
    regionLabelRaw: areaMatch ? compact(areaMatch[1]) : null,
    municipality: areaMatch ? compact(areaMatch[2]) : null,
    municipalityLabelRaw: areaMatch ? compact(areaMatch[2]) : null,
    address: addressRaw,
    addressLabelRaw: '상점 정보',
    ratePercent: null,
    rateLabelRaw: null,
    capAmountKrw: null,
    capLabelRaw: null,
    venueName: null,
    venueNameLabelRaw: null,
    mapLinkUrl: mapLink?.url ?? null,
    sourceUrl,
    fieldLabels: {
      eventDate: '게시판 날짜(.mart_desc .subj)',
      regionAndMunicipality: '행 표시의 구분 라벨(.mart_desc)',
      address: '상점 정보(.mart_desc .addr)'
    }
  };
}

function parseGenericBoardRows(table, sourceUrl, boardName) {
  const rows = findAll(table, node => node.tagName === 'tr');
  const dataRows = rows.filter(row => rowCells(row).some(cell => cell.tagName === 'td'));
  const emptyNode = findAll(table, node => hasClass(node, 'empty_table'))[0] ?? null;
  if (emptyNode) return { records: [], emptyStateLabelRaw: compact(textContent(emptyNode)) };
  const records = dataRows.map((row, index) => {
    const cells = rowCells(row);
    if (!cells.length) return null;
    const rawText = compact(textContent(row));
    const detailLink = links(row, sourceUrl).find(link => {
      const url = new URL(link.url);
      return url.hostname === 'fsale.kr' && url.searchParams.get('bo_table') === boardName && url.searchParams.has('wr_id');
    }) ?? null;
    const rateRaw = rawText.match(/[^\s]{0,20}\d+(?:\.\d+)?\s*%[^\s]{0,20}/)?.[0] ?? null;
    return {
      id: detailLink ? `fsale-${boardName}-${new URL(detailLink.url).searchParams.get('wr_id')}` : `${boardName}-row-${index + 1}`,
      titleRaw: rawText,
      periodStart: null,
      periodEnd: null,
      periodRaw: null,
      status: 'unknown',
      ratePercent: parseRate(rateRaw),
      rateLabelRaw: rateRaw,
      capAmountKrw: null,
      capLabelRaw: null,
      detailUrl: detailLink?.url ?? null,
      sourceUrl,
      fieldLabels: { title: '상점 정보' }
    };
  }).filter(Boolean);
  return { records, emptyStateLabelRaw: null };
}

/** Parses directmarket rows or an event-specific Fsale ZeroPay/Onnuri board. */
export function parseFsaleBoard(html, { boardName, sourceUrl = FSALE_BOARD_URLS[boardName], checkedAt = new Date().toISOString() } = {}) {
  if (!['directmarket', 'zero1', 'onnuri1'].includes(boardName)) throw new TypeError('FSALE_BOARD_NAME_UNSUPPORTED');
  const doc = parseHtml(html);
  const table = getTable(doc);
  if (!table) throw Object.assign(new Error('HTML_LAYOUT_CHANGED'), { code: 'HTML_LAYOUT_CHANGED' });
  const headerLabels = getHeaderLabels(table);
  const allRows = findAll(table, node => node.tagName === 'tr');
  const emptyRow = allRows.find(row => hasClass(row, 'empty_table')) ?? null;
  const countText = compact(textContent(doc));
  const totalCount = parseCount(countText);
  const title = pageTitle(doc);
  const yearMatch = title.match(/\b(20\d{2})\b/);
  const contextYear = yearMatch?.[1] ?? null;
  let records;
  let emptyStateLabelRaw = null;
  let actualSelectors;
  if (boardName === 'directmarket') {
    records = allRows.map(row => parseDirectmarketRow(row, sourceUrl, contextYear, checkedAt)).filter(Boolean);
    emptyStateLabelRaw = emptyRow ? compact(textContent(emptyRow)) : null;
    actualSelectors = [
      table ? 'table thead th' : null,
      allRows.length ? 'table tbody tr' : null,
      records.some(record => record.dateLabelRaw) ? '.mart_desc .subj' : null,
      records.some(record => record.address) ? '.mart_desc .addr' : null,
      records.some(record => record.mapLinkUrl) ? '.mapLink a[href]' : null
    ].filter(Boolean);
  } else {
    const parsed = parseGenericBoardRows(table, sourceUrl, boardName);
    records = parsed.records;
    emptyStateLabelRaw = parsed.emptyStateLabelRaw;
    actualSelectors = [table ? 'table thead th' : null, allRows.length ? 'table tbody tr' : null,
      findAll(table, node => node.tagName === 'td').length ? 'table td' : null].filter(Boolean);
  }
  const actualFingerprint = structuralFingerprint(actualSelectors, headerLabels);
  const expectedLayout = structuralFingerprint(...(boardName === 'directmarket'
    ? [LAYOUTS.directmarket.selectors, LAYOUTS.directmarket.labels]
    : [LAYOUTS.emptyBoard.selectors, LAYOUTS.emptyBoard.labels]));
  const maxRows = boardName === 'directmarket' ? 15 : 500;
  const pageNumber = queryPageNumber(sourceUrl);
  const expectedRows = boardName === 'directmarket' && totalCount != null
    ? Math.max(0, Math.min(15, totalCount - (15 * (pageNumber - 1))))
    : records.length;
  const layoutFingerprint = assertLayout(actualFingerprint, expectedLayout, {
    rowCount: records.length,
    minRows: boardName === 'directmarket' ? expectedRows : 0,
    maxRows: boardName === 'directmarket' ? expectedRows : maxRows
  });
  if (!records.length && (totalCount !== 0 || emptyStateLabelRaw !== '게시물이 없습니다.')) {
    throw Object.assign(new Error('HTML_LAYOUT_CHANGED'), { code: 'HTML_LAYOUT_CHANGED' });
  }
  const paginationUrls = discoveredPagination(doc, sourceUrl, boardName);
  const detailPageUrls = detailLinksInBoard(doc, sourceUrl, boardName);
  return {
    checkedAt,
    sourceUrl,
    pageType: `${boardName}-list`,
    boardName,
    pageTitleRaw: title,
    contextYear,
    totalCount,
    receivedCount: records.length,
    parsedCount: records.length,
    emptyStateLabelRaw,
    paginationUrls,
    detailPageUrls,
    records,
    layoutFingerprint
  };
}

export function parseFsaleLanding(html, { sourceUrl = FSALE_HOME_URL, checkedAt = new Date().toISOString() } = {}) {
  const doc = parseHtml(html);
  const allLinks = links(doc, sourceUrl);
  const entries = Object.entries(FSALE_BOARD_URLS).map(([boardName, expectedUrl]) => {
    const found = allLinks.find(link => {
      const url = new URL(link.url);
      return url.hostname === 'fsale.kr' && url.pathname === '/bbs/board.php' && url.searchParams.get('bo_table') === boardName;
    });
    return found ? { boardName, labelRaw: found.text, url: found.url } : null;
  }).filter(Boolean);
  const selectors = [
    'title', ...Object.keys(FSALE_BOARD_URLS).map(boardName => `a[href*="bo_table=${boardName}"]`)
  ].filter(selector => selector === 'title' ? Boolean(pageTitle(doc)) : entries.some(entry => selector.includes(`=${entry.boardName}`)));
  const expectedLayout = structuralFingerprint(LAYOUTS.home.selectors, LAYOUTS.home.labels);
  const actualLabels = ['coupon', 'directmarket', 'zero1', 'onnuri1'].map(boardName => entries.find(entry => entry.boardName === boardName)?.labelRaw ?? '');
  const layoutFingerprint = assertLayout(structuralFingerprint(selectors, actualLabels), expectedLayout, {
    rowCount: entries.length, minRows: 4, maxRows: 4
  });
  return {
    checkedAt,
    sourceUrl,
    pageType: 'fsale-home',
    pageTitleRaw: pageTitle(doc),
    boardLinks: entries,
    records: entries,
    receivedCount: entries.length,
    parsedCount: entries.length,
    layoutFingerprint
  };
}

async function getParsedPage(client, url, { sourceId, pageType, parser }) {
  const response = await client.get(url, { sourceId, pageType });
  if (response.error) return { response, error: responseError(response), parsed: null };
  try { return { response, error: null, parsed: parser(response.html, { sourceUrl: response.url, checkedAt: response.checkedAt }) }; }
  catch (error) { return { response, error: { code: error.code ?? 'HTML_PARSE_FAILED' }, parsed: null }; }
}

async function collectCouponPageSet(client, seedUrl, pageType, firstResult = null) {
  const sourceId = 'fsale-coupon-board';
  const queue = firstResult ? [] : [seedUrl];
  const queued = new Set([seedUrl]);
  const pages = firstResult?.parsed ? [firstResult.parsed] : [];
  const errors = [];
  const captureFiles = [firstResult?.response?.captureFiles].filter(Boolean);
  if (firstResult?.parsed) {
    for (const nextUrl of firstResult.parsed.paginationUrls) {
      if (!queued.has(nextUrl)) { queued.add(nextUrl); queue.push(nextUrl); }
    }
  }
  while (queue.length && pages.length < 40) {
    const url = queue.shift();
    const result = await getParsedPage(client, url, { sourceId, pageType, parser: parseFsaleCoupon });
    if (result.response.captureFiles) captureFiles.push(result.response.captureFiles);
    if (!result.parsed) { errors.push({ url, ...result.error }); break; }
    pages.push(result.parsed);
    for (const nextUrl of result.parsed.paginationUrls) {
      if (!queued.has(nextUrl)) { queued.add(nextUrl); queue.push(nextUrl); }
    }
    queue.sort((left, right) => queryPageNumber(left) - queryPageNumber(right));
  }
  const allRecords = pages.flatMap(page => page.records);
  const distinctRecords = new Map(allRecords.map(record => [record.id, record]));
  const totalCount = pages.find(page => page.totalCount != null)?.totalCount ?? null;
  const complete = !errors.length && !queue.length && totalCount != null && distinctRecords.size === totalCount;
  return {
    status: errors.length ? 'partial' : complete ? 'read' : 'layout_review',
    pageCount: pages.length,
    totalCount,
    receivedCount: allRecords.length,
    parsedCount: distinctRecords.size,
    duplicateCount: allRecords.length - distinctRecords.size,
    paginationComplete: complete,
    pages,
    errors,
    captureFiles
  };
}

async function collectCouponViews(client) {
  const sourceId = 'fsale-coupon-board';
  const initial = await getParsedPage(client, FSALE_BOARD_URLS.coupon, {
    sourceId, pageType: 'coupon-list', parser: parseFsaleCoupon
  });
  if (!initial.parsed) return { status: 'unavailable', error: initial.error, pages: [], captureFiles: initial.response.captureFiles };
  const pageSets = [await collectCouponPageSet(client, initial.response.url, 'coupon-list', initial)];
  for (const category of initial.parsed.categoryViews) {
    const url = new URL(category.url);
    if (url.searchParams.has('page')) continue;
    const key = url.searchParams.get('sca') ?? 'all';
    pageSets.push(await collectCouponPageSet(client, url.href, `coupon-${key === '온라인쇼핑몰' ? 'online' : 'offline'}`));
  }
  const allErrors = pageSets.flatMap(set => set.errors ?? []);
  return {
    status: pageSets.every(set => set.status === 'read') ? 'read' : 'partial',
    pageCount: pageSets.reduce((sum, set) => sum + set.pageCount, 0),
    pages: pageSets.flatMap(set => set.pages),
    errors: allErrors,
    captureFiles: pageSets.flatMap(set => set.captureFiles ?? []),
    detailFetches: 0,
    detailLinkHandling: 'Only coupon click-through URLs were present; they were recorded but not requested.'
  };
}

async function collectPagedBoard(client, boardName) {
  const sourceId = boardName === 'directmarket' ? 'fsale-directmarket-board' : 'fsale-zero-onnuri-boards';
  const startUrl = FSALE_BOARD_URLS[boardName];
  const queue = [startUrl];
  const queued = new Set(queue);
  const pages = [];
  const captureFiles = [];
  const errors = [];
  while (queue.length && pages.length < 40) {
    const url = queue.shift();
    const result = await getParsedPage(client, url, {
      sourceId,
      pageType: `${boardName}-page-${queryPageNumber(url)}`,
      parser: (html, options) => parseFsaleBoard(html, { ...options, boardName })
    });
    if (result.response.captureFiles) captureFiles.push(result.response.captureFiles);
    if (!result.parsed) { errors.push({ url, ...result.error }); break; }
    pages.push(result.parsed);
    for (const nextUrl of result.parsed.paginationUrls) {
      if (!queued.has(nextUrl)) { queued.add(nextUrl); queue.push(nextUrl); }
    }
    queue.sort((left, right) => queryPageNumber(left) - queryPageNumber(right));
  }
  const records = pages.flatMap(page => page.records);
  const distinct = new Map(records.map(record => [record.id, record]));
  const expectedTotal = pages.find(page => page.totalCount != null)?.totalCount ?? null;
  const duplicateCount = records.length - distinct.size;
  const complete = !errors.length && !queue.length && expectedTotal != null && distinct.size === expectedTotal;
  return {
    status: errors.length ? 'partial' : complete ? 'read' : 'layout_review',
    boardName,
    totalCount: expectedTotal,
    pageCount: pages.length,
    receivedCount: records.length,
    parsedCount: distinct.size,
    duplicateCount,
    paginationComplete: complete,
    lastPageReached: queue.length === 0,
    pages,
    records: [...distinct.values()].sort((a, b) => (b.rowNumber ?? 0) - (a.rowNumber ?? 0)),
    errors,
    captureFiles,
    detailFetches: 0,
    detailLinkHandling: boardName === 'directmarket'
      ? 'No event-post detail links were present; rows link only to Naver Map searches, which were recorded but not requested.'
      : 'Same-board detail links, if present, are recorded but not requested.'
  };
}

/** Anonymous GET collection for Fsale's public landing page and the four requested Gnuboard boards. */
export async function collectFsaleHtml({ client = createPublicClient({ captureDir: DEFAULT_CAPTURE_DIR, requestLimit: 40, allowedHosts: ['fsale.kr'] }) } = {}) {
  const landing = await getParsedPage(client, FSALE_HOME_URL, { sourceId: 'fsale-site', pageType: 'home', parser: parseFsaleLanding });
  const coupon = await collectCouponViews(client);
  const directmarket = await collectPagedBoard(client, 'directmarket');
  const zero1 = await collectPagedBoard(client, 'zero1');
  const onnuri1 = await collectPagedBoard(client, 'onnuri1');
  const sources = {
    'fsale-site': landing.parsed ? { status: 'read', ...landing.parsed, captureFiles: landing.response.captureFiles } : { status: 'unavailable', error: landing.error, captureFiles: landing.response.captureFiles },
    'fsale-coupon-board': coupon,
    'fsale-directmarket-board': directmarket,
    'fsale-zero-onnuri-boards': { status: zero1.status === 'read' && onnuri1.status === 'read' ? 'read' : 'partial', boards: { zero1, onnuri1 }, captureFiles: [...zero1.captureFiles, ...onnuri1.captureFiles] }
  };
  return {
    checkedAt: new Date().toISOString(),
    status: Object.values(sources).every(source => source.status === 'read') ? 'read' : 'partial',
    requestCounts: Object.fromEntries(client.counts ?? []),
    sources
  };
}
