// Observed home navigation schema. Menu occurrences and canonical category URLs differ.
export function categoryFrontier(data){
 const gnb=data?.data?.gnb;
 if(!Array.isArray(gnb?.shoppingComponent))throw Error('Category schema mismatch');
 const nodes=new Map(),edges=[],containers=[];
 const queue=Object.entries(gnb).filter(([group,value])=>group.endsWith('Component')&&Array.isArray(value)).flatMap(([group,value])=>value.map((node,index)=>({node,parent:'https://www.coupang.com/',depth:1,group,occurrence:group+'/'+index})));
 for(let i=0;i<queue.length;i++){
  const {node,parent,depth,group,occurrence}=queue[i];
  if(!node||typeof node!=='object')throw Error('Invalid menu node: '+occurrence);
  let url;try{if(typeof node.linkUri==='string'&&node.linkUri)url=new URL(node.linkUri,'https://www.coupang.com/');}catch{}
  const eligible=url?.origin==='https://www.coupang.com'&&/^\/np\/categories\/\d+$/.test(url.pathname);
  const key=eligible?url.origin+url.pathname:'menu:'+occurrence;
  if(eligible){
   if(!nodes.has(key))nodes.set(key,{url:key,name:node.name,categoryId:url.pathname.split('/').pop(),depth,state:'pending',attempts:0,evidenceSource:'home-category-api',nextStage:'inspect-listing-contract'});
  }else containers.push({key,name:node.name,depth,reason:url?'non-category-destination':'missing-or-invalid-destination'});
  edges.push({parent,child:key,type:depth===1?'home-menu':'menu-child',group,componentId:node.id});
  if(node.visibleChildren!==undefined&&!Array.isArray(node.visibleChildren))throw Error('Invalid menu children: '+occurrence);
  for(const [index,child] of (node.visibleChildren??[]).entries())queue.push({node:child,parent:key,depth:depth+1,group,occurrence:occurrence+'/'+index});
 }
 return {root:'https://www.coupang.com/',sourceContract:'/n-api/web-adapter/category-list',coverage:'observed-navigation-tree-not-entire-inventory',nodes:[...nodes.values()],edges,containers};
}

// Refresh navigation without losing attempts, pagination, or evidence from earlier runs.
export function mergeCategoryFrontier(previous,fresh){
 if(previous.root!==fresh.root||previous.sourceContract!==fresh.sourceContract)throw Error('Frontier scope mismatch');
 const old=new Map(previous.nodes.map(node=>[node.url,node]));
 const nodes=fresh.nodes.map(node=>({...old.get(node.url),...node,...Object.fromEntries(Object.entries(old.get(node.url)??{}).filter(([key])=>!['url','name','categoryId','depth'].includes(key))),navigationPresent:true}));
 const current=new Set(fresh.nodes.map(node=>node.url));
 for(const node of previous.nodes)if(!current.has(node.url))nodes.push({...node,navigationPresent:false});
 const supplementalTypes=new Set(['lazy-category-child','observed-breadcrumb','observed-navigation-context']);
 const supplementalEdges=[...new Map([...(previous.supplementalEdges??[]),...previous.edges,...(previous.previousEdges??[])].filter(e=>supplementalTypes.has(e.type)).map(e=>[JSON.stringify([e.parent,e.child,e.type,e.componentId??null]),e])).values()];
 const edges=[...fresh.edges];for(const e of supplementalEdges)if(!edges.some(x=>x.parent===e.parent&&x.child===e.child&&x.type===e.type&&x.componentId===e.componentId))edges.push(e);
 return {...fresh,nodes,edges,supplementalEdges,previousEdges:previous.edges};
}

export function mergeLazyCategories(frontier,receipt,parent){
 const request=new URL(receipt.url);
 const canonical=value=>{const u=new URL(value,'https://www.coupang.com');if(u.origin!=='https://www.coupang.com'||!/^\/np\/categories\/\d+$/.test(u.pathname))throw Error('Observed category URL required');return u.origin+u.pathname;};
 if(receipt.httpStatus!==200||!receipt.responseHash||!Array.isArray(receipt.children))throw Error('Verified lazy response required');
 // Request context can be a selected leaf in a different branch. Only an
 // observed DOM/navigation parent establishes the structural attachment.
 if(typeof parent.observedParentUrl!=='string')throw Error('Observed navigation parent required');
 const out=structuredClone(frontier),parentUrl=canonical(parent.url),contextUrl=canonical(parent.observedParentUrl);
 if(contextUrl===parentUrl)throw Error('Category cannot parent itself');
 let context=out.nodes.find(n=>n.url===contextUrl);
 if(!context){
  if(!Array.isArray(parent.observedBreadcrumb)||canonical(parent.observedBreadcrumb.at(-1)?.url)!==contextUrl)throw Error('Observed navigation-parent breadcrumb required');
  let previous=out.root,depth=0;
  for(const crumb of parent.observedBreadcrumb){const url=canonical(crumb.url);depth++;
   if(!out.nodes.some(n=>n.url===url))out.nodes.push({url,name:crumb.name,categoryId:url.split('/').pop(),depth,state:'pending',attempts:0,evidenceSource:'observed-breadcrumb',nextStage:'inspect-listing-contract'});
   if(!out.edges.some(e=>e.parent===previous&&e.child===url))out.edges.push({parent:previous,child:url,type:'observed-breadcrumb'});previous=url;
  }
  context=out.nodes.find(n=>n.url===contextUrl);
 }
 let parentNode=out.nodes.find(n=>n.url===parentUrl);
 if(!parentNode){parentNode={url:parentUrl,name:parent.name,categoryId:parentUrl.split('/').pop(),depth:context.depth+1,state:'pending',attempts:0,evidenceSource:'observed-category-dom',nextStage:'inspect-listing-contract'};out.nodes.push(parentNode);}
 const edges=[{parent:contextUrl,child:parentUrl,type:'observed-navigation-context'}];
 for(const child of receipt.children){
  const url=canonical(child.linkUri);if(url.split('/').pop()!==String(child.linkCode))throw Error('Category URL and linkCode mismatch');
  if(!out.nodes.some(n=>n.url===url))out.nodes.push({url,name:child.name,categoryId:String(child.linkCode),depth:parentNode.depth+1,state:'pending',attempts:0,evidenceSource:'lazy-category-api',nextStage:'inspect-listing-contract'});
  edges.push({parent:parentUrl,child:url,type:'lazy-category-child',componentId:child.id,requestComponent:request.searchParams.get('component'),requestContext:request.searchParams.get('linkcodes'),responseHash:receipt.responseHash});
 }
 for(const edge of edges)if(!out.edges.some(e=>e.parent===edge.parent&&e.child===edge.child&&e.type===edge.type))out.edges.push(edge);
 out.lazyDiscoveryAt=receipt.checkedAt;return out;
}
