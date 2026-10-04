const positiveKrw = value => value?.currency === 'KRW' && Number.isSafeInteger(value.amount) && value.amount > 0
  ? value.amount : null;
const positiveWon = value => Number.isSafeInteger(value) && value > 0 ? value : null;

/** Select a verified public general price; keep a legacy listing amount explicitly unverified. */
export function selectGoldboxGeneralPrice(deal = {}) {
  const listingAmount = positiveWon(deal.salePrice);
  const widgetAmount = positiveKrw(deal.widgetFinalPrice);
  if (widgetAmount !== null && typeof deal.widgetPriceReadStatus === 'string'
    && deal.widgetPriceReadStatus.startsWith('matched_')) {
    return { amount: widgetAmount, currency: 'KRW', source: 'coupang_mlp_goldbox_widget',
      basis: deal.widgetFinalPrice.basis ?? 'widget_final_price_field', verified: true,
      readStatus: deal.widgetPriceReadStatus,
      matchesListingSalePrice: listingAmount === null ? null : listingAmount === widgetAmount };
  }

  const offerAmount = positiveKrw(deal.publicOfferGeneralPrice);
  if (offerAmount !== null && deal.publicOfferGeneralPriceReadStatus === 'matched_public_offer_general_price') {
    return { amount: offerAmount, currency: 'KRW', source: 'coupang_public_offer_list',
      basis: deal.publicOfferGeneralPrice.basis ?? 'public_offer_list', verified: true,
      readStatus: deal.publicOfferGeneralPriceReadStatus,
      matchesListingSalePrice: listingAmount === null ? null : listingAmount === offerAmount };
  }

  if (listingAmount !== null) return { amount: listingAmount, currency: 'KRW', source: 'coupang_goldbox_listing',
    basis: 'legacy_listing_sale_price', verified: false, verificationStatus: 'unverified_listing_fallback',
    readStatus: null, matchesListingSalePrice: true };
  return null;
}