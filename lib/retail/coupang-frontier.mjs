import { createHash } from 'node:crypto';
import { coupangPublicUrl } from './coupang-public.mjs';
const sha = v => createHash('sha256').update(v).digest('hex').slice(0,24);

export function resourceUrl(value) {
  const safe = coupangPublicUrl(value); if (!safe) return null;
  const u = new URL(safe); u.searchParams.delete('channel');
  if (/\/(?:tp|vp)\/products\//.test(u.pathname)) u.searchParams.delete('q');
  if (u.hostname==='trip.coupang.com' && /^\/tp\/categories\//.test(u.pathname)) {
    if (u.searchParams.get('travelSearchType')==='DEFAULT') u.searchParams.delete('travelSearchType');
    const filters=u.searchParams.get('filters');
    if (filters && filters.split(',').sort().join(',')==='reviewRating=0,sorting=COUPANG_RATING') u.searchParams.delete('filters');
    if (u.searchParams.get('page')==='1') u.searchParams.delete('page');
  }
  for (const [k,v] of [...u.searchParams]) if (v === '') u.searchParams.delete(k);
  u.searchParams.sort(); return u.href;
}
export function normalizeCoupangFrontier(frontier) {
  const nodes=new Map(),ids=new Map();
  for(const old of frontier.nodes){const url=resourceUrl(old.url);if(!url)continue;const key=sha(url);ids.set(old.id,key);
    const n={...old,id:key,url};const prior=nodes.get(key);
    if(!prior){nodes.set(key,n);continue;}
    const winner=prior.directHttpVerified?prior:n.directHttpVerified?n:prior;
    nodes.set(key,{...winner,attempts:prior.attempts+n.attempts,depth:Math.min(prior.depth,n.depth),
      evidenceSources:[...new Set([...prior.evidenceSources,...n.evidenceSources])],browserInspected:prior.browserInspected||n.browserInspected,
      optionsVerified:prior.optionsVerified||n.optionsVerified,reviewsVerified:prior.reviewsVerified||n.reviewsVerified,
      mergedResourceIds:[...new Set([...(prior.mergedResourceIds??[]),old.id])]});
  }
  frontier.nodes=[...nodes.values()];const edges=new Map();
  for(const e of frontier.edges){const from=ids.get(e.from),to=ids.get(e.to);if(from&&to&&from!==to)edges.set(`${from}:${to}`,{...e,from,to});}
  frontier.edges=[...edges.values()];for(const op of frontier.operations)op.parent=ids.get(op.parent)??op.parent;
  for(const n of frontier.nodes)if(n.continuation)n.continuation=ids.get(n.continuation)??n.continuation;
  return frontier;
}
export function newCoupangFrontier() {
  return { schema: 'coupang-resource-frontier-v1', roots: ['https://www.coupang.com/','https://trip.coupang.com/'],
    requestedScope: ['retail_navigation','retail_search','retail_sort_filter_pagination','retail_product_options_reviews',
      'travel_navigation','travel_search','travel_sort_filter_pagination','travel_detail_options_reviews'],
    complete: false, totalDenominator: 'unknown', nodes: [], edges: [], operations: [], runs: [] };
}
export function enqueueCoupang(frontier, value, { label = '', parent = null, depth = 0, evidenceSource = 'DOM', browserInspected = false } = {}) {
  const url = resourceUrl(value); if (!url) return null;
  const u = new URL(url);
  if (!/^(?:\/$|\/(?:tp|np|vp)\/(?:categories|campaigns|products)\/\d+$|\/(?:tp|np)\/search$|\/np\/(?:coupangglobal|omp)$|\/p\/(?:\d+|bep)$|\/mlp\/web\/mlp-landing-page$)/.test(u.pathname)) return null;
  const key = sha(url); let node = frontier.nodes.find(x=>x.id === key);
  if (!node) {
    const stage = /\/products\//.test(u.pathname) ? 'product_detail' : u.searchParams.has('page') || /\/search$/.test(u.pathname) ? 'listing' : 'navigation';
    node = { id: key, url, label, depth, stage, state: 'pending', attempts: 0, lastAttemptAt: null,
      evidenceSources: [], browserInspected: false, directHttpVerified: false, listingVerified: false,
      optionsVerified: false, reviewsVerified: false, pagination: null, continuation: null };
    frontier.nodes.push(node);
  }
  if (label && !node.label) node.label=label;
  if (!node.evidenceSources.includes(evidenceSource)) node.evidenceSources.push(evidenceSource);
  node.browserInspected ||= browserInspected;
  if (parent && parent !== key && !frontier.edges.some(e=>e.from===parent && e.to===key)) frontier.edges.push({ from: parent, to: key, evidenceSource });
  return node;
}
export function seedCoupangFrontier(frontier, browser, categories) {
  frontier.unresolvedRoutes ??= [];
  const unresolved = (url, parent, label) => {
    const safe = coupangPublicUrl(url); if (!safe) return;
    if (!frontier.unresolvedRoutes.some(r => r.url === safe && r.parent === parent))
      frontier.unresolvedRoutes.push({url:safe,parent,label,
        state:/\/np\/(?:policies|etc|safety)(?:\/|$)/.test(new URL(safe).pathname)?'out_of_scope':'pending_contract',
        reason:/\/np\/(?:policies|etc|safety)(?:\/|$)/.test(new URL(safe).pathname)?'footer_policy_or_company_page':'observed_read_route_without_maintained_adapter'});
  };
  for (const url of frontier.roots) enqueueCoupang(frontier,url);
  for (const page of browser.pages ?? []) {
    const parent=enqueueCoupang(frontier,page.url,{ label:page.label,browserInspected:true });
    if (!parent) { unresolved(page.url,null,page.label); continue; }
    for (const link of page.links??[]) {
      if (!enqueueCoupang(frontier,link.href,{label:link.label,parent:parent.id,depth:parent.depth+1}))
        unresolved(link.href,parent.id,link.label);
    }
  }
  for (const c of categories?.data?.nodes??[]) enqueueCoupang(frontier,c.url,{label:c.label,depth:c.depth,evidenceSource:'direct_replay'});
  for (const e of categories?.data?.edges??[]) {
    const p=enqueueCoupang(frontier,e.from,{evidenceSource:'direct_replay'});
    enqueueCoupang(frontier,e.to,{parent:p?.id,evidenceSource:'direct_replay'});
  }
  frontier.blockers=browser.blockers??[];
  return frontier;
}
export function applyCoupangResult(frontier,node,run) {
  node.attempts++; node.lastAttemptAt=run.checkedAt; node.resultRef=null;
  if (!run.ok) { node.state='blocked_http';node.failure={code:run.code,httpStatus:run.request?.httpStatus??null,challengeSignal:run.request?.challengeSignal??null};return; }
  node.state='replay_verified'; node.directHttpVerified=true;node.kind=run.data.kind;
  node.listingVerified=['retail_listing','travel_listing'].includes(run.data.kind);
  node.optionsVerified=run.data.completeOptions===true;
  node.pagination=run.data.pagination??null;
  for (const nav of run.data.navigation??[]) enqueueCoupang(frontier,nav.url,{label:nav.label,parent:node.id,depth:node.depth+1,evidenceSource:'HTML'});
  for (const p of run.data.products??[]) if (p.productUrl) {
    const u=new URL(p.productUrl), source=new URL(node.url);
    for (const key of ['checkIn','checkOut','numberOfAdults','childrenAges','displayCategoryCode','pickUpDate','pickUpTime','dropOffDate','dropOffTime'])
      if(source.searchParams.has(key))u.searchParams.set(key,source.searchParams.get(key));
    // The clicked rental result carried the exact vendor item and rental interval into the detail URL.
    if(p.productType==='RENTAL_CAR'&&p.vendorItemId)u.searchParams.set('vendorItemId',p.vendorItemId);
    const child=enqueueCoupang(frontier,u.href,{label:p.title,parent:node.id,depth:node.depth+1,evidenceSource:'direct_replay'});
    if(child)child.productType=p.productType??null;
  }
  if (run.data.pagination?.hasNext===true) {
    const next=new URL(node.url);next.searchParams.set('page',String(run.data.pagination.page+1));
    const child=enqueueCoupang(frontier,next.href,{label:'next page',parent:node.id,depth:node.depth,evidenceSource:'direct_replay'});
    if (child && node.adapter === 'travel_search') { child.adapter=node.adapter; child.templateRef=node.templateRef; }
    node.continuation=child?.id??null;
  }
  if (run.data.kind==='travel_detail') {
    node.productId=run.data.productId;node.packageProductId=run.data.packageProductId;
    // Preserve nested work independently from having fetched a detail Document.
    for(const operation of ['options','reviews'])if(!frontier.operations.some(o=>o.parent===node.id&&o.operation===operation))
      frontier.operations.push({parent:node.id,operation,productId:node.productId,packageProductId:node.packageProductId,
        state:operation==='options'&&node.optionsVerified?'replay_verified':'pending'});
  }
}
export function coupangCoverage(frontier) {
  const count = (key,value) => frontier.nodes.filter(n=>n[key]===value).length;
  return { complete:false,totalDenominator:'unknown',resourceNodes:frontier.nodes.length,edges:frontier.edges.length,
    activeResourceNodes:frontier.nodes.filter(n=>n.state!=='superseded').length,supersededResources:count('state','superseded'),
    browserInspected:count('browserInspected',true),directHttpVerified:count('directHttpVerified',true),
    listingVerified:count('listingVerified',true),optionsVerified:count('optionsVerified',true),reviewsVerified:count('reviewsVerified',true),
    pending:count('state','pending'),blocked:count('state','blocked_http'),
    sharedBoundaryDeferred:frontier.nodes.filter(n=>n.state==='pending'&&n.blockedBy).length,
    pendingReadRoutes:(frontier.unresolvedRoutes??[]).filter(r=>r.state==='pending_contract').length,
    pendingNestedOperations:frontier.operations.filter(o=>o.state==='pending').length,
    blockedNestedOperations:frontier.operations.filter(o=>o.state==='blocked_http').length,
    pendingReviewPages:frontier.operations.filter(o=>o.operation==='reviews'&&Number.isInteger(o.nextPage)).length,
    stages:Object.fromEntries(['navigation','listing','product_detail'].map(s=>[s,{
      discovered:frontier.nodes.filter(n=>n.stage===s).length,verified:frontier.nodes.filter(n=>n.stage===s&&n.directHttpVerified).length,
      pending:frontier.nodes.filter(n=>n.stage===s&&n.state==='pending').length,
      blocked:frontier.nodes.filter(n=>n.stage===s&&n.state==='blocked_http').length}])) };
}
