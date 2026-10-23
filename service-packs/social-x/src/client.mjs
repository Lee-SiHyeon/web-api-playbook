import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import twitterText from 'twitter-text';
import {decodeConversation} from './conversation.mjs';
const handleOK = s => typeof s==='string' && /^[A-Za-z0-9_]{1,15}$/.test(s);
const idOK = s => typeof s==='string' && /^\d{1,25}$/.test(s);
export class XError extends Error { constructor(code,receipt={}) {super(code);this.code=code;this.receipt=receipt;} }
const hash = s => createHash('sha256').update(s).digest('hex');
export function decode(instructions,handle) {
  if(!Array.isArray(instructions)||!handleOK(handle))throw new XError('SCHEMA');
  const items=new Map(); let cursor=null;
  function visit(content) {
    const c=content?.itemContent??content;
    if(!c||content?.promotedMetadata||c.promotedMetadata)return;
    if(c.cursorType==='Bottom'&&typeof c.value==='string')cursor=c.value;
    const outer=c.tweet_results?.result;
    const t=outer?.__typename==='TweetWithVisibilityResults'?outer.tweet:outer;
    const author=t?.core?.user_results?.result;
    const name=author?.core?.screen_name??author?.legacy?.screen_name;
    if(t?.__typename!=='Tweet'||name?.toLowerCase()!==handle.toLowerCase()||!idOK(t.rest_id)||t.legacy?.retweeted_status_result)return;
    let text=t.note_tweet?.note_tweet_results?.result?.text??t.legacy?.full_text;
    if(typeof text!=='string')return;
    text=text.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
    for(const link of [...(t.note_tweet?.note_tweet_results?.result?.entity_set?.urls??[]),...(t.legacy?.entities?.urls??[])])if(typeof link.url==='string'&&typeof link.expanded_url==='string')text=text.split(link.url).join(link.expanded_url);
    const metric=v => v!==null&&v!==undefined&&/^\d+$/.test(String(v))&&Number.isSafeInteger(Number(v))?Number(v):null;
    items.set(t.rest_id,{id:t.rest_id,author:name,text,url:`https://x.com/${name}/status/${t.rest_id}`,createdAt:t.legacy.created_at??null,
      metrics:{likes:metric(t.legacy.favorite_count),replies:metric(t.legacy.reply_count),reposts:metric(t.legacy.retweet_count),views:metric(t.views?.count)}});
  }
  for(const i of instructions) {
    for(const e of i.entries??(i.entry?[i.entry]:[])){visit(e.content);for(const c of e.content?.items??[])visit(c.item);}
    for(const c of i.moduleItems??[])visit(c.item);
  }
  return {items:[...items.values()],cursor};
}
export class XClient {
  constructor({authToken,csrfToken,bearerToken,contracts,fetchImpl=fetch,transactionProvider,clientHeaders={},requestTimeouts={read:90_000,write:120_000}}) {
    for(const value of [authToken,csrfToken,bearerToken])if(typeof value!=='string'||!value||value.length>4096||!/^\S+$/.test(value)||/[;\r\n]/.test(value))throw new XError('SESSION_INVALID');
    if(['read','write'].some(key=>!Number.isSafeInteger(requestTimeouts?.[key])||requestTimeouts[key]<1||requestTimeouts[key]>600_000))throw new XError('REQUEST_TIMEOUT_INVALID');
    this.requestTimeouts={read:requestTimeouts.read,write:requestTimeouts.write};
    this.headers={authorization:`Bearer ${bearerToken}`,cookie:`auth_token=${authToken}; ct0=${csrfToken}`,'x-csrf-token':csrfToken,'x-twitter-auth-type':'OAuth2Session','x-twitter-active-user':'yes','x-twitter-client-language':'en','content-type':'application/json'};
    for(const key of ['user-agent','sec-ch-ua','sec-ch-ua-mobile','sec-ch-ua-platform'])if(clientHeaders[key]){if(typeof clientHeaders[key]!=='string'||/[\r\n]/.test(clientHeaders[key]))throw new XError('HEADER_INVALID');this.headers[key]=clientHeaders[key];}
    this.contracts=contracts.operations;this.fetch=fetchImpl;this.transactionProvider=transactionProvider;this.closed=false;
  }
  close(){this.headers={};this.closed=true;}
  async request(operation,variables) {
    if(this.closed)throw new XError('CLIENT_CLOSED');
    if(!['UserByScreenName','UserOriginalsTimeline','TweetDetail','CreateTweet','CreateNoteTweet'].includes(operation))throw new XError('OPERATION_DENIED');
    const c=this.contracts[operation];if(!c||!/^[\w-]+$/.test(c.queryId))throw new XError('CONTRACT_INVALID');
    const method=['CreateTweet','CreateNoteTweet'].includes(operation)?'POST':'GET';
    const url=new URL(`https://api.x.com/graphql/${c.queryId}/${operation}`); // web app base since 2026-09 (x.com/i/api returned 404 for CreateTweet 2026-09-28)
    const payload={variables,features:c.features,...Object.keys(c.fieldToggles??{}).length?{fieldToggles:c.fieldToggles}:{}};
    if(method==='GET')for(const [k,v] of Object.entries(payload))url.searchParams.set(k,JSON.stringify(v));
    const headers={...this.headers};
    if(this.transactionProvider){const value=await this.transactionProvider({method,path:url.pathname});if(typeof value!=='string'||!value||value.length>4096||!/^[\x21-\x7e]+$/.test(value))throw new XError('TRANSACTION_INVALID');headers['x-client-transaction-id']=value;}
    let response,text;
    try {
      response=await this.fetch(url,{method,headers,redirect:'error',signal:AbortSignal.timeout(method==='POST'?this.requestTimeouts.write:this.requestTimeouts.read),...(method==='POST'?{body:JSON.stringify({...payload,queryId:c.queryId})}:{})});
      let bytes=0;const chunks=[];for await(const chunk of response.body){bytes+=chunk.length;if(bytes>4_000_000)throw Error('size');chunks.push(chunk);}text=Buffer.concat(chunks).toString('utf8');
    }catch{throw new XError(method==='POST'?'WRITE_UNKNOWN':'TRANSPORT');}
    const mime=response.headers.get('content-type');
    const receipt={operation,method,origin:url.origin,path:url.pathname,status:response.status,mime:mime??null,bytes:Buffer.byteLength(text),sha256:hash(text),checkedAt:new Date().toISOString(),mode:'pure_http',transactionProvided:!!headers['x-client-transaction-id']};
    if(!response.ok)throw new XError(response.status===429?'RATE_LIMITED':response.status===401?'AUTH_REJECTED':response.status===403?'ACCESS_BLOCKED':'HTTP_ERROR',receipt);
    if(!mime?.includes('json'))throw new XError('NOT_JSON',receipt);
    let result;try{result=JSON.parse(text);}catch{throw new XError('NOT_JSON',receipt);}
    if(result.errors?.length||!result.data){
      // Numeric codes only (e.g. 344 daily limit, 226 automation): callers pause writes on them.
      receipt.serviceErrorCodes=(Array.isArray(result.errors)?result.errors:[]).map(e=>e?.code).filter(Number.isInteger);
      throw new XError('SERVICE_ERROR',receipt);
    }
    return {data:result.data,receipt};
  }
  async profile(handle){
    if(!handleOK(handle))throw new XError('HANDLE_INVALID');
    const {data,receipt}=await this.request('UserByScreenName',{screen_name:handle,withGrokTranslatedBio:true});
    const u=data.user?.result;const name=u?.core?.screen_name??u?.legacy?.screen_name;
    if(u?.__typename!=='User'||name?.toLowerCase()!==handle.toLowerCase()||!idOK(u.rest_id))throw new XError('IDENTITY_MISMATCH',receipt);
    return {id:u.rest_id,handle:name,receipt};
  }
  async timeline(handle,{pages=1,cursor}={}){
    if(!Number.isInteger(pages)||pages<1||pages>5||cursor!==undefined&&(typeof cursor!=='string'||cursor.length>4096))throw new XError('PAGE_INPUT');
    const user=await this.profile(handle);const items=new Map(),seen=new Set(),receipts=[user.receipt];let next=cursor;
    for(let i=0;i<pages;i++){
      if(next&&seen.has(next))break;if(next)seen.add(next);
      const {data,receipt}=await this.request('UserOriginalsTimeline',{userId:user.id,count:20,...next?{cursor:next}:{},includePromotedContent:true,withQuickPromoteEligibilityTweetFields:true,withVoice:true});
      const decoded=decode(data.user?.result?.timeline?.timeline?.instructions,handle);
      for(const item of decoded.items)items.set(item.id,item);receipts.push(receipt);next=decoded.cursor;if(!next)break;
    }
    return {items:[...items.values()],nextCursor:next??null,receipts,fullTimeline:false};
  }
  async detail(postId,handle){
    if(!idOK(postId)||!handleOK(handle))throw new XError('POST_INPUT');
    const {data,receipt}=await this.request('TweetDetail',{focalTweetId:postId,rankingMode:'Relevance',includePromotedContent:true,withCommunity:true,withQuickPromoteEligibilityTweetFields:true,withBirdwatchNotes:true,withVoice:true});
    const item=decode(data.threaded_conversation_with_injections_v2?.instructions,handle).items.find(t=>t.id===postId);
    if(!item)throw new XError('POST_MISMATCH',receipt);return {item,receipt};
  }
  async conversation(postId){
    if(!idOK(postId))throw new XError('POST_INPUT');
    const {data,receipt}=await this.request('TweetDetail',{focalTweetId:postId,with_rux_injections:false,rankingMode:'Relevance',includePromotedContent:true,withCommunity:true,withQuickPromoteEligibilityTweetFields:true,withBirdwatchNotes:true,withVoice:true});
    try{return {...decodeConversation(data.threaded_conversation_with_injections_v2?.instructions,postId),receipt};}catch{throw new XError('CONVERSATION_SCHEMA',receipt);}
  }
  async publish({text,expectedHandle,expectedUserId,jobId,journalDir='runtime',execute=false,semanticAnnotationOptions}){
    if(typeof text!=='string'||!text.trim()||!twitterText.parseTweet(text).valid||!handleOK(expectedHandle)||!idOK(expectedUserId)||!/^[A-Za-z0-9_-]{1,80}$/.test(jobId??''))throw new XError('PUBLISH_INPUT');
    const variables={tweet_text:text,media:{media_entities:[],possibly_sensitive:false},semantic_annotation_ids:[],disallowed_reply_options:null};
    if(semanticAnnotationOptions!==undefined){if(semanticAnnotationOptions.composition_signal_1!==true||semanticAnnotationOptions.source!=='UniversalLink'||Object.keys(semanticAnnotationOptions).length!==2)throw new XError('ANNOTATION_INVALID');variables.semantic_annotation_options=semanticAnnotationOptions;}
    if(!execute)return {dryRun:true,operation:'CreateTweet',text,expectedHandle,expectedUserId,jobId};
    const owner=await this.profile(expectedHandle);if(owner.id!==expectedUserId)throw new XError('EXPECTED_USER_MISMATCH');
    await mkdir(journalDir,{recursive:true});const file=path.join(journalDir,jobId+'.json');
    const state={jobId,expectedHandle,expectedUserId,textHash:hash(text),state:'submitting',startedAt:new Date().toISOString()};
    try{await writeFile(file,JSON.stringify(state),{flag:'wx',mode:0o600});}catch(e){throw new XError(e.code==='EEXIST'?'JOB_ALREADY_EXISTS':'JOURNAL_FAILED');}
    try{
      const {data,receipt}=await this.request('CreateTweet',variables);
      const outer=data.create_tweet?.tweet_results?.result;const tweet=outer?.tweet??outer;
      const postId=tweet?.rest_id??tweet?.legacy?.id_str;
      if(!idOK(postId))throw new XError('CREATE_SCHEMA');
      Object.assign(state,{state:'created_unverified',postId,receipt});await writeFile(file,JSON.stringify(state,null,2));
      const readback=await this.detail(postId,expectedHandle);
      if(readback.item.text!==text)throw new XError('READBACK_MISMATCH');
      state.state='verified';state.readbackReceipt=readback.receipt;await writeFile(file,JSON.stringify(state,null,2));return {item:readback.item,receipt,readbackReceipt:readback.receipt,verified:true};
    }catch(e){
      state.state=state.postId?'created_needs_review':'unknown_needs_review';state.error=e instanceof XError?e.code:'LOCAL_ERROR';
      const responseReceipt=e instanceof XError&&Number.isInteger(e.receipt?.status)?e.receipt:undefined;
      if(responseReceipt)state.responseReceipt=responseReceipt;
      await writeFile(file,JSON.stringify(state,null,2));
      throw new XError(state.state,{jobId,postId:state.postId,...responseReceipt?{responseReceipt}: {}});
    }
  }
}
export const loadContracts=async()=>JSON.parse(await readFile(new URL('../contracts/x.json',import.meta.url),'utf8'));
