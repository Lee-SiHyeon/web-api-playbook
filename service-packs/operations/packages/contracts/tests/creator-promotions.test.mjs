import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPromotionGraph,
  extractPromotionClaims,
  validatePromotionGraph,
} from '../src/creator-promotions.mjs';

const NOW = '2026-10-05T12:10:00Z';
const PRODUCT_URL = 'https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=G12345&variantId=option-1';

function video(overrides = {}) {
  const description = `제품 콜라보 안내. 쿠폰 코드는 CREATOR20이고 20% 할인 기간은 공식 페이지를 확인하세요. ${PRODUCT_URL}`;
  const linkStart = description.indexOf(PRODUCT_URL);
  return {
    videoId: 'video-001',
    channelId: 'UCcreator001',
    channelTitle: '뷰티 크리에이터 채널',
    title: '브랜드와 함께 만든 제품, 20% 할인 쿠폰 코드: CREATOR20',
    description,
    publishedAt: '2026-10-01T08:00:00Z',
    observedAt: '2026-10-05T12:00:00Z',
    sourceUrl: 'https://www.youtube.com/watch?v=video-001',
    sourceReceipt: { httpStatus: 200, responseHash: 'a'.repeat(64) },
    productReferences: [{
      provider: 'oliveyoung', productId: 'G12345', variantId: 'option-1', market: 'KR', productUrl: PRODUCT_URL,
      sourceField: 'description', start: linkStart, end: linkStart + PRODUCT_URL.length,
    }],
    ...overrides,
  };
}

function merchant(overrides = {}) {
  const sourceUrl = 'https://www.oliveyoung.co.kr/api/promotion/G12345';
  return {
    provider: 'oliveyoung',
    productId: 'G12345',
    variantId: 'option-1',
    market: 'KR',
    currency: 'KRW',
    title: '상품 G12345',
    brand: 'Fixture Beauty',
    canonicalProductUrl: PRODUCT_URL,
    sourceUrl,
    checkedAt: '2026-10-05T12:02:00Z',
    validFrom: '2026-10-01T00:00:00Z',
    validThrough: '2026-10-31T23:59:59Z',
    active: true,
    price: 8000,
    listedPrice: 10000,
    discountPercent: 20,
    promoCode: 'CREATOR20',
    priceBasis: 'coupon_payable',
    eligibilityStatus: 'known',
    eligibility: {
      couponRequired: true,
      membershipRequired: false,
      eligibleMarkets: ['KR'],
      termsObserved: 'One coupon per account; eligible item only.',
    },
    sourceReceipt: {
      sourceType: 'merchant_first_party_offer',
      officialFirstParty: true,
      httpStatus: 200,
      sourceUrl,
      responseHash: 'b'.repeat(64),
    },
    ...overrides,
  };
}

function nodesByType(result, type) {
  return result.graph['@graph'].filter(node => (Array.isArray(node['@type']) ? node['@type'] : [node['@type']]).includes(type));
}

function trustedFixtureCallbacks(videos = [], offers = []) {
  const trustedVideos = new WeakSet(videos);
  const trustedOffers = new WeakSet(offers);
  return {
    trustedVideoVerifier: (raw, normalized) => trustedVideos.has(raw)
      && raw.videoId === normalized.videoId && raw.channelId === normalized.channelId
      && (raw.sourceReceipt?.httpStatus ?? raw.sourceReceipt?.status) === 200,
    trustedMerchantVerifier: (raw, normalized) => trustedOffers.has(raw)
      && raw.provider === normalized.provider && raw.productId === normalized.productId
      && raw.variantId === normalized.variantId && raw.market === normalized.market
      && (raw.sourceReceipt?.httpStatus ?? raw.sourceReceipt?.status) === 200
      && /^[a-f0-9]{64}$/i.test(raw.sourceReceipt?.responseHash ?? ''),
  };
}

function buildTrusted(input) {
  const proof = trustedFixtureCallbacks(input.videos, input.merchantObservations ?? []);
  return buildPromotionGraph({ ...input, ...proof });
}

function extractTrusted(row) {
  return extractPromotionClaims(row, { trustedVideoVerifier: trustedFixtureCallbacks([row]).trustedVideoVerifier });
}

test('extracts attributed discount and collaboration claims without declaring either verified', () => {
  const extracted = extractTrusted(video());
  assert.equal(extracted.creator.displayName, '뷰티 크리에이터 채널');
  assert.equal(extracted.creator.platformAccountId, 'UCcreator001');
  assert.equal(extracted.announcements.length, 1);
  const announcement = extracted.announcements[0];
  assert.equal(announcement.kind, 'discount_and_collaboration');
  assert.equal(announcement.verificationStatus, 'unverified_announcement');
  assert.equal(announcement.validityStatus, 'unknown');
  assert.deepEqual(announcement.reportedPromoCodes, ['CREATOR20']);
  assert.deepEqual(announcement.reportedDiscountPercents, [20]);
  assert.equal(announcement.claim.support, 'supports');
  assert.ok(announcement.excerpt.length <= 240);
  assert.ok(extracted.sourceEvidence.sourceSpans.every(span => span.excerpt.length <= 240));
  assert.match(extracted.sourceEvidence.independence_cluster, /UCcreator001:video-001/);
  assert.equal(Object.hasOwn(extracted.content, 'description'), false);
});

test('merchant verification requires exact linked product variant, market, price, dates and known eligibility', () => {
  const result = buildTrusted({ videos: [video()], merchantObservations: [merchant()], generatedAt: NOW });
  const creatorPromotion = nodesByType(result, 'Promotion').find(node => node.announcementStatus === 'unverified_announcement');
  const merchantPromotion = nodesByType(result, 'Promotion').find(node => node.announcementStatus === 'merchant_observation');
  assert.equal(creatorPromotion.verificationStatus, 'merchant_verified');
  assert.equal(creatorPromotion.validityStatus, 'active');
  assert.equal(merchantPromotion.verificationStatus, 'merchant_verified');
  assert.equal(merchantPromotion.validityStatus, 'active');
  assert.equal(merchantPromotion.active, true);
  assert.equal(merchantPromotion.price, 8000);
  assert.equal(merchantPromotion.priceCurrency, 'KRW');
  assert.equal(nodesByType(result, 'Collaboration')[0].verificationStatus, 'unverified_announcement');
  assert.equal(result.productCandidates[0].payablePriceKrw, 8000);
  assert.deepEqual(result.productCandidates[0].evidenceRefs, [result.sourceEvidence.find(item => item.source_type === 'merchant_first_party_offer')['@id']]);
  assert.equal(result.claims[0].support, 'supports');
  assert.equal(validatePromotionGraph(result), true);
});

test('caller-supplied status booleans and hashes never verify claims or offers without trusted callbacks', () => {
  const imported = video();
  const extracted = extractPromotionClaims(imported);
  assert.equal(extracted.announcements[0].claim.support, 'uncertain');
  assert.equal(extracted.content.productReferences[0].sourcePointerStatus, 'caller_supplied_unverified');
  assert.equal(extracted.content.productReferences[0].sourceBound, false);
  const result = buildPromotionGraph({ videos: [imported], merchantObservations: [merchant()], generatedAt: NOW });
  const creatorPromotion = nodesByType(result, 'Promotion').find(node => node.announcementStatus === 'unverified_announcement');
  const merchantPromotion = nodesByType(result, 'Promotion').find(node => node.announcementStatus === 'merchant_observation');
  assert.equal(creatorPromotion.verificationStatus, 'unverified_announcement');
  assert.equal(merchantPromotion.verificationStatus, 'unverified_announcement');
  assert.equal(merchantPromotion.active, false);
  assert.equal(result.claims[0].support, 'uncertain');
});

test('merchant observation without a receipt is retained as unverified rather than requiring an SDK receipt shape', () => {
  const observation = merchant({ sourceReceipt: undefined });
  const result = buildPromotionGraph({ videos: [video()], merchantObservations: [observation], generatedAt: NOW });
  const merchantPromotion = nodesByType(result, 'Promotion').find(node => node.announcementStatus === 'merchant_observation');
  assert.equal(merchantPromotion.verificationStatus, 'unverified_announcement');
  assert.equal(merchantPromotion.validityStatus, 'unknown');
  assert.equal(merchantPromotion.active, false);
  assert.equal(Object.hasOwn(result.productCandidates[0], 'payablePrice'), false);
  assert.deepEqual(result.productCandidates[0].observedPrice, { amount: 8000, currency: 'KRW' });
  assert.ok(result.sourceEvidence.some(item => item.source_type === 'merchant_offer_candidate'));
});

test('official first-party verification is origin-bound and permits reviewed split-origin providers', () => {
  const splitOriginObservation = merchant({
    sourceUrl: 'https://api.oliveyoung.co.kr/api/promotion/G12345',
    sourceReceipt: {
      officialFirstParty: true,
      httpStatus: 200,
      sourceUrl: 'https://api.oliveyoung.co.kr/api/promotion/G12345',
      responseHash: 'd'.repeat(64),
    },
  });
  const withoutAllowlist = buildTrusted({ videos: [video()], merchantObservations: [splitOriginObservation], generatedAt: NOW });
  assert.equal(nodesByType(withoutAllowlist, 'Promotion').find(node => node.announcementStatus === 'merchant_observation').verificationStatus, 'unverified_announcement');

  const withAllowlist = buildTrusted({
    videos: [video()], merchantObservations: [splitOriginObservation], generatedAt: NOW,
    officialOriginAllowlist: { oliveyoung: ['https://api.oliveyoung.co.kr', 'https://www.oliveyoung.co.kr'] },
  });
  assert.equal(nodesByType(withAllowlist, 'Promotion').find(node => node.announcementStatus === 'merchant_observation').verificationStatus, 'merchant_verified');
});

test('variant or market mismatch cannot verify a creator announcement', () => {
  const wrongVariant = buildTrusted({
    videos: [video()], merchantObservations: [merchant({ variantId: 'option-2' })], generatedAt: NOW,
  });
  const promo = nodesByType(wrongVariant, 'Promotion').find(node => node.announcementStatus === 'unverified_announcement');
  assert.equal(promo.verificationStatus, 'unverified_announcement');
  assert.equal(wrongVariant.diagnostics.unmatchedMerchantObservations, 1);

  const wrongMarket = buildTrusted({
    videos: [video()], merchantObservations: [merchant({ market: 'US', currency: 'USD', eligibility: { couponRequired: true, membershipRequired: false, eligibleMarkets: ['US'], termsObserved: 'US only' } })], generatedAt: NOW,
  });
  assert.equal(nodesByType(wrongMarket, 'Promotion').find(node => node.announcementStatus === 'unverified_announcement').verificationStatus, 'unverified_announcement');
});

test('expired and stale merchant snapshots are never labeled active', () => {
  const expired = buildTrusted({
    videos: [video()], merchantObservations: [merchant({ validThrough: '2026-10-05T12:09:59Z' })], generatedAt: NOW,
  });
  const expiredOffer = nodesByType(expired, 'Promotion').find(node => node.announcementStatus === 'merchant_observation');
  assert.equal(expiredOffer.validityStatus, 'expired');
  assert.equal(expiredOffer.active, false);

  const stale = buildTrusted({
    videos: [video()], merchantObservations: [merchant({ checkedAt: '2026-10-01T00:00:00Z' })], generatedAt: NOW, freshnessMs: 60_000,
  });
  const staleOffer = nodesByType(stale, 'Promotion').find(node => node.announcementStatus === 'merchant_observation');
  assert.equal(staleOffer.validityStatus, 'stale');
  assert.equal(staleOffer.active, false);
  assert.equal(staleOffer.verificationStatus, 'unverified_announcement');
});

test('missing validity or eligibility keeps a matched offer unknown and unverified', () => {
  const result = buildTrusted({
    videos: [video()], merchantObservations: [merchant({ validThrough: undefined, eligibilityStatus: 'unknown', eligibility: undefined })], generatedAt: NOW,
  });
  const offer = nodesByType(result, 'Promotion').find(node => node.announcementStatus === 'merchant_observation');
  assert.equal(offer.validityStatus, 'unknown');
  assert.equal(offer.eligibilityStatus, 'unknown');
  assert.equal(offer.verificationStatus, 'unverified_announcement');
  assert.equal(offer.active, false);
});

test('negative announcement text remains uncertain and cannot be verified by a merchant offer', () => {
  const negated = video({ title: '브랜드 콜라보 아님, 할인 없습니다', description: '추천 제품입니다.' });
  const extracted = extractPromotionClaims(negated);
  assert.equal(extracted.announcements[0].polarity, 'negated_or_ambiguous');
  assert.equal(extracted.announcements[0].claim.support, 'uncertain');
  const result = buildTrusted({ videos: [negated], merchantObservations: [merchant()], generatedAt: NOW });
  assert.equal(nodesByType(result, 'Promotion').find(node => node.announcementStatus === 'unverified_announcement').verificationStatus, 'unverified_announcement');
  assert.equal(nodesByType(result, 'Collaboration')[0].polarity, 'negated_or_ambiguous');
});

test('recommendation language alone does not create a collaboration or promotion', () => {
  const extracted = extractPromotionClaims(video({ title: '제가 추천하는 신제품 리뷰', description: '정말 좋은 제품입니다.' }));
  assert.equal(extracted.announcements.length, 0);
  assert.equal(extracted.diagnostics.recommendationOnly, true);
});

test('evidence excerpts redact contact details and links while preserving source pointers', () => {
  const extracted = extractPromotionClaims(video({
    title: '20% 할인 쿠폰 문의 jane@example.com 010-1234-5678 https://example.com/private?token=secret',
    description: '', productReferences: undefined,
  }));
  const serialized = JSON.stringify(extracted);
  assert.equal(serialized.includes('jane@example.com'), false);
  assert.equal(serialized.includes('010-1234-5678'), false);
  assert.equal(serialized.includes('token=secret'), false);
  assert.equal(extracted.content.title.includes('jane@example.com'), false);
  assert.ok(extracted.sourceEvidence.sourceSpans[0].redacted);
  assert.ok(extracted.sourceEvidence.sourceSpans[0].end > extracted.sourceEvidence.sourceSpans[0].start);
});

test('same video returned by multiple queries deduplicates while keeping a shared channel identity', () => {
  const result = buildPromotionGraph({ videos: [video(), video()], generatedAt: NOW });
  assert.equal(result.diagnostics.duplicateVideos, 1);
  assert.equal(nodesByType(result, 'Creator').length, 1);
  assert.equal(nodesByType(result, 'Content').length, 1);
  assert.equal(result.sourceEvidence.length, 1);
  assert.equal(result.claims.length, 1);
});

test('tracking parameters are stripped and opaque short links are not resolved or joined', () => {
  const opaque = video({
    description: '제품 20% 할인 https://coupa.ng/abc123?utm_source=youtube',
    productReferences: [{
      provider: 'oliveyoung', productId: 'G12345', variantId: 'option-1', market: 'KR',
      productUrl: 'https://coupa.ng/abc123?utm_source=youtube', sourceField: 'description', start: 15, end: 58,
    }],
  });
  const result = buildTrusted({ videos: [opaque], merchantObservations: [merchant()], generatedAt: NOW });
  assert.equal(result.diagnostics.rejectedLinks, 1);
  assert.equal(result.diagnostics.unmatchedMerchantObservations, 1);
  assert.equal(nodesByType(result, 'Promotion').find(node => node.announcementStatus === 'unverified_announcement').verificationStatus, 'unverified_announcement');
});

test('invented source pointers and multiple coupon codes cannot verify an exact offer', () => {
  const wrongPointer = video({ productReferences: [{
    provider: 'oliveyoung', productId: 'G12345', variantId: 'option-1', market: 'KR',
    productUrl: PRODUCT_URL, sourceField: 'description', start: 0, end: PRODUCT_URL.length,
  }] });
  const pointerResult = buildTrusted({ videos: [wrongPointer], merchantObservations: [merchant()], generatedAt: NOW });
  assert.equal(pointerResult.diagnostics.unmatchedMerchantObservations, 1);
  assert.equal(nodesByType(pointerResult, 'Promotion').find(node => node.announcementStatus === 'unverified_announcement').verificationStatus, 'unverified_announcement');

  const ambiguous = video({
    title: '20% 할인 쿠폰 코드: CREATOR20 그리고 쿠폰 코드: SECOND20',
  });
  const ambiguousResult = buildTrusted({ videos: [ambiguous], merchantObservations: [merchant()], generatedAt: NOW });
  assert.equal(ambiguousResult.diagnostics.unmatchedMerchantObservations, 1);
  assert.equal(nodesByType(ambiguousResult, 'Promotion').find(node => node.announcementStatus === 'unverified_announcement').verificationStatus, 'unverified_announcement');
});

test('unsafe URLs and incomplete or invented dates fail closed', () => {
  assert.throws(() => extractPromotionClaims(video({ sourceUrl: 'javascript:alert(1)' })), /public HTTPS URL/);
  assert.throws(() => extractPromotionClaims(video({ sourceUrl: 'https://youtube.com.evil.test/watch?v=video-001' })), /public HTTPS URL/);
  assert.throws(() => extractPromotionClaims(video({ sourceUrl: 'https://user@www.youtube.com/watch?v=video-001' })), /public HTTPS URL/);
  assert.throws(() => extractPromotionClaims(video({ publishedAt: '2026-10-01' })), /full ISO timestamp/);
  assert.throws(() => buildPromotionGraph({ videos: [], generatedAt: '2026-02-31T00:00:00Z' }), /valid ISO timestamp/);
});

test('unknown and coerced price values cannot become zero-valued merchant prices', () => {
  for (const price of [null, '', '   ', false, true, 'NaN', '1,000']) {
    assert.throws(() => buildPromotionGraph({
      videos: [], merchantObservations: [merchant({ price })], generatedAt: NOW,
    }), /plain decimal string|nonnegative number/);
  }
});

test('same capture time with conflicting source content and duplicate video identity fail closed', () => {
  assert.throws(() => buildPromotionGraph({
    videos: [video(), video({ title: 'New title', description: '20% 할인', productReferences: undefined, sourceReceipt: { httpStatus: 200, responseHash: 'c'.repeat(64) } })], generatedAt: NOW,
  }), /conflicting source content/);
  assert.throws(() => buildPromotionGraph({ videos: [video(), video({ channelId: 'UCother' })], generatedAt: NOW }), /conflicting creator identity/);
});
