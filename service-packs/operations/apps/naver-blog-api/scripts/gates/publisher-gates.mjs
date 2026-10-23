import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { fingerprint } from '../../../../packages/contracts/src/index.mjs';
import { evaluateCommercialSnapshot } from './commercial-snapshot-gates.mjs';
import { evaluatePublicationReview, evaluateExactReadback } from './publication-review-gates.mjs';
import { verifyPublicationArtifacts } from './publication-artifacts.mjs';
import { sha256 } from './publication-document.mjs';
import { evaluateAffiliateLinkGate } from './affiliate-link-gate.mjs';

const BLOCK_TYPES = new Set([
  'image', 'imageStrip', 'quote', 'divider', 'heading', 'notice', 'paragraph', 'list', 'numbered', 'link', 'oglink', 'spacer',
]);

const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();

function validIso(value) {
  return Number.isFinite(Date.parse(String(value || '')));
}

export function publisherContentFingerprint(job) {
  return fingerprint({
    mode: job?.mode || null,
    blogId: job?.blogId || null,
    target: job?.target || null,
    title: job?.title || null,
    blocks: job?.bodyBlocks || job?.blocks || [],
    requiredMarkers: job?.requiredMarkers || [],
    requiredSeparateParagraphs: job?.requiredSeparateParagraphs || [],
    minParagraphs: job?.minParagraphs ?? null,
    maxParagraphLength: job?.maxParagraphLength ?? null,
    minImageComponents: job?.minImageComponents ?? null,
    minImageCount: job?.minImageCount ?? null,
    minQuoteComponents: job?.minQuoteComponents ?? null,
    minDividerComponents: job?.minDividerComponents ?? null,
    affiliate: job?.affiliate || null,
    actionLabel: job?.actionLabel || null,
    actionClass: job?.actionClass || null,
    publishSettings: job?.publishSettings || null,
    preserveExistingOgLink: job?.preserveExistingOgLink === true,
    appendExistingDraft: job?.appendExistingDraft === true,
    partialDraftStep: job?.partialDraftStep === true,
    existingDraftBaseline: job?.existingDraftBaseline || null,
    verifyExistingDraftOnly: job?.verifyExistingDraftOnly === true,
    skipTitleUpdate: job?.skipTitleUpdate === true,
    expectedExistingTitle: job?.expectedExistingTitle || null,
    executionMode: job?.executionMode || null,
    inputProvider: job?.inputProvider || null,
    publicationBundleFingerprint: job?.publicationBundleFingerprint || null,
    sourceDocumentFingerprint: job?.preflight?.sourceDocumentFingerprint || null,
    preflightCheckedAt: job?.preflight?.checkedAt || null,
  });
}

async function exists(target) {
  try { await access(target, fsConstants.F_OK); return true; } catch { return false; }
}

function blockTextUnits(block) {
  if (!block || !block.type) return [];
  if (['heading', 'notice', 'paragraph', 'quote'].includes(block.type)) return [normalize(block.text)].filter(Boolean);
  if (['list', 'numbered'].includes(block.type)) return (block.items || []).map(normalize).filter(Boolean);
  if (block.type === 'link') return (block.display === 'label' ? [normalize(block.label)] : [normalize(block.label), normalize(block.url)]).filter(Boolean);
  return [];
}

function paragraphContribution(block) {
  if (!block || !block.type) return 0;
  if (['heading', 'notice', 'paragraph', 'quote'].includes(block.type)) return normalize(block.text) ? 1 : 0;
  if (['list', 'numbered'].includes(block.type)) return Array.isArray(block.items) ? block.items.filter(item => normalize(item)).length : 0;
  if (block.type === 'link') return Number(Boolean(normalize(block.label))) + (block.display === 'label' ? 0 : Number(Boolean(normalize(block.url))));
  return 0;
}

function result(passed, checks, details = null) {
  const failedChecks = Object.entries(checks).filter(([, value]) => value !== true).map(([name]) => name);
  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    passed: passed ?? failedChecks.length === 0,
    checks,
    failedChecks,
    details,
  };
}

export async function evaluatePublisherJobGate(job, {
  baseDir = process.cwd(),
  checkImageFiles = true,
  checkReviewFiles = true,
  now = new Date(),
} = {}) {
  const blocks = Array.isArray(job?.bodyBlocks)
    ? job.bodyBlocks
    : Array.isArray(job?.blocks)
      ? job.blocks
      : [];
  const textUnits = blocks.flatMap(blockTextUnits);
  const fullText = textUnits.join('\n');
  const imageBlocks = blocks.filter(block => ['image', 'imageStrip'].includes(block?.type));
  const quoteBlocks = blocks.filter(block => block?.type === 'quote' || block?.type === 'heading' && block.presentation === 'quotation');
  const dividerBlocks = blocks.filter(block => block?.type === 'divider');
  const baseline = (job?.appendExistingDraft === true || job?.verifyExistingDraftOnly === true)
    && job?.existingDraftBaseline
    ? job.existingDraftBaseline
    : {};
  const baselineParagraphs = Number(baseline.paragraphCount || 0);
  const baselineImageComponents = Number(baseline.imageComponentCount || 0);
  const baselineImages = Number(baseline.imageCount || 0);
  const baselineQuotes = Number(baseline.quoteComponentCount || 0);
  const baselineDividers = Number(baseline.dividerComponentCount || 0);
  const baselineMarkers = Array.isArray(baseline.markers) ? baseline.markers.map(normalize) : [];
  const supported = blocks.every(block => BLOCK_TYPES.has(block?.type));
  const paragraphCount = blocks.reduce((sum, block) => sum + paragraphContribution(block), 0);
  const maxTextLength = Math.max(0, ...textUnits.map(value => value.length));
  const assets = imageBlocks.flatMap(block=>block.type==='imageStrip' ? block.images || (block.files||[]).map(file=>({file})) : [block]);
  const resolvedImages = assets.map(asset=>path.resolve(baseDir,String(asset.file||'')));
  const imageFileChecks = checkImageFiles
    ? await Promise.all(resolvedImages.map(exists))
    : resolvedImages.map(() => true);
  const requiredMarkers = Array.isArray(job?.requiredMarkers) ? job.requiredMarkers : [];
  const separateMarkers = Array.isArray(job?.requiredSeparateParagraphs) ? job.requiredSeparateParagraphs : [];
  const targetType = job?.target?.type || (job?.actionLabel ? 'current_editor' : null);
  const inferredAffiliateUrl = blocks
    .filter(block => ['link','oglink'].includes(block?.type))
    .map(block => String(block.url || ''))
    .find(url => /^https:\/\/link\.coupang\.com\/a\/[A-Za-z0-9]+$/.test(url)) || '';
  const affiliateUrl = job?.affiliate?.url || inferredAffiliateUrl;
  const linkUrls = blocks.filter(block => ['link','oglink'].includes(block?.type)).map(block => String(block.url || ''));
  const publishes = job?.publish === true || job?.dryRun === false;
  const auth = job?.authorization;
  const preflight = job?.preflight;
  const authAgeMinutes = validIso(auth?.approvedAt)
    ? (now.getTime() - Date.parse(auth.approvedAt)) / 60000
    : null;
  const commercialAgeMinutes = validIso(job?.commercialSnapshot?.checkedAt)
    ? Math.max(0, (now.getTime() - Date.parse(job.commercialSnapshot.checkedAt)) / 60000)
    : null;
  const commercialGate = publishes
    ? evaluateCommercialSnapshot(job?.commercialSnapshot, { now, maxAgeMinutes: 60 })
    : null;
  const publicationReview = publishes ? evaluatePublicationReview(job, { now }) : null;
  const affiliateGate = publishes ? evaluateAffiliateLinkGate(job, { now }) : null;
  const artifacts = publishes && checkReviewFiles ? await verifyPublicationArtifacts(job?.publicationBundle,{baseDir}) : null;
  const imageHashChecks = publishes && checkImageFiles ? await Promise.all(assets.map(async(asset,index)=>{
    try { return sha256(await readFile(resolvedImages[index]))===asset.sha256; } catch { return false; }
  })) : [];
  const checks = {
    jobIdPresent: typeof job?.jobId === 'string' && job.jobId.trim().length >= 6,
    blogScopePresent: typeof job?.blogId === 'string' && job.blogId.trim().length >= 3
      || targetType === 'current_editor',
    targetSupported: ['create', 'update', 'current_editor'].includes(targetType),
    updateTargetHasLogNo: targetType !== 'update' || /^\d{6,}$/.test(String(job?.target?.logNo || '')),
    titlePresent: typeof job?.title === 'string' && normalize(job.title).length >= 10 && normalize(job.title).length <= 100,
    blocksPresent: job?.verifyExistingDraftOnly === true || blocks.length >= 5,
    blocksSupported: supported,
    paragraphFloorMet: paragraphCount + baselineParagraphs >= Number(job?.minParagraphs || 1),
    paragraphLengthBounded: maxTextLength <= Number(job?.maxParagraphLength || 1000),
    imageFloorMet: imageBlocks.length + baselineImageComponents >= Number(job?.minImageComponents || 0),
    imageCountFloorMet: resolvedImages.length + baselineImages >= Number(job?.minImageCount || 0),
    quoteFloorMet: quoteBlocks.length + baselineQuotes >= Number(job?.minQuoteComponents || 0),
    dividerFloorMet: dividerBlocks.length + baselineDividers >= Number(job?.minDividerComponents || 0),
    imageFilesPresent: imageFileChecks.every(Boolean),
    markersPresent: requiredMarkers.every(marker => {
      const normalized = normalize(marker);
      return normalize(fullText).includes(normalized)
        || baselineMarkers.some(value => value.includes(normalized));
    }),
    separateMarkersPresent: separateMarkers.every(marker => {
      const normalized = normalize(marker);
      return textUnits.some(unit => unit.includes(normalized))
        || baselineMarkers.some(value => value.includes(normalized));
    }),
    affiliateUrlValid: /^https:\/\/link\.coupang\.com\/a\/[A-Za-z0-9]+$/.test(affiliateUrl),
    affiliateLinkBlockMatches: job?.verifyExistingDraftOnly === true
      || job?.partialDraftStep === true
      || job?.preserveExistingOgLink === true
      || linkUrls.includes(affiliateUrl),
    partialStepSafe: job?.partialDraftStep !== true || !publishes,
    publishFlagBoolean: typeof job?.publish === 'boolean' || typeof job?.dryRun === 'boolean',
    publishSettingsPresent: !publishes
      || ['public', 'neighbor', 'private'].includes(job?.publishSettings?.visibility),
    publishTimingPresent: !publishes || ['current', 'scheduled'].includes(job?.publishSettings?.timing),
    explicitAuthorizationPresent: !publishes || auth?.approved === true,
    explicitAuthorizationActor: !publishes || auth?.approvedBy === 'user',
    explicitAuthorizationTimestamp: !publishes || validIso(auth?.approvedAt),
    explicitAuthorizationFresh: !publishes || authAgeMinutes !== null && authAgeMinutes >= 0 && authAgeMinutes <= 120,
    explicitAuthorizationScope: !publishes || auth?.scope === 'publish_once',
    authorizationContentMatches: !publishes
      || auth?.contentFingerprint === publisherContentFingerprint(job),
    preflightPassed: !publishes || preflight?.passed === true,
    preflightJobRecorded: !publishes || typeof preflight?.dryRunJobId === 'string' && preflight.dryRunJobId.length >= 6,
    preflightFingerprintsRecorded: !publishes
      || ['dryRunJobFingerprint', 'dryRunResultFingerprint', 'dryRunGateFingerprint']
        .every(field => /^[a-f0-9]{64}$/.test(String(preflight?.[field] || ''))),
    commercialSnapshotPresent: !publishes || Boolean(job?.commercialSnapshot),
    commercialSnapshotVerified: !publishes || commercialGate?.passed === true,
    monetizedAffiliateVerified: !publishes || affiliateGate?.passed === true,
    commercialAffiliateMatches: !publishes
      || job?.commercialSnapshot?.affiliateUrl === affiliateUrl,
    independentHttpWriterRequired: !publishes || job?.executionMode === 'independent_http',
    httpOperationSupported: !publishes || (targetType === 'update' || targetType === 'create' && job?.inputProvider === 'headless_sdk') && ['public','private'].includes(job?.publishSettings?.visibility) && job?.publishSettings?.timing==='current',
    publicationReviewPassed: !publishes || publicationReview?.passed === true,
    publicationArtifactsVerified: !publishes || !checkReviewFiles || artifacts?.passed === true,
    imageContentHashesVerified: !publishes || !checkImageFiles || imageHashChecks.every(Boolean),
  };
  const gate = result(null, checks, {
    blockCount: blocks.length,
    paragraphCount,
    maxTextLength,
    imageCount: resolvedImages.length,
    imageComponentCount: imageBlocks.length,
    quoteCount: quoteBlocks.length,
    dividerCount: dividerBlocks.length,
    baseline,
    resolvedImages,
    missingImages: resolvedImages.filter((_, index) => !imageFileChecks[index]),
    publishes,
    authAgeMinutes: authAgeMinutes === null ? null : Math.round(authAgeMinutes * 100) / 100,
    commercialAgeMinutes: commercialAgeMinutes === null ? null : Math.round(commercialAgeMinutes * 100) / 100,
    commercialGate,
    affiliateGate,
    publicationReview,
    artifacts,
  });
  return { ...gate, gate: 'publisher-job', inputFingerprint: fingerprint(job) };
}

export function evaluatePublisherResultGate(job, payload, {now=new Date()}={}) {
  const publish = job?.publish === true || job?.dryRun === false;
  const draft = payload?.data?.draft;
  const receipt = payload?.data?.receipt;
  const publicReadback = receipt?.publicReadback;
  const requiredMarkers = Array.isArray(job?.requiredMarkers) ? job.requiredMarkers : [];
  const markerPresence = publicReadback?.markerPresence || {};
  const dryRunMarkers = new Set([
    ...(draft?.paragraphTexts || []),
    ...(draft?.quoteTexts || []),
    ...(draft?.ogLinkTexts || []),
  ].map(normalize));
  const baselineImageComponents = Number(job?.existingDraftBaseline?.imageComponentCount || 0);
  const observedUploads = Number(payload?.data?.upload?.observed || 0);
  const exactReadback = publish ? evaluateExactReadback(job, payload?.data?.independentReadback,{now, createdLogNo: receipt?.logNo}) : null;
  const checks = {
    jobIdMatches: payload?.jobId === job?.jobId,
    resultOk: payload?.ok === true,
    modeMatches: payload?.mode === job?.mode,
    irreversibleStateConsistent: publish ? payload?.data?.published === true : payload?.data?.published === false,
    titleVerified: publish
      ? typeof receipt?.pageTitle === 'string' && receipt.pageTitle.includes(normalize(job?.title))
      : normalize(payload?.data?.titleText) === normalize(job?.title),
    paragraphStructureVerified: publish
      ? Number(receipt?.paragraphCount || 0) >= Number(job?.minParagraphs || 1)
      : Number(draft?.nonEmptyParagraphs || 0) >= Number(job?.minParagraphs || 1),
    paragraphLengthVerified: publish
      ? Number(receipt?.maxParagraphLength || Infinity) <= Number(job?.maxParagraphLength || 1000)
      : Number(draft?.maxParagraphLength || Infinity) <= Number(job?.maxParagraphLength || 1000),
    imageStructureVerified: publish
      ? Number(receipt?.componentCounts?.['se-image'] || 0) + Number(receipt?.componentCounts?.['se-imageStrip'] || 0) + Number(receipt?.componentCounts?.['se-imageGroup'] || 0) >= Number(job?.minImageComponents || 0)
      : Number(draft?.imageComponentCount || 0) >= Number(job?.minImageComponents || 0),
    imageCountVerified: publish
      ? Number(receipt?.uniqueImageCount || 0) >= Number(job?.minImageCount || 0)
      : Number(draft?.imageResourceCount || 0) >= Number(job?.minImageCount || 0),
    quoteStructureVerified: publish
      ? Number(receipt?.componentCounts?.['se-quotation'] || 0) >= Number(job?.minQuoteComponents || 0)
      : Number(draft?.quoteComponentCount || 0) >= Number(job?.minQuoteComponents || 0),
    dividerStructureVerified: publish
      ? Number(receipt?.componentCounts?.['se-horizontalLine'] || 0) >= Number(job?.minDividerComponents || 0)
      : Number(draft?.dividerComponentCount || 0) >= Number(job?.minDividerComponents || 0),
    markerReadbackVerified: publish
      ? requiredMarkers.every(marker => markerPresence[marker] === true)
      : requiredMarkers.every(marker => [...dryRunMarkers].some(value => value.includes(normalize(marker)))),
    affiliateLinkVerified: !publish && job?.partialDraftStep === true
      ? true
      : publish
      ? publicReadback?.affiliateLinkPresent === true
      : job?.preserveExistingOgLink === true
        ? Number(draft?.ogLinkCount || 0) === 1
        : Number(draft?.ogLinkCount || 0) >= 1
          || (draft?.paragraphTexts || []).some(value => String(value).includes(
            job?.affiliate?.url
              || (job?.blocks || job?.bodyBlocks || []).find(block => block?.type === 'link')?.url
              || '',
          )),
    publicHttpVerified: !publish || receipt?.publicStatus === 200,
    publicSmartEditorBodyVerified: !publish || publicReadback?.smartEditorBodyPresent === true,
    uploadCountVerified: publish
      ? true
      : observedUploads + baselineImageComponents >= Number(job?.minImageComponents || 0),
    extensionReportedNoMissingMarkers: !Array.isArray(payload?.data?.missing) || payload.data.missing.length === 0,
    exactPublicDocumentVerified: !publish || exactReadback?.passed === true,
  };
  const gate = result(null, checks, {
    publish,
    publicUrl: receipt?.url || null,
    logNo: receipt?.logNo || job?.target?.logNo || null,
    observedUploads,
    baselineImageComponents,
    exactReadback,
  });
  return {
    ...gate,
    gate: 'publisher-result',
    jobFingerprint: fingerprint(job),
    inputFingerprint: fingerprint(payload),
  };
}
