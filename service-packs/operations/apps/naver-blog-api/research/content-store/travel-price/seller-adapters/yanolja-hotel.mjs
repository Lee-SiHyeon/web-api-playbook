import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';

const ORIGIN = 'https://nol.yanolja.com';
const HOME_PATH = '/sub-home/hotel';
const SEARCH_PATH = '/discovery/list/search/PRODUCT_CATEGORY_KOREA_ACCOMMODATION';
const MIN_HOST_INTERVAL_MS = 2050;
let lastRequestAt = 0;

function plainText(element) {
  return element?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
}

function parseKrw(label) {
  const text = String(label ?? '');
  const match = text.match(/([0-9][0-9,]*)\s*원/)
    ?? text.match(/(?:정상가|판매가)\s*([0-9][0-9,]*)\s*$/);
  return match ? Number(match[1].replaceAll(',', '')) : null;
}

function validatePageUrl(input, kind) {
  const url = new URL(input);
  if (url.origin !== ORIGIN) throw new Error('Yanolja URL must use the observed nol.yanolja.com origin');
  const expectedPath = kind === 'home' ? HOME_PATH : SEARCH_PATH;
  if (url.pathname !== expectedPath) throw new Error('Yanolja URL is outside the observed hotel Document contract');
  if (kind === 'search' && !url.searchParams.has('q')) throw new Error('Yanolja search URL must contain the observed q parameter');
  return url;
}

async function getDocument(url, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const delay = MIN_HOST_INTERVAL_MS - (Date.now() - lastRequestAt);
  if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
  lastRequestAt = Date.now();
  const checkedAt = new Date().toISOString();
  const response = await fetchImpl(url, {
    method: 'GET',
    redirect: 'manual',
    headers: {
      'accept-language': 'ko-KR,ko;q=0.9',
      accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  const metadata = {
    origin: new URL(url).origin,
    path: new URL(url).pathname,
    method: 'GET',
    checkedAt,
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  if (response.status !== 200 || !/text\/html/i.test(metadata.contentType)) {
    throw Object.assign(new Error('Yanolja hotel Document did not return HTML HTTP 200'), { code: 'YANOLJA_HOTEL_DOCUMENT_UNAVAILABLE', metadata });
  }
  return { metadata, html: bytes.toString('utf8') };
}

function parseContextFromHref(href, baseUrl) {
  const url = new URL(href, baseUrl);
  return {
    checkInDate: url.searchParams.get('checkInDate'),
    checkOutDate: url.searchParams.get('checkOutDate'),
    adultCount: url.searchParams.has('adultCount') ? Number(url.searchParams.get('adultCount')) : null,
    childCount: url.searchParams.has('childCount') ? Number(url.searchParams.get('childCount')) : null,
    keyword: url.searchParams.get('srpKeyword'),
  };
}

function parseCard(anchor, { baseUrl, checkedAt, priceScope }) {
  const target = new URL(anchor.getAttribute('href'), baseUrl);
  if (target.origin !== ORIGIN || !/^\/stay\/domestic\/\d+\/?$/.test(target.pathname)) return null;
  const hotelId = target.pathname.split('/').filter(Boolean).at(-1);
  const label = prefix => [...anchor.querySelectorAll('[aria-label]')]
    .map(node => node.getAttribute('aria-label'))
    .find(value => value?.startsWith(prefix)) ?? null;
  const productName = label('상품명 ');
  const reviewLabel = label('리뷰 정보 ');
  const review = reviewLabel?.match(/평점\s*([0-9.]+),\s*후기\s*([0-9,]+)개/);
  const locationLabel = [...anchor.querySelectorAll('[aria-label]')]
    .map(node => node.getAttribute('aria-label'))
    .find(value => value?.startsWith('위치 ') && value !== '위치 정보') ?? null;
  const checkinText = plainText(anchor.querySelector('[aria-label="상품 위치 및 이용 기간 정보"]')) ?? '';
  const checkInTime = checkinText.match(/(?:숙박|체크인)\s*(\d{1,2}:\d{2})/i)?.[1] ?? null;
  const category = plainText(anchor.querySelector('[aria-label="상품 분류 정보"]'));
  const benefitContainer = anchor.querySelector('[aria-label="상품 혜택"]');
  const benefitsText = plainText(benefitContainer);
  const benefits = benefitsText ? benefitsText.split(/\s+/).filter(Boolean) : [];
  const advertised = [...anchor.querySelectorAll('[role="group"][aria-label^="상품 가격 정보"]')].map(group => {
    const originalLabel = [...group.querySelectorAll('[aria-label]')]
      .map(node => node.getAttribute('aria-label')).find(value => value?.startsWith('정상가 ')) ?? null;
    const saleLabel = [...group.querySelectorAll('[aria-label]')]
      .map(node => node.getAttribute('aria-label')).find(value => value?.startsWith('판매가 ')) ?? null;
    const discountLabel = [...group.querySelectorAll('span')]
      .map(plainText).find(value => /^\d{1,3}%$/.test(value ?? '')) ?? null;
    const visibleText = plainText(group) ?? '';
    const badge = [...group.querySelectorAll('span,div')].map(plainText)
      .find(value => value && /^(회원가|쿠폰가|앱전용가)$/.test(value)) ?? null;
    const checkInWindow = visibleText.match(/(?:숙박|체크인)\s*(\d{1,2}:\d{2})/i)?.[1] ?? checkInTime;
    return {
      originalPriceLabel: originalLabel,
      originalPriceKrw: parseKrw(originalLabel),
      salePriceLabel: saleLabel,
      salePriceKrw: parseKrw(saleLabel),
      discountRateLabel: discountLabel,
      discountRatePercent: discountLabel ? Number(discountLabel.slice(0, -1)) : null,
      priceBadge: badge,
      checkInTime: checkInWindow,
      priceScope,
      taxesIncluded: null,
      feesIncluded: null,
      amountBasis: 'listing label; total-vs-nightly semantics not stated in card',
    };
  });
  if (!advertised.length) {
    const amountSpan = [...anchor.querySelectorAll('span')]
      .find(node => /^\d[\d,]*$/.test(plainText(node) ?? '')
        && /원~/.test(plainText(node.parentElement)));
    const discountLabel = [...anchor.querySelectorAll('span')]
      .map(plainText).find(value => /^\d{1,3}%$/.test(value ?? '')) ?? null;
    const noDatePrice = amountSpan ? `${plainText(amountSpan)}원~` : null;
    if (noDatePrice || discountLabel) {
      advertised.push({
        originalPriceLabel: null,
        originalPriceKrw: null,
        salePriceLabel: noDatePrice,
        salePriceKrw: parseKrw(noDatePrice),
        discountRateLabel: discountLabel,
        discountRatePercent: discountLabel ? Number(discountLabel.slice(0, -1)) : null,
        priceBadge: null,
        checkInTime,
        priceScope,
        taxesIncluded: null,
        feesIncluded: null,
        amountBasis: 'homepage starting-price label; original price and stay dates are absent from this card',
      });
    }
  }
  const rawText = plainText(anchor) ?? '';
  const cardType = anchor.getAttribute('data-card-type') ?? null;
  const image = anchor.querySelector('img')?.getAttribute('src') ?? null;
  const fallbackTitle = plainText(anchor.querySelector('div[class*="mb-4"][class*="line-clamp-1"]'))
    ?? plainText(anchor.querySelector('div[class*="pc:px-4"] > div'));
  return {
    sellerId: 'yanolja-hotel',
    hotelId,
    title: productName?.replace(/^상품명\s*/, '') ?? fallbackTitle ?? anchor.getAttribute('aria-label')?.replace(/ 상품 상세 보기$/, '') ?? null,
    detailUrl: target.href,
    category,
    location: locationLabel?.replace(/^위치\s*/, '') ?? null,
    reviewScore: review ? Number(review[1]) : null,
    reviewCount: review ? Number(review[2].replaceAll(',', '')) : null,
    sponsored: /광고/.test(rawText),
    benefits,
    benefitsRaw: benefitsText,
    imageUrl: image,
    observedAt: checkedAt,
    searchContext: parseContextFromHref(target.href, baseUrl),
    prices: advertised,
    priceUnavailableLabel: advertised.length ? null : (rawText.includes('다른 날짜 확인') ? '다른 날짜 확인' : null),
    rawCardText: rawText,
    cardType,
  };
}

function paginationFromFlight(html) {
  const match = html.match(/\\+"paging\\+":\{\\+"isLast\\+":(true|false),\\+"current\\+":(\d+),\\+"total\\+":(\d+)\}/);
  return match ? { isLast: match[1] === 'true', currentPage: Number(match[2]), totalPages: Number(match[3]) } : null;
}

function countFromDocument(document) {
  const headings = [...document.querySelectorAll('h1,h2,h3,h4')];
  for (const heading of headings) {
    const match = plainText(heading)?.match(/^([0-9][0-9,]*)개\s*검색결과$/);
    if (match) return Number(match[1].replaceAll(',', ''));
  }
  return null;
}

export function parseYanoljaHotelHome(html, { checkedAt = new Date().toISOString() } = {}) {
  const baseUrl = `${ORIGIN}${HOME_PATH}`;
  const document = new JSDOM(String(html)).window.document;
  if (!document.title.includes('호텔/리조트')) throw new Error('Yanolja hotel home title does not match the observed page');
  const anchors = [...document.querySelectorAll('a[href*="/stay/domestic/"]')];
  const cards = anchors
    .map(anchor => parseCard(anchor, { baseUrl, checkedAt, priceScope: 'advertised starting price; stay dates are absent from the homepage card' }))
    .filter(Boolean);
  const deduped = [...new Map(cards.map(card => [card.hotelId, card])).values()];
  if (!deduped.length) throw Object.assign(new Error('Yanolja hotel home cards are missing'), { code: 'HTML_LAYOUT_CHANGED' });
  return {
    sourceId: 'yanolja-hotel',
    operation: 'hotel-home-ssr',
    pageTitle: document.title,
    checkedAt,
    resultCount: deduped.length,
    anchorCount: cards.length,
    duplicateAnchorCount: cards.length - deduped.length,
    pricedCount: deduped.filter(card => card.prices.some(price => price.salePriceKrw != null)).length,
    discountedCount: deduped.filter(card => card.prices.some(price => price.discountRatePercent != null)).length,
    execution: { mode: 'pure_http', representation: 'server-rendered HTML Document', auth: 'anonymous', browserUsed: false },
    coverage: { rows: 'all distinct domestic-stay anchors present in this Document response', pagination: 'not applicable to observed homepage cards', priceSemantics: 'starting price; no dates/occupancy on homepage cards' },
    cards: deduped,
  };
}

export function parseYanoljaHotelSearchResults(html, { url, checkedAt = new Date().toISOString() } = {}) {
  const pageUrl = validatePageUrl(url, 'search');
  const document = new JSDOM(String(html)).window.document;
  const canonical = document.querySelector('link[rel="canonical"]')?.href;
  if (!document.title.includes('국내숙소 추천 상품') || !canonical) throw new Error('Yanolja hotel search page does not match the observed result Document');
  const canonicalUrl = new URL(canonical);
  if (canonicalUrl.origin !== ORIGIN || canonicalUrl.pathname !== SEARCH_PATH) throw new Error('Yanolja hotel search canonical URL is outside the observed route');
  const searchKeyword = canonicalUrl.searchParams.get('q') ?? pageUrl.searchParams.get('q');
  const totalResultCount = countFromDocument(document);
  const cards = [...document.querySelectorAll('a[href*="/stay/domestic/"]')]
    .map(anchor => parseCard(anchor, { baseUrl: pageUrl.href, checkedAt, priceScope: 'search listing price for the date and occupancy encoded in the product link' }))
    .filter(Boolean);
  const deduped = [...new Map(cards.map(card => [card.hotelId, card])).values()];
  if (!deduped.length || totalResultCount == null) throw Object.assign(new Error('Yanolja hotel search card or result-count fields are missing'), { code: 'HTML_LAYOUT_CHANGED' });
  const contexts = deduped.map(card => card.searchContext);
  const contextValue = key => {
    const values = [...new Set(contexts.map(context => context[key]).filter(value => value != null))];
    return values.length === 1 ? values[0] : null;
  };
  const filter = pageUrl.searchParams.get('filter');
  const filterEvidence = filter == null ? { present: false } : {
    present: true,
    length: filter.length,
    sha256: createHash('sha256').update(filter).digest('hex'),
  };
  return {
    sourceId: 'yanolja-hotel',
    operation: 'hotel-keyword-search-ssr',
    checkedAt,
    search: {
      category: 'PRODUCT_CATEGORY_KOREA_ACCOMMODATION',
      keyword: searchKeyword,
      checkInDate: contextValue('checkInDate'),
      checkOutDate: contextValue('checkOutDate'),
      adultCount: contextValue('adultCount'),
      childCount: contextValue('childCount'),
      filterParameter: filterEvidence,
    },
    totalResultCount,
    page: paginationFromFlight(html),
    returnedCardCount: deduped.length,
    pricedCardCount: deduped.filter(card => card.prices.some(price => price.salePriceKrw != null)).length,
    discountedCardCount: deduped.filter(card => card.prices.some(price => price.discountRatePercent != null)).length,
    execution: { mode: 'pure_http', representation: 'server-rendered HTML Document', auth: 'anonymous', browserUsed: false },
    coverage: {
      rows: deduped.length,
      totalResultCount,
      page: paginationFromFlight(html),
      paginationReplayed: false,
      priceSemantics: 'listing sale labels only; total-vs-nightly and tax/fee inclusion are unknown',
    },
    cards: deduped,
    request: { origin: ORIGIN, path: pageUrl.pathname, method: 'GET', queryNames: [...pageUrl.searchParams.keys()].filter(key => key !== 'filter').concat(filter == null ? [] : ['filter (opaque; value omitted)']) },
  };
}

export async function fetchYanoljaHotelHome(options = {}) {
  const url = new URL(HOME_PATH, ORIGIN);
  const response = await getDocument(url, options);
  return { metadata: response.metadata, result: parseYanoljaHotelHome(response.html, { checkedAt: response.metadata.checkedAt }) };
}

export async function fetchYanoljaHotelSearch({ keyword, fetchImpl = fetch, timeoutMs } = {}) {
  if (typeof keyword !== 'string' || !keyword.trim()) throw new Error('keyword is required');
  const url = new URL(SEARCH_PATH, ORIGIN);
  url.searchParams.set('q', keyword.trim());
  const response = await getDocument(url, { fetchImpl, timeoutMs });
  return { metadata: response.metadata, result: parseYanoljaHotelSearchResults(response.html, { url: url.href, checkedAt: response.metadata.checkedAt }) };
}
