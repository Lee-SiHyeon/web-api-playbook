import test from 'node:test';
import assert from 'node:assert/strict';
import { readCoupangConsumerWowPrice } from '../adapters/coupang-wow-prices.mjs';
import { parseCoupangOfferList, parseCoupangQuantityInfo } from '../adapters/coupang-consumer-offers.mjs';
import {
  normalizeCoupangWowPriceTargetUrl,
  verifyCoupangWowPrice,
} from '../lib/coupang-wow-price-verification.mjs';
import {
  main,
  parseCoupangWowPriceArgs,
} from '../scripts/verify-coupang-wow-price.mjs';

const target = {
  productId: '6247736560',
  itemId: '12646874013',
  vendorItemId: '79914317500',
};
const targetUrl = `https://www.coupang.com/vp/products/${target.productId}?itemId=${target.itemId}&vendorItemId=${target.vendorItemId}`;
const checkedAt = '2026-10-04T03:30:00.000Z';
const eggTarget = { productId: '6417848924', itemId: '13792011639', vendorItemId: '81042389208' };
const eggUrl = `https://www.coupang.com/vp/products/${eggTarget.productId}?itemId=${eggTarget.itemId}&vendorItemId=${eggTarget.vendorItemId}`;

function offerListResult({
  generalPrice = 13_200,
  wowAmount = null,
  wowStatus = 'not_exposed_by_public_offer_list',
  wowOverrides = {},
  resultOverrides = {},
  selectedOverrides = {},
  receiptOverrides = {},
  statesOverrides = {},
  accountReceiptOverrides = {},
  accountStatesOverrides = {},
  accountReadOverrides = {},
} = {}) {
  const hasVerifiedWow = wowStatus === 'verified_advertised_wow_price' && wowAmount !== null;
  const selectedOffer = {
    productId: target.productId,
    itemId: target.itemId,
    vendorItemId: target.vendorItemId,
    selected: true,
    price: {
      amount: generalPrice,
      currency: 'KRW',
      priceKind: 'offer_list_general_sale_price',
      basis: 'public_offer_list',
    },
    wowPriceReadStatus: wowStatus,
    ...(hasVerifiedWow ? {
      accountGeneralPriceMatchesPublic: true,
      accountContextSalePriceReadStatus: 'matched',
      wowGeneralBoundSource: null,
      accountContextPriceComponents: {
        salePrice: { amount: generalPrice, currency: 'KRW' },
        couponPrice: { amount: wowAmount, currency: 'KRW' },
        finalPrice: { amount: wowAmount, currency: 'KRW' },
      },
      discountContext: { readStatus: 'valid', wowCouponDiscount: true, hasWowCouponDiscount: true,
        hasWowInstantDiscount: false },
    } : {}),
    ...(wowAmount === null ? {} : {
      advertisedWowPrice: {
        amount: wowAmount,
        currency: 'KRW',
        label: '와우할인',
        requiresMembership: true,
        eligibilityVerified: false,
        basis: 'account_context_final_price_with_explicit_wow_discount',
        source: 'coupang_quantity_info',
        sourcePath: 'price.finalPrice',
        quantity: 1,
        ...wowOverrides,
      },
    }),
    ...selectedOverrides,
  };
  return {
    productId: target.productId,
    itemId: target.itemId,
    selectedVendorItemId: target.vendorItemId,
    selectedOffer,
    receipt: {
      checkedAt,
      operation: 'offer_list',
      origin: 'https://www.coupang.com',
      path: '/next-api/offer-list',
      method: 'GET',
      query: { productId: target.productId, itemId: target.itemId, selectedVendorItemId: target.vendorItemId },
      execution: 'pure_http',
      browserUsed: false,
      authenticationMode: 'visitor',
      status: 200,
      transport: 'native_fetch',
      ownerCredentialUsed: false,
      credentialSent: false,
      credentialPropagated: false,
      ...receiptOverrides,
    },
    accountContextPriceRead: {
      status: hasVerifiedWow ? 'read' : 'provider_missing',
      code: hasVerifiedWow ? null : 'SESSION_PROVIDER_MISSING',
      attempted: hasVerifiedWow,
      receipt: hasVerifiedWow ? {
        checkedAt,
        operation: 'quantity_info',
        origin: 'https://www.coupang.com',
        path: '/next-api/products/quantity-info',
        method: 'GET',
        query: { productId: target.productId, vendorItemId: target.vendorItemId },
        execution: 'pure_http',
        browserUsed: false,
        authenticationMode: 'protected',
        status: 200,
        transport: 'native_fetch',
        credentialSent: true,
        credentialPropagated: true,
        ...accountReceiptOverrides,
      } : null,
      ...accountReadOverrides,
    },
    pricePaths: {
      publicGeneral: {
        captured: true,
        client_exists: true,
        remnant_free: true,
        credential_propagated: false,
        live_replay: true,
      },
      accountWow: {
        captured: true,
        client_exists: true,
        remnant_free: true,
        credential_propagated: hasVerifiedWow,
        live_replay: hasVerifiedWow,
        ...accountStatesOverrides,
      },
    },
    states: {
      captured: true,
      client_exists: true,
      remnant_free: true,
      credential_propagated: hasVerifiedWow,
      live_replay: hasVerifiedWow,
      ...statesOverrides,
    },
    ...resultOverrides,
  };
}

const validFallbackSelectedOverrides = () => ({
  accountGeneralPriceMatchesPublic: null,
  accountContextSalePriceReadStatus: 'explicitly_null',
  wowGeneralBoundSource: 'public_offer_list_fallback',
  accountContextPriceComponents: {
    salePrice: null,
    couponPrice: { amount: 12_000, currency: 'KRW' },
    finalPrice: { amount: 11_200, currency: 'KRW' },
  },
  discountContext: { readStatus: 'valid', wowCouponDiscount: false, hasWowCouponDiscount: false,
    hasWowInstantDiscount: true, hasNormalInstantDiscount: false },
});

const eggPublicPayload = () => ({ data: { status: 200, vendorItems: [{
  ...eggTarget, selected: true, hasCouponDownload: false, hasAppreciationCoupon: false,
  hasNoneAppreciationCoupon: true,
  vendorItemSaleInfo: { itemId: eggTarget.itemId, vendorItemId: eggTarget.vendorItemId,
    salePrice: 8690, i18nSalePrice: { amount: '8690', rawAmount: 8690, fractionDigits: 0, currency: 'KRW' },
    couponPrice: null, i18nCouponPrice: null },
}] } });
// Captured browser fixture: preserve browser provenance, never relabel it as native HTTP.
const browserObservedEggQuantityPayload = () => [{ quantity: 1, priceUnit: '원', price: {
  salePrice: null, i18nSalePrice: null, originPrice: '8,690',
  i18nOriginPrice: { amount: '8690', rawAmount: null, fractionDigits: 0, currency: 'KRW' },
  couponPrice: '7,590', i18nCouponPrice: { amount: '7590', rawAmount: null, fractionDigits: 0, currency: 'KRW' },
  finalPrice: '7,590', wowCouponDiscount: false, instantDiscount: true,
  hasNormalCouponDiscount: false, hasWowCouponDiscount: false,
  hasNormalInstantDiscount: false, hasWowInstantDiscount: true,
}, shippingFee: { shippingFeeType: 'FREE', shippingFee: '0' } }];
const browserObservedEggAdapterOptions = () => ({
  url: eggUrl,
  providerStatus: () => ({ usableForAttempt: true }),
  publicReader: async ({ url, authentication }) => {
    assert.equal(url, eggUrl);
    assert.equal(authentication, 'visitor');
    return {
      ...parseCoupangOfferList(eggPublicPayload(), { ...eggTarget, url: eggUrl }),
      receipt: { checkedAt, operation: 'offer_list', origin: 'https://www.coupang.com',
        path: '/next-api/offer-list', method: 'GET',
        query: { productId: eggTarget.productId, itemId: eggTarget.itemId,
          selectedVendorItemId: eggTarget.vendorItemId },
        execution: 'pure_http', browserUsed: false, authenticationMode: 'visitor',
        status: 200, transport: 'native_fetch',
        ownerCredentialUsed: false, credentialSent: false, credentialPropagated: false },
      states: { captured: true, client_exists: true, remnant_free: true,
        credential_propagated: false, live_replay: true },
    };
  },
  accountReader: async ({ url, authentication }) => {
    assert.equal(url, eggUrl);
    assert.equal(authentication, 'protected');
    return {
      offer: parseCoupangQuantityInfo(browserObservedEggQuantityPayload(), { ...eggTarget, url: eggUrl }),
      receipt: { checkedAt, operation: 'quantity_info', origin: 'https://www.coupang.com',
        path: '/next-api/products/quantity-info', method: 'GET',
        query: { productId: eggTarget.productId, vendorItemId: eggTarget.vendorItemId },
        execution: 'pure_http', browserUsed: false, authenticationMode: 'protected', status: 200,
        transport: 'browser_observed_fixture', credentialPropagated: false },
      states: { captured: true, client_exists: true, remnant_free: true,
        credential_propagated: false, live_replay: false },
    };
  },
});

test('accepts only an exact Coupang product, item, and vendor URL', () => {
  assert.deepEqual(normalizeCoupangWowPriceTargetUrl(targetUrl), {
    productUrl: targetUrl,
    ...target,
  });
  assert.equal(normalizeCoupangWowPriceTargetUrl(
    `https://www.coupang.com/vp/products/${target.productId}?vendorItemId=${target.vendorItemId}&itemId=${target.itemId}`,
  ).productUrl, targetUrl);
  for (const url of [
    'https://example.com/vp/products/6247736560?itemId=12646874013&vendorItemId=79914317500',
    `${targetUrl}&itemId=1`,
    `${targetUrl}&q=milk`,
    `${targetUrl}#reviews`,
    `https://user@www.coupang.com/vp/products/${target.productId}?itemId=${target.itemId}&vendorItemId=${target.vendorItemId}`,
  ]) assert.throws(() => normalizeCoupangWowPriceTargetUrl(url));
});

test('parses URL, expected WOW price, live, and write options without permitting arbitrary flags', () => {
  assert.deepEqual(parseCoupangWowPriceArgs([
    '--url', targetUrl, '--expected-wow-price=11200', '--live', '--write',
  ]), {
    url: targetUrl,
    expectedWowPriceKrw: 11_200,
    live: true,
    writeReceipt: true,
  });
  assert.throws(() => parseCoupangWowPriceArgs(['--url', targetUrl, '--live', '--live']));
  assert.throws(() => parseCoupangWowPriceArgs(['--url', targetUrl, '--expected-wow-price=0']));
  assert.throws(() => parseCoupangWowPriceArgs(['--url', targetUrl, '--force']));
});

test('dry-run validates the exact target and never invokes the reader', async () => {
  let calls = 0;
  const report = await verifyCoupangWowPrice({
    url: targetUrl,
    expectedWowPriceKrw: 11_200,
    readOfferList: async () => { calls += 1; throw new Error('must not read'); },
  });
  assert.equal(report.status, 'validated_only');
  assert.equal(report.passed, false);
  assert.equal(report.liveRequested, false);
  assert.equal(report.expectedWowPriceMatched, false);
  assert.equal(report.memberPriceVerified, false);
  assert.equal(calls, 0);
});

test('verifies the advertised WOW amount separately from the general sale and account eligibility', async () => {
  const report = await verifyCoupangWowPrice({
    url: targetUrl,
    expectedWowPriceKrw: 11_200,
    live: true,
    readOfferList: async options => {
      assert.deepEqual(options, { url: targetUrl, authentication: 'visitor' });
      return offerListResult({ generalPrice: 13_200, wowAmount: 11_200, wowStatus: 'verified_advertised_wow_price' });
    },
  });
  assert.equal(report.status, 'verified_advertised_wow_price');
  assert.equal(report.passed, true);
  assert.deepEqual([report.productId, report.itemId, report.vendorItemId], Object.values(target));
  assert.equal(report.observedAt, checkedAt);
  assert.equal(report.selectedIdentityMatched, true);
  assert.equal(report.observedGeneralPriceKrw, 13_200);
  assert.equal(report.generalPriceVerified, true);
  assert.equal(report.advertisedWowPriceKrw, 11_200);
  assert.equal(report.advertisedWowPriceVerified, true);
  assert.equal(report.advertisedWowPriceLabel, '와우할인');
  assert.equal(report.advertisedWowPriceSourcePath, 'price.finalPrice');
  assert.equal(report.wowMembershipRequired, true);
  assert.equal(report.memberPriceVerified, false);
  assert.equal(report.expectedWowPriceMatched, true);
  assert.equal(report.accountContextPriceReadStatus, 'read');
  assert.equal(report.accountContextSalePriceReadStatus, 'matched');
  assert.equal(report.accountGeneralPriceMatchesPublic, true);
  assert.equal(report.wowGeneralBoundSource, null);
  assert.equal(report.accountCredentialPropagated, true);
  assert.equal(report.nativeWowStatesVerified, true);
});

test('integrates the maintained WOW adapter for explicit coupon and instant WOW discounts', async () => {
  const variants = [
    {
      name: 'coupon flag',
      flags: {
        hasWowCouponDiscount: true,
        wowCouponDiscount: true,
        hasWowInstantDiscount: false,
        hasNormalInstantDiscount: false,
        hasNormalCouponDiscount: false,
        instantDiscount: false,
      },
    },
    {
      name: 'instant flag with legacy coupon flag false',
      flags: {
        hasWowCouponDiscount: false,
        wowCouponDiscount: false,
        hasWowInstantDiscount: true,
        hasNormalInstantDiscount: false,
        hasNormalCouponDiscount: false,
        instantDiscount: true,
      },
    },
  ];

  for (const variant of variants) {
    const accountObservedAt = '2026-10-04T03:30:01.000Z';
    const report = await verifyCoupangWowPrice({
      url: targetUrl,
      expectedWowPriceKrw: 11_200,
      live: true,
      readOfferList: options => readCoupangConsumerWowPrice({
        ...options,
        providerStatus: service => {
          assert.equal(service, 'coupang-consumer');
          return { usableForAttempt: true };
        },
        publicReader: async ({ url, authentication }) => {
          assert.equal(url, targetUrl);
          assert.equal(authentication, 'visitor');
          const selectedOffer = {
            productId: target.productId,
            itemId: target.itemId,
            vendorItemId: target.vendorItemId,
            selected: true,
            price: {
              amount: 13_200,
              currency: 'KRW',
              priceKind: 'offer_list_general_sale_price',
              basis: 'public_offer_list',
            },
          };
          return {
            productId: target.productId,
            itemId: target.itemId,
            selectedVendorItemId: target.vendorItemId,
            selectedOffer,
            offers: [selectedOffer],
            count: 1,
            receipt: {
              checkedAt,
              operation: 'offer_list',
              origin: 'https://www.coupang.com',
              path: '/next-api/offer-list',
              method: 'GET',
              query: { productId: target.productId, itemId: target.itemId,
                selectedVendorItemId: target.vendorItemId },
              execution: 'pure_http',
              browserUsed: false,
              authenticationMode: 'visitor',
              status: 200,
              transport: 'native_fetch',
              ownerCredentialUsed: false,
              credentialSent: false,
              credentialPropagated: false,
            },
            states: {
              captured: true,
              client_exists: true,
              remnant_free: true,
              credential_propagated: false,
              live_replay: true,
            },
          };
        },
        accountReader: async ({ url, authentication }) => {
          assert.equal(url, targetUrl);
          assert.equal(authentication, 'protected');
          return {
            offer: {
              ...target,
              quantity: 1,
              identityEvidence: 'request_scope',
              sourceScope: 'consumer_account_price',
              priceComponents: {
                salePrice: { amount: 13_200, currency: 'KRW' },
                couponPrice: { amount: 12_000, currency: 'KRW' },
                finalPrice: { amount: 11_200, currency: 'KRW' },
              },
              salePriceReadStatus: 'matched',
              discountContext: { readStatus: 'valid', ...variant.flags },
            },
            receipt: {
              checkedAt: accountObservedAt,
              operation: 'quantity_info',
              origin: 'https://www.coupang.com',
              path: '/next-api/products/quantity-info',
              method: 'GET',
              query: { productId: target.productId, vendorItemId: target.vendorItemId },
              execution: 'pure_http',
              browserUsed: false,
              authenticationMode: 'protected',
              status: 200,
              transport: 'native_fetch',
              credentialSent: true,
              credentialPropagated: true,
            },
            states: {
              captured: true,
              client_exists: true,
              remnant_free: true,
              credential_propagated: true,
              live_replay: true,
            },
          };
        },
      }),
    });

    assert.equal(report.status, 'verified_advertised_wow_price', variant.name);
    assert.equal(report.passed, true, variant.name);
    assert.equal(report.selectedIdentityMatched, true, variant.name);
    assert.equal(report.observedGeneralPriceKrw, 13_200, variant.name);
    assert.equal(report.generalPriceVerified, true, variant.name);
    assert.equal(report.advertisedWowPriceKrw, 11_200, variant.name);
    assert.equal(report.advertisedWowPriceVerified, true, variant.name);
    assert.equal(report.advertisedWowPriceSourcePath, 'price.finalPrice', variant.name);
    assert.equal(report.wowMembershipRequired, true, variant.name);
    assert.equal(report.memberPriceVerified, false, variant.name);
    assert.equal(report.accountCredentialPropagated, true, variant.name);
    assert.equal(report.nativeGeneralStatesVerified, true, variant.name);
    assert.equal(report.nativeWowStatesVerified, true, variant.name);
    assert.equal(report.nativeStatesVerified, true, variant.name);
    assert.equal(report.observedGeneralAt, checkedAt, variant.name);
    assert.equal(report.observedWowAt, accountObservedAt, variant.name);
    assert.equal(report.expectedWowPriceMatched, true, variant.name);
  }
});

test('accepts null-sale WOW only with the explicit public-general fallback provenance and full native proof', async () => {
  const report = await verifyCoupangWowPrice({ url: targetUrl, expectedWowPriceKrw: 11_200, live: true,
    readOfferList: async () => offerListResult({ generalPrice: 13_200, wowAmount: 11_200,
      wowStatus: 'verified_advertised_wow_price', selectedOverrides: validFallbackSelectedOverrides() }),
  });
  assert.equal(report.status, 'verified_advertised_wow_price');
  assert.equal(report.passed, true);
  assert.equal(report.observedGeneralPriceKrw, 13_200);
  assert.equal(report.generalPriceVerified, true);
  assert.equal(report.advertisedWowPriceKrw, 11_200);
  assert.equal(report.accountContextSalePriceReadStatus, 'explicitly_null');
  assert.equal(report.accountGeneralPriceMatchesPublic, null);
  assert.equal(report.wowGeneralBoundSource, 'public_offer_list_fallback');
  assert.equal(report.nativeGeneralStatesVerified, true);
  assert.equal(report.nativeWowStatesVerified, true);
  assert.equal(report.nativeStatesVerified, true);
  assert.equal(report.memberPriceVerified, false);
});

test('verified WOW status cannot bypass omitted or invalid null-sale fallback provenance and bounds', async () => {
  const mutations = [
    ['source omitted', selected => { delete selected.wowGeneralBoundSource; }],
    ['source malformed', selected => { selected.wowGeneralBoundSource = 'display_origin_price'; }],
    ['comparison omitted', selected => { delete selected.accountGeneralPriceMatchesPublic; }],
    ['comparison non-null', selected => { selected.accountGeneralPriceMatchesPublic = true; }],
    ['sale status omitted', selected => { delete selected.accountContextSalePriceReadStatus; }],
    ['sale component omitted', selected => { delete selected.accountContextPriceComponents.salePrice; }],
    ['account sale fabricated', selected => { selected.accountContextPriceComponents.salePrice = { amount: 8690, currency: 'KRW' }; }],
    ['coupon above general', selected => { selected.accountContextPriceComponents.couponPrice.amount = 13_201; }],
    ['final above coupon', selected => { selected.accountContextPriceComponents.finalPrice.amount = 12_001; }],
    ['final equals general', selected => {
      selected.accountContextPriceComponents.couponPrice.amount = 13_200;
      selected.accountContextPriceComponents.finalPrice.amount = 13_200;
    }],
    ['final differs from advertised amount', selected => { selected.accountContextPriceComponents.finalPrice.amount = 11_201; }],
    ['WOW flags not explicit', selected => {
      selected.discountContext.hasWowInstantDiscount = false;
      selected.discountContext.wowCouponDiscount = false;
      selected.discountContext.hasWowCouponDiscount = false;
    }],
    ['present sale mismatch cannot use fallback', selected => {
      selected.accountContextSalePriceReadStatus = 'matched';
      selected.accountContextPriceComponents.salePrice = { amount: 14_000, currency: 'KRW' };
      selected.accountGeneralPriceMatchesPublic = false;
    }],
  ];
  for (const [name, mutate] of mutations) {
    const selectedOverrides = validFallbackSelectedOverrides();
    mutate(selectedOverrides);
    const report = await verifyCoupangWowPrice({ url: targetUrl, live: true,
      readOfferList: async () => offerListResult({ generalPrice: 13_200, wowAmount: 11_200,
        wowStatus: 'verified_advertised_wow_price', selectedOverrides }),
    });
    assert.equal(report.status, 'invalid_advertised_wow_price', name);
    assert.equal(report.advertisedWowPriceVerified, false, name);
    assert.equal(report.passed, false, name);
  }
});

test('integrates the captured paired-null browser fixture without claiming native WOW replay', async () => {
  const report = await verifyCoupangWowPrice({ url: eggUrl, live: true,
    readOfferList: options => readCoupangConsumerWowPrice({ ...options, ...browserObservedEggAdapterOptions() }),
  });
  assert.equal(report.status, 'wow_price_unavailable');
  assert.equal(report.selectedIdentityMatched, true);
  assert.equal(report.observedGeneralPriceKrw, 8690);
  assert.equal(report.generalPriceVerified, true);
  assert.equal(report.accountContextSalePriceReadStatus, 'explicitly_null');
  assert.equal(report.accountGeneralPriceMatchesPublic, null);
  assert.equal(report.wowGeneralBoundSource, 'public_offer_list_fallback');
  assert.equal(report.wowPriceReadStatus, 'parsed_account_wow_price');
  assert.equal(report.advertisedWowPriceKrw, null);
  assert.equal(report.advertisedWowPriceVerified, false);
  assert.equal(report.nativeWowStatesVerified, false);
  assert.equal(report.nativeStatesVerified, false);
  assert.equal(report.memberPriceVerified, false);
  assert.equal(report.passed, false);
});

test('reports an unverified public-general fallback as partial without promoting WOW', async () => {
  const report = await verifyCoupangWowPrice({ url: targetUrl, live: true,
    readOfferList: async () => offerListResult({ wowStatus: 'public_general_fallback_unverified',
      selectedOverrides: { accountContextSalePriceReadStatus: 'explicitly_null',
        accountGeneralPriceMatchesPublic: null, wowGeneralBoundSource: null },
      accountReadOverrides: { status: 'read', code: null, attempted: true,
        receipt: { checkedAt, operation: 'quantity_info', transport: 'browser_observed_fixture', status: 200,
          credentialPropagated: false } },
    }),
  });
  assert.equal(report.status, 'public_general_fallback_unverified');
  assert.equal(report.wowPriceReadStatus, 'public_general_fallback_unverified');
  assert.equal(report.accountContextSalePriceReadStatus, 'explicitly_null');
  assert.equal(report.accountGeneralPriceMatchesPublic, null);
  assert.equal(report.wowGeneralBoundSource, null);
  assert.equal(report.generalPriceVerified, true);
  assert.equal(report.advertisedWowPriceKrw, null);
  assert.equal(report.passed, false);
});

test('reports an account/public general-price mismatch without discarding the verified public price', async () => {
  const report = await verifyCoupangWowPrice({ url: targetUrl, live: true,
    readOfferList: async () => offerListResult({ wowStatus: 'account_general_price_mismatch',
      selectedOverrides: { accountGeneralPriceMatchesPublic: false },
      accountReadOverrides: { status: 'read', code: null, attempted: true,
        receipt: { checkedAt, operation: 'quantity_info', transport: 'native_fetch', status: 200, credentialPropagated: true } },
    }),
  });
  assert.equal(report.status, 'account_general_price_mismatch');
  assert.equal(report.wowPriceReadStatus, 'account_general_price_mismatch');
  assert.equal(report.generalPriceVerified, true);
  assert.equal(report.observedGeneralPriceKrw, 13200);
  assert.equal(report.accountGeneralPriceMatchesPublic, false);
  assert.equal(report.wowGeneralBoundSource, null);
  assert.equal(report.accountHttpStatus, 200);
  assert.equal(report.advertisedWowPriceKrw, null);
  assert.equal(report.advertisedWowPriceVerified, false);
  assert.equal(report.passed, false);
});

test('does not infer WOW price from a generic coupon or the screenshot comparison amount', async () => {
  const result = offerListResult({
    generalPrice: 13_200,
    wowStatus: 'not_exposed_by_public_offer_list',
    selectedOverrides: {
      genericCouponPrice: { amount: 11_200, currency: 'KRW' },
      originalPrice: { amount: 19_900, currency: 'KRW' },
    },
  });
  const report = await verifyCoupangWowPrice({
    url: targetUrl,
    expectedWowPriceKrw: 11_200,
    live: true,
    readOfferList: async () => result,
  });
  assert.equal(report.status, 'wow_price_unavailable');
  assert.equal(report.passed, false);
  assert.equal(report.observedGeneralPriceKrw, 13_200);
  assert.equal(report.generalPriceVerified, true);
  assert.equal(report.advertisedWowPriceKrw, null);
  assert.equal(report.advertisedWowPriceVerified, false);
  assert.equal(report.wowPriceReadStatus, 'not_exposed_by_public_offer_list');
  assert.equal(report.expectedWowPriceMatched, false);
  assert.equal(report.wowMembershipRequired, null);
  assert.equal(report.memberPriceVerified, false);
  assert.equal(report.accountContextPriceReadStatus, 'provider_missing');
  assert.equal(report.accountContextPriceReadCode, 'SESSION_PROVIDER_MISSING');
  assert.equal(report.accountHttpStatus, null);
  assert.equal(report.accountCredentialPropagated, false);
});

test('missing and mismatching advertised prices cannot pass an expected WOW price', async () => {
  const missing = await verifyCoupangWowPrice({
    url: targetUrl,
    expectedWowPriceKrw: 11_200,
    live: true,
    readOfferList: async () => offerListResult({ wowStatus: 'absent' }),
  });
  assert.equal(missing.passed, false);
  assert.equal(missing.expectedWowPriceMatched, false);

  const mismatch = await verifyCoupangWowPrice({
    url: targetUrl,
    expectedWowPriceKrw: 11_200,
    live: true,
    readOfferList: async () => offerListResult({
      wowAmount: 11_500,
      wowStatus: 'verified_advertised_wow_price',
    }),
  });
  assert.equal(mismatch.status, 'expected_wow_price_mismatch');
  assert.equal(mismatch.passed, false);
  assert.equal(mismatch.advertisedWowPriceVerified, true);
  assert.equal(mismatch.expectedWowPriceMatched, false);
});

test('conditional amount, malformed evidence, and wrong identity are rejected', async () => {
  const conditional = await verifyCoupangWowPrice({
    url: targetUrl,
    live: true,
    readOfferList: async () => offerListResult({ wowAmount: 11_200, wowStatus: 'conditional_unverified' }),
  });
  assert.equal(conditional.status, 'conditional_unverified');
  assert.equal(conditional.passed, false);
  assert.equal(conditional.advertisedWowPriceKrw, null);

  const malformed = await verifyCoupangWowPrice({
    url: targetUrl,
    live: true,
    readOfferList: async () => offerListResult({
      wowAmount: 11_200,
      wowStatus: 'verified_advertised_wow_price',
      wowOverrides: { eligibilityVerified: true },
    }),
  });
  assert.equal(malformed.status, 'invalid_advertised_wow_price');
  assert.equal(malformed.passed, false);

  const wrongIdentity = await verifyCoupangWowPrice({
    url: targetUrl,
    live: true,
    readOfferList: async () => offerListResult({ selectedOverrides: { vendorItemId: '79914317501' } }),
  });
  assert.equal(wrongIdentity.status, 'identity_mismatch');
  assert.equal(wrongIdentity.selectedIdentityMatched, false);
  assert.equal(wrongIdentity.observedGeneralPriceKrw, null);
  assert.equal(wrongIdentity.advertisedWowPriceKrw, null);
});

test('requires native offer-list transport, current observation time, and all native states', async () => {
  const nonNative = await verifyCoupangWowPrice({
    url: targetUrl,
    live: true,
    readOfferList: async () => offerListResult({
      wowAmount: 11_200,
      wowStatus: 'verified_advertised_wow_price',
      receiptOverrides: { transport: 'injected' },
    }),
  });
  assert.equal(nonNative.status, 'non_native_transport');
  assert.equal(nonNative.passed, false);
  assert.equal(nonNative.generalPriceVerified, false);

  const incompleteStates = await verifyCoupangWowPrice({
    url: targetUrl,
    live: true,
    readOfferList: async () => offerListResult({
      wowAmount: 11_200,
      wowStatus: 'verified_advertised_wow_price',
      statesOverrides: { live_replay: false },
    }),
  });
  assert.equal(incompleteStates.status, 'native_wow_states_unverified');
  assert.equal(incompleteStates.passed, false);
  assert.equal(incompleteStates.generalPriceVerified, true);

  const missingTime = await verifyCoupangWowPrice({
    url: targetUrl,
    live: true,
    readOfferList: async () => offerListResult({
      wowAmount: 11_200,
      wowStatus: 'verified_advertised_wow_price',
      accountReceiptOverrides: { checkedAt: null },
    }),
  });
  assert.equal(missingTime.status, 'native_wow_states_unverified');
  assert.equal(missingTime.observedWowAt, null);

  const otherOperation = await verifyCoupangWowPrice({
    url: targetUrl,
    live: true,
    readOfferList: async () => offerListResult({
      wowAmount: 11_200,
      wowStatus: 'verified_advertised_wow_price',
      accountReceiptOverrides: { operation: 'other_sellers' },
    }),
  });
  assert.equal(otherOperation.nativeWowStatesVerified, false);
  assert.equal(otherOperation.passed, false);
  assert.equal(otherOperation.status, 'native_wow_states_unverified');
});

test('rejects injected native claims without the exact pure-HTTP offer-list and quantity request receipts', async () => {
  const publicReceiptMutations = [
    { execution: 'browser' },
    { browserUsed: true },
    { origin: 'https://m.coupang.com' },
    { path: '/next-api/review' },
    { method: 'POST' },
    { authenticationMode: 'protected' },
    { ownerCredentialUsed: true },
    { query: { productId: target.productId, itemId: target.itemId, selectedVendorItemId: '79914317501' } },
    { query: { productId: target.productId, itemId: target.itemId,
      selectedVendorItemId: target.vendorItemId, unobserved: 'x' } },
  ];
  for (const receiptOverrides of publicReceiptMutations) {
    const report = await verifyCoupangWowPrice({ url: targetUrl, live: true,
      readOfferList: async () => offerListResult({ wowAmount: 11_200,
        wowStatus: 'verified_advertised_wow_price', receiptOverrides }),
    });
    assert.equal(report.nativeOfferListRead, false);
    assert.equal(report.nativeGeneralStatesVerified, false);
    assert.equal(report.status, 'non_native_transport');
    assert.equal(report.passed, false);
  }

  const accountReceiptMutations = [
    { execution: 'browser' },
    { browserUsed: true },
    { origin: 'https://m.coupang.com' },
    { path: '/next-api/products/other-seller-info' },
    { method: 'POST' },
    { authenticationMode: 'visitor' },
    { credentialSent: false },
    { query: { productId: target.productId, vendorItemId: '79914317501' } },
    { query: { productId: target.productId, vendorItemId: target.vendorItemId, unobserved: 'x' } },
  ];
  for (const accountReceiptOverrides of accountReceiptMutations) {
    const report = await verifyCoupangWowPrice({ url: targetUrl, live: true,
      readOfferList: async () => offerListResult({ wowAmount: 11_200,
        wowStatus: 'verified_advertised_wow_price', accountReceiptOverrides }),
    });
    assert.equal(report.nativeOfferListRead, true);
    assert.equal(report.nativeGeneralStatesVerified, true);
    assert.equal(report.nativeWowStatesVerified, false);
    assert.equal(report.status, 'native_wow_states_unverified');
    assert.equal(report.passed, false);
  }

});

test('sanitizes blocked reads and never copies error messages or private request fields', async () => {
  const blocked = await verifyCoupangWowPrice({
    url: targetUrl,
    live: true,
    readOfferList: async () => {
      throw Object.assign(new Error('SECRET_ERROR_TEXT'), {
        code: 'COUPANG_CONSUMER_ACCESS_BLOCKED',
        receipt: {
          status: 403,
          checkedAt,
          requestUrl: 'https://private.invalid/?token=SECRET',
          responseText: 'SECRET_BODY',
        },
      });
    },
  });
  assert.equal(blocked.status, 'blocked_403');
  assert.equal(blocked.httpStatus, 403);
  assert.equal(blocked.errorCode, 'COUPANG_CONSUMER_ACCESS_BLOCKED');
  const serialized = JSON.stringify(blocked);
  for (const forbidden of ['SECRET_ERROR_TEXT', 'SECRET_BODY', 'private.invalid', 'token=SECRET', 'requestUrl'])
    assert.equal(serialized.includes(forbidden), false);
});

test('reports blocked account quantity reads without hiding a verified public general price', async () => {
  const report = await verifyCoupangWowPrice({
    url: targetUrl,
    expectedWowPriceKrw: 11_200,
    live: true,
    readOfferList: async () => offerListResult({
      generalPrice: 13_200,
      wowStatus: 'account_wow_price_blocked',
      accountReadOverrides: {
        status: 'blocked',
        code: 'COUPANG_CONSUMER_ACCESS_BLOCKED',
        attempted: true,
        receipt: {
          checkedAt,
          operation: 'quantity_info',
          origin: 'https://www.coupang.com',
          path: '/next-api/products/quantity-info',
          method: 'GET',
          query: { productId: target.productId, vendorItemId: target.vendorItemId },
          status: 403,
          contentType: 'text/html',
          bytes: 1234,
          bodyComplete: true,
          server: 'AkamaiGHost',
          challengeConfirmed: false,
          accessDeniedTitle: true,
          dpopChallengePresent: false,
          denialSignals: { requestBlocked: true, automatedAccess: false,
            permissionDenied: true, loginPage: false, secretSignal: 'SECRET_SIGNAL' },
          transport: 'native_fetch',
          execution: 'pure_http',
          browserUsed: false,
          authenticationMode: 'protected',
          credentialSent: true,
          credentialPropagated: true,
          authenticatedOwnerVerified: null,
          applicationAuthenticated: null,
          cookieRotationApplied: false,
          cookieRotationPersisted: false,
          requestUrl: 'https://private.invalid/?cookie=SECRET',
          cookie: 'SECRET_COOKIE',
          responseText: 'SECRET_BODY',
        },
      },
    }),
  });
  assert.equal(report.status, 'account_wow_blocked_403');
  assert.equal(report.httpStatus, 200);
  assert.equal(report.accountHttpStatus, 403);
  assert.equal(report.accountContextPriceReadStatus, 'blocked');
  assert.equal(report.accountContextPriceReadCode, 'COUPANG_CONSUMER_ACCESS_BLOCKED');
  assert.equal(report.accountCredentialPropagated, true);
  assert.equal(report.ownerCredentialUsed, true);
  assert.equal(report.selectedIdentityMatched, true);
  assert.equal(report.observedGeneralPriceKrw, 13_200);
  assert.equal(report.generalPriceVerified, true);
  assert.equal(report.advertisedWowPriceKrw, null);
  assert.equal(report.advertisedWowPriceVerified, false);
  assert.equal(report.expectedWowPriceMatched, false);
  assert.equal(report.memberPriceVerified, false);
  assert.equal(report.nativeGeneralStatesVerified, true);
  assert.equal(report.nativeWowStatesVerified, false);
  assert.equal(report.passed, false);
  assert.equal(report.accountReadReceipt.operation, 'quantity_info');
  assert.equal(report.accountReadReceipt.exactRequestIdentityMatched, true);
  assert.deepEqual(report.accountReadReceipt.identityFieldsMatched, ['productId', 'vendorItemId']);
  assert.deepEqual(report.accountReadReceipt.queryKeys, ['productId', 'vendorItemId']);
  assert.equal(report.accountReadReceipt.status, 403);
  assert.equal(report.accountReadReceipt.server, 'AkamaiGHost');
  assert.equal(report.accountReadReceipt.credentialPropagated, true);
  assert.equal(report.accountReadReceipt.authenticatedOwnerVerified, null);
  assert.equal(report.accountReadReceipt.applicationAuthenticated, null);
  assert.equal(report.accountReadReceipt.cookieRotationApplied, false);
  assert.equal(report.accountReadReceipt.cookieRotationPersisted, false);
  assert.deepEqual(report.accountReadReceipt.denialSignals, {
    requestBlocked: true, automatedAccess: false, permissionDenied: true, loginPage: false,
  });
  assert.equal(report.publicReadReceipt.exactRequestIdentityMatched, true);
  assert.deepEqual(report.publicReadReceipt.identityFieldsMatched, ['productId', 'itemId', 'vendorItemId']);
  assert.deepEqual(report.publicReadReceipt.queryKeys, ['itemId', 'productId', 'selectedVendorItemId']);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('private.invalid'), false);
  assert.equal(serialized.includes('SECRET'), false);
  assert.equal(serialized.includes(target.productId), true); // The existing verifier target fields remain unchanged.
  assert.equal(report.publicReadReceipt.responseText, undefined);
  assert.equal(report.accountReadReceipt.requestUrl, undefined);
});

test('exposes only explicitly allowlisted session and account error codes', async () => {
  for (const code of ['SESSION_SCOPE', 'SESSION_ACCESS_TOKEN_EXPIRED']) {
    const known = await verifyCoupangWowPrice({
      url: targetUrl,
      live: true,
      readOfferList: async () => offerListResult({
        accountReadOverrides: { status: 'provider_unavailable', code },
      }),
    });
    assert.equal(known.accountContextPriceReadCode, code);
    assert.equal(known.passed, false);
    assert.equal(known.nativeWowStatesVerified, false);
  }

  const unknown = await verifyCoupangWowPrice({
    url: targetUrl,
    live: true,
    readOfferList: async () => offerListResult({
      accountReadOverrides: { status: 'provider_unavailable', code: 'SECRET_SESSION_DATA' },
    }),
  });
  assert.equal(unknown.accountContextPriceReadCode, null);
  assert.equal(JSON.stringify(unknown).includes('SECRET_SESSION_DATA'), false);
});

test('CLI reports a live missing WOW price without a false pass and writes only through the run receipt hook', async () => {
  const output = [];
  const errors = [];
  let writeCalls = 0;
  const oldLog = console.log;
  const oldError = console.error;
  try {
    console.log = line => output.push(String(line));
    console.error = line => errors.push(String(line));
    const code = await main([
      '--url', targetUrl, '--expected-wow-price=11200', '--live', '--write',
    ], {
      readOfferList: async () => offerListResult(),
      writeReceipt: async (report, checked) => {
        writeCalls += 1;
        assert.equal(report.status, 'wow_price_unavailable');
        assert.equal(checked, report.checkedAt);
      },
    });
    assert.equal(code, 1);
  } finally {
    console.log = oldLog;
    console.error = oldError;
  }
  assert.equal(errors.length, 0);
  assert.equal(output.length, 1);
  assert.equal(writeCalls, 1);
  const report = JSON.parse(output[0]);
  assert.equal(report.status, 'wow_price_unavailable');
  assert.equal(report.passed, false);
  assert.equal(report.observedGeneralPriceKrw, 13_200);
  assert.equal(report.advertisedWowPriceKrw, null);
  assert.equal(report.expectedWowPriceMatched, false);
  assert.equal(report.memberPriceVerified, false);
  assert.equal(report.accountContextPriceReadStatus, 'provider_missing');
  assert.equal(report.receiptWritten, true);
  assert.equal(report.ownerCredentialUsed, false);
  assert.equal(output[0].includes(targetUrl), false);
});
