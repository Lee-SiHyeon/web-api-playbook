import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const DESTINATIONS = ['\uB2E4\uB0AD', '\uB098\uD2B8\uB791'];
const WINDOW_DAYS = 3;
const ANCHOR_OFFSET_DAYS = 28;
const MIN_HOST_GAP_MS = 2050;
const MAX_SELLER_REQUESTS = 40;
const MAX_RESPONSE_BYTES = 100 * 1024 * 1024;
const VALID_PRICE_BASES = new Set([
  'dated_event_price', 'dated_adult_starting_price', 'dated_calendar_price', 'dated_detail_price',
]);
const DIMENSIONS = [
  'destinationCitySet', 'nights', 'days', 'departureAirport', 'airlineClass',
  'directness', 'hotelGradeBand', 'shoppingStopBand',
];
const CITY_IDS = new Map([
  ['\uB2E4\uB0AD', 'VN-DAD'], ['da nang', 'VN-DAD'], ['danang', 'VN-DAD'], ['dad', 'VN-DAD'], ['vn-dad', 'VN-DAD'],
  ['\uD638\uC774\uC548', 'VN-HOI'], ['hoi an', 'VN-HOI'], ['hoian', 'VN-HOI'], ['vn-hoi', 'VN-HOI'],
  ['\uD6C4\uC5D0', 'VN-HUE'], ['hue', 'VN-HUE'], ['vn-hue', 'VN-HUE'],
  ['\uB098\uD2B8\uB791', 'VN-NHA'], ['\uB098\uC9F1', 'VN-NHA'], ['nha trang', 'VN-NHA'], ['nhatrang', 'VN-NHA'], ['vn-nha', 'VN-NHA'],
  ['\uB2EC\uB7AB', 'VN-DLI'], ['da lat', 'VN-DLI'], ['dalat', 'VN-DLI'], ['vn-dli', 'VN-DLI'],
]);
const SELLER_LABELS = new Map([
  ['yellowballoon-package', '\uB178\uB791\uD48D\uC120'],
  ['verygood-package', '\uCC38\uC88B\uC740\uC5EC\uD589'],
  ['lotte-package', '\uB86F\uB370\uAD00\uAD11'],
]);
const OBSERVED_ORIGINS = new Map([
  ['yellowballoon-package', 'https://papi.ybtour.co.kr'],
  ['verygood-package', 'https://www.verygoodtour.com'],
  ['lotte-package', 'https://www.lottetour.com'],
]);
const SELLER_ALIASES = new Map([
  ['verygood', 'verygood-package'],
  ['yellowballoon-package', 'yellowballoon-package'],
  ['lotte-package', 'lotte-package'],
]);
const POST_READ_CONTRACT = /read[- ]only|read[- ]only search|search\/detail lookup/i;

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function seoulToday() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function dateWindow(anchor, days) {
  return { from: addDays(anchor, -days), through: addDays(anchor, days) };
}

function inWindow(date, anchor, days) {
  return validDate(date) && date >= addDays(anchor, -days) && date <= addDays(anchor, days);
}

function positiveInteger(value) {
  const number = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[\s,]/g, ''));
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function priceKrw(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[\s,\uC6D0]/g, ''));
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function normalizeDimension(row, name) {
  const value = row?.[name];
  if (name === 'destinationCitySet') {
    if (!Array.isArray(value) || value.length === 0 || value.some((item) => !text(item))) return null;
    return [...new Set(value.map((item) => {
      const raw = text(item);
      return CITY_IDS.get(raw.toLowerCase()) ?? raw;
    }))].sort();
  }
  if (name === 'nights' || name === 'days') return positiveInteger(value);
  if (name === 'hotelGradeBand') return ['3', '4', '5', 3, 4, 5].includes(value) ? String(value) : null;
  if (name === 'airlineClass') return ['FSC', 'LCC', 'mixed'].includes(value) ? value : null;
  if (name === 'directness') return ['direct', 'connecting', 'mixed'].includes(value) ? value : null;
  if (name === 'shoppingStopBand') return ['0', '1-2', '3+'].includes(value) ? value : null;
  return text(value);
}

function compareDimensions(product, departure) {
  const combined = { ...product, ...departure };
  const dimensions = Object.fromEntries(DIMENSIONS.map((name) => [name, normalizeDimension(combined, name)]));
  const missing = DIMENSIONS.filter((name) => dimensions[name] === null);
  return { combined, dimensions, missing, key: JSON.stringify(dimensions) };
}

function formatAmount(amount, currency) {
  if (amount === null || amount === undefined || amount === '') return null;
  const value = Number(amount);
  if (!Number.isFinite(value) || value < 0) return null;
  const rounded = Number.isInteger(value) ? value.toLocaleString('ko-KR') : value.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
  const code = String(currency ?? '').toUpperCase();
  return code === 'KRW' || !code ? `${rounded}\uC6D0` : `${code} ${rounded}`;
}

function feeLabel(fee) {
  const source = `${fee?.name ?? ''} ${fee?.label ?? ''} ${fee?.sourceText ?? ''}`.toLowerCase();
  if (/guide|driver|\uAC00\uC774\uB4DC|\uAE30\uC0AC/.test(source)) return '\uAC00\uC774\uB4DC\u00B7\uAE30\uC0AC \uACBD\uBE44';
  if (/fuel|\uC720\uB958/.test(source)) return '\uC720\uB958\uD560\uC99D\uB8CC';
  if (/tax|\uACF5\uD56D\uC138|\uC81C\uC138/.test(source)) return '\uACF5\uD56D\uC138\u00B7\uC81C\uC138\uACF5\uACFC\uAE08';
  return text(fee?.name ?? fee?.label) ?? '\uD604\uC9C0 \uCD94\uAC00 \uACBD\uBE44';
}

function candidateFeeMessage(fee) {
  const amount = fee?.amountKrw != null && String(fee?.currency ?? '').toUpperCase() === 'KRW'
    ? formatAmount(fee.amountKrw, 'KRW')
    : formatAmount(fee?.amount, fee?.currency);
  const unit = fee?.unit === 'per_person' ? '/\uC778' : '';
  const charge = amount ? ` ${amount}${unit}` : '';
  const status = fee?.includedInBasePrice === false
    ? '\uD45C\uC2DC\uAC00 \uC81C\uC678'
    : fee?.includedInBasePrice === true
      ? '\uD45C\uC2DC\uAC00 \uD3EC\uD568'
      : '\uD3EC\uD568 \uC5EC\uBD80 \uBBF8\uD655\uC778';
  const mandatory = fee?.mandatory === true ? '\uC758\uBB34 \uCD94\uAC00\uAE08'
    : fee?.mandatory === false ? '\uC120\uD0DD \uBE44\uC6A9'
      : '\uC758\uBB34 \uC5EC\uBD80 \uBBF8\uD655\uC778';
  return `${feeLabel(fee)}${charge}: ${status}, ${mandatory}`;
}

function hiddenCostsFor(product, departure) {
  const hidden = [];
  if (departure?.fuelIncluded === false) {
    const amount = formatAmount(departure.fuelSurchargeKrw, 'KRW');
    hidden.push(amount
      ? `\uC720\uB958\uD560\uC99D\uB8CC ${amount}: \uD45C\uC2DC\uAC00 \uC81C\uC678`
      : '\uC720\uB958\uD560\uC99D\uB8CC: \uBCC4\uB3C4, \uAE08\uC561 \uBBF8\uD655\uC778');
  } else if (departure?.fuelIncluded !== true) {
    hidden.push('\uC720\uB958\uD560\uC99D\uB8CC \uD3EC\uD568 \uC5EC\uBD80 \uBBF8\uD655\uC778');
  }

  if (departure?.airportTaxIncluded !== true) {
    const amount = formatAmount(departure?.airportTaxKrw, 'KRW');
    hidden.push(amount
      ? `\uACF5\uD56D\uC138\u00B7\uC81C\uC138\uACF5\uACFC\uAE08 ${amount}: \uD45C\uC2DC\uAC00 \uD3EC\uD568 \uC5EC\uBD80 \uBBF8\uD655\uC778`
      : '\uACF5\uD56D\uC138\u00B7\uC81C\uC138\uACF5\uACFC\uAE08 \uD3EC\uD568 \uC5EC\uBD80 \uBBF8\uD655\uC778');
  }

  const localFees = Array.isArray(departure?.localFees) ? departure.localFees : [];
  const feeCandidates = Array.isArray(departure?.localFeeCandidates) ? departure.localFeeCandidates : [];
  for (const fee of [...localFees, ...feeCandidates]) hidden.push(candidateFeeMessage(fee));
  if (departure?.localFeesComplete !== true) hidden.push('\uD604\uC9C0 \uD544\uC218 \uACBD\uBE44 \uC804\uCCB4 \uBAA9\uB85D\uACFC \uAE08\uC561 \uBBF8\uD655\uC778');

  if (Array.isArray(departure?.mandatoryOptions)) {
    for (const option of departure.mandatoryOptions) {
      const amount = formatAmount(option?.amountKrw ?? option?.amount, option?.currency ?? 'KRW');
      hidden.push(`${text(option?.name) ?? '\uD544\uC218 \uC120\uD0DD\uAD00\uAD11\u00B7\uC635\uC158'}${amount ? ` ${amount}` : ''}: ${option?.mandatory === true ? '\uC758\uBB34' : '\uC758\uBB34 \uC5EC\uBD80 \uBBF8\uD655\uC778'}`);
    }
  }
  if (departure?.mandatoryOptionsComplete !== true) hidden.push('\uD544\uC218 \uC120\uD0DD\uAD00\uAD11\u00B7\uC635\uC158 \uC804\uCCB4 \uBAA9\uB85D\uACFC \uCD94\uAC00\uAE08 \uBBF8\uD655\uC778');
  if (departure?.discounts == null) hidden.push('\uCE74\uB4DC\u00B7\uCFE0\uD3F0 \uD560\uC778 \uC870\uAC74\uACFC \uC801\uC6A9 \uC790\uACA9 \uBBF8\uD655\uC778');

  const supplement = priceKrw(departure?.singleSupplementKrw ?? product?.singleSupplementKrw);
  if (supplement !== null) hidden.push(`1\uC778\uC2E4 \uCD94\uAC00\uAE08 ${formatAmount(supplement, 'KRW')} (2\uC778 1\uC2E4 \uAE30\uC900 \uD45C\uC2DC\uAC00 \uC81C\uC678)`);
  return [...new Set(hidden)];
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function safeSellerUrl(sellerId, value) {
  const url = safeHttpsUrl(value);
  return url && new URL(url).origin === OBSERVED_ORIGINS.get(sellerId) ? url : null;
}

function statusOk(request) {
  return Number.isInteger(request?.status) && request.status >= 200 && request.status < 300;
}

function requestFor(requests, predicate) {
  return [...(requests ?? [])].filter(predicate).sort((a, b) => String(b.checkedAt ?? '').localeCompare(String(a.checkedAt ?? '')))[0] ?? null;
}

function evidenceFor(product, departure, referenceAt = null) {
  const requests = product?._displayRequests ?? [];
  const id = String(departure?.sellerDepartureId ?? '');
  let quoteRequest = null;
  let detailRequest = null;
  let pageRequest = null;
  if (product?.sellerId === 'yellowballoon-package') {
    quoteRequest = requestFor(requests, (request) => request.name === `by-goods-${product.sellerProductId}`);
    detailRequest = requestFor(requests, (request) => request.name === `event-${id}`);
  } else if (product?.sellerId === 'verygood-package') {
    quoteRequest = requestFor(requests, (request) => request.name?.startsWith('list-'));
    detailRequest = requestFor(requests, (request) => request.name?.startsWith('detail-') && request.name.endsWith(id));
    pageRequest = detailRequest;
  } else if (product?.sellerId === 'lotte-package') {
    quoteRequest = requestFor(requests, (request) => request.name?.includes(`${product.sellerProductId}-price-list`));
    detailRequest = requestFor(requests, (request) => request.name?.endsWith(`${id}-dated-detail`));
    pageRequest = requestFor(requests, (request) => request.name?.endsWith(`${product.sellerProductId}-detail`));
  }
  const sourceRequest = detailRequest ?? quoteRequest;
  const checkedAtCandidates = [quoteRequest?.checkedAt, detailRequest?.checkedAt]
    .filter((value) => Number.isFinite(Date.parse(value)) && validDate(String(value).slice(0, 10)))
    .sort();
  const checkedAt = checkedAtCandidates.at(-1) ?? product?._displayCheckedAt ?? null;
  const priceKrwValue = priceKrw(departure?.basePriceKrw);
  const referenceMs = Date.parse(referenceAt ?? new Date().toISOString());
  const isFresh = (request) => {
    const requestMs = Date.parse(request?.checkedAt ?? '');
    return Number.isFinite(requestMs) && Number.isFinite(referenceMs)
      && requestMs <= referenceMs + 5_000 && referenceMs - requestMs <= 15 * 60_000;
  };
  const hasEvidence = statusOk(quoteRequest) && statusOk(detailRequest)
    && isFresh(quoteRequest) && isFresh(detailRequest)
    && checkedAt && priceKrwValue !== null && VALID_PRICE_BASES.has(departure?.priceBasis);
  const sourceUrl = safeSellerUrl(product?.sellerId, sourceRequest?.url);
  return {
    verified: {
      ok: Boolean(hasEvidence),
      checkedAt,
      link: sourceUrl,
      priceKrw: priceKrwValue,
    },
    sourceUrl,
    productUrl: sourceUrl,
    observedPageUrl: safeSellerUrl(product?.sellerId, pageRequest?.url),
  };
}

function isConfirmedNaverConnect(product) {
  const sellerName = text(product?.sellerName ?? product?.seller);
  return sellerName === '\uC5EC\uD589\uCEE4\uB125\uD2B8'
    && product?.affiliateNetwork === 'naver_connect'
    && product?.affiliateConfirmed === true;
}

function offerFrom(product, departure, destination, dimensions, checkedAt) {
  const evidence = evidenceFor(product, departure, checkedAt);
  const sellerName = text(product?.sellerName ?? product?.seller) ?? SELLER_LABELS.get(product?.sellerId) ?? product?.sellerId ?? '\uD310\uB9E4\uCC98 \uBBF8\uD655\uC778';
  const displayPrice = priceKrw(departure?.basePriceKrw);
  return {
    seller: sellerName,
    sellerId: text(product?.sellerId),
    sellerProductId: text(product?.sellerProductId),
    departureDate: departure?.departureDate,
    priceKrw: displayPrice,
    url: evidence.productUrl,
    sourceUrl: evidence.sourceUrl,
    isNaverConnect: isConfirmedNaverConnect(product),
    hiddenCosts: hiddenCostsFor(product, departure),
    verified: evidence.verified,
    destination,
    nights: dimensions.nights,
    days: dimensions.days,
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function displayReasonCounts(reasons) {
  return reasons.reduce((counts, reason) => {
    counts[reason] = (counts[reason] ?? 0) + 1;
    return counts;
  }, {});
}

/**
 * Compare live package display fares using the package ontology dimensions.
 * Cost completeness is deliberately not part of this display-price gate.
 */
export function evaluateDisplayPackages(products, { anchor, windowDays = WINDOW_DAYS, checkedAt = null } = {}) {
  if (!validDate(anchor)) throw new TypeError('anchor must be a valid YYYY-MM-DD date');
  if (!Array.isArray(products)) throw new TypeError('products must be an array');

  const selected = [];
  const excluded = [];
  for (const product of products) {
    for (const departure of product?.departures ?? []) {
      if (!inWindow(departure?.departureDate, anchor, windowDays)) continue;
      const { combined, dimensions, missing, key } = compareDimensions(product, departure);
      const amount = priceKrw(departure?.basePriceKrw);
      const reasons = [];
      if (amount === null || !VALID_PRICE_BASES.has(departure?.priceBasis)) reasons.push('dated_display_price_missing');
      if (missing.length) reasons.push('cluster_dimensions_unknown');
      if (departure?.seatsLeft === 0 || departure?.bookable === false) reasons.push('unavailable_departure');
      if (reasons.length) {
        excluded.push({
          seller: text(product?.sellerName ?? product?.seller) ?? SELLER_LABELS.get(product?.sellerId) ?? product?.sellerId ?? null,
          sellerId: text(product?.sellerId),
          sellerProductId: text(product?.sellerProductId),
          departureDate: departure?.departureDate ?? null,
          priceKrw: amount,
          reasons,
          missingDimensions: missing,
          checkedAt: evidenceFor(product, departure, checkedAt).verified.checkedAt,
        });
        continue;
      }
      const destination = text(product?._displayDestination ?? product?.destination) ?? null;
      selected.push({
        product,
        departure,
        destination,
        dimensions,
        key,
        offer: offerFrom(product, departure, destination, dimensions, checkedAt),
        price: amount,
        destinationCitySet: combined.destinationCitySet,
      });
    }
  }

  const groups = new Map();
  for (const row of selected) {
    if (!groups.has(row.key)) groups.set(row.key, []);
    groups.get(row.key).push(row);
  }

  const rows = [...groups.entries()].map(([clusterKey, candidates]) => {
    const bestBySeller = new Map();
    for (const candidate of candidates) {
      const previous = bestBySeller.get(candidate.product.sellerId);
      if (!previous || candidate.price < previous.price
          || (candidate.price === previous.price && candidate.departure.departureDate < previous.departure.departureDate)) {
        bestBySeller.set(candidate.product.sellerId, candidate);
      }
    }
    const chosen = [...bestBySeller.values()].sort((a, b) => a.price - b.price
      || a.departure.departureDate.localeCompare(b.departure.departureDate)
      || String(a.product.sellerId).localeCompare(String(b.product.sellerId)));
    const offers = chosen.map((candidate) => candidate.offer);
    const prices = offers.map((offer) => offer.priceKrw);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const spreadKrw = max - min;
    const medianPrice = median(prices);
    const discountPct = medianPrice > 0 ? Math.round(((medianPrice - min) / medianPrice) * 10000) / 100 : 0;
    const lowestCandidate = chosen[0];
    const lowestOffer = offers[0];
    const sellers = new Set(offers.map((offer) => offer.sellerId));
    const reasons = [];
    if (sellers.size < 2) reasons.push('minimum_distinct_sellers_not_met');
    if (sellers.size >= 2 && min > medianPrice * 0.92) reasons.push('display_discount_below_8_percent');
    if (offers.some((offer) => !offer.verified.ok)) reasons.push('live_recheck_incomplete');
    const eligible = reasons.length === 0;
    const route = lowestOffer.isNaverConnect && lowestOffer.verified.ok ? 'naver_connect' : 'lowest_not_affiliate';
    const groupCheckedAt = offers.map((offer) => offer.verified.checkedAt).filter(Boolean).sort().at(-1) ?? checkedAt;
    const sourceUrl = lowestOffer.verified.link ?? lowestOffer.sourceUrl;
    const hiddenCosts = [...new Set(offers.flatMap((offer) => offer.hiddenCosts.map((note) => `${offer.seller}: ${note}`)))];
    return {
      kind: 'package',
      priceTier: 'display',
      verdict: { eligible, route, ...(reasons.length ? { reasons } : {}) },
      title: text(lowestCandidate.product?.title) ?? '\uD328\uD0A4\uC9C0 \uC0C1\uD488',
      destination: lowestCandidate.destination,
      departureDate: lowestCandidate.departure.departureDate,
      anchorDepartureDate: anchor,
      windowDays,
      nights: lowestCandidate.dimensions.nights,
      days: lowestCandidate.dimensions.days,
      clusterKey,
      lowest: {
        seller: lowestOffer.seller,
        priceKrw: lowestOffer.priceKrw,
        url: sourceUrl,
        isNaverConnect: lowestOffer.isNaverConnect,
      },
      offers,
      min,
      max,
      spreadKrw,
      spreadPct: min > 0 ? Math.round((spreadKrw / min) * 10000) / 100 : null,
      median: medianPrice,
      discountPct,
      hiddenCosts,
      sourceUrl,
      checkedAt: groupCheckedAt,
      verified: { ...lowestOffer.verified },
    };
  }).sort((a, b) => a.min - b.min || a.clusterKey.localeCompare(b.clusterKey));

  return {
    anchor,
    windowDays,
    window: dateWindow(anchor, windowDays),
    selectedCount: selected.length,
    excludedCount: excluded.length,
    excludedReasons: displayReasonCounts(excluded.flatMap((row) => row.reasons)),
    excluded,
    rows,
    eligibleCount: rows.filter((row) => row.verdict.eligible).length,
    limitations: [
      'Display fares are quoted adult prices. They are not checkout totals or per-person true-payable amounts.',
      'Unknown mandatory costs do not remove a dated offer from this display comparison; each known or unconfirmed extra is disclosed in hiddenCosts.',
      'Rows are compared only when all package ontology cluster dimensions are known and equal within the anchor date window.',
      'Only an explicitly confirmed cheapest seller named \uC5EC\uD589\uCEE4\uB125\uD2B8 may use the naver_connect route.',
    ],
  };
}

function queryKeysOnly(url, expected) {
  const actual = [...url.searchParams.keys()].sort();
  return JSON.stringify(actual) === JSON.stringify([...expected].sort());
}

function validateYellowballoon(url, method) {
  if (method !== 'GET') return false;
  const p = url.pathname;
  if (/^\/pkg\/goods\/by-menu\/(?:AABF000|AABE000)$/.test(p)) return url.search === '';
  if (/^\/pkg\/goods\/[A-Za-z0-9_-]+\/available-date\/day$/.test(p)) return url.search === '';
  if (/^\/pkg\/goods\/[A-Za-z0-9_-]+\/recent-event\/amt$/.test(p)) return queryKeysOnly(url, ['startDate']) && /^\d{8}$/.test(url.searchParams.get('startDate') ?? '');
  if (/^\/pkg\/goods\/[A-Za-z0-9_-]+\/option$/.test(p) || /^\/pkg\/goods\/join-event\/[A-Za-z0-9_-]+$/.test(p)) return url.search === '';
  if (/^\/pkg\/event\/by-goods\/[A-Za-z0-9_-]+\/(?:AABF000|AABE000)\/20\d{4}$/.test(p)) return url.search === '';
  if (/^\/pkg\/event\/[A-Za-z0-9_-]+$/.test(p)) return url.search === '';
  return false;
}

function validateVerygood(url, method, options) {
  const p = url.pathname;
  if (p === '/Search/SearchKeyWordAjaxList') return method === 'GET' && queryKeysOnly(url, ['keyword']);
  if (p === '/Product/PackageList') return method === 'GET'
    && queryKeysOnly(url, ['MenuCode']) && ['101150401', '101150402'].includes(url.searchParams.get('MenuCode'));
  if (p === '/Product/GetSearchFilter' || p === '/Product/GetPackageList') {
    if (method !== 'POST' || !POST_READ_CONTRACT.test(String(options.readContract ?? ''))) return false;
    const headers = new Headers(options.headers ?? {});
    if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(headers.get('content-type') ?? '')) return false;
    const form = new URLSearchParams(String(options.body ?? ''));
    const keys = p === '/Product/GetSearchFilter'
      ? ['keyword', 'menuCode', 'regionCode']
      : ['keyword', 'menuCode', 'regionCode', 'orderby', 'CfmYN', 'depdate', 'weekday', 'day', 'price'];
    if (JSON.stringify([...form.keys()].sort()) !== JSON.stringify([...keys].sort())) return false;
    if (!['101150401', '101150402'].includes(form.get('menuCode')) || form.get('keyword') !== '' || form.get('regionCode') !== '') return false;
    return p === '/Product/GetSearchFilter' || (form.get('orderby') === '1'
      && ['CfmYN', 'depdate', 'weekday', 'day', 'price'].every((key) => form.get(key) === ''));
  }
  if (p === '/Product/PackageDetail') return method === 'GET'
    && queryKeysOnly(url, ['MenuCode', 'proCode']) && url.searchParams.get('MenuCode') === '101'
    && /^APP\d{4}-\d{6}[A-Z]{2}\d{2}$/i.test(url.searchParams.get('proCode') ?? '');
  if (p === '/Product/ProductCalendarSearch') return method === 'GET'
    && queryKeysOnly(url, ['MasterCode', 'MenuCode', 'Year', 'Month'])
    && /^APP\d{4}$/i.test(url.searchParams.get('MasterCode') ?? '') && url.searchParams.get('MenuCode') === '101'
    && /^20\d{2}$/.test(url.searchParams.get('Year') ?? '') && /^(0[1-9]|1[0-2])$/.test(url.searchParams.get('Month') ?? '');
  if (p === '/Product/ProductAirScheduleSearch') return method === 'GET'
    && queryKeysOnly(url, ['ProCode']) && /^APP\d{4}-\d{6}[A-Z]{2}\d{2}$/i.test(url.searchParams.get('ProCode') ?? '');
  return false;
}

function validateLotte(url, method) {
  if (method !== 'GET') return false;
  const p = url.pathname;
  if (p === '/search/json') {
    const keys = ['kwd', 'subkwd', 'subdatekwd', 'minprice', 'maxprice', 'checkdtcnt', 'checkday', 'checkcomm', 'checkairline', 'checkclass', 'checkstatus', 'calenderKwd', 'pageSize', 'pageNum', 'selectKey', 'startPrice', 'endPrice', 'category', 'selectcategory', 'subcategory'];
    return queryKeysOnly(url, keys) && ['\uB2E4\uB0AD', '\uB098\uD2B8\uB791'].includes(url.searchParams.get('kwd'))
      && ['1', '2'].includes(url.searchParams.get('pageNum')) && url.searchParams.get('pageSize') === '10'
      && url.searchParams.get('category') === 'globalpackage' && url.searchParams.get('selectcategory') === 'globalpackage';
  }
  if (/^\/evtList\/\d+(?:\/\d+){3}$/.test(p)) return queryKeysOnly(url, ['godId']) && /^\d{4,10}$/.test(url.searchParams.get('godId') ?? '');
  if (p === '/evtCal' || p === '/priceList') return queryKeysOnly(url, ['godId', 'depDt'])
    && /^\d{4,10}$/.test(url.searchParams.get('godId') ?? '') && /^20\d{4}$/.test(url.searchParams.get('depDt') ?? '');
  if (p === '/evtDetail') return queryKeysOnly(url, ['evtCd']) && /^[A-Za-z0-9-]{8,40}$/.test(url.searchParams.get('evtCd') ?? '');
  return false;
}

function validateObservedRequest(seller, name, rawUrl, options) {
  const canonicalSeller = SELLER_ALIASES.get(seller) ?? seller;
  const expectedOrigin = OBSERVED_ORIGINS.get(canonicalSeller);
  if (!expectedOrigin) throw new Error('seller is outside the observed anonymous package sources');
  const url = new URL(rawUrl);
  if (url.origin !== expectedOrigin || url.username || url.password || url.hash) throw new Error('request URL is outside the observed public contract');
  const method = String(options?.method ?? 'GET').toUpperCase();
  if (!['GET', 'POST'].includes(method)) throw new Error('anonymous package reader only permits GET and observed read-only POST');
  const headers = options?.headers ?? {};
  for (const key of Object.keys(headers)) {
    if (/cookie|authorization|token|api[-_]?key|session/i.test(key)) throw new Error('credential headers are prohibited');
    if (!['accept', 'content-type', 'referer'].includes(key.toLowerCase())) throw new Error('header is outside the observed anonymous request contract');
  }
  if (headers.referer) {
    const referer = new URL(headers.referer);
    if (referer.origin !== expectedOrigin || referer.username || referer.password) throw new Error('referer is outside the observed public origin');
  }
  const valid = canonicalSeller === 'yellowballoon-package' ? validateYellowballoon(url, method)
    : canonicalSeller === 'verygood-package' ? validateVerygood(url, method, options ?? {})
      : validateLotte(url, method);
  if (!valid) throw new Error(`unobserved anonymous ${method} package request: ${name}`);
  return { url, method, sellerId: canonicalSeller };
}

/** Safe in-memory anonymous HTTP reader for the already observed package read contracts. */
export function createAnonymousReader({ fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const lastStartByHost = new Map();
  const hostQueues = new Map();
  const requestCounts = new Map();
  const auditLedger = [];

  async function waitForHost(host) {
    const previous = hostQueues.get(host) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    hostQueues.set(host, previous.then(() => current));
    await previous;
    let startedAt;
    try {
      const lastStart = lastStartByHost.get(host) ?? 0;
      const pause = Math.max(0, MIN_HOST_GAP_MS - (now() - lastStart));
      if (pause) await sleep(pause);
      startedAt = now();
      lastStartByHost.set(host, startedAt);
    } finally {
      release();
    }
    return startedAt;
  }

  const readAnonymous = async function readAnonymous(seller, name, rawUrl, options = {}) {
    const { url, method, sellerId } = validateObservedRequest(seller, name, rawUrl, options);
    const count = requestCounts.get(sellerId) ?? 0;
    if (count >= MAX_SELLER_REQUESTS) throw new Error('anonymous package source request budget exhausted');
    requestCounts.set(sellerId, count + 1);
    const checkedAt = new Date(await waitForHost(url.host)).toISOString();
    const headers = new Headers({
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36',
      'accept-language': 'ko-KR,ko;q=0.9',
      accept: options.accept ?? options.headers?.accept ?? '*/*',
    });
    if (options.headers?.['content-type']) headers.set('content-type', options.headers['content-type']);
    if (options.headers?.referer) headers.set('referer', options.headers.referer);
    const meta = {
      seller: sellerId, sellerId, name, host: url.host, url: url.href, method, checkedAt, startedAt: checkedAt, status: null, contentType: '',
      bytes: 0, sha256: null, capture: null, error: null,
    };
    const audit = {
      sellerId, name, host: url.host, url: url.href, method, startedAt: checkedAt, checkedAt,
      status: null, contentType: '', bytes: 0, sha256: null, error: null,
    };
    auditLedger.push(audit);
    let body = Buffer.alloc(0);
    try {
      const response = await fetchImpl(url.href, {
        method,
        headers,
        body: method === 'POST' ? String(options.body ?? '') : undefined,
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
        signal: AbortSignal.timeout(options.timeoutMs ?? 16_000),
      });
      meta.status = response.status;
      meta.contentType = response.headers?.get?.('content-type') ?? '';
      audit.status = meta.status;
      audit.contentType = meta.contentType;
      body = Buffer.from(await response.arrayBuffer());
      meta.bytes = body.byteLength;
      meta.sha256 = createHash('sha256').update(body).digest('hex');
      audit.bytes = meta.bytes;
      audit.sha256 = meta.sha256;
      if (body.byteLength > MAX_RESPONSE_BYTES) throw new Error('anonymous package response exceeded the in-memory size limit');
    } catch (error) {
      meta.error = { name: error?.name ?? 'Error', message: String(error?.message ?? error) };
      audit.error = meta.error.message;
      body = Buffer.alloc(0);
    }
    const responseText = body.toString('utf8');
    return { meta, text: responseText, bytes: body, json: () => JSON.parse(responseText) };
  };
  readAnonymous.audit = () => auditLedger.map((entry) => ({ ...entry, error: entry.error }));
  return readAnonymous;
}

async function collectPackageData({ anchor, readImpl, destination = 'both', sellerIds = null }) {
  const yellowAdapter = await import('./seller-adapters/yellowballoon.mjs');
  const verygoodAdapter = await import('./seller-adapters/verygood.mjs');
  const lotteAdapter = await import('./seller-adapters/lotte.mjs');
  const sellerResults = [];
  const selectedSellers = new Set(sellerIds ?? ['yellowballoon-package', 'verygood-package', 'lotte-package']);
  const destinations = destination === 'both' ? DESTINATIONS : [destination];
  const run = async (sellerId, method) => {
    try {
      sellerResults.push(await method());
    } catch (error) {
      sellerResults.push({ sellerId, verdict: 'collector_error', error: String(error?.message ?? error), products: [], requests: [] });
    }
  };

  if (selectedSellers.has('yellowballoon-package')) {
    await run('yellowballoon-package', () => yellowAdapter.collectYellowballoonLive({
      destination, anchor, windowDays: WINDOW_DAYS, requestBudget: MAX_SELLER_REQUESTS,
      maxProductsPerDestination: 1, readImpl,
    }));
  }
  for (const target of destinations) {
    if (selectedSellers.has('verygood-package')) {
      await run('verygood-package', () => verygoodAdapter.collectVerygoodLive({
        destination: target, anchor, anchorDate: anchor, windowDays: WINDOW_DAYS, readImpl,
      }));
    }
    if (selectedSellers.has('lotte-package')) {
      await run('lotte-package', () => lotteAdapter.collectLotteLive({
        destination: target, anchor, anchorDate: anchor, daysBefore: WINDOW_DAYS, daysAfter: WINDOW_DAYS,
        maxRequests: 12, maxProducts: 1, readImpl,
      }));
    }
  }

  const products = [];
  for (const result of sellerResults) {
    const requests = result.requests ?? [];
    if (result.sellerId === 'yellowballoon-package' && result.byDestination) {
      for (const [destination, byDestination] of Object.entries(result.byDestination)) {
        for (const product of byDestination.products ?? []) {
          products.push({ ...product, _displayDestination: destination, _displayRequests: requests, _displayCheckedAt: result.checkedAt });
        }
      }
      continue;
    }
    const destination = text(result.destination);
    for (const product of result.products ?? []) {
      products.push({ ...product, _displayDestination: destination, _displayRequests: requests, _displayCheckedAt: result.checkedAt });
    }
  }
  return { sellerResults, products, requests: sellerResults.flatMap((result) => result.requests ?? []) };
}

function publicRequestSummary(request) {
  return {
    seller: request.seller ?? request.sellerId ?? null,
    host: request.host ?? null,
    destination: request.destination ?? null,
    name: request.name ?? null,
    method: request.method ?? 'GET',
    url: safeSellerUrl(request.seller ?? request.sellerId, request.url),
    status: Number.isInteger(request.status) ? request.status : null,
    startedAt: request.startedAt ?? request.checkedAt ?? null,
    checkedAt: request.checkedAt ?? null,
    bytes: Number.isFinite(request.bytes) ? request.bytes : null,
    sha256: text(request.sha256),
    error: text(request.error?.message ?? request.error),
  };
}

function collectionRequests(collection) {
  return collection?.requests ?? collection?.sellerResults?.flatMap((result) => result.requests ?? []) ?? [];
}

async function runCollection(collect, options, readImpl) {
  const hasAudit = typeof readImpl.audit === 'function';
  const before = hasAudit ? readImpl.audit().length : 0;
  let collection;
  try {
    collection = await collect(options) ?? {};
  } catch (error) {
    collection = {
      sellerResults: [{ sellerId: 'package-collector', verdict: 'collector_error', error: String(error?.message ?? error), requests: [] }],
      products: [], requests: [],
    };
  }
  if (!hasAudit) return collection;
  const audit = readImpl.audit();
  const newStarts = audit.slice(before);
  if (!newStarts.length) return collection;
  const observedRows = collectionRequests(collection);
  const requests = newStarts.map((entry) => {
    const matching = observedRows.find((row) => row.name === entry.name && row.url === entry.url);
    return { ...entry, destination: matching?.destination ?? null };
  });
  return { ...collection, requests };
}

function demoteRow(row, reason) {
  const reasons = [...new Set([...(row.verdict?.reasons ?? []), reason])];
  return { ...row, verdict: { ...row.verdict, eligible: false, reasons } };
}

function sameSellerSet(actual, expected) {
  const left = new Set(actual);
  const right = new Set(expected);
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function chooseForRecheck(rows) {
  return rows.filter((row) => row.verdict.eligible)
    .sort((a, b) => b.discountPct - a.discountPct || a.min - b.min || a.clusterKey.localeCompare(b.clusterKey))[0] ?? null;
}

/** Live recheck through the observed anonymous seller adapters, then rebuild the display cluster. */
export async function checkPackages({ today, anchorDate, read, collect = collectPackageData } = {}) {
  const observationDate = today ?? seoulToday();
  if (!validDate(observationDate)) throw new TypeError('today must be a valid YYYY-MM-DD date');
  const anchor = anchorDate ?? addDays(observationDate, ANCHOR_OFFSET_DAYS);
  if (!validDate(anchor)) throw new TypeError('anchorDate must be a valid YYYY-MM-DD date');
  if (typeof collect !== 'function') throw new TypeError('collect must be a function');
  const readImpl = read ?? createAnonymousReader();
  if (typeof readImpl !== 'function') throw new TypeError('read must be an anonymous adapter read function');
  const initialCollection = await runCollection(collect, {
    anchor, today: observationDate, windowDays: WINDOW_DAYS, destination: 'both',
    read: readImpl, readImpl, recheck: false,
  }, readImpl);
  const initialCheckedAt = new Date().toISOString();
  const initialProducts = Array.isArray(initialCollection?.products) ? initialCollection.products : [];
  const initialComparison = evaluateDisplayPackages(initialProducts, { anchor, windowDays: WINDOW_DAYS, checkedAt: initialCheckedAt });
  const selected = chooseForRecheck(initialComparison.rows);
  let comparison = initialComparison;
  let recheckCollection = null;
  let recheckedClusterKey = null;
  if (selected) {
    const sellerIds = [...new Set(selected.offers.map((offer) => offer.sellerId).filter(Boolean))];
    if (selected.destination && sellerIds.length >= 2) {
      recheckCollection = await runCollection(collect, {
        anchor, today: observationDate, windowDays: WINDOW_DAYS, destination: selected.destination,
        sellerIds, read: readImpl, readImpl, recheck: true, clusterKey: selected.clusterKey,
      }, readImpl);
    }
    const recheckCheckedAt = new Date().toISOString();
    const recheckProducts = Array.isArray(recheckCollection?.products) ? recheckCollection.products : [];
    const refreshed = evaluateDisplayPackages(recheckProducts, { anchor, windowDays: WINDOW_DAYS, checkedAt: recheckCheckedAt });
    const refreshedRow = refreshed.rows.find((row) => row.clusterKey === selected.clusterKey);
    const expectedSellers = selected.offers.map((offer) => offer.sellerId);
    const refreshedSellers = refreshedRow?.offers.map((offer) => offer.sellerId) ?? [];
    const matchingRecheck = refreshedRow && sameSellerSet(refreshedSellers, expectedSellers)
      && refreshedRow.offers.every((offer) => offer.verified.ok);
    const rows = initialComparison.rows.map((row) => {
      if (row.clusterKey === selected.clusterKey) {
        return matchingRecheck ? refreshedRow : demoteRow(row, 'live_recheck_failed');
      }
      return row.verdict.eligible ? demoteRow(row, 'live_recheck_pending') : row;
    }).sort((a, b) => a.min - b.min || a.clusterKey.localeCompare(b.clusterKey));
    comparison = {
      ...initialComparison,
      rows,
      eligibleCount: rows.filter((row) => row.verdict.eligible).length,
      recheckSelectedCount: refreshed.selectedCount,
    };
    if (matchingRecheck) recheckedClusterKey = selected.clusterKey;
  }

  const collections = [initialCollection, ...(recheckCollection ? [recheckCollection] : [])];
  const checkedAt = new Date().toISOString();
  const requests = collections.flatMap((collection) => collectionRequests(collection))
    .map(publicRequestSummary);
  const sellerResults = collections.flatMap((collection) => collection?.sellerResults ?? []);
  return {
    kind: 'package',
    priceTier: 'display',
    checkedAt,
    mode: 'anonymous-live-display',
    recheckedClusterKey,
    sellerResults: sellerResults.map((result) => ({
      sellerId: result.sellerId ?? result.sourceId ?? null,
      destination: result.destination ?? null,
      verdict: result.verdict ?? null,
      requestCount: Array.isArray(result.requests) ? result.requests.length : 0,
      productCount: Array.isArray(result.products) ? result.products.length : 0,
      error: text(result.error),
    })),
    requestCount: requests.length,
    requests,
    ...comparison,
  };
}

async function main() {
  try {
    const today = process.argv[2];
    const result = await checkPackages({ today });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ kind: 'package', priceTier: 'display', error: String(error?.message ?? error), rows: [], eligibleCount: 0 })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
