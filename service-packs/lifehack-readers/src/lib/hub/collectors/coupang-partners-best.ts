// Coupang Partners catalog feeds, read inside the ALREADY-STORED partners web session on Vercel (owner 2026-10-11:
// replace the PC-only Goldbox importer for hub_items).
//
// Primary source — Goldbox discovery (verified live against the owner's session 2026-10-11):
//   GET https://partners.coupang.com/api/v1/discovery/goldbox?limit=100  headers: accept: application/json, lang: ko
//   → { rCode:'0', data:{ products:[…], shortUrl:'https://link.coupang.com/…', sharing:{…} } }
// The returned `shortUrl`/`sharing` fields are never requested — resolving a link.coupang.com URL can count as a
// click, so this module only reads `data.products`.
//
// Optional extra, OFF BY DEFAULT — the portal's best-category list:
//   POST https://partners.coupang.com/api/v1/search/best {page:{pageNumber:0,size:36},category:<id>}
// 2026-10-11 field note: a live check (same session, the portal's own `categoryId` key, real ids) got back
// {"rCode":"0","rMessage":""} with no products, so this path is kept only as a secondary top-up and is not
// relied on for coverage.
//
// Both HTTP calls happen in coupang-session-runtime.ts (readCoupangGoldboxFromVercel / readCoupangPartnersBestFromVercel);
// this module is pure (no network, no session) — it only maps the already-parsed JSON into HubItem drafts.
import { normalizeCoupangExactProductTarget } from '../../coupang-partner-link-issue-core';
import { guessCategory } from './parse-deal-title';
import type { HubCategory, HubItem } from '../types';

export interface CoupangBestCategoryDef {
  readonly id: string;
  readonly category: HubCategory;
  readonly label: string;
}

// Coupang Open API documented bestCategory ids. Kept only for the disabled best-list top-up (see module header);
// the live portal call for this path returned zero products on 2026-10-11, so this list is otherwise unused.
export const DEFAULT_COUPANG_BEST_CATEGORIES: readonly CoupangBestCategoryDef[] = [
  { id: '1001', category: 'fashion', label: '여성패션' },
  { id: '1006', category: 'food', label: '식품' },
  { id: '1008', category: 'living', label: '생활용품' },
  { id: '1011', category: 'digital', label: '가전디지털' },
  { id: '1004', category: 'beauty', label: '뷰티' },
  { id: '1019', category: 'pet', label: '반려동물용품' },
];

export const COUPANG_BEST_PAGE_SIZE = 36;
export const COUPANG_GOLDBOX_LIMIT = 100;
/** Per-list limit for /api/v1/discovery/<list> reads. Kept modest (not 100) because hub-coupang now reads up to
 * 9 lists sequentially through one session inside the 120s maxDuration route. */
export const COUPANG_DISCOVERY_LIMIT = 60;
export const COUPANG_BEST_LINK_ISSUE_CAP = 10;

export interface CoupangBestCategoryResponse {
  readonly category: string;
  readonly fetched: number;
  readonly error: string | null;
  readonly raw: unknown;
}

export interface CoupangBestCollectStat {
  readonly category: string;
  readonly fetched: number;
  readonly error: string | null;
}

export type CoupangHubItemDraft = Partial<HubItem> & Pick<HubItem, 'id' | 'kind' | 'title' | 'source' | 'sourceUrl' | 'postedAt'> & {
  readonly coupangIdentity: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
    if (typeof value === 'string') {
      const digits = value.replace(/[^\d]/g, '');
      if (digits) {
        const parsed = parseInt(digits, 10);
        if (Number.isSafeInteger(parsed)) return parsed;
      }
    }
  }
  return null;
}

const ID = /^[1-9]\d{0,19}$/;

/** A productId/itemId/vendorItemId field as the goldbox API sends it: a JSON number, or occasionally a numeric string. */
function toIdString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && ID.test(value)) return value;
  return null;
}

/** http(s) or protocol-relative coupangcdn.com image → https; anything else not on that CDN is left as-is (or dropped if not https). */
export function upgradeCoupangImageUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  let url = value.trim();
  if (url.startsWith('//')) url = `https:${url}`;
  if (url.startsWith('http://')) {
    try {
      const parsed = new URL(url);
      if (/(^|\.)coupangcdn\.com$/i.test(parsed.hostname)) {
        parsed.protocol = 'https:';
        url = parsed.href;
      }
    } catch {
      return null;
    }
  }
  return /^https:\/\//i.test(url) ? url : null;
}

// --- Goldbox (primary source) ---------------------------------------------------------------

/**
 * Maps one raw goldbox product (documented shape, verified live 2026-10-11) to a HubItem draft.
 * Skips adult, travel, and explicitly-invalid products; returns null when the exact product identity or a
 * title can't be established. Never reads or requests the response's shortUrl/sharing fields.
 */
export function mapCoupangGoldboxProduct(raw: unknown, now: Date): CoupangHubItemDraft | null {
  if (!isRecord(raw)) return null;
  if (raw.isAdult === true || raw.travel === true || raw.valid === false) return null;

  const productId = toIdString(raw.productId);
  const itemId = toIdString(raw.itemId);
  const vendorItemId = toIdString(raw.vendorItemId);
  if (!productId || !itemId || !vendorItemId) return null;
  const target = normalizeCoupangExactProductTarget(
    `https://www.coupang.com/vp/products/${productId}?itemId=${itemId}&vendorItemId=${vendorItemId}`,
  );
  if (!target) return null;

  const title = firstString(raw.title);
  if (!title) return null;

  const price = firstNumber(raw.discountedPrice, raw.salesPrice);
  const imageUrl = upgradeCoupangImageUrl(firstString(raw.image, raw.rawImage));
  const deliveryChargeType = Array.isArray(raw.deliveryChargeType) ? raw.deliveryChargeType : [];
  const rocket = deliveryChargeType.includes('ROCKET');
  const freeShipping = raw.isFreeShipping === true;
  const discount = firstNumber(raw.discountRate);

  const tags: string[] = [];
  if (discount && discount > 0 && discount <= 100) tags.push(`${discount}%`);
  if (rocket) tags.push('로켓배송');

  return {
    id: `coupang:${target.productId}`,
    kind: 'hotdeal',
    category: guessCategory(title),
    title: title.slice(0, 300),
    store: '쿠팡',
    priceKrw: price,
    shippingNote: freeShipping ? '무료배송' : null,
    imageUrl,
    source: 'coupang',
    sourceUrl: target.productUrl,
    affiliateUrl: null,
    postedAt: now.toISOString(),
    expiresAt: null,
    comments: null,
    votes: null,
    views: null,
    tags,
    summary: null,
    ended: raw.isSoldOut === true,
    coupangIdentity: target.identity,
  };
}

export interface CoupangGoldboxCollectResult {
  readonly items: CoupangHubItemDraft[];
  readonly fetched: number;
  readonly skipped: number;
}

/** Pure mapping pass over one cron run's goldbox product array. Never touches the network or the session. */
export function collectCoupangGoldbox(rawProducts: readonly unknown[], now: Date = new Date()): CoupangGoldboxCollectResult {
  const items: CoupangHubItemDraft[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const raw of rawProducts) {
    const mapped = mapCoupangGoldboxProduct(raw, now);
    if (!mapped) {
      skipped += 1;
      continue;
    }
    if (seen.has(mapped.id)) continue; // duplicate product id within the same page: keep the first
    seen.add(mapped.id);
    items.push(mapped);
  }
  return { items, fetched: rawProducts.length, skipped };
}

// --- Coupang Partners discovery lists (2026-10-11, owner: "Coupang has more than goldbox") -------------------
// goldbox/most-discounted/most-sold/most-conversion/rocket-fresh/fashion/high-commission/top-commission/
// retail-clearance all share goldbox's exact product shape (verified live 2026-10-11), so they reuse
// mapCoupangGoldboxProduct unchanged; the only new behavior is merging the same product across lists and adding
// each list's display tag.

export interface CoupangDiscoveryListRaw {
  readonly list: string;
  /** Display tag added to every item this list contributes (source-policy.ts COUPANG_DISCOVERY_LISTS). */
  readonly tag: string;
  readonly products: readonly unknown[];
}

/**
 * Pure mapping pass over one cron run's discovery lists. The SAME product can appear in several lists (e.g.
 * goldbox and most-sold); it keeps one row (first list's mapped fields win for everything except tags) with the
 * union of every list's tag it appeared in, capped at 12 like every other HubItem.tags. Never touches the
 * network or the session.
 */
export function collectCoupangDiscovery(lists: readonly CoupangDiscoveryListRaw[], now: Date = new Date()): CoupangGoldboxCollectResult {
  const byId = new Map<string, CoupangHubItemDraft>();
  let fetched = 0;
  let skipped = 0;
  for (const { tag, products } of lists) {
    fetched += products.length;
    for (const raw of products) {
      const mapped = mapCoupangGoldboxProduct(raw, now);
      if (!mapped) {
        skipped += 1;
        continue;
      }
      const existing = byId.get(mapped.id);
      const tags = [...new Set([...(existing?.tags ?? mapped.tags ?? []), tag])].slice(0, 12);
      byId.set(mapped.id, existing ? { ...existing, tags } : { ...mapped, tags });
    }
  }
  return { items: [...byId.values()], fetched, skipped };
}

/** Every attempted list must succeed. A legitimate empty list is success, while a single failed list
 * makes the combined receipt partial even if another list returned products. Persistence is checked separately. */
export function summarizeCoupangDiscoveryRun(
  results: readonly { list: string; fetched: number; error: string | null }[],
): { fetched: number; blocked: boolean; error: string | null } {
  const fetched = results.reduce((sum, r) => sum + r.fetched, 0);
  const authStop = results.find((r) => r.error && /^COUPANG_(REAUTH_REQUIRED|AUTH_FORBIDDEN|AUTH_THROTTLED|HTTP_ACCESS_DENIED)$/.test(r.error));
  if (authStop) return { fetched, blocked: true, error: authStop.error };
  const failure = results.find((r) => r.error);
  if (failure) return { fetched, blocked: false, error: failure.error };
  if (results.length === 0) return { fetched, blocked: false, error: 'COUPANG_DISCOVERY_NOT_ATTEMPTED' };
  return { fetched, blocked: false, error: null };
}

// --- Best-category list (optional extra, off by default — see module header) ---------------

function resolveBestListTarget(row: Record<string, unknown>): ReturnType<typeof normalizeCoupangExactProductTarget> {
  const productId = firstString(row.productId, row.pageKey);
  const itemId = firstString(row.itemId);
  const vendorItemId = firstString(row.vendorItemId);
  if (productId && itemId && vendorItemId && ID.test(productId) && ID.test(itemId) && ID.test(vendorItemId)) {
    const direct = normalizeCoupangExactProductTarget(
      `https://www.coupang.com/vp/products/${productId}?itemId=${itemId}&vendorItemId=${vendorItemId}`,
    );
    if (direct) return direct;
  }
  const directUrl = firstString(row.detailUrl, row.productUrl, row.landingUrl, row.url, row.link);
  if (!directUrl) return null;
  const canonical = canonicalCoupangProductUrl(directUrl);
  return canonical ? normalizeCoupangExactProductTarget(canonical) : null;
}

/** Strips a detail/landing URL (which may carry tracking query params) down to the exact www.coupang.com product identity, if present. */
function canonicalCoupangProductUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'www.coupang.com') return null;
  const match = url.pathname.match(/^\/vp\/products\/([1-9]\d{0,19})$/);
  const itemId = url.searchParams.get('itemId');
  const vendorItemId = url.searchParams.get('vendorItemId');
  if (!match || !itemId || !vendorItemId || !ID.test(itemId) || !ID.test(vendorItemId)) return null;
  return `https://www.coupang.com/vp/products/${match[1]}?itemId=${itemId}&vendorItemId=${vendorItemId}`;
}

/** Maps one raw "best" list product (unknown exact shape; this path returned zero products in the 2026-10-11 check) to a HubItem draft. */
export function mapCoupangBestProduct(raw: unknown, category: HubCategory, now: Date): CoupangHubItemDraft | null {
  if (!isRecord(raw)) return null;
  const target = resolveBestListTarget(raw);
  if (!target) return null;

  const title = firstString(raw.productTitle, raw.productName, raw.title, raw.name);
  if (!title) return null;

  const price = firstNumber(raw.salePrice, raw.finalPrice, raw.price, raw.productPrice, raw.discountPrice, raw.couponPrice);
  const imageUrl = upgradeCoupangImageUrl(
    firstString(raw.productImageUrl, raw.productImage, raw.imageUrl, raw.thumbnailUrl, raw.image),
  );
  const rocketCandidates = [raw.deliveryBadgeName, raw.badge, raw.rocketType, raw.deliveryType, raw.badgeName];
  const rocket = rocketCandidates.some((value) => typeof value === 'string' && /로켓/.test(value))
    || raw.isRocket === true || raw.rocketDelivery === true;
  const discount = firstNumber(raw.discountRate, raw.instantDiscountRate, raw.salePercentage, raw.discountPercentage);

  const tags: string[] = [];
  if (rocket) tags.push('로켓배송');
  if (discount && discount > 0 && discount <= 100) tags.push(`-${discount}%`);

  return {
    id: `coupang:${target.productId}`,
    kind: 'hotdeal',
    category,
    title: title.slice(0, 300),
    store: '쿠팡',
    priceKrw: price,
    shippingNote: rocket ? '로켓배송' : null,
    imageUrl,
    source: 'coupang',
    sourceUrl: target.productUrl,
    affiliateUrl: null,
    postedAt: now.toISOString(),
    expiresAt: null,
    comments: null,
    votes: null,
    views: null,
    tags,
    summary: null,
    ended: false,
    coupangIdentity: target.identity,
  };
}

function extractProductList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!isRecord(raw)) return [];
  for (const key of ['products', 'productList', 'list', 'items', 'contents', 'data']) {
    const value = raw[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

/** Pure mapping pass over one cron run's per-category best-list responses. Never touches the network or the session. */
export function collectCoupangPartnersBest(
  responses: readonly CoupangBestCategoryResponse[],
  categoryDefs: readonly CoupangBestCategoryDef[] = DEFAULT_COUPANG_BEST_CATEGORIES,
  now: Date = new Date(),
): { items: CoupangHubItemDraft[]; stats: CoupangBestCollectStat[] } {
  const byId = new Map(categoryDefs.map((def) => [def.id, def]));
  const items: CoupangHubItemDraft[] = [];
  const stats: CoupangBestCollectStat[] = [];
  const seen = new Set<string>();

  for (const response of responses) {
    const def = byId.get(response.category);
    let fetched = 0;
    if (def && !response.error) {
      for (const rawProduct of extractProductList(response.raw)) {
        const mapped = mapCoupangBestProduct(rawProduct, def.category, now);
        if (!mapped) continue;
        fetched += 1;
        if (seen.has(mapped.id)) continue; // same product surfaced by more than one category: keep the first
        seen.add(mapped.id);
        items.push(mapped);
      }
    }
    stats.push({ category: response.category, fetched, error: response.error });
  }
  return { items, stats };
}

// --- shared session/route helpers ------------------------------------------------------------

export type CoupangSessionBlockStatus = 'blocked' | 'busy' | 'ready';

/** Pure decision for the cron route: never throws, never calls the network; used for the "session not ready" exit. */
export function describeCoupangSessionBlock(
  sessionStatus: 'unconfigured' | 'ready' | 'hold' | 'reauth_required' | 'disabled' | null,
  hasCredential: boolean,
): { status: CoupangSessionBlockStatus; holdCode: string | null } {
  if (sessionStatus === 'ready' && hasCredential) return { status: 'ready', holdCode: null };
  if (sessionStatus === null) return { status: 'blocked', holdCode: 'SESSION_UNCONFIGURED' };
  if (sessionStatus === 'hold' || sessionStatus === 'reauth_required' || sessionStatus === 'disabled' || !hasCredential) {
    return { status: 'blocked', holdCode: sessionStatus.toUpperCase() };
  }
  return { status: 'blocked', holdCode: 'SESSION_UNCONFIGURED' };
}

/**
 * Runs `issueOnce` at most `maxAttempts` times (the task's "at most 10 new links per run"), stopping as soon as a
 * call reports nothing left to do or asks to stop (session held, auth stopped, etc.). Never re-implements the
 * issuance path itself — the caller passes the EXISTING issueLatestCoupangPartnerLinkFromVercel(scope, claim) in.
 */
export async function runBoundedCoupangLinkIssuance(
  maxAttempts: number,
  issueOnce: () => Promise<{ issued: boolean; stop: boolean }>,
): Promise<{ attempts: number; issued: number }> {
  let attempts = 0;
  let issued = 0;
  for (let i = 0; i < maxAttempts; i += 1) {
    attempts += 1;
    let result: { issued: boolean; stop: boolean };
    try {
      result = await issueOnce();
    } catch {
      break;
    }
    if (result.issued) issued += 1;
    if (result.stop) break;
  }
  return { attempts, issued };
}
