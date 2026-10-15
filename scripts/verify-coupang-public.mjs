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
 blocked.push({file:dir+file,checkedAt:run.checkedAt,httpStatus:403,mode:'anonymous',cause:'unknown',protectedSessionReplay:'unverified'});
}
// Fail without printing any value if future evidence accidentally contains runtime identifiers.
let evidenceFiles=0;
const sensitive=/^(?:coupangApp|pcid|uuid|memberSrl|feedId|nextPageKey|continuationToken|accessPasses?|blockId|searchId|searchGroupId|q2cId|token|session|cookie|authorization)$/i;
function inspect(value,shape=false){
 if(typeof value==='string'){
   if(shape)assert.ok(['string','number','boolean','null','undefined','array','object'].includes(value),'EVIDENCE_BODY_SHAPE_VALUE');
   assert.ok(!value.includes('COUPANG|PC|'),'EVIDENCE_RUNTIME_IDENTIFIER');
   assert.ok(!/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./.test(value),'EVIDENCE_TOKEN_PATTERN');
   assert.ok(!/[?&](?:searchId|searchGroupId|q2cId|pcid|access_token|onlinetourRT)=/i.test(value),'EVIDENCE_RUNTIME_URL');
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
 'scripts/coupang-public.mjs','scripts/coupang-crawl.mjs','scripts/verify-coupang-public.mjs','tests/coupang-public.test.mjs','tests/coupang-frontier.test.mjs'])
 implementationAtVerification[file]=hash(await readFile(new URL(file,root)));
const report={schema:'coupang-public-verification-v1',verifiedAt:new Date().toISOString(),networkUsed:false,
 verifier:'scripts/verify-coupang-public.mjs',records,blocked,crawl,coverage:coupangCoverage(frontier),implementationAtVerification,
 evidenceAudit:{jsonFiles:evidenceFiles,runtimeIdentifierFindings:0},
 limitations:['Entire catalog is not complete. Pending resource and nested-operation frontiers are preserved.',
 'General retail browser navigation succeeds; anonymous search/category Document reads return 403. Protected session replay is not verified.',
 'Flight iframe search is not verified. Membership prices are advertised values, not verified account checkout totals.',
 'Early live receipts predate later metadata/parser repairs; implementation digests describe code at verification time.']};
await writeFile(new URL(dir+'verification.json',root),JSON.stringify(report,null,2)+'\n');
await writeFile(new URL(dir+'ontology-projections.json',root),JSON.stringify({schema:'coupang-travel-projections-v1',databaseWrites:0,projections},null,2)+'\n');
await writeFile(new URL(dir+'ontology-crawl-projections.jsonl',root),crawlProjections.map(p=>JSON.stringify(p)).join('\n')+'\n');
console.log(JSON.stringify({ok:true,networkUsed:false,representativeOperations:records.length,crawl,coverage:report.coverage,ontologyProjections:projections.length,ontologyCrawlReceipts:crawlProjections.length,evidenceAudit:report.evidenceAudit}));
