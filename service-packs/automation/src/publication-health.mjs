import {createHash,randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tistoryBlogOrigin} from './measurement-snapshot.mjs';

export function inspectPublication(html,expected){
 const missing=[];
 if(!html.includes(expected.title))missing.push('title');
 if(!html.includes(expected.disclosure))missing.push('disclosure');
 for(const link of expected.links)if(!html.includes(link))missing.push('affiliate-link:'+new URL(link).pathname);
 return {status:missing.length?'needs_review':'content-markers-present',missing,
  limitations:['HTML marker check is not visual layout verification','Destination, price, stock and affiliate conversion are not checked','Verification request may affect view counts']};
}

export async function checkPublication(expected,directory,{blogOrigin=process.env.TISTORY_BLOG_ORIGIN,fetchImpl=globalThis.fetch,now=()=>new Date(),uuid=randomUUID}={}){
 const origin=tistoryBlogOrigin(blogOrigin),url=new URL(expected.url);
 if(!origin||url.origin!==origin||!/^\/\d+$/.test(url.pathname)||url.search||url.hash)throw Error('Verified public post URL required');
 if(!expected.title||!expected.disclosure||!Array.isArray(expected.links)||!expected.links.length)throw Error('Expected content markers required');
 const response=await fetchImpl(url,{redirect:'manual',signal:AbortSignal.timeout(20000)});
 const raw=await response.text();
 const result=response.status===200&&response.headers.get('content-type')?.includes('text/html')?inspectPublication(raw,expected):{status:'unavailable',missing:[],limitations:['Transport or content type did not match the public page']};
 const receipt={url:url.href,checkedAt:now().toISOString(),httpStatus:response.status,responseHash:createHash('sha256').update(raw).digest('hex'),...result,authenticated:false,verificationTraffic:true};
 await mkdir(directory,{recursive:true});const file=join(directory,'publication-health-'+uuid()+'.json');await writeFile(file,JSON.stringify(receipt,null,2),{flag:'wx'});
 return {file,...receipt};
}
