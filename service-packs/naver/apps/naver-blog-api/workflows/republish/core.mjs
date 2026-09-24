import fs from 'node:fs/promises';
import path from 'node:path';
import {fingerprint} from '../../../../packages/contracts/src/index.mjs';
import {documentFingerprint,sha256,documentTables,text} from '../../scripts/gates/publication-document.mjs';
import {evaluateExactReadback} from '../../scripts/gates/publication-review-gates.mjs';
import {auditPost} from '../../scripts/api/post-audit.mjs';
import {isInformationalArticle} from '../../scripts/gates/informational-article-contract.mjs';
import {requireJevQualityEvidence} from './jev-quality.mjs';
export const read=async p=>JSON.parse((await fs.readFile(p,'utf8')).replace(/^\uFEFF/,''));
export const save=(p,v)=>fs.writeFile(p,JSON.stringify(v,null,2)+'\n');
export function validateScope(manifest,job,id){
 if(!/^[0-9]{6,}$/.test(id)||!manifest.posts?.[id]||job.blogId!==manifest.blogId||job.target?.type!=='update'||String(job.target.logNo)!==id||job.publicationBundle?.document?.blogId!==manifest.blogId||String(job.publicationBundle.document.logNo)!==id)throw Error('TARGET_SCOPE');
}
export async function loadContext(file,id,authorized=false){
 const manifest=await read(file),entry=manifest.posts?.[id];
 if(manifest.schemaVersion!==1||!entry?.directory||!entry?.journal)throw Error('MANIFEST_SCOPE');
 const base=path.dirname(path.resolve(file)),dir=path.resolve(base,entry.directory),journal=path.resolve(base,entry.journal);
 const job=await read(path.join(dir,authorized?'authorized-job.json':'job.json'));validateScope(manifest,job,id);
 return {manifest,entry,dir,journal,job,id,blogId:manifest.blogId};
}
export function validateReviews(document,ledger,review,native,jevQuality){
 const fp=documentFingerprint(document);
 if(review.documentFingerprint!==fp||review.claimLedgerFingerprint!==fingerprint(ledger))throw Error('REVIEW_REVISION');
 if(!native.reviews?.desktop||!native.reviews?.mobile||Object.values(native.reviews).some(r=>r.documentFingerprint!==fp))throw Error('NATIVE_REVISION');
 requireJevQualityEvidence(jevQuality,{document,ledger,requestFingerprint:jevQuality?.requestFingerprint});
}
export function requireJevQuality(job){
 if(job?.qualityPolicy?.jev!=='required'||!job.publicationBundle?.jevQuality)throw Error('JEV_QUALITY_REQUIRED');
 return requireJevQualityEvidence(job.publicationBundle.jevQuality,{document:job.publicationBundle.document,ledger:job.publicationBundle.claimLedger,requestFingerprint:job.publicationBundle.jevQuality.requestFingerprint});
}
export async function assemble(ctx){
 const {dir,job}=ctx,document=await read(path.join(dir,'document.json')),ledger=await read(path.join(dir,'claim-ledger.json'));
 validateScope(ctx.manifest,{...job,publicationBundle:{...job.publicationBundle,document}},ctx.id);
 const review=await read(path.join(dir,'editorial-review.json')),native=await read(path.join(dir,'native-preview.json')),jevQuality=await read(path.join(dir,'jev-quality.json'));
 validateReviews(document,ledger,review,native,jevQuality);
 job.qualityPolicy={...(job.qualityPolicy||{}),jev:'required'};
 job.publicationBundle={...job.publicationBundle,document,claimLedger:ledger,renderReviews:native.reviews,jevQuality,qualityReview:{...review,evidenceFile:'editorial-review.json',evidenceSha256:sha256(await fs.readFile(path.join(dir,'editorial-review.json')))}};
 let gatePlan;
 try{gatePlan=await read(path.join(dir,'gate-plan.json'));}catch(e){if(e.code!=='ENOENT'||job.publicationBundle.gatePlan)throw e;}
 if(gatePlan){
  const adaptiveReview=await read(path.join(dir,'adaptive-review.json'));
  try{job.publicationBundle.research=await read(path.join(dir,'research-snapshot.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
  job.publicationBundle.gatePlan=gatePlan;
  job.publicationBundle.layoutReference={...job.publicationBundle.layoutReference,id:'adaptive-ai-v1'};
  job.publicationBundle.adaptiveReview={...adaptiveReview,evidenceFile:'adaptive-review.json',evidenceSha256:sha256(await fs.readFile(path.join(dir,'adaptive-review.json')))};
 }
 job.title=document.title;job.bodyBlocks=document.blocks;job.publish=false;job.dryRun=true;
 for(const k of ['authorization','preflight','publicationBundleFingerprint'])delete job[k];
 await save(path.join(dir,'job.json'),job);await save(path.join(dir,'bundle.json'),job.publicationBundle);
 return {assembled:true,documentFingerprint:documentFingerprint(document)};
}
export async function verify(ctx){
 const {dir,job,id}=ctx,pub=await read(path.join(dir,'final-public.json')),owner=await read(path.join(dir,'final-owner.json')),baseline=await read(path.join(dir,'owner-baseline.json')),receipt=await read(path.join(dir,'publish-receipt.json'));
 requireJevQuality(job);
 const exact=evaluateExactReadback(job,pub,{createdLogNo:id}),audit=await auditPost(pub,isInformationalArticle(job)?{researchJob:job}:{});
 const expectedCaptions=job.publicationBundle.document.blocks.map((block,i)=>block.type==='image'
   ? (job.publicationBundle.document.blocks[i+1]?.presentation==='caption'?[text(job.publicationBundle.document.blocks[i+1].text)]:[]) : null).filter(group=>group!==null);
 const ownerCaptions=owner.model.document.components.filter(component=>component['@ctype']==='image')
   .map(component=>(component.caption||[]).map(paragraph=>text((paragraph.nodes||[]).map(node=>node.value||'').join(''))).filter(Boolean));
 const publicCaptions=(pub.imageCaptions||[]).map(group=>group.map(text));
 const nativeCaptions=expectedCaptions.some(group=>group.length>0)
   ? JSON.stringify(ownerCaptions)===JSON.stringify(expectedCaptions)&&JSON.stringify(publicCaptions)===JSON.stringify(expectedCaptions) : true;
 const expectedVideos=job.publicationBundle.document.blocks.filter(b=>b.type==='video'),ownerVideos=owner.model.document.components.filter(c=>c['@ctype']==='video');
 const expectedVideoCaptions=job.publicationBundle.document.blocks.flatMap((b,i)=>b.type==='video'?[job.publicationBundle.document.blocks[i+1]?.presentation==='caption'?[text(job.publicationBundle.document.blocks[i+1].text)]:[]]:[]);
 const ownerVideoCaptions=ownerVideos.map(c=>(c.caption||[]).map(p=>text((p.nodes||[]).map(n=>n.value||'').join(''))).filter(Boolean));
 const nativeVideoCaptions=JSON.stringify(expectedVideoCaptions)===JSON.stringify(ownerVideoCaptions)&&JSON.stringify(expectedVideoCaptions)===JSON.stringify((pub.videoCaptions||[]).map(group=>group.map(text)));
 const ownerVideoIdentity=JSON.stringify(expectedVideos.map(v=>v.videoId))===JSON.stringify(ownerVideos.map(v=>v.vid));
 const checks={nativeCaptions,nativeVideoCaptions,ownerVideoIdentity,accepted:receipt.ok===true&&receipt.accepted===true&&receipt.readbackVerified===true,exactBody:exact.passed===true,exactTables:JSON.stringify(pub.tables||[])===JSON.stringify(documentTables(job.publicationBundle.document)),title:pub.title===job.title,public:owner.postConfiguration.openType===2,search:owner.postConfiguration.searchYn===(typeof job.publishSettings.searchAllowed==='boolean'?job.publishSettings.searchAllowed:baseline.postConfiguration.searchYn),ownerTags:owner.postFormMeta.tags===job.publishSettings.tags.join(','),publicTags:JSON.stringify(pub.tags)===JSON.stringify(job.publishSettings.tags),configuration:receipt.configurationVerified===true,metadata:JSON.stringify(owner.postFormMeta)===JSON.stringify(baseline.postFormMeta),images:audit.uniqueVerifiedImageContents===job.publicationBundle.document.blocks.filter(b=>b.type==='image').length};
 const result={checkedAt:new Date().toISOString(),id,url:`https://blog.naver.com/${ctx.blogId}/${id}`,passed:Object.values(checks).every(Boolean),checks,exact,audit};await save(path.join(dir,'final-verification.json'),result);return result;
}
