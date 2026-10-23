import {createHash} from 'node:crypto';
import {categoryFrontier} from './category-frontier.mjs';

export function decodeSubcategories(data){
 if(!Array.isArray(data.children)||data.children.some(c=>typeof c.name!=='string'||!c.id||!c.linkCode||typeof c.linkUri!=='string'||(Object.hasOwn(c,'hasChild')&&typeof c.hasChild!=='boolean')))throw Error('Subcategory schema mismatch');
 // The observed UI expands only when hasChild is truthy. Inline child arrays need a separate contract.
 if(data.children.some(c=>Array.isArray(c.children)&&c.children.length))throw Error('Inline subcategory traversal requires contract extension');
 return data.children.map(c=>({...c,hasChild:Object.hasOwn(c,'hasChild')?c.hasChild:false,hasChildEvidence:Object.hasOwn(c,'hasChild')?'explicit':'omitted-ui-no-expansion'}));
}

export async function fetchSubcategories({linkcodes,component},cookie,{fetchImpl=globalThis.fetch,now=()=>new Date()}={}){
 if(!/^\d+$/.test(String(linkcodes))||!/^\d+$/.test(String(component)))throw Error('Observed numeric category selectors required');
 if(!cookie)throw Error('Current authorized cookie required');
 const url=new URL('https://www.coupang.com/n-api/first-sub-category');
 for(const [key,value] of Object.entries({linkcodes,channel:'user',isPriceRange:'false',rocketAll:'false',isGoogleLanding:'false',component}))url.searchParams.set(key,String(value));
 const r=await fetchImpl(url,{headers:{cookie,accept:'application/json'},redirect:'manual',signal:AbortSignal.timeout(20000)});
 if(r.status!==200||!r.headers.get('content-type')?.includes('application/json'))throw Error('Subcategory transport failure: HTTP '+r.status);
 const raw=await r.text(),data=JSON.parse(raw);
 return {checkedAt:now().toISOString(),httpStatus:r.status,url:url.href,responseHash:createHash('sha256').update(raw).digest('hex'),children:decodeSubcategories(data),scope:'observed-lazy-navigation-branch',inventoryComplete:false};
}

export async function fetchCategoryTree(cookie,{fetchImpl=globalThis.fetch,now=Date.now,checkedAt=()=>new Date()}={}){
 if(!cookie)throw Error('Current authorized cookie required');
 const url=new URL('https://www.coupang.com/n-api/web-adapter/category-list');
 url.searchParams.set('_',String(now()));
 const response=await fetchImpl(url,{headers:{cookie,accept:'application/json'},redirect:'manual',signal:AbortSignal.timeout(20000)});
 if(response.status!==200||!response.headers.get('content-type')?.includes('application/json'))throw Error('Category transport failure: HTTP '+response.status);
 const raw=await response.text();const map=categoryFrontier(JSON.parse(raw));
 return {checkedAt:checkedAt().toISOString(),httpStatus:200,responseHash:createHash('sha256').update(raw).digest('hex'),...map};
}
