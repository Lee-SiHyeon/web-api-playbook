import { writeFile } from "node:fs/promises";
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from "node:path";
import { PNG } from "pngjs";
import { fingerprint } from "../../../../packages/contracts/src/index.mjs";
import {
  documentFingerprint,
  renderUnits,
  sha256,
  unitsFingerprint,
} from "../../scripts/gates/publication-document.mjs";
import { publisherContentFingerprint } from "../../scripts/gates/publisher-gates.mjs";
import { inspectEditorModel, compileEditorModel, editorPresentationFingerprint } from "../../scripts/api/editor-model.mjs";
import { editorialDimensions } from '../../scripts/gates/editorial-provenance.mjs';
const reviewDirectories=new Map();

export const NOW = new Date("2026-09-20T10:00:00.000Z");
export const seedModel = () => ({
  documentId: "synthetic-document",
  document: {
    version: "2.10.2",
    theme: "default",
    language: "ko-KR",
    id: "SE-synthetic-doc",
    components: [
      {
        id: "SE-title",
        layout: "default",
        title: [
          {
            id: "SE-p1",
            nodes: [
              {
                id: "SE-n1",
                value: "이전 테스트 제목입니다",
                "@ctype": "textNode",
              },
            ],
            "@ctype": "paragraph",
          },
        ],
        subTitle: null,
        align: "left",
        "@ctype": "documentTitle",
      },
      {
        id: "SE-body",
        layout: "default",
        value: [
          {
            id: "SE-p2",
            nodes: [
              {
                id: "SE-n2",
                value: "이전 테스트 본문입니다.",
                link: { url: 'https://link.coupang.com/a/example123' },
                "@ctype": "textNode",
              },
            ],
            "@ctype": "paragraph",
          },
        ],
        "@ctype": "text",
      },
    ],
    di: { dif: false, dio: [] },
  },
});

export function bind(job) {
  const bundle = job.publicationBundle,
    doc = bundle.document;
  bundle.qualityReview.documentFingerprint = documentFingerprint(doc);
  bundle.qualityReview.claimLedgerFingerprint = fingerprint(bundle.claimLedger);
  const quality=bundle.qualityReview;
  if(reviewDirectories.has(quality.evidenceFile)) {
    const bytes=JSON.stringify(quality);
    writeFileSync(path.join(reviewDirectories.get(quality.evidenceFile),quality.evidenceFile),bytes);
    quality.evidenceSha256=sha256(bytes);
  }
  let presentation;
  try {presentation=editorPresentationFingerprint(compileEditorModel(seedModel(),doc));}
  catch {presentation=fingerprint(doc);}
  job.preflight.compiledPresentationFingerprint=presentation;
  for (const review of Object.values(bundle.renderReviews)) {
    review.documentFingerprint = documentFingerprint(doc);
    review.observedUnitsFingerprint = unitsFingerprint(renderUnits(doc));
    review.compiledPresentationFingerprint=presentation;
  }
  job.bodyBlocks = structuredClone(doc.blocks);
  job.preflight.documentFingerprint = documentFingerprint(doc);
  job.publicationBundleFingerprint = fingerprint(bundle);
  job.preflight.publicationBundleFingerprint = job.publicationBundleFingerprint;
  job.authorization.contentFingerprint = publisherContentFingerprint(job);
  return job;
}
export async function publicationFixture(directory, now = NOW) {
  const checkedAt = now.toISOString();
  const reviewFile=`synthetic-review-${randomUUID()}.json`;
  reviewDirectories.set(reviewFile,directory);
  const products = [],
    evidence = {},
    claims = [];
  for (let i = 0; i < 4; i++) {
    const file = `product-${i}.json`,
      data = Buffer.from(
        JSON.stringify({
          synthetic: true,
          productId: String(1000 + i),
          price: 10000 + i,
        }),
      );
    await writeFile(path.join(directory, file), data);
    const hash = sha256(data),
      url = `https://www.coupang.com/vp/products/${1000 + i}`;
    products.push({
      schemaVersion: 1,
      checkedAt,
      productId: String(1000 + i),
      itemId: String(2000 + i),
      vendorItemId: String(3000 + i),
      variantId: "variant0",
      productTitle: `테스트 상품 ${i}`,
      productUrl: url,
      payablePriceKrw: 10000 + i,
      variant: "기본 흰색 3단",
      stockState: "in_stock",
      affiliateUrl:
        i === 0 ? "https://link.coupang.com/a/example123" : undefined,
      credentialsPersisted: false,
      linkVerification: { passed: true, checkedAt, targetMatches: true },
      seller: "테스트 판매자",
      quantity: 1,
      priceBasis: "none",
      conditions: "일반회원 기본 가격",
      shippingKrw: 0,
      evidenceFile: file,
      evidenceSha256: hash,
    });
    evidence[`E${i}`] = { url, checkedAt, evidenceFile: file, sha256: hash };
    products[i].attributes = { width: 12, depth: 20, stages: 3 };
    claims.push({
      claimId: `C${i}`,
      text: `테스트 상품 ${i}의 가격은 ${10000 + i}원`,
      productId: String(1000 + i),
      variantId: "variant0",
      claimType: "price",
      support: "supports",
      publishable: true,
      sources: [`E${i}`],
      expiresAt: new Date(now.getTime() + 30 * 60000).toISOString(),
    });
  }
  const renderReviews = {};
  for (const [device, width, height] of [
    ["desktop", 1024, 768],
    ["mobile", 390, 844],
  ]) {
    const png = new PNG({ width, height });
    png.data.fill(255);
    const data = PNG.sync.write(png);
    const file = `${device}.png`;
    await writeFile(path.join(directory, file), data);
    renderReviews[device] = {
      source: "rendered_dom",
      channel:'naver_editor',nativeDocumentInjected:true,browserWritesBlocked:true,
      presentationChecks:{headingHierarchy:true,labeledLinks:true,paragraphSpacing:true,noHorizontalOverflow:true},
      checkedAt,
      viewport: { width, height },
      disclosureRect: { top: 180, bottom: 230 },
      screenshotFile: file,
      screenshotSha256: sha256(data),
    };
  }
  const title = "틈새 수납장 비교 테스트 선택 기준";
  const blocks = [
    {
      type: "notice",
      text: "이 포스팅은 쿠팡 파트너스 활동의 일환으로 수수료를 제공받습니다.",
    },
    { type: "link", label: "현재 옵션 확인", url: products[0].affiliateUrl },
    { type: "heading", text: "공간에 맞는 선택 기준", claimClass: "guidance" },
    ...products.map((p, i) => ({
      type: "paragraph",
      text: claims[i].text,
      claimClass: "factual",
      claimIds: [`C${i}`],
    })),
    {
      type: "quote",
      text: "문 여는 공간을 먼저 확인하세요.",
      claimClass: "guidance",
    },
    { type: "divider" },
  ];
  return bind({
    jobId: "synthetic-api-update",
    blogId: "fixtureblog",
    mode: "publish",
    target: { type: "update", logNo: "123456789" },
    title,
    bodyBlocks: blocks,
    publish: true,
    dryRun: false,
    executionMode: "independent_http",
    publishSettings: { visibility: "public", timing: "current" },
    commercialSnapshot: products[0],
    affiliate: { url: products[0].affiliateUrl, accountId: 'AF1234567', verification: {
      source: 'independent_http_redirect', checkedAt, status: 302, url: products[0].affiliateUrl,
      accountId: 'AF1234567', productId: '1000', itemId: '2000', vendorItemId: '3000' } },
    minParagraphs: 8,
    maxParagraphLength: 1000,
    publicationBundle: {
      schemaVersion: 1,
      format: "comparison",
      comparisonCriteria: [
        { key: "width", label: "폭", unit: "cm" },
        { key: "depth", label: "깊이", unit: "cm" },
        { key: "stages", label: "선반", unit: "단" },
      ],
      authorId: "fixture-writer",
      authorExecutionId:'synthetic-author-execution',
      document: { blogId: "fixtureblog", logNo: "123456789", title, blocks },
      products,
      claimLedger: { schemaVersion: 1, evidence, claims },
      collision: { blogId: "fixtureblog", checkedAt, decision: "update" },
      qualityReview: {
        decision: "pass",
        checkedAt,
        reviewerRole: "independent_verifier",
        reviewerId: "fixture-reviewer",
        provenance:{method:'separate_agent',authorExecutionId:'synthetic-author-execution',reviewerExecutionId:'synthetic-reviewer-execution',receipt:'synthetic-test-only-receipt'},
        evidenceFile:reviewFile,
        editorialAssessments:Object.fromEntries([...editorialDimensions,'semanticRepetition'].map(k=>[k,{status:'pass',blockIndexes:[3],rationale:'Synthetic regression fixture with a concrete passage; this does not establish live editorial quality.'}])),
        hardBlocks: [],
        checks: {
          readerIntent: true,
          comparisonFairness: true,
          claimsSupported: true,
          noMisleadingExperience: true,
          sourceTraceability: true,
        },
      },
      renderReviews,
    },
    preflight: {
      kind: "independent_http_update_preflight",
      source: "independent_http",
      checkedAt,
      passed: true,
      sourceDocumentFingerprint: fingerprint(inspectEditorModel(seedModel())),
      dryRunJobId: "synthetic-dry-job",
      dryRunJobFingerprint: "a".repeat(64),
      dryRunResultFingerprint: "b".repeat(64),
      dryRunGateFingerprint: "c".repeat(64),
    },
    authorization: {
      approved: true,
      approvedBy: "user",
      approvedAt: checkedAt,
      scope: "publish_once",
    },
  });
}

const escape = (s) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;");
export function publicHtml(document) {
  const labeledLinks=new Map(document.blocks.filter(b=>b.type==='link'&&b.display==='label').map(b=>[b.label,b.url]));
  const components = renderUnits(document)
    .map((u) =>
      u.type === "divider"
        ? '<div class="se-component se-horizontalLine"></div>'
        : u.type === "image"
          ? `<div class="se-component se-image"><img data-lazy-src="${escape(u.value)}"></div>`
          : u.type === "linkcard"
            ? `<div class="se-component se-oglink"><a href="${escape(u.value)}">상품 카드</a></div>`
            : `<div class="se-component ${u.type === "quote" ? "se-quotation" : "se-text"}"><p class="se-text-paragraph">${/^https:\/\//.test(u.value) || labeledLinks.has(u.value) ? `<a href="${escape(labeledLinks.get(u.value)||u.value)}">${escape(u.value)}</a>` : escape(u.value)}</p></div>`,
    )
    .join("");
  return `<html><head><meta property="og:title" content="${escape(document.title)}"><meta property="og:url" content="https://blog.naver.com/${document.blogId}/${document.logNo}"></head><body><aside>네비게이션에만 있는 문구</aside><div id="post-view${document.logNo}"><div class="se-main-container">${components}</div></div></body></html>`;
}
