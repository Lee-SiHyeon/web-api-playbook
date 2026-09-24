import test from 'node:test';
import assert from 'node:assert/strict';
import {validateScope,validateReviews} from '../workflows/republish/core.mjs';
import {JEV_QUALITY_QUESTIONS,buildJevQualityState} from '../workflows/republish/jev-quality.mjs';
import {documentFingerprint} from '../scripts/gates/publication-document.mjs';
import {fingerprint} from '../../../packages/contracts/src/index.mjs';
const id='224417064414',document={blogId:'testblog',logNo:id,title:'Example',blocks:[{type:'paragraph',text:'Original'}]};
const job={blogId:'testblog',target:{type:'update',logNo:id},publicationBundle:{document}};
const manifest={blogId:'testblog',posts:{[id]:{}}};
const ledger={claims:[]};
const requestFingerprint=buildJevQualityState(document,ledger);
const jevQuality={
 schemaVersion:1,gate:'jev-quality',checkedAt:new Date().toISOString(),decisionId:'republish-editorial-quality',
 provider:'fixture',model:'fixture',mode:'active',providerResult:'ok',confidenceFloor:0.82,documentFingerprint:documentFingerprint(document),
 claimLedgerFingerprint:fingerprint(ledger),requestFingerprint:fingerprint(requestFingerprint),
 comparisons:Object.fromEntries(Object.keys(JEV_QUALITY_QUESTIONS).map(id=>[id,{eligible:true,adoptedSource:'jev_active'}])),
 adopted:{evidence_sufficient:{noul:0.95},editorial_quality:{score:2},next_action:{choice:'publish'},ai_slop_free:{noul:0.95},table_use:{noul:0.95},core_prose:{noul:0.95},unsupported_claims_absent:{noul:0.95}},
};
test('manifest target must match blog, operation and document, not just post argument',()=>{
 assert.doesNotThrow(()=>validateScope(manifest,job,id));
 for(const change of [j=>j.blogId='another',j=>j.target.type='create',j=>j.target.logNo='224417064415',j=>j.publicationBundle.document.blogId='another',j=>j.publicationBundle.document.logNo='224417064415']){const j=structuredClone(job);change(j);assert.throws(()=>validateScope(manifest,j,id),/TARGET_SCOPE/);}
 assert.throws(()=>validateScope(manifest,job,'../224417064414'),/TARGET_SCOPE/);
});
test('assembly refuses stale editorial, stale ledger or either missing/stale native viewport',()=>{
 const fp=documentFingerprint(document),review={documentFingerprint:fp,claimLedgerFingerprint:fingerprint(ledger)},native={reviews:{desktop:{documentFingerprint:fp},mobile:{documentFingerprint:fp}}};
 assert.doesNotThrow(()=>validateReviews(document,ledger,review,native,jevQuality));
 assert.throws(()=>validateReviews({...document,title:'Changed'},ledger,review,native),/REVIEW_REVISION/);
 assert.throws(()=>validateReviews(document,{claims:[{}]},review,native),/REVIEW_REVISION/);
 assert.throws(()=>validateReviews(document,ledger,review,{reviews:{desktop:{documentFingerprint:fp}}}),/NATIVE_REVISION/);
 assert.throws(()=>validateReviews(document,ledger,review,{reviews:{...native.reviews,mobile:{documentFingerprint:'old'}}}),/NATIVE_REVISION/);
 assert.throws(()=>validateReviews(document,ledger,review,native),/JEV_QUALITY/);
 assert.throws(()=>validateReviews(document,ledger,review,native,{...jevQuality,documentFingerprint:'old'}),/JEV_QUALITY_REVISION/);
});
