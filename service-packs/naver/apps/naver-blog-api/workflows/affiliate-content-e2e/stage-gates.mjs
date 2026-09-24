import { fingerprint } from '../../../../packages/contracts/src/index.mjs';
import { evaluateClaimEvidenceGate } from '../../scripts/gates/claim-evidence-gates.mjs';

const ALLOWED_FORMATS = new Set([
  'multi_product_comparison',
  'problem_solution',
  'community_consensus',
]);

function boolean(value) {
  return value === true || value === 'verified';
}

function stateField(state, camel, snake) {
  return state?.[camel] ?? state?.[snake];
}

export function inspectApiOnlyState(state, { source = 'unknown', optional = false } = {}) {
  const credential = stateField(state, 'credentialPropagated', 'credential_propagated');
  const checks = {
    captured: stateField(state, 'captured', 'captured') === true,
    clientExists: stateField(state, 'clientExists', 'client_exists') === true,
    remnantFree: stateField(state, 'remnantFree', 'remnant_free') === true,
    credentialBoundary: credential === true || String(credential || '').startsWith('not_applicable_'),
    liveReplay: boolean(stateField(state, 'liveReplay', 'live_replay')),
  };
  const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  return {
    source,
    optional,
    checks,
    passed: optional || failed.length === 0,
    failed,
    reason: state?.reason || null,
  };
}

function markdownMetrics(markdown) {
  const text = String(markdown || '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const paragraphs = text
    .split(/\n\s*\n/g)
    .map(value => value.trim())
    .filter(value => value && !value.startsWith('|') && !/^[-*]\s/.test(value) && !/^\d+\.\s/.test(value));
  const prose = paragraphs.filter(value => !/^#{1,6}\s/.test(value) && !/^```/.test(value));
  return {
    characters: text.length,
    headingCount: lines.filter(line => /^##\s+/.test(line)).length,
    paragraphCount: paragraphs.length,
    maxParagraphLength: Math.max(0, ...prose.map(value => value.length)),
    giantLineCount: lines.filter(line => line.length > 800).length,
    blankLineCount: lines.filter(line => line.trim() === '').length,
  };
}

function productRows(receipt) {
  return receipt?.brief?.comparisonProducts || receipt?.comparison?.products || [];
}

function stageChecks(stage, receipt) {
  switch (stage) {
    case '00-policy':
      return {
        policyDecisionPresent: typeof receipt?.policy?.allowed === 'boolean',
        riskClassificationPresent: typeof receipt?.policy?.riskLevel === 'string'
          && Array.isArray(receipt?.policy?.matchedRules),
      };
    case '01-trends': {
      const states = receipt?.data?.sourceStates || {};
      const shopping = inspectApiOnlyState(states.naverShoppingInsight, { source: 'naverShoppingInsight' });
      const autocomplete = inspectApiOnlyState(states.naverAutocomplete, { source: 'naverAutocomplete' });
      const google = inspectApiOnlyState(states.googleTrendingRss, { source: 'googleTrendingRss', optional: true });
      return {
        apiOnlyShopping: shopping.passed,
        apiOnlyAutocomplete: autocomplete.passed,
        optionalGoogleStateRecorded: Boolean(states.googleTrendingRss),
        normalExecutionBrowserFree: receipt?.data?.browserUsedForNormalExecution === false,
        credentialsNotPersisted: receipt?.data?.credentialsPersisted !== true,
        requestedSeedPresent: Array.isArray(receipt?.data?.seedExpansions) && receipt.data.seedExpansions.length > 0,
        shoppingCoverageComplete: Number(receipt?.data?.coverage?.shoppingContractsRequested || 0) > 0
          && receipt.data.coverage.shoppingContractsRequested === receipt.data.coverage.shoppingContractsSucceeded,
        autocompleteCoveragePresent: Number(receipt?.data?.coverage?.autocompleteSeedsSucceeded || 0) > 0,
        _details: { shopping, autocomplete, google },
      };
    }
    case '02-topic-selection':
      return {
        selectedTopicPresent: typeof receipt?.selected === 'string' && receipt.selected.trim().length > 2,
        selectedTopicAllowed: Array.isArray(receipt?.candidates)
          && receipt.candidates.some(candidate => candidate.keyword === receipt.selected),
        candidateSetBounded: Array.isArray(receipt?.candidates) && receipt.candidates.length >= 1 && receipt.candidates.length <= 8,
      };
    case '03-reference-brief': {
      const posts = receipt?.data?.posts || [];
      const urls = posts.map(post => post?.url || post?.search?.href).filter(Boolean);
      return {
        enoughReferencePosts: Number(receipt?.data?.summary?.postCount || 0) >= 5,
        uniqueReferenceUrls: urls.length === new Set(urls).size,
        referenceMetricsPresent: Number(receipt?.data?.summary?.medianTextLength || 0) > 0
          && Number(receipt?.data?.summary?.medianImageCount ?? 0) >= 0,
        failuresBounded: Number(receipt?.data?.failureCount || 0) <= 3,
      };
    }
    case '04-community-radar': {
      const state = inspectApiOnlyState(receipt?.data?.sourceState, { source: 'communitySearch' });
      return {
        apiOnlyStateComplete: state.passed,
        queryCoverage: Number(receipt?.data?.querySuccessCount || 0) >= 6,
        browserFree: receipt?.data?.browserUsed === false,
        credentialsNotPersisted: receipt?.data?.credentialsPersisted === false,
        noPersonalUsernames: receipt?.data?.personalUsernamesCaptured === false,
        noFullComments: receipt?.data?.fullCommentsCaptured === false,
        canonicalArticlesPresent: Number(receipt?.data?.articleCount || 0) > 0,
        _details: { state },
      };
    }
    case '05-product-comparison': {
      const products = productRows(receipt);
      const priced = products.filter(product => Number.isFinite(Number(product?.salePriceKrw)));
      const keys = products.map(product => `${product?.title || ''}|${product?.salePriceKrw ?? ''}`);
      const selectedTitle = receipt?.brief?.selectedProduct?.title || receipt?.comparison?.selectedProduct?.title;
      return {
        enoughComparableProducts: products.length >= 4,
        currentData: receipt?.freshness?.fresh === true,
        topicRelevant: receipt?.relevance?.relevant === true,
        comparisonReadOnly: receipt?.comparison?.executable === false,
        affiliateLinkShape: /^https:\/\/link\.coupang\.com\/a\/[A-Za-z0-9]+$/.test(receipt?.affiliateUrl || ''),
        everyCandidatePriced: priced.length === products.length,
        noDuplicateProductRows: keys.length === new Set(keys).size,
        selectedProductInCohort: Boolean(selectedTitle) && products.some(product => product?.title === selectedTitle),
        sourceDigestsPresent: Object.values(receipt?.sourceDigests || {}).filter(Boolean).length >= 3,
      };
    }
    case '05a-claim-evidence': {
      const claimGate = evaluateClaimEvidenceGate(receipt?.ledger, {
        now: new Date(receipt?.checkedAt || Date.now()),
      });
      return {
        claimLedgerPresent: Boolean(receipt?.ledger),
        claimGatePassed: claimGate.passed,
        supportedClaimsPresent: Number(claimGate.metrics?.supportedCount || 0) >= 2,
        noExpiredClaims: !claimGate.failedChecks.includes('noExpiredClaims'),
        sourcesResolve: !claimGate.failedChecks.includes('sourceReferencesResolve'),
        _details: { claimGate },
      };
    }
    case '06-format-selection':
      return {
        formatAllowed: ALLOWED_FORMATS.has(receipt?.selected),
        fallbackRecorded: typeof receipt?.deterministicFallback === 'string',
      };
    case '07-draft': {
      const metrics = markdownMetrics(receipt?.draft?.markdown);
      return {
        minimumLength: metrics.characters >= 1800,
        structuredParagraphs: metrics.paragraphCount >= 20,
        noGiantParagraph: metrics.maxParagraphLength <= 700,
        noGiantPhysicalLine: metrics.giantLineCount === 0,
        enoughSections: metrics.headingCount >= 8,
        whitespaceStructurePresent: metrics.blankLineCount >= 15,
        productCountRecorded: Number(receipt?.draft?.metadata?.productCount || 0) >= 4,
        disclosureRecorded: receipt?.draft?.metadata?.affiliateDisclosurePresent === true,
        noFalseExperienceClaim: receipt?.draft?.metadata?.directExperienceClaimed === false,
        affiliateLinkRecorded: /^https:\/\/link\.coupang\.com\/a\/[A-Za-z0-9]+$/.test(receipt?.draft?.metadata?.affiliateUrl || ''),
        claimLedgerLinked: Number(receipt?.draft?.metadata?.claimCount || 0) >= 3
          && Number(receipt?.draft?.metadata?.evidenceCount || 0) >= 3,
        _details: { metrics },
      };
    }
    case '08-chart':
      return {
        chartDeclared: receipt?.exists === true,
        chartPathPresent: typeof receipt?.output === 'string' && receipt.output.endsWith('.png'),
        chartBytesPositive: receipt?.bytes === undefined || Number(receipt.bytes) > 1000,
      };
    case '09-quality-gate':
      return {
        deterministicScorePresent: Number.isFinite(receipt?.gate?.score),
        thresholdPresent: Number.isFinite(receipt?.gate?.threshold),
        hardBlockListPresent: Array.isArray(receipt?.gate?.hardBlocks),
        statusConsistent: receipt?.gate?.passed === true
          ? receipt.gate.status === 'ready_for_review'
            && receipt.gate.hardBlocks.length === 0
            && receipt.gate.score >= receipt.gate.threshold
          : ['blocked', 'needs_revision'].includes(receipt?.gate?.status),
        autoPublishDisabled: receipt?.gate?.policy?.autoPublishAllowed === false,
        hardGatesAuthoritative: receipt?.gate?.policy?.deterministicHardGatesAuthoritative === true,
      };
    default:
      return { knownStage: false };
  }
}

export function evaluateStageGate(stage, receipt, { checkedAt = new Date() } = {}) {
  const checks = stageChecks(stage, receipt);
  const details = checks._details || null;
  delete checks._details;
  const failedChecks = Object.entries(checks)
    .filter(([, passed]) => passed !== true)
    .map(([name]) => name);
  return {
    schemaVersion: 1,
    stage,
    checkedAt: checkedAt.toISOString(),
    inputFingerprint: fingerprint(receipt),
    passed: failedChecks.length === 0,
    checks,
    failedChecks,
    details,
  };
}

export function evaluatePublishPackageGate(pkg) {
  const reviewReady = pkg?.status === 'ready_for_review';
  const qualityPassed = Number(pkg?.quality?.score || 0) >= Number(pkg?.quality?.threshold || Infinity)
    && Array.isArray(pkg?.quality?.hardBlocks) && pkg.quality.hardBlocks.length === 0;
  const checks = {
    statusKnown: ['ready_for_review', 'blocked', 'needs_revision'].includes(pkg?.status),
    titlePresent: typeof pkg?.title === 'string' && pkg.title.trim().length >= 10,
    draftDeclared: pkg?.draft === 'draft.md',
    assetDeclared: Array.isArray(pkg?.assets) && pkg.assets.length > 0,
    affiliateLinksDeclared: Array.isArray(pkg?.affiliateLinks) && pkg.affiliateLinks.length > 0,
    claimLedgerDeclared: pkg?.claimLedger === 'claim-evidence-ledger.json',
    qualityStatusConsistent: reviewReady ? qualityPassed : !qualityPassed,
    publishNotImplicitlyAuthorized: pkg?.publishAuthorized === false,
    autoPublishNotPerformed: pkg?.automaticPublishingPerformed === false,
  };
  const failedChecks = Object.entries(checks).filter(([, value]) => !value).map(([name]) => name);
  return {
    schemaVersion: 1,
    stage: 'publish-package',
    checkedAt: new Date().toISOString(),
    inputFingerprint: fingerprint(pkg),
    passed: failedChecks.length === 0,
    checks,
    failedChecks,
  };
}

export { markdownMetrics };
