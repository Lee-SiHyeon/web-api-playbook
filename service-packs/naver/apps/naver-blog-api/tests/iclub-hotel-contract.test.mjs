import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {iclubFixture,ICLUB_NOW as now} from './support/iclub-hotel-fixture.mjs';
import {bind} from './support/publication-fixture.mjs';
import {evaluateIclubSnapshot,evaluateIclubAffiliate,verifyIclubAffiliate,verifyIclubEvidence,iclubLayoutChecks} from '../scripts/gates/iclub-hotel-contract.mjs';
import {buildIclubResearchArtifacts} from '../scripts/gates/iclub-research-builder.mjs';
import {evaluateCommercialSnapshot} from '../scripts/gates/commercial-snapshot-gates.mjs';
import {evaluateAffiliateLinkGate,verifyAffiliateRedirect} from '../scripts/gates/affiliate-link-gate.mjs';
import {evaluatePublisherJobGate,publisherContentFingerprint} from '../scripts/gates/publisher-gates.mjs';
import {evaluateExactReadback} from '../scripts/gates/publication-review-gates.mjs';
import {renderUnits,sha256} from '../scripts/gates/publication-document.mjs';
const fixture=async t=>{const dir=await mkdtemp(path.join(os.tmpdir(),'iclub-contract-'));t.after(()=>rm(dir,{recursive:true,force:true}));return {dir,...await iclubFixture(dir)};};

test('iclub local comparison dispatch passes the complete job gate with two independently linked image banners',async t=>{
  const {dir,job}=await fixture(t);
  assert.equal(evaluateCommercialSnapshot(job.commercialSnapshot,{now}).passed,true);
  assert.equal(evaluateAffiliateLinkGate(job,{now}).passed,true);
  const report=await evaluatePublisherJobGate(job,{baseDir:dir,now});
  assert.equal(report.passed,true,JSON.stringify({failed:report.failedChecks,review:report.details.publicationReview?.failedChecks,artifacts:report.details.artifacts?.failedChecks}));
  assert.equal(report.details.publicationReview.independentEditorialReviewVerified,true);
  assert.equal(report.details.artifacts.checks.promotion0_iclub1DatedOptionSourceMatches,true);
});

test('snapshot rejects relabeled campaigns, different rooms or occupancy, guaranteed inventory and shared promotion dates',async t=>{
  const {job}=await fixture(t);
  const edits=[p=>p.productId='202609_MONOGRAM',p=>p.campaignKeyType='official',p=>p.promotionCode='iclub_202609',p=>p.sales={endsAt:'2026-09-30'},p=>p.propertyOffers.reverse(),p=>p.propertyOffers.push(p.propertyOffers[0]),p=>p.propertyOffers=[null],p=>p.propertyOffers[0].roomName='iSuite',p=>p.propertyOffers[0].roomId='222857246',p=>p.propertyOffers[0].rateOptionId+='other',p=>p.propertyOffers[0].adults=4,p=>p.propertyOffers[0].children=1,p=>p.propertyOffers[0].rooms=2,p=>p.propertyOffers[0].nights=1,p=>p.propertyOffers[0].checkIn='2026-10-12',p=>p.propertyOffers[0].checkOut='2026-11-04',p=>p.propertyOffers[0].totalTaxIncluded=false,p=>p.propertyOffers[0].nightlyTaxIncluded=true,p=>p.propertyOffers[0].sourceUrl+='&adultCount=5',p=>p.propertyOffers[0].productUrl=p.propertyOffers[1].productUrl,p=>p.propertyOffers[0].checkedAt='2026-09-21T05:00:00Z',p=>p.propertyOffers[1].promotion.endsAtLocal='2026-09-30T23:59:59',p=>p.propertyOffers[1].promotion.appliesToSelectedRate=true,p=>p.propertyOffers[0].benefits.lateCheckout.time='14:00',p=>p.propertyOffers[1].benefits.lateCheckout.time='13:00',p=>p.propertyOffers[0].benefits.lateCheckout.requestRequired=false,p=>p.propertyOffers[0].benefits.lateCheckout.subjectToAvailability=false,p=>p.propertyOffers[0].minimumBookableNights=2,p=>p.propertyOffers[0].maximumOccupancyVerified=true,p=>p.propertyOffers[0].confirmationText='즉시 확정',p=>p.propertyOffers[0].cancellation.freeUntilKst='2026-10-25T01:00:00Z',p=>p.bookingStatus='confirmed',p=>p.availability='available',p=>p.payablePriceKrw=960712,p=>p.stockState='in_stock',p=>p.propertyOffers[1].affiliateUrl=p.affiliateUrl];
  for(const [i,edit] of edits.entries()){const p=structuredClone(job.commercialSnapshot);edit(p);assert.equal(evaluateCommercialSnapshot(p,{now}).passed,false,`mutation ${i}`);}
});

test('valid hashes cannot mask changed raw date, rate, total, tax label, conditional benefits or confirmation',async t=>{
  const {job,bytes}=await fixture(t),p=job.commercialSnapshot;
  const check=async(edit,primary=false)=>{
    const next=structuredClone(p),q=next.propertyOffers[0],file=primary?q.propertyEvidence.evidenceFile:q.evidenceFile;
    const raw=JSON.parse(bytes.get(file));edit(raw);const changed=Buffer.from(JSON.stringify(raw)),hash=sha256(changed);
    if(primary)q.propertyEvidence.sha256=hash;else q.evidenceSha256=hash;
    const manifest=JSON.parse(bytes.get(p.evidenceFile));manifest.find(r=>r.file===file).sha256=hash;
    const manifestBytes=Buffer.from(JSON.stringify(manifest));next.evidenceSha256=sha256(manifestBytes);
    const report=await verifyIclubEvidence(next,{read:async(f,h)=>{const b=f===file?changed:f===p.evidenceFile?manifestBytes:bytes.get(f);assert.equal(sha256(b),h);return b;}});
    assert.equal(report.checks.iclub0FetchReceiptsMatch,true);
    assert.equal(report.checks[primary?'iclub0PropertySourceMatches':'iclub0DatedOptionSourceMatches'],false);
  };
  const card=r=>r.data.sections[0].gridCards[0],opt=r=>card(r).bestOptions[0];
  for(const edit of [r=>r.result.status=403,r=>r.data.sections[0].header.startDate='2026-10-12',r=>r.data.sections[0].header.endDate='2026-11-04',r=>r.data.sections[0].header.persons.adultCount=4,r=>r.data.sections[0].header.persons.childCount=1,r=>card(r).header.roomId=1,r=>opt(r).gid=4818069,r=>opt(r).rateOptionId+='x',r=>opt(r).roomId=1,r=>opt(r).startDateTime='2026-11-03T15:00:00',r=>opt(r).priceDetail.prices[0].title='객실 2개 x 1박',r=>opt(r).priceDetail.prices[1].krwPrice='436,688원',r=>opt(r).price.taxIncludedText='1박 세금 포함 960,712원',r=>opt(r).price.discountedPriceText='304,700원',r=>opt(r).salePrice=1,r=>opt(r).optionAllAttributes.contents[0].items[1].items=['요청 없어도 확정 제공'],r=>opt(r).optionAllAttributes.contents[0].items[1].titleWithIcon.text='2박 이상- 14시 무료 레이트 체크아웃 제공',r=>opt(r).optionAllAttributes.contents[0].items[2].items=['언제든 무료 취소'],r=>opt(r).optionAllAttributes.contents[0].items[3].items=['최소 숙박일 2일'],r=>card(r).header.representAttributesWithIcon[1].title='즉시 확정',r=>opt(r).isPromotion=false,r=>opt(r).promotionPriceDisplay.endDateTime='2026-09-23T23:59:59'])await check(edit);
  for(const edit of [r=>r.data.staticArea.metaInfo.gid=4818069,r=>r.data.staticArea.header.stayTitle='다른 호텔',r=>r.data.staticArea.promotionId=27780,r=>r.data.sections[0].endDateTime='2026-09-23T23:59:59'])await check(edit,true);
});

test('both top banners, distinct image content and adjacent AI captions are required with no extra affiliate',async t=>{
  const {job}=await fixture(t);
  for(const [i,edit] of [j=>j.bodyBlocks.splice(3,1),j=>j.bodyBlocks[3].href=j.affiliate.url,j=>j.bodyBlocks[1].propertyId='4818069',j=>j.bodyBlocks[3].sha256=j.bodyBlocks[1].sha256,j=>j.bodyBlocks[2].text='호텔 제공 사진',j=>j.bodyBlocks[1].rights.basis='owned',j=>j.bodyBlocks.splice(1,0,{type:'paragraph',text:'소개 먼저'}),j=>j.bodyBlocks.push({type:'link',url:j.affiliate.secondary.url}),j=>j.affiliate.secondary.secondary={url:'https://myrealt.rip/third'},j=>j.target={type:'update',logNo:'224418752424'},j=>j.inputProvider='http_only'].entries()){
    const next=structuredClone(job);edit(next);assert.equal(evaluateIclubAffiliate(next,{now}).passed,false,`mutation ${i}`);
  }
});

test('new format cannot bypass full evidence, independent review, native images, claims or fingerprints',async t=>{
  const {dir,job}=await fixture(t);
  for(const edit of [j=>{j.publicationBundle.document.blocks=j.publicationBundle.document.blocks.filter(b=>b.type!=='image');j.minImageCount=0;},j=>j.publicationBundle.qualityReview.provenance.reviewerExecutionId=j.publicationBundle.authorExecutionId,j=>j.publicationBundle.renderReviews.mobile.presentationChecks.imagesLoaded=false,j=>j.publicationBundle.claimLedger.claims[0].support='uncertain',j=>j.publicationBundle.claimLedger.claims[0].expiresAt='2026-09-20T00:00:00Z',j=>j.publicationBundle.document.blocks[6].text+=' 즉시 확정',j=>j.publicationBundle.document.blocks[6].text+=' 14시 레이트 체크아웃',j=>j.publicationBundle.document.blocks[6].text+=' 두 호텔 모두 9월 30일',j=>j.publicationBundle.document.blocks[6].text+=' 304,700원',j=>j.publicationBundle.document.blocks[7].role='other']){
    const next=structuredClone(job);edit(next);bind(next);assert.equal((await evaluatePublisherJobGate(next,{baseDir:dir,now})).passed,false);
  }
  const honest=structuredClone(job.publicationBundle);honest.document.blocks.push({type:'paragraph',text:'체크인 14시, 일반 체크아웃 11시입니다.',claimClass:'factual',claimIds:['late_checkout']});
  assert.equal(iclubLayoutChecks(honest).iclubNoUnsupportedAssertions,true);
  const changed=structuredClone(job);changed.affiliate.secondary.creationJournalKey='f'.repeat(64);assert.notEqual(publisherContentFingerprint(changed),publisherContentFingerprint(job));
});

test('both owner journals are verified before HTTP and each exact product redirect is verified independently',async t=>{
  const {job,journal,journalEntries,fetchImpl}=await fixture(t);let calls=0;
  const counted=(...args)=>{calls++;return fetchImpl(...args);};
  assert.equal((await verifyAffiliateRedirect(job,{now,journal,fetchImpl:counted})).passed,true);assert.equal(calls,4);
  for(const edit of [e=>e.state='submitted_unknown',e=>e.receipt.ownerVerified=false,e=>e.receipt.accountFingerprint='f'.repeat(64),e=>e.receipt.targetUrl=job.affiliate.targetUrl,e=>e.receipt.data.id=0]){
    const entries=structuredClone(journalEntries),secondary=entries.get(job.affiliate.secondary.creationJournalKey);edit(secondary);calls=0;
    assert.equal((await verifyIclubAffiliate(job,{now,journal:{read:async key=>entries.get(key)},fetchImpl:counted})).passed,false);assert.equal(calls,0);
  }
});

test('secondary redirect rejects swapped hotels, changed or duplicated dates/guests, attribution and unsafe bridges',async t=>{
  const {job,journal,bridges,fetchImpl}=await fixture(t),secondary=job.affiliate.secondary;
  const original=bridges.get(secondary.url),target=new URL(original).searchParams.get('return_url');
  const badTargets=[target.replace('4818069','4819071'),target.replace('adultCount=5','adultCount=4'),target+'&adultCount=5',target.replace('checkOut=2026-11-05','checkOut=2026-11-04'),target.replace('mylink_id=12346','mylink_id=12345'),target+'&mylink_id=12346',target+'&redirect=https://evil.example',target+'#fragment',target.replace('https:','http:')];
  const locations=[original.replace('www.myrealtrip.com','evil.example'),original+'&return_url='+encodeURIComponent(target),...badTargets.map(t=>'https://www.myrealtrip.com/main/bridge/marketing?return_url='+encodeURIComponent(t))];
  for(const location of locations){let calls=0;const bad=async(u,init)=>{calls++;return u===secondary.url?new Response('',{status:301,headers:{location}}):fetchImpl(u,init);};assert.equal((await verifyIclubAffiliate(job,{now,journal,fetchImpl:bad})).passed,false);assert.equal(calls,3);}
});

test('exact ordered readback binds the secondary image href even when the primary banner still matches',async t=>{
  const {job}=await fixture(t),units=renderUnits(job.publicationBundle.document),logNo='224499999999';
  const observation={source:'independent_http',httpStatus:200,smartEditorBodyPresent:true,targetIdentityVerified:true,blogId:job.blogId,logNo,title:job.title,tags:job.publishSettings.tags,tagsObserved:true,links:[job.affiliate.url,job.affiliate.secondary.url],units,checkedAt:now.toISOString()};
  assert.equal(evaluateExactReadback(job,observation,{now,createdLogNo:logNo}).passed,true);
  for(const edit of [o=>delete o.units[3].href,o=>o.units[3].href=job.affiliate.url,o=>o.units.splice(3,1),o=>[o.units[1],o.units[3]]=[o.units[3],o.units[1]]]){const next=structuredClone(observation);edit(next);assert.equal(evaluateExactReadback(job,next,{now,createdLogNo:logNo}).passed,false);}
});

test('research builder preserves original claims/evidence and blocks missing ownership, source hashes and expiry',async t=>{
  const {dir,research,ledger,links,journal,fetchImpl}=await fixture(t),original=JSON.stringify({research,ledger,links});
  const built=await buildIclubResearchArtifacts({baseDir:dir,research,ledger,links,journal,fetchImpl,now});
  assert.equal(JSON.stringify({research,ledger,links}),original);assert.deepEqual(built.claimLedger.claims.map(c=>c.text),ledger.claims.map(c=>c.text));assert.deepEqual(built.claimLedger.evidence,ledger.evidence);assert.equal(built.snapshot.campaignKeyType,'local');
  for(const edit of [x=>x.links.sheungwan.ownerVerified=false,x=>x.research.evidence.quote0.sha256='a'.repeat(64),x=>x.research.evidence.quote0.evidenceFile='../outside.json',x=>x.research.evidence.quote0.checkedAt='2026-09-20T00:00:00Z',x=>x.ledger.claims[0].expiresAt='2026-09-20T00:00:00Z',x=>x.ledger.evidence.quote0.sha256='a'.repeat(64),x=>x.research.quotes[0].totalKrw=1]){
    const data=structuredClone({research,ledger,links});edit(data);let calls=0;await assert.rejects(buildIclubResearchArtifacts({baseDir:dir,...data,journal,now,fetchImpl:(...args)=>{calls++;return fetchImpl(...args);}}));assert.equal(calls,0);
  }
});
