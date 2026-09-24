import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateTravelSnapshot,evaluateTravelAffiliate,verifyTravelAffiliate,MYREALTRIP_ACCOUNTS} from '../scripts/gates/travel-planning-contract.mjs';
import {compileEditorModel,inspectEditorModel} from '../scripts/api/editor-model.mjs';
import {parsePublicDocument} from '../scripts/api/public-document.mjs';
import {renderUnits} from '../scripts/gates/publication-document.mjs';
const now=new Date('2026-09-21T04:00:00Z'),at=now.toISOString(),account=MYREALTRIP_ACCOUNTS.aicandoanything;
function fixture(){
 const url='https://myrealt.rip/example';
 const p={schemaVersion:1,provider:'myrealtrip',checkedAt:at,productId:'123',productUrl:'https://experiences.myrealtrip.com/products/123',productTitle:'Example tour',seller:'Fixture seller',variant:'Morning request',variantId:'morning',travelDate:'2026-11-09',quantity:2,bookingStatus:'unconfirmed',dateAvailability:'unverified',quoteType:'listing_guide_fee',listedGuideFeeKrw:65000,additionalCosts:'verify_for_travel_date',conditions:'Listing only; no dated quote.',affiliateUrl:url,linkVerification:{passed:true,targetMatches:true,checkedAt:at},evidenceFile:'fixture.html',evidenceSha256:'a'.repeat(64),credentialsPersisted:false};
 const blocks=[{type:'notice',text:'제휴 수수료 안내'},{type:'image',href:url,role:'affiliate_banner'}];
 const a={provider:'myrealtrip',url,accountFingerprint:account,mylinkId:'456',creationJournalKey:'b'.repeat(64),verification:{source:'independent_http_redirect',checkedAt:at,status:301,bridgeStatus:200,url,productId:'123',mylinkId:'456',accountFingerprint:account}};
 const receipt={operation:'myrealtripCreateLink',state:'verified',receipt:{source:'independent_http',status:200,ownerVerified:true,accountFingerprint:account,targetUrl:p.productUrl,data:{id:456,mylink:url}}};
 return {job:{blogId:'aicandoanything',target:{type:'update',logNo:'123456789'},commercialSnapshot:p,affiliate:a,bodyBlocks:blocks,publicationBundle:{format:'travel_itinerary',document:{blocks}}},receipt};
}
test('travel snapshot accepts explicit unconfirmed dated plan, not invented checkout facts',()=>{
 const {job}=fixture();assert.equal(evaluateTravelSnapshot(job.commercialSnapshot,{now}).passed,true);
 for(const edit of [p=>p.payablePriceKrw=130000,p=>p.stockState='in_stock',p=>p.dateAvailability='available',p=>p.bookingStatus='confirmed',p=>p.checkedAt='2026-09-20T00:00:00Z',p=>p.productUrl='https://other.example/products/123']){
  const p=structuredClone(job.commercialSnapshot);edit(p);assert.equal(evaluateTravelSnapshot(p,{now}).passed,false);
 }
});
for(const [name,edit] of [
 ['plain text affiliate',j=>j.bodyBlocks[1]={type:'link',url:j.affiliate.url}],
 ['banner below body',j=>j.bodyBlocks.unshift({type:'paragraph',text:'Introduction'})],
 ['wrong banner URL',j=>j.bodyBlocks[1].href='https://myrealt.rip/wrong'],
 ['additional affiliate link',j=>j.bodyBlocks.push({type:'link',url:j.affiliate.url})],
 ['stale redirect',j=>j.affiliate.verification.checkedAt='2026-09-20T00:00:00Z'],
 ['missing ownership journal',j=>delete j.affiliate.creationJournalKey],
 ['unverified create operation',j=>j.target.type='create'],
])test(`${name} rejected before any affiliate request`,async()=>{
 const {job,receipt}=fixture();edit(job);let calls=0;
 assert.equal(evaluateTravelAffiliate(job,{now}).passed,false);
 assert.equal((await verifyTravelAffiliate(job,{now,journal:{read:async()=>receipt},fetchImpl:async()=>{calls++;}})).passed,false);assert.equal(calls,0);
});
test('verified own creation receipt and bounded first-party bridge are required',async()=>{
 const {job,receipt}=fixture();let calls=0;
 const target='https://experiences.myrealtrip.com/products/123?utm_source=mktpartner&mylink_id=456&t_scope=604800';
 const bridge='https://www.myrealtrip.com/main/bridge/marketing?return_url='+encodeURIComponent(target);
 const fetchImpl=async(url,init)=>{calls++;assert.equal(init.redirect,'manual');assert.equal(init.credentials,'omit');assert.equal(new Headers(init.headers).has('cookie'),false);return new Response('',{status:url===job.affiliate.url?301:200,headers:url===job.affiliate.url?{location:bridge}:{}});};
 assert.equal((await verifyTravelAffiliate(job,{now,journal:{read:async()=>receipt},fetchImpl})).passed,true);assert.equal(calls,2);
 for(const mutation of [r=>r.state='submitted_unknown',r=>r.receipt.accountFingerprint='c'.repeat(64),r=>r.receipt.data.id=999]){const r=structuredClone(receipt);mutation(r);calls=0;assert.equal((await verifyTravelAffiliate(job,{now,journal:{read:async()=>r},fetchImpl})).passed,false);assert.equal(calls,0);}
 for(const location of [bridge.replace('www.myrealtrip.com','evil.example'),bridge.replace(encodeURIComponent(target),encodeURIComponent(target.replace('mylink_id=456','mylink_id=999'))),bridge+'&return_url='+encodeURIComponent(target)]){calls=0;assert.equal((await verifyTravelAffiliate(job,{now,journal:{read:async()=>receipt},fetchImpl:async()=>{calls++;return new Response('',{status:301,headers:{location}})}})).passed,false);assert.equal(calls,1);}
});
test('image URL is retained by model and exact public readback; wrong href cannot be hidden by identical image',()=>{
 const para=v=>[{'@ctype':'paragraph',nodes:[{'@ctype':'textNode',value:v}]}];
 const fresh={document:{components:[{'@ctype':'documentTitle',title:para('A title')},{'@ctype':'image',src:'https://blogfiles.pstatic.net/x/banner.png'}]}};
 const d={title:'A title',blocks:[{type:'image',publishedUrl:'https://blogfiles.pstatic.net/x/banner.png',href:'https://myrealt.rip/example'}]};
 const model=compileEditorModel(fresh,d);assert.equal(model.document.components[1].link,d.blocks[0].href);assert.deepEqual(inspectEditorModel(model).units,renderUnits(d));
 const html=href=>`<meta property="og:url" content="https://blog.naver.com/aicandoanything/123456789"><meta property="og:title" content="A title"><div id="post-view123456789"><div class="se-main-container"><div class="se-component se-image"><a href="${href}"><img src="https://blogfiles.pstatic.net/x/banner.png"></a></div></div></div>`;
 const parse=h=>parsePublicDocument(h,{url:'https://blog.naver.com/PostView.naver?blogId=aicandoanything&logNo=123456789'}).units;
 assert.deepEqual(parse(html(d.blocks[0].href)),renderUnits(d));assert.notDeepEqual(parse(html('https://myrealt.rip/wrong')),renderUnits(d));
 assert.throws(()=>compileEditorModel(fresh,{...d,blocks:[{...d.blocks[0],href:'javascript:alert(1)'}]}),/INVALID_CLICKABLE_LINK/);
 const noLink=compileEditorModel(model,{...d,blocks:[{type:'image',publishedUrl:d.blocks[0].publishedUrl}]});assert.equal(noLink.document.components[1].link,null);
});
