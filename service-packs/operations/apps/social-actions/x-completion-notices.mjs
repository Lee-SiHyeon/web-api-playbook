import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { publishThread } from '../affiliate-api-hub/scripts/sns/writers/x.mjs';
import { replyTextMatches } from '../affiliate-api-hub/scripts/sns/writers/x-reply-readback.mjs';
import { inspectTweet } from './x-reactions.mjs';
const twitterText = createRequire(import.meta.url)('twitter-text');
export const noticePromotionId = '2105198250806726810';
const fail = code => { throw Object.assign(new Error(code),{code}); };
export function completionNoticeCandidates(state) {
  const rows=[];
  for(const [id, record] of Object.entries(state.records || {})) {
    const relation=state.relationships?.[id];
    if(record.status!=='verified' || relation?.visibility!=='present' || relation.followsMe!==true) continue;
    const handle=relation.handle;
    if(!/^[A-Za-z0-9_]{1,15}$/.test(handle || '')) continue;
    const follow=record.results?.follow?.readbackVerified===true && record.results.follow.following===true;
    const pinRequested=Boolean(record.pinnedPostId);
    const pin=pinRequested && record.results?.[record.pinnedPostId]?.like?.readbackVerified===true
      && record.results?.[record.pinnedPostId]?.repost?.readbackVerified===true
      && record.results?.reply?.readbackVerified===true && record.results.reply.ids?.length===1;
    const extras=record.additionalPostIds;
    const pairsVerified=Array.isArray(extras) && extras.length<=9 && new Set(extras).size===extras.length && extras.every(postId=>record.results[postId]?.like?.readbackVerified && record.results[postId]?.repost?.readbackVerified);
    const full=pairsVerified && (record.bonusStatus==='verified' || record.policyVersion===2);
    if(!full && (!follow || pinRequested && !pin)) continue;
    if(full && !follow && !pin && !extras.length) continue;
    const stage=full?'full':record.latestFallbackFinishedAt?'base_latest':'base';
    if(state.completionNotices?.[id]?.[stage] || state.completionNotices?.[id]?.full) continue;
    const deferred=Boolean(state.retroactiveCohort?.members?.[id] || record.qualifyingPostId || record.bonusQualification);
    const primarySource=record.primarySource==='latest_original'?'latest_original':'pinned';
    rows.push({id,handle,stage,follow,pin,primarySource,extraCount:full?extras.length:0,deferred,group:`${stage}-${follow}-${pin}-${primarySource}-${full?extras.length:deferred}`});
  }
  return rows.sort((a,b)=>Number(b.stage==='full')-Number(a.stage==='full'));
}
export function composeCompletionNotice(rows) {
  if(!rows.length || rows.length>3 || rows.some(r=>r.group!==rows[0].group || !/^[A-Za-z0-9_]{1,15}$/.test(r.handle))) fail('X_NOTICE_INPUT');
  const names=rows.map(r=>'@'+r.handle).join(' '), row=rows[0];
  const base=[row.follow!==false?'맞팔':null,row.pin?`${row.primarySource==='latest_original'?'최신글':'고정글'} 댓글·좋아요·리포스트`:null].filter(Boolean).join(' + ');
  if(row.stage==='full') return `${names} 님 감사합니다 💙\n${[base,row.extraCount?`추가 글 ${row.extraCount}건 좋아요·리포스트`:null].filter(Boolean).join(' + ')} 처리 완료했습니다!`;
  return `${names} 님 감사합니다 💙\n${base} 처리 완료했습니다!\n${row.deferred?'추가 혜택은 순차 처리 대기 중입니다. 참여 조건을 다시 채우실 필요는 없어요.':'추가 최대 9건 혜택은 이 고정글 좋아요 + 리포스트(인용도 인정)로 참여해주세요! 이미 참여하셨다면 확인 후 이어서 적용됩니다.'}`;
}
export function nextCompletionNotice(state, preferredIds=[]) {
  const pending=completionNoticeCandidates(state);
  const first=pending.find(r=>preferredIds.includes(r.id)) || pending[0];
  if(!first) return null;
  const rows=[first,...pending.filter(r=>r.id!==first.id && r.group===first.group)].slice(0,3);
  while(rows.length) {
    const text=composeCompletionNotice(rows);
    if(twitterText.parseTweet(text).valid) return {rows,text};
    if(rows.length===1) fail('X_NOTICE_TOO_LONG');
    rows.pop();
  }
}
export async function sendCompletionNotice(state,{saveState,publisher=publishThread,reader=inspectTweet,preferredIds=[],beforePublish=()=>{}}={}) {
  if(typeof saveState!=='function') fail('X_NOTICE_STATE_WRITER_REQUIRED');
  const plan=nextCompletionNotice(state,preferredIds);
  if(!plan) return null;
  const parent=await reader(noticePromotionId);
  if(parent.owner!=='lifehack__ailab' || parent.tweet.author!==parent.owner || parent.tweet.id!==noticePromotionId) fail('X_NOTICE_PARENT_MISMATCH');
  const batchId=createHash('sha256').update(`${noticePromotionId}:${plan.rows.map(r=>`${r.id}:${r.stage}`).sort().join(',')}`).digest('hex').slice(0,20);
  state.completionNotices ||= {}; state.completionNoticeBatches ||= {};
  const batch=state.completionNoticeBatches[batchId]={batchId,promotionId:noticePromotionId,runKey:`completion-notice-${batchId}`,text:plan.text,members:plan.rows,status:'reserved',reservedAt:new Date().toISOString()};
  for(const row of plan.rows) {state.completionNotices[row.id] ||= {};state.completionNotices[row.id][row.stage]=batchId;}
  await saveState(state);
  try {
    await beforePublish(batch);
    const result=await publisher([plan.text],{replyToId:noticePromotionId,runKey:batch.runKey});
    batch.ids=result.ids; await saveState(state);
    if(result.ids?.length!==1) fail('X_NOTICE_RECONCILIATION_REQUIRED');
    if(!result.readbackVerified) {
      const after=await reader(result.ids[0]);
      const actual=after.tweet.text.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
      if(after.owner!=='lifehack__ailab' || after.tweet.author!==after.owner || !replyTextMatches({text:actual,parentId:after.tweet.replyToId},plan.text,noticePromotionId)) fail('X_NOTICE_RECONCILIATION_REQUIRED');
    }
    batch.status='verified';batch.readbackVerified=true;batch.finishedAt=new Date().toISOString();await saveState(state);
    return {id:batch.ids[0],url:`https://x.com/lifehack__ailab/status/${batch.ids[0]}`,handles:plan.rows.map(r=>r.handle),stage:plan.rows[0].stage,readbackVerified:true};
  } catch(error) {batch.status='needs_reconciliation';batch.code=/^[A-Z0-9_]+$/.test(error.code || '')?error.code:'X_NOTICE_FAILED';await saveState(state);throw error;}
}
if(process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) {
  const root=path.join(process.env.LOCALAPPDATA,'affiliate-content-operations/x-followback-bot');
  try {
    const state=JSON.parse(await readFile(path.join(root,'state.json'),'utf8'));
    const plan=nextCompletionNotice(state);
    if(!process.argv.includes('--execute')) console.log(JSON.stringify({pending:completionNoticeCandidates(state).length,plan,writes:0}));
    else {
      let lock;try{lock=JSON.parse(await readFile(path.join(root,'worker.lock'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
      if(lock){try{process.kill(lock.pid,0);fail('X_BOT_ALREADY_RUNNING');}catch(e){if(e.code!=='ESRCH')throw e;}}
      console.log(JSON.stringify(await sendCompletionNotice(state,{saveState:value=>writeFile(path.join(root,'state.json'),JSON.stringify(value,null,2))})));
    }
  }catch(error){console.log(JSON.stringify({success:false,code:error.code || 'X_NOTICE_FAILED'}));process.exitCode=2;}
}
