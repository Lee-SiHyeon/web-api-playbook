import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  publicationFixture,
  bind,
  NOW,
  publicHtml,
} from "./support/publication-fixture.mjs";
import {
  evaluatePublicationReview,
  evaluateExactReadback,
} from "../scripts/gates/publication-review-gates.mjs";
import { evaluatePublisherJobGate } from "../scripts/gates/publisher-gates.mjs";
import {
  documentChecks,
  documentFingerprint,
  sha256,
  renderUnits,
} from "../scripts/gates/publication-document.mjs";
import { parsePublicDocument } from "../scripts/api/public-document.mjs";
import { verifyPublicationArtifacts } from "../scripts/gates/publication-artifacts.mjs";

async function fixture(t) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "naver-publication-test-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, job: await publicationFixture(directory) };
}

function userDirectedAuthorReview(job) {
  const bundle = job.publicationBundle, review = bundle.qualityReview;
  review.reviewerRole = 'author_self_review';
  review.reviewerId = bundle.authorId;
  review.reviewMode = 'Author self-review; user explicitly directed publication without a separate reviewer.';
  review.provenance = {method:'author_self_review', authorExecutionId:bundle.authorExecutionId,
    reviewerExecutionId:bundle.authorExecutionId};
  review.userDirective = {source:'conversation_user_instruction', approvedBy:'user',
    scope:'independent_editorial_review_only', instruction:'Publish this exact revision now without waiting for another editorial reviewer.',
    conversationId:'synthetic-conversation', recordedAt:NOW.toISOString(),
    documentFingerprint:documentFingerprint(bundle.document), blogId:job.blogId, logNo:job.target.logNo};
  return bind(job);
}

test('explicit document-bound user direction permits honest author review without claiming independence',async t=>{
  const {directory,job}=await fixture(t);
  userDirectedAuthorReview(job);
  const gate=await evaluatePublisherJobGate(job,{baseDir:directory,now:NOW});
  assert.deepEqual(gate.failedChecks,[]);
  const review=evaluatePublicationReview(job,{now:NOW});
  assert.equal(review.editorialReviewRoute,'user_directed_author_review');
  assert.equal(review.independentEditorialReviewVerified,false);
  assert.equal(Object.hasOwn(review.checks,'independentReviewProvenance'),false);
});

for(const [name,mutate] of [
  ['missing instruction',r=>delete r.userDirective.instruction],
  ['wrong document',r=>r.userDirective.documentFingerprint='0'.repeat(64)],
  ['wrong target',r=>r.userDirective.logNo='987654321'],
  ['expired direction',r=>r.userDirective.recordedAt='2026-09-20T07:59:00Z'],
  ['future direction',r=>r.userDirective.recordedAt='2026-09-20T10:01:00Z'],
  ['broad override',r=>r.userDirective.scope='all_gates'],
]) test(`user-directed publication rejects ${name}`,async t=>{
  const {job}=await fixture(t);userDirectedAuthorReview(job);
  mutate(job.publicationBundle.qualityReview);bind(job);
  const gate=evaluatePublicationReview(job,{now:NOW});
  assert.equal(gate.passed,false);
  assert.ok(gate.failedChecks.includes('independentReviewProvenance'));
});

test('user direction does not waive factual, render, affiliate or publish-once authorization gates',async t=>{
  const {directory,job}=await fixture(t);userDirectedAuthorReview(job);
  job.publicationBundle.qualityReview.checks.claimsSupported=false;
  job.publicationBundle.renderReviews.mobile.presentationChecks.labeledLinks=false;
  job.affiliate.verification.accountId='AF0000000';
  job.authorization.approved=false;bind(job);
  const gate=await evaluatePublisherJobGate(job,{baseDir:directory,now:NOW});
  assert.equal(gate.passed,false);
  assert.ok(gate.details.publicationReview.failedChecks.includes('semanticChecksPassed'));
  assert.ok(gate.details.publicationReview.failedChecks.includes('mobileReadablePresentation'));
  assert.equal(gate.checks.explicitAuthorizationPresent,false);
  assert.equal(gate.checks.monetizedAffiliateVerified,false);
});

test('user publication directive must match the hashed review artifact',async t=>{
  const {directory,job}=await fixture(t);userDirectedAuthorReview(job);
  job.publicationBundle.qualityReview.userDirective.instruction='A different unrecorded publication instruction.';
  assert.equal((await verifyPublicationArtifacts(job.publicationBundle,{baseDir:directory})).checks.editorialReviewVerified,false);
});

test("complete current bundle passes semantic, artifact and publish gates", async (t) => {
  const { directory, job } = await fixture(t);
  const gate = await evaluatePublisherJobGate(job, {
    baseDir: directory,
    now: NOW,
  });
  assert.deepEqual(gate.failedChecks, []);
  assert.equal(gate.passed, true);
});

for (const [name, mutate, failed] of [
  ['different reviewer name but same execution',j=>j.publicationBundle.qualityReview.provenance.reviewerExecutionId=j.publicationBundle.authorExecutionId,'independentReviewProvenance'],
  ['same assistant disclosed as independent',j=>j.publicationBundle.qualityReview.reviewMode='Same assistant, separate passage-grounded verification pass','independentReviewProvenance'],
  ['unscored writing quality',j=>delete j.publicationBundle.qualityReview.editorialAssessments,'editorialAssessmentsPresent'],
  ['paraphrase repetition not reviewed',j=>delete j.publicationBundle.qualityReview.editorialAssessments.semanticRepetition,'semanticRepetitionReviewed'],
  ['ungrounded quality checkbox',j=>j.publicationBundle.qualityReview.editorialAssessments.economyFlow.blockIndexes=[],'editorialAssessmentsPresent'],
  ['standalone HTML mockup',j=>j.publicationBundle.renderReviews.mobile.channel='local_html','mobileNativeChannelRender'],
  ['flattened headings',j=>j.publicationBundle.renderReviews.mobile.presentationChecks.headingHierarchy=false,'mobileReadablePresentation'],
  ['raw URL display',j=>j.publicationBundle.renderReviews.desktop.presentationChecks.labeledLinks=false,'desktopReadablePresentation'],
  [
    "expired competitor claim",
    (j) =>
      (j.publicationBundle.claimLedger.claims[3].expiresAt =
        "2026-09-20T09:59:00Z"),
    "claimsCurrent",
  ],
  [
    "competitor price without expiry",
    (j) => delete j.publicationBundle.claimLedger.claims[2].expiresAt,
    "volatileClaimsExpire",
  ],
  [
    "damaged product option",
    (j) => (j.publicationBundle.products[1].variant = "???"),
    "allProductsFresh",
  ],
  [
    "stale competitor link",
    (j) =>
      (j.publicationBundle.products[2].linkVerification.checkedAt =
        "2026-09-19T10:00:00Z"),
    "allProductsFresh",
  ],
  [
    "unknown stock",
    (j) => (j.publicationBundle.products[1].stockState = "unknown"),
    "allProductsFresh",
  ],
  [
    "mixed price conditions not explained",
    (j) => (j.publicationBundle.products[1].priceBasis = "member"),
    "pricesComparable",
  ],
  [
    "different blog collision",
    (j) => (j.publicationBundle.collision.blogId = "4053103"),
    "collisionScopeMatches",
  ],
  [
    "self review",
    (j) =>
      (j.publicationBundle.qualityReview.reviewerId =
        j.publicationBundle.authorId),
    "qualityReviewed",
  ],
  [
    "score 94 with no semantic check",
    (j) => {
      j.publicationBundle.qualityReview.score = 94;
      delete j.publicationBundle.qualityReview.checks.claimsSupported;
    },
    "semanticChecksPassed",
  ],
  [
    "untraced factual block",
    (j) => delete j.publicationBundle.document.blocks.find(b => b.claimClass === "factual").claimIds,
    "materialClaimCoverage",
  ],
  [
    "mobile disclosure below viewport",
    (j) =>
      (j.publicationBundle.renderReviews.mobile.disclosureRect = {
        top: 1848,
        bottom: 1920,
      }),
    "mobileDisclosureVisible",
  ],
  [
    "unreviewed price product",
    (j) => delete j.publicationBundle.claimLedger.claims[1].productId,
    "productClaimsCovered",
  ],
  [
    "partial append publish",
    (j) => (j.appendExistingDraft = true),
    "completeWriteOnly",
  ],
  [
    "unknown comparison dimension",
    (j) => (j.publicationBundle.products[2].attributes.stages = "미확인"),
    "comparisonDimensionsKnown",
  ],
  [
    "price disguised as guidance",
    (j) => (j.publicationBundle.document.blocks[3].claimClass = "guidance"),
    "commercialStatementsClassified",
  ],
  [
    "future evidence date",
    (j) =>
      (j.publicationBundle.claimLedger.evidence.E0.checkedAt =
        "2026-09-21T10:00:00Z"),
    "sourceEvidenceBound",
  ],
])
  test(`regression: ${name} blocks publication`, async (t) => {
    const { job } = await fixture(t);
    mutate(job);
    bind(job);
    const gate = evaluatePublicationReview(job, { now: NOW });
    assert.equal(gate.passed, false);
    assert.ok(gate.failedChecks.includes(failed), gate.failedChecks.join(","));
  });

test("changing one final paragraph invalidates reviewer, render and authorization hashes", async (t) => {
  const { directory, job } = await fixture(t);
  job.publicationBundle.document.blocks[3].text += " 승인되지 않은 추가 문장";
  const gate = await evaluatePublisherJobGate(job, {
    baseDir: directory,
    now: NOW,
  });
  assert.equal(gate.passed, false);
  assert.ok(
    gate.details.publicationReview.failedChecks.includes(
      "qualityForThisDocument",
    ),
  );
  assert.ok(
    gate.details.publicationReview.failedChecks.includes(
      "submittedDocumentMatches",
    ),
  );
  assert.ok(
    gate.details.publicationReview.failedChecks.includes("bundleBoundToJob"),
  );
});

test("images before disclosure and repeated uploaded assets are blocked", async (t) => {
  const { job } = await fixture(t);
  const doc = job.publicationBundle.document;
  const image = {
    type: "image",
    file: "comparison.png",
    publishedUrl: "https://postfiles.pstatic.net/example/comparison.png",
    sha256: "a".repeat(64),
  };
  doc.blocks.unshift(image);
  doc.blocks.push({
    ...image,
    publishedUrl: "https://postfiles.pstatic.net/another/comparison.png",
  });
  const checks = documentChecks(doc);
  assert.equal(checks.disclosureFirst, false);
  assert.equal(checks.noDuplicateImages, false);
  assert.equal(
    documentChecks({
      blocks: [{ type: "imageStrip", files: ["a.png", "b.png"] }],
    }).supportedBlocks,
    false,
  );
});

test("artifact hashes and screenshot dimensions refer to real PNG files", async (t) => {
  const { directory, job } = await fixture(t);
  await writeFile(path.join(directory, "mobile.png"), "pass");
  job.publicationBundle.renderReviews.mobile.screenshotSha256 = sha256("pass");
  const gate = await verifyPublicationArtifacts(job.publicationBundle, {
    baseDir: directory,
  });
  assert.equal(gate.checks.mobileScreenshotVerified, false);
  job.publicationBundle.products[1].evidenceFile = "../outside.json";
  assert.equal(
    (
      await verifyPublicationArtifacts(job.publicationBundle, {
        baseDir: directory,
      })
    ).checks.product1EvidenceVerified,
    false,
  );
});

test('a modified review artifact cannot pass with its old hash',async t=>{
  const {directory,job}=await fixture(t);
  await writeFile(path.join(directory,job.publicationBundle.qualityReview.evidenceFile),'{}');
  assert.equal((await verifyPublicationArtifacts(job.publicationBundle,{baseDir:directory})).checks.editorialReviewVerified,false);
});

test("HTML readback checks target, full paragraph order, quotations and image positions", async (t) => {
  const { job } = await fixture(t);
  const doc = job.publicationBundle.document;
  const url = `https://blog.naver.com/PostView.naver?blogId=${job.blogId}&logNo=${job.target.logNo}`;
  const observation = parsePublicDocument(publicHtml(doc), {
    url,
    checkedAt: NOW.toISOString(),
  });
  assert.deepEqual(observation.units, renderUnits(doc));
  assert.equal(
    evaluateExactReadback(job, observation, { now: NOW }).passed,
    true,
  );
  for (const mutate of [
    (o) => o.units.splice(3, 1),
    (o) => o.units.reverse(),
    (o) => o.units.push(o.units[1]),
    (o) => (o.targetIdentityVerified = false),
    (o) => (o.source = "browser_dom"),
    (o) => (o.links = []),
    (o) => (o.checkedAt = "2026-09-20T09:59:00Z"),
  ]) {
    const altered = structuredClone(observation);
    mutate(altered);
    assert.equal(
      evaluateExactReadback(job, altered, { now: NOW }).passed,
      false,
    );
  }
  const forged = parsePublicDocument(
    publicHtml({ ...doc, logNo: "987654321" }),
    { url, checkedAt: NOW.toISOString() },
  );
  assert.equal(forged.targetIdentityVerified, false);
  assert.equal(forged.smartEditorBodyPresent, false);
});
