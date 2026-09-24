import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const references = path.join(root, 'references');
const evidence = path.join(root, 'evidence');
const docs = path.join(root, 'docs');

const number = value => Number.isFinite(Number(value)) ? Number(value) : null;
const clamp = (value, minimum = 0, maximum = 100) => Math.max(minimum, Math.min(maximum, value));

export function extractProductFeatures(product = {}) {
  const title = String(product.title || '');
  const capacityMatches = [...title.matchAll(/(\d{4,5})\s*mAh/gi)].map(match => Number(match[1]));
  const modelCapacity = title.match(/MINI[-_]?((?:5|10)000)\b/i)?.[1];
  const powerMatches = [...title.matchAll(/(\d+(?:\.\d+)?)\s*[wW](?!\w)/g)].map(match => Number(match[1]));
  const bundle = title.match(/(\d+)\s*\+\s*(\d+)/);
  const model = title.match(/\b([A-Z][A-Z0-9-]{3,})\b/)?.[1] || null;
  const firstToken = title.split(/[\s,]/).find(token => token && !/^\d+\+\d+$/.test(token)) || null;
  const connector = /C\s*타입|타입\s*C|USB\s*-?\s*C/i.test(title)
    ? 'usb_c'
    : /8\s*핀|라이트닝/i.test(title)
      ? 'lightning'
      : /맥세이프|magsafe/i.test(title)
        ? 'magsafe'
        : null;
  return {
    title,
    model,
    brand: firstToken,
    capacityMah: capacityMatches.length ? Math.max(...capacityMatches) : modelCapacity ? Number(modelCapacity) : null,
    capacitySource: capacityMatches.length ? 'title_explicit' : modelCapacity ? 'model_hint' : null,
    powerW: powerMatches.length ? Math.max(...powerMatches) : null,
    connector,
    bundleQuantity: bundle ? Number(bundle[1]) + Number(bundle[2]) : 1,
    docking: /도킹|일체형/i.test(title),
    mini: /미니|포켓|초슬림/i.test(title),
    fastChargeClaim: /고속|PD\s*\d|\d+(?:\.\d+)?\s*[wW]/i.test(title),
    foldableConnector: /접이식/i.test(title),
    led: /LED/i.test(title),
    samsungCellClaim: /삼성셀/i.test(title),
    wireless: /무선|맥세이프/i.test(title),
    grip: /그립/i.test(title),
    semiSolidBatteryClaim: /반고체/i.test(title),
    salePriceKrw: number(product.salePriceKrw),
    listPriceKrw: number(product.listPriceKrw),
    discountPercent: number(product.discountPercent),
    badgeCount: number(product.badgeCount) || 0,
    evidenceCoverage: {
      currentPrice: Number.isFinite(number(product.salePriceKrw)),
      capacity: Boolean(capacityMatches.length || modelCapacity),
      chargingPower: Boolean(powerMatches.length),
      connector: Boolean(connector),
      physicalMeasurements: false,
      caseCompatibility: false,
      communityReviewSignals: false,
      safetyCertification: false,
    },
  };
}

function mergeOverride(features, selection) {
  if (!selection) return features;
  return {
    ...features,
    model: selection.model || features.model,
    brand: selection.brand || features.brand,
    capacityMah: selection.capacityMah ?? features.capacityMah,
    capacitySource: selection.capacityMah ? 'selected_product_verified_metadata' : features.capacitySource,
    connector: selection.connector || features.connector,
    salePriceKrw: selection.salePriceKrw ?? features.salePriceKrw,
    docking: Array.isArray(selection.formFactor) ? selection.formFactor.includes('docking') : features.docking,
    mini: Array.isArray(selection.formFactor) ? selection.formFactor.includes('mini') : features.mini,
    affiliateUrl: selection.affiliateUrl || null,
    productPageKey: selection.productPageKey || null,
    selected: true,
    evidenceCoverage: {
      ...features.evidenceCoverage,
      currentPrice: true,
      capacity: Boolean(selection.capacityMah ?? features.capacityMah),
      connector: Boolean(selection.connector || features.connector),
    },
  };
}

function priceScore(price, prices) {
  if (!Number.isFinite(price) || !prices.length) return 35;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  if (max === min) return 100;
  return clamp(100 - ((price - min) / (max - min)) * 100);
}

function capacityFit(capacity, target) {
  if (!Number.isFinite(capacity)) return 35;
  const distance = Math.abs(capacity - target) / target;
  return clamp(100 - distance * 120);
}

export function scoreProducts(products = []) {
  const prices = products.map(product => product.salePriceKrw).filter(Number.isFinite);
  return products.map(product => {
    const affordability = priceScore(product.salePriceKrw, prices);
    const unitPrice = Number.isFinite(product.salePriceKrw)
      ? product.salePriceKrw / Math.max(1, product.bundleQuantity)
      : null;
    const unitAffordability = priceScore(unitPrice, products.map(item => (
      Number.isFinite(item.salePriceKrw) ? item.salePriceKrw / Math.max(1, item.bundleQuantity) : null
    )).filter(Number.isFinite));
    const portableEmergency = clamp(
      affordability * 0.30
      + capacityFit(product.capacityMah, 5000) * 0.22
      + (product.docking ? 100 : 20) * 0.18
      + (product.mini ? 100 : 35) * 0.12
      + (product.connector === 'usb_c' ? 100 : product.connector ? 55 : 35) * 0.10
      + (product.fastChargeClaim ? 100 : 40) * 0.08
    );
    const fastCharge = clamp(
      affordability * 0.20
      + (product.powerW ? clamp((product.powerW / 20) * 100) : product.fastChargeClaim ? 75 : 25) * 0.45
      + capacityFit(product.capacityMah, 5000) * 0.15
      + (product.docking ? 100 : 40) * 0.10
      + (product.connector === 'usb_c' ? 100 : 45) * 0.10
    );
    const allDay = clamp(
      affordability * 0.20
      + (product.capacityMah ? clamp((product.capacityMah / 10000) * 100) : 35) * 0.55
      + (product.fastChargeClaim ? 100 : 35) * 0.15
      + (product.docking ? 70 : 45) * 0.10
    );
    const bundleValue = clamp(
      unitAffordability * 0.65
      + (product.bundleQuantity > 1 ? 100 : 35) * 0.25
      + (product.docking ? 100 : 40) * 0.10
    );
    return {
      ...product,
      unitPriceKrw: unitPrice ? Math.round(unitPrice) : null,
      scores: {
        portableEmergency: Math.round(portableEmergency),
        fastCharge: Math.round(fastCharge),
        allDay: Math.round(allDay),
        bundleValue: Math.round(bundleValue),
      },
    };
  });
}

function rankFor(products, selector, descending = true) {
  return [...products]
    .filter(product => Number.isFinite(selector(product)))
    .sort((a, b) => descending ? selector(b) - selector(a) : selector(a) - selector(b));
}

function findSelected(products, selection) {
  const model = selection?.model;
  return products.find(product => model && product.title.includes(model))
    || products.find(product => product.title === selection?.title)
    || null;
}

export function buildPositioning(products, selection) {
  const selected = findSelected(products, selection);
  if (!selected) throw new Error('selected_product_not_found_in_search_capture');
  const prices = products.map(product => product.salePriceKrw).filter(Number.isFinite).sort((a, b) => a - b);
  const cheaperCount = prices.filter(price => price < selected.salePriceKrw).length;
  const cheaperThanPercent = prices.length ? Math.round(((prices.length - cheaperCount - 1) / prices.length) * 100) : null;
  const cheapest = rankFor(products, product => product.salePriceKrw, false)[0] || null;
  const fastAlternative = rankFor(
    products.filter(product => product.fastChargeClaim && product.connector === 'usb_c'),
    product => product.salePriceKrw,
    false,
  )[0] || null;
  const capacityAlternative = rankFor(
    products.filter(product => (product.capacityMah || 0) >= 10000),
    product => product.salePriceKrw,
    false,
  )[0] || null;
  const bundleAlternative = rankFor(
    products.filter(product => product.bundleQuantity > 1),
    product => product.unitPriceKrw,
    false,
  )[0] || null;

  const strengths = [
    `현재 검색 표본에서 ${selected.salePriceKrw.toLocaleString('ko-KR')}원으로 저가 구간에 속한다.`,
    cheaperThanPercent !== null ? `관측한 ${products.length}개 후보 중 약 ${cheaperThanPercent}%보다 가격이 낮다.` : null,
    'C타입 도킹형이라 케이블을 따로 연결하지 않는 간단한 사용 목적이 분명하다.',
    `${selected.capacityMah?.toLocaleString('ko-KR') || '약 5천'}mAh급이라 대용량보다 휴대성과 비상 충전에 초점이 맞는다.`,
    '같은 브랜드의 명시적 20W 모델보다 가격 부담이 낮아 도킹형을 처음 시험하려는 독자에게 진입장벽이 낮다.',
  ].filter(Boolean);
  const tradeoffs = [
    '상품명에는 20W·PD 같은 고속충전 주장이 없어 충전 속도 우선 독자에게는 상위 모델이 더 설득력 있다.',
    '약 5천mAh급이므로 하루 종일 여러 번 충전하는 목적에는 1만mAh 후보가 더 적합하다.',
    cheapest && cheapest.title !== selected.title
      ? `최저가 자체는 ${cheapest.title} (${cheapest.salePriceKrw.toLocaleString('ko-KR')}원)라서 “가장 싼 제품”으로 말하면 안 된다.`
      : null,
    bundleAlternative
      ? `묶음 단가만 보면 ${bundleAlternative.title}가 강할 수 있어 수량·옵션·품질 조건을 따로 확인해야 한다.`
      : null,
  ].filter(Boolean);
  return {
    selected,
    cohortSize: products.length,
    cheaperThanPercent,
    positioning: '가장 강력하거나 절대 최저가는 아니지만, 7천원 이하에서 C타입 미니 도킹 구조를 부담 없이 선택하는 입문형',
    strengths,
    tradeoffs,
    alternatives: {
      cheapest,
      fastCharge: fastAlternative,
      allDayCapacity: capacityAlternative,
      bundleValue: bundleAlternative,
    },
    recommendedFor: [
      '작은 가방에 넣을 비상 충전용을 찾는 사람',
      '케이블 없이 C타입 단자에 바로 꽂는 구조를 선호하는 사람',
      '고출력보다 낮은 구매 가격을 우선하는 사람',
    ],
    notRecommendedFor: [
      '20W 이상 충전 속도를 명확히 원하는 사람',
      '장거리 이동 중 여러 번 충전할 1만mAh급이 필요한 사람',
      '두꺼운 케이스 장착 상태의 단자 호환을 확인하지 못한 사람',
    ],
    evidenceGaps: [
      '실측 무게와 크기',
      '두꺼운 휴대폰 케이스 장착 시 단자 호환',
      '실제 충전 출력과 완충 소요 시간',
      '충전 중 발열',
      'KC·배터리 셀·보증 정보의 상세 확인',
      '구매 후기의 반복 불만과 장기 내구성',
    ],
  };
}

function compactProduct(product) {
  if (!product) return null;
  return {
    title: product.title,
    salePriceKrw: product.salePriceKrw,
    capacityMah: product.capacityMah,
    powerW: product.powerW,
    connector: product.connector,
    bundleQuantity: product.bundleQuantity,
    fastChargeClaim: product.fastChargeClaim,
    evidenceCoverage: product.evidenceCoverage,
    scores: product.scores,
  };
}

export function buildComparisonRecord(searchRecord, selectionRecord, now = new Date()) {
  const selection = selectionRecord.selection;
  let products = searchRecord.products.map(extractProductFeatures);
  products = products.map(product => (
    product.title.includes(selection.model) ? mergeOverride(product, selection) : product
  ));
  products = scoreProducts(products);
  const positioning = buildPositioning(products, selection);
  const scenarioWinners = Object.fromEntries([
    ['portableEmergency', rankFor(products, product => product.scores.portableEmergency).slice(0, 5).map(compactProduct)],
    ['fastCharge', rankFor(products, product => product.scores.fastCharge).slice(0, 5).map(compactProduct)],
    ['allDay', rankFor(products, product => product.scores.allDay).slice(0, 5).map(compactProduct)],
    ['bundleValue', rankFor(products, product => product.scores.bundleValue).slice(0, 5).map(compactProduct)],
  ]);
  return {
    schemaVersion: 1,
    checkedAt: now.toISOString(),
    sourceSearchCheckedAt: searchRecord.checkedAt,
    query: searchRecord.query,
    productCount: products.length,
    selectedProduct: compactProduct(positioning.selected),
    positioning: {
      ...positioning,
      selected: compactProduct(positioning.selected),
      alternatives: Object.fromEntries(Object.entries(positioning.alternatives).map(([key, value]) => [key, compactProduct(value)])),
    },
    scenarioWinners,
    products,
    scoringNotice: 'Scores are editorial positioning aids based on visible current price and title-derived claims, not laboratory performance ratings.',
    executable: false,
    credentialsPersisted: false,
  };
}

function money(value) {
  return Number.isFinite(value) ? `${value.toLocaleString('ko-KR')}원` : '확인 필요';
}

function markdown(record) {
  const selected = record.positioning.selected;
  const alternativeEntries = Object.entries(record.positioning.alternatives).filter(([, product]) => product);
  const lines = [
    '# 도킹형 보조배터리 다제품 비교 — 스피디 C타입 포지셔닝',
    '',
    `- 확인 시각: ${record.checkedAt}`,
    `- 쿠팡 파트너스 검색어: ${record.query}`,
    `- 비교 표본: ${record.productCount}개`,
    '',
    '## 결론',
    '',
    `**${record.positioning.positioning}**`,
    '',
    `선택 제품은 **${selected.title}**, 현재 관측 가격은 **${money(selected.salePriceKrw)}**다.`,
    '',
    '## 왜 매력적인가',
    '',
    ...record.positioning.strengths.map(value => `- ${value}`),
    '',
    '## 어디서 밀리는가',
    '',
    ...record.positioning.tradeoffs.map(value => `- ${value}`),
    '',
    '## 비교 대안',
    '',
    '| 비교축 | 대안 | 현재 가격 | 용량/출력 단서 |',
    '|---|---|---:|---|',
    ...alternativeEntries.map(([key, product]) => (
      `| ${key} | ${product.title} | ${money(product.salePriceKrw)} | ${product.capacityMah ? `${product.capacityMah.toLocaleString('ko-KR')}mAh` : '-'} / ${product.powerW ? `${product.powerW}W` : product.fastChargeClaim ? '고속충전 표기' : '-'} |`
    )),
    '',
    '## 추천 대상',
    '',
    ...record.positioning.recommendedFor.map(value => `- ${value}`),
    '',
    '## 비추천 대상',
    '',
    ...record.positioning.notRecommendedFor.map(value => `- ${value}`),
    '',
    '## 아직 확인해야 할 증거',
    '',
    ...record.positioning.evidenceGaps.map(value => `- ${value}`),
    '',
    '## 블로그에서 잡을 메시지',
    '',
    '이 제품을 “최고 제품”으로 밀면 비교에서 약해진다. 대신 다음 메시지가 정확하다.',
    '',
    '> 가장 싸거나 가장 빠른 제품은 아니다. 다만 7천원 이하에서 C타입 도킹형을 가볍게 써보고 싶은 사람에게는 선택 이유가 분명하다.',
    '',
    '비교 글은 `가격 → 휴대성 → 속도 → 용량 → 케이스 호환 → 추천/비추천 대상` 순으로 구성한다.',
    '',
    '가격·옵션·재고는 변동될 수 있으므로 발행 직전 다시 확인한다.',
    '',
  ];
  return lines.join('\n');
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedPath === import.meta.url) {
  await mkdir(evidence, { recursive: true });
  await mkdir(references, { recursive: true });
  await mkdir(docs, { recursive: true });
  const search = JSON.parse(await readFile(path.join(references, 'coupang-product-search-latest.json'), 'utf8'));
  const selection = JSON.parse(await readFile(path.join(references, 'selected-product-speedy.json'), 'utf8'));
  const now = new Date();
  const record = buildComparisonRecord(search, selection, now);
  const stamp = now.toISOString().replace(/[-:.]/g, '').replace('Z', 'Z');
  const evidenceName = `coupang-product-comparison-${stamp}.json`;
  await writeFile(path.join(evidence, evidenceName), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  await writeFile(path.join(references, 'coupang-product-comparison.json'), JSON.stringify(record, null, 2) + '\n');
  await writeFile(path.join(docs, 'coupang-product-comparison-speedy-2026-09-19.md'), markdown(record));
  console.log(JSON.stringify({
    completed: true,
    productCount: record.productCount,
    selected: record.selectedProduct.title,
    selectedPriceKrw: record.selectedProduct.salePriceKrw,
    positioning: record.positioning.positioning,
    evidenceFile: evidenceName,
    executable: false,
  }));
}
