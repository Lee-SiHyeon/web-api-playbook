import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {readCoupangDocument,readCoupangTravelSearch,readCoupangTravelTicketOptions,readCoupangTravelRooms,readCoupangTravelReviews} from '../lib/retail/coupang-public.mjs';
import {newCoupangFrontier,normalizeCoupangFrontier,seedCoupangFrontier,applyCoupangResult,coupangCoverage} from '../lib/retail/coupang-frontier.mjs';
const args=Object.fromEntries(process.argv.slice(2).map(v=>{const i=v.indexOf('=');return[v.slice(2,i),v.slice(i+1)]}));
const dir=args.dir??'verification/coupang-discovery-2026-10-15';
const frontierPath=path.join(dir,'resource-frontier.json');
const checkpoint=async()=>{const tmp=`${frontierPath}.${process.pid}.tmp`;await writeFile(tmp,JSON.stringify(frontier,null,2)+'\n');await rename(tmp,frontierPath)};
const read=async p=>JSON.parse(await readFile(p,'utf8'));
let frontier;try{frontier=await read(frontierPath)}catch(e){if(e.code!=='ENOENT')throw e;frontier=newCoupangFrontier()}
seedCoupangFrontier(frontier,await read(path.join(dir,'browser-observations.json')),await read(path.join(dir,'categories-live.json')));
normalizeCoupangFrontier(frontier);
if(args['retry-repaired']==='true')for(const node of frontier.nodes)
  if(node.state==='blocked_http'&&(node.failure?.httpStatus===302||node.failure?.code==='COUPANG_PRICE_SCHEMA')){
    node.priorFailure=node.failure;node.state='pending';
  }
for(const node of frontier.nodes)if(node.priorFailure?.httpStatus===302&&node.state==='pending')
  node.blockedBy='redirected_travel_search_document_rejected_use_observed_json_contract';
const max=Number(args.max??60),phase=args.phase??'travel-navigation';
if(!Number.isSafeInteger(max)||max<1||max>500)throw new Error('COUPANG_BUDGET_INVALID');
if(!['travel-navigation','travel-details','travel-pages','travel-search-pages','travel-reviews','retail-navigation'].includes(phase))throw new Error('COUPANG_PHASE_INVALID');
await mkdir(path.join(dir,'crawl'),{recursive:true});
const startedAt=new Date().toISOString();let attempts=0;
if(phase==='travel-reviews'){
  for(const op of frontier.operations)if(op.operation==='reviews'&&op.state==='pending'&&!Number.isInteger(op.nextPage))op.nextPage=0;
  for(const op of frontier.operations)if(op.operation==='reviews'&&op.code==='COUPANG_PAGINATION_SCHEMA'){
    op.nextPage=0;op.state='pending';op.repair='accept_observed_empty_review_pagination';
  }
  while(attempts<max){
    const op=frontier.operations.filter(o=>o.operation==='reviews'&&Number.isInteger(o.nextPage)&&o.state!=='blocked_http')
      .sort((a,b)=>a.nextPage-b.nextPage||a.productId.localeCompare(b.productId))[0];if(!op)break;
    const page=op.nextPage;let run;try{run=await readCoupangTravelReviews(op.productId,{page})}
    catch(e){run={ok:false,code:e.code??'COUPANG_CLIENT_FAILED',request:e.receipt??null}};
    attempts++;op.pageAttempts=(op.pageAttempts??0)+1;
    const ref=`crawl/${op.parent}-reviews-page${page}-${op.pageAttempts}.json`;
    await writeFile(path.join(dir,ref),JSON.stringify(run,null,2)+'\n',{flag:'wx'});
    op.pageReceipts??=[];op.pageReceipts.push(ref);op.state=run.ok?'replay_verified':'blocked_http';
    if(run.ok){op.pagination=run.data.pagination;op.nextPage=page+1<run.data.pagination.totalPages?page+1:null;delete op.code;
      const n=frontier.nodes.find(n=>n.id===op.parent);if(n)n.reviewsVerified=true;
    }else op.code=run.code;
    await checkpoint();console.log(JSON.stringify({phase,attempt:attempts,productId:op.productId,page,ok:run.ok,count:run.data?.reviews.length,code:run.code}));
    if(!run.ok&&[401,403,418,429].includes(run.request?.httpStatus))break;
    await delay(700);
  }
  frontier.runs.push({startedAt,endedAt:new Date().toISOString(),phase,attempts,budget:max});frontier.coverage=coupangCoverage(frontier);await checkpoint();
  console.log(JSON.stringify({phase,attempts,coverage:frontier.coverage}));process.exit(0);
}
const selected=n=>{const u=new URL(n.url);return n.state==='pending'&&!n.blockedBy&&(phase==='travel-navigation'
  ? u.hostname==='trip.coupang.com'&&n.stage==='navigation'
  : phase==='travel-details'?u.hostname==='trip.coupang.com'&&n.stage==='product_detail'
  : phase==='travel-pages'?u.hostname==='trip.coupang.com'&&/^\/tp\/categories\//.test(u.pathname)&&n.stage==='listing'
  : phase==='travel-search-pages'?n.adapter==='travel_search'&&n.templateRef&&n.stage==='listing'
  : phase==='retail-navigation'?['www.coupang.com','pages.coupang.com'].includes(u.hostname)&&n.stage==='navigation':false)};
while(attempts<max){
  const parentOf=id=>frontier.edges.find(e=>e.to===id)?.from;
  const coveredParents=new Map();for(const n of frontier.nodes.filter(n=>n.stage==='product_detail'&&n.directHttpVerified)){
    const p=parentOf(n.id);coveredParents.set(p,(coveredParents.get(p)??0)+1);}
  const priority=n=>['travel-pages','travel-search-pages'].includes(phase)?Number(new URL(n.url).searchParams.get('page')??1):
    phase==='travel-details'?(coveredParents.get(parentOf(n.id))??0):n.depth;
  const node=frontier.nodes.filter(selected).sort((a,b)=>priority(a)-priority(b)||a.depth-b.depth||a.url.localeCompare(b.url))[0];if(!node)break;
  let result;try{result=node.adapter==='travel_search'
    ?await readCoupangTravelSearch(await read(path.join(dir,node.templateRef)),{page:Number(new URL(node.url).searchParams.get('page')??1),resultsOnly:true})
    :await readCoupangDocument(node.url)}catch(e){result={ok:false,checkedAt:new Date().toISOString(),code:e.code??'COUPANG_CLIENT_FAILED',request:e.receipt??null,redirects:e.redirects??[]}}
  applyCoupangResult(frontier,node,result);attempts++;
  const resultRef=`crawl/${node.id}-${node.attempts}.json`;await writeFile(path.join(dir,resultRef),JSON.stringify(result,null,2)+'\n',{flag:'wx'});node.resultRef=resultRef;
  if(result.ok&&result.data.kind==='travel_detail'){
    for(const operation of ['options','reviews']){
      const op=frontier.operations.find(o=>o.parent===node.id&&o.operation===operation);if(!op||op.state!=='pending')continue;
      let nested;
      try{
        if(operation==='reviews')nested=await readCoupangTravelReviews(node.productId);
        else if(result.data.productType==='TICKET')nested=await readCoupangTravelTicketOptions({
          url:`https://trip.coupang.com/api/products/${node.productId}/vendor-items`,body:{vendorItemPackageId:node.packageProductId,productType:'TICKET',selectDate:null}});
        else if(result.data.productType==='ACCOMMODATION'){
          const template=await read(path.join(dir,'travel-rooms-request.json'));
          template.url=`https://trip.coupang.com/api/lodging/hotels/${node.productId}/rooms`;
          nested=await readCoupangTravelRooms(template);
        } else {op.reason='product_type_option_contract_pending';continue;}
      }catch(e){nested={ok:false,code:e.code??'COUPANG_CLIENT_FAILED',request:e.receipt??null};}
      op.state=nested.ok?'replay_verified':'blocked_http';op.resultRef=`crawl/${node.id}-${operation}-${node.attempts}.json`;
      op.pagination=nested.data?.pagination??null;
      if(nested.ok){node[operation==='options'?'optionsVerified':'reviewsVerified']=true;
        op.nextPage=operation==='reviews'&&nested.data.pagination.page+1<nested.data.pagination.totalPages?nested.data.pagination.page+1:null;
      }else op.code=nested.code;
      await writeFile(path.join(dir,op.resultRef),JSON.stringify(nested,null,2)+'\n',{flag:'wx'});
      await delay(400);
    }
  }
  frontier.coverage=coupangCoverage(frontier);frontier.updatedAt=new Date().toISOString();await checkpoint();
  console.log(JSON.stringify({attempt:attempts,phase,url:node.url,ok:result.ok,kind:result.data?.kind,products:result.data?.products?.length,status:result.request?.httpStatus,code:result.code,pending:frontier.coverage.pending}));
  // Preserve a rejection without retrying it or issuing a same-family request flood.
  if(!result.ok&&[401,403,418,429].includes(result.request?.httpStatus))break;
  await delay(700);
}
frontier.runs.push({startedAt,endedAt:new Date().toISOString(),phase,attempts,budget:max,remainingSelected:frontier.nodes.filter(selected).length});
frontier.coverage=coupangCoverage(frontier);await checkpoint();
console.log(JSON.stringify({phase,attempts,remainingSelected:frontier.nodes.filter(selected).length,coverage:frontier.coverage}));
