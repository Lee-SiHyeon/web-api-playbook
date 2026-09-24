import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultSource = path.resolve(root, '..', 'affiliate-api-hub', 'references', 'coupang-product-comparison.json');

const money = value => Number.isFinite(value) ? `${value.toLocaleString('ko-KR')}원` : '확인 필요';

function uniqueProducts(products = []) {
  const map = new Map();
  for (const product of products.filter(Boolean)) {
    const key = `${product.title}|${product.salePriceKrw}`;
    if (!map.has(key)) map.set(key, product);
  }
  return [...map.values()];
}

export function buildComparisonBrief(record) {
  const selected = record.positioning.selected;
  const alternatives = record.positioning.alternatives;
  const comparisonProducts = uniqueProducts([
    selected,
    alternatives.cheapest,
    alternatives.fastCharge,
    alternatives.allDayCapacity,
    alternatives.bundleValue,
  ]);
  const gaps = record.positioning.evidenceGaps || [];
  const headlineCandidates = [
    `도킹형 보조배터리 5종 비교｜5천원대·20W·1만mAh 중 스피디 ${money(selected.salePriceKrw)} 선택 이유`,
    `스피디 도킹형 보조배터리가 매력적인 이유｜최저가·고속충전·1만mAh 제품과 비교`,
    `도킹형 보조배터리 아무거나 사면 안 되는 이유｜가격·속도·용량별 추천`,
    `C타입 도킹형 보조배터리 비교｜스피디 4900mAh는 누구에게 맞을까`,
  ];
  return {
    schemaVersion: 1,
    checkedAt: record.checkedAt,
    mode: 'multi_product_comparison_editorial_brief',
    searchIntent: '도킹형 보조배터리를 가격·속도·용량·휴대성 기준으로 비교해 자기 상황에 맞는 제품을 고르려는 독자',
    thesis: record.positioning.positioning,
    selectedProduct: selected,
    comparisonProducts,
    headlineCandidates,
    whySelected: record.positioning.strengths,
    whereSelectedLoses: record.positioning.tradeoffs,
    recommendedFor: record.positioning.recommendedFor,
    notRecommendedFor: record.positioning.notRecommendedFor,
    evidenceGaps: gaps,
    communityResearchQuestions: [
      '두꺼운 케이스를 장착한 채 C타입 단자가 끝까지 들어가는가',
      '도킹 상태에서 타이핑·촬영할 때 단자와 손목이 불편한가',
      '실제 충전 속도와 발열에 대한 반복 불만이 있는가',
      '4,900~5,000mAh가 실제 스마트폰에서 어느 정도 충전되는가',
      '장기 사용 시 단자 유격·배터리 저하·파손 불만이 반복되는가',
      '비슷한 가격대 제품 중 교환·AS 경험 차이가 있는가',
    ],
    outline: [
      '첫 화면: 제휴 고지 + “가장 싼 제품이 아니라도 살 이유가 있을까?” 질문',
      '독자 상황: 작은 가방·출퇴근·비상 충전 vs 여행·고속 충전',
      '비교 기준: 현재 가격, 용량, 출력 표기, 단자, 휴대성, 묶음 여부',
      '5개 제품 비교표',
      '최저가 승자와 주의점',
      '고속충전 승자와 추가 비용',
      '1만mAh 승자와 무게·부피 트레이드오프',
      '묶음 단가 승자와 옵션·품질 확인점',
      '스피디 4,900mAh가 매력적인 정확한 조건',
      '추천 대상 / 비추천 대상',
      '아직 확인할 커뮤니티 불만과 공식 사양',
      '최종 선택 트리와 제휴 링크',
    ],
    publishGate: {
      minimumProducts: 4,
      comparisonProductCount: comparisonProducts.length,
      currentPriceCheckedAt: record.checkedAt,
      requiresCommunityEvidence: true,
      requiresSpecVerification: true,
      mayClaimUniversalWinner: false,
      readyForPublication: comparisonProducts.length >= 4 && gaps.length === 0,
    },
    credentialsPersisted: false,
  };
}

function markdown(brief) {
  const lines = [
    '# 다제품 비교 글 브리프 — 도킹형 보조배터리',
    '',
    `- 가격·검색 확인 시각: ${brief.checkedAt}`,
    `- 비교 후보: ${brief.comparisonProducts.length}개`,
    `- 발행 준비 상태: ${brief.publishGate.readyForPublication ? '준비 완료' : '추가 검증 필요'}`,
    '',
    '## 검색 의도',
    '',
    brief.searchIntent,
    '',
    '## 핵심 논지',
    '',
    `**${brief.thesis}**`,
    '',
    '## 제목 후보',
    '',
    ...brief.headlineCandidates.map(title => `- ${title}`),
    '',
    '## 비교표',
    '',
    '| 제품 | 현재 가격 | 용량 | 출력 단서 | 단자 | 포지션 |',
    '|---|---:|---:|---:|---|---|',
    ...brief.comparisonProducts.map(product => {
      const position = product.title === brief.selectedProduct.title
        ? '선택 제품'
        : product === brief.comparisonProducts[1]
          ? '비교 대안'
          : '상황별 대안';
      return `| ${product.title} | ${money(product.salePriceKrw)} | ${product.capacityMah ? `${product.capacityMah.toLocaleString('ko-KR')}mAh` : '확인 필요'} | ${product.powerW ? `${product.powerW}W` : product.fastChargeClaim ? '고속충전 표기' : '표기 없음'} | ${product.connector || '확인 필요'} | ${position} |`;
    }),
    '',
    '## 스피디 제품이 매력적인 이유',
    '',
    ...brief.whySelected.map(value => `- ${value}`),
    '',
    '## 다른 제품이 더 나은 조건',
    '',
    ...brief.whereSelectedLoses.map(value => `- ${value}`),
    '',
    '## 추천 대상',
    '',
    ...brief.recommendedFor.map(value => `- ${value}`),
    '',
    '## 비추천 대상',
    '',
    ...brief.notRecommendedFor.map(value => `- ${value}`),
    '',
    '## 커뮤니티에서 추가로 확인할 질문',
    '',
    ...brief.communityResearchQuestions.map(value => `- ${value}`),
    '',
    '## 아직 비어 있는 증거',
    '',
    ...brief.evidenceGaps.map(value => `- ${value}`),
    '',
    '## 권장 글 순서',
    '',
    ...brief.outline.map((value, index) => `${index + 1}. ${value}`),
    '',
    '## 발행 원칙',
    '',
    '- “최고”라고 말하지 않고 어떤 기준에서 이기는지 명시한다.',
    '- 판매 페이지 제목에 적힌 표현과 실측·공식 검증 결과를 구분한다.',
    '- 가격과 옵션은 발행 직전 다시 확인한다.',
    '- 선택 제품이 지는 비교축을 최소 2개 공개한다.',
    '- 링크는 선택 기준과 추천 대상을 정리한 뒤 배치한다.',
    '',
  ];
  return lines.join('\n');
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedPath === import.meta.url) {
  const source = process.argv[2] || defaultSource;
  const record = JSON.parse(await readFile(source, 'utf8'));
  const brief = buildComparisonBrief(record);
  const jsonPath = path.join(root, 'research', 'brief-coupang-speedy-multi-product.json');
  const mdPath = path.join(root, 'research', 'brief-coupang-speedy-multi-product.md');
  await writeFile(jsonPath, JSON.stringify(brief, null, 2) + '\n');
  await writeFile(mdPath, markdown(brief));
  console.log(JSON.stringify({
    completed: true,
    comparisonProductCount: brief.comparisonProducts.length,
    readyForPublication: brief.publishGate.readyForPublication,
    markdown: path.basename(mdPath),
    json: path.basename(jsonPath),
  }));
}
