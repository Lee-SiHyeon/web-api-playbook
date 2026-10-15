import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {projectCoupangTravel} from '../lib/retail/coupang-ontology.mjs';
import {coupangCoverage} from '../lib/retail/coupang-frontier.mjs';
const root=new URL('../',import.meta.url),dir='verification/coupang-discovery-2026-10-15/';
const read=async file=>JSON.parse(await readFile(new URL(file,root),'utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const specs=[
 ['categories-live.json','category_tree',3228],['travel-autocomplete-live.json','travel_autocomplete',null],
 ['travel-page2-live.json','travel_listing',24],['travel-rental-live.json','travel_listing',25],
 ['travel-rooms-live.json','travel_rooms',5],['travel-ticket-options-live.json','travel_ticket_options',3],
 ['travel-ticket-reviews-live.json','travel_reviews',5],['travel-ticket-detail-live.json','travel_detail',null],
 ['travel-rental-detail-context-live.json','travel_detail',null],
];
const records=[],projections=[];
for(const [file,kind,count]of specs){
 const run=await read(dir+file);assert.equal(run.ok,true);assert.equal(run.executionMode,'pure_http');assert.equal(run.browserUsed,false);
 assert.equal(run.credentialsUsed,false);assert.equal(run.writesSubmitted,0);assert.equal(run.request.httpStatus,200);assert.equal(run.request.cookieSent,false);
 assert.equal(run.data.kind,kind);assert.equal(run.projectionSha256,hash(JSON.stringify(run.data)));
 const rows=run.data.nodes??run.data.products??run.data.rooms??run.data.options??run.data.reviews;
 if(count!==null)assert.equal(rows.length,count);
 if(file==='travel-page2-live.json')assert.equal(run.data.pagination.page,2);
 if(file==='travel-rental-live.json')assert.equal(run.data.query.rentalCar.displayCategoryCode,'32618');
 if(file==='travel-rental-detail-context-live.json'){
   assert.equal(run.data.context.pickUpDate,'2026-10-22');assert.equal(run.data.representativeOption.name,'자차불포함');
   assert.equal(run.data.representativeOption.allOptionsVerified,false);assert.equal(run.data.price.salePrice,89010);
 }
 const projected=kind.startsWith('travel_')&&!['travel_autocomplete','travel_gateway'].includes(kind)?projectCoupangTravel(run):null;
 if(projected)projections.push({input:dir+file,...projected});
 records.push({file:dir+file,kind,count:rows?.length??null,states:run.states,httpStatus:run.request.httpStatus,
  checkedAt:run.checkedAt,sha256:hash(await readFile(new URL(dir+file,root)))});
}
const frontier=await read(dir+'resource-frontier.json');
const crawlFiles=(await readdir(new URL(dir+'crawl/',root))).filter(x=>x.endsWith('.json'));
const crawl={receipts:crawlFiles.length,ok:0,failed:0,listingPages:0,detailDocuments:0,optionReads:0,reviewReads:0};
const crawlProjections=[];
for(const file of crawlFiles){const run=await read(dir+'crawl/'+file);if(!run.ok){crawl.failed++;continue}
 assert.equal(run.request.httpStatus,200);assert.equal(run.browserUsed,false);assert.equal(run.projectionSha256,hash(JSON.stringify(run.data)));crawl.ok++;
 if(run.data.kind==='travel_listing')crawl.listingPages++;
 if(run.data.kind==='travel_detail')crawl.detailDocuments++;
 if(['travel_rooms','travel_ticket_options'].includes(run.data.kind))crawl.optionReads++;
 if(run.data.kind==='travel_reviews')crawl.reviewReads++;
 if(['travel_listing','travel_detail','travel_rooms','travel_ticket_options','travel_reviews'].includes(run.data.kind))
   crawlProjections.push({input:dir+'crawl/'+file,...projectCoupangTravel(run)});
}
const blocked=[];
for(const file of ['retail-search-live.json','retail-category-live.json']){
 const run=await read(dir+file);assert.equal(run.ok,false);assert.equal(run.request.httpStatus,403);assert.equal(run.states.live_replay,false);
 blocked.push({file:dir+file,checkedAt:run.checkedAt,httpStatus:403,mode:'cookie_free',cause:'unknown',protectedSessionReplay:'unverified'});
}
const visitor=await read(dir+'retail-visitor-live.json');
assert.equal(visitor.visitorContextCount,1);assert.equal(visitor.rebootstrapAllowed,false);
assert.equal(visitor.runs[0].receipt.visitorBootstrap.status,200);assert.equal(visitor.runs[0].receipt.status,200);
assert.equal(visitor.runs[0].selectedOffer.price.amount,13200);assert.equal(visitor.runs[1].receipt.httpStatus,403);
assert.equal(visitor.runs[1].receipt.cookieSent,true);assert.equal(visitor.runs[1].receipt.visitorBootstrap,null);
const diagnostic=await read(dir+'retail-403-variants-live.json');
assert.equal(diagnostic.nativeNetwork,true);assert.equal(diagnostic.bootstrapRequests,1);assert.equal(diagnostic.identityPreserved,true);
assert.equal(diagnostic.runs.length,9);assert.equal(diagnostic.stopped,null);
for(const name of ['offer_control_before','offer_control_after']) {
 const row=diagnostic.runs.find(x=>x.name===name);assert.equal(row.ok,true);assert.equal(row.receipt.status,200);assert.equal(row.price.amount,13200);
}
for(const row of diagnostic.runs.filter(x=>!x.ok)){assert.equal(row.receipt.httpStatus??row.receipt.status,403);}
const rscCapture=await read(dir+'retail-rsc-capture.json');
assert.equal(rscCapture.response.status,200);assert.equal(rscCapture.response.mime,'text/x-component');
assert.equal(rscCapture.projection.mainListProducts,60);assert.equal(rscCapture.projection.exactIdentityAndTitleMatches,60);
assert.equal(rscCapture.projection.maintainedParserReadFullCapturedBody,true);
assert.equal(rscCapture.projection.maintainedParserCount,60);assert.equal(rscCapture.projection.maintainedParserExactDomMatches,60);
const rscReplays=[];
for(const file of ['retail-rsc-anonymous-replay.json','retail-rsc-visitor-replay.json']){
 const run=await read(dir+file);assert.equal(run.ok,false);assert.equal(run.receipt.status,403);assert.equal(run.receipt.server,'AkamaiGHost');
 assert.equal(run.states.live_replay,false);rscReplays.push({file:dir+file,mode:run.receipt.authenticationMode,status:403,cookieSent:run.receipt.cookieSent});
}
const cookieComparison=await read(dir+'retail-browser-cookie-comparison-live.json');
assert.equal(cookieComparison.browserResponse.status,200);assert.equal(cookieComparison.runs.length,3);
assert.deepEqual(cookieComparison.runs.map(r=>r.receipt.status),[403,403,200]);
assert.deepEqual(cookieComparison.runs.map(r=>r.receipt.cookieNames.length),[3,11,33]);
assert.equal(cookieComparison.cookieValuesPersisted,false);assert.equal(cookieComparison.visitorBootstraps,0);
assert.equal(cookieComparison.browserUsedForTransport,false);assert.equal(cookieComparison.nonCookieHeadersChanged,false);
for(const row of cookieComparison.runs){assert.equal(row.requestCount,1);assert.equal(row.exactCookieHeaderSent,true);assert.equal(row.states.credential_propagated,true);}
const fullCookieRead=cookieComparison.runs[2];
assert.equal(fullCookieRead.ok,true);assert.equal(fullCookieRead.receipt.contentType,'text/x-component');
assert.equal(fullCookieRead.states.live_replay,true);assert.equal(fullCookieRead.data.products.length,60);
assert.equal(fullCookieRead.projectionSha256,hash(JSON.stringify(fullCookieRead.data)));
assert.equal(cookieComparison.browserDomVerification.exactIdentityAndTitleMatches,60);
assert.equal(cookieComparison.browserDomVerification.displayedPriceMatches,60);
const retailDiagnostics={visitorReceipt:dir+'retail-visitor-live.json',comparisonReceipt:dir+'retail-403-variants-live.json',
 visitorBootstrapStatus:200,publicOfferStatusBeforeAndAfter:[200,200],publicOfferGeneralPriceKrw:13200,
 documentVariants:diagnostic.runs.filter(x=>!x.name.startsWith('offer_')&&x.name!=='review_json').map(x=>({name:x.name,status:x.receipt.httpStatus,server:x.receipt.server})),
 reviewStatus:diagnostic.runs.find(x=>x.name==='review_json').receipt.status,
 rscCapture:{file:dir+'retail-rsc-capture.json',status:200,products:60,exactDomMatches:60},rscReplays,
 browserCookieComparison:{file:dir+'retail-browser-cookie-comparison-live.json',statuses:[403,403,200],cookieCounts:[3,11,33],
   exactCookieHeadersSent:true,products:60,exactDomIdentityTitleAndPriceMatches:60,wholeOperationBrowserIndependent:false},
 conclusions:['PCID bootstrap and public offer JSON work in the same identity before and after Document denials.',
 'Cookie-free, HTTP-issued visitor and browser visitor-plus-Akamai RSC replays return 403; the exact full browser cookie header succeeds with 60 products.',
 'All 60 direct HTTP products match current DOM identities, titles and displayed prices. The necessary additional cookie subset and renewal remain unknown.']};
// Fail without printing any value if future evidence accidentally contains runtime identifiers.
let evidenceFiles=0;
const sensitive=/^(?:coupangApp|pcid|uuid|memberSrl|feedId|nextPageKey|continuationToken|accessPasses?|blockId|searchId|searchGroupId|q2cId|token|session|cookie|cookieHeader|authorization|_rsc|next-router-state-tree|_abck|ak_bmsc|bm_[a-z]+|authCodeVerifier|authLoginChallenge|authLoginSessionId|CT_LSID|cf_clearance)$/i;
function inspect(value,shape=false){
 if(typeof value==='string'){
   if(shape)assert.ok(['string','number','boolean','null','undefined','array','object'].includes(value),'EVIDENCE_BODY_SHAPE_VALUE');
   assert.ok(!value.includes('COUPANG|PC|'),'EVIDENCE_RUNTIME_IDENTIFIER');
   assert.ok(!/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./.test(value),'EVIDENCE_TOKEN_PATTERN');
   assert.ok(!/[?&](?:searchId|searchGroupId|q2cId|pcid|access_token|onlinetourRT)=/i.test(value),'EVIDENCE_RUNTIME_URL');
   assert.ok(!/(?:^|;\s*)(?:PCID|_abck|ak_bmsc|bm_[a-z]+|authCodeVerifier|authLoginChallenge|authLoginSessionId|CT_LSID|cf_clearance)=[^;\s]+/i.test(value),'EVIDENCE_COOKIE_VALUE');
 }
 if(!value||typeof value!=='object')return;
 for(const[k,v]of Object.entries(value)){
   if(!shape&&sensitive.test(k))assert.ok(v==null||v===''||(Array.isArray(v)&&v.length===0),'EVIDENCE_RUNTIME_FIELD');
   inspect(v,shape||k==='bodyShape');
 }
}
for(const file of await readdir(new URL(dir,root),{recursive:true}))if(file.endsWith('.json')&&!['verification.json','ontology-projections.json'].includes(file)){
 inspect(await read(dir+file));evidenceFiles++;
}
const implementationAtVerification={};for(const file of ['lib/retail/coupang-public.mjs','lib/retail/coupang-frontier.mjs','lib/retail/coupang-ontology.mjs',
 'scripts/coupang-public.mjs','scripts/coupang-crawl.mjs','scripts/verify-coupang-public.mjs','tests/coupang-public.test.mjs','tests/coupang-frontier.test.mjs',
 'lib/retail/coupang-rsc.mjs','scripts/coupang-retail-diagnostic.mjs','scripts/coupang-retail-visitor-check.mjs','scripts/coupang-rsc-probe.mjs',
 'tests/coupang-retail-diagnostic.test.mjs','tests/coupang-retail-visitor.test.mjs','tests/coupang-rsc.test.mjs',
 'scripts/coupang-browser-cookie-probe.mjs','tests/coupang-browser-cookie-probe.test.mjs',
 'service-packs/affiliate/apps/affiliate-api-hub/lib/coupang-visitor-context.mjs'])
 implementationAtVerification[file]=hash(await readFile(new URL(file,root)));
const report={schema:'coupang-public-verification-v1',verifiedAt:new Date().toISOString(),networkUsed:false,
 verifier:'scripts/verify-coupang-public.mjs',records,blocked,crawl,retailDiagnostics,coverage:coupangCoverage(frontier),implementationAtVerification,
 evidenceAudit:{jsonFiles:evidenceFiles,runtimeIdentifierFindings:0},
 limitations:['Entire catalog is not complete. Pending resource and nested-operation frontiers are preserved.',
 'General retail RSC direct replay succeeds with a fresh full browser cookie header: 60 DOM-matched products. Cookie-free, visitor-only and visitor-plus-Akamai variants fail. Recurring input/session renewal remains browser-dependent.',
 'Flight iframe search is not verified. Membership prices are advertised values, not verified account checkout totals.',
 'Early live receipts predate later metadata/parser repairs; implementation digests describe code at verification time.']};
await writeFile(new URL(dir+'verification.json',root),JSON.stringify(report,null,2)+'\n');
await writeFile(new URL(dir+'ontology-projections.json',root),JSON.stringify({schema:'coupang-travel-projections-v1',databaseWrites:0,projections},null,2)+'\n');
await writeFile(new URL(dir+'ontology-crawl-projections.jsonl',root),crawlProjections.map(p=>JSON.stringify(p)).join('\n')+'\n');
console.log(JSON.stringify({ok:true,networkUsed:false,representativeOperations:records.length,crawl,coverage:report.coverage,ontologyProjections:projections.length,ontologyCrawlReceipts:crawlProjections.length,evidenceAudit:report.evidenceAudit}));
