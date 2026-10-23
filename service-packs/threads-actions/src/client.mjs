import {createHash,randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {ThreadsError} from './errors.mjs';
import {ORIGIN,handleOK,codeOK,postIdOK,fetchProfilePosts,fetchViews} from './public.mjs';
export {ThreadsError};

const hash=t=>createHash('sha256').update(t).digest('hex');
const MAX_CHAIN=10;
const MAX_TEXT=500; // local guard only; the server-side limit is not established by the ported evidence

// Evidence (ported from affiliate-content-operations/apps/affiliate-api-hub/scripts/sns/writers/threads.mjs):
// logged-in BarcelonaComposerAPI excerpt `function f(e){` emits these snake-case keys.
export function buildTextPostAppInfo({caption,replyId,replyControl,linkPreviewURL,selfThreadContextId}){
  const info={community_flair_id:null,entry_point:'main_tab_bar',excluded_inline_media_ids:JSON.stringify([]),
    fediverse_composer_enabled:true,gif_media_id:null,is_genai_invocation_post:false,is_reply_approval_enabled:false,
    is_spoiler_media:false,link_attachment_url:linkPreviewURL||null,link_preview_default_render_style:null,
    quoted_post_id:null,ranking_info_token:null,reply_control:replyControl??0,reply_id:replyId??undefined,
    self_thread_context_id:selfThreadContextId,snippet_attachment:null,special_effects_enabled_str:null,tag_header:null,
    text_with_entities:{entities:[],text:caption}};
  return JSON.stringify(info);
}

// Evidence: logged-in excerpt key `configure_text_only_post` (route, form encoding, chain fields).
// Returns the request WITHOUT credentials; headers are attached by the provider at send time.
export function buildTextOnlyConfigureRequest({caption,uploadId,chainId,chainIndex,chainLength,replyId,replyControl,linkPreviewURL,selfThreadContextId,webSessionId}){
  if(typeof caption!=='string'||!caption.trim())throw new ThreadsError('THREADS_CAPTION_INVALID');
  if(!uploadId)throw new ThreadsError('THREADS_UPLOAD_ID_REQUIRED');
  const fields={audience:'default',
    ...(replyId!=null?{barcelona_source_reply_id:String(replyId)}:{}),
    caption,...(chainId?{chain_id:chainId}:{}),
    ...(chainIndex!==undefined?{chain_index:String(chainIndex)}:{}),
    ...(chainLength!==undefined?{chain_length:String(chainLength)}:{}),
    creator_geo_gating_info:JSON.stringify({whitelist_country_codes:[]}),internal_features:'',should_include_permalink:'true',
    text_post_app_info:buildTextPostAppInfo({caption,replyId,replyControl,linkPreviewURL,selfThreadContextId}),
    ...(webSessionId?{web_session_id:webSessionId}:{}),
    is_threads:'true',is_upload_type_override_allowed:'1',publish_mode:'text_post',upload_id:String(uploadId)};
  return {method:'POST',url:`${ORIGIN}/api/v1/media/configure_text_only_post/`,
    // Fetch-metadata headers: Meta refused API calls without them ("SecFetch Policy violation", source comment 2026-09-28).
    headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8',Origin:ORIGIN,Referer:`${ORIGIN}/`,
      'Sec-Fetch-Site':'same-origin','Sec-Fetch-Mode':'cors','Sec-Fetch-Dest':'empty','X-Requested-With':'XMLHttpRequest'},
    body:new URLSearchParams(fields).toString()};
}

// Ported response parser. PENDING (post_client_id) is reported, not polled: the status-poll query needs an
// authenticated Relay context (fb_dtsg) that this repo does not port yet.
export function parseCreateResponse(payload){
  const firstPost=Array.isArray(payload?.posts)?payload.posts[0]:null;
  const firstMedia=Array.isArray(payload?.medias)?payload.medias[0]:null;
  const st=String(firstPost?.status??'').toUpperCase();
  if(st==='ERROR')throw new ThreadsError('THREADS_CREATE_REJECTED');
  const providerStatus=typeof payload?.status==='string'?payload.status.toLowerCase():null;
  if(payload?.error||payload?.errors?.length||(providerStatus&&providerStatus!=='ok'))throw new ThreadsError('THREADS_CREATE_REJECTED');
  if(st==='PENDING')return {pending:true,id:null,permalink:null};
  const media=payload?.media??payload?.data?.media??firstPost?.media??firstPost?.post??firstPost??firstMedia;
  const id=media?.pk??media?.id??payload?.id;
  if(!postIdOK(id))throw new ThreadsError('THREADS_CREATE_SCHEMA');
  let permalink=null;
  try{const u=new URL(media?.permalink??payload?.permalink);
    if(u.origin===ORIGIN&&/^\/@[A-Za-z0-9_.]{1,30}\/post\/[A-Za-z0-9_-]{5,30}\/?$/.test(u.pathname)&&!u.search&&!u.hash)permalink=u.href;}catch{}
  return {pending:false,id:String(id),permalink};
}

const errorFor=status=>status===401||status===403?'AUTH_REJECTED':status===429?'RATE_LIMITED':`THREADS_HTTP_${status}`;

export class ThreadsClient{
  constructor({fetchImpl=globalThis.fetch,provider,timeoutMs=20000,uuid=randomUUID}={}){Object.assign(this,{fetchImpl,provider,timeoutMs,uuid});}
  profile(handle,{limit=5}={}){return fetchProfilePosts(handle,limit,{fetchImpl:this.fetchImpl});}
  views(input){return fetchViews(input,{fetchImpl:this.fetchImpl});}

  plan({posts,replyId,replyControl,linkPreviewURL}){
    const chainId=this.uuid(),ctx=this.uuid();
    return posts.map((caption,i)=>buildTextOnlyConfigureRequest({caption,uploadId:this.uuid(),chainId,chainIndex:i,chainLength:posts.length,
      replyId:i===0?replyId:'<previous post id>',replyControl,linkPreviewURL:i===0?linkPreviewURL:undefined,selfThreadContextId:ctx}));
  }

  async publish({posts,text,replyId,replyControl,linkPreviewURL,expectedOwner,expectedOwnerId,jobId,journalDir='runtime',execute=false,media}){
    if(text!==undefined&&posts===undefined)posts=[text];
    if(media!==undefined)throw new ThreadsError('THREADS_MEDIA_PUBLISH_UNVERIFIED');
    if(!Array.isArray(posts)||posts.length<1||posts.length>MAX_CHAIN||posts.some(p=>typeof p!=='string'||!p.trim()||[...p].length>MAX_TEXT)
      ||!handleOK(expectedOwner)||!/^\d{1,25}$/.test(expectedOwnerId??'')||!/^[A-Za-z0-9_-]{1,80}$/.test(jobId??'')
      ||(replyId!=null&&!postIdOK(replyId))||(linkPreviewURL!=null&&!/^https:\/\//.test(linkPreviewURL)))throw new ThreadsError('PUBLISH_INPUT');
    if(!execute){
      const requests=this.plan({posts,replyId,replyControl,linkPreviewURL}).map(r=>({method:r.method,url:r.url,headerNames:Object.keys(r.headers),bodyBytes:Buffer.byteLength(r.body),bodySha256:hash(r.body)}));
      return {dryRun:true,operation:'configure_text_only_post',posts:posts.length,expectedOwner,expectedOwnerId,jobId,requests,credentialHeaders:'attached_by_provider_at_send'};
    }
    if(!this.provider)throw new ThreadsError('PROVIDER_REQUIRED');
    const c=this.provider.credentials;
    if(c.owner?.toLowerCase()!==expectedOwner.toLowerCase()||c.ownerId!==expectedOwnerId)throw new ThreadsError('EXPECTED_OWNER_MISMATCH');
    await mkdir(journalDir,{recursive:true});const file=path.join(journalDir,jobId+'.json');
    const state={jobId,expectedOwner,expectedOwnerId,postHashes:posts.map(hash),state:'submitting',created:[],startedAt:new Date().toISOString()};
    try{await writeFile(file,JSON.stringify(state),{flag:'wx',mode:0o600});}catch(e){throw new ThreadsError(e.code==='EEXIST'?'JOB_ALREADY_EXISTS':'JOURNAL_FAILED');}
    const save=()=>writeFile(file,JSON.stringify(state,null,2));
    const chainId=this.uuid(),ctx=this.uuid();
    try{
      for(let i=0;i<posts.length;i++){
        const parent=i===0?replyId:state.created[i-1].id;
        const req=buildTextOnlyConfigureRequest({caption:posts[i],uploadId:this.uuid(),chainId,chainIndex:i,chainLength:posts.length,
          replyId:parent,replyControl,linkPreviewURL:i===0?linkPreviewURL:undefined,selfThreadContextId:ctx,webSessionId:c.webSessionId});
        state.intent={index:i,method:req.method,path:new URL(req.url).pathname,bodySha256:hash(req.body),at:new Date().toISOString()};await save();
        let res;
        try{res=await this.fetchImpl(req.url,{method:req.method,redirect:'error',body:req.body,signal:AbortSignal.timeout(this.timeoutMs),headers:{...req.headers,...this.provider.headersFor(req.url)}});}
        catch{throw new ThreadsError('TRANSPORT_OUTCOME_UNKNOWN');}
        // 202 is not retried here (the ported source retried it); the outcome is left for review.
        if(res.status===202)throw new ThreadsError('THREADS_HTTP_202_OUTCOME_UNKNOWN');
        if(!res.ok)throw new ThreadsError(errorFor(res.status));
        let payload;try{payload=JSON.parse((await res.text()).replace(/^for \(;;\);\s*/,''));}catch{throw new ThreadsError('THREADS_RESPONSE_NOT_JSON');}
        const created=parseCreateResponse(payload);
        if(created.pending)throw new ThreadsError('THREADS_CREATE_PENDING');
        state.created.push({index:i,id:created.id,permalink:created.permalink});delete state.intent;state.state='created_unverified';await save();
      }
      const readback=await this.readback(expectedOwner,posts,state.created);
      state.readback=readback;state.state=readback.verified?'verified':'created_needs_review';await save();
      return {created:state.created,readback,verified:readback.verified,journal:file};
    }catch(e){
      if(state.state==='verified')throw e;
      state.state=state.created.length?'created_needs_review':'unknown_needs_review';
      if(e.code==='AUTH_REJECTED'||e.code==='THREADS_CREATE_REJECTED'||e.code==='THREADS_CREATE_SCHEMA'||/^THREADS_HTTP_4/.test(e.code||''))state.lastResponse='http_answered';
      state.error=e instanceof ThreadsError?e.code:'LOCAL_ERROR';await save();
      throw new ThreadsError(state.state,{jobId,error:state.error,created:state.created});
    }
  }

  // Public-window readback via the anonymous profile reader. Only proves what the latest public window shows.
  async readback(handle,posts,created){
    try{
      const {items,receipt}=await this.profile(handle,{limit:30});
      const matched=created.map((c,i)=>{const code=c.permalink?.match(/\/post\/([A-Za-z0-9_-]+)/)?.[1];
        const item=items.find(it=>(code&&it.code===code)||(it.id&&it.id===c.id));
        return {id:c.id,found:Boolean(item),textMatches:item?item.text===posts[i]:false};});
      return {method:'public_profile_window',verified:matched.every(m=>m.found&&m.textMatches),matched,receipt};
    }catch(e){return {method:'public_profile_window',verified:false,reason:e.code||'READBACK_FAILED'};}
  }
}

export const loadContracts=async()=>JSON.parse(await readFile(new URL('../contracts/threads.json',import.meta.url),'utf8'));
