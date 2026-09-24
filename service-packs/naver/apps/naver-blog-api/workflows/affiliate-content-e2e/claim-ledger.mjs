function asIso(value, fallback = new Date()) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback.toISOString() : date.toISOString();
}

function addHours(value, hours) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  date.setHours(date.getHours() + hours);
  return date.toISOString();
}

export function buildWorkflowClaimLedger({ productReceipt, communityReceipt, referenceReceipt, trendReceipt }) {
  const comparison = productReceipt?.comparison || {};
  const brief = productReceipt?.brief || {};
  const selected = brief?.selectedProduct || comparison?.selectedProduct || null;
  const products = brief?.comparisonProducts || comparison?.products || [];
  const checkedAt = comparison?.checkedAt || brief?.checkedAt || new Date().toISOString();
  const priceExpiresAt = addHours(checkedAt, 24);
  const communityCheckedAt = communityReceipt?.data?.checkedAt || checkedAt;
  const referenceCheckedAt = referenceReceipt?.data?.checkedAt || checkedAt;
  const trendCheckedAt = trendReceipt?.data?.checkedAt || checkedAt;

  const evidence = {
    E_PRODUCT: {
      type: 'price_observation',
      source: 'normalized affiliate product comparison',
      checkedAt: asIso(checkedAt),
      digest: productReceipt?.sourceDigests?.comparison || null,
      fields: ['title', 'salePriceKrw', 'capacityMah', 'powerW', 'connector', 'bundleQuantity'],
    },
    E_COMMUNITY: {
      type: 'community_report',
      source: 'public community search metadata',
      checkedAt: asIso(communityCheckedAt),
      articleCount: communityReceipt?.data?.articleCount || 0,
      mode: communityReceipt?.data?.mode || null,
    },
    E_REFERENCE: {
      type: 'search_result_structure',
      source: 'current Naver Blog public reference brief',
      checkedAt: asIso(referenceCheckedAt),
      postCount: referenceReceipt?.data?.summary?.postCount || 0,
    },
    E_TREND: {
      type: 'search_result_structure',
      source: 'API-only trend radar',
      checkedAt: asIso(trendCheckedAt),
      mode: trendReceipt?.data?.mode || null,
    },
  };

  const claims = [];
  if (selected) {
    claims.push({
      claimId: 'C_SELECTED_PRICE',
      text: `${selected.title}의 관측 가격은 ${selected.salePriceKrw}원이다.`,
      support: 'supports',
      sources: ['E_PRODUCT'],
      claimType: 'price_observation',
      expiresAt: priceExpiresAt,
      publishable: true,
    });
  }
  claims.push(
    {
      claimId: 'C_COHORT',
      text: `비교 후보는 ${products.length}개다.`,
      support: products.length >= 4 ? 'supports' : 'not_addressed',
      sources: ['E_PRODUCT'],
      claimType: products.length >= 4 ? 'comparison_scope' : 'uncertainty',
      publishable: products.length >= 4,
      ...(products.length >= 4 ? {} : { allowedWording: '현재 비교 후보가 충분하지 않아 결론을 보류한다.' }),
    },
    {
      claimId: 'C_COMMUNITY_BOUNDARY',
      text: '커뮤니티 문서 수는 반복 질문의 소재 신호이며 결함률이나 전체 구매자 합의가 아니다.',
      support: 'supports',
      sources: ['E_COMMUNITY'],
      claimType: 'community_report',
      publishable: true,
    },
    {
      claimId: 'C_DIRECT_EXPERIENCE',
      text: '직접 사용 경험은 확인되지 않았다.',
      support: 'not_addressed',
      sources: ['E_PRODUCT', 'E_COMMUNITY'],
      claimType: 'uncertainty',
      allowedWording: '이 글은 직접 사용 후기가 아니라 공개 가격·사양·검색 자료를 비교한 구매 가이드다.',
      forbiddenWording: '직접 써보니',
      publishable: false,
    },
  );

  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    evidence,
    claims,
  };
}
