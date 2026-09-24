import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectShoppingTrends, SHOPPING_CATEGORIES } from './sources/naver-shopping-insight.mjs';
import { collectAutocomplete } from './sources/naver-autocomplete.mjs';
import { fetchGoogleTrending } from './sources/google-trends-rss.mjs';
import { naverSearchTrendCredentialState } from './sources/naver-search-trend.mjs';
import { buildContentIdeas, buildLongTailOpportunities, scoreShoppingTrends } from './scoring.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const radarRoot = path.join(root, 'research', 'trend-radar');
const evidenceDir = path.join(radarRoot, 'evidence');

function parseArgs(args) {
  const options = {
    seeds: [],
    timeUnits: ['date', 'week', 'month'],
    categoryIds: SHOPPING_CATEGORIES.map(category => category.id),
    top: 50,
    autocompleteSeeds: 30,
    google: true,
  };
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--seed=')) options.seeds.push(...arg.slice(7).split(',').map(value => value.trim()).filter(Boolean));
    else if (arg.startsWith('--units=')) options.timeUnits = arg.slice(8).split(',').map(value => value.trim()).filter(Boolean);
    else if (arg.startsWith('--categories=')) options.categoryIds = arg.slice(13).split(',').map(value => value.trim()).filter(Boolean);
    else if (arg.startsWith('--top=')) options.top = Number(arg.slice(6));
    else if (arg.startsWith('--autocomplete-seeds=')) options.autocompleteSeeds = Number(arg.slice(21));
    else if (arg === '--no-google') options.google = false;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.timeUnits.every(unit => ['date', 'week', 'month'].includes(unit))) throw new Error('Invalid --units');
  if (!Number.isInteger(options.top) || options.top < 10 || options.top > 300) throw new Error('Invalid --top');
  if (!Number.isInteger(options.autocompleteSeeds) || options.autocompleteSeeds < 0 || options.autocompleteSeeds > 100) {
    throw new Error('Invalid --autocomplete-seeds');
  }
  return options;
}

function usage() {
  return [
    'API-only trend radar',
    '',
    'Usage:',
    '  npm run research:trends',
    '  npm run research:trends -- --seed=보조배터리,신혼여행',
    '  node research/trend-radar/run.mjs --categories=50000003,50000008 --units=date,week',
    '',
    'Sources: Naver Shopping Insight XHR replay, Naver autocomplete JSONP, Google Trends RSS.',
    'Normal execution imports no browser automation.',
  ].join('\n');
}

function sourceState({ captured, clientExists, remnantFree, credentialPropagated, liveReplay, reason = null }) {
  return { captured, clientExists, remnantFree, credentialPropagated, liveReplay, ...(reason ? { reason } : {}) };
}

function markdown(record) {
  const lines = [
    '# API-only 트렌드 레이더',
    '',
    `- 확인 시각: ${record.checkedAt}`,
    `- 네이버 쇼핑 카테고리: ${record.coverage.shoppingCategoriesProcessed}/${record.coverage.shoppingCategoriesRequested}`,
    `- 네이버 쇼핑 계약: ${record.coverage.shoppingContractsSucceeded}/${record.coverage.shoppingContractsRequested}`,
    `- 자동완성 seed: ${record.coverage.autocompleteSeedsSucceeded}/${record.coverage.autocompleteSeedsRequested}`,
    `- Google 급상승: ${record.googleTrending.length}개`,
    '',
    '## 소스 역할',
    '',
    '| 소스 | 무엇을 알려주나 | 현재 상태 |',
    '|---|---|---|',
    '| Naver Shopping Insight | 쇼핑 카테고리별 인기 검색어와 일·주·월 지속성 | API-only 실검증 |',
    '| Naver autocomplete | 사람들이 붙여 검색하는 롱테일·문제·구매 의도 | API-only 실검증 |',
    '| Google Trends RSS | 지금 갑자기 치솟는 뉴스·대중 관심사 | API-only 실검증 |',
    '| Naver Search Trend 공식 API | 후보 키워드의 상대 검색 추이·인구통계 비교 | 키 미설정으로 대기 |',
    '| Naver Blog search | 상위 콘텐츠 구조와 경쟁 강도 | 기존 레퍼런스 분석기로 처리 |',
    '| Coupang Partners | 실제 판매 상품·가격·제휴 링크 | 기존 상품 비교기로 처리 |',
    '',
    '## 쇼핑 트렌드 상위',
    '',
    '| 순위 | 검색어 | 점수 | 분야 |',
    '|---:|---|---:|---|',
    ...record.shoppingTrends.slice(0, 40).map((item, index) => (
      `| ${index + 1} | ${item.keyword} | ${item.score} | ${item.categories.map(category => category.name).join(', ')} |`
    )),
    '',
    '## 롱테일 콘텐츠 기회',
    '',
    '| 순위 | 검색어 | 점수 | 의도 | 기반 seed |',
    '|---:|---|---:|---|---|',
    ...record.longTailOpportunities.slice(0, 50).map((item, index) => (
      `| ${index + 1} | ${item.keyword} | ${item.opportunityScore} | ${item.tags.join(', ') || '탐색'} | ${item.seed} |`
    )),
    '',
    '## 지정 seed 확장',
    '',
    ...record.seedExpansions.flatMap(group => [
      `### ${group.seed}`,
      '',
      ...group.suggestions.slice(0, 15).map(item => (
        `- ${item.keyword} — ${item.opportunityScore ?? '-'}점${item.tags?.length ? ` — ${item.tags.join(', ')}` : ''}`
      )),
      '',
    ]),
    '',
    '## 현재 Google 급상승',
    '',
    ...record.googleTrending.slice(0, 25).map((item, index) => (
      `${index + 1}. **${item.keyword}** — ${item.approxTrafficLabel || 'traffic 미표시'}`
    )),
    '',
    '## 콘텐츠 후보',
    '',
    ...record.contentIdeas.slice(0, 40).map((item, index) => (
      `${index + 1}. **${item.keyword}** — ${item.format} — ${item.score}점 (${item.reason.join('; ')})`
    )),
    '',
    '## 해석 주의',
    '',
    '- 쇼핑인사이트 순위는 카테고리 내 상대 인기이며 절대 검색량이 아니다.',
    '- 자동완성은 연관 검색 의도 신호이지 검색량 순위가 아니다.',
    '- Google 급상승은 뉴스성 이슈가 많아 상품 제휴 적합성을 별도로 판단한다.',
    '- 실제 글감 선정 전에 네이버 블로그 상위글과 커뮤니티 반복 질문을 추가 분석한다.',
    '',
  ];
  return lines.join('\n');
}

export async function run(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    console.log(usage());
    return { help: true };
  }
  await mkdir(evidenceDir, { recursive: true });
  const categories = SHOPPING_CATEGORIES.filter(category => options.categoryIds.includes(category.id));
  if (!categories.length) throw new Error('No valid shopping categories selected');

  const shopping = await collectShoppingTrends({ categories, timeUnits: options.timeUnits });
  const shoppingTrends = scoreShoppingTrends(shopping);
  const autocompleteSeeds = [...new Set([
    ...options.seeds,
    ...shoppingTrends.slice(0, options.autocompleteSeeds).map(item => item.keyword),
  ])];
  const autocomplete = await collectAutocomplete(autocompleteSeeds);
  const longTailOpportunities = buildLongTailOpportunities(autocomplete, shoppingTrends, {
    explicitSeeds: options.seeds,
  });
  const seedSet = new Set(options.seeds);
  const seedExpansions = autocomplete.results
    .filter(result => seedSet.has(result.seed))
    .map(result => ({
      seed: result.seed,
      suggestions: result.suggestions.map(suggestion => {
        const match = longTailOpportunities.find(item => item.seed === result.seed && item.keyword === suggestion.keyword);
        return match || suggestion;
      }),
    }));
  let google = { trends: [], receipt: null, error: null };
  if (options.google) {
    try { google = await fetchGoogleTrending({ geo: 'KR' }); }
    catch (error) { google = { trends: [], receipt: null, error: error?.code || error?.name || 'ERROR' }; }
  }
  const credentialState = naverSearchTrendCredentialState();
  const checkedAt = new Date();
  const contentIdeas = buildContentIdeas(shoppingTrends, longTailOpportunities, google.trends);
  const categoryProcessed = new Set(shopping.results.map(item => item.categoryId)).size;
  const record = {
    schemaVersion: 1,
    checkedAt: checkedAt.toISOString(),
    mode: 'api_only_trend_radar',
    options: {
      seeds: options.seeds,
      timeUnits: options.timeUnits,
      categoryIds: categories.map(category => category.id),
    },
    coverage: {
      shoppingCategoriesRequested: categories.length,
      shoppingCategoriesProcessed: categoryProcessed,
      shoppingContractsRequested: shopping.requestedContracts,
      shoppingContractsSucceeded: shopping.successfulContracts,
      autocompleteSeedsRequested: autocomplete.requestedSeeds,
      autocompleteSeedsSucceeded: autocomplete.successfulSeeds,
    },
    sourceStates: {
      naverShoppingInsight: sourceState({
        captured: true, clientExists: true, remnantFree: true,
        credentialPropagated: 'not_applicable_anonymous', liveReplay: shopping.successfulContracts > 0,
        reason: shopping.successfulContracts === shopping.requestedContracts
          ? null
          : `partial_coverage_${shopping.successfulContracts}_of_${shopping.requestedContracts}`,
      }),
      naverAutocomplete: sourceState({
        captured: true, clientExists: true, remnantFree: true,
        credentialPropagated: 'not_applicable_public', liveReplay: autocomplete.successfulSeeds > 0,
      }),
      googleTrendingRss: sourceState({
        captured: true, clientExists: true, remnantFree: true,
        credentialPropagated: 'not_applicable_public', liveReplay: Boolean(google.receipt),
        reason: google.error,
      }),
      naverOfficialSearchTrend: sourceState({
        captured: true, clientExists: true, remnantFree: true,
        credentialPropagated: credentialState.ready,
        liveReplay: false,
        reason: credentialState.ready ? 'not_run_to_preserve_quota' : 'missing_NAVER_CLIENT_ID_and_NAVER_CLIENT_SECRET',
      }),
    },
    receipts: {
      naverAnonymousSession: shopping.sessionEvidence,
      shopping: shopping.results.map(item => item.receipt),
      autocomplete: autocomplete.results.map(item => item.receipt),
      google: google.receipt,
    },
    failures: {
      shopping: shopping.failures,
      autocomplete: autocomplete.failures,
      google: google.error,
    },
    shoppingTrends: shoppingTrends.slice(0, options.top),
    seedExpansions,
    longTailOpportunities: longTailOpportunities.slice(0, options.top * 2),
    googleTrending: google.trends,
    contentIdeas: contentIdeas.slice(0, options.top * 2),
    credentialsPersisted: false,
    browserUsedForNormalExecution: false,
  };

  const stamp = checkedAt.toISOString().replace(/[-:.]/g, '').replace('Z', 'Z');
  const evidenceName = `trend-radar-${stamp}.json`;
  await writeFile(path.join(evidenceDir, evidenceName), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  await writeFile(path.join(radarRoot, 'latest.json'), JSON.stringify(record, null, 2) + '\n');
  await writeFile(path.join(radarRoot, 'latest.md'), markdown(record));
  await writeFile(path.join(radarRoot, 'conversion-receipt.json'), JSON.stringify({
    checkedAt: record.checkedAt,
    sourceStates: record.sourceStates,
    browserUsedForNormalExecution: false,
    credentialsPersisted: false,
    evidenceFile: evidenceName,
  }, null, 2) + '\n');
  console.log(JSON.stringify({
    completed: true,
    evidenceFile: evidenceName,
    shoppingContracts: `${shopping.successfulContracts}/${shopping.requestedContracts}`,
    shoppingTrendCount: record.shoppingTrends.length,
    longTailCount: record.longTailOpportunities.length,
    googleTrendCount: record.googleTrending.length,
    browserUsedForNormalExecution: false,
  }));
  return record;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedPath === import.meta.url) {
  run().catch(error => {
    console.error(JSON.stringify({
      completed: false,
      code: error?.code || error?.name || 'TREND_RADAR_FAILED',
      message: String(error?.message || 'Trend radar failed').slice(0, 240),
    }));
    process.exitCode = 1;
  });
}
