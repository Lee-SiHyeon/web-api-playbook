const clamp = (value, minimum = 0, maximum = 100) => Math.max(minimum, Math.min(maximum, value));

const buyerPatterns = [
  /추천|비교|후기|리뷰|가성비|가격|순위|베스트|best|내돈내산|브랜드|할인/i,
  /구매|선택|고르는|어떤.*좋|뭐가.*좋/i,
];
const problemPatterns = [
  /기내|비행기|규정|폐기|버리는|발열|고장|호환|케이스|충전.*안|안.*충전|수리|주의/i,
  /사용법|계산|차이|단점|후회|위험|안전성|KC인증/i,
];

function quality(rank) {
  return clamp((11 - Number(rank)) / 10, 0, 1);
}

export function scoreRankSeries(periods, keyword) {
  if (!Array.isArray(periods) || !periods.length) {
    return { score: 0, persistence: 0, momentum: 0, novelty: false, appearances: 0 };
  }
  const values = periods.map(period => {
    const found = period.ranks.find(rank => rank.keyword === keyword);
    return found ? quality(found.rank) : 0;
  });
  const weights = values.map((_, index) => 0.78 ** (values.length - index - 1));
  const weighted = values.reduce((sum, value, index) => sum + value * weights[index], 0)
    / weights.reduce((sum, value) => sum + value, 0);
  const appearances = values.filter(value => value > 0).length;
  const persistence = appearances / values.length;
  const sample = Math.min(3, values.length);
  const recent = values.slice(-sample).reduce((sum, value) => sum + value, 0) / sample;
  const older = values.slice(0, sample).reduce((sum, value) => sum + value, 0) / sample;
  const momentum = recent - older;
  const oldestHalf = values.slice(0, Math.max(1, Math.floor(values.length / 2)));
  const novelty = values.slice(-2).some(value => value > 0) && oldestHalf.every(value => value === 0);
  const score = clamp(100 * (
    weighted * 0.55
    + persistence * 0.25
    + ((momentum + 1) / 2) * 0.15
    + (novelty ? 1 : 0) * 0.05
  ));
  return {
    score: Math.round(score),
    persistence: Number(persistence.toFixed(3)),
    momentum: Number(momentum.toFixed(3)),
    novelty,
    appearances,
    latestRank: (() => {
      for (let index = periods.length - 1; index >= 0; index--) {
        const found = periods[index].ranks.find(rank => rank.keyword === keyword);
        if (found) return found.rank;
      }
      return null;
    })(),
  };
}

export function scoreShoppingTrends(collection) {
  const units = new Map();
  for (const result of collection.results || []) {
    const key = `${result.categoryId}|${result.categoryName}`;
    if (!units.has(key)) units.set(key, { categoryId: result.categoryId, categoryName: result.categoryName, byUnit: new Map() });
    units.get(key).byUnit.set(result.timeUnit, result.periods);
  }
  const rows = [];
  for (const category of units.values()) {
    const keywords = new Set();
    for (const periods of category.byUnit.values()) {
      for (const period of periods) for (const rank of period.ranks) keywords.add(rank.keyword);
    }
    for (const keyword of keywords) {
      const horizons = {};
      for (const [timeUnit, periods] of category.byUnit) horizons[timeUnit] = scoreRankSeries(periods, keyword);
      const weights = { date: 0.5, week: 0.3, month: 0.2 };
      const active = Object.entries(horizons);
      const denominator = active.reduce((sum, [unit]) => sum + (weights[unit] || 0), 0) || 1;
      const score = active.reduce((sum, [unit, value]) => sum + value.score * (weights[unit] || 0), 0) / denominator;
      rows.push({
        keyword,
        categoryId: category.categoryId,
        categoryName: category.categoryName,
        score: Math.round(score),
        horizons,
      });
    }
  }
  const aggregate = new Map();
  for (const row of rows) {
    if (!aggregate.has(row.keyword)) aggregate.set(row.keyword, { keyword: row.keyword, categories: [], categoryScores: [] });
    const item = aggregate.get(row.keyword);
    item.categories.push({ id: row.categoryId, name: row.categoryName, score: row.score, horizons: row.horizons });
    item.categoryScores.push(row.score);
  }
  return [...aggregate.values()].map(item => {
    const max = Math.max(...item.categoryScores);
    const average = item.categoryScores.reduce((sum, value) => sum + value, 0) / item.categoryScores.length;
    const crossCategoryBonus = Math.min(10, Math.max(0, item.categories.length - 1) * 3);
    return {
      keyword: item.keyword,
      score: Math.round(clamp(max * 0.75 + average * 0.25 + crossCategoryBonus)),
      categoryCount: item.categories.length,
      categories: item.categories.sort((a, b) => b.score - a.score),
    };
  }).sort((a, b) => b.score - a.score || a.keyword.localeCompare(b.keyword, 'ko'));
}

export function classifyAutocomplete(keyword, seed, rank) {
  const buyerIntent = buyerPatterns.some(pattern => pattern.test(keyword));
  const problemIntent = problemPatterns.some(pattern => pattern.test(keyword));
  const numericSpecificity = /\d/.test(keyword);
  const differsFromSeed = keyword.replace(/\s+/g, '') !== seed.replace(/\s+/g, '');
  const intentScore = clamp(
    (11 - rank) * 5
    + (buyerIntent ? 25 : 0)
    + (problemIntent ? 20 : 0)
    + (numericSpecificity ? 8 : 0)
    + (differsFromSeed ? 5 : 0)
  );
  return {
    buyerIntent,
    problemIntent,
    numericSpecificity,
    intentScore: Math.round(intentScore),
    tags: [
      buyerIntent ? 'buyer_intent' : null,
      problemIntent ? 'problem_intent' : null,
      numericSpecificity ? 'numeric_specificity' : null,
    ].filter(Boolean),
  };
}

function semanticDrift(keyword, seed, categoryNames) {
  const categories = new Set(categoryNames || []);
  if (categories.has('패션의류') && /원피스/.test(seed) && /애니|만화|피규어|\d+화/.test(keyword)) return true;
  if (categories.has('도서') && /원피스/.test(seed) && /여성|여름|롱|미니|쇼핑몰/.test(keyword)) return true;
  return false;
}

export function buildLongTailOpportunities(autocompleteCollection, shoppingRows, { explicitSeeds = [] } = {}) {
  const shoppingMap = new Map(shoppingRows.map(item => [item.keyword, item]));
  const explicit = new Set(explicitSeeds);
  const output = new Map();
  for (const result of autocompleteCollection.results || []) {
    const shopping = shoppingMap.get(result.seed);
    const inherited = shopping?.score || (explicit.has(result.seed) ? 50 : 35);
    const categoryNames = shopping?.categories?.map(category => category.name) || [];
    for (const suggestion of result.suggestions) {
      const classification = classifyAutocomplete(suggestion.keyword, result.seed, suggestion.rank);
      const drift = semanticDrift(suggestion.keyword, result.seed, categoryNames);
      const opportunityScore = Math.round(clamp(inherited * 0.55 + classification.intentScore * 0.45 - (drift ? 45 : 0)));
      const current = output.get(suggestion.keyword);
      const record = {
        keyword: suggestion.keyword,
        seed: result.seed,
        autocompleteRank: suggestion.rank,
        inheritedShoppingScore: inherited,
        opportunityScore,
        categoryNames,
        semanticDrift: drift,
        ...classification,
      };
      if (!current || record.opportunityScore > current.opportunityScore) output.set(suggestion.keyword, record);
    }
  }
  return [...output.values()].sort((a, b) => b.opportunityScore - a.opportunityScore || a.keyword.localeCompare(b.keyword, 'ko'));
}

export function buildContentIdeas(shoppingRows, longTails, googleTrends) {
  const ideas = [];
  for (const item of longTails.filter(item => !item.semanticDrift).slice(0, 80)) {
    let format = 'comparison_or_buying_guide';
    if (item.problemIntent) format = 'problem_solution';
    else if (!item.buyerIntent) format = 'explainer_or_list';
    ideas.push({
      keyword: item.keyword,
      format,
      score: item.opportunityScore,
      reason: [
        `Naver autocomplete rank ${item.autocompleteRank}`,
        `inherited shopping trend ${item.inheritedShoppingScore}`,
        ...item.tags,
      ],
    });
  }
  for (const item of shoppingRows.slice(0, 40)) {
    if (ideas.some(idea => idea.keyword === item.keyword)) continue;
    ideas.push({
      keyword: item.keyword,
      format: 'trend_explainer_or_product_roundup',
      score: item.score,
      reason: [`Naver Shopping Insight score ${item.score}`, `${item.categoryCount} categories`],
    });
  }
  const googleMap = new Map((googleTrends || []).map(item => [item.keyword.toLowerCase(), item]));
  for (const idea of ideas) {
    const spike = googleMap.get(idea.keyword.toLowerCase());
    if (spike) {
      idea.score = Math.round(clamp(idea.score + 10));
      idea.reason.push(`Google trending ${spike.approxTrafficLabel || ''}`.trim());
      idea.googleSpike = true;
    }
  }
  return ideas.sort((a, b) => b.score - a.score || a.keyword.localeCompare(b.keyword, 'ko'));
}
