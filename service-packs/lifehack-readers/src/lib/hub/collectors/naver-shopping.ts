import { HubItem } from '../types';
import { guessCategory } from './parse-deal-title';
import { fetchCollectorResponse } from './fetch-response';

const PROMOTION_URL = 'https://shopping.naver.com/promotion';
const API_ORIGIN = 'https://vertical-api.shopping.naver.com';
const V3_PATH = '/v3/web/v1/waffle-promotion';
const MAX_REQUESTS = 25;
const REQUEST_TIMEOUT_MS = 8000;
const MAX_PRODUCTS = 150;
const MAX_PAGES_PER_GROUP = 2;
const LAYER_BATCH_SIZE = 3;

interface CollectorResult {
  items: Array<Partial<HubItem>>;
  fetched: number;
  blocked: boolean;
  error: string | null;
}

interface TabInfo {
  tabId: string;
  title: string;
}

interface LayerInfo {
  layoutId: string;
  layerCode: string;
  bindStatus: string;
  meta?: { title?: string };
  blocks?: BlockInfo[];
}

interface BlockInfo {
  layoutId: string;
  itemGroups?: ItemGroupInfo[];
}

interface ItemGroupInfo {
  id: string;
  exposureCondition?: {
    exposureStartAt?: string;
    exposureEndAt?: string;
  };
  productElements?: ProductElement[];
}

interface ProductElement {
  dataConditionType: string;
  paginationInfoType?: string;
  paginationInfo?: {
    pageNo?: number;
    pageSize?: number;
    hasNext?: boolean;
    totalCount?: number;
  };
  products?: ProductCard[];
}

interface ProductCard {
  channelProductId: number;
  productMeta?: {
    name?: string;
    imageUrl?: string;
    salePrice?: number;
  };
  benefitAdditional?: {
    discountedPrice?: number;
    discountedRatio?: number;
  };
  benefitMeta?: {
    dispDiscountedSalePrice?: number;
    dispDiscountedRatio?: number;
  };
  productAdditional?: {
    landingUrl?: string;
    mobileLandingUrl?: string;
    saleEndDate?: string;
    isSoldOut?: boolean;
    isComingSoon?: boolean;
  };
  deliveryMeta?: {
    isFreeDelivery?: boolean;
    deliveryFeeType?: string;
    baseFee?: number;
  };
  deliveryAdditional?: {
    deliveryFee?: number;
  };
}

interface ParsedProduct {
  id: string;
  title: string;
  landingUrl: string;
  imageUrl: string | null;
  salePrice: number;
  discountedPrice: number | null;
  discountRatio: number | null;
  isDeliveryFree: boolean | null;
  deliveryFee: number | null;
  isSoldOut: boolean;
  saleEndDate: string | null;
  campaignEndAt: string | null;
}

/**
 * Parse __NEXT_DATA__ from Naver promotion page HTML to extract tabList (WAFFLE tabs).
 */
function parseManifest(html: string): TabInfo[] {
  try {
    const match = html.match(/<script\b[^>]*id\s*=\s*["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!match) return [];

    const data = JSON.parse(match[1]);
    const tabList = data?.props?.pageProps?.tabList;
    if (!Array.isArray(tabList)) return [];

    const tabs: TabInfo[] = [];
    for (const tab of tabList) {
      if (tab?.tabType !== 'WAFFLE' || tab?.version !== 'V3') continue;
      const tabId = tab.uid ?? tab.id;
      if (typeof tabId === 'string' && typeof tab.title === 'string') {
        tabs.push({ tabId, title: tab.title });
      }
    }
    return tabs;
  } catch {
    return [];
  }
}

/**
 * Make a fetch request with timeout and error handling.
 */
async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  options: RequestInit = {},
  requestCount: { current: number },
  format: 'json' | 'text' = 'json',
): Promise<{ data: any; status: number } | null> {
  if (requestCount.current >= MAX_REQUESTS) {
    return null;
  }

  try {
    requestCount.current++;
    const response = await fetchCollectorResponse(fetchImpl, url, {
      ...options,
      headers: {
        accept: format === 'json' ? 'application/json' : 'text/html',
        'accept-language': 'ko-KR',
        ...options.headers,
      },
    }, { timeoutMs: REQUEST_TIMEOUT_MS });

    if (!response.ok) {
      return { data: null, status: response.status };
    }

    const contentType = response.headers.get('content-type') || '';
    if (format === 'json' && !/\bjson\b/i.test(contentType)) {
      return { data: null, status: response.status };
    }

    const text = new TextDecoder().decode(response.body);
    const data = format === 'json' ? JSON.parse(text) : text;
    return { data, status: response.status };
  } catch {
    return null;
  }
}

/**
 * Walk a JSON object recursively to find all values matching a predicate.
 */
function findAll<T>(obj: any, predicate: (v: any) => v is T): T[] {
  const results: T[] = [];

  function walk(value: any): void {
    if (value && typeof value === 'object') {
      if (predicate(value)) {
        results.push(value);
      }
      for (const child of Object.values(value)) {
        walk(child);
      }
    }
  }

  walk(obj);
  return results;
}

/**
 * Extract item groups from layers that have productElements with products.
 */
function findProductGroups(layers: LayerInfo[]): Array<{ groupId: string; itemGroup: ItemGroupInfo; endpoint: string; campaignEndAt: string | null }> {
  const groups: Array<{ groupId: string; itemGroup: ItemGroupInfo; endpoint: string; campaignEndAt: string | null }> = [];

  for (const layer of layers) {
    if (!layer.blocks) continue;
    for (const block of layer.blocks) {
      if (!block.itemGroups) continue;
      for (const group of block.itemGroups) {
        if (!group.id || !group.productElements) continue;
        for (const element of group.productElements) {
          if (!element.dataConditionType) continue;
          const endpoint = { MANUAL: 'manual-products', AUTO_SORT: 'auto-sort-products' }[element.dataConditionType];
          if (!endpoint) continue;
          groups.push({
            groupId: group.id,
            itemGroup: group,
            endpoint,
            campaignEndAt: group.exposureCondition?.exposureEndAt ?? null,
          });
        }
      }
    }
  }

  return groups;
}

/**
 * Parse a product card and extract the relevant fields.
 */
function parseProduct(card: ProductCard, campaignEndAt: string | null): ParsedProduct | null {
  const id = String(card.channelProductId);
  const name = card.productMeta?.name;
  const landingUrl = card.productAdditional?.landingUrl ?? card.productMeta?.imageUrl;

  if (!id || !name || !landingUrl) return null;

  // Validate URL is HTTPS
  if (!landingUrl.startsWith('https://')) return null;

  const imageUrl = card.productMeta?.imageUrl;
  if (imageUrl && !imageUrl.startsWith('https://')) return null;

  const salePrice = card.productMeta?.salePrice;
  if (typeof salePrice !== 'number') return null;

  const discountedPrice = card.benefitAdditional?.discountedPrice ?? card.benefitMeta?.dispDiscountedSalePrice ?? null;
  const discountRatio = card.benefitAdditional?.discountedRatio ?? card.benefitMeta?.dispDiscountedRatio ?? null;
  const isDeliveryFree = card.deliveryMeta?.isFreeDelivery ?? null;
  const deliveryFee = card.deliveryAdditional?.deliveryFee ?? card.deliveryMeta?.baseFee ?? null;

  return {
    id,
    title: name,
    landingUrl,
    imageUrl: imageUrl ?? null,
    salePrice,
    discountedPrice,
    discountRatio,
    isDeliveryFree,
    deliveryFee,
    isSoldOut: card.productAdditional?.isSoldOut ?? false,
    saleEndDate: card.productAdditional?.saleEndDate ?? null,
    campaignEndAt,
  };
}

/**
 * Format delivery note from product data.
 */
function formatShippingNote(product: ParsedProduct): string | null {
  if (product.isDeliveryFree) {
    return '무료배송';
  }
  if (product.deliveryFee !== null && product.deliveryFee > 0) {
    return `배송비 ${product.deliveryFee.toLocaleString('en-US')}원`;
  }
  return null;
}

/**
 * Collect hotdeal items from Naver 오늘끝딜 (V3 API).
 */
export async function collectNaverShopping(
  fetchImpl: typeof fetch,
  userAgent: string,
  now: Date,
): Promise<CollectorResult> {
  const result: CollectorResult = {
    items: [],
    fetched: 0,
    blocked: false,
    error: null,
  };

  const requestCount = { current: 0 };

  try {
    // Fetch promotion page HTML
    const htmlResponse = await fetchWithTimeout(
      fetchImpl,
      PROMOTION_URL,
      {
        headers: { 'User-Agent': userAgent },
      },
      requestCount,
      'text',
    );

    if (!htmlResponse) {
      result.error = 'Failed to fetch promotion page';
      return result;
    }

    if (htmlResponse.status === 403 || htmlResponse.status === 429) {
      result.blocked = true;
      result.error = `HTTP ${htmlResponse.status}`;
      return result;
    }

    if (htmlResponse.status !== 200) {
      result.error = `HTTP ${htmlResponse.status}`;
      return result;
    }

    // Parse manifest to get tabs
    const html = htmlResponse.data as string;

    const tabs = parseManifest(html);
    if (!tabs.length) {
      result.error = 'No WAFFLE tabs found in promotion page';
      return result;
    }

    // Collect products from each tab
    const products = new Map<string, ParsedProduct>();
    const nowIso = now.toISOString();

    for (const tab of tabs) {
      if (products.size >= MAX_PRODUCTS) break;

      // Fetch tab page
      const tabPageUrl = `${API_ORIGIN}${V3_PATH}/pages/${tab.tabId}?exposureDevice=WEB&serviceCode=WAFFLE_PROMOTION`;
      const tabPageResp = await fetchWithTimeout(fetchImpl, tabPageUrl, {}, requestCount);

      if (!tabPageResp || tabPageResp.status !== 200 || !tabPageResp.data) continue;

      const layers = tabPageResp.data.layers;
      if (!Array.isArray(layers)) continue;

      // Batch fetch DEFERRED layers
      const deferredLayers = layers.filter((l: LayerInfo) => l.bindStatus === 'DEFERRED');
      const boundLayers: LayerInfo[] = layers.filter((l: LayerInfo) => l.bindStatus === 'BOUND');

      for (let i = 0; i < deferredLayers.length; i += LAYER_BATCH_SIZE) {
        if (requestCount.current >= MAX_REQUESTS) break;

        const batch = deferredLayers.slice(i, i + LAYER_BATCH_SIZE);
        const layerCodes = batch.map((l: LayerInfo) => l.layerCode).join(',');
        const layerBatchUrl = `${API_ORIGIN}${V3_PATH}/pages/${tab.tabId}/layers?exposureDevice=WEB&layerCodes=${encodeURIComponent(layerCodes)}&serviceCode=WAFFLE_PROMOTION`;

        const layerResp = await fetchWithTimeout(fetchImpl, layerBatchUrl, {}, requestCount);
        if (layerResp && layerResp.status === 200 && Array.isArray(layerResp.data)) {
          boundLayers.push(...layerResp.data);
        }
      }

      // Find product groups
      const productGroups = findProductGroups(boundLayers);

      for (const group of productGroups) {
        if (products.size >= MAX_PRODUCTS || requestCount.current >= MAX_REQUESTS) break;

        let pageNum = 1;
        let hasMore = true;

        while (hasMore && pageNum <= MAX_PAGES_PER_GROUP && products.size < MAX_PRODUCTS) {
          if (requestCount.current >= MAX_REQUESTS) break;

          const productUrl = `${API_ORIGIN}${V3_PATH}/item-groups/${group.groupId}/paginated-elements/${group.endpoint}?pageNo=${pageNum}&pageSize=20${group.endpoint === 'auto-sort-products' ? '&sortType=VIEW' : ''}`;

          const productResp = await fetchWithTimeout(fetchImpl, productUrl, {}, requestCount);
          if (!productResp || productResp.status !== 200 || !productResp.data) break;

          const productCards = productResp.data.products;
          if (!Array.isArray(productCards) || !productCards.length) break;

          for (const card of productCards) {
            if (products.size >= MAX_PRODUCTS) break;
            const parsed = parseProduct(card, group.campaignEndAt);
            if (parsed) {
              products.set(parsed.id, parsed);
            }
          }

          hasMore = productResp.data.paginationInfo?.hasNext ?? false;
          pageNum++;
        }
      }
    }

    if (!products.size) {
      result.error = 'No products found';
      return result;
    }

    // Convert products to HubItem rows
    for (const product of products.values()) {
      const displayPrice = product.discountedPrice ?? product.salePrice;
      const tags: string[] = [];

      if (product.discountRatio && product.discountRatio > 0) {
        tags.push(`${product.discountRatio}%`);
      }

      const row: Partial<HubItem> = {
        id: `naver_shopping:${product.id}`,
        kind: 'hotdeal',
        category: guessCategory(product.title),
        title: product.title,
        store: '네이버',
        priceKrw: displayPrice,
        shippingNote: formatShippingNote(product),
        imageUrl: product.imageUrl,
        source: 'naver_shopping',
        sourceUrl: product.landingUrl,
        affiliateUrl: null,
        postedAt: nowIso,
        expiresAt: product.campaignEndAt ? new Date(product.campaignEndAt).toISOString() : nowIso,
        comments: null,
        votes: null,
        views: null,
        tags,
        summary: null,
        ended: product.isSoldOut,
      };

      result.items.push(row);
    }

    result.fetched = products.size;
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : 'unknown error';
    return result;
  }
}
