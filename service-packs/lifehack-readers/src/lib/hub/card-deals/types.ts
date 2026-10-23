export const CARD_ISSUERS = ['kb', 'shinhan', 'samsung', 'hyundai', 'lotte', 'hana', 'woori', 'bc', 'nh'] as const;
export type CardIssuer = (typeof CARD_ISSUERS)[number];
export type CardConditionalPrice = {
  kind: 'coupon' | 'instant_discount' | 'statement_discount' | 'cashback' | 'points_spend' | 'advertised_best' | 'unknown';
  amountKrw: number | null;
  points: number | null;
  label: string | null;
};
/** A mall's operator is not evidence that payment requires that issuer's card. */
export type CardDealObservation = {
  externalId: string;
  title: string;
  sourceUrl: string;
  imageUrl: string | null;
  surface: 'mall_product' | 'payment_promotion' | 'points_redemption';
  productId: string | null;
  optionId: string | null;
  sellerId: string | null;
  priceKrw: number | null;
  listPriceKrw: number | null;
  shippingFeeKrw: number | null;
  shippingNote: string | null;
  stockStatus: 'in_stock' | 'sold_out' | 'unknown';
  eligibility: { status: 'unverified'; labels: string[]; requiredCard?: string | null; appOnly?: boolean | null; membershipRequired?: boolean | null };
  conditionalPrices?: CardConditionalPrice[];
  startsAt: string | null;
  expiresAt: string | null;
  publishedStartsAt?: string | null;
  publishedExpiresAt?: string | null;
};
export type CardProviderResult = {
  provider: CardIssuer;
  items: CardDealObservation[];
  sourceRows: number;
  /** Rows outside the explicitly selected shopping surface, not parser failures. */
  excludedRows?: number;
  pagesFetched: number;
  requests: number;
  /** Only true for the selected source surface after proven continuation exhaustion. */
  completeCatalog: boolean;
  stopReason: string;
  error: string | null;
  blocked: boolean;
  evidenceUrls: string[];
};
export type CardProvider = (fetchImpl?: typeof fetch, now?: Date) => Promise<CardProviderResult>;
