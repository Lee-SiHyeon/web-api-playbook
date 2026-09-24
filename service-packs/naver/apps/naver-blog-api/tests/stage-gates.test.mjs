import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateStageGate,
  inspectApiOnlyState,
  markdownMetrics,
} from '../workflows/affiliate-content-e2e/stage-gates.mjs';

test('API-only five-state gate accepts public credential boundaries', () => {
  const result = inspectApiOnlyState({
    captured: true,
    client_exists: true,
    remnant_free: true,
    credential_propagated: 'not_applicable_public',
    live_replay: true,
  });
  assert.equal(result.passed, true);
});

test('API-only gate rejects a captured contract without live replay', () => {
  const result = inspectApiOnlyState({
    captured: true,
    clientExists: true,
    remnantFree: true,
    credentialPropagated: true,
    liveReplay: false,
  });
  assert.equal(result.passed, false);
  assert.ok(result.failed.includes('liveReplay'));
});

test('draft gate rejects one giant paragraph even when character count is high', () => {
  const markdown = `# title\n\n${'본문 문장 '.repeat(500)}`;
  const gate = evaluateStageGate('07-draft', {
    draft: {
      markdown,
      metadata: {
        productCount: 5,
        affiliateDisclosurePresent: true,
        directExperienceClaimed: false,
        affiliateUrl: 'https://link.coupang.com/a/example123',
        claimCount: 4,
        evidenceCount: 4,
      },
    },
  });
  assert.equal(gate.passed, false);
  assert.ok(gate.failedChecks.includes('noGiantParagraph'));
  assert.ok(gate.failedChecks.includes('structuredParagraphs'));
});

test('markdown metrics count physical and semantic structure separately', () => {
  const metrics = markdownMetrics('# title\n\n## A\n\n짧은 문단\n\n## B\n\n두 번째 문단');
  assert.equal(metrics.headingCount, 2);
  assert.ok(metrics.paragraphCount >= 5);
  assert.equal(metrics.giantLineCount, 0);
});

test('trend stage fails when normal execution used a browser', () => {
  const complete = {
    captured: true,
    clientExists: true,
    remnantFree: true,
    credentialPropagated: 'not_applicable_public',
    liveReplay: true,
  };
  const gate = evaluateStageGate('01-trends', {
    data: {
      sourceStates: {
        naverShoppingInsight: complete,
        naverAutocomplete: complete,
        googleTrendingRss: complete,
      },
      browserUsedForNormalExecution: true,
      credentialsPersisted: false,
      seedExpansions: [{ seed: 'x', suggestions: [] }],
      coverage: {
        shoppingContractsRequested: 3,
        shoppingContractsSucceeded: 3,
        autocompleteSeedsSucceeded: 1,
      },
    },
  });
  assert.equal(gate.passed, false);
  assert.ok(gate.failedChecks.includes('normalExecutionBrowserFree'));
});
