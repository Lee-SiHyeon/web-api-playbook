import { readCoupangConsumerOfferList, readCoupangConsumerOffer, coupangConsumerProductUrl } from './coupang-consumer.mjs';
import { shoppingSessionStatus } from '../lib/shopping-session-store.mjs';

const positiveKrw = price => price?.currency === 'KRW' && Number.isSafeInteger(price.amount) && price.amount > 0;
const safeCode = value => typeof value === 'string' && /^[A-Z0-9_]{1,100}$/.test(value) ? value : 'COUPANG_ACCOUNT_PRICE_READ_FAILED';
const matches = (row, identity) => ['productId', 'itemId', 'vendorItemId'].every(key => row?.[key] === identity[key]);
const emptyStates = () => ({ captured: true, client_exists: true, remnant_free: true,
  credential_propagated: false, live_replay: false });
const ORIGIN = 'https://www.coupang.com';
const validIsoTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const exactQuery = (actual, expected) => actual !== null && typeof actual === 'object' && !Array.isArray(actual)
  && [Object.prototype, null].includes(Object.getPrototypeOf(actual))
  && Object.keys(actual).length === Object.keys(expected).length
  && Object.entries(expected).every(([key, value]) => actual[key] === value);
const nativePublicOfferList = (result, identity) => {
  const receipt = result?.receipt;
  const price = result?.selectedOffer?.price;
  return receipt?.operation === 'offer_list' && receipt.method === 'GET'
    && receipt.origin === ORIGIN && receipt.path === '/next-api/offer-list'
    && exactQuery(receipt.query, { productId: identity.productId, itemId: identity.itemId,
      selectedVendorItemId: identity.vendorItemId })
    && validIsoTime(receipt.checkedAt) && receipt.status === 200
    && receipt.execution === 'pure_http' && receipt.browserUsed === false
    && receipt.authenticationMode === 'visitor' && receipt.ownerCredentialUsed === false
    && receipt.transport === 'native_fetch' && receipt.credentialSent === false && receipt.credentialPropagated === false
    && price?.currency === 'KRW' && Number.isSafeInteger(price.amount) && price.amount > 0
    && price.priceKind === 'offer_list_general_sale_price' && price.basis === 'public_offer_list'
    && result.states?.captured === true && result.states?.client_exists === true
    && result.states?.remnant_free === true && result.states?.credential_propagated === false
    && result.states?.live_replay === true;
};
const nativeAccountQuantityInfo = (account, identity) => {
  const receipt = account?.receipt;
  return receipt?.operation === 'quantity_info' && receipt.method === 'GET'
    && receipt.origin === ORIGIN && receipt.path === '/next-api/products/quantity-info'
    && exactQuery(receipt.query, { productId: identity.productId, vendorItemId: identity.vendorItemId })
    && validIsoTime(receipt.checkedAt) && receipt.status === 200
    && receipt.execution === 'pure_http' && receipt.browserUsed === false
    && receipt.authenticationMode === 'protected' && receipt.credentialSent === true
    && receipt.transport === 'native_fetch' && receipt.credentialPropagated === true
    && account.states?.captured === true && account.states?.client_exists === true
    && account.states?.remnant_free === true && account.states?.credential_propagated === true
    && account.states?.live_replay === true;
};
const sanitizedAccountContextShipping = shipping => {
  const fee = shipping?.fee;
  if (!fee || fee.currency !== 'KRW' || !Number.isSafeInteger(fee.amount) || fee.amount < 0
    || fee.priceKind !== 'account_context_shipping_fee'
    || !['FREE', 'OTHER'].includes(shipping.type)
    || (shipping.type === 'FREE' && fee.amount !== 0)) return null;
  let originalFee = null;
  if (shipping.originalFee !== null) {
    const original = shipping.originalFee;
    if (!original || original.currency !== 'KRW' || !Number.isSafeInteger(original.amount) || original.amount < 0
      || original.priceKind !== 'displayed_original_shipping_fee') return null;
    originalFee = { amount: original.amount, currency: 'KRW', priceKind: 'displayed_original_shipping_fee' };
  }
  return {
    fee: { amount: fee.amount, currency: 'KRW', priceKind: 'account_context_shipping_fee' },
    type: shipping.type,
    originalFee,
    sourceScope: 'consumer_account_price',
    quantity: 1,
    memberEligibilityVerified: false,
  };
};

/** General and WOW pricing are separate contracts; missing membership input never falls back to general as WOW. */
export async function readCoupangConsumerWowPrice({ url, fetchImpl,
  publicReader = readCoupangConsumerOfferList, accountReader = readCoupangConsumerOffer,
  providerStatus = shoppingSessionStatus } = {}) {
  const identity = coupangConsumerProductUrl(url);
  const publicResult = await publicReader({ url: identity.url, authentication: 'visitor', ...(fetchImpl ? { fetchImpl } : {}) });
  if (!matches(publicResult.selectedOffer, identity) || publicResult.selectedOffer.selected !== true)
    throw Object.assign(new Error('COUPANG_WOW_PRICE_IDENTITY'), { code: 'COUPANG_WOW_PRICE_IDENTITY' });
  const selectedOffer = { ...publicResult.selectedOffer, advertisedWowPrice: null,
    wowPriceReadStatus: 'not_exposed_by_public_offer_list', memberPriceVerified: false,
    accountGeneralPriceMatchesPublic: null, accountContextSalePriceReadStatus: null, wowGeneralBoundSource: null };
  selectedOffer.publicShipping = selectedOffer.shipping ?? null;
  const publicShippingFee = selectedOffer.publicShipping?.fee;
  selectedOffer.publicShippingFee = selectedOffer.shippingReadStatus === 'verified'
    && publicShippingFee?.currency === 'KRW' && Number.isSafeInteger(publicShippingFee.amount)
    && publicShippingFee.amount >= 0 && publicShippingFee.priceKind === 'public_offer_list_shipping_fee'
    && publicShippingFee.basis === 'public_offer_list' ? publicShippingFee.amount : null;
  selectedOffer.memberShippingFee = null;
  selectedOffer.memberShippingVerified = false;
  selectedOffer.accountContextShipping = null;
  selectedOffer.accountContextShippingReadStatus = 'not_attempted';
  selectedOffer.accountContextShippingVerified = false;
  let accountContextPriceRead = { status: 'not_attempted', code: null, attempted: false, receipt: null };
  let accountStates = emptyStates();
  let ready;
  try { ready = providerStatus('coupang-consumer'); }
  catch (error) { ready = { usableForAttempt: false, code: safeCode(error.code) }; }
  if (ready?.usableForAttempt !== true) {
    accountContextPriceRead = { ...accountContextPriceRead, status: ready?.code === 'SESSION_PROVIDER_MISSING'
      ? 'provider_missing' : 'provider_unavailable', code: safeCode(ready?.code) };
    selectedOffer.accountContextShippingReadStatus = accountContextPriceRead.status;
  } else {
    try {
      // This reader resolves exactly one captured matching quantity request from DPAPI.
      const account = await accountReader({ url: identity.url, authentication: 'protected', ...(fetchImpl ? { fetchImpl } : {}) });
      accountStates = account.states ?? emptyStates();
      const offer = account.offer;
      accountContextPriceRead = { status: 'read', code: null, attempted: true, receipt: account.receipt ?? null };
      if (!matches(offer, identity) || offer.quantity !== 1 || offer.identityEvidence !== 'request_scope'
        || offer.sourceScope !== 'consumer_account_price' || account.receipt?.operation !== 'quantity_info'
        || account.receipt?.method !== 'GET' || account.receipt?.origin !== ORIGIN
        || account.receipt?.path !== '/next-api/products/quantity-info'
        || !exactQuery(account.receipt?.query, { productId: identity.productId, vendorItemId: identity.vendorItemId }))
        throw Object.assign(new Error('COUPANG_WOW_ACCOUNT_IDENTITY'), { code: 'COUPANG_WOW_ACCOUNT_IDENTITY' });
      selectedOffer.accountContextPriceComponents = offer.priceComponents;
      selectedOffer.discountContext = offer.discountContext;
      const flags = offer.discountContext;
      const finalPrice = offer.priceComponents?.finalPrice;
      const salePrice = offer.priceComponents?.salePrice;
      const couponPrice = offer.priceComponents?.couponPrice;
      const publicGeneralPrice = selectedOffer.price;
      const publicGeneralVerified = nativePublicOfferList(publicResult, identity);
      const accountSaleObserved = offer.salePriceReadStatus === 'matched' && positiveKrw(salePrice);
      const accountSaleExplicitlyNull = offer.salePriceReadStatus === 'explicitly_null' && salePrice === null;
      const accountGeneralPriceMatchesPublic = accountSaleObserved && publicGeneralVerified
        ? salePrice.amount === publicGeneralPrice.amount : null;
      selectedOffer.accountGeneralPriceMatchesPublic = accountGeneralPriceMatchesPublic;
      selectedOffer.accountContextSalePriceReadStatus = offer.salePriceReadStatus ?? null;
      const wowCouponDiscount = flags?.hasWowCouponDiscount === true || flags?.wowCouponDiscount === true;
      const wowInstantDiscount = flags?.hasWowInstantDiscount === true;
      const explicitWowDiscount = wowCouponDiscount || wowInstantDiscount;
      const nativeAccount = nativeAccountQuantityInfo(account, identity);
      const accountContextShipping = sanitizedAccountContextShipping(offer.shipping);
      if (accountContextShipping) {
        selectedOffer.accountContextShipping = accountContextShipping;
        selectedOffer.accountContextShippingReadStatus = nativeAccount
          ? 'verified_account_context' : 'parsed_account_context';
        selectedOffer.accountContextShippingVerified = nativeAccount;
      } else {
        selectedOffer.accountContextShippingReadStatus = offer.shipping == null ? 'shipping_absent' : 'invalid_account_context_shipping';
      }
      let generalPriceBound = null;
      if (accountGeneralPriceMatchesPublic === false) {
        selectedOffer.wowPriceReadStatus = 'account_general_price_mismatch';
      } else if (accountGeneralPriceMatchesPublic === true) {
        generalPriceBound = salePrice;
      } else if (accountSaleExplicitlyNull) {
        if (publicGeneralVerified) {
          generalPriceBound = publicGeneralPrice;
          selectedOffer.wowGeneralBoundSource = 'public_offer_list_fallback';
        } else {
          selectedOffer.wowPriceReadStatus = 'public_general_fallback_unverified';
        }
      } else {
        selectedOffer.wowPriceReadStatus = 'account_general_price_unverified';
      }
      if (generalPriceBound && flags?.readStatus === 'valid' && explicitWowDiscount && positiveKrw(finalPrice)
        && positiveKrw(couponPrice) && finalPrice.amount <= couponPrice.amount
        && couponPrice.amount <= generalPriceBound.amount && finalPrice.amount < generalPriceBound.amount) {
        selectedOffer.advertisedWowPrice = { ...finalPrice, label: '와우 적용 최종가',
          basis: 'account_context_final_price_with_explicit_wow_discount', requiresMembership: true, eligibilityVerified: false,
          source: 'coupang_quantity_info', sourcePath: 'price.finalPrice',
          wowCouponDiscountApplied: wowCouponDiscount,
          wowInstantDiscountApplied: wowInstantDiscount,
          normalInstantDiscountApplied: flags.hasNormalInstantDiscount,
          additionalCouponApplied: flags.hasNormalCouponDiscount,
          instantDiscountApplied: flags.instantDiscount, quantity: 1 };
        selectedOffer.wowPriceReadStatus = nativeAccount ? 'verified_advertised_wow_price' : 'parsed_account_wow_price';
      } else if (generalPriceBound && selectedOffer.wowPriceReadStatus !== 'account_general_price_mismatch') {
        selectedOffer.wowPriceReadStatus = flags?.readStatus === 'valid'
          && (flags.hasWowCouponDiscount ?? flags.wowCouponDiscount) === false
          && flags.hasWowInstantDiscount === false
          ? 'no_wow_discount_in_account_response' : 'unverified_account_wow_price';
      }
    } catch (error) {
      accountStates = { ...emptyStates(), credential_propagated: error.receipt?.credentialPropagated === true };
      accountContextPriceRead = { status: 'blocked', code: safeCode(error.code), attempted: true,
        receipt: error.receipt ?? accountContextPriceRead.receipt };
      selectedOffer.accountContextShippingReadStatus = error.receipt?.status === 403
        ? 'blocked_account_shipping' : error.code === 'COUPANG_WOW_ACCOUNT_IDENTITY'
          ? 'unverified_account_context' : 'read_failed';
      selectedOffer.advertisedWowPrice = null;
      selectedOffer.wowPriceReadStatus = 'account_wow_price_blocked';
    }
  }
  const wowVerified = selectedOffer.wowPriceReadStatus === 'verified_advertised_wow_price';
  const offerCopies = publicResult.offers.map(offer => offer.selected ? selectedOffer : offer);
  return { ...publicResult, ok: publicResult.states?.live_replay === true && wowVerified,
    partial: !wowVerified, ...(wowVerified ? {} : { code: 'COUPANG_WOW_PRICE_UNAVAILABLE' }),
    offers: offerCopies, selectedOffer, accountContextPriceRead,
    coverage: 'exact_sku_general_and_separate_wow_price',
    pricePaths: { publicGeneral: publicResult.states, accountWow: { ...accountStates, live_replay: wowVerified } },
    states: { ...publicResult.states, credential_propagated: accountStates.credential_propagated === true,
      live_replay: publicResult.states?.live_replay === true && wowVerified } };
}
