const NAVER_ORIGIN = 'https://map.naver.com';
const KAKAO_MAP_ORIGIN = 'https://map.kakao.com';
const KAKAO_PLACE_ORIGIN = 'https://place.map.kakao.com';
const NAVER_REFERER = 'https://map.naver.com/';
const REQUEST_TIMEOUT_MS = 12000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_RESULTS = 15;
const MAX_REVIEW_SAMPLES = 20;

export class PlaceInfoError extends Error {
  constructor(code) {
    super(code);
    this.name = 'PlaceInfoError';
    this.code = code;
  }
}

function error(code) {
  return new PlaceInfoError(code);
}

function requiredQuery(value) {
  if (typeof value !== 'string') throw error('PLACES_QUERY_INPUT');
  const query = value.trim();
  if (!query || query.length > 100 || /[\u0000-\u001f\u007f]/.test(query)) throw error('PLACES_QUERY_INPUT');
  return query;
}

function requiredPlaceId(value) {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value)
    : typeof value === 'string' ? value.trim() : '';
  if (!/^[0-9]{1,20}$/.test(id)) throw error('PLACES_ID_INPUT');
  return id;
}

function safeText(value, limit = 500) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, limit) : null;
}

function safeReviewText(value, limit = 1200) {
  const text = safeText(value, limit);
  if (!text) return null;
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[이메일]')
    .replace(/(?:\+?82[\s-]?)?0\d{1,2}[\s-]?\d{3,4}[\s-]?\d{4}/g, '[전화번호]')
    .replace(/https?:\/\/\S+/gi, '[링크]');
}

function finiteNumber(value) {
  const number = typeof value === 'number' ? value
    : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

function countValue(value) {
  const direct = finiteNumber(value);
  if (direct !== null && direct >= 0) return Math.floor(direct);
  if (typeof value !== 'string') return null;
  const match = value.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(만|천)?/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const multiplier = match[2] === '만' ? 10000 : match[2] === '천' ? 1000 : 1;
  return Math.round(amount * multiplier);
}

function splitKakaoAddress(value) {
  const text = safeText(value, 500);
  return text ? text.split('|').filter(Boolean).join(' ') : null;
}

function safeHomepage(value) {
  const text = safeText(value, 1000);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:token|auth|session|secret|api[_-]?key|credential)/i.test(key)) url.searchParams.delete(key);
    }
    return url.href;
  } catch {
    return null;
  }
}

function checkedUrl(url, expectedOrigin, referer) {
  let parsed;
  try { parsed = new URL(url); } catch { throw error('PLACES_URL_INVALID'); }
  if (parsed.protocol !== 'https:' || parsed.origin !== expectedOrigin || parsed.username || parsed.password)
    throw error('PLACES_ORIGIN_REJECTED');
  const headers = { Accept: 'application/json' };
  if (referer) {
    let ref;
    try { ref = new URL(referer); } catch { throw error('PLACES_REFERER_INVALID'); }
    if (ref.origin !== expectedOrigin || ref.protocol !== 'https:') throw error('PLACES_REFERER_REJECTED');
    headers.Referer = ref.href;
  }
  return { parsed, headers };
}

async function getObservedJson(url, { origin, referer = null } = {}) {
  const checked = checkedUrl(url, origin, referer);
  let response;
  try {
    response = await fetch(checked.parsed, {
      method: 'GET',
      headers: checked.headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw error('PLACES_NETWORK_ERROR');
  }
  if (response.status >= 300 && response.status < 400) throw error('PLACES_REDIRECT');
  if (response.status === 401 || response.status === 403) throw error('PLACES_ACCESS_BLOCKED');
  if (response.status === 429) throw error('PLACES_RATE_LIMITED');
  if (response.status >= 500) throw error('PLACES_UPSTREAM_UNAVAILABLE');
  if (!response.ok) throw error('PLACES_UPSTREAM_HTTP');
  const contentType = response.headers.get('content-type') || '';
  if (!/(?:application|text)\/(?:[\w.+-]*\+)?json\b/i.test(contentType)) throw error('PLACES_CONTENT_TYPE');
  let bytes;
  try { bytes = Buffer.from(await response.arrayBuffer()); } catch { throw error('PLACES_NETWORK_ERROR'); }
  if (bytes.length > MAX_RESPONSE_BYTES) throw error('PLACES_RESPONSE_TOO_LARGE');
  let data;
  try { data = JSON.parse(bytes.toString('utf8')); } catch { throw error('PLACES_JSON_INVALID'); }
  if (!data || typeof data !== 'object') throw error('PLACES_SCHEMA');
  return { data, status: response.status, contentType, bytes: bytes.length };
}

function stateFor(response) {
  return {
    captured: true,
    client_exists: true,
    execution_mode: 'pure_http',
    browser_used: false,
    credential_propagated: false,
    cookie_sent: false,
    captcha_token_sent: false,
    live_replay: true,
    http_status: response.status,
    content_type: response.contentType,
    response_bytes: response.bytes,
  };
}

function mapCategories(row) {
  const categories = [
    row?.cate_name_depth1, row?.cate_name_depth2, row?.cate_name_depth3,
    row?.cate_name_depth4, row?.cate_name_depth5,
  ].map(value => safeText(value, 100)).filter(Boolean);
  if (!categories.length && row?.last_cate_name) categories.push(safeText(row.last_cate_name, 100));
  return [...new Set(categories)];
}

export function normalizeKakaoPlaceSearchResult(row) {
  if (!row || typeof row !== 'object') return null;
  const placeId = safeText(row.confirmid, 40);
  const name = safeText(row.name, 300);
  if (!placeId || !/^[0-9]{1,20}$/.test(placeId) || !name) return null;
  const road = splitKakaoAddress(row.new_address_disp || row.new_address);
  const display = splitKakaoAddress(row.address_disp || row.address);
  return {
    entityType: 'Place',
    source: 'kakao-map',
    sourcePlaceId: placeId,
    sourceUrl: 'https://place.map.kakao.com/' + placeId,
    name,
    categories: mapCategories(row),
    address: { road, display, jibun: null },
    coordinate: { latitude: finiteNumber(row.lat), longitude: finiteNumber(row.lon) },
    contact: { phone: safeText(row.tel, 80), homepage: safeHomepage(row.homepage) },
    rating: {
      average: finiteNumber(row.rating_average) ?? finiteNumber(row.kplace_rating),
      scale: 5,
      visitorReviewCount: countValue(row.rating_count),
      blogReviewCount: countValue(row.reviewCount),
    },
    business: { statusCode: safeText(row.openoff_status, 40) },
    sponsored: Boolean(safeText(row.ad_track_id, 200)),
  };
}

export function normalizeNaverPlaceSummary(payload, placeId) {
  const row = payload?.data?.placeDetail;
  if (!row || typeof row !== 'object' || !safeText(row.name, 300)) throw error('PLACES_SCHEMA');
  const visitorReviews = row.visitorReviews && typeof row.visitorReviews === 'object' ? row.visitorReviews : {};
  const blogReviews = row.blogReviews && typeof row.blogReviews === 'object' ? row.blogReviews : {};
  const address = row.address && typeof row.address === 'object' ? row.address : {};
  const coordinate = row.coordinate && typeof row.coordinate === 'object' ? row.coordinate : {};
  const category = safeText(row.category?.category, 150);
  const id = requiredPlaceId(placeId);
  return {
    entityType: 'Place',
    source: 'naver-place',
    sourcePlaceId: id,
    name: safeText(row.name, 300),
    businessType: safeText(row.businessType, 100),
    categories: category ? [category] : [],
    address: {
      road: safeText(address.roadAddress, 500),
      display: safeText(address.formattedAddress || address.address, 500),
      jibun: safeText(address.address, 500),
    },
    coordinate: {
      latitude: finiteNumber(coordinate.latitude),
      longitude: finiteNumber(coordinate.longitude),
    },
    contact: { phone: null, homepage: null },
    businessHours: safeText(row.businessHours?.description, 500),
    rating: {
      average: finiteNumber(visitorReviews.score),
      scale: 5,
      visitorReviewCount: countValue(visitorReviews.displayText),
      blogReviewCount: countValue(blogReviews.total),
    },
    menus: [],
    reviews: { items: [], coverage: 'aggregate_only', textReviewsObserved: false },
    evidence: { endpoint: '/p/api/place/summary/{placeId}', responseType: 'application/json' },
  };
}

function normalizeKakaoHours(row) {
  const openHours = row?.open_hours && typeof row.open_hours === 'object' ? row.open_hours : {};
  const periods = Array.isArray(openHours.week_from_today?.week_periods) ? openHours.week_from_today.week_periods : [];
  const weekly = [];
  for (const period of periods.slice(0, 2)) {
    for (const day of Array.isArray(period?.days) ? period.days.slice(0, 7) : []) {
      const label = safeText(day?.day_of_the_week_desc, 40);
      const time = safeText(day?.on_days?.start_end_time_desc, 120);
      if (label || time) weekly.push({ day: label, time });
    }
  }
  return { status: safeText(openHours.headline?.display_text, 160), weekly };
}

function normalizeKakaoMenu(row) {
  const items = Array.isArray(row?.menu?.menus?.items) ? row.menu.menus.items : [];
  return items.slice(0, 30).map(item => ({
    name: safeText(item?.name, 200),
    price: finiteNumber(item?.price),
    currency: finiteNumber(item?.price) === null ? null : 'KRW',
    recommended: item?.is_recommend === true,
  })).filter(item => item.name);
}

function normalizeKakaoReviews(payload) {
  const rows = Array.isArray(payload?.reviews) ? payload.reviews : [];
  const strengths = new Map((Array.isArray(payload?.strength_description) ? payload.strength_description : [])
    .map(item => [String(item?.id), safeText(item?.name, 100)]).filter(([id, name]) => id !== 'undefined' && name));
  const items = rows.slice(0, MAX_REVIEW_SAMPLES).map(row => ({
    rating: finiteNumber(row?.star_rating),
    text: safeReviewText(row?.contents, 1200),
    publishedAt: safeText(row?.registered_at, 60),
    strengths: (Array.isArray(row?.strength_ids) ? row.strength_ids : [])
      .map(id => strengths.get(String(id))).filter(Boolean),
    photoCount: countValue(row?.photo_count) ?? 0,
  }));
  return {
    visitorReviewCount: countValue(payload?.score_set?.review_count),
    averageRating: finiteNumber(payload?.score_set?.average_score),
    items,
    hasNext: typeof payload?.has_next === 'boolean' ? payload.has_next : null,
    order: 'RECOMMENDED',
    pageSize: MAX_REVIEW_SAMPLES,
  };
}

function normalizeKakaoPlaceDetail(payload, placeId, reviewPayload, reviewAccess) {
  const row = payload?.summary;
  if (!row || typeof row !== 'object' || !safeText(row.name, 300)) throw error('PLACES_SCHEMA');
  const address = row.address && typeof row.address === 'object' ? row.address : {};
  const category = row.category && typeof row.category === 'object' ? row.category : {};
  const categories = [category.name1, category.name2, category.name3].map(value => safeText(value, 100)).filter(Boolean);
  const scores = payload?.kakaomap_review?.score_set && typeof payload.kakaomap_review.score_set === 'object'
    ? payload.kakaomap_review.score_set : {};
  const reviewData = reviewPayload ? normalizeKakaoReviews(reviewPayload) : {
    visitorReviewCount: countValue(scores.review_count),
    averageRating: finiteNumber(scores.average_score),
    items: [],
    hasNext: null,
    order: 'RECOMMENDED',
    pageSize: 0,
  };
  const phone = Array.isArray(row.phone_numbers) ? row.phone_numbers[0]?.tel : null;
  const homepages = Array.isArray(row.homepages) ? row.homepages : [];
  return {
    entityType: 'Place',
    source: 'kakao-map',
    sourcePlaceId: placeId,
    sourceUrl: 'https://place.map.kakao.com/' + placeId,
    name: safeText(row.name, 300),
    categories,
    address: {
      road: safeText(address.road, 500),
      display: safeText(address.disp, 500),
      jibun: safeText(address.jibun, 500),
    },
    coordinate: {
      latitude: finiteNumber(row.point?.lat),
      longitude: finiteNumber(row.point?.lon),
    },
    contact: {
      phone: safeText(phone, 80),
      homepage: safeHomepage(homepages[0]),
    },
    businessHours: normalizeKakaoHours(payload),
    rating: {
      average: reviewData.averageRating ?? finiteNumber(scores.average_score),
      scale: 5,
      visitorReviewCount: reviewData.visitorReviewCount ?? countValue(scores.review_count),
      blogReviewCount: countValue(payload?.blog_review?.review_count),
    },
    menus: normalizeKakaoMenu(payload),
    reviews: {
      items: reviewData.items,
      coverage: reviewAccess === 'allowed' ? 'first_page_only' : reviewAccess,
      hasNext: reviewData.hasNext,
      order: reviewData.order,
    },
    photos: { total: countValue(payload?.photos?.counts?.total) },
  };
}

function normalizeCenter(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 60 || !/^\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*$/.test(value))
    throw error('PLACES_CENTER_INPUT');
  return value.replace(/\s+/g, '');
}

export async function searchKakaoPlaces({ query, center } = {}) {
  const normalizedQuery = requiredQuery(query);
  const normalizedCenter = normalizeCenter(center);
  const url = new URL('/api/v1/mapsearch/map', KAKAO_MAP_ORIGIN);
  url.searchParams.set('msFlag', 'A');
  url.searchParams.set('q', normalizedQuery);
  url.searchParams.set('sort', '0');
  if (normalizedCenter) url.searchParams.set('center', normalizedCenter);
  const response = await getObservedJson(url.href, { origin: KAKAO_MAP_ORIGIN });
  const rows = response.data?.place;
  if (!Array.isArray(rows)) throw error('PLACES_SCHEMA');
  const places = rows.slice(0, MAX_SEARCH_RESULTS).map(normalizeKakaoPlaceSearchResult).filter(Boolean);
  return {
    source: 'kakao-map',
    query: normalizedQuery,
    pageResultCount: places.length,
    totalResultCount: countValue(response.data?.place_totalcount),
    places,
    evidence: { endpoint: '/api/v1/mapsearch/map', requestMethod: 'GET', responseType: 'application/json' },
    state: stateFor(response),
  };
}

export async function readKakaoPlace({ placeId } = {}) {
  const id = requiredPlaceId(placeId);
  const panelUrl = new URL('/places/panel3/' + id, KAKAO_PLACE_ORIGIN);
  const panelResponse = await getObservedJson(panelUrl.href, { origin: KAKAO_PLACE_ORIGIN });
  const reviewReadable = panelResponse.data?.restrict?.review_read?.is_restrict === false;
  let reviewResponse = null;
  if (reviewReadable) {
    const reviewUrl = new URL('/places/tab/reviews/kakaomap/' + id, KAKAO_PLACE_ORIGIN);
    reviewUrl.searchParams.set('only_photo_review', 'false');
    reviewUrl.searchParams.set('order', 'RECOMMENDED');
    reviewResponse = await getObservedJson(reviewUrl.href, { origin: KAKAO_PLACE_ORIGIN });
  }
  const reviewAccess = reviewReadable ? 'allowed' : 'restricted_or_unknown';
  const place = normalizeKakaoPlaceDetail(panelResponse.data, id, reviewResponse?.data, reviewAccess);
  return {
    source: 'kakao-map',
    place,
    reviewPage: {
      requested: reviewReadable,
      returned: reviewResponse ? place.reviews.items.length : 0,
      visitorReviewCount: place.rating.visitorReviewCount,
      hasNext: place.reviews.hasNext,
      coverage: place.reviews.coverage,
    },
    evidence: {
      detailEndpoint: '/places/panel3/{placeId}',
      reviewEndpoint: reviewReadable ? '/places/tab/reviews/kakaomap/{placeId}' : null,
      requestMethod: 'GET',
      responseType: 'application/json',
    },
    state: {
      captured: true,
      client_exists: true,
      execution_mode: 'pure_http',
      browser_used: false,
      credential_propagated: false,
      cookie_sent: false,
      captcha_token_sent: false,
      live_replay: true,
      http_statuses: {
        detail: panelResponse.status,
        ...(reviewResponse ? { reviews: reviewResponse.status } : {}),
      },
    },
  };
}

export async function readNaverPlaceSummary({ placeId } = {}) {
  const id = requiredPlaceId(placeId);
  const url = new URL('/p/api/place/summary/' + id, NAVER_ORIGIN);
  const response = await getObservedJson(url.href, { origin: NAVER_ORIGIN, referer: NAVER_REFERER });
  const place = normalizeNaverPlaceSummary(response.data, id);
  return {
    source: 'naver-place',
    place,
    evidence: { endpoint: '/p/api/place/summary/{placeId}', requestMethod: 'GET', responseType: 'application/json' },
    state: stateFor(response),
  };
}
