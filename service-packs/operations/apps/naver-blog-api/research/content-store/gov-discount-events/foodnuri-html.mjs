import {
  DEFAULT_CAPTURE_DIR,
  assertLayout,
  attr,
  createPublicClient,
  findAll,
  hasClass,
  parseHtml,
  structuralFingerprint,
  textContent
} from './html-public.mjs';

export const FOODNURI_SALE_LIST_URL = 'https://sale.foodnuri.go.kr/ft/ftSale/list.do';
export const FOODNURI_PARTICIPATING_COMPANIES_URL = 'https://sale.foodnuri.go.kr/ft/ftCmpn/list.do';

const compact = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const nodesWithClass = (root, tagName, className) => findAll(root, node =>
  (!tagName || node.tagName === tagName) && hasClass(node, className));

const LAYOUT_SELECTORS = [
  '.salebox.thisweek', '.salebox.nextweek', '.salebox .top', '.salebox .list', '.sale_history'
];
const RETAILER_CATEGORIES = ['대형마트', '지역농협', '중소형마트', '친환경매장', '로컬푸드직매장', '온라인몰', '전통시장몰'];

function dateFromPeriod(periodRaw, index) {
  const matches = [...String(periodRaw ?? '').matchAll(/(20\d{2})\.(\d{1,2})\.(\d{1,2})/g)];
  const match = matches[index];
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseCount(raw) {
  const match = String(raw ?? '').match(/(\d+)\s*종/);
  return match ? Number(match[1]) : null;
}

function recordStatus(startDate, endDate, checkedAt) {
  if (!startDate || !endDate) return 'unknown';
  const today = String(checkedAt).slice(0, 10);
  if (endDate < today) return 'ended';
  if (startDate > today) return 'upcoming';
  return 'active';
}

function parseWeekBox(box, pageType, sourceUrl, checkedAt) {
  const top = nodesWithClass(box, 'div', 'top')[0] ?? null;
  const list = nodesWithClass(box, 'div', 'list')[0] ?? null;
  const note = (box.childNodes ?? []).find(node => node.tagName === 'p') ?? null;
  if (!top || !list) throw Object.assign(new Error('HTML_LAYOUT_CHANGED'), { code: 'HTML_LAYOUT_CHANGED' });
  const headingRaw = compact(textContent(top));
  const periodMatch = headingRaw.match(/\d{4}\.\d{1,2}\.\d{1,2}\.\([^)]*\)\s*-\s*\d{4}\.\d{1,2}\.\d{1,2}\.\([^)]*\)/);
  const periodRaw = periodMatch?.[0] ?? null;
  const countMatch = headingRaw.match(/\d+\s*종/);
  const itemCountLabelRaw = countMatch?.[0] ?? null;
  const labelRaw = compact(headingRaw.replace(periodRaw ?? '', ' ').replace(itemCountLabelRaw ?? '', ' '));
  const items = findAll(list, node => node.tagName === 'li').map(node => compact(textContent(node))).filter(Boolean);
  const expectedItemCount = parseCount(itemCountLabelRaw);
  if (!periodRaw || expectedItemCount === null || items.length !== expectedItemCount) {
    throw Object.assign(new Error('HTML_LAYOUT_CHANGED'), { code: 'HTML_LAYOUT_CHANGED' });
  }
  return {
    id: `foodnuri-${pageType}-${dateFromPeriod(periodRaw, 0) ?? 'unknown'}`,
    pageType,
    periodStart: dateFromPeriod(periodRaw, 0),
    periodEnd: dateFromPeriod(periodRaw, 1),
    status: recordStatus(dateFromPeriod(periodRaw, 0), dateFromPeriod(periodRaw, 1), checkedAt),
    periodRaw,
    periodLabelRaw: labelRaw,
    itemCount: expectedItemCount,
    itemCountLabelRaw,
    items,
    itemLabelsRaw: items,
    noteRaw: note ? compact(textContent(note)) : null,
    ratePercent: null,
    rateLabelRaw: null,
    capAmountKrw: null,
    capLabelRaw: null,
    retailerSpecific: true,
    retailerVarianceLabelRaw: note ? compact(textContent(note)) : null,
    sourceUrl,
    fieldLabels: {
      period: labelRaw,
      eligibleItems: '할인품목',
      itemCount: '종'
    }
  };
}

function parseHistorySummary(doc, sourceUrl, checkedAt) {
  const history = nodesWithClass(doc, 'div', 'sale_history')[0] ?? null;
  if (!history) return null;
  const summary = nodesWithClass(history, 'div', 'box')[0] ?? null;
  const raw = summary ? compact(textContent(summary)) : null;
  if (!raw) return null;
  const periodMatch = raw.match(/\d{4}\.\d{1,2}\.\d{1,2}\.\([^)]*\)\s*-\s*\d{4}\.\d{1,2}\.\d{1,2}\.\([^)]*\)/);
  const periodRaw = periodMatch?.[0] ?? null;
  const periodStart = dateFromPeriod(periodRaw, 0);
  const periodEnd = dateFromPeriod(periodRaw, 1);
  return {
    id: `foodnuri-history-${dateFromPeriod(periodRaw, 0) ?? 'unknown'}`,
    periodStart,
    periodEnd,
    status: recordStatus(periodStart, periodEnd, checkedAt),
    periodRaw,
    summaryRaw: raw,
    ratePercent: null,
    rateLabelRaw: null,
    capAmountKrw: null,
    capLabelRaw: null,
    sourceUrl
  };
}

/** Parses the official discount-item page's current and next week item lists. */
export function parseFoodnuriSaleList(html, { sourceUrl = FOODNURI_SALE_LIST_URL, checkedAt = new Date().toISOString() } = {}) {
  const doc = parseHtml(html);
  const currentBox = nodesWithClass(doc, 'div', 'thisweek').find(node => hasClass(node, 'salebox')) ?? null;
  const nextBox = nodesWithClass(doc, 'div', 'nextweek').find(node => hasClass(node, 'salebox')) ?? null;
  const historyBox = nodesWithClass(doc, 'div', 'sale_history').find(node => hasClass(node, 'salebox')) ?? null;
  const weekBoxes = [currentBox, nextBox].filter(Boolean);
  const records = [
    ...(currentBox ? [parseWeekBox(currentBox, 'thisweek', sourceUrl, checkedAt)] : []),
    ...(nextBox ? [parseWeekBox(nextBox, 'nextweek', sourceUrl, checkedAt)] : [])
  ];
  const labelRaw = records.map(record => record.periodLabelRaw);
  const selectors = [
    currentBox ? '.salebox.thisweek' : null,
    nextBox ? '.salebox.nextweek' : null,
    weekBoxes.every(box => nodesWithClass(box, 'div', 'top').length) ? '.salebox .top' : null,
    weekBoxes.every(box => nodesWithClass(box, 'div', 'list').length) ? '.salebox .list' : null,
    historyBox ? '.sale_history' : null
  ].filter(Boolean);
  const expected = structuralFingerprint(LAYOUT_SELECTORS, ['이번주에 할인 하는 품목', '다음주에 할인 하는 품목']);
  const actual = structuralFingerprint(selectors, labelRaw);
  const layoutFingerprint = assertLayout(actual, expected, { rowCount: records.length, minRows: 2, maxRows: 2 });
  if (records.length !== 2 || records[0].pageType !== 'thisweek' || records[1].pageType !== 'nextweek') {
    throw Object.assign(new Error('HTML_LAYOUT_CHANGED'), { code: 'HTML_LAYOUT_CHANGED' });
  }
  return {
    checkedAt,
    sourceUrl,
    pageType: 'foodnuri-sale-list',
    pageTitleRaw: compact(textContent(findAll(doc, node => node.tagName === 'title')[0])),
    records,
    historicalSummary: parseHistorySummary(doc, sourceUrl, checkedAt),
    receivedCount: records.length,
    parsedCount: records.length,
    ratePercent: null,
    capAmountKrw: null,
    layoutFingerprint
  };
}

/** Parses the linked public Foodnuri participating-company directory, without treating brands as branch venues. */
export function parseFoodnuriParticipatingCompanies(html, { sourceUrl = FOODNURI_PARTICIPATING_COMPANIES_URL, checkedAt = new Date().toISOString() } = {}) {
  const doc = parseHtml(html);
  const root = nodesWithClass(doc, 'div', 'company_list_sub')[0] ?? null;
  if (!root) throw Object.assign(new Error('HTML_LAYOUT_CHANGED'), { code: 'HTML_LAYOUT_CHANGED' });
  const sections = (root.childNodes ?? []).filter(node => node.tagName === 'dl');
  const groups = sections.map(section => {
    const heading = (section.childNodes ?? []).find(node => node.tagName === 'dt') ?? null;
    const categoryLabelRaw = heading ? compact(textContent(heading)) : '';
    const list = (section.childNodes ?? []).find(node => node.tagName === 'dd') ?? section;
    const items = findAll(list, node => node.tagName === 'li').map((item, index) => {
      const logo = findAll(item, node => node.tagName === 'img')[0] ?? null;
      const anchor = findAll(item, node => node.tagName === 'a')[0] ?? null;
      const logoAltRaw = logo ? attr(logo, 'alt') : null;
      const labelRaw = compact(logoAltRaw || textContent(item)) || null;
      const hrefRaw = anchor ? attr(anchor, 'href') : null;
      return {
        id: `foodnuri-retailer-${groupsafe(categoryLabelRaw)}-${index + 1}`,
        categoryLabelRaw,
        retailerLabelRaw: labelRaw,
        retailerLogoAltRaw: logoAltRaw || null,
        retailerLogoUrl: logo && attr(logo, 'src') ? new URL(attr(logo, 'src'), sourceUrl).href : null,
        retailerOutboundUrl: hrefRaw ? new URL(hrefRaw, sourceUrl).href : null,
        branchNameRaw: null,
        sourceUrl
      };
    });
    return { categoryLabelRaw, itemCount: items.length, items };
  });
  const records = groups.flatMap(group => group.items);
  const categoryLabels = groups.map(group => group.categoryLabelRaw);
  const selectorLabels = ['.company_list_sub', 'dl', 'dt', 'dd', 'li', 'img[alt]'];
  const expected = structuralFingerprint(selectorLabels, RETAILER_CATEGORIES);
  const actual = structuralFingerprint(selectorLabels, categoryLabels);
  const layoutFingerprint = assertLayout(actual, expected, { rowCount: records.length, minRows: 1, maxRows: 200 });
  return {
    checkedAt,
    sourceUrl,
    pageType: 'participating-companies-directory',
    directoryLabelRaw: '참여업체',
    records,
    groups: groups.map(({ categoryLabelRaw, itemCount }) => ({ categoryLabelRaw, itemCount })),
    receivedCount: records.length,
    parsedCount: records.length,
    branchVenueCoverage: 'unverified',
    campaignRoundCoverage: 'not_established_by_directory',
    detailFetches: 0,
    detailLinkHandling: 'Retailer outbound links and logos are recorded only; no external retailer site was requested.',
    layoutFingerprint
  };
}

function groupsafe(value) {
  return value.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').toLowerCase() || 'unknown';
}

export async function collectFoodnuriSaleList({ client = createPublicClient({
  captureDir: DEFAULT_CAPTURE_DIR,
  requestLimit: 40,
  allowedHosts: ['sale.foodnuri.go.kr']
}) } = {}) {
  const response = await client.get(FOODNURI_SALE_LIST_URL, { sourceId: 'foodnuri', pageType: 'sale-list' });
  if (response.error) {
    return {
      status: 'unavailable',
      sourceId: 'foodnuri',
      sourceUrl: FOODNURI_SALE_LIST_URL,
      httpStatus: response.httpStatus,
      error: response.error,
      challenge: response.challenge,
      captureFiles: response.captureFiles
    };
  }
  try {
    const saleList = parseFoodnuriSaleList(response.html, { sourceUrl: response.url, checkedAt: response.checkedAt });
    const retailerResponse = await client.get(FOODNURI_PARTICIPATING_COMPANIES_URL, {
      sourceId: 'foodnuri-participating-retailers', pageType: 'participating-companies'
    });
    let retailerDirectory;
    if (retailerResponse.error) {
      retailerDirectory = {
        status: 'unavailable',
        sourceUrl: FOODNURI_PARTICIPATING_COMPANIES_URL,
        httpStatus: retailerResponse.httpStatus,
        error: retailerResponse.error,
        captureFiles: retailerResponse.captureFiles
      };
    } else {
      try {
        retailerDirectory = {
          status: 'read',
          ...parseFoodnuriParticipatingCompanies(retailerResponse.html, {
            sourceUrl: retailerResponse.url,
            checkedAt: retailerResponse.checkedAt
          }),
          httpStatus: retailerResponse.httpStatus,
          contentType: retailerResponse.contentType,
          charset: retailerResponse.charset,
          captureFiles: retailerResponse.captureFiles
        };
      } catch (error) {
        retailerDirectory = {
          status: 'parse_error',
          sourceUrl: FOODNURI_PARTICIPATING_COMPANIES_URL,
          httpStatus: retailerResponse.httpStatus,
          error: error.code ?? 'HTML_PARSE_FAILED',
          captureFiles: retailerResponse.captureFiles
        };
      }
    }
    return {
      status: 'read',
      sourceId: 'foodnuri',
      ...saleList,
      httpStatus: response.httpStatus,
      contentType: response.contentType,
      charset: response.charset,
      captureFiles: [response.captureFiles, retailerResponse.captureFiles].filter(Boolean),
      retailerDirectory,
      detailFetches: 0,
      detailLinkHandling: 'A same-host participation-directory link was followed by GET. Retailer outbound links and logos are recorded only; no external retailer site was requested.'
    };
  } catch (error) {
    return {
      status: 'parse_error',
      sourceId: 'foodnuri',
      sourceUrl: FOODNURI_SALE_LIST_URL,
      httpStatus: response.httpStatus,
      error: error.code ?? 'HTML_PARSE_FAILED',
      captureFiles: response.captureFiles
    };
  }
}
