import { buildCoupangOfferListRequest } from '../adapters/coupang-consumer-offers.mjs';
import { readCoupangConsumerOfferList } from '../adapters/coupang-consumer.mjs';

const SHIPPING_PATHS = new Set(['vendorItemSaleInfo.deliveryFee.shippingFee',
  'vendorItemSaleInfo.vendorItemDelivery.shippingFee', 'sellerSaleDeliveryInfo.shippingFee']);

// A collected public fee belongs to the public quote's general price, never to a member discount.
export function collectedCoupangComparisonShipping(deal, generalPrice) {
  const shipping = deal?.shipping;
  const fee = shipping?.fee;
  const quotePrice = deal?.publicShippingGeneralPrice;
  if (generalPrice?.verified !== true || generalPrice.currency !== 'KRW'
    || !Number.isSafeInteger(generalPrice.amount) || generalPrice.amount <= 0
    || deal?.shippingReadStatus !== 'verified' || shipping?.sourceScope !== 'consumer_public_offer_list'
    || shipping.memberEligibilityVerified !== false || fee?.currency !== 'KRW'
    || fee.priceKind !== 'public_offer_list_shipping_fee' || fee.basis !== 'public_offer_list'
    || !Number.isSafeInteger(fee.amount) || fee.amount < 0
    || quotePrice?.currency !== 'KRW' || quotePrice.basis !== 'public_offer_list'
    || quotePrice.priceKind !== 'offer_list_general_sale_price' || quotePrice.source !== 'coupang_public_offer_list'
    || quotePrice.amount !== generalPrice.amount
    || !Array.isArray(shipping.sourcePaths) || shipping.sourcePaths.length < 1
    || shipping.sourcePaths.length > SHIPPING_PATHS.size
    || shipping.sourcePaths.some(value => !SHIPPING_PATHS.has(value))) return null;
  return { feeKRW: fee.amount, source: 'coupang_public_offer_list', readStatus: 'verified',
    basis: 'public_offer_list', scope: 'consumer_public_offer_list', memberEligibilityVerified: false,
    sourcePaths: [...new Set(shipping.sourcePaths)], quotedGeneralPriceKRW: quotePrice.amount };
}

// An exact public offer quote may provide shipping for a widget price only when
// its selected SKU and general selling price still agree with that widget row.
export async function readCoupangComparisonShipping({ item, generalPrice, fetchImpl = globalThis.fetch,
  visitorContext, offerReader = readCoupangConsumerOfferList }) {
  const unknown = (readStatus, extra = {}) => ({ feeKRW: null, source: null, readStatus, ...extra });
  const deal = item?.deal;
  if (generalPrice?.verified !== true || generalPrice.currency !== 'KRW'
    || !Number.isSafeInteger(generalPrice.amount) || generalPrice.amount <= 0)
    return unknown('unverified_general_price');
  const identity = { url: item?.url, productId: deal?.productId, itemId: deal?.itemId, vendorItemId: deal?.vendorItemId };
  try { buildCoupangOfferListRequest(identity); }
  catch { return unknown('exact_identity_unavailable'); }
  let result;
  try {
    result = await offerReader({ url: identity.url, authentication: 'visitor', fetchImpl, visitorContext });
  } catch (error) {
    const status = Number.isInteger(error?.receipt?.status) ? error.receipt.status : null;
    const errorCode = /^[A-Z0-9_]{1,100}$/.test(error?.code ?? '') ? error.code : 'COUPANG_PUBLIC_SHIPPING_READ_FAILED';
    return unknown(status === 429 ? 'rate_limited' : 'read_failed', { status, errorCode });
  }
  const offer = result?.selectedOffer;
  if (offer?.selected !== true || offer.productId !== identity.productId || offer.itemId !== identity.itemId
    || offer.vendorItemId !== identity.vendorItemId || offer.price?.currency !== 'KRW')
    return unknown('identity_or_price_invalid', { status: result.receipt?.status ?? null });
  if (offer.price.amount !== generalPrice.amount) return unknown('general_price_conflict', { status: result.receipt?.status ?? null });
  const fee = offer.shipping?.fee;
  if (offer.shippingReadStatus !== 'verified' || fee?.currency !== 'KRW'
    || fee.basis !== 'public_offer_list' || fee.priceKind !== 'public_offer_list_shipping_fee'
    || offer.shipping?.sourceScope !== 'consumer_public_offer_list' || offer.shipping.memberEligibilityVerified !== false
    || !Number.isSafeInteger(fee.amount) || fee.amount < 0
    || !Array.isArray(offer.shipping.sourcePaths) || offer.shipping.sourcePaths.length < 1
    || offer.shipping.sourcePaths.some(path => !SHIPPING_PATHS.has(path)))
    return unknown(offer.shippingReadStatus === 'invalid' ? 'shipping_invalid' : 'shipping_unverified',
      { status: result.receipt?.status ?? null });
  return { feeKRW: fee.amount, source: 'coupang_public_offer_list', readStatus: 'verified',
    basis: 'public_offer_list', scope: 'consumer_public_offer_list', memberEligibilityVerified: false,
    status: result.receipt?.status ?? null, sourcePaths: offer.shipping.sourcePaths };
}
