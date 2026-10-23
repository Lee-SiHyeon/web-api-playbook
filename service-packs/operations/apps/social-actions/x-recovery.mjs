// Recovery never repeats a mutation. Account reservations survive process restarts.
export function readRetryAt(error,{phase='read',failures=1,now=Date.now()}={}) {
 if(phase!=='read'||error?.receipt?.writeSent===true)return null;
 if(error?.code==='SESSION_LOCK_BUSY')return now+60000;
 if(error?.code==='X_TRANSACTION_BOOTSTRAP_FAILED')return now+60000;
 if(error?.code==='X_READ_BUDGET_WAIT'&&error.receipt?.localBudget===true)return Math.max(now+1000,error.receipt.readBudgetRetryAt||(error.receipt.rateLimitReset||0)*1000);
 const r=error?.receipt||{},status=r.httpStatus??r.status;
 if(error?.code==='X_SEARCH_SERVICE_UNAVAILABLE'&&status===200&&r.operation==='SearchTimeline'&&r.writeSent===false)
   return Math.max(now+Math.min(600,30*2**Math.min(5,Math.max(0,failures-1)))*1000,
     now+(r.retryAfterSeconds||0)*1000,r.rateLimitRemaining===0?(r.rateLimitReset||0)*1000:0);
 if(status===429)return Math.max(now+300000,(r.rateLimitReset||0)*1000,now+(r.retryAfterSeconds||0)*1000);
 if(['X_READ_TIMEOUT','X_ACTION_SESSION_STORE_FAILED'].includes(error?.code) && (status == null || status === 200 && r.writeSent === false)
   && (error.code === 'X_READ_TIMEOUT' || r.store?.timedOut === true))
   return now+Math.min(1800,60*2**Math.min(5,Math.max(0,failures-1)))*1000;
 if(['X_BOOTSTRAP_UNAVAILABLE','X_MAIN_ASSET_UNAVAILABLE','X_MAIN_CONTRACT_INCOMPLETE'].includes(error?.code)&&![401,403].includes(status))return now+60000;
 if(['X_SEARCH_REJECTED','X_CONVERSATION_REJECTED','X_FOLLOWERS_READ_REJECTED'].includes(error?.code)&&status===404
   && (r.mime==='application/json'||r.mime===''&&(r.bodyBytes===undefined||r.bodyBytes===0)))
   return now+Math.min(1800,300*2**Math.min(3,Math.max(0,failures-1)))*1000;
 return null;
}
export function recoveryDecision({status={},state={records:{}},alive=false,stop=false,now=Date.now(),deadline=Infinity,attempts=0,nextAttemptAt=0}={}) {
 if(stop||now>=deadline||['stopped','expired','completed_burst_capacity'].includes(status.status))return {action:'stop'};
 if(alive)return {action:'observe'};
 if(attempts>=5)return {action:'hold',reason:'RESTART_BUDGET_EXHAUSTED'};
 if(now<nextAttemptAt)return {action:'wait',retryAt:nextAttemptAt};
 const receipt=status.receipt??{httpStatus:status.httpStatus};
 if(receipt.localBudget&&receipt.readBudgetRetryAt>now)return {action:'wait',retryAt:receipt.readBudgetRetryAt};
 if((receipt.httpStatus??receipt.status)===429) {
  const serverNotBefore=Math.max((receipt.rateLimitReset||0)*1000,Date.parse(status.retryAt||'')||0);
  if(now<serverNotBefore)return {action:'wait',retryAt:serverNotBefore};
 }
 // Protected tweet reads can happen inside account processing; the enclosing
 // work phase must not misclassify an observed read rejection as a mutation.
 const readRejected=['X_TWEET_READ_REJECTED','X_SEARCH_REJECTED','X_SEARCH_SERVICE_UNAVAILABLE','X_CONVERSATION_REJECTED','X_FOLLOWERS_READ_REJECTED'].includes(status.code);
 const read=readRetryAt({code:status.code,receipt:status.receipt??{httpStatus:status.httpStatus,mime:status.mime}} ,{now,phase:readRejected?'read':status.workPhase==='processing'?'write':'read'});
 const held=Object.values(state.records||{}).some(r=>r.handle===status.currentHandle&&(['reserved','held','needs_reconciliation'].includes(r.status)||['reserved','needs_reconciliation'].includes(r.bonusStatus)));
 const uncertain=['X_CREATE_SCHEMA','SERVICE_ERROR','WRITE_UNKNOWN','X_INVITE_REPLY_UNCERTAIN','SNS_JOURNAL_RECONCILIATION_REQUIRED','X_REACTION_RECONCILIATION_REQUIRED'].includes(status.code)
   ||['X_TWEET_READ_REJECTED','X_READ_BUDGET_WAIT'].includes(status.code)&&receipt.writeSent===true;
 const notice=state.completionNoticeBatches?.[status.currentNoticeBatchId];
 const heldNotice=status.workPhase==='notice_write'&&receipt.operation==='CreateTweet'
   &&notice?.batchId===status.currentNoticeBatchId&&notice?.status==='needs_reconciliation'
   &&notice.code===status.code&&Array.isArray(notice.members)&&notice.members.length>0
   &&notice.members.every(row=>state.completionNotices?.[row.id]?.[row.stage]===notice.batchId);
 // A session-lock timeout can follow a persisted account reservation. Keep
 // that account held while restarting the worker to serve the remaining queue.
 const heldSessionContention=status.code==='SESSION_LOCK_BUSY'&&held;
 const heldReflectionRepost=status.code==='X_REFLECTION_REPOST_UNVERIFIED'&&Object.values(state.records||{}).some(r=>
  r.handle===status.currentHandle&&r.status==='held'&&r.mode==='repost'&&r.repostAttemptedAt
  &&r.results?.repost?.readbackVerified===false);
 const draft=status.workPhase==='drafting'&&['X_AI_COMMENT_INVALID','X_AI_TIMEOUT','X_AI_CALL_FAILED','X_AI_OUTPUT_INVALID'].includes(status.code);
 if(read || draft || uncertain&&(held||heldNotice) || heldSessionContention || heldReflectionRepost || status.status!=='blocked'&&['running','discovering','preparing','processing','waiting','cooldown','waiting_for_search_read','waiting_for_base_benefits'].includes(status.status))return {action:'restart',reason:status.code||'PROCESS_EXITED'};
 return {action:'hold',reason:status.code||'UNSAFE_OR_UNKNOWN_FAILURE'};
}
