import {verifyArchivedComparisonEvidence} from './archived-comparison-contract.mjs';
import { readFile, stat, realpath } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import { sha256, aiResearchImageQuotation } from "./publication-document.mjs";
import { fingerprint } from '../../../../packages/contracts/src/index.mjs';
import {verifyHotelPromotionEvidence} from './hotel-promotion-contract.mjs';
import {verifyAiResearchEvidence} from './ai-research-article-contract.mjs';
import {verifySingleOfferHotdealEvidence} from './single-offer-hotdeal-contract.mjs';
import {verifyMarketAnalysisEvidence} from './market-analysis-article-contract.mjs';
import {isFrontierComparison,frontierOriginalQuotation} from './frontier-model-comparison-contract.mjs';
import {userDirectedJevWaiver} from './dynamic-article-gates.mjs';

export async function verifyPublicationArtifacts(bundle, { baseDir } = {}) {
  const root = path.resolve(baseDir || ".");
  const checks = {};
  const read = async (relative, hash, limit = 20 * 1024 * 1024) => {
    if (typeof relative !== "string" || path.isAbsolute(relative) || !relative)
      throw new Error("INVALID_ARTIFACT_PATH");
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep))
      throw new Error("ARTIFACT_OUTSIDE_BUNDLE");
    if (
      !(await realpath(file)).startsWith((await realpath(root)) + path.sep) ||
      (await stat(file)).size > limit
    )
      throw new Error("ARTIFACT_OUTSIDE_BUNDLE");
    const data = await readFile(file);
    if (data.length > limit || sha256(data) !== hash)
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
  if(bundle?.archiveComparison?.kind==='velment-20260920-archive-v1') Object.assign(checks,(await verifyArchivedComparisonEvidence(bundle,{read})).checks);
  if(bundle?.format==='travel_itinerary') {
    try {await read(bundle.itinerary?.evidenceFile,bundle.itinerary?.evidenceSha256);checks.itineraryEvidenceVerified=true;}
    catch {checks.itineraryEvidenceVerified=false;}
  }
  if(bundle?.format==='hotel_promotion') {
    for(const [index,product] of (bundle.products||[]).entries()) {
      try {
        const report=await verifyHotelPromotionEvidence(product,{read});
        for(const [key,value] of Object.entries(report.checks)) checks[`promotion${index}_${key}`]=value;
      } catch {checks[`promotion${index}EvidenceVerified`]=false;}
    }
  }
  if(bundle?.format==='single_offer_hotdeal') {
    for(const [index,product] of (bundle.products||[]).entries()) {
      try {const report=await verifySingleOfferHotdealEvidence(product,{read});for(const [key,value] of Object.entries(report.checks))checks[`hotdeal${index}_${key}`]=value;}
      catch {checks[`hotdeal${index}_evidenceVerified`]=false;}
    }
  }
  if(bundle?.format==='ai_research_article') {
    if(bundle.gatePlan){
      for(const [index,media] of (bundle.document?.blocks||[]).filter(b=>['image','video'].includes(b.type)&&b.sourceArtifact).entries()){
        try{
          const original=media.sourceArtifact,source=(bundle.research?.sources||[]).find(s=>s.id===media.sourceId);
          if(!source||original.sourcePageUrl!==(source.publicUrl||source.url))throw Error('ORIGINAL_SOURCE_SCOPE');
          const limit=media.type==='video'?256*1024*1024:20*1024*1024;
          const sourceBytes=await read(original.sourceFile,original.sourceSha256,limit),publishedBytes=await read(media.file,media.sha256,limit);
          checks["adaptiveOriginalMedia"+index+"Verified"]=sourceBytes.equals(publishedBytes);
        }catch{checks["adaptiveOriginalMedia"+index+"Verified"]=false;}
      }
      if(userDirectedJevWaiver(bundle)) checks.adaptiveUserJevWaiverScoped=true;
      else try {
        const evidence=JSON.parse((await read(bundle.adaptiveReview?.evidenceFile,bundle.adaptiveReview?.evidenceSha256)).toString('utf8'));
        const {evidenceFile,evidenceSha256,...review}=bundle.adaptiveReview;
        checks.adaptiveReviewArtifactBound=fingerprint(evidence)===fingerprint(review);
      }catch{checks.adaptiveReviewArtifactBound=false;}
      // First-party runs: the stated provenance and generated output must be the exact bytes on disk.
      for(const [index,run] of (Array.isArray(bundle.firstPartyRuns)?bundle.firstPartyRuns:[]).entries()){
        try{await read(run.provenanceFile,run.provenanceSha256);await read(run.outputFile,run.outputSha256);checks["adaptiveFirstPartyRun"+index+"Verified"]=true;}
        catch{checks["adaptiveFirstPartyRun"+index+"Verified"]=false;}
      }
    }
    for(const [index,image] of (bundle.document?.blocks||[]).filter(b=>b.type==='image'&&b.rights?.basis==='official_source_reproduced').entries()) {
      try {
        if(!aiResearchImageQuotation(image,bundle.research?.sources)) throw Error('OFFICIAL_IMAGE_SCOPE');
        const artifact=image.sourceArtifact,original=await read(artifact.sourceFile,artifact.sourceSha256),published=await read(image.file,image.sha256);
        if(!original.equals(published)) throw Error('OFFICIAL_IMAGE_BYTES_CHANGED');
        const png=PNG.sync.read(published,{checkCRC:true}),rgb=Buffer.alloc(png.width*png.height*3);
        for(let i=0,j=0;i<png.data.length;i+=4){rgb[j++]=png.data[i];rgb[j++]=png.data[i+1];rgb[j++]=png.data[i+2];}
        checks[`aiResearchOfficialImage${index}Verified`]=png.width===artifact.width&&png.height===artifact.height&&sha256(rgb)===artifact.decodedPixelSha256;
      } catch { checks[`aiResearchOfficialImage${index}Verified`]=false; }
    }
    if(isFrontierComparison(bundle)) for(const [index,image] of (bundle.document?.blocks||[]).filter(b=>b.type==='image'&&b.rights?.basis==='editorial_quotation').entries()) {
      try {
        if(!frontierOriginalQuotation(bundle.document,image)) throw Error('ORIGINAL_SCOPE');
        const a=image.sourceArtifact;await read(a.sourceFile,a.sourceSha256);
        const png=PNG.sync.read(await read(image.file,image.sha256));
        const rgb=Buffer.alloc(png.width*png.height*3);for(let i=0,j=0;i<png.data.length;i+=4){rgb[j++]=png.data[i];rgb[j++]=png.data[i+1];rgb[j++]=png.data[i+2];}
        checks[`officialOriginal${index}Verified`]=png.width===a.width&&png.height===a.height&&sha256(rgb)===a.decodedPixelSha256;
      } catch {checks[`officialOriginal${index}Verified`]=false;}
    }
    try {Object.assign(checks,(await verifyAiResearchEvidence(bundle,{read})).checks);}
    catch {checks.researchEvidenceVerified=false;}
  }
  if(bundle?.format==='market_analysis_article') {
    try {Object.assign(checks,(await verifyMarketAnalysisEvidence(bundle,{read})).checks);}
    catch {checks.marketEvidenceVerified=false;}
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
