import { readFile, mkdir, open, writeFile, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withXReadContext } from './providers/x.mjs';
import { reserveXWrite, noteXWriteRejection } from '../affiliate-api-hub/scripts/sns/writers/x-write-gate.mjs';

const followerContract = JSON.parse(await readFile(new URL('./contracts/x-followers.json', import.meta.url), 'utf8'));
// Exact request envelopes captured on 2026-09-30; capture requests were aborted before transmission.
const contracts = { like: { queryId: 'lI07N6Otwv1PhnEgXILM7A', operation: 'FavoriteTweet', state: 'favorited' }, repost: { queryId: 'mbRO74GrOvSfRcJnlMapnQ', operation: 'CreateRetweet', state: 'retweeted' } };
const readPath = '/i/api/graphql/blErEeZkos5TDrWmrCp7cw/TweetDetail';
const fail = (code, receipt) => { throw Object.assign(new Error(code), { code, ...(receipt ? { receipt } : {}) }); };
// X answers some refused mutations with HTTP 200, an empty `data` object and an error such as
// 344 "daily limit for sending Tweets and messages" (observed 2026-10-02), 226 (automation
// suspected), 185 (status update limit) or 88 (rate limit). Nothing was created, so the
// journal records an explicit rejection instead of an unknown outcome.
export const X_REACTION_REJECTION_CODES = Object.freeze([88, 185, 226, 344]);
export const REACTION_ALREADY_APPLIED_CODES = Object.freeze([139, 327]);
export function explicitReactionRejection(raw) {
  let body; try { body = JSON.parse(raw); } catch { return null; }
  const errors = Array.isArray(body?.errors) ? body.errors : [];
  const data = body?.data;
  if (!errors.length || !errors.every(error => X_REACTION_REJECTION_CODES.includes(error?.code))) return null;
  if (data !== undefined && (data === null || typeof data !== 'object' || Object.keys(data).length)) return null;
  return [...new Set(errors.map(error => error.code))];
}

export function decodeTweet(data, id) {
  const matches = [];
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    if (value.rest_id === id && value.__typename === 'Tweet' && value.legacy) matches.push(value);
    for (const child of Object.values(value)) if (child && typeof child === 'object') walk(child);
  };
  walk(data);
  const tweet = matches[0];
  const author = tweet?.core?.user_results?.result?.core?.screen_name;
  if (!tweet || !author || typeof tweet.legacy.favorited !== 'boolean' || typeof tweet.legacy.retweeted !== 'boolean') fail('X_TWEET_STATE_UNVERIFIED');
  if (matches.some(t => t.legacy.favorited !== tweet.legacy.favorited || t.legacy.retweeted !== tweet.legacy.retweeted)) fail('X_TWEET_STATE_CONFLICT');
  let text = tweet.note_tweet?.note_tweet_results?.result?.text ?? tweet.legacy.full_text;
  text=text.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
  for (const url of tweet.legacy.entities?.urls || []) if (typeof url.url === 'string' && typeof url.expanded_url === 'string') text = text.split(url.url).join(url.expanded_url);
  return { id, author, authorId:tweet.core?.user_results?.result?.rest_id||null, lang:tweet.legacy.lang||null, text, quotedPostId:tweet.legacy.quoted_status_id_str||null, editControl: tweet.edit_control || tweet.edit_control_initial || null, displayRange: tweet.legacy.display_text_range || null, mentions: (tweet.legacy.entities?.user_mentions || []).map(u => u.screen_name), replyToId: tweet.legacy.in_reply_to_status_id_str || null, createdAt: tweet.legacy.created_at, favorited: tweet.legacy.favorited, retweeted: tweet.legacy.retweeted };
}

async function readTweet(context, id) {
  const url = new URL(readPath, 'https://x.com');
  url.searchParams.set('variables', JSON.stringify({ focalTweetId: id, with_rux_injections: false, rankingMode: 'Relevance', includePromotedContent: true, withCommunity: true, withQuickPromoteEligibilityTweetFields: true, withBirdwatchNotes: true, withVoice: true }));
  url.searchParams.set('features', JSON.stringify(followerContract.features));
  url.searchParams.set('fieldToggles', JSON.stringify({ withPayments: false, withArticleRichContentState: true, withArticlePlainText: false, withArticleSummaryText: true, withArticleVoiceOver: true, withGrokAnalyze: false, withDisallowedReplyControls: false }));
  const response = await context.request('GET', readPath, url.href);
  if (response.status !== 200) fail('X_TWEET_READ_REJECTED', { operation:'TweetDetail',httpStatus: response.status,rateLimitLimit:/^\d+$/.test(response.headers['x-rate-limit-limit']||'')?Number(response.headers['x-rate-limit-limit']):null,rateLimitRemaining:/^\d+$/.test(response.headers['x-rate-limit-remaining']||'')?Number(response.headers['x-rate-limit-remaining']):null, rateLimitReset: /^\d+$/.test(response.headers['x-rate-limit-reset'] || '') ? Number(response.headers['x-rate-limit-reset']) : null, retryAfterSeconds: /^\d+$/.test(response.headers['retry-after'] || '') ? Number(response.headers['retry-after']) : null });
  let data; try { data = JSON.parse(response.raw); } catch { fail('X_TWEET_READ_INVALID'); }
  if (data.errors?.length) fail('X_TWEET_READ_INVALID');
  return decodeTweet(data, id);
}

export async function inspectTweet(id,{withContext=withXReadContext}={}) {
  if (!/^\d{1,25}$/.test(id || '')) fail('X_REACTION_INPUT_INVALID');
  return withContext(async context => ({ owner: context.ownerHandle, tweet: await readTweet(context, id), browserUsed: false }));
}

async function reactOperations({tweetId,expectedAuthor,execute=false},operations,{withContext=withXReadContext,journalRoot=path.join(process.env.LOCALAPPDATA||process.cwd(),'affiliate-content-operations','x-reactions'),isStopped=async()=>false,
  writeGate=process.env.NODE_TEST_CONTEXT?null:reserveXWrite,noteRejection=process.env.NODE_TEST_CONTEXT?async()=>null:noteXWriteRejection}={}) {
  if(!/^\d{1,25}$/.test(tweetId||'')||!/^[A-Za-z0-9_]{1,15}$/.test(expectedAuthor||''))fail('X_REACTION_INPUT_INVALID');
  const run=async({dispatch=false,gateReserved=false,expectedIdentity=null}={})=>withContext(async context=>{
    if(typeof context.ownerHandle!=='string'||!/^[A-Za-z0-9_]{1,15}$/.test(context.ownerHandle)
      ||typeof context.ownerFingerprint!=='string'||!context.ownerFingerprint.trim())fail('X_REACTION_OWNER_UNVERIFIED');
    const identity={ownerHandle:context.ownerHandle.toLowerCase(),ownerFingerprint:context.ownerFingerprint};
    if(expectedIdentity&&(identity.ownerHandle!==expectedIdentity.ownerHandle||identity.ownerFingerprint!==expectedIdentity.ownerFingerprint))fail('X_REACTION_OWNER_CHANGED');
    const before=await readTweet(context,tweetId);
    if(before.author.toLowerCase()!==expectedAuthor.toLowerCase()||before.author.toLowerCase()===context.ownerHandle.toLowerCase())fail('X_REACTION_TARGET_MISMATCH');
    const results={},pending=[];
    for(const operation of operations){
      const contract=contracts[operation];
      const receipt={owner:context.ownerHandle,operation,tweetId,target:before.author,browserUsed:false,executionMode:'pure_http',currentState:before,writes:0,readbackVerified:false};
      results[operation]=receipt;
      if(!execute){receipt.ready=true;continue;}
      pending.push({operation,contract,receipt,journal:path.join(journalRoot,`${context.ownerFingerprint}-${operation}-${tweetId}.json`)});
    }
    if(!execute||!pending.length)return {result:results,identity};
    await mkdir(journalRoot,{recursive:true});
    // Reconcile each operation independently only from a positive current readback.
    const hold=row=>fail('X_REACTION_RECONCILIATION_REQUIRED',{operation:row.contract.operation,writeSent:false,currentAttemptWrites:0,journalReconciliationHold:true});
    const historical=await readdir(journalRoot);
    const mutations=[];
    for(const row of pending){
      if(historical.some(name=>name.startsWith(path.basename(row.journal)+'.not-applied-')))hold(row);
      let previous=null;
      try{previous=JSON.parse(await readFile(row.journal,'utf8'));}catch(error){if(error.code!=='ENOENT')hold(row);}
      if(previous?.status==='rejected'&&previous.owner===context.ownerHandle&&previous.operation===row.operation&&previous.tweetId===tweetId
        &&Array.isArray(previous.xErrorCodes)&&previous.xErrorCodes.length&&previous.xErrorCodes.every(code=>X_REACTION_REJECTION_CODES.includes(code))
        &&before[row.contract.state]===false){
        if(!dispatch||row.operation==='repost'&&!gateReserved){mutations.push(row);continue;}
        // The refused send created nothing; archive its journal so this attempt gets a fresh one.
        await rename(row.journal,`${row.journal}.rejected-${Date.now()}`);previous=null;
      }
      if(previous){
        if(previous.owner!==context.ownerHandle||previous.operation!==row.operation||previous.tweetId!==tweetId||previous.target?.toLowerCase()!==expectedAuthor.toLowerCase())hold(row);
        if(['needs_reconciliation','reserved'].includes(previous.status)){
          // A like/repost is a state, not a new object: the wanted end state is reached
          // whoever's request set it, so a true readback closes the journal.
          if(before[row.contract.state]===true){
            await writeFile(row.journal,JSON.stringify({...previous,status:'verified',readbackVerified:true,reconciledAt:new Date().toISOString(),currentState:before}));
            Object.assign(row.receipt,{success:true,noOp:true,readbackVerified:true,status:'verified'});
            continue;
          }
          // A false state, even much later, cannot prove that the previous send never applied.
          hold(row);
        }
        if(previous.status==='verified'&&before[row.contract.state]===true){
          Object.assign(row.receipt,{success:true,noOp:true,readbackVerified:true,status:'verified'});
          continue;
        }
        hold(row);
      }
      if(before[row.contract.state]===true){Object.assign(row.receipt,{success:true,noOp:true,readbackVerified:true});continue;}
      mutations.push(row);
    }
    if(!mutations.length)return {result:results,identity};
    const requiresGate=mutations.some(row=>row.operation==='repost');
    if(!dispatch||requiresGate&&!gateReserved)return {requiresDispatch:true,requiresGate,identity};
    for(const row of mutations){
      let handle;try{handle=await open(row.journal,'wx');}catch(error){if(error.code==='EEXIST')hold(row);throw error;}
      try{await handle.writeFile(JSON.stringify({...row.receipt,status:'reserved',checkedAt:new Date().toISOString()}));await handle.sync();}finally{await handle.close();}
      row.receipt.writes=1;
    }

    for(const row of mutations){
      if(await isStopped())fail('X_REACTION_STOPPED');
      const route=`/i/api/graphql/${row.contract.queryId}/${row.contract.operation}`;
      let response;
      // Persist that the send is uncertain before crossing the transport boundary.
      await writeFile(row.journal,JSON.stringify({...row.receipt,status:'needs_reconciliation'}));
      try{response=await context.request('POST',route,new URL(route,'https://x.com').href,JSON.stringify({variables:{tweet_id:tweetId},queryId:row.contract.queryId}));}
      catch(error){fail('X_REACTION_RECONCILIATION_REQUIRED',{operation:row.contract.operation,writeSent:true,...error.receipt});}
      row.receipt.httpStatus=response.status;
      await writeFile(row.journal,JSON.stringify({...row.receipt,status:'needs_reconciliation'}));
      // 139 "already favorited" / 327 "already retweeted": the state is set; the readback below confirms it.
      let accepted;try{const data=JSON.parse(response.raw);accepted=data&&typeof data==='object'
        &&(!data.errors?.length||data.errors.every(error=>REACTION_ALREADY_APPLIED_CODES.includes(error?.code)));}catch{}
      const rejectedCodes=response.status===200?explicitReactionRejection(response.raw):null;
      if(rejectedCodes){
        await writeFile(row.journal,JSON.stringify({...row.receipt,status:'rejected',xErrorCodes:rejectedCodes,rejectedAt:new Date().toISOString()}));
        await noteRejection(rejectedCodes).catch(()=>null);
        // Same code as before so every worker keeps its retry/hold path; the receipt says nothing was applied.
        fail('X_REACTION_RECONCILIATION_REQUIRED',{operation:row.contract.operation,httpStatus:200,writeSent:true,
          explicitRejection:true,applied:false,xErrorCodes:rejectedCodes});
      }
      if(response.status!==200||!accepted)fail('X_REACTION_RECONCILIATION_REQUIRED',{operation:row.contract.operation,httpStatus:response.status,writeSent:true,rateLimitReset:/^\d+$/.test(response.headers?.['x-rate-limit-reset']||'')?Number(response.headers['x-rate-limit-reset']):null});
    }
    let after;
    try{after=await readTweet(context,tweetId);}catch(error){
      const wrapped=new Error(error?.message||'X_TWEET_READBACK_FAILED',{cause:error});
      if(error?.name)wrapped.name=error.name;
      if(error?.code)wrapped.code=error.code;
      if(error?.detail!==undefined)wrapped.detail=error.detail;
      if(error?.stack)wrapped.stack=error.stack;
      wrapped.receipt={...(error?.receipt||{}),writeSent:mutations.length>0,mutationCount:mutations.length};
      throw wrapped;
    }
    for(const row of pending){
      const {operation}=row;
      const success=after.author.toLowerCase()===before.author.toLowerCase()&&after[contracts[operation].state]===true;
      Object.assign(results[operation],{success,readbackVerified:success,live_replay:success,currentState:after,status:success?'verified':'needs_reconciliation'});
    }
    for(const row of mutations)await writeFile(row.journal,JSON.stringify(row.receipt));
    return {result:results,identity};
  });
  // Reconcile existing journals from a read without waiting on the write gate.
  // New repost mutations reserve budget outside the X session, then re-read and
  // revalidate every journal under the lock before dispatch.
  const usesCountedWriteGate=execute&&operations.includes('repost')&&writeGate;
  if(!usesCountedWriteGate)return (await run({dispatch:true,gateReserved:true})).result;
  const preflight=await run();
  if(!preflight.requiresDispatch)return preflight.result;
  let gateReserved=false,reservation=null;
  if(preflight.requiresGate){reservation=await writeGate({operation:'CreateRetweet',isStopped});gateReserved=true;}
  let committed=await run({dispatch:true,gateReserved,expectedIdentity:preflight.identity});
  // If state changed between the preflight and locked revalidation, wait for any
  // newly required repost budget without retaining the session lock, then check again.
  if(committed.requiresDispatch&&committed.requiresGate&&!gateReserved){
    reservation=await writeGate({operation:'CreateRetweet',isStopped});gateReserved=true;
    committed=await run({dispatch:true,gateReserved,expectedIdentity:preflight.identity});
  }
  // The locked re-read found the repost already present: no counted write went out, so return the slot.
  if(reservation?.release&&committed.result?.repost&&committed.result.repost.writes!==1)await reservation.release().catch(()=>false);
  return committed.result;
}
// Older journals stored no error codes. Mark one rejected only from its protected debug record:
// the exact POST for this tweet and operation, an explicit rejection body, and a false readback now.
export async function reconcileRejectedFromDebug({operation,tweetId,debugRecordId},{withContext=withXReadContext,
  readDebug=async id=>(await import('./lib/bot-debug-log.mjs')).readProtectedBotDebug('x',id),
  journalRoot=path.join(process.env.LOCALAPPDATA||process.cwd(),'affiliate-content-operations','x-reactions')}={}) {
  const contract=contracts[operation];
  if(!contract||!/^\d{1,25}$/.test(tweetId||'')||!/^[0-9a-f-]{36}$/.test(debugRecordId||''))fail('X_REACTION_INPUT_INVALID');
  const record=await readDebug(debugRecordId);
  const text=body=>body?.encoding==='utf8'?String(body.value||''):Buffer.from(body?.value||'','base64').toString('utf8');
  let url,requestBody;try{url=new URL(record.request?.url);requestBody=JSON.parse(text(record.request?.body));}catch{}
  const raw=text(record.response?.body);
  const codes=explicitReactionRejection(raw);
  if(record.request?.method!=='POST'||!url?.pathname.endsWith(`/${contract.operation}`)||requestBody?.variables?.tweet_id!==tweetId
    ||record.response?.status!==200||!codes)fail('X_REACTION_REJECTION_EVIDENCE_MISMATCH');
  return withContext(async context=>{
    const journal=path.join(journalRoot,`${context.ownerFingerprint}-${operation}-${tweetId}.json`);
    const previous=JSON.parse(await readFile(journal,'utf8'));
    if(previous.status!=='needs_reconciliation'||previous.owner!==context.ownerHandle||previous.operation!==operation
      ||previous.tweetId!==tweetId||previous.httpStatus!==200)fail('X_REACTION_JOURNAL_NOT_RECONCILABLE');
    const current=await readTweet(context,tweetId);
    if(current[contract.state]!==false)fail('X_REACTION_STATE_NOT_FALSE');
    await writeFile(journal,JSON.stringify({...previous,status:'rejected',xErrorCodes:codes,rejectedAt:record.at||null,
      rejectionEvidence:{debugRecordId,checkedAt:new Date().toISOString(),currentState:{[contract.state]:false}}}));
    return {operation,tweetId,status:'rejected',xErrorCodes:codes};
  });
}
export async function react(input,options) {
  if(!contracts[input.operation])fail('X_REACTION_INPUT_INVALID');
  return (await reactOperations(input,[input.operation],options))[input.operation];
}
export async function reactPair(input,options) {
  return reactOperations(input,['like','repost'],options);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [operation, tweetId, expectedAuthor, flag] = process.argv.slice(2);
  react({ operation, tweetId, expectedAuthor, execute: flag === '--execute' }).then(result => { console.log(JSON.stringify(result)); if (result.success === false) process.exitCode = 2; }).catch(error => { console.log(JSON.stringify({ success: false, code: /^[A-Z_]+$/.test(error.code || '') ? error.code : 'X_REACTION_FAILED' })); process.exitCode = 2; });
}
