import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildAffiliateDraft } from '../workflows/affiliate-content-e2e/draft-generator.mjs';
import { evaluateAffiliateDraft } from '../workflows/affiliate-content-e2e/quality-gate.mjs';

const product = (title, price, extra = {}) => ({
  title, salePriceKrw: price, capacityMah: 5000, powerW: null, connector: 'usb_c', bundleQuantity: 1,
  fastChargeClaim: false, ...extra,
});

function fixtureBrief() {
  const selected = product('스피디 SPE-B2PA5GPQCP C타입', 6900, { capacityMah: 4900 });
  return {
    checkedAt: '2026-09-19T08:44:01Z',
    selectedProduct: selected,
    comparisonProducts: [
      selected,
      product('팬택 MINI5000 C타입', 5120),
      product('스피디 20W C타입', 9990, { powerW: 20, fastChargeClaim: true }),
      product('오지렌 10000mAh', 15200, { capacityMah: 10000 }),
      product('1+1 미니 5000mAh', 8630, { bundleQuantity: 2 }),
    ],
    whySelected: ['현재 표본에서 6,900원으로 저가 구간이다.', '관측한 후보 중 약 86%보다 가격이 낮다.'],
    whereSelectedLoses: ['최저가는 팬택이다.', '속도는 20W 제품이 낫다.', '용량은 1만mAh 제품이 낫다.'],
    recommendedFor: ['작은 가방 비상 충전', '가격 우선', 'C타입 도킹 선호'],
    notRecommendedFor: ['20W 이상 필요', '1만mAh 필요', '케이스 호환 미확인'],
  };
}

test('generated comparison draft is transparent and decision-oriented', async () => {
  const comparisonBrief = fixtureBrief();
  const community = {
    articleCount: 20,
    issueSummary: [
      { issue: 'heat', articleCount: 6, exampleTitles: ['발열 질문'] },
      { issue: 'port_strain', articleCount: 5, exampleTitles: ['단자 질문'] },
      { issue: 'charging_speed', articleCount: 4, exampleTitles: ['속도 질문'] },
      { issue: 'durability', articleCount: 3, exampleTitles: ['내구 질문'] },
    ],
  };
  const draft = buildAffiliateDraft({
    topic: '도킹형 보조배터리 추천', format: 'multi_product_comparison', comparisonBrief, community,
    referenceBrief: { summary: { medianTextLength: 1800 } }, affiliateUrl: 'https://link.coupang.com/a/fixtureLink',
  });
  assert.match(draft.markdown, /직접 사용 후기가 아니라/);
  assert.match(draft.markdown, /다른 제품이 나은 조건/);
  assert.doesNotMatch(draft.markdown, /직접 써보니|내돈내산/);
  const rubric = JSON.parse(await readFile(new URL('../research/editorial-quality-rubric.json', import.meta.url), 'utf8'));
  const gate = evaluateAffiliateDraft({ draft, comparisonBrief, community, rubric });
  assert.equal(gate.hardBlocks.length, 0);
  assert.equal(gate.metrics.comparisonProductCount, 5);
  assert.equal(gate.status, 'ready_for_review');
  assert.ok(gate.score >= 80);
});

test('quality gate blocks unsupported review language and thin comparisons', async () => {
  const rubric = JSON.parse(await readFile(new URL('../research/editorial-quality-rubric.json', import.meta.url), 'utf8'));
  const gate = evaluateAffiliateDraft({
    draft: { title: '실측 후기', markdown: '# 글\n직접 써보니 최고였습니다.', metadata: { affiliateUrl: '' } },
    comparisonBrief: { whereSelectedLoses: [] }, community: {}, rubric,
  });
  assert.ok(gate.hardBlocks.includes('unsupported_first_person_claim'));
  assert.ok(gate.hardBlocks.includes('comparison_with_fewer_than_four_products'));
  assert.equal(gate.passed, false);
});
