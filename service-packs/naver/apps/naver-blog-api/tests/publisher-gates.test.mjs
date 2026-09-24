import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePublisherJobGate, evaluatePublisherResultGate } from '../scripts/gates/publisher-gates.mjs';
import { publisherContentFingerprint } from '../scripts/gates/publisher-gates.mjs';

function job(overrides = {}) {
  return {
    jobId: 'publisher-gate-test',
    blogId: '4053103',
    mode: 'publish',
    target: { type: 'update', logNo: '224417664446' },
    publish: false,
    title: '충분히 긴 테스트 제목입니다',
    bodyBlocks: [
      { type: 'notice', text: '제휴 고지' },
      { type: 'heading', text: '01. 소제목' },
      { type: 'paragraph', text: '짧은 본문입니다.' },
      { type: 'list', items: ['항목 1', '항목 2'] },
      { type: 'link', label: '상품 확인', url: 'https://link.coupang.com/a/example123' },
    ],
    affiliate: { url: 'https://link.coupang.com/a/example123' },
    requiredMarkers: ['제휴 고지', '01. 소제목'],
    requiredSeparateParagraphs: ['01. 소제목'],
    minParagraphs: 6,
    maxParagraphLength: 200,
    minImageComponents: 0,
    ...overrides,
  };
}

test('publisher job gate accepts a structured dry-run job', async () => {
  const gate = await evaluatePublisherJobGate(job(), { checkImageFiles: false });
  assert.equal(gate.passed, true);
});

test('publisher job gate rejects collapsed content and mismatched affiliate links', async () => {
  const gate = await evaluatePublisherJobGate(job({
    bodyBlocks: [{ type: 'paragraph', text: 'x'.repeat(1000) }],
  }), { checkImageFiles: false });
  assert.equal(gate.passed, false);
  assert.ok(gate.failedChecks.includes('paragraphFloorMet'));
  assert.ok(gate.failedChecks.includes('paragraphLengthBounded'));
  assert.ok(gate.failedChecks.includes('affiliateLinkBlockMatches'));
});

test('append job gate combines a verified existing-draft baseline with appended blocks', async () => {
  const appendJob = job({
    appendExistingDraft: true,
    existingDraftBaseline: {
      paragraphCount: 20,
      imageComponentCount: 3,
      imageCount: 3,
      markers: ['제휴 고지'],
    },
    minParagraphs: 26,
    minImageComponents: 3,
    minImageCount: 3,
  });
  const gate = await evaluatePublisherJobGate(appendJob, { checkImageFiles: false });
  assert.equal(gate.passed, true);
});

test('append dry-run result combines baseline images with newly uploaded images', () => {
  const currentJob = job({
    appendExistingDraft: true,
    partialDraftStep: true,
    existingDraftBaseline: {
      paragraphCount: 20,
      imageComponentCount: 3,
      imageCount: 3,
      markers: ['제휴 고지'],
    },
    minParagraphs: 21,
    minImageComponents: 4,
    minImageCount: 4,
  });
  const payload = {
    jobId: currentJob.jobId,
    ok: true,
    mode: 'publish',
    data: {
      published: false,
      titleText: currentJob.title,
      missing: [],
      upload: { observed: 1 },
      draft: {
        nonEmptyParagraphs: 21,
        maxParagraphLength: 90,
        imageComponentCount: 4,
        imageResourceCount: 4,
        quoteComponentCount: 0,
        dividerComponentCount: 0,
        paragraphTexts: ['제휴 고지', currentJob.affiliate.url],
        quoteTexts: [],
        ogLinkTexts: [],
      },
    },
  };
  const gate = evaluatePublisherResultGate(currentJob, payload);
  assert.equal(gate.checks.uploadCountVerified, true);
});

test('partial append dry-runs may defer the affiliate card until the final chunk', async () => {
  const partial = job({
    partialDraftStep: true,
    appendExistingDraft: true,
    bodyBlocks: [
      { type: 'quote', text: '중간 소제목' },
      { type: 'paragraph', text: '중간 본문입니다.' },
      { type: 'divider' },
      { type: 'paragraph', text: '다음 본문입니다.' },
      { type: 'paragraph', text: '마무리 전 본문입니다.' },
    ],
    requiredMarkers: ['중간 소제목'],
    requiredSeparateParagraphs: ['중간 소제목'],
    minParagraphs: 4,
    minQuoteComponents: 1,
    minDividerComponents: 1,
  });
  const gate = await evaluatePublisherJobGate(partial, { checkImageFiles: false });
  assert.equal(gate.passed, true);
  assert.equal(gate.checks.partialStepSafe, true);
});

test('verify-only job may inspect an existing draft without rewriting it', async () => {
  const verifyOnly = job({
    verifyExistingDraftOnly: true,
    preserveExistingOgLink: true,
    bodyBlocks: [],
    existingDraftBaseline: {
      paragraphCount: 64,
      imageComponentCount: 9,
      imageCount: 9,
      quoteComponentCount: 2,
      dividerComponentCount: 1,
      markers: ['제휴 고지', '최종 선택'],
    },
    requiredMarkers: ['제휴 고지', '최종 선택'],
    requiredSeparateParagraphs: ['최종 선택'],
    minParagraphs: 60,
    minImageComponents: 9,
    minImageCount: 9,
    minQuoteComponents: 2,
    minDividerComponents: 1,
  });
  const gate = await evaluatePublisherJobGate(verifyOnly, { checkImageFiles: false });
  assert.equal(gate.passed, true);
});

test('dry-run result gate requires SmartEditor structure before publish', () => {
  const currentJob = job();
  const payload = {
    jobId: currentJob.jobId,
    ok: true,
    mode: 'publish',
    data: {
      published: false,
      titleText: currentJob.title,
      missing: [],
      upload: { observed: 0 },
      draft: {
        nonEmptyParagraphs: 8,
        maxParagraphLength: 90,
        imageComponentCount: 0,
        paragraphTexts: ['제휴 고지', '01. 소제목', '상품 확인', currentJob.affiliate.url],
      },
    },
  };
  const gate = evaluatePublisherResultGate(currentJob, payload);
  assert.equal(gate.passed, true);
});

test('published result gate fails without public HTTP read-back', () => {
  const currentJob = authorizedJob();
  const payload = {
    jobId: currentJob.jobId,
    ok: true,
    mode: 'publish',
    data: {
      published: true,
      receipt: { url: 'https://blog.naver.com/PostView.naver?logNo=1', pageTitle: currentJob.title },
    },
  };
  const gate = evaluatePublisherResultGate(currentJob, payload);
  assert.equal(gate.passed, false);
  assert.ok(gate.failedChecks.includes('publicHttpVerified'));
});

test('dry-run may preserve exactly one existing OG affiliate card', async () => {
  const currentJob = job({
    preserveExistingOgLink: true,
    bodyBlocks: [
      { type: 'notice', text: '제휴 고지' },
      { type: 'heading', text: '선택 기준' },
      { type: 'paragraph', text: '본문입니다.' },
      { type: 'list', items: ['항목 1', '항목 2'] },
      { type: 'paragraph', text: '마무리입니다.' },
    ],
    requiredMarkers: ['제휴 고지', '선택 기준'],
    requiredSeparateParagraphs: ['선택 기준'],
    minParagraphs: 6,
  });
  const jobGate = await evaluatePublisherJobGate(currentJob, { checkImageFiles: false });
  assert.equal(jobGate.passed, true);
  const payload = {
    jobId: currentJob.jobId,
    ok: true,
    mode: 'publish',
    data: {
      published: false,
      titleText: currentJob.title,
      missing: [],
      upload: { observed: 0 },
      draft: {
        nonEmptyParagraphs: 7,
        maxParagraphLength: 80,
        imageComponentCount: 0,
        imageResourceCount: 0,
        quoteComponentCount: 0,
        dividerComponentCount: 0,
        ogLinkCount: 1,
        paragraphTexts: ['제휴 고지', '선택 기준', '본문입니다.', '항목 1', '항목 2', '마무리입니다.'],
      },
    },
  };
  const resultGate = evaluatePublisherResultGate(currentJob, payload);
  assert.equal(resultGate.passed, true);
});

test('publish job requires fresh explicit authorization and dry-run fingerprints', async () => {
  const unauthorized = job({ dryRun: false, publish: true, publishSettings: { visibility: 'public', timing: 'current' } });
  const gate = await evaluatePublisherJobGate(unauthorized, { checkImageFiles: false });
  assert.equal(gate.passed, false);
  assert.ok(gate.failedChecks.includes('explicitAuthorizationPresent'));
  assert.ok(gate.failedChecks.includes('preflightPassed'));
  assert.ok(gate.failedChecks.includes('commercialSnapshotPresent'));

  const authorized = authorizedJob();
  const valid = await evaluatePublisherJobGate(authorized, {
    checkImageFiles: false,
    now: new Date(authorized.authorization.approvedAt),
  });
  assert.equal(valid.passed, false);
  assert.ok(valid.failedChecks.includes('publicationReviewPassed'));
  assert.ok(valid.failedChecks.includes('independentHttpWriterRequired'));
});

function authorizedJob() {
  const checkedAt = '2026-09-20T05:00:00.000Z';
  const current = job({
    dryRun: false,
    publish: true,
    publishSettings: { visibility: 'public', timing: 'current' },
    commercialSnapshot: {
      schemaVersion: 1,
      checkedAt,
      productTitle: '테스트 상품',
      payablePriceKrw: 10000,
      affiliateUrl: 'https://link.coupang.com/a/example123',
      variant: '기본',
      stockState: 'in_stock',
      credentialsPersisted: false,
      linkVerification: {
        passed: true,
        checkedAt,
        targetMatches: true,
      },
    },
    preflight: {
      passed: true,
      dryRunJobId: 'publisher-gate-test-dry',
      dryRunJobFingerprint: 'a'.repeat(64),
      dryRunResultFingerprint: 'b'.repeat(64),
      dryRunGateFingerprint: 'c'.repeat(64),
    },
    authorization: {
      approved: true,
      approvedBy: 'user',
      approvedAt: checkedAt,
      scope: 'publish_once',
    },
  });
  current.authorization.contentFingerprint = publisherContentFingerprint(current);
  return current;
}


test('publisher job and result gates account for image strips, quotations, and dividers', async () => {
  const currentJob = job({
    bodyBlocks: [
      { type: 'notice', text: '?? ??' },
      { type: 'quote', text: '?? ?? ? ?' },
      { type: 'paragraph', text: '?? ?????.' },
      { type: 'imageStrip', files: ['a.png', 'b.png'] },
      { type: 'divider' },
      { type: 'link', label: '?? ??', url: 'https://link.coupang.com/a/example123' },
    ],
    minParagraphs: 4,
    minImageComponents: 1,
    minImageCount: 2,
    minQuoteComponents: 1,
    minDividerComponents: 1,
    requiredMarkers: ['?? ??', '?? ?? ? ?'],
    requiredSeparateParagraphs: ['?? ?? ? ?'],
  });
  const jobGate = await evaluatePublisherJobGate(currentJob, { checkImageFiles: false });
  assert.equal(jobGate.passed, true);
  const payload = {
    jobId: currentJob.jobId,
    ok: true,
    mode: 'publish',
    data: {
      published: false,
      titleText: currentJob.title,
      missing: [],
      upload: { observed: 2 },
      draft: {
        nonEmptyParagraphs: 4,
        maxParagraphLength: 80,
        imageComponentCount: 1,
        imageResourceCount: 2,
        quoteComponentCount: 1,
        dividerComponentCount: 1,
        paragraphTexts: ['?? ??', '?? ?? ? ?', '?? ?????.', currentJob.affiliate.url],
      },
    },
  };
  const resultGate = evaluatePublisherResultGate(currentJob, payload);
  assert.equal(resultGate.passed, true);
});
