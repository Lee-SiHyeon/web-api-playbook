import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { inspectDuplication } from '../scripts/gates/content-duplication.mjs';
import { auditPost } from '../scripts/api/post-audit.mjs';
const unit = value => ({ type: 'text', value });
const long = '이 문장은 중복 본문 검사를 위한 충분히 긴 문장입니다. 공백과 인용 형식이 달라져도 같은 문단으로 검사합니다.';

test('duplicate prose is blocked across whitespace and quotation changes', () => {
  const result = inspectDuplication([unit(long), { type: 'quote', value: long.replaceAll(' ', '  ') }]);
  assert.deepEqual(result.duplicateParagraphs, [[1, 2]]);
  assert.equal(result.noDuplicateProse, false);
});
test('repeated short consecutive sections are blocked, while headings and CTA are advisory', () => {
  const section = ['첫 문단은 짧지만 반복된 전체 구간을 탐지할 수 있어야 합니다.',
    '둘째 문단 역시 하나만 반복되면 문맥을 따로 판단할 필요가 있습니다.',
    '셋째 문단까지 동일하다면 중복 구간으로 검사를 통과하지 못합니다.'].map(unit);
  assert.equal(inspectDuplication([...section, ...section]).noDuplicateProse, false);
  const ok = inspectDuplication([unit('01. 주문 전에 확인할 항목'), unit('주문 전에 확인할 항목'),
    unit('상품 확인'), unit('상품 확인'), unit('https://example.com/'), unit('https://example.com/')]);
  assert.equal(ok.noDuplicateProse, true);
  assert.deepEqual(ok.repeatedHeadings[0].units, [1, 2]);
});
test('audit detects identical image pixels at different upload URLs and late disclosure', async () => {
  const png = new PNG({ width: 2, height: 2 }); png.data.fill(255);
  const bytes = PNG.sync.write(png);
  const post = { source: 'independent_http', httpStatus: 200, targetIdentityVerified: true,
    smartEditorBodyPresent: true, units: [
      { type: 'image', value: 'https://postfiles.pstatic.net/first/test.png' },
      unit('이 글은 쿠팡 파트너스 활동의 일환입니다.'),
      { type: 'image', value: 'https://postfiles.pstatic.net/second/test.png' }] };
  const audit = await auditPost(post, { fetchImpl: async (_, init) => {
    assert.equal(init.redirect, 'manual'); assert.equal(init.headers, undefined);
    return new Response(bytes, { headers: { 'content-type': 'image/png' } });
  } });
  assert.deepEqual(audit.duplicateImages, [[1, 3]]);
  assert.equal(audit.checks.disclosureFirst, false);
  assert.equal(audit.passed, false);
});
test('image errors and off-scope destinations never produce a passing audit', async () => {
  let requests = 0;
  const result = await auditPost({ source: 'independent_http', httpStatus: 200,
    targetIdentityVerified: true, smartEditorBodyPresent: true,
    units: [unit('쿠팡 파트너스 활동의 일환'), { type: 'image', value: 'https://localhost/private' }] },
  { fetchImpl: async () => { requests++; } });
  assert.equal(requests, 0); assert.equal(result.checks.allImagesVerified, false);
  assert.equal(result.passed, false);
});
test('audit retains the observed image query instead of hashing a thumbnail fallback', async () => {
  const png = new PNG({ width: 2, height: 2 }); png.data.fill(255);
  const bytes = PNG.sync.write(png), base = 'https://postfiles.pstatic.net/synthetic/image.png';
  const audit = await auditPost({ source: 'independent_http', httpStatus: 200,
    targetIdentityVerified: true, smartEditorBodyPresent: true,
    units: [unit('쿠팡 파트너스 활동의 일환'), { type: 'image', value: base }],
    imageResources: [{ position: 2, url: base + '?type=w773' }] }, {
    fetchImpl: async url => { assert.equal(url, base + '?type=w773'); return new Response(bytes, { headers: { 'content-type': 'image/png' } }); },
  });
  assert.equal(audit.passed, true);
});
