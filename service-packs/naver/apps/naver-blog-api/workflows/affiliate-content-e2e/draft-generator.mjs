function money(value) {
  return Number.isFinite(Number(value)) ? `${Number(value).toLocaleString('ko-KR')}원` : '확인 필요';
}

function checkedAtKst(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || '확인 필요');
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

function capacity(product) {
  return product?.capacityMah ? `${Number(product.capacityMah).toLocaleString('ko-KR')}mAh` : '상세 확인 필요';
}

function power(product) {
  if (product?.powerW) return `${product.powerW}W`;
  if (product?.fastChargeClaim) return '고속충전 표기';
  return '출력 표기 확인 필요';
}

function connector(product) {
  return product?.connector === 'usb_c'
    ? 'C타입'
    : product?.connector === 'lightning'
      ? '8핀'
      : product?.connector === 'magsafe'
        ? '맥세이프'
        : '옵션 확인 필요';
}

function cleanTitle(title) {
  return String(title || '').replace(/,+\s*$/, '').replace(/\s+/g, ' ').trim();
}

function productRole(index, product, selected) {
  if (product.title === selected.title) return '저가 입문형';
  if (index === 1) return '최저가 대안';
  if (product.powerW || product.fastChargeClaim) return '속도 우선 대안';
  if ((product.capacityMah || 0) >= 10000) return '대용량 대안';
  if ((product.bundleQuantity || 1) > 1) return '묶음 단가 대안';
  return '비교 대안';
}

function issueLabel(issue) {
  const labels = {
    heat: '발열',
    port_strain: '단자 유격·부담',
    charging_speed: '충전 속도',
    durability: '고장·내구성',
    travel_airline: '기내반입·여행',
    actual_capacity: '실제 충전량',
    usability: '충전 중 조작성',
    case_compatibility: '케이스 호환',
    charging_method: '본체 충전 방법',
    display_convenience: '잔량 표시',
  };
  return labels[issue] || issue;
}

export function buildAffiliateDraft({
  topic,
  format,
  comparisonBrief,
  community,
  referenceBrief,
  affiliateUrl,
  claimLedger,
}) {
  const selected = comparisonBrief.selectedProduct;
  const products = comparisonBrief.comparisonProducts.slice(0, 6);
  const issues = (community.issueSummary || []).slice(0, 7);
  const checkedAt = checkedAtKst(comparisonBrief.checkedAt);
  const referenceMedian = referenceBrief?.summary?.medianTextLength || null;
  const title = format === 'problem_solution'
    ? `도킹형 보조배터리 고르기 전 확인할 7가지｜발열·단자·용량과 제품 비교`
    : `도킹형 보조배터리 5종 비교｜5천원대·20W·1만mAh 중 스피디가 맞는 사람`;

  const tableRows = products.map((product, index) => (
    `| ${cleanTitle(product.title)} | ${money(product.salePriceKrw)} | ${capacity(product)} | ${power(product)} | ${connector(product)} | ${productRole(index, product, selected)} |`
  ));
  const issueRows = issues.map(issue => (
    `| ${issueLabel(issue.issue)} | ${issue.articleCount}개 | ${issue.exampleTitles?.[0] || '공개 검색 결과에서 반복 확인'} |`
  ));
  const strengths = comparisonBrief.whySelected.map(value => `- ${value}`);
  const losses = comparisonBrief.whereSelectedLoses.map(value => `- ${value}`);
  const recommended = comparisonBrief.recommendedFor.map(value => `- ${value}`);
  const notRecommended = comparisonBrief.notRecommendedFor.map(value => `- ${value}`);

  const markdown = [
    `# ${title}`,
    '',
    '**이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.**',
    '',
    `> 이 글은 직접 사용 후기가 아니라 **${checkedAt} 기준 쿠팡 파트너스 공개 상품명·가격**, 네이버 블로그 상위 글 구조, 공개 네이버 카페 검색 제목·스니펫을 비교한 구매 가이드입니다. 가격·옵션·재고와 공식 사양은 구매 직전에 다시 확인해야 합니다.`,
    '',
    '## 도킹형이 편해 보여도, 아무 제품이나 고르면 안 되는 이유',
    '',
    '도킹형 보조배터리는 케이블을 따로 꺼내지 않고 휴대폰에 바로 꽂는다는 장점이 분명합니다.',
    '',
    '하지만 실제 선택에서는 가격만 볼 수 없습니다. 작은 가방에 넣을 비상용인지, 충전 속도가 중요한지, 여행 중 하루 종일 쓸 것인지에 따라 정답이 달라집니다.',
    '',
    '공개 커뮤니티 검색에서도 발열, 휴대폰 단자에 가해지는 부담, 실제 충전량, 케이스 호환 문제가 반복해서 등장했습니다. 그래서 이번 비교는 “무조건 좋은 제품”을 찾기보다 **어떤 상황에서 어느 제품이 더 합리적인지**에 초점을 맞췄습니다.',
    '',
    '## 비교 기준은 6가지입니다',
    '',
    '1. 현재 판매 가격',
    '2. 5천mAh급 비상용인지, 1만mAh급 하루용인지',
    '3. 20W 등 충전 출력이 명확히 표시됐는지',
    '4. C타입·8핀 등 단자 옵션',
    '5. 1개 가격인지 묶음 가격인지',
    '6. 케이스 호환·발열·단자 내구처럼 구매 후 문제가 될 조건',
    '',
    '![도킹형 보조배터리 가격 비교](assets/product-price-comparison.png)',
    '',
    '## 도킹형 보조배터리 5종 비교표',
    '',
    `가격 확인 시점: **${checkedAt}**`,
    '',
    '| 제품 | 현재 가격 | 용량 단서 | 출력 단서 | 단자 | 비교 포지션 |',
    '|---|---:|---:|---:|---|---|',
    ...tableRows,
    '',
    '상품명에 표시된 용량·출력은 판매 화면상의 표현입니다. 실제 무게, 충전 효율, 발열은 실측값으로 보지 않았습니다.',
    '',
    '## 가격만 보면 팬택, 속도라면 20W 모델',
    '',
    '절대 최저가만 찾는다면 스피디보다 저렴한 팬택 후보가 있습니다. 따라서 스피디를 “가장 싼 제품”이라고 소개하면 비교가 성립하지 않습니다.',
    '',
    '반대로 충전 속도를 중요하게 본다면 상품명에 20W가 명시된 스피디 상위 모델이 더 분명한 선택입니다. 약 3천원을 더 내는 대신 출력 조건을 제품명에서 바로 확인할 수 있습니다.',
    '',
    '## 여행과 장시간 사용이라면 1만mAh 후보',
    '',
    '4,900~5,000mAh급은 작은 가방과 비상 충전에 초점을 맞춘 구간입니다. 지도, 사진, 영상 촬영을 오래 하거나 장거리 이동 중 여러 번 충전하려면 10,000mAh 후보가 목적에 더 맞습니다.',
    '',
    '다만 대용량 제품은 가격뿐 아니라 실제 무게와 돌출 정도를 확인해야 합니다. 숫자가 크다고 모든 상황에서 더 좋은 것은 아닙니다.',
    '',
    '## 2개가 필요하면 1+1 단가도 따져봐야 합니다',
    '',
    '가족이나 커플이 각각 하나씩 쓸 목적이라면 1+1 상품이 개당 가격에서는 강할 수 있습니다. 다만 옵션에 따라 단자 종류가 달라질 수 있고, 묶음 표기가 실제 동일 구성인지 반드시 판매 페이지에서 확인해야 합니다.',
    '',
    `## 그래도 스피디 ${money(selected.salePriceKrw)} 제품이 매력적인 이유`,
    '',
    ...strengths,
    '',
    `한 문장으로 정리하면 **“가장 빠르거나 가장 싼 제품은 아니지만, 7천원 이하에서 C타입 도킹형을 부담 없이 시험해 볼 비상 충전용 입문 제품”**입니다.`,
    '',
    '## 스피디보다 다른 제품이 나은 조건',
    '',
    ...losses,
    '',
    '이 차이를 숨기지 않아야 제품의 매력이 더 정확하게 보입니다. 저가·고속·대용량·묶음은 서로 다른 우승 조건입니다.',
    '',
    '## 커뮤니티에서 반복된 구매 전 질문',
    '',
    '| 이슈 | 관련 공개 글 수 | 대표적으로 나온 질문 |',
    '|---|---:|---|',
    ...issueRows,
    '',
    '이 숫자는 결함률이 아닙니다. 공개 검색 결과에서 같은 질문이 몇 개 문서에 등장했는지를 센 **소재 신호**입니다. 실제 결론은 공식 사양과 개별 제품 후기, 가능하면 실측으로 다시 확인해야 합니다.',
    '',
    '## 이런 분에게 스피디 4,900mAh가 맞습니다',
    '',
    ...recommended,
    '',
    '## 이런 분은 다른 제품이 낫습니다',
    '',
    ...notRecommended,
    '',
    '## 구매 전에 마지막으로 확인하세요',
    '',
    '- 휴대폰 케이스를 낀 채 C타입 단자가 끝까지 들어가는지',
    '- 판매 옵션이 C타입인지 8핀인지',
    '- 고속충전이 필요하다면 실제 지원 출력과 케이블·기기 조건',
    '- 비행기에 가져갈 예정이라면 이용 항공사의 최신 보조배터리 규정',
    '- 가격, 배송 조건, 반품·보증 조건',
    '',
    '## 상황별로 고르면 간단합니다',
    '',
    '```text',
    '가격 최우선          → 현재 최저가 후보 확인',
    '작은 가방·비상 충전 → 스피디 4,900mAh 같은 저가 도킹형',
    '충전 속도 우선       → 20W 표기 모델',
    '여행·장시간 사용     → 10,000mAh 모델',
    '두 사람이 각각 사용  → 1+1 구성과 개당 가격 확인',
    '```',
    '',
    '## 스피디 제품 상세 확인',
    '',
    `현재 선택 제품: **${cleanTitle(selected.title)}**`,
    '',
    affiliateUrl,
    '',
    '판매 가격과 배송 조건은 시점에 따라 바뀔 수 있습니다. 최종 구매 전 쿠팡 상품 페이지의 옵션과 공식 사양을 다시 확인하세요.',
    '',
    '## 결론',
    '',
    '도킹형 보조배터리는 한 제품이 모든 기준에서 이기는 시장이 아닙니다.',
    '',
    '스피디 4,900mAh의 매력은 최고 성능이 아니라 **낮은 진입 가격, C타입 도킹 구조, 비상 충전에 맞는 목적의 명확성**에 있습니다. 속도나 하루 사용량이 더 중요하다면 비용을 더 내고 다른 후보를 고르는 편이 합리적입니다.',
    '',
  ].join('\n');

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    topic,
    format,
    title,
    markdown,
    metadata: {
      productCount: products.length,
      issueCount: issues.length,
      priceCheckedAt: comparisonBrief.checkedAt,
      directExperienceClaimed: false,
      affiliateDisclosurePresent: true,
      affiliateUrl,
      referenceMedianTextLength: referenceMedian,
      claimCount: Array.isArray(claimLedger?.claims) ? claimLedger.claims.length : 0,
      evidenceCount: claimLedger?.evidence && typeof claimLedger.evidence === 'object'
        ? Object.keys(claimLedger.evidence).length
        : 0,
    },
  };
}
