import { createHash } from 'node:crypto';

// The public Markdown representation is linked from the Photoroom documentation home page.
// This reader collects documentation only; it never invokes the image editing API.
export const DOCUMENT_URL = 'https://docs.photoroom.com/getting-started/introduction.md';
export const CANONICAL_URL = 'https://docs.photoroom.com/';
const MAX_BYTES = 500_000;
const fail = code => Object.assign(new Error(code), { code });

export function parsePhotoroomIntroduction(markdown) {
  if (!/^# Introduction\s*$/m.test(markdown)
    || !/they take an image as their input, apply edits to it, and return their result as a new edited image/i.test(markdown)
    || !/API consists of two API endpoints/i.test(markdown)
    || !/x-api-key.*HTTP header/i.test(markdown)) throw fail('PHOTOROOM_DOC_SCHEMA');
  return {
    title: 'Photoroom API: 입력 이미지와 인증 조건',
    summary: '공식 문서는 입력 이미지를 편집해 새 이미지를 반환하는 API를 설명한다. 배경 제거와 이미지 편집은 별도 엔드포인트이며, 실제 API 호출에는 계정의 키를 x-api-key 헤더로 보내야 한다. 이미지 처리 결과나 계정 권한은 이 공개 문서 읽기로 검증되지 않는다.',
    url: CANONICAL_URL,
    publisher: 'Photoroom',
    contentCoverage: 'full_document',
  };
}

export async function fetchPhotoroomDocs(_limit = 1, { fetchImpl = globalThis.fetch } = {}) {
  const response = await fetchImpl(DOCUMENT_URL, {
    method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(12_000),
    headers: { accept: 'text/markdown' },
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw fail(`PHOTOROOM_DOC_HTTP_${response.status}`);
  }
  const mime = response.headers.get('content-type')?.toLowerCase() || '';
  if (!mime.startsWith('text/markdown')) {
    await response.body?.cancel();
    throw fail('PHOTOROOM_DOC_MIME');
  }
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_BYTES) {
    await response.body?.cancel();
    throw fail('PHOTOROOM_DOC_TOO_LARGE');
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > MAX_BYTES) throw fail('PHOTOROOM_DOC_TOO_LARGE');
  const markdown = body.toString('utf8');
  const item = parsePhotoroomIntroduction(markdown);
  const sha256 = createHash('sha256').update(body).digest('hex');
  return {
    items: [{ ...item, bodySha256: sha256, bodyLength: body.length, bodyTruncated: false }],
    receipt: {
      sourceUrl: DOCUMENT_URL, canonicalUrl: CANONICAL_URL,
      collectionMethod: 'public_markdown_get', method: 'GET', httpStatus: response.status,
      httpStatuses: [response.status], contentType: mime,
      responseSha256: sha256, responseBytes: body.length, observedItems: 1,
      contentCoverage: 'full_document', browserUsed: false, credentialsUsed: false,
      executionMode: 'pure_http', liveReplay: true,
    },
  };
}
