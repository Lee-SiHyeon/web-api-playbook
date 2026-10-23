import { readFile, stat, realpath } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import { sha256 } from "./publication-document.mjs";
import { fingerprint } from '../../../../packages/contracts/src/index.mjs';

export async function verifyPublicationArtifacts(bundle, { baseDir } = {}) {
  const root = path.resolve(baseDir || ".");
  const checks = {};
  const read = async (relative, hash) => {
    if (typeof relative !== "string" || path.isAbsolute(relative) || !relative)
      throw new Error("INVALID_ARTIFACT_PATH");
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep))
      throw new Error("ARTIFACT_OUTSIDE_BUNDLE");
    if (
      !(await realpath(file)).startsWith((await realpath(root)) + path.sep) ||
      (await stat(file)).size > 20 * 1024 * 1024
    )
      throw new Error("ARTIFACT_OUTSIDE_BUNDLE");
    const data = await readFile(file);
    if (data.length > 20 * 1024 * 1024 || sha256(data) !== hash)
      throw new Error("ARTIFACT_HASH_MISMATCH");
    return data;
  };
  for (const device of ["desktop", "mobile"]) {
    const review = bundle?.renderReviews?.[device];
    try {
      const data = await read(review?.screenshotFile, review?.screenshotSha256);
      if (
        data.length < 24 ||
        !data
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        data.readUInt32BE(16) * data.readUInt32BE(20) > 10000000
      )
        throw new Error("INVALID_SCREENSHOT");
      const png = PNG.sync.read(data, { checkCRC: true });
      checks[`${device}ScreenshotVerified`] =
        png.width === review.viewport.width &&
        png.height === review.viewport.height;
    } catch {
      checks[`${device}ScreenshotVerified`] = false;
    }
  }
  for (const [index, product] of (bundle?.products || []).entries()) {
    try {
      await read(product.evidenceFile, product.evidenceSha256);
      checks[`product${index}EvidenceVerified`] = true;
    } catch {
      checks[`product${index}EvidenceVerified`] = false;
    }
  }
  try {
    const review = bundle?.qualityReview;
    const data = await read(review?.evidenceFile, review?.evidenceSha256);
    const evidence = JSON.parse(data.toString('utf8'));
    checks.editorialReviewVerified = evidence.documentFingerprint === review.documentFingerprint &&
      evidence.claimLedgerFingerprint === review.claimLedgerFingerprint &&
      JSON.stringify(evidence.provenance) === JSON.stringify(review.provenance) &&
      JSON.stringify(evidence.editorialAssessments) === JSON.stringify(review.editorialAssessments) &&
      ['checkedAt','reviewerId','reviewerRole','reviewMode','userDirective','checks','hardBlocks'].every(k=>fingerprint(evidence[k] ?? null)===fingerprint(review[k] ?? null)) &&
      evidence.decision === 'pass';
  } catch { checks.editorialReviewVerified = false; }
  for (const [id, evidence] of Object.entries(
    bundle?.claimLedger?.evidence || {},
  )) {
    try {
      await read(evidence.evidenceFile, evidence.sha256);
      checks[`claim${id}EvidenceVerified`] = true;
    } catch {
      checks[`claim${id}EvidenceVerified`] = false;
    }
  }
  const failedChecks = Object.keys(checks).filter((k) => checks[k] !== true);
  return {
    passed: failedChecks.length === 0 && Object.keys(checks).length >= 4,
    checks,
    failedChecks,
  };
}
