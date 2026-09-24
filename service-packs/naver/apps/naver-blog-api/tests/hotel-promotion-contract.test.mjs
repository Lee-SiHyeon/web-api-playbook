import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {hotelPromotionFixture,HOTEL_NOW as now} from './support/hotel-promotion-fixture.mjs';
import {bind} from './support/publication-fixture.mjs';
import {HOTEL_PROMOTION,evaluateHotelPromotionSnapshot,evaluateHotelPromotionAffiliate,verifyHotelPromotionAffiliate,verifyHotelPromotionEvidence} from '../scripts/gates/hotel-promotion-contract.mjs';
import {evaluateCommercialSnapshot} from '../scripts/gates/commercial-snapshot-gates.mjs';
import {evaluateAffiliateLinkGate,verifyAffiliateRedirect} from '../scripts/gates/affiliate-link-gate.mjs';
import {evaluatePublisherJobGate} from '../scripts/gates/publisher-gates.mjs';
import {evaluateExactReadback} from '../scripts/gates/publication-review-gates.mjs';
import {renderUnits,sha256} from '../scripts/gates/publication-document.mjs';

async function fixture(t){const dir=await mkdtemp(path.join(os.tmpdir(),'hotel-promotion-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));return {dir,...await hotelPromotionFixture(dir)};}
test('hotel promotion passes the full create job gate without relaxing claim, review, image or SDK checks',async t=>{
  const {dir,job}=await fixture(t);assert.equal(evaluateCommercialSnapshot(job.commercialSnapshot,{now}).passed,true);
  const gate=await evaluatePublisherJobGate(job,{baseDir:dir,now});assert.equal(gate.passed,true,JSON.stringify(gate.details?.publicationReview?.failedChecks||gate.failedChecks));
  assert.equal(gate.details.publicationReview.independentEditorialReviewVerified,true);assert.equal(gate.details.artifacts.passed,true);
});
test('hotel promotion permits only its known campaign post update with matching owner, document and fresh update preflight',async t=>{
  const {dir,job}=await fixture(t);
  job.target={type:'update',logNo:HOTEL_PROMOTION.existingPosts[job.blogId]};
  job.inputProvider='http_only';job.publicationBundle.document.logNo=job.target.logNo;
  job.publicationBundle.collision.decision='update';job.preflight.kind='independent_http_update_preflight';
  job.publishSettings.searchAllowed=true;bind(job);
  const gate=await evaluatePublisherJobGate(job,{baseDir:dir,now});assert.equal(gate.passed,true,JSON.stringify(gate.failedChecks));
  for(const edit of [j=>j.target.logNo='224418405166',j=>j.publicationBundle.document.logNo='224418405166',j=>j.publicationBundle.document.blogId='otherblog',j=>j.blogId='otherblog',j=>j.preflight.kind='headless_input_http_create_preflight',j=>j.preflight.checkedAt='2026-09-21T02:00:00Z',j=>delete j.preflight.sourceDocumentFingerprint,j=>j.commercialSnapshot.productId='different_campaign']){
    const next=structuredClone(job);edit(next);assert.equal(evaluateHotelPromotionAffiliate(next,{now}).passed,false);
  }
  const missingImages=structuredClone(job);missingImages.publicationBundle.document.blocks=missingImages.publicationBundle.document.blocks.filter(b=>b.type!=='image');bind(missingImages);
  assert.equal((await evaluatePublisherJobGate(missingImages,{baseDir:dir,now})).passed,false);
  const selfReview=structuredClone(job);selfReview.publicationBundle.qualityReview.reviewerRole='author_self_review';bind(selfReview);
  assert.equal((await evaluatePublisherJobGate(selfReview,{baseDir:dir,now})).passed,false);
});
test('snapshot rejects travel relabeling, checkout assertions, mixed packages and stale or mis-scoped date prices',async t=>{
  const {job}=await fixture(t),base=job.commercialSnapshot;
  for(const edit of [
    p=>p.productUrl='https://experiences.myrealtrip.com/products/5569868',p=>p.productId='another_campaign',
    p=>p.payablePriceKrw=130760,p=>p.availability='available',p=>p.bookingStatus='confirmed',p=>p.stockState='in_stock',
    p=>p.packages[0].benefits.push('breakfast_2'),p=>p.packages[0].advertisedAfterCouponKrw-=1,
    p=>p.packages[1]=structuredClone(p.packages[0]),p=>p.packages=[null],p=>delete p.coupon,
    p=>p.coupon.redemptionVerified=true,p=>p.coupon.stacking='stacked',p=>p.coupon.checkInEnd='2026-11-31',
    p=>p.checkedAt='2026-09-20T00:00:00Z',p=>p.checkedAt='2026-09-21T05:00:00Z',
    p=>p.sales.endsAt=now.toISOString(),p=>p.datedQuotes[0].checkedAt='2026-09-20T00:00:00Z',
    p=>p.datedQuotes[0].sourceUrl+='&gid=999',p=>p.datedQuotes[0].propertyId='999',
    p=>p.datedQuotes[0].couponApplied=true,p=>p.datedQuotes[0].taxIncluded=false,
    p=>p.datedQuotes[0].checkOut='2026-11-05',p=>p.datedQuotes=[null],
  ]){const p=structuredClone(base);edit(p);assert.equal(evaluateHotelPromotionSnapshot(p,{now}).passed,false);}
});
test('raw evidence must match the exact campaign, date, room, tax-inclusive price and official image source',async t=>{
  const {dir,job}=await fixture(t),p=job.commercialSnapshot;
  const read=async(file,hash)=>{const data=await readFile(path.join(dir,file));assert.equal(sha256(data),hash);return data;};
  assert.equal((await verifyHotelPromotionEvidence(p,{read})).passed,true);
  for(const edit of [d=>d.result.status=403,d=>d.data.sections[0].header.startDate='2026-11-04',d=>d.data.sections[0].header.endDate='2026-11-05',d=>d.data.sections[0].header.persons.adultCount=3,d=>d.data.sections[0].header.persons.childCount=1,d=>d.data.sections[0].gridCards[0].bestOptions[0].gid=5602483,d=>d.data.sections[0].gridCards[0].bestOptions[0].startDateTime='2026-11-04T15:00:00',d=>d.data.sections[0].gridCards[0].bestOptions[0].endDateTime='2026-11-05T11:00:00',d=>d.data.sections[0].gridCards[0].bestOptions[0].priceDetail.roomName='other room',d=>d.data.sections[0].gridCards[0].bestOptions[0].priceDetail.prices[0].title='객실 2개 x 1박',d=>d.data.sections[0].gridCards[0].bestOptions[0].priceDetail.prices[1].krwPrice='1원']){
    const next=structuredClone(p),raw=JSON.parse(await readFile(path.join(dir,p.datedQuotes[0].evidenceFile),'utf8'));edit(raw);
    const bytes=Buffer.from(JSON.stringify(raw));await writeFile(path.join(dir,'tampered-quote.json'),bytes);next.datedQuotes[0].evidenceFile='tampered-quote.json';next.datedQuotes[0].evidenceSha256=sha256(bytes);
    assert.equal((await verifyHotelPromotionEvidence(next,{read})).passed,false);
  }
  const wrongImage=structuredClone(p);wrongImage.packages[0].evidence.url='https://evil.example/image.png';assert.equal((await verifyHotelPromotionEvidence(wrongImage,{read})).passed,false);
  const wrongCampaign=structuredClone(p),data=JSON.parse(await readFile(path.join(dir,p.evidenceFile),'utf8'));data.code='another_campaign';const bytes=Buffer.from(JSON.stringify(data));await writeFile(path.join(dir,'another.json'),bytes);wrongCampaign.evidenceFile='another.json';wrongCampaign.evidenceSha256=sha256(bytes);assert.equal((await verifyHotelPromotionEvidence(wrongCampaign,{read})).passed,false);
});
test('format cannot bypass images, independent editorial review, claims, native renders or fingerprints',async t=>{
  const {dir,job}=await fixture(t);
  for(const edit of [
    j=>{j.publicationBundle.document.blocks=j.publicationBundle.document.blocks.filter(b=>b.type!=='image');j.minImageCount=0;j.minImageComponents=0;},
    j=>j.publicationBundle.document.blocks[4].role='other',j=>j.publicationBundle.qualityReview.provenance.reviewerExecutionId=j.publicationBundle.authorExecutionId,
    j=>j.publicationBundle.qualityReview.reviewerRole='author_self_review',j=>j.publicationBundle.renderReviews.mobile.presentationChecks.imagesLoaded=false,
    j=>j.publicationBundle.document.blocks[6].text='쿠폰 조건을 확인하세요.',j=>j.publicationBundle.document.blocks[9].text='날짜별 실제 금액은 차이가 있습니다.',
    j=>j.publicationBundle.claimLedger.claims[0].support='uncertain',j=>j.publicationBundle.claimLedger.claims[0].expiresAt='2026-09-20T00:00:00Z',
    j=>j.inputProvider='http_only',j=>j.publicationBundle.format='travel_itinerary',
  ]){const next=structuredClone(job);edit(next);bind(next);assert.equal((await evaluatePublisherJobGate(next,{baseDir:dir,now})).passed,false);}
  const next=structuredClone(job);bind(next);next.bodyBlocks[3].text+=' changed';assert.equal((await evaluatePublisherJobGate(next,{baseDir:dir,now})).passed,false);
});
test('banner, provider format and own creation journal are required before any redirect GET',async t=>{
  const {job,receipt}=await fixture(t);
  assert.equal(evaluateAffiliateLinkGate(job,{now}).passed,true);
  for(const edit of [j=>j.bodyBlocks[1]={type:'link',url:j.affiliate.url},j=>j.bodyBlocks.unshift({type:'paragraph',text:'Introduction'}),j=>j.bodyBlocks.push({type:'link',url:j.affiliate.url}),j=>j.bodyBlocks[1].href='https://myrealt.rip/wrong',j=>j.target.type='update',j=>j.publicationBundle.format='travel_itinerary',j=>delete j.affiliate.creationJournalKey,j=>j.affiliate.verification.checkedAt='2026-09-20T00:00:00Z']){
    const next=structuredClone(job);edit(next);let calls=0;assert.equal(evaluateHotelPromotionAffiliate(next,{now}).passed,false);
    assert.equal((await verifyHotelPromotionAffiliate(next,{now,journal:{read:async()=>receipt},fetchImpl:async()=>{calls++;}})).passed,false);assert.equal(calls,0);
  }
});
test('live public check follows only the observed exact promotion bridge with own attribution',async t=>{
  const {job,receipt,bridge,target}=await fixture(t);let calls=0;
  const fetchImpl=async(url,init)=>{calls++;assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');assert.equal(init.credentials,'omit');assert.equal(new Headers(init.headers).has('cookie'),false);assert.equal(new Headers(init.headers).has('authorization'),false);return new Response('',{status:url===job.affiliate.url?301:200,headers:{'content-type':'text/html',...(url===job.affiliate.url?{location:bridge}:{})}});};
  assert.equal((await verifyAffiliateRedirect(job,{now,journal:{read:async()=>receipt},fetchImpl})).passed,true);assert.equal(calls,2);
  for(const edit of [r=>r.state='submitted_unknown',r=>r.operation='anotherOperation',r=>r.receipt.ownerVerified=false,r=>r.receipt.accountFingerprint='f'.repeat(64),r=>r.receipt.targetUrl='https://www.myrealtrip.com/promotions/202609_MONOGRAM',r=>r.receipt.data.id=999]){
    const bad=structuredClone(receipt);edit(bad);calls=0;assert.equal((await verifyHotelPromotionAffiliate(job,{now,journal:{read:async()=>bad},fetchImpl})).passed,false);assert.equal(calls,0);
  }
  const targets=[target.replace('myrealtrip.com','evil.example'),target.replace('202609_MONOGRAM','another_campaign'),target.replace('mylink_id=12345','mylink_id=999'),target+'&mylink_id=12345',target+'&utm_source=mktpartner',target.replace('t_scope=604800','t_scope=1'),target+'&redirect=https://evil.example',target+'#fragment'];
  const locations=[bridge.replace('www.myrealtrip.com','evil.example'),bridge+'&return_url='+encodeURIComponent(target),...targets.map(x=>'https://www.myrealtrip.com/main/bridge/marketing?return_url='+encodeURIComponent(x))];
  for(const location of locations){calls=0;const badFetch=async()=>{calls++;return new Response('',{status:301,headers:{location}});};assert.equal((await verifyHotelPromotionAffiliate(job,{now,journal:{read:async()=>receipt},fetchImpl:badFetch})).passed,false);assert.equal(calls,1);}
  for(const [status,mime] of [[503,'text/html'],[200,'application/json']]){const badFetch=async u=>new Response('',{status:u===job.affiliate.url?301:status,headers:u===job.affiliate.url?{location:bridge}:{'content-type':mime}});assert.equal((await verifyHotelPromotionAffiliate(job,{now,journal:{read:async()=>receipt},fetchImpl:badFetch})).passed,false);}
});
test('create readback binds returned post ID, ordered image hrefs and exact text',async t=>{
  const {job}=await fixture(t),units=renderUnits(job.publicationBundle.document),id='123456789';
  const observation={source:'independent_http',httpStatus:200,smartEditorBodyPresent:true,targetIdentityVerified:true,blogId:job.blogId,logNo:id,title:job.title,tags:job.publishSettings.tags,tagsObserved:true,links:[job.affiliate.url],units,checkedAt:now.toISOString()};
  assert.equal(evaluateExactReadback(job,observation,{now,createdLogNo:id}).passed,true);
  for(const edit of [o=>o.units[1].href='https://myrealt.rip/wrong',o=>o.units.splice(1,1),o=>o.units[3].value+='wrong price',o=>o.logNo='987654321']){const next=structuredClone(observation);edit(next);assert.equal(evaluateExactReadback(job,next,{now,createdLogNo:id}).passed,false);}
});
