import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectApiOnlyState } from '../../workflows/affiliate-content-e2e/stage-gates.mjs';
import { readJsonFile } from './json-io.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function optionalJson(target) {
  try { return await readJsonFile(target); } catch { return null; }
}

const trendPath = path.join(root, 'research', 'trend-radar', 'conversion-receipt.json');
const communityPath = path.join(root, 'research', 'community-radar', 'latest.json');
const operationsPath = path.join(root, 'references', 'implemented-operations.json');
const outputPath = path.join(root, 'references', 'api-only-boundaries.json');
const docsPath = path.resolve(root, '..', '..', 'docs', 'api-only-boundaries-2026-09-20.md');

const [trend, community, operations, editor] = await Promise.all([
  optionalJson(trendPath),
  optionalJson(communityPath),
  optionalJson(operationsPath),
  optionalJson(path.join(root,'references','editor-api-contracts.json')),
]);
const priorRecord = await optionalJson(outputPath);

const trendRequired = ['naverShoppingInsight', 'naverAutocomplete'];
const trendInspections = trendRequired.map(name => inspectApiOnlyState(trend?.sourceStates?.[name], { source: name }));
const communityInspection = inspectApiOnlyState(community?.sourceState, { source: 'naverPublicCommunitySearch' });
const operationRows = Array.isArray(operations) ? operations : [];
const completeOperations = operationRows.filter(row => inspectApiOnlyState({
  captured: Boolean(row.captured),
  client_exists: row.client_exists,
  remnant_free: row.remnant_free,
  credential_propagated: row.credential_propagated,
  live_replay: row.live_replay,
}, { source: row.operation }).passed);

const domains = [
  {
    id: 'trend-radar',
    normalTransport: 'independent_http_api_only',
    apiOnlyComplete: trendInspections.every(item => item.passed),
    requiredSources: trendRequired,
    inspections: trendInspections,
    browserRequiredForNormalExecution: false,
  },
  {
    id: 'community-radar',
    normalTransport: 'independent_http_public_search',
    apiOnlyComplete: communityInspection.passed,
    inspections: [communityInspection],
    browserRequiredForNormalExecution: false,
  },
  {
    id: 'naver-blog-statistics',
    normalTransport: 'independent_authenticated_http_for_verified_operations',
    apiOnlyComplete: operationRows.length > 0 && completeOperations.length === operationRows.length,
    verifiedOperationCount: completeOperations.length,
    candidateOperationCount: operationRows.length,
    incompleteOperations: operationRows
      .filter(row => !completeOperations.includes(row))
      .map(row => row.operation),
    browserRequiredForNormalExecution: false,
  },
  {
    id: 'coupang-product-refresh',
    normalTransport: 'authenticated_browser_portal_capture_then_offline_normalization',
    apiOnlyComplete: false,
    reason: '상품 검색·가격 갱신은 로그인된 쿠팡 파트너스 포털에 의존하며 공식 API key 기반 live replay가 아직 없다.',
    browserRequiredForNormalExecution: true,
  },
  {
    id: 'naver-smarteditor-publish',
    normalTransport: 'independent_http_with_explicit_headless_inputs_for_private_creation',
    apiOnlyComplete: Boolean(editor?.operations?.length) && editor.operations.every(row=>inspectApiOnlyState(row,{source:row.operation}).passed),
    reason: '기존 수정·초안·PNG 업로드는 HTTP 경로다. 일반 비공개 신규 생성에는 명시적인 헤드리스 SDK 입력을 연결했으며 공유 입력 공급자·문서 컴파일러의 비공개 기술 발행을 실검증했다. 상업용 전체 게이트 발행과 공개 신규 생성은 미검증이며 공개 신규 생성·확장 서버 발행은 차단된다. 로그인 쿠키 연장도 미검증이다.',
    browserRequiredForNormalExecution: true,
    browserFreeExistingUpdates: true,
    operations: editor?.operations?.map(row=>({operation:row.operation,...inspectApiOnlyState(row,{source:row.operation})})) || [],
    requiredMechanicalGates: [
      'publisher-job',
      'publication-review',
      'publication-artifacts',
      'independent-http-preflight',
      'explicit-publish-authorization',
      'publisher-result',
      'exact-public-readback',
      'post-content-audit',
    ],
  },
];

// Ignored runtime receipts are not copied into an isolated checkout. Preserve
// unrelated historical evidence explicitly instead of rewriting it as a failure.
for (const [id, available] of [['trend-radar', trend], ['community-radar', community]]) {
  const prior = priorRecord?.domains?.find(domain => domain.id === id);
  const index = domains.findIndex(domain => domain.id === id);
  if (!available && prior) domains[index] = { ...prior,
    evidenceStatus: 'historical_only_runtime_receipt_unavailable',
    evidenceCheckedAt: prior.evidenceCheckedAt || priorRecord.checkedAt };
}

const record = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  policy: {
    apiOnlyLabelRequiresAllFiveStates: true,
    fiveStates: ['captured', 'client_exists', 'remnant_free', 'credential_propagated', 'live_replay'],
    browserAutomationMayNotBeLabeledApiOnly: true,
  },
  domains,
};
await mkdir(path.dirname(outputPath), { recursive: true });
await mkdir(path.dirname(docsPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(record, null, 2) + '\n', 'utf8');

const statsDomain = domains.find(item => item.id === 'naver-blog-statistics');
const lines = [
  '# API-only 경계와 기계적 게이트 — 2026-09-20',
  '',
  '## 결론',
  '',
  '- 트렌드·공개 커뮤니티의 로컬 실행 영수증이 없으면 아래 기록은 날짜가 명시된 과거 검증이며, 이번 실행에서 새로 재현했다는 뜻이 아니다.',
  `- 네이버 통계 계약은 ${statsDomain.verifiedOperationCount}/${statsDomain.candidateOperationCount}개만 live replay까지 완료되어 전체 완료가 아니다.`,
  '- 쿠팡 상품 갱신은 로그인된 포털 캡처가 필요해 아직 API-only가 아니다.',
  '- 네이버 소유자 조회·비공개 글 수정·기존 초안 수정·PNG 업로드는 HTTP 실검증을 통과했다. 신규 글 및 빈 초안 생성은 아직 전체 API-only 완료가 아니다.',
  '',
  '이번 서식 붕괴는 API-only 데이터 수집 실패가 아니라, Markdown 초안과 SmartEditor 실제 문서 사이의 구조 검증이 게시 전에 강제되지 않았던 문제였다.',
  '',
  '## 5단계 정의',
  '',
  '```text',
  'captured',
  'client_exists',
  'remnant_free',
  'credential_propagated',
  'live_replay',
  '```',
  '',
  '다섯 단계가 모두 완료된 경로에만 `API-only`라는 이름을 사용한다.',
  '',
  '## 현재 경계',
  '',
  '| 영역 | 정상 경로 | API-only 완료 | 브라우저 필요 |',
  '|---|---|---:|---:|',
  ...domains.map(item => `| ${item.id} | ${item.normalTransport} | ${item.apiOnlyComplete ? '예' : '아니오'} | ${item.browserRequiredForNormalExecution ? '예' : '아니오'} |`),
  '',
  ...domains.filter(item => item.evidenceStatus).map(item => `${item.id}: ${item.evidenceCheckedAt} 과거 검증 보존; 현재 작업 트리에 실행 영수증 없음.`),
  '신규 비공개 생성은 일반 헤드리스 입력 공급자와 HTTP 실행기를 연결했다. 기존 글·초안 수정과 PNG 업로드에는 브라우저 엔진이 필요 없다.',
  '공개 신규 생성과 순수 HTTP 토큰 발급은 계속 차단된다. [최신 검증](naver-duplicate-audit-and-hybrid-publisher-2026-09-20.md)을 참조한다.',
  '',
  '## 게시 fail-closed 게이트',
  '',
  '```text',
  'publisher job schema·파일·문단·링크 검증',
  '→ SmartEditor dry-run 문단·이미지·표식 검증',
  '→ 명시적 publish authorization',
  '→ 게시 실행',
  '→ 전체 순서 HTTP 대조·실제 표시 이미지 중복 검사',
  '```',
  '',
];
await writeFile(docsPath, lines.join('\n'), 'utf8');
console.log(JSON.stringify({
  completed: true,
  output: outputPath,
  docs: docsPath,
  completeDomains: domains.filter(item => item.apiOnlyComplete).map(item => item.id),
  incompleteDomains: domains.filter(item => !item.apiOnlyComplete).map(item => item.id),
  verifiedStatisticOperations: statsDomain.verifiedOperationCount,
  candidateStatisticOperations: statsDomain.candidateOperationCount,
}));
