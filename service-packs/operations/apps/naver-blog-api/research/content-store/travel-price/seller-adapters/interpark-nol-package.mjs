import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';

const ORIGIN = 'https://tour.yanolja.com';
const INVENTORY_PATH = '/tour-api/inventories/nol-package-main/items';
const MIN_HOST_INTERVAL_MS = 2050;
let lastRequestAt = 0;

function assertObservedNolUrl(value, { product = false } = {}) {
  const url = new URL(value, ORIGIN);
  if (url.origin !== ORIGIN) throw new Error('NOL package URL must use the observed tour origin');
  if (product ? !/^\/package\/products\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) : url.pathname !== INVENTORY_PATH) {
    throw new Error('NOL package path is outside the observed read contract');
  }
  return url;
}

async function getPublic(url, { accept, fetchImpl = fetch, timeoutMs = 16000 } = {}) {
  const parsed = new URL(url);
  const delay = MIN_HOST_INTERVAL_MS - (Date.now() - lastRequestAt);
  if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
  lastRequestAt = Date.now();
  const checkedAt = new Date().toISOString();
  const response = await fetchImpl(parsed, {
    method: 'GET',
    redirect: 'manual',
    headers: {
      'accept-language': 'ko-KR,ko;q=0.9',
      accept,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  const metadata = {
    url: parsed.href,
    method: 'GET',
    checkedAt,
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  return { metadata, text: bytes.toString('utf8') };
}

export function parseInterparkNolPackageInventory(value, { baseUrl = `${ORIGIN}${INVENTORY_PATH}` } = {}) {
  const input = typeof value === 'string' ? JSON.parse(value) : value;
  if (!input || !Array.isArray(input.items)) throw new Error('invalid NOL package inventory response');
  const base = assertObservedNolUrl(baseUrl);
  const promotions = [];
  const products = [];
  for (const item of input.items) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.target !== 'string') continue;
    const target = new URL(item.target, base);
    const common = {
      inventoryId: item.id,
      label: typeof item.desc === 'string' ? item.desc : null,
      description: typeof item.detailedDesc === 'string' ? item.detailedDesc : null,
      imageUrl: typeof item.image === 'string' ? item.image : null,
      targetUrl: target.href,
    };
    if (target.origin === ORIGIN && /^\/package\/products\/[A-Za-z0-9_-]+\/?$/.test(target.pathname)) {
      products.push({ ...common, productId: target.pathname.split('/').filter(Boolean).at(-1) });
    } else {
      promotions.push(common);
    }
  }
  return { promotions, products, inventoryItemCount: input.items.length };
}

function parseJsonScript(document, selector) {
  const node = document.querySelector(selector);
  if (!node?.textContent) return null;
  try { return JSON.parse(node.textContent); } catch { return null; }
}

function compactConditions(coupon) {
  if (!coupon || typeof coupon !== 'object') return null;
  return {
    name: coupon.name ?? null,
    description: coupon.description ?? null,
    downloaded: coupon.downloaded ?? null,
    startsAt: coupon.publicationPeriod?.startAt ?? null,
    endsAt: coupon.publicationPeriod?.endAt ?? null,
    policy: coupon.discountPolicy && {
      type: coupon.discountPolicy.type ?? null,
      value: coupon.discountPolicy.value ?? null,
      maxDiscountAmountKrw: coupon.discountPolicy.maxDiscountAmount ?? null,
    },
    useConditions: Array.isArray(coupon.useConditions) ? coupon.useConditions.map(({ type, value }) => ({ type, value })) : [],
  };
}

export function parseInterparkNolPackageProduct(html, { url, checkedAt = new Date().toISOString() } = {}) {
  const productUrl = assertObservedNolUrl(url, { product: true });
  const document = new JSDOM(String(html)).window.document;
  const nextData = parseJsonScript(document, 'script#__NEXT_DATA__');
  const page = nextData?.props?.pageProps;
  if (!page || typeof page.productId !== 'string' || typeof page.productTitle !== 'string') {
    throw new Error('NOL package detail SSR data is missing product identity');
  }
  if (productUrl.pathname.split('/').filter(Boolean).at(-1) !== page.productId) {
    throw new Error('NOL package detail identity does not match its observed URL');
  }
  const jsonLd = [...document.querySelectorAll('script[type="application/ld+json"]')]
    .map(node => { try { return JSON.parse(node.textContent); } catch { return null; } })
    .find(value => value?.['@type'] === 'Product') ?? null;
  const priceQueries = (page.dehydratedState?.queries ?? [])
    .filter(query => ['product-prices', 'product-prices-initial'].includes(query.queryKey?.[0])
      && Array.isArray(query.state?.data?.itemGroups));
  const selectedQuantities = Array.isArray(page.selectedQuantities) ? page.selectedQuantities : [];
  const adultCount = selectedQuantities
    .filter(quantity => quantity?.ageType === 'ADULT' || quantity?.priceType === 'ADULT')
    .reduce((sum, quantity) => sum + (Number.isInteger(quantity.count) && quantity.count > 0 ? quantity.count : 0), 0);
  const uniqueGroups = new Map();
  for (const query of priceQueries) {
    const data = query.state.data;
    for (const group of data.itemGroups) {
      if (!group || typeof group !== 'object' || typeof group.id !== 'string') continue;
      const key = `${data.targetDate ?? ''}:${group.id}`;
      if (!uniqueGroups.has(key)) uniqueGroups.set(key, { data, group });
    }
  }
  const departures = [...uniqueGroups.values()].map(({ data, group }) => {
    const adult = (group.prices ?? []).find(price => price?.ageType === 'ADULT' || price?.priceType === 'ADULT') ?? null;
    const coupon = compactConditions(group.maxDiscountCoupon);
    const transports = (group.transports ?? []).map(item => ({ title: item.title ?? null, useDate: item.useDate ?? null }));
    const hotels = (group.hotels ?? []).map(item => ({ title: item.title ?? null, useDate: item.useDate ?? null, count: item.count ?? null }));
    return {
      departureDate: data.targetDate ?? null,
      departureGroupId: group.id,
      availability: group.status ?? null,
      saleable: group.saleable ?? null,
      passenger: { type: 'adult', count: adultCount || null, evidence: 'SSR selectedQuantities' },
      adultPriceKrw: adult?.saleAmount ?? null,
      adultDiscountedPriceKrw: adult?.discountedAmount ?? null,
      adultCouponAdjustedPriceKrw: adult?.discountedAmountWithCoupon ?? null,
      groupTotalPriceKrw: group.totalPrice ?? null,
      groupTotalDiscountedPriceKrw: group.totalDiscountedPrice ?? null,
      groupTotalCouponAdjustedPriceKrw: group.totalDiscountedPriceWithCoupon ?? null,
      baseDiscountAmountKrw: group.baseDiscountAmount ?? null,
      couponDiscountAmountKrw: group.couponDiscountAmount ?? adult?.couponDiscountAmount ?? null,
      discountRatePercent: group.discountRate ?? adult?.discountRate ?? null,
      singleSupplementKrw: group.singleChargeAmount ?? null,
      coupon,
      transportItems: transports,
      hotelItems: hotels,
      tourItems: (group.tours ?? []).map(item => ({ title: item.title ?? null, useDate: item.useDate ?? null })),
      taxesIncluded: null,
      feesIncluded: null,
      amountSemantics: 'SSR fields preserved by name; coupon adjusted prices require coupon eligibility and are not unconditional payable prices',
    };
  });
  const canonical = document.querySelector('link[rel="canonical"]')?.href ?? productUrl.href;
  if (new URL(canonical).origin !== ORIGIN || canonical !== productUrl.href) {
    throw new Error('NOL package canonical URL does not match the observed product URL');
  }
  const metaDescription = document.querySelector('meta[name="description"]')?.content ?? page.metaDescription ?? null;
  const nightsDays = metaDescription?.match(/(\d+)박\s*(\d+)일/);
  return {
    sellerId: 'interpark-package',
    seller: 'NOL Tour (Interpark migration)',
    productId: page.productId,
    title: page.productTitle,
    detailUrl: canonical,
    observedAt: checkedAt,
    metadataDescription: metaDescription,
    nights: nightsDays ? Number(nightsDays[1]) : null,
    days: nightsDays ? Number(nightsDays[2]) : null,
    advertisedAdultStartingPriceKrw: Number.isFinite(jsonLd?.offers?.price) ? jsonLd.offers.price : page.discountPrice ?? null,
    advertisedPriceLabel: jsonLd?.priceRange ?? null,
    currency: jsonLd?.offers?.priceCurrency ?? (page.discountPrice != null ? 'KRW' : null),
    selectedDepartureDate: page.selectedDepartureDate ?? null,
    selectedQuantities,
    keywords: Array.isArray(page.keywords) ? page.keywords : [],
    departures,
    coverage: {
      documentStatus: 'parsed SSR HTML',
      quoteSource: priceQueries.length ? 'Next.js dehydrated product-prices query' : 'no quote query observed',
      details: 'Only the server-rendered selected departure is returned; this client does not enumerate the date calendar.',
    },
  };
}

export async function fetchInterparkNolPackageInventory(options = {}) {
  const response = await getPublic(`${ORIGIN}${INVENTORY_PATH}`, {
    accept: 'application/json,*/*;q=0.8', ...options,
  });
  if (response.metadata.status !== 200 || !/application\/json/i.test(response.metadata.contentType)) {
    throw Object.assign(new Error('NOL package inventory did not return JSON HTTP 200'), { code: 'NOL_PACKAGE_INVENTORY_UNAVAILABLE', metadata: response.metadata });
  }
  return { ...response.metadata, ...parseInterparkNolPackageInventory(response.text) };
}

export async function fetchInterparkNolPackageProduct(url, options = {}) {
  const productUrl = assertObservedNolUrl(url, { product: true });
  const response = await getPublic(productUrl.href, {
    accept: 'text/html,application/xhtml+xml,*/*;q=0.8', ...options,
  });
  if (response.metadata.status !== 200 || !/text\/html/i.test(response.metadata.contentType)) {
    throw Object.assign(new Error('NOL package detail did not return HTML HTTP 200'), { code: 'NOL_PACKAGE_DETAIL_UNAVAILABLE', metadata: response.metadata });
  }
  return { metadata: response.metadata, product: parseInterparkNolPackageProduct(response.text, { url: productUrl.href, checkedAt: response.metadata.checkedAt }) };
}

export async function collectInterparkNolFeaturedPackages({ maxProducts = 10, fetchImpl = fetch } = {}) {
  if (!Number.isInteger(maxProducts) || maxProducts < 1 || maxProducts > 20) throw new Error('maxProducts must be an integer from 1 to 20');
  const inventory = await fetchInterparkNolPackageInventory({ fetchImpl });
  const products = [];
  for (const link of inventory.products.slice(0, maxProducts)) {
    products.push(await fetchInterparkNolPackageProduct(link.targetUrl, { fetchImpl }));
  }
  return {
    sourceId: 'interpark-package',
    checkedAt: inventory.checkedAt,
    execution: { mode: 'pure_http', browserUsed: false, auth: 'anonymous', credentialPropagation: 'not_applicable' },
    inventory: { status: inventory.status, itemCount: inventory.inventoryItemCount, productLinkCount: inventory.products.length, promotionCount: inventory.promotions.length },
    products: products.map(item => item.product),
    requests: [inventory, ...products.map(item => item.metadata)],
  };
}
