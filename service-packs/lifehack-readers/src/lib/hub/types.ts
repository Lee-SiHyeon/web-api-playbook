// Hub feed contract (owner 2026-10-11: lifehackailab.com becomes the traffic hub for every ontology — "최소한 hotdeal.zip
// 정도까진"). One row type for every vertical so the home feed, category pages, search and alerts share one query path.
// Rows come from Vercel Cron collectors (public RSS/APIs) and from the PC ontology importers; pages only read.

import type { CreatorSignalFacts } from '../creator-data/model';
import type { CardIssuer, CardDealObservation } from './card-deals/types';

export const HUB_KINDS = ['hotdeal', 'travel', 'benefit', 'opportunity', 'ranking', 'trend', 'news'] as const;
export type HubKind = (typeof HUB_KINDS)[number];

/** Category chips on the feed (hotdeal.zip-style). `etc` catches anything unclassified. */
export const HUB_CATEGORIES = [
  { id: 'food', label: '식품' }, { id: 'living', label: '생활용품' }, { id: 'digital', label: '가전·디지털' },
  { id: 'pc', label: 'PC·부품' }, { id: 'game', label: '게임' }, { id: 'fashion', label: '의류·잡화' },
  { id: 'beauty', label: '뷰티' }, { id: 'baby', label: '육아' }, { id: 'pet', label: '반려동물' },
  { id: 'travel', label: '여행' }, { id: 'coupon', label: '쿠폰·상품권' }, { id: 'etc', label: '기타' },
] as const;
export type HubCategory = (typeof HUB_CATEGORIES)[number]['id'];

/** Where a row was found. Community boards are shown as a source badge, like hotdeal.zip. */
export type HubSource =
  // platform deal feeds — the main feed; each carries our affiliate link when one exists
  | 'coupang' | 'naver_shopping' | 'toss' | 'eleventh' | 'adpick'
  | 'card_kb' | 'card_shinhan' | 'card_samsung' | 'card_hyundai' | 'card_lotte' | 'card_hana' | 'card_woori' | 'card_bc' | 'card_nh'
  // community boards — the 커뮤니티 탭
  | 'ppomppu' | 'quasarzone' | 'ruliweb' | 'clien' | 'fmkorea' | 'arca' | 'eomisae'
  | 'lifehack' // our own ontology collectors (price history, travel, benefits, rankings, …)
  | 'gov' | 'revu' | 'wevity' | 'trafficscent' | 'news'
  // ontology verticals ported to Vercel Cron (owner 2026-10-11): travel, ranking, benefit, opportunity, trend, news
  | 'tripcom' | 'yeogi' | 'nol' | 'ttang' | 'myrealtrip' | 'myrealtrip_partner' | 'naver_travel'
  | 'naver_overseas_hotel' | 'agoda_hotel'
  | 'hwahae' | 'oliveyoung_global'
  | 'applyhome' | 'lh' | 'kshoppingfesta' | 'foodnuri'
  | 'googletrends' | 'tiktok_trends' | 'meta_newsroom' | 'threads_public' | 'threads_trending'
  | 'openai' | 'googleai' | 'deepmind' | 'anthropic' | 'deepseek' | 'qwen';

export type TravelRateOption = {
  optionId: string | null;
  providerCode: string | null;
  currencyCode: string | null;
  amount: number | null;
  basis: 'per_room_per_night' | 'per_booking' | 'unknown';
  priceType: 'inclusive' | 'exclusive' | 'listed' | 'unknown';
  crossedOutAmount: number | null;
  displayAmountUnknownCurrency: number | null;
  originalDisplayAmountUnknownCurrency: number | null;
  availableRooms: number | null;
  promoEligible: boolean | null;
  discountLabels: string[];
};

export const PLATFORM_SOURCES: readonly HubSource[] = ['coupang', 'naver_shopping', 'toss', 'eleventh', 'adpick', 'card_samsung', 'card_shinhan'];
export const COMMUNITY_SOURCES: readonly HubSource[] = ['ppomppu', 'quasarzone', 'ruliweb', 'clien', 'fmkorea', 'arca', 'eomisae'];

/** Source facts remain separate from display text. A missing value means it was not verified. */
export type HubFacts = {
  cardDeal?: {
    issuer: CardIssuer; surface: CardDealObservation['surface']; listingId: string;
    productId: string | null; optionId: string | null; sellerId: string | null;
    currency: 'KRW'; listPriceKrw: number | null; shippingFeeKrw: number | null;
    eligibility: CardDealObservation['eligibility']; conditionalPrices: NonNullable<CardDealObservation['conditionalPrices']>;
    stockStatus: CardDealObservation['stockStatus']; startsAt: string | null; expiresAt: string | null;
    publishedStartsAt: string | null; publishedExpiresAt: string | null;
    observedAt: string; evidencePeriod: { startAt: string; endAt: string | null }; completeCatalog: false;
  };
  coupangGoldbox?: {
    provider: 'coupang_mlp_goldbox_widget'; productId: string; itemId: string; vendorItemId: string;
    sellerId: null; currency: 'KRW'; generalPriceKrw: number | null; originalPriceKrw: number | null;
    advertisedPrice: { amountKrw: number; label: string; conditional: boolean | null; eligibilityVerified: false } | null;
    priceBasis: 'widget_final_price_field'; shippingFeeKrw: null; eligibility: 'unverified';
    stockStatus: 'in_stock' | 'sold_out' | 'unknown'; observedAt: string;
    evidencePeriod: { startAt: string; endAt: null }; catalogScanComplete: boolean; completeCatalog: false;
  };
  coupangRetail?: { query: string; priceBasis: 'rsc_displayed_sales_price' | 'html_displayed_sales_price';
    priceLabel?: string | null; accountApplied: false;
    sponsored: boolean; completeCatalog: false };
  adpick?: {
    provider: 'adpick'; listingId: string; merchantProductId: string | null; variantId: string | null; sellerId: string | null;
    merchantDomain: string | null; originalProductUrl: string | null; currency: 'KRW'; shippingFeeKrw: number | null;
    eligibility: 'unverified'; stockStatus: 'unknown'; listPriceKrw: number | null; commission: string | null;
    surface: 'shopping' | 'hotdeal'; observedAt: string; evidencePeriod: { startAt: string; endAt: string | null };
  };
  partnerSearch?: {
    provider: 'coupang' | 'naver_connect'; productId: string;
    itemId: string | null; vendorItemId: string | null; affiliateProductId: string | null;
    sellerId: string | null; sellerName: string | null; currency: 'KRW'; shippingFeeKrw: number | null;
    category?: { id: string | null; name: string | null; hubCategory: HubCategory };
    eligibility: 'unverified'; stockStatus: 'in_stock' | 'unknown'; observedAt: string;
    evidencePeriod: { startAt: string; endAt: string | null };
  };
  toss?: {
    provider: 'toss_sharelink'; tacaItemId: string; tacaId: string | null; productId: string | null;
    stockId: string | null; merchantId: string | null; sellerName: string | null;
    currency: 'KRW'; priceKind: string | null; shippingFeeKrw: number | null;
    /** Toss detail fee before a free-shipping threshold, the threshold, and when they were read (2026-10-18). */
    displayedShippingFeeKrw?: number | null; freeShippingThresholdKrw?: number | null; shippingReadAt?: string | null;
    eligibility: 'unverified'; sectionCodes: string[]; categoryTabs: string[];
    observedAt: string; evidencePeriod: { startAt: string | null; endAt: string | null };
    stockStatus: 'in_stock' | 'sold_out' | 'unknown';
    stockSignals: { isSoldOut: boolean | null; status: string | null; conflict: boolean };
  };
  creator?: CreatorSignalFacts;
  travel?: {
    departureDate?: string | null;
    returnDate?: string | null;
    nights?: number | null;
    travellers?: number | null;
    priceBasis?: 'from' | 'per_person' | 'total' | 'listed' | 'per_room_per_night' | 'unknown';
    taxesIncluded?: boolean | null;
    baggageIncluded?: boolean | null;
    checkInDate?: string | null;
    checkOutDate?: string | null;
    adults?: number | null;
    children?: number | null;
    rooms?: number | null;
    currencyCode?: string | null;
    propertyId?: string | null;
    hotelRating?: number | null;
    reviewCount?: number | null;
    rateOptionCount?: number | null;
    rateOptionsSampled?: boolean;
    rateOptions?: TravelRateOption[];
  };
  ranking?: {
    rank: number;
    contextId?: string;
    rankingType?: string;
    category?: string | null;
    market?: string | null;
    period?: string | null;
    sourceUpdatedAt?: string | null;
    productId?: string | null;
  };
  eligibility?: {
    region?: string | null;
    applicationStart?: string | null;
    deadlineDate?: string | null;
    deadlinePrecision?: 'date' | 'instant';
    deadlineTimeZone?: string;
  };
};

export type HubItem = {
  id: string;                 // stable: `${source}:${sourceItemId}`
  kind: HubKind;
  category: HubCategory;
  title: string;
  store: string | null;       // 쿠팡, G마켓, 네이버페이, 옥션, 11번가 …
  priceKrw: number | null;    // displayed price as posted (not a verified lowest)
  shippingNote: string | null;// '무료', '3,000원', …
  imageUrl: string | null;
  source: HubSource;
  sourceUrl: string;          // original post / page (always linked, never copied in full)
  affiliateUrl: string | null;// our partner link for the same product when verified, else null
  targetUrl?: string | null;  // community posts: the merchant product URL the poster shared (decoded)
  postedAt: string;           // ISO
  updatedAt?: string;         // ISO; last collector refresh of this row ("가격 확인 N분 전")
  observedAt?: string;        // ISO; when the source was actually observed (never the import time)
  ingestedAt?: string;        // ISO; when that observation reached the database
  facts?: HubFacts;           // domain-specific option, ranking and eligibility facts
  expiresAt: string | null;   // deal end / application deadline / event date
  comments: number | null;
  votes: number | null;
  views: number | null;
  tags: string[];
  summary: string | null;     // our one-line summary (never the original body)
  ended: boolean;             // 종료/품절 marked by source or our checker
};

export type HubFeedQuery = {
  /** Story-keyword workspace includes legacy topics and typed keywords, not videos or issue articles. */
  trendKeywordsOnly?: boolean;
  kind?: HubKind;
  category?: HubCategory;
  source?: HubSource;
  sourceGroup?: 'platform' | 'community'; // main feed = platform deals, 커뮤니티 tab = community boards
  q?: string;
  sort?: 'latest' | 'popular' | 'rank'; // 'rank' = ranking vertical's own 1위..N위 order (/rank's default)
  hideEnded?: boolean;
  priceMin?: number;          // 가격 필터 (hot deals): priceKrw >= priceMin
  priceMax?: number;          // 가격 필터 (hot deals): priceKrw <= priceMax
  discount?: boolean;         // 할인 있는 것만: tags contains an entry with a '%' sign
  limit?: number;             // default 30, max 60
  before?: string;            // opaque (postedAt,id) cursor; legacy ISO cursors remain readable
};

/** Popularity used for the 인기 tab: comments and votes weighted, decayed by age in hours. */
export function hubPopularity(item: Pick<HubItem, 'comments' | 'votes' | 'views' | 'postedAt'>, now = Date.now()): number {
  const ageH = Math.max(0, (now - Date.parse(item.postedAt)) / 3_600_000);
  const raw = (item.votes ?? 0) * 3 + (item.comments ?? 0) * 2 + (item.views ?? 0) / 200;
  return raw / Math.pow(ageH + 2, 1.5);
}
