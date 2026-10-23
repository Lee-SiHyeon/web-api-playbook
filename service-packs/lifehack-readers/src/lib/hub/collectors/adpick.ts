import { adpickDigest, adpickObject, adpickObservedProductUrl, adpickProductUrl, adpickShortLink, AdpickServiceError } from '../../adpick-service-core';
import { cleanDisplayText } from '../row';
import { safeAdpickSdkDestination } from '../../source-destination';
import { classifyHubTitle } from '../category';
import type { HubItem } from '../types';

export const ADPICK_WRITER = 'adpick:sdk';
const text = (v: unknown): string | null => typeof v === 'string' && v.length <= 2000 ? cleanDisplayText(v) : null;
const money = (v: unknown): number | null => {
  if (typeof v !== 'number' && !(typeof v === 'string' && /^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(v))) return null;
  const value = Number(typeof v === 'string' ? v.replaceAll(',', '') : v);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
};

/** Live SDK returns an array of groups containing list.product_name/photo/mall/price_sale/price_org/commission/buyurl.
 * A buyurl without an embedded original URL identifies a provider listing, not a merchant SKU. */
export function mapAdpickSdk(body: unknown, surface: 'shopping' | 'hotdeal', now: Date): HubItem[] {
  const response = adpickObject(body), payload = response?.items ?? response?.json ?? body;
  const groups = Array.isArray(payload) ? payload : [payload];
  if (!groups.length || groups.length > 50) throw new AdpickServiceError('ADPICK_CATALOG_SCHEMA_INVALID');
  const rows: unknown[] = [];
  for (const group of groups) {
    const root = adpickObject(group);
    if (!root || !Array.isArray(root.list) || root.list.length > 500) throw new AdpickServiceError('ADPICK_CATALOG_SCHEMA_INVALID');
    rows.push(...root.list);
  }
  if (rows.length > 500) throw new AdpickServiceError('ADPICK_CATALOG_SCHEMA_INVALID');
  const observedAt = now.toISOString(), items: HubItem[] = [];
  for (const raw of rows) {
    const row = adpickObject(raw), title = text(row?.product_name), buyurl = safeAdpickSdkDestination(row?.buyurl) ?? adpickShortLink(row?.buyurl);
    if (!row || !title || !buyurl) throw new AdpickServiceError('ADPICK_CATALOG_ROW_INVALID');
    const id = adpickDigest(buyurl), rawTarget = new URL(buyurl).searchParams.get('url');
    const sourceUrl = adpickObservedProductUrl(rawTarget), issueTarget = adpickProductUrl(rawTarget);
    items.push({ id: `adpick:${id}`, kind: 'hotdeal', category: classifyHubTitle(title), title,
      store: text(row.mall_name) ?? text(row.mall), priceKrw: money(row.price_sale), shippingNote: null,
      imageUrl: adpickProductUrl(row.photo), source: 'adpick', sourceUrl: sourceUrl ?? buyurl,
      affiliateUrl: buyurl, targetUrl: issueTarget, postedAt: observedAt, observedAt,
      expiresAt: null, comments: null, votes: null, views: null, tags: ['애드픽', surface === 'hotdeal' ? '핫딜' : '추천상품'],
      summary: null, ended: false,
      facts: { adpick: { provider: 'adpick', listingId: id, merchantProductId: null, variantId: null, sellerId: null,
        merchantDomain: text(row.mall), originalProductUrl: sourceUrl, currency: 'KRW', shippingFeeKrw: null,
        eligibility: 'unverified', stockStatus: 'unknown', listPriceKrw: money(row.price_org),
        commission: typeof row.commission === 'string' || typeof row.commission === 'number' ? String(row.commission).slice(0, 64) : null,
        surface, observedAt, evidencePeriod: { startAt: observedAt, endAt: null } } },
    });
  }
  return items;
}
