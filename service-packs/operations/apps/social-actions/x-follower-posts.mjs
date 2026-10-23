import {withXReadContext} from './providers/x.mjs';
import {decodeXTimeline} from '../naver-blog-api/research/content-store/x-xhr.mjs';
const fail=(code,receipt)=>{throw Object.assign(new Error(code),{code,receipt});};
export async function readFollowerPosts(user,{withContext=withXReadContext}={}) {
 if(!/^[0-9]{1,25}$/.test(user?.id||'')||!/^[A-Za-z0-9_]{1,15}$/.test(user?.handle||''))fail('X_REFLECTION_FOLLOWER_INPUT');
 return withContext(async context=>{
  if(context.ownerHandle!=='lifehack__ailab')fail('X_REFLECTION_OWNER_MISMATCH');
  const contract=context.timelineContract;
  if(!contract||!['UserOriginalsTimeline','UserTweets'].includes(contract.operation)||contract.missing?.length
   ||!/^[A-Za-z0-9_-]+$/.test(contract.queryId||''))fail('X_TIMELINE_CURRENT_CONTRACT_UNAVAILABLE');
  const profile=await context.lookupUser(user.handle);
  if(profile.userId!==user.id||profile.protected!==false||profile.relation?.followsMe!==true)return {items:[],skipped:'not_current_public_follower',writes:0};
  const prefix=context.apiTransitionEnabled?'/i/api':'';
  const url=new URL(prefix+'/graphql/'+contract.queryId+'/'+contract.operation,context.apiTransitionEnabled?'https://x.com':'https://api.x.com');
  url.searchParams.set('variables',JSON.stringify({userId:user.id,count:20,includePromotedContent:true,withQuickPromoteEligibilityTweetFields:true,withVoice:context.timelineWithVoice===true}));
  url.searchParams.set('features',JSON.stringify(contract.features));
  if(contract.operation==='UserOriginalsTimeline')url.searchParams.set('fieldToggles',JSON.stringify({withPayments:false,withArticlePlainText:false}));
  const response=await context.request('GET',url.pathname,url.href);
  const receipt={operation:contract.operation,httpStatus:response.status,mime:(response.headers['content-type']||'').split(';')[0],
   rateLimitReset:/^[0-9]+$/.test(response.headers['x-rate-limit-reset']||'')?Number(response.headers['x-rate-limit-reset']):null,
   retryAfterSeconds:/^[0-9]+$/.test(response.headers['retry-after']||'')?Number(response.headers['retry-after']):null,
   browserUsed:false,executionMode:'pure_http'};
  if(response.status!==200||!receipt.mime.includes('json'))fail('X_TIMELINE_READ_REJECTED',receipt);
  let payload;try{payload=JSON.parse(response.raw);}catch{fail('X_TIMELINE_SCHEMA',receipt);}
  if(payload.errors?.length)fail('X_TIMELINE_SCHEMA',receipt);
  const instructions=payload.data?.user?.result?.timeline?.timeline?.instructions??payload.data?.user?.result?.timeline_v2?.timeline?.instructions;
  const decoded=decodeXTimeline(instructions,user.handle);
  return {items:decoded.items.filter(p=>p.publisherId===user.id),receipt,fullTimeline:false,writes:0};
 });
}
