import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { withXReadContext } from './providers/x.mjs';
const fail = (code,receipt={})=>{throw Object.assign(new Error(code),{code,receipt});};
// Observed 2026-10-02: one transient GraphQL error followed six successful
// searches with the same contract. Its full body stays in protected diagnostics.
export function observedTransientSearchError(payload){
  return Array.isArray(payload?.errors)&&payload.errors.length>0&&payload.errors.every(error=>
    error?.code==null&&typeof error.message==='string'
    &&/temporar|unavailable|try again|something.*wrong/i.test(error.message)
    &&!/auth|forbidden|unauthorized|token|captcha|blocked|suspend|restrict|limit|permission|feature|variable|validation|credential|login|log.?in|bad.request|required|field/i.test(error.message)
    &&Array.isArray(error.path)&&['search_by_raw_query','search_timeline','timeline'].every((field,index)=>error.path[index]===field));
}
const count=value=>{const n=typeof value==='string'&&/^\d+$/.test(value)?Number(value):value;return Number.isSafeInteger(n)&&n>=0?n:null;};
const media=legacy=>{const m=legacy?.extended_entities?.media?.[0]??legacy?.entities?.media?.[0];
  if(!m||typeof m.media_url_https!=='string'||!/^https:\/\/pbs\.twimg\.com\/[\w/.-]+$/.test(m.media_url_https))return null;
  return {type:m.type==='video'||m.type==='animated_gif'?'video':'image',thumbnail:m.media_url_https};};
export function decodeXSearch(payload) {
  const instructions=payload?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions;
  if(!Array.isArray(instructions) || payload.errors?.length) fail('X_SEARCH_SCHEMA');
  const items=new Map();let cursor=null,terminated=false;
  const visit=content=>{
    if(!content || content.promotedMetadata) return;
    const c=content.itemContent || content;
    if(c.promotedMetadata) return;
    if(c.cursorType==='Bottom' && typeof c.value==='string') cursor=c.value;
    const outer=c.tweet_results?.result,tweet=outer?.__typename==='TweetWithVisibilityResults'?outer.tweet:outer;
    const user=tweet?.core?.user_results?.result;
    const author=user?.core?.screen_name ?? user?.legacy?.screen_name;
    const legacy=tweet?.legacy;
    const text=tweet?.note_tweet?.note_tweet_results?.result?.text ?? legacy?.full_text;
    if(tweet?.__typename!=='Tweet' || !/^\d{1,25}$/.test(tweet.rest_id||'') || !/^\d{1,25}$/.test(user?.rest_id||'') || !/^[A-Za-z0-9_]{1,15}$/.test(author||'') || typeof text!=='string' || legacy.retweeted_status_result) return;
    const date=Date.parse(legacy.created_at);
    items.set(tweet.rest_id,{id:tweet.rest_id,authorId:user.rest_id,author,text:text.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>'),
      url:`https://x.com/${author}/status/${tweet.rest_id}`,blueVerified:user.is_blue_verified===true,protected:user.privacy?.protected ?? user.legacy?.protected ?? null,
      publishedAt:Number.isFinite(date)?new Date(date).toISOString():null,replyToId:legacy.in_reply_to_status_id_str || null,quotedPostId:legacy.quoted_status_id_str || null,
      // Public engagement counts and first media item, for ranking hot posts. Absent counts stay null.
      metrics:{likes:count(legacy.favorite_count),reposts:count(legacy.retweet_count),replies:count(legacy.reply_count),quotes:count(legacy.quote_count),views:count(tweet.views?.count)},
      media:media(legacy)});
  };
  for(const instruction of instructions) {
    if(instruction.type==='TimelineTerminateTimeline' && instruction.direction==='Bottom') terminated=true;
    for(const entry of instruction.entries || (instruction.entry?[instruction.entry]:[])) {
      visit(entry.content);for(const child of entry.content?.items || []) visit(child.item);
    }
    for(const child of instruction.moduleItems || []) visit(child.item);
  }
  return {items:[...items.values()],cursor:terminated?null:cursor,terminatedBottom:terminated};
}
export async function searchXPosts(query,{product='Latest',maxPages=1,blueOnly=false,withContext=withXReadContext,diagnosticTransport}={}) {
  if(diagnosticTransport!==undefined&&!['legacy_api','web'].includes(diagnosticTransport))fail('X_SEARCH_INPUT');
  if(typeof query!=='string' || !query.trim() || query.length>300 || !['Latest','Top'].includes(product) || !Number.isInteger(maxPages) || maxPages<1 || maxPages>10) fail('X_SEARCH_INPUT');
  const contract=JSON.parse(await readFile(new URL('./contracts/x-search.json',import.meta.url),'utf8'));
  if(contract.missingFeatures?.length || !/^[A-Za-z0-9_-]+$/.test(contract.queryId||'')) fail('X_SEARCH_CONTRACT_INVALID');
  return withContext(async context=>{
    if('searchContract' in context&&!context.searchContract)fail('X_SEARCH_CURRENT_CONTRACT_UNAVAILABLE');
    const activeContract=context.searchContract?{...context.searchContract,missingFeatures:context.searchContract.missing}:contract;
    if(activeContract.missingFeatures?.length||!/^[A-Za-z0-9_-]+$/.test(activeContract.queryId||''))fail('X_SEARCH_CONTRACT_INVALID');
    const rows=new Map(),seen=new Set(),receipts=[];let cursor,stopReason='page_limit';
    for(let page=0;page<maxPages;page++) {
      const useWeb=diagnosticTransport==='web'||diagnosticTransport!== 'legacy_api'&&context.apiTransitionEnabled===true;
      const route=`${useWeb?'/i/api':''}/graphql/${activeContract.queryId}/SearchTimeline`,url=new URL(route,useWeb?'https://x.com':'https://api.x.com');
      url.searchParams.set('variables',JSON.stringify({rawQuery:query,count:20,querySource:'typed_query',product,withGrokTranslatedBio:false,withQuickPromoteEligibilityTweetFields:false,...(cursor?{cursor}:{})}));
      url.searchParams.set('features',JSON.stringify(activeContract.features));
      const r=await context.request('GET',route,url.href);
      const receipt={operation:'SearchTimeline',httpStatus:r.status,rateLimitReset:/^\d+$/.test(r.headers['x-rate-limit-reset']||'')?Number(r.headers['x-rate-limit-reset']):null,
        rateLimitRemaining:/^\d+$/.test(r.headers['x-rate-limit-remaining']||'')?Number(r.headers['x-rate-limit-remaining']):null,browserUsed:false,executionMode:'pure_http'};
      receipt.origin=url.origin;receipt.path=route;receipt.apiTransitionEnabled=context.apiTransitionEnabled===true;
      receipt.page=page+1;receipt.hasCursor=Boolean(cursor);receipt.mime=(r.headers['content-type']||'').split(';')[0];
      receipt.bodyBytes=Buffer.byteLength(r.raw||'');receipt.bodySha256=createHash('sha256').update(r.raw||'').digest('hex');receipt.headerNames=Object.keys(r.headers).filter(k=>!/^set-cookie$/i.test(k)).sort();
      if(r.status!==200) { try { const rejected=JSON.parse(r.raw);receipt.errorCodes=(rejected.errors||[]).map(e=>e.code).filter(Number.isInteger); } catch {} }
      receipts.push(receipt);
      if(r.status!==200 || !r.headers['content-type']?.includes('json')) fail('X_SEARCH_REJECTED',receipt);
      let payload;try{payload=JSON.parse(r.raw);}catch{fail('X_SEARCH_SCHEMA',receipt);}
      if(Array.isArray(payload?.errors)) receipt.errorCodes=payload.errors.map(e=>e?.code).filter(Number.isInteger);
      if(observedTransientSearchError(payload))fail('X_SEARCH_SERVICE_UNAVAILABLE',{...receipt,writeSent:false});
      let decoded;try{decoded=decodeXSearch(payload);}catch(error){
        if(error.code==='X_SEARCH_SCHEMA') fail('X_SEARCH_SCHEMA',receipt);
        throw error;
      }
      receipt.items=decoded.items.length;
      for(const item of decoded.items) rows.set(item.id,item);
      if(decoded.terminatedBottom || !decoded.cursor){stopReason='exhausted_visible_results';cursor=null;break;}
      if(seen.has(decoded.cursor)){stopReason='repeated_cursor';cursor=decoded.cursor;break;}
      seen.add(decoded.cursor);cursor=decoded.cursor;
    }
    return {query,product,owner:context.ownerHandle,items:[...rows.values()].filter(r=>!blueOnly || r.blueVerified),observedCount:rows.size,
      nextCursor:cursor || null,stopReason,pages:receipts.length,receipts,fullSearch:false,captured:false,clientExists:true,credentialPropagated:true,liveReplay:true,writes:0,browserUsed:false};
  });
}
if(process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) {
  searchXPosts(process.argv[2],{maxPages:process.argv.includes('--two-pages')?2:1,blueOnly:process.argv.includes('--blue-only')}).then(r=>{const {nextCursor,...safe}=r;console.log(JSON.stringify({...safe,hasNextPage:Boolean(nextCursor)}));}).catch(e=>{console.log(JSON.stringify({success:false,code:e.code||'X_SEARCH_FAILED',receipt:e.receipt,writes:0}));process.exitCode=2;});
}
