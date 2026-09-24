import test from 'node:test';
import assert from 'node:assert/strict';
import {SEOUL_SHILLA,seoulShillaProductUrl,evaluateSeoulShillaAffiliate,verifySeoulShillaAffiliate} from '../scripts/gates/seoul-shilla-contract.mjs';
import {MYREALTRIP_ACCOUNTS} from '../scripts/gates/travel-planning-contract.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {shillaFixture} from './support/seoul-shilla-fixture.mjs';
import {bind} from './support/publication-fixture.mjs';
import {evaluateSeoulShillaSnapshot,verifySeoulShillaEvidence,seoulShillaLayoutChecks} from '../scripts/gates/seoul-shilla-contract.mjs';
import {buildSeoulShillaResearchArtifacts} from '../scripts/gates/seoul-shilla-research-builder.mjs';
import {evaluateCommercialSnapshot} from '../scripts/gates/commercial-snapshot-gates.mjs';
import {evaluatePublisherJobGate} from '../scripts/gates/publisher-gates.mjs';
import {evaluateExactReadback} from '../scripts/gates/publication-review-gates.mjs';
import {renderUnits,sha256} from '../scripts/gates/publication-document.mjs';

const now=new Date('2026-09-21T09:20:00Z');
const fixture=async t=>{const dir=await mkdtemp(path.join(os.tmpdir(),'shilla-contract-'));t.after(()=>rm(dir,{recursive:true,force:true}));return {dir,...await shillaFixture(dir,now)};};
function affiliateFixture(){
  const url='https://myrealt.rip/syntheticShilla',targetUrl=seoulShillaProductUrl(),accountFingerprint=MYREALTRIP_ACCOUNTS.aicandoanything;
  const affiliate={provider:'myrealtrip',propertyId:'2680667',url,targetUrl,accountFingerprint,mylinkId:'10001',creationJournalKey:'a'.repeat(64),verification:{source:'independent_http_redirect',checkedAt:now.toISOString(),status:301,bridgeStatus:200,url,targetUrl,propertyId:'2680667',accountFingerprint,mylinkId:'10001'}};
  const blocks=[{type:'notice',text:'제휴 배너로 구매 시 수수료를 받습니다.'},{type:'image',role:'affiliate_banner',propertyId:'2680667',href:url,sha256:'b'.repeat(64),rights:{basis:'generated'}},{type:'paragraph',text:'AI로 제작한 안내 이미지입니다.'},{type:'paragraph',text:'출처: 마이리얼트립, 확인일 2026년 9월 21일.'}];
  const p={productId:SEOUL_SHILLA.key,provider:'myrealtrip',snapshotType:'hotel_promotion',productUrl:targetUrl,affiliateUrl:url};
  const job={blogId:'aicandoanything',target:{type:'create'},inputProvider:'headless_sdk',affiliate,commercialSnapshot:p,bodyBlocks:structuredClone(blocks),publicationBundle:{format:'hotel_promotion',document:{blogId:'aicandoanything',blocks}}};
  const entry={operation:'myrealtripCreateLink',state:'verified',receipt:{source:'independent_http',status:200,ownerVerified:true,accountFingerprint,targetUrl,data:{id:10001,mylink:url}}};
  const target=targetUrl+'&utm_source=mktpartner&t_scope=604800&mylink_id=10001',bridge='https://www.myrealtrip.com/main/bridge/marketing?return_url='+encodeURIComponent(target);
  const fetchImpl=async(u,init)=>{assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');assert.equal(init.credentials,'omit');assert.equal(new Headers(init.headers).has('cookie'),false);if(u===url)return new Response('',{status:301,headers:{location:bridge}});assert.equal(u,bridge);return new Response('',{status:200,headers:{'content-type':'text/html'}});};
  return {job,entry,target,bridge,fetchImpl};
}

test('Seoul Shilla affiliate accepts only its own exact stay target and one top AI-captioned banner',async()=>{
  const {job,entry,fetchImpl}=affiliateFixture();assert.equal(evaluateSeoulShillaAffiliate(job,{now}).passed,true);
  const report=await verifySeoulShillaAffiliate(job,{now,journal:{read:async()=>entry},fetchImpl});assert.equal(report.passed,true);assert.equal(report.propertyId,'2680667');
  for(const edit of [j=>j.target={type:'update',logNo:'224418864957'},j=>j.blogId='otherblog',j=>j.inputProvider='http_only',j=>j.affiliate.secondary={url:'https://myrealt.rip/second'},j=>j.affiliate.targetUrl=j.affiliate.targetUrl.replace('adultCount=2','adultCount=5'),j=>j.bodyBlocks[1].propertyId='4819071',j=>j.bodyBlocks[1].href='https://myrealt.rip/wrong',j=>j.bodyBlocks[2].text='공식 호텔 사진',j=>j.bodyBlocks.unshift({type:'paragraph',text:'소개부터'}),j=>j.affiliate.verification.checkedAt='2026-09-21T07:00:00Z']){const next=structuredClone(job);edit(next);assert.equal(evaluateSeoulShillaAffiliate(next,{now}).passed,false);}
});

test('Seoul Shilla rejects ordinary body links, naked URLs and any second linked image',()=>{
  const {job}=affiliateFixture();
  for(const extra of [{type:'link',label:'공식 출처',url:'https://www.myrealtrip.com'},{type:'oglink',url:'https://www.myrealtrip.com'},{type:'paragraph',text:'출처: https://www.myrealtrip.com'},{type:'paragraph',text:'출처: myrealtrip.com'},{type:'image',href:'https://example.com/reference'}]){const next=structuredClone(job);next.bodyBlocks.push(extra);assert.equal(evaluateSeoulShillaAffiliate(next,{now}).checks.shillaOnlyOneLinkedBanner,false);}
});

test('Seoul Shilla verifies authenticated journal ownership before public redirect requests',async()=>{
  const {job,entry,fetchImpl}=affiliateFixture();
  for(const edit of [e=>e.state='submitted_unknown',e=>e.operation='other',e=>e.receipt.ownerVerified=false,e=>e.receipt.accountFingerprint='f'.repeat(64),e=>e.receipt.targetUrl=e.receipt.targetUrl.replace('2680667','4819071'),e=>e.receipt.data.id=999]){const changed=structuredClone(entry);edit(changed);let calls=0;assert.equal((await verifySeoulShillaAffiliate(job,{now,journal:{read:async()=>changed},fetchImpl:(...args)=>{calls++;return fetchImpl(...args);}})).passed,false);assert.equal(calls,0);}
});

test('Seoul Shilla rejects altered date/guest/tracking queries and non-first-party or duplicate bridges',async()=>{
  const {job,entry,target,bridge}=affiliateFixture();
  const destinations=[target.replace('2680667','4819071'),target.replace('checkIn=2026-09-28','checkIn=2026-09-29'),target.replace('adultCount=2','adultCount=1'),target+'&adultCount=2',target.replace('childCount=0','childCount=1'),target.replace('mylink_id=10001','mylink_id=10002'),target+'&mylink_id=10001',target+'&redirect=https://evil.example',target+'#fragment'];
  const locations=[bridge.replace('www.myrealtrip.com','evil.example'),bridge+'&return_url='+encodeURIComponent(target),...destinations.map(t=>'https://www.myrealtrip.com/main/bridge/marketing?return_url='+encodeURIComponent(t))];
  for(const location of locations){let calls=0;const fetchImpl=async()=>{calls++;return new Response('',{status:301,headers:{location}});};assert.equal((await verifySeoulShillaAffiliate(job,{now,journal:{read:async()=>entry},fetchImpl})).passed,false);assert.equal(calls,1);}
});

test('Seoul Shilla exact local dispatch passes complete publication gate without weakening shared reviews or artifacts',async t=>{
  const {dir,job}=await fixture(t);assert.equal(evaluateCommercialSnapshot(job.commercialSnapshot,{now}).passed,true);
  const report=await evaluatePublisherJobGate(job,{baseDir:dir,now});assert.equal(report.passed,true,JSON.stringify({failed:report.failedChecks,review:report.details.publicationReview?.failedChecks,artifacts:report.details.artifacts?.failedChecks}));
  assert.equal(report.details.publicationReview.independentEditorialReviewVerified,true);assert.equal(report.details.artifacts.checks.promotion0_shillaCouponOriginalsMatch,true);
});

test('Shilla snapshot rejects threshold repair, stacking, booking, tax, coupon-double-deduction and general package dates',async t=>{
  const {job}=await fixture(t);const edits=[
    p=>p.productId='iclub_202609',p=>p.campaignKeyType='official',p=>p.promotionCode=SEOUL_SHILLA.key,p=>p.propertyId='4819071',p=>p.sales={end:'2026-09-30'},p=>p.stay={end:'2026-09-30'},p=>p.checkedAt='2026-09-21T08:19:00Z',p=>p.bookingStatus='confirmed',p=>p.availability='available',p=>p.personalCouponIssued=true,p=>p.confirmationStatus='instant',p=>p.couponStacking='allowed',p=>p.couponStayWindow='2026-09',p=>p.payablePriceKrw=565980,
    p=>p.datedOffers.reverse(),p=>p.datedOffers.pop(),p=>p.datedOffers[0].roomId='225979239',p=>p.datedOffers[0].rateOptionId+='other',p=>p.datedOffers[0].checkIn='2026-09-27',p=>p.datedOffers[0].adults=1,p=>p.datedOffers[0].children=1,p=>p.datedOffers[0].rooms=2,p=>p.datedOffers[0].nights=2,p=>p.datedOffers[0].couponApplication='not_applied',p=>p.datedOffers[0].displayedTotalKrw-=30000,p=>p.datedOffers[0].totalTaxIncluded=false,p=>p.datedOffers[0].normalRoomChargeKrw=565980,p=>p.datedOffers[0].taxAndFeesKrw=0,p=>p.datedOffers[0].cancellation.type='free_until',p=>p.datedOffers[1].cancellation.freeUntilKst='2026-09-27T18:00:00Z',p=>p.datedOffers[3].benefits.loungeIncluded=true,
    p=>p.coupons[1].minimumSpendDisplayKrw=550000,p=>p.coupons[1].minimumSpendDescriptionKrw=550000,p=>p.coupons[1].minimumSpendStatus='verified',p=>p.coupons[0].perIdIssueLimit=4,p=>p.coupons[0].issueLimitScope='whole_campaign',p=>p.coupons[0].stacking='allowed',p=>p.coupons[0].expireDate='2026-09-30T14:59:59Z',p=>p.coupons[0].deadlinePrecision='second',p=>p.coupons[0].isPublishable=false,p=>p.urbanPackage.excludedStayDates=[],p=>p.urbanPackage.salesEnd='2026-09-30',p=>p.propertyEvidence.url+='&adultCount=2',p=>p.couponEvidence.url=p.couponEvidence.url.replace('2680667','4819071'),p=>p.linkVerification.checkedAt='2026-09-21T08:00:00Z',
  ];
  for(const [i,edit] of edits.entries()){const p=structuredClone(job.commercialSnapshot);edit(p);assert.equal(evaluateSeoulShillaSnapshot(p,{now}).passed,false,`mutation ${i}`);}
});

test('valid replacement hashes cannot mask altered original coupons, room/rate dates, price units or cancellation',async t=>{
  const {job,bytes}=await fixture(t),p=job.commercialSnapshot;
  const check=async(kind,edit)=>{
    const next=structuredClone(p),record=kind==='primary'?next.propertyEvidence:kind==='coupon'?next.couponEvidence:{evidenceFile:next.datedOffers[0].evidenceFile,sha256:next.datedOffers[0].evidenceSha256},file=record.evidenceFile;
    const raw=JSON.parse(bytes.get(file));edit(raw);const changed=Buffer.from(JSON.stringify(raw)),hash=sha256(changed);
    if(kind==='quote')for(const q of next.datedOffers)q.evidenceSha256=hash;else record.sha256=hash;
    const manifest=JSON.parse(bytes.get(p.evidenceFile));manifest.find(r=>r.file===file).sha256=hash;const manifestBytes=Buffer.from(JSON.stringify(manifest));next.evidenceSha256=sha256(manifestBytes);
    const result=await verifySeoulShillaEvidence(next,{read:async(f,h)=>{const b=f===file?changed:f===p.evidenceFile?manifestBytes:bytes.get(f);assert.equal(sha256(b),h);return b;}});
    assert.equal(result.checks.shillaFetchReceiptsMatch,true);assert.equal(result.passed,false,kind);
  };
  const card=r=>r.data.sections[0].gridCards[0],opt=r=>card(r).bestOptions[0];
  for(const edit of [r=>r.data.sections[0].header.startDate='2026-09-27',r=>r.data.sections[0].header.persons.adultCount=5,r=>card(r).header.roomId=1,r=>opt(r).gid=4819071,r=>opt(r).rateOptionId+='other',r=>opt(r).couponTemplateId='36286',r=>opt(r).startDateTime='2026-09-28T14:00:00',r=>opt(r).priceDetail.prices[0].title='객실 2개 x 1박',r=>opt(r).priceDetail.prices[1].subPrices[0].title='회원 할인',r=>opt(r).priceDetail.prices[1].krwPrice='-50,000원',r=>opt(r).priceDetail.prices[2].krwPrice='535,980원',r=>opt(r).salePrice=565980,r=>opt(r).price.taxIncludedText='세금 별도 565,980원',r=>opt(r).attributions[0].title='무료 취소',r=>opt(r).optionAllAttributes.contents[0].items[1].items=['판매 기간은 9월30일까지']])await check('quote',edit);
  for(const edit of [r=>r.data[1].condition[0]='550,000원 이상 구매 시',r=>r.data[1].description=r.data[1].description.replace('55원','550000원'),r=>r.data[0].flatAmount=120000,r=>r.data[0].expireDate='2026-09-30T14:59:59Z',r=>r.data[0].isRepeatable=true,r=>r.data[0].isUsable=false,r=>r.data[0].couponUseStatus='USED',r=>r.data[0].description=r.data[0].description.replace('한 ID당 1매','한 행사당 1매'),r=>r.data.push(r.data[0])])await check('coupon',edit);
  for(const edit of [r=>r.data.staticArea.metaInfo.gid=4819071,r=>r.data.staticArea.header.stayTitle='다른 호텔',r=>r.data.staticArea.staySearchParam.childCount=1,r=>r.data.staticArea.header.shareWebLink+='&childCount=1'])await check('primary',edit);
});

test('Shilla cannot bypass independent review, native render, distinct four images, captions or external-link exclusion',async t=>{
  const {dir,job}=await fixture(t);
  for(const edit of [j=>j.publicationBundle.qualityReview.provenance.reviewerExecutionId=j.publicationBundle.authorExecutionId,j=>j.publicationBundle.renderReviews.mobile.presentationChecks.imagesLoaded=false,j=>j.publicationBundle.claimLedger.claims[0].support='uncertain',j=>j.publicationBundle.document.blocks[5].role='other',j=>j.publicationBundle.document.blocks[8].sha256=j.publicationBundle.document.blocks[5].sha256,j=>j.publicationBundle.document.blocks[6].text='공식 사진입니다.',j=>j.publicationBundle.document.blocks.push({type:'paragraph',text:'55만원 이상 구매하면 5만원 할인됩니다.',claimClass:'factual',claimIds:['coupons']}),j=>j.publicationBundle.document.blocks.push({type:'link',label:'출처',url:'https://www.myrealtrip.com'})]){
    const next=structuredClone(job);edit(next);bind(next);assert.equal((await evaluatePublisherJobGate(next,{baseDir:dir,now})).passed,false);
  }
  const next=structuredClone(job.publicationBundle);next.document.blocks[4].text='5만원 쿠폰은 55만원 이상 구매 시 적용됩니다.';assert.equal(seoulShillaLayoutChecks(next).shillaCouponConflictVisible,false);
});

test('Shilla exact public readback binds the single top clickable banner and all displayed amounts',async t=>{
  const {job}=await fixture(t),units=renderUnits(job.publicationBundle.document),logNo='224499999999';
  const observed={source:'independent_http',httpStatus:200,smartEditorBodyPresent:true,targetIdentityVerified:true,blogId:job.blogId,logNo,title:job.title,tags:job.publishSettings.tags,tagsObserved:true,links:[job.affiliate.url],units,checkedAt:now.toISOString()};
  assert.equal(evaluateExactReadback(job,observed,{now,createdLogNo:logNo}).passed,true);
  for(const edit of [o=>delete o.units[1].href,o=>o.units[1].href='https://myrealt.rip/wrong',o=>o.units.splice(1,1),o=>o.units.find(u=>u.value.includes('565,980')).value+=' 535,980원']){const next=structuredClone(observed);edit(next);assert.equal(evaluateExactReadback(job,next,{now,createdLogNo:logNo}).passed,false);}
});

test('Shilla research builder preserves originals and blocks bad source bytes, silent conflict correction and ownership',async t=>{
  const {dir,research,ledger,links,journal,fetchImpl}=await fixture(t),original=JSON.stringify({research,ledger,links});
  const built=await buildSeoulShillaResearchArtifacts({baseDir:dir,research,ledger,links,journal,fetchImpl,now});assert.equal(JSON.stringify({research,ledger,links}),original);assert.deepEqual(built.claimLedger.claims.map(c=>c.text),ledger.claims.map(c=>c.text));assert.deepEqual(built.claimLedger.evidence,ledger.evidence);
  for(const edit of [x=>x.links.shilla.ownerVerified=false,x=>x.research.evidence.quote.sha256='a'.repeat(64),x=>x.research.evidence.quote.evidenceFile='../outside.json',x=>x.research.evidence.quote.checkedAt='2026-09-20T09:00:00Z',x=>x.research.quotes[0].displayedTotalKrw-=30000,x=>x.research.coupons[1].minimumSpendDescriptionKrw=550000,x=>x.research.coupons[1].minimumSpendStatus='verified',x=>x.ledger.evidence.coupons.sha256='a'.repeat(64),x=>x.ledger.claims[0].expiresAt='2026-09-21T12:00:00Z',x=>x.ledger.claims[0].support='uncertain']){const data=structuredClone({research,ledger,links});edit(data);let calls=0;await assert.rejects(buildSeoulShillaResearchArtifacts({baseDir:dir,...data,journal,now,fetchImpl:(...args)=>{calls++;return fetchImpl(...args);}}));assert.equal(calls,0);}
});

test('observed Shilla property promotion 28146 remains metadata and must match the bound fresh source',async t=>{
  const {job,bytes}=await fixture(t),original=job.commercialSnapshot;
  for(const [rawId,snapshotId,expected] of [[null,undefined,true],[28146,28146,true],[28146,undefined,false],[null,28146,false],[28147,28147,false],['28146',28146,false]]){
    const p=structuredClone(original);if(snapshotId!==undefined)p.propertyPromotionId=snapshotId;
    const file=p.propertyEvidence.evidenceFile,raw=JSON.parse(bytes.get(file));raw.data.staticArea.promotionId=rawId;
    const changed=Buffer.from(JSON.stringify(raw));p.propertyEvidence.sha256=sha256(changed);
    const manifest=JSON.parse(bytes.get(p.evidenceFile));manifest.find(r=>r.file===file).sha256=p.propertyEvidence.sha256;
    const manifestBytes=Buffer.from(JSON.stringify(manifest));p.evidenceSha256=sha256(manifestBytes);
    const report=await verifySeoulShillaEvidence(p,{read:async(f,h)=>{const b=f===file?changed:f===p.evidenceFile?manifestBytes:bytes.get(f);assert.equal(sha256(b),h);return b;}});
    assert.equal(report.checks.shillaPropertySourceMatches,expected,`${rawId}/${snapshotId}`);
    assert.equal(p.promotionCode,null);assert.equal(p.productUrl,seoulShillaProductUrl());
  }
});
