import { fingerprint } from '../../../../packages/contracts/src/index.mjs';
import { NaverEditorClient, EditorApiError } from '../../scripts/api/editor-client.mjs';
import { inspectEditorModel } from '../../scripts/api/editor-model.mjs';

// Discovery only. A browser supplies fresh document metadata and its normal SDK
// token. This is not a browser-free token provider or a commercial publisher.
export const PRIVATE_CREATE_TITLE = 'API HTTP 신규 발행 전달 검증 20260920';
export const PRIVATE_CREATE_PARAGRAPHS = [
  '이 글은 정상 브라우저에서 발급받은 nCaptcha 토큰을 독립 HTTP 실행기에 전달하는 비공개 검증용 글입니다.',
  '첫 번째 확인: 브라우저의 중복 발행 요청을 취소하고 HTTP 요청을 한 번만 보냅니다.',
  '두 번째 확인: 제목과 네 문단의 전체 순서 및 비공개 상태를 다시 조회합니다.',
  '이 결과는 브라우저 없는 토큰 발급이나 상업용 원고 품질 통과를 뜻하지 않습니다.',
];
export const HEADLESS_CREATE_TITLE = '헤드리스 HTTP 신규 발행 검증 20260920';
export const HEADLESS_CREATE_PARAGRAPHS = [
  '이 글은 로컬 헤드리스 Chrome의 정상 SDK 발급과 독립 HTTP 발행을 확인하는 비공개 검증용 글입니다.',
  '첫 번째 확인: 브라우저 창과 확장 없이 토큰과 새 문서를 준비합니다.',
  '두 번째 확인: 브라우저를 종료하고 다시 실행한 뒤 새 토큰을 발급받습니다.',
  '공개 글이나 상업용 원고의 품질 통과를 뜻하지 않습니다.',
];
export const COMPILED_CREATE_TITLE = '헤드리스 일반 경로 컴파일 검증 20260920';
export const COMPILED_CREATE_PARAGRAPHS = [
  '이 비공개 글은 일반 헤드리스 입력 공급자와 HTTP 문서 컴파일러의 연결을 검증합니다.',
  '새 SDK 입력을 받은 뒤 브라우저를 닫고 전체 본문을 독립 HTTP 문서로 다시 구성합니다.',
  '기존 조각을 덧붙이지 않고 제목과 네 문단의 전체 순서를 다시 조회합니다.',
  '상품 가격이나 상업용 원고의 품질 심사를 통과했다는 의미는 아닙니다.',
];
const FIXTURES = Object.freeze({
  browser: { title: PRIVATE_CREATE_TITLE, paragraphs: [...PRIVATE_CREATE_PARAGRAPHS],
    operation: 'browserIssuedPrivateCreateProbe' },
  headless: { title: HEADLESS_CREATE_TITLE, paragraphs: [...HEADLESS_CREATE_PARAGRAPHS],
    operation: 'headlessPrivateCreateProbe' },
  compiled: { title: COMPILED_CREATE_TITLE, paragraphs: [...COMPILED_CREATE_PARAGRAPHS],
    operation: 'compiledHeadlessPrivateCreateProbe' },
});
const ORIGIN = 'https://blog.naver.com';
const FIELDS = ['blogId', 'documentModel', 'mediaResources', 'populationParams', 'productApiVersion', 'tokenId'].sort();
const fail = code => { throw new EditorApiError(code); };
function fixtureFor(probe) {
  if (!Object.hasOwn(FIXTURES, probe)) fail('PROBE_PROFILE');
  const fixture = FIXTURES[probe];
  return { operation: fixture.operation, expected: { title: fixture.title,
    units: fixture.paragraphs.map(value => ({ type: 'text', value })) } };
}
const exact = (document, expected) => fingerprint({ title: document.title, units: document.units }) === fingerprint(expected);

export function validatePrivateCreateEnvelope(envelope, { blogId, now = new Date(), probe = 'browser' }) {
  const { expected } = fixtureFor(probe);
  if (!/^[a-zA-Z0-9_-]{3,50}$/.test(blogId || '') || envelope?.blogId !== blogId)
    fail('PROBE_SCOPE');
  // This is a local freshness policy, not an assertion of the server token TTL.
  const age = now.getTime() - Date.parse(envelope.observedAt || '');
  if (!Number.isFinite(age) || age < 0 || age > 60000) fail('PROBE_HANDOFF_EXPIRED');
  if (envelope.browserRequestCancelled !== true) fail('PROBE_BROWSER_REQUEST_NOT_CANCELLED');
  if (typeof envelope.body !== 'string' || Buffer.byteLength(envelope.body) > 256 * 1024)
    fail('PROBE_BODY');
  const body = new URLSearchParams(envelope.body);
  if (JSON.stringify([...body.keys()].sort()) !== JSON.stringify(FIELDS) ||
      body.get('blogId') !== blogId || body.get('productApiVersion') !== 'v1') fail('PROBE_FIELDS');
  const token = body.get('tokenId');
  if (!token || token.length > 8192 || /[\x00-\x20\x7f]/.test(token) ||
      Buffer.from(token, 'base64').toString('utf8').startsWith('FAILURE.')) fail('PROBE_TOKEN');
  let model, population, media;
  try {
    model = JSON.parse(body.get('documentModel'));
    population = JSON.parse(body.get('populationParams'));
    media = JSON.parse(body.get('mediaResources'));
    if (!exact(inspectEditorModel(model), expected)) fail('PROBE_CONTENT');
  } catch { fail('PROBE_CONTENT'); }
  if (population?.configuration?.openType !== 0 ||
      population?.populationMeta?.postWriteTimeType !== 'now' ||
      population?.populationMeta?.noticePostYn !== false ||
      ![undefined, null, 0, '0', ''].includes(population?.populationMeta?.logNo)) fail('PROBE_PRIVATE_CREATE_ONLY');
  if (JSON.stringify(Object.keys(media || {}).sort()) !== JSON.stringify(['file', 'image', 'video']) ||
      Object.values(media).some(value => !Array.isArray(value) || value.length)) fail('PROBE_MEDIA');
  return { body, handoffAgeMs: age };
}

async function boundedJson(response) {
  if (response.status !== 200 || !/application\/json/i.test(response.headers.get('content-type') || ''))
    fail('PROBE_WRITE_OUTCOME_UNKNOWN');
  const chunks = []; let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size > 1024 * 1024) fail('PROBE_WRITE_OUTCOME_UNKNOWN');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('PROBE_WRITE_OUTCOME_UNKNOWN'); }
}

export async function verifyPrivateCreate(envelope, {
  blogId, session, journal, fetchImpl = globalThis.fetch, now = () => new Date(), probe = 'browser',
}) {
  const { expected, operation } = fixtureFor(probe);
  const prepared = validatePrivateCreateEnvelope(envelope, { blogId, now: now(), probe });
  if (!journal) fail('JOURNAL_REQUIRED');
  const client = new NaverEditorClient({ blogId, session, fetchImpl, now });
  await client.loadEditor(undefined, { allowEmpty: true }); // Live owner verification.
  validatePrivateCreateEnvelope(envelope, { blogId, now: now(), probe });
  const key = journal.key(operation, { blogId, visibility: 'private' }, expected);
  await journal.reserve(key, { operation, blogId,
    expectedDocumentFingerprint: fingerprint(expected), visibility: 'private' });
  let logNo;
  try {
    const response = await fetchImpl(`${ORIGIN}/RabbitWrite.naver`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20000),
      headers: { accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        referer: `${ORIGIN}/PostWriteForm.naver?blogId=${blogId}`,
        cookie: session.cookieFor(`${ORIGIN}/RabbitWrite.naver`) },
      body: prepared.body,
    });
    const data = await boundedJson(response);
    if (data?.isSuccess !== true) fail('PROBE_APPLICATION_REJECTED');
    if (typeof data.result?.redirectUrl !== 'string') fail('PROBE_WRITE_OUTCOME_UNKNOWN');
    const redirect = new URL(data.result.redirectUrl, ORIGIN);
    if (redirect.origin !== ORIGIN || redirect.pathname !== '/PostView.naver' ||
        redirect.searchParams.get('blogId') !== blogId ||
        !/^\d{6,}$/.test(redirect.searchParams.get('logNo') || '')) fail('PROBE_WRITE_OUTCOME_UNKNOWN');
    logNo = redirect.searchParams.get('logNo');
    const owner = await client.loadEditor(logNo);
    const readback = await client.readPost(logNo, { authenticated: true, includeTags: false });
    if (owner.form.postConfiguration?.openType !== 0 || !exact(inspectEditorModel(owner.model), expected) ||
        !readback.targetIdentityVerified || !exact(readback, expected)) fail('PROBE_READBACK_MISMATCH');
    const receipt = { schemaVersion: 1, operation,
      checkedAt: now().toISOString(), source: 'http_write_with_browser_issued_inputs',
      blogId, logNo, accepted: true, browserRequestCancelled: true,
      handoffAgeMs: prepared.handoffAgeMs, protectedOwnerVerified: true,
      privateVisibilityVerified: true, readbackVerified: true, paragraphCount: 4,
      documentFingerprint: fingerprint(expected), htmlSha256: readback.htmlSha256,
      browserFreeTokenIssuanceVerified: false, browserFreeDocumentConstructionVerified: false,
      publicationQualityVerified: false };
    await journal.finish(key, 'verified', receipt);
    return receipt;
  } catch (error) {
    const code = error instanceof EditorApiError ? error.code : 'PROBE_WRITE_OUTCOME_UNKNOWN';
    await journal.finish(key, 'submitted_unknown', { code, logNo: logNo || null,
      retryAllowed: false }).catch(() => {});
    throw new EditorApiError(code, { readbackRequired: true, retryAllowed: false, logNo: logNo || null });
  }
}
