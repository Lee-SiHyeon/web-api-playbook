import {isArchivedComparison,evaluateArchivedComparison,archivedComparisonScope} from './archived-comparison-contract.mjs';
import { fingerprint } from "../../../../packages/contracts/src/index.mjs";
import { evaluateClaimEvidenceGate } from "./claim-evidence-gates.mjs";
import { evaluateCommercialSnapshot } from "./commercial-snapshot-gates.mjs";
import { inspectDuplication } from './content-duplication.mjs';
import { editorialReviewChecks, ownerEditorialReviewProvenance, userDirectedEditorialWaiver } from './editorial-provenance.mjs';
import {referenceLayoutChecks} from './reference-layout-gate.mjs';
import {isInformationalArticle,evaluateInformationalArticle,informationalReadbackChecks} from './informational-article-contract.mjs';
import {isSingleOfferHotdeal,evaluateSingleOfferHotdeal} from './single-offer-hotdeal-contract.mjs';
import {publicationTagsReadback} from './publication-tags.mjs';
import {
  documentChecks,
  documentFingerprint,
  documentUnits,
  renderUnits,
  unitsFingerprint,
  text,
  documentTables,
} from "./publication-document.mjs";

const recent = (value, now, minutes) =>
  Number.isFinite(Date.parse(value)) &&
  Date.parse(value) <= now.getTime() &&
  now.getTime() - Date.parse(value) <= minutes * 60000;
export function evaluatePublicationReview(job, { now = new Date() } = {}) {
  const bundle = job?.publicationBundle;
  const informational = isInformationalArticle(job);
  const archived = archivedComparisonScope(job);
  const document = bundle?.document;
  const docHash = documentFingerprint(document);
  const checks = {
    bundlePresent: bundle?.schemaVersion === 1,
    ...documentChecks(document,{contentKind:informational?bundle.format:'commercial',researchSources:bundle?.research?.sources||[]}),
    ...(informational?evaluateInformationalArticle(job,{now}).checks:{}),
    ...(isSingleOfferHotdeal(job)?evaluateSingleOfferHotdeal(job,{now}).checks:{}),
    ...referenceLayoutChecks(bundle),
    ...(isArchivedComparison(job)?evaluateArchivedComparison(job).checks:{}),
  };
  const quality = bundle?.qualityReview;
  const editorialWaiver = userDirectedEditorialWaiver(bundle, { now });
  const ownerReview = ownerEditorialReviewProvenance(bundle);
  const editorialChecks = editorialReviewChecks(bundle);
  if (ownerReview) {
    // Keep the owner route distinct from independent review evidence.
    delete editorialChecks.independentReviewProvenance;
    editorialChecks.chatgptOwnerReviewProvenance = true;
  } else if (editorialWaiver) {
    // Do not report a self-review as an independent review that passed.
    delete editorialChecks.independentReviewProvenance;
    editorialChecks.userDirectedEditorialWaiverScoped = true;
  }
  const ledger = bundle?.claimLedger;
  const claimGate = evaluateClaimEvidenceGate(ledger, {
    now,
    draft: renderUnitsSafe(document)
      .map((b) => b.value || "")
      .join("\n"),
  });
  const claimList = Array.isArray(ledger?.claims) ? ledger.claims : [];
  const claims = new Map(claimList.map((c) => [c.claimId, c]));
  const blocks = Array.isArray(document?.blocks) ? document.blocks : [];
  const expectedHash = unitsFingerprint(renderUnitsSafe(document));
  const facts = blocks.filter((b) => b.claimClass === "factual");
  const textBlocks = blocks.filter((b) =>
    ["paragraph", "list", "numbered", "quote", "heading", "table"].includes(b.type),
  );
  const products = Array.isArray(bundle?.products) ? bundle.products : [];
  const criteria = Array.isArray(bundle?.comparisonCriteria)
    ? bundle.comparisonCriteria
    : [];
  const known = (value) =>
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" &&
      value.trim().length > 0 &&
      !/\?|미확인|정보\s*없|확인\s*필요|unknown|n\/a/i.test(value));
  const productGates = products.map((product) =>
    evaluateCommercialSnapshot(product, {
      now,
      requireCommerceDetails: true,
      requireAffiliate: product.affiliateUrl != null,
    }),
  );
  Object.assign(checks, {
    ...editorialChecks,
    documentTargetMatches:
      document?.blogId === job?.blogId &&
      String(document?.logNo || "") === String(job?.target?.logNo || ""),
    documentTitleMatches: text(document?.title) === text(job?.title),
    completeWriteOnly:
      job?.partialDraftStep !== true &&
      job?.appendExistingDraft !== true &&
      job?.verifyExistingDraftOnly !== true,
    submittedDocumentMatches:
      document &&
      fingerprint(document.blocks) ===
        fingerprint(job?.bodyBlocks || job?.blocks || []),
    claimsCurrent: claimGate.passed,
    claimClassificationPresent: textBlocks.every((b) =>
      ["factual", "guidance"].includes(b.claimClass),
    ),
    materialClaimCoverage: facts.every(
      (b) =>
        Array.isArray(b.claimIds) &&
        b.claimIds.length > 0 &&
        b.claimIds.every(
          (id) =>
            claims.get(id)?.support === "supports" &&
            claims.get(id)?.publishable === true,
        ),
    ),
    commercialStatementsClassified: textBlocks.every(
      (b) =>
        !/[\d,]+\s*(?:원|%|cm|mm|kg|mAh)|최저가|무료배송|재고\s*(?:있|없)/i.test(
          b.text || (b.type==='table'?[b.columns,...(b.rows||[])].flat().join(' '):(b.items || []).join(" ")),
        ) || b.claimClass === "factual",
    ),
    qualityForThisDocument:
      quality?.documentFingerprint === docHash &&
      quality?.claimLedgerFingerprint === fingerprint(ledger || null),
    qualityReviewed:
      quality?.decision === "pass" &&
      (quality?.reviewerRole === "independent_verifier" || ownerReview || editorialWaiver) &&
      typeof quality?.reviewerId === "string" &&
      quality.reviewerId.length >= 3 &&
      (quality.reviewerId !== bundle?.authorId || ownerReview || editorialWaiver) &&
      recent(quality?.checkedAt, now, 120),
    noQualityHardBlocks:
      Array.isArray(quality?.hardBlocks) && quality.hardBlocks.length === 0,
    semanticChecksPassed: [
      "readerIntent",
      "comparisonFairness",
      "claimsSupported",
      "noMisleadingExperience",
      "sourceTraceability",
    ].every((k) => quality?.checks?.[k] === true),
    ...(informational ? {} : {comparisonSetPresent:
      products.length >= (bundle?.format === "comparison" && !archived ? 4 : 1),
    distinctProducts:
      new Set(products.map((p) => `${p.productId}:${p.variantId}`)).size ===
      products.length,
    allProductsFresh: productGates.every((g) => g.passed),
    selectedProductMatches: products.some(
      (p) => fingerprint(p) === fingerprint(job?.commercialSnapshot || null),
    ),
    pricesComparable:
      bundle?.format !== "comparison" || archived ||
      new Set(products.map((p) => `${p.priceBasis}:${p.quantity}`)).size ===
        1 ||
      quality?.checks?.mixedPriceConditionsExplained === true}),
    sourceEvidenceBound: Object.values(ledger?.evidence || {}).every(
      (e) =>
        /^https:\/\//.test(e.url || "") &&
        /^[a-f0-9]{64}$/.test(e.sha256 || "") &&
        recent(e.checkedAt, now, 1440 * 30),
    ),
    volatileClaimsExpire: claimList.every(
      (c) =>
        !["price", "stock", "shipping", "rating", "review_count"].includes(
          c.claimType,
        ) ||
        (Number.isFinite(Date.parse(c.expiresAt)) &&
          Date.parse(c.expiresAt) >= now.getTime()),
    ),
    preflightForThisDocument:
      job?.preflight?.documentFingerprint === docHash &&
      job?.preflight?.publicationBundleFingerprint ===
        fingerprint(bundle || null) &&
      /^[a-f0-9]{64}$/.test(job?.preflight?.sourceDocumentFingerprint || ""),
    collisionScopeMatches:
      bundle?.collision?.blogId === job?.blogId &&
      recent(bundle?.collision?.checkedAt, now, 1440) &&
      ["create", "update", "differentiate", "merge"].includes(
        bundle?.collision?.decision,
      ),
    bundleBoundToJob:
      job?.publicationBundleFingerprint === fingerprint(bundle || null),
    authorIdentified:
      typeof bundle?.authorId === "string" && bundle.authorId.length >= 3,
    ...(informational ? {} : {productClaimsCovered: products.every((p) =>
      claimList.some(
        (c) =>
          c.productId === p.productId &&
          c.variantId === p.variantId &&
          c.claimType === "price" &&
          c.support === "supports" &&
          c.publishable === true &&
          facts.some((b) => b.claimIds?.includes(c.claimId)),
      ),
    )}),
    comparisonCriteriaPresent:
      bundle?.format !== "comparison" || archived ||
      (criteria.length >= 3 &&
        new Set(criteria.map((c) => c.key)).size === criteria.length &&
        criteria.every((c) => known(c.key) && known(c.label) && known(c.unit))),
    comparisonDimensionsKnown:
      bundle?.format !== "comparison" || archived ||
      products.every((p) =>
        criteria.every((c) => known(p.attributes?.[c.key])),
      ),
  });
  for (const device of ["desktop", "mobile"]) {
    const review = bundle?.renderReviews?.[device];
    const rect = review?.disclosureRect;
    checks[`${device}RenderMatches`] =
      review?.documentFingerprint === docHash &&
      review?.observedUnitsFingerprint === expectedHash &&
      recent(review?.checkedAt, now, 120);
    checks[`${device}DisclosureVisible`] =
      Number.isFinite(rect?.top) &&
      Number.isFinite(rect?.bottom) &&
      rect.top >= 0 &&
      rect.bottom > rect.top &&
      rect.bottom <= Number(review?.viewport?.height || 0);
    checks[`${device}ViewportValid`] =
      device === "mobile"
        ? review?.viewport?.width >= 320 && review.viewport.width <= 480
        : review?.viewport?.width >= 768 || review?.channel === 'naver_editor' &&
          review?.viewport?.width >= 600 && review?.browserViewport?.width >= 768;
    checks[`${device}EvidencePresent`] =
      /^[a-f0-9]{64}$/.test(review?.screenshotSha256 || "") &&
      review?.source === "rendered_dom";
    checks[`${device}NativeChannelRender`] =
      review?.channel === 'naver_editor' && review?.nativeDocumentInjected === true &&
      review?.browserWritesBlocked === true &&
      /^[a-f0-9]{64}$/.test(review?.compiledPresentationFingerprint || '') &&
      review.compiledPresentationFingerprint === job?.preflight?.compiledPresentationFingerprint;
    checks[`${device}ReadablePresentation`] =
      ['headingHierarchy','labeledLinks','paragraphSpacing','noHorizontalOverflow']
        .every(k => review?.presentationChecks?.[k] === true);
    if(blocks.some(b=>b.type==='table'))checks[`${device}NativeTables`]=review?.presentationChecks?.nativeTables===true&&fingerprint(review?.tables)===fingerprint(documentTables(document));
    if(blocks.some(b=>b.type==='notice'&&b.presentation==='panel'))
      checks[`${device}DisclosureStyled`] = review?.presentationChecks?.disclosureStyled === true;
  }
  const failedChecks = Object.keys(checks).filter((k) => checks[k] !== true);
  return {
    schemaVersion: 1,
    gate: "publication-review",
    checkedAt: now.toISOString(),
    passed: failedChecks.length === 0,
    editorialReviewRoute: ownerReview ? 'chatgpt_owner_review'
      : editorialWaiver ? 'user_directed_author_review' : 'independent_review_required',
    independentEditorialReviewVerified: editorialReviewChecks(bundle).independentReviewProvenance === true,
    checks,
    failedChecks,
    documentFingerprint: docHash,
    expectedUnitsFingerprint: expectedHash,
    claimGate,
    productGates,
  };
}
function renderUnitsSafe(document) {
  try {
    return renderUnits(document);
  } catch {
    return [];
  }
}

export function evaluateExactReadback(
  job,
  observation,
  { now = new Date(), createdLogNo } = {},
) {
  const document = job?.publicationBundle?.document;
  const expected = renderUnitsSafe(document);
  const observed = observation?.units || [];
  // Uploads are served from blogfiles in the owner model and postfiles in
  // public HTML. Only these observed HTTPS aliases, with the identical full
  // asset path, are equivalent; all other hosts and paths still fail closed.
  const comparable=observed.map((unit,i)=>{
    if(unit.type!=='image'||expected[i]?.type!=='image')return unit;
    try{const a=new URL(expected[i].value),b=new URL(unit.value);
      if(a.protocol==='https:'&&b.protocol==='https:'&&!a.port&&!b.port&&!a.username&&!b.username&&!a.password&&!b.password&&
        new Set([a.hostname,b.hostname]).size===2&&[a.hostname,b.hostname].every(h=>['blogfiles.pstatic.net','postfiles.pstatic.net'].includes(h))&&a.pathname===b.pathname)
        return {...unit,value:expected[i].value};
    }catch{}
    return unit;
  });
  const checks = {
    independentHttp: observation?.source === "independent_http",
    httpOk: observation?.httpStatus === 200,
    sourceDocumentPresent: observation?.smartEditorBodyPresent === true,
    responseIdentityVerified: observation?.targetIdentityVerified === true,
    correctTarget:
      observation?.blogId === job?.blogId &&
      (job?.target?.type === 'create'
        ? /^\d{6,}$/.test(String(createdLogNo || '')) && String(observation?.logNo) === String(createdLogNo)
        : String(observation?.logNo) === String(job?.target?.logNo)),
    titleMatches: text(observation?.title) === text(document?.title),
    ...(job?.publicationBundle?.format ? publicationTagsReadback(job, observation) : {}),
    ...(isInformationalArticle(job)?informationalReadbackChecks(job,observation):{
      affiliateClickable: !job?.affiliate?.url || observation?.links?.includes(job.affiliate.url) === true,
    }),
    ...((document?.blocks||[]).some(b=>b.type==='video')?{
      nativeVideosMatch:(document.blocks.filter(b=>b.type==='video').length===observation?.videoResources?.length)&&
        document.blocks.filter(b=>b.type==='video').every((b,i)=>{const v=observation.videoResources[i],r=b.uploadReceipt;
          return v?.videoId===b.videoId&&(!r||v.thumbnail===r.thumbnail.url&&v.title===text(r.mediaMeta.title));}),
      nativeVideoCaptionsMatch:fingerprint(observation?.videoCaptions)===fingerprint(document.blocks.map((b,i)=>b.type==='video'?
        (document.blocks[i+1]?.presentation==='caption'?[text(document.blocks[i+1].text)]:[]):null).filter(Boolean))
    }:{}),
    fullOrderedContentMatches:
      expected.length > 0 &&
      unitsFingerprint(expected) === unitsFingerprint(comparable),
    ...((document?.blocks||[]).some(b=>b.type==='table')?{nativeTablesMatch:fingerprint(observation?.tables)===fingerprint(documentTables(document))}:{}),
    noDuplicateProse: inspectDuplication(observed).noDuplicateProse,
    checkedAfterSubmission:
      recent(observation?.checkedAt, now, 10) &&
      Date.parse(observation.checkedAt) >=
        Date.parse(job?.authorization?.approvedAt || ""),
  };
  const firstMismatch = expected.findIndex(
    (unit, i) => fingerprint(unit) !== fingerprint(comparable[i] || null),
  );
  const failedChecks = Object.keys(checks).filter((k) => checks[k] !== true);
  return {
    schemaVersion: 1,
    gate: "exact-public-readback",
    passed: failedChecks.length === 0,
    checks,
    failedChecks,
    expectedUnits: expected.length,
    observedUnits: observed.length,
    firstMismatch,
  };
}
