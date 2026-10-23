import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';

const ORIGIN = 'https://kr.trip.com';
const HOTEL_LIST_URL = `${ORIGIN}/hotels/da-nang-hotels-list-1356/`;
const ACTIVITIES_URL = `${ORIGIN}/things-to-do/`;
const MIN_HOST_INTERVAL_MS = 2500;
let lastRequestAt = 0;

function plainText(element) {
  return element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function fail(code, message, metadata) {
  return Object.assign(new Error(message), { code, ...(metadata ? { metadata } : {}) });
}

function assertObservedPageUrl(input, expectedUrl, label) {
  const url = new URL(input);
  const expected = new URL(expectedUrl);
  if (url.origin !== ORIGIN || url.pathname !== expected.pathname || url.search || url.hash) {
    throw fail('TRIP_UNOBSERVED_ROUTE', `${label} must use the exact observed public Trip.com route`);
  }
  return url;
}

function pageHasVisibleChallenge(html) {
  const visible = String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ');
  return /<title[^>]*>[^<]*(?:just a moment|access denied|verify you are human|보안 확인|접근이 차단)[^<]*<\/title>/i.test(visible)
    || /(?:verify you are human|checking your browser|잠시 후 다시 시도|비정상적인 요청|접근이 차단되었습니다)/i.test(visible);
}

function parseKrw(label) {
  const match = String(label ?? '').match(/([0-9][0-9,]*)\s*원/);
  return match ? Number(match[1].replaceAll(',', '')) : null;
}

function hotelIdFromHref(href, baseUrl) {
  const target = new URL(href, baseUrl);
  const match = target.pathname.match(/^\/hotels\/da-nang-hotel-detail-(\d+)\/[^/]+\/?$/);
  return target.origin === ORIGIN && match ? { id: match[1], href: target.href } : null;
}

export function parseTripCityHotelList(html, {
  sourceUrl = HOTEL_LIST_URL,
  observedAt = new Date().toISOString(),
} = {}) {
  const pageUrl = assertObservedPageUrl(sourceUrl, HOTEL_LIST_URL, 'Trip.com Da Nang hotel list');
  const dom = new JSDOM(String(html), { url: pageUrl.href });
  try {
    const document = dom.window.document;
    if (pageHasVisibleChallenge(html)) throw fail('TRIP_PUBLIC_PAGE_CHALLENGE', 'Trip.com hotel list returned a visible challenge page');
    const component = document.querySelector('[data-type="template-comp"][data-name="City"][data-jsondata]');
    if (!document.title.includes('호텔') || !document.title.includes('다낭') || !component) {
      throw fail('HTML_LAYOUT_CHANGED', 'Trip.com Da Nang hotel SSR component was not found');
    }

    let payload;
    try {
      payload = JSON.parse(component.getAttribute('data-jsondata'));
    } catch {
      throw fail('HTML_LAYOUT_CHANGED', 'Trip.com hotel SSR data-jsondata is not valid JSON');
    }
    if (!Array.isArray(payload?.hotels) || payload.hotels.length === 0) {
      throw fail('HTML_LAYOUT_CHANGED', 'Trip.com hotel SSR payload has no hotel rows');
    }

    const anchors = [...component.querySelectorAll('a.Template-Grid-Hotel-Cards-hotel-card[href*="-hotel-detail-"]')];
    if (anchors.length !== payload.hotels.length) {
      throw fail('HTML_LAYOUT_CHANGED', 'Trip.com hotel SSR card count does not match its embedded hotel data');
    }
    const cards = payload.hotels.map((row, index) => {
      const anchor = anchors[index];
      const detail = hotelIdFromHref(anchor.getAttribute('href'), pageUrl.href);
      const title = String(row?.hotelName ?? row?.title ?? '').trim();
      const anchorText = plainText(anchor);
      if (!detail || !title || !anchorText.includes(title)) {
        throw fail('HTML_LAYOUT_CHANGED', 'Trip.com hotel SSR card title or detail link did not match embedded data');
      }
      const priceLabel = typeof row.price === 'string' ? row.price.trim() : null;
      const priceUnitLabel = typeof row.priceUnit === 'string' ? row.priceUnit.trim() : null;
      return {
        hotelId: detail.id,
        title,
        detailUrl: detail.href,
        priceLabel,
        priceKrw: parseKrw(priceLabel),
        priceUnitLabel,
        reviewCountLabel: typeof row.reviewCountText === 'string' ? row.reviewCountText.trim() : null,
        observedAt,
        priceContext: {
          stayDate: null,
          nights: priceUnitLabel && /1\s*박/.test(priceUnitLabel) ? 1 : null,
          adults: null,
          children: null,
          currency: 'KRW',
          taxesIncluded: null,
          feesIncluded: null,
          checkoutPriceVerified: false,
          basis: 'displayed city-card rate; the page does not bind a stay date or occupancy',
        },
      };
    });

    return {
      sourceId: 'trip-hotel',
      operation: 'da-nang-hotel-list-ssr',
      sourceUrl: pageUrl.href,
      pageTitle: document.title,
      observedAt,
      returnedCardCount: cards.length,
      pricedCardCount: cards.filter(card => card.priceKrw !== null).length,
      execution: { mode: 'pure_http', representation: 'server-rendered HTML Document', auth: 'anonymous', browserUsed: false },
      coverage: {
        rows: 'all distinct hotel cards present in this single city-list Document response',
        paginationReplayed: false,
        stayDates: 'not supplied by the observed city-card payload',
        occupancy: 'not supplied by the observed city-card payload',
        taxesAndFees: 'unknown; no checkout total verified',
      },
      cards,
    };
  } finally {
    dom.window.close();
  }
}

function productCard(anchor, { baseUrl, observedAt }) {
  const target = new URL(anchor.getAttribute('href'), baseUrl);
  const match = target.pathname.match(/^\/things-to-do\/detail\/(\d+)\/?$/);
  if (target.origin !== ORIGIN || !match) return null;
  const card = anchor.closest('li[class*="vertical-card_card_layout"]');
  if (!card) return null;

  const priceArea = card.querySelector('[class*="vertical-card_card_price_area"]');
  const priceAreaText = plainText(priceArea) || null;
  const cardText = plainText(card);
  const priceTokens = [...(priceAreaText ?? '').matchAll(/(?:최저\s*|From\s*)?([0-9][0-9,]*)\s*원/gi)]
    .map(match => ({ label: match[0].replace(/\s+/g, ' ').trim(), amount: Number(match[1].replaceAll(',', '')) }));
  const priceLabels = [...new Set(
    [...cardText.matchAll(/(?:최저\s*|From\s*)?([0-9][0-9,]*)\s*원/gi)]
      .map(match => match[0].replace(/\s+/g, ' ').trim()),
  )];
  const promoLabels = [...new Set([...card.querySelectorAll('[class*="card-bg-tags_tag_text"], [class*="discount"], [class*="promotion"]')]
    .filter(element => element.children.length === 0)
    .map(plainText)
    .filter(label => Boolean(label) && !/^[|·•]+$/.test(label)))];
  const discountRateLabels = [...new Set(promoLabels.flatMap(label =>
    [...label.matchAll(/\b(?:100|[1-9]?\d)\s*%\s*(?:할인|off)?/gi)].map(match => match[0].replace(/\s+/g, ' ').trim())))];
  const originalPrice = priceTokens.length > 1 ? priceTokens[0] : null;
  const salePrice = priceTokens.at(-1) ?? null;
  const ratingLabel = plainText(card.querySelector('[class*="card-comments_score__"]')) || null;
  const reviewCountLabel = plainText(card.querySelector('[class*="card-comments_review_sale__"]')) || null;
  const bookingCountLabel = plainText(card.querySelector('[class*="card-comments_sales_text__"]')) || null;
  const cargo = card.ownerDocument.querySelector('[data-cargo]')?.getAttribute('data-cargo') ?? '';
  const currency = /(?:^|,)currency:KRW(?:,|$)/.test(cargo) ? 'KRW' : null;

  return {
    productId: match[1],
    title: plainText(anchor),
    productUrl: target.href,
    observedAt,
    currency,
    priceAreaLabel: priceAreaText,
    displayedPriceLabels: priceLabels,
    originalPriceLabel: originalPrice?.label ?? null,
    originalPriceKrw: originalPrice?.amount ?? null,
    salePriceLabel: salePrice?.label ?? null,
    salePriceKrw: salePrice?.amount ?? null,
    startingPriceKrw: salePrice?.amount ?? null,
    discountRateLabels,
    discountRatePercent: discountRateLabels.length ? Number(discountRateLabels[0].match(/\d+/)?.[0]) : null,
    promoLabels,
    ratingLabel,
    reviewCountLabel,
    bookingCountLabel,
    priceContext: {
      activityDate: null,
      participants: null,
      taxesIncluded: null,
      feesIncluded: null,
      checkoutPriceVerified: false,
      availabilityVerified: false,
      basis: 'displayed product-card price; activity date, participant count, and checkout total are not bound',
    },
  };
}

export function parseTripThingsToDo(html, {
  sourceUrl = ACTIVITIES_URL,
  observedAt = new Date().toISOString(),
} = {}) {
  const pageUrl = assertObservedPageUrl(sourceUrl, ACTIVITIES_URL, 'Trip.com things-to-do home');
  const dom = new JSDOM(String(html), { url: pageUrl.href });
  try {
    const document = dom.window.document;
    if (pageHasVisibleChallenge(html)) throw fail('TRIP_PUBLIC_PAGE_CHALLENGE', 'Trip.com activities page returned a visible challenge page');
    if (!document.title.includes('트립닷컴') || !document.querySelector('[data-cargo*="currency:"]')) {
      throw fail('HTML_LAYOUT_CHANGED', 'Trip.com activities page metadata was not found');
    }
    const anchors = [...document.querySelectorAll('a[href*="/things-to-do/detail/"]')];
    const parsed = anchors.map(anchor => productCard(anchor, { baseUrl: pageUrl.href, observedAt })).filter(Boolean);
    const cards = [...new Map(parsed.map(card => [card.productId, card])).values()];
    if (!cards.length) throw fail('HTML_LAYOUT_CHANGED', 'Trip.com activities SSR cards were not found');

    return {
      sourceId: 'trip-things-to-do',
      operation: 'things-to-do-home-ssr',
      sourceUrl: pageUrl.href,
      pageTitle: document.title,
      observedAt,
      anchorCount: anchors.length,
      returnedCardCount: cards.length,
      duplicateCardAnchorCount: parsed.length - cards.length,
      pricedCardCount: cards.filter(card => card.startingPriceKrw !== null).length,
      discountedCardCount: cards.filter(card => card.discountRateLabels.length > 0
        || (card.originalPriceKrw !== null && card.salePriceKrw !== null && card.salePriceKrw < card.originalPriceKrw)).length,
      promotionalCardCount: cards.filter(card => card.promoLabels.length > 0).length,
      execution: { mode: 'pure_http', representation: 'server-rendered HTML Document', auth: 'anonymous', browserUsed: false },
      coverage: {
        rows: 'distinct product cards present in the first things-to-do Document response',
        paginationReplayed: false,
        activityDateAndParticipants: 'not supplied by the observed card payload',
        taxesAndFees: 'unknown; no checkout total verified',
        promotions: 'display labels only; eligibility, date, and checkout application are unverified',
      },
      cards,
    };
  } finally {
    dom.window.close();
  }
}

async function getPublicDocument(url, { fetchImpl = fetch, timeoutMs = 20000, minHostIntervalMs = MIN_HOST_INTERVAL_MS } = {}) {
  const delay = minHostIntervalMs - (Date.now() - lastRequestAt);
  if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
  lastRequestAt = Date.now();
  const observedAt = new Date().toISOString();
  const response = await fetchImpl(url, {
    method: 'GET',
    credentials: 'omit',
    redirect: 'manual',
    headers: {
      accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      'accept-language': 'ko-KR,ko;q=0.9,en;q=0.5',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  const metadata = {
    origin: new URL(url).origin,
    path: new URL(url).pathname,
    method: 'GET',
    auth: 'anonymous',
    userAgent: 'runtime default; no User-Agent override',
    observedAt,
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const html = bytes.toString('utf8');
  if (response.status !== 200 || !/text\/html/i.test(metadata.contentType)) {
    throw fail('TRIP_PUBLIC_DOCUMENT_UNAVAILABLE', 'Trip.com public Document did not return HTML HTTP 200', metadata);
  }
  if (pageHasVisibleChallenge(html)) {
    throw fail('TRIP_PUBLIC_PAGE_CHALLENGE', 'Trip.com public Document returned a visible challenge page', metadata);
  }
  return { html, metadata };
}

export async function fetchTripDaNangHotelList(options = {}) {
  const { html, metadata } = await getPublicDocument(HOTEL_LIST_URL, options);
  return { metadata, result: parseTripCityHotelList(html, { sourceUrl: HOTEL_LIST_URL, observedAt: metadata.observedAt }) };
}

export async function fetchTripThingsToDo(options = {}) {
  const { html, metadata } = await getPublicDocument(ACTIVITIES_URL, options);
  return { metadata, result: parseTripThingsToDo(html, { sourceUrl: ACTIVITIES_URL, observedAt: metadata.observedAt }) };
}

export const TRIP_PUBLIC_ROUTES = Object.freeze({ hotelList: HOTEL_LIST_URL, thingsToDo: ACTIVITIES_URL });
