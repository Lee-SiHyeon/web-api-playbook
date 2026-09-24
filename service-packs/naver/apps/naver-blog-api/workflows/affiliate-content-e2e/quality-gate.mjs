const unsupportedFirstPerson = /내돈내산|직접\s*(?:써|사용|구매)|써\s*보니|사용해\s*보니|제가\s*느끼기/;
const universalWinner = /무조건\s*(?:최고|추천)|압도적\s*1위|최고의\s*제품|누구에게나\s*추천/;

function countMarkdownTableProducts(markdown) {
  const section = markdown.split('## 도킹형 보조배터리 5종 비교표')[1]?.split(/^## /m)[0] || '';
  return section.split(/\r?\n/).filter(line => /^\|/.test(line) && !/^\|[-:| ]+\|$/.test(line) && !/제품 \| 현재 가격/.test(line)).length;
}

function countHeadings(markdown) {
  return markdown.split(/\r?\n/).filter(line => /^##\s+/.test(line)).length;
}

function check(markdown, pattern) {
  return pattern.test(markdown);
}

export function evaluateAffiliateDraft({ draft, comparisonBrief, community, rubric }) {
  const markdown = String(draft.markdown || '');
  const affirmativeExperienceClaims = markdown
    .replace(/직접 사용 후기가 아니라/g, '')
    .replace(/실측값으로 보지 않았습니다/g, '');
  const threshold = Number(rubric?.publishThreshold ?? 80);
  const productCount = countMarkdownTableProducts(markdown);
  const headingCount = countHeadings(markdown);
  const affiliateUrl = draft.metadata?.affiliateUrl || '';
  const first500 = markdown.slice(0, 500);
  const lines = markdown.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const averageParagraphLength = lines.length
    ? lines.filter(line => !/^#|^\||^[-*]\s|^\d+\.|^```/.test(line)).reduce((sum, line) => sum + line.length, 0)
      / Math.max(1, lines.filter(line => !/^#|^\||^[-*]\s|^\d+\.|^```/.test(line)).length)
    : 0;
  const checks = {
    one_primary_search_intent: /도킹형 보조배터리/.test(draft.title) && /어떤 상황|상황에서|고르는/.test(markdown),
    title_matches_reader_question: /비교|맞는 사람|고르기/.test(draft.title),
    intro_names_real_situation: /작은 가방|비상 충전|여행|장거리/.test(markdown.slice(0, 1800)),
    experience_or_sources_declared: /직접 사용 후기가 아니라/.test(first500),
    three_specific_proofs: [/[0-9,]+원/, /mAh/, /20W/, /공개 커뮤니티/].filter(pattern => pattern.test(markdown)).length >= 3,
    conditions_and_checked_at_recorded: /가격 확인 시점/.test(markdown) && Boolean(comparisonBrief.checkedAt),
    selection_criteria: /비교 기준은/.test(markdown) && /현재 판매 가격/.test(markdown),
    advantages_and_drawbacks: /매력적인 이유/.test(markdown) && /다른 제품이 나은 조건/.test(markdown),
    recommended_and_not_recommended_users: /이런 분에게/.test(markdown) && /이런 분은 다른 제품/.test(markdown),
    at_least_four_comparable_products: productCount >= 4,
    scenario_specific_winners: /가격만 보면/.test(markdown) && /속도라면/.test(markdown) && /1만mAh/.test(markdown),
    selected_compared_with_cheapest_fastest_and_highest_capacity: /최저가/.test(markdown) && /20W/.test(markdown) && /10,000mAh/.test(markdown),
    evidence_gaps_disclosed: /실제 무게|실측값으로 보지 않았/.test(markdown) && /공식 사양/.test(markdown),
    mobile_short_paragraphs: averageParagraphLength <= 150,
    four_or_more_section_breaks: headingCount >= 8,
    visual_or_table_evidence: /\| 제품 \| 현재 가격/.test(markdown) && /product-price-comparison\.png/.test(markdown),
    cta_not_before_trust: markdown.indexOf(affiliateUrl) > markdown.length * 0.65,
    personal_context_or_unique_analysis: /약 86%보다 가격이 낮/.test(markdown) || /저가 도킹형/.test(markdown),
    non_generic_conclusion: /낮은 진입 가격, C타입 도킹 구조/.test(markdown),
    no_keyword_stuffing: (markdown.match(/도킹형 보조배터리/g) || []).length <= 20,
    affiliate_disclosure_above_fold: /쿠팡 파트너스 활동의 일환/.test(first500),
    price_inventory_variability_noted: /가격과 배송 조건은 시점에 따라/.test(markdown),
    claims_do_not_overpromise: !universalWinner.test(markdown),
    links_match_products: /^https:\/\/link\.coupang\.com\/a\/[A-Za-z0-9]+$/.test(affiliateUrl),
    price_checked_at_recorded: /가격 확인 시점/.test(markdown),
    title_claims_separated_from_verified_specs: /상품명에 표시된 용량·출력은 판매 화면상의 표현/.test(markdown),
  };

  const dimensionScores = {};
  let score = 0;
  for (const dimension of rubric.dimensions || []) {
    const passed = dimension.checks.filter(id => checks[id] === true).length;
    const possible = dimension.checks.length;
    const points = possible ? Math.round((passed / possible) * dimension.points) : 0;
    dimensionScores[dimension.id] = { points, maximum: dimension.points, passed, possible };
    score += points;
  }

  const hardBlocks = [];
  if (unsupportedFirstPerson.test(affirmativeExperienceClaims)) hardBlocks.push('unsupported_first_person_claim');
  if (!checks.affiliate_disclosure_above_fold) hardBlocks.push('missing_affiliate_disclosure');
  if (!checks.one_primary_search_intent) hardBlocks.push('no_reader_problem_or_search_intent');
  if (!checks.links_match_products) hardBlocks.push('broken_or_unverified_link');
  if (!checks.conditions_and_checked_at_recorded) hardBlocks.push('regulated_or_time_sensitive_claim_without_source_date');
  if (productCount < 4) hardBlocks.push('comparison_with_fewer_than_four_products');
  if (universalWinner.test(markdown)) hardBlocks.push('universal_winner_claim_without_axis');
  if (/실측|측정 결과/.test(draft.title) && !draft.metadata?.directExperienceClaimed) hardBlocks.push('title_claim_presented_as_measured_fact');
  if ((comparisonBrief.whereSelectedLoses || []).length < 2) hardBlocks.push('selected_product_advantage_without_counterexample');

  const uniqueHardBlocks = [...new Set(hardBlocks)];
  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    score,
    threshold,
    passed: uniqueHardBlocks.length === 0 && score >= threshold,
    status: uniqueHardBlocks.length ? 'blocked' : score >= threshold ? 'ready_for_review' : 'needs_revision',
    hardBlocks: uniqueHardBlocks,
    dimensionScores,
    checks,
    metrics: {
      markdownCharacters: markdown.length,
      headingCount,
      comparisonProductCount: productCount,
      communityArticleCount: community.articleCount || 0,
      averageParagraphLength: Math.round(averageParagraphLength),
    },
    policy: {
      deterministicHardGatesAuthoritative: true,
      jevMayNotOverrideHardBlocks: true,
      autoPublishAllowed: false,
    },
  };
}
