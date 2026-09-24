const HIGH_RISK_RULES = Object.freeze([
  {
    id: 'medical_or_health',
    pattern: /감기|몸살|질병|증상|진단|치료|수술|약(?:품|물)?|영양제|보충제|암|임신|정자|혈압|당뇨|통증|다이어트약|건강기능식품/i,
  },
  {
    id: 'financial_or_tax',
    pattern: /투자|주식|코인|가상자산|수익률|세금|절세|대출|보험|연금|상속|증여/i,
  },
  {
    id: 'legal',
    pattern: /법률|소송|고소|고발|처벌|합의금|계약 분쟁|이혼|형사|민사/i,
  },
  {
    id: 'regulated_product',
    pattern: /담배|전자담배|니코틴|술|주류|대마|마약|도박|총기|무기/i,
  },
]);

const TOPIC_STOPWORDS = new Set([
  '추천', '비교', '후기', '리뷰', '제품', '상품', '구매', '가이드', '정리', '가격', '가성비',
  'best', 'vs', '사용', '선택', '사람', '이유', '어떤', '좋은', '최고',
]);

function normalize(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^0-9a-z가-힣]+/gu, '');
}

function tokens(value) {
  return [...new Set(String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^0-9a-z가-힣]+/gu)
    .map(token => token.trim())
    .filter(token => token.length >= 2 && !TOPIC_STOPWORDS.has(token)))];
}

export function classifyWorkflowRisk(value) {
  const topic = String(value || '').trim();
  const matchedRules = HIGH_RISK_RULES.filter(rule => rule.pattern.test(topic)).map(rule => rule.id);
  return {
    topic,
    allowed: matchedRules.length === 0,
    riskLevel: matchedRules.length ? 'high' : 'standard',
    matchedRules,
    requiredWorkflow: matchedRules.length ? 'specialized_evidence_and_compliance_workflow' : 'affiliate_content_e2e',
    reason: matchedRules.length
      ? 'The generic affiliate workflow may not create health, financial, legal or regulated-product advice.'
      : 'No high-risk topic rule matched.',
  };
}

export function assessFreshness(checkedAt, { now = new Date(), maxAgeHours = 24 } = {}) {
  const timestamp = Date.parse(String(checkedAt || ''));
  const current = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const validTimestamp = Number.isFinite(timestamp) && Number.isFinite(current);
  const ageHours = validTimestamp ? Math.max(0, (current - timestamp) / 3_600_000) : null;
  return {
    validTimestamp,
    checkedAt: validTimestamp ? new Date(timestamp).toISOString() : null,
    ageHours: ageHours === null ? null : Math.round(ageHours * 100) / 100,
    maxAgeHours,
    fresh: validTimestamp && ageHours <= maxAgeHours,
  };
}

export function trendContainsSeed(trend, seed) {
  const target = normalize(seed);
  if (!target) return false;
  return (trend?.seedExpansions || []).some(group => {
    const candidate = normalize(group?.seed);
    return candidate === target || candidate.includes(target) || target.includes(candidate);
  });
}

export function assessTrendInput(trend, seed, options = {}) {
  const freshness = assessFreshness(trend?.checkedAt, options);
  const hasSeed = trendContainsSeed(trend, seed);
  return {
    ...freshness,
    hasSeed,
    usable: freshness.fresh && hasSeed,
  };
}

export function compactTrendData(trend, seed) {
  const target = normalize(seed);
  const relevantGroups = (trend?.seedExpansions || []).filter(group => {
    const candidate = normalize(group?.seed);
    return candidate === target || candidate.includes(target) || target.includes(candidate);
  });
  const relevantKeywords = new Set(relevantGroups.flatMap(group => [group.seed, ...(group.suggestions || []).map(item => item.keyword)]).map(normalize));
  const matches = item => {
    const keyword = normalize(item?.keyword);
    return keyword && (relevantKeywords.has(keyword) || keyword.includes(target) || target.includes(keyword));
  };
  return {
    schemaVersion: trend?.schemaVersion ?? 1,
    checkedAt: trend?.checkedAt ?? null,
    mode: trend?.mode ?? null,
    options: {
      seeds: relevantGroups.map(group => group.seed),
      timeUnits: trend?.options?.timeUnits || [],
    },
    coverage: trend?.coverage || {},
    sourceStates: trend?.sourceStates || {},
    seedExpansions: relevantGroups,
    longTailOpportunities: (trend?.longTailOpportunities || []).filter(matches).slice(0, 50),
    contentIdeas: (trend?.contentIdeas || []).filter(matches).slice(0, 50),
    credentialsPersisted: trend?.credentialsPersisted === true,
    browserUsedForNormalExecution: trend?.browserUsedForNormalExecution === true,
  };
}

export function assessTopicProductRelevance({ topic, seed, comparison } = {}) {
  const topicText = [topic, seed].filter(Boolean).join(' ');
  const productText = [
    comparison?.query,
    comparison?.selectedProduct?.title,
    ...(comparison?.products || []).slice(0, 30).map(product => product?.title),
  ].filter(Boolean).join(' ');
  const topicNormalized = normalize(topicText);
  const queryNormalized = normalize(comparison?.query);
  const topicTokens = tokens(topicText);
  const productTokens = new Set(tokens(productText));
  const sharedTokens = topicTokens.filter(token => productTokens.has(token));
  const directMatch = Boolean(queryNormalized)
    && (topicNormalized.includes(queryNormalized) || queryNormalized.includes(topicNormalized));
  const coverage = topicTokens.length ? sharedTokens.length / topicTokens.length : 0;
  const relevant = directMatch || sharedTokens.length >= 1 && coverage >= 0.34;
  return {
    relevant,
    topic: String(topic || ''),
    seed: String(seed || ''),
    productQuery: String(comparison?.query || ''),
    directMatch,
    topicTokens,
    sharedTokens,
    coverage: Math.round(coverage * 1000) / 1000,
    reason: relevant
      ? 'The topic shares a specific product-family signal with the comparison dataset.'
      : 'The selected topic does not match the product comparison dataset.',
  };
}
