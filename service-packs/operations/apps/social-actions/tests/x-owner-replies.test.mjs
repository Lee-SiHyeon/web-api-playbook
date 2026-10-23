import test from 'node:test';
import assert from 'node:assert/strict';
import { readOwnerRepliesBefore } from '../x-owner-replies.mjs';

const owner='lifehack__ailab',ownerId='1234567890123456789',parentId='1987654321098765432';
const twitterEpoch=1288834974657n;
function sortIndex(date){return ((BigInt(Date.parse(date))-twitterEpoch)<<22n).toString();}
function tweet(id,createdAt,replyToId=null,author=owner,authorId=ownerId){
  return {itemContent:{tweet_results:{result:{__typename:'Tweet',rest_id:id,
    core:{user_results:{result:{rest_id:authorId,core:{screen_name:author}}}},
    legacy:{full_text:`post ${id}`,created_at:createdAt,...(replyToId?{in_reply_to_status_id_str:replyToId}:{})}}}}};
}
function tweetEntry(row){return {entryId:`tweet-${row[0]}`,sortIndex:sortIndex(row[1]),content:tweet(...row)};}
function conversationEntry(sortDate,rows){
  return {entryId:`profile-conversation-${rows[0][0]}`,sortIndex:sortIndex(sortDate),content:{entryType:'TimelineTimelineModule',
    items:rows.map(row=>({entryId:`tweet-${row[0]}`,item:tweet(...row)}))}};
}
function pinInstruction(row){return {type:'TimelinePinEntry',entries:[{entryId:`pin-${row[0]}`,sortIndex:sortIndex(row[1]),content:tweet(...row)}]};}
function cursorEntry(cursor){return {entryId:`cursor-bottom-${cursor}`,sortIndex:'0',content:{itemContent:{cursorType:'Bottom',value:cursor}}};}
function payload(instructions){return {data:{user:{result:{timeline:{timeline:{instructions}}}}}};}
function page(rows,cursor){
  return payload([{type:'TimelineAddEntries',entries:[...rows.map(tweetEntry),...(cursor?[cursorEntry(cursor)]:[])]}]);
}
function dependencies(responses,{capacity=async()=>{}}={}){
  const requests=[];
  const context={ownerHandle:owner,apiTransitionEnabled:false,timelineWithVoice:true,timelineWithCommunity:false,
    ownerRepliesContract:{operation:'UserTweetsAndReplies',queryId:'observed-id',features:{feature_a:true},missing:[]},
    lookupUser:async handle=>({userId:ownerId,handle,protected:false}),
    request:async(method,route,url)=>{
      requests.push({method,route,url:new URL(url)});
      return {status:200,headers:{'content-type':'application/json; charset=utf-8'},raw:JSON.stringify(responses.shift())};
    }};
  return {requests,withContext:work=>work(context),readCapacity:capacity};
}

test('reads owner replies newest-first by observed UserTweetsAndReplies pages until the sortIndex cutoff',async()=>{
  const deps=dependencies([
    page([['2100000000000000001','Fri Oct 02 10:00:00 +0000 2026'],['2100000000000000002','Thu Oct 01 10:00:00 +0000 2026',parentId]],'older-page'),
    page([['2100000000000000003','Wed Sep 30 10:59:00 +0000 2026']],null),
  ]);
  const capacity=[];
  deps.readCapacity=async(ownerName,operation,options)=>capacity.push({ownerName,operation,options});
  const result=await readOwnerRepliesBefore({cutoffAt:'2026-09-30T11:00:00.000Z'},deps);
  assert.equal(result.ownerId,ownerId);assert.equal(result.pagesRead,2);assert.equal(result.coverageComplete,true);
  assert.equal(result.reachedCutoff,true);assert.equal(result.ownerItemCount,3);assert.equal(result.items.length,3);
  assert.deepEqual(result.items[1],{id:'2100000000000000002',authorId:ownerId,author:owner,replyToId:parentId,text:'post 2100000000000000002',createdAt:'2026-10-01T10:00:00.000Z'});
  assert.equal(deps.requests[0].method,'GET');assert.equal(deps.requests[0].route,'/graphql/observed-id/UserTweetsAndReplies');
  assert.deepEqual(JSON.parse(deps.requests[0].url.searchParams.get('variables')),{userId:ownerId,count:20,includePromotedContent:true,
    withCommunity:false,withQuickPromoteEligibilityTweetFields:true,withVoice:true});
  assert.deepEqual(JSON.parse(deps.requests[0].url.searchParams.get('fieldToggles')),{withPayments:false,withArticlePlainText:false});
  assert.equal(JSON.parse(deps.requests[1].url.searchParams.get('variables')).cursor,'older-page');
  assert.equal(capacity.length,2);assert.ok(capacity.every(row=>row.ownerName===owner&&row.operation==='UserTweetsAndReplies'&&row.options.needed===1));
  assert.equal(result.writes,0);
});

test('conversation modules collect all owner items, ignore pins, and use entry sortIndex for order and cutoff',async()=>{
  const cutoffAt='2026-09-30T11:00:00.000Z';
  const first=payload([
    pinInstruction(['2100000000000000099','Tue Sep 01 10:00:00 +0000 2026']),
    {type:'TimelineAddEntries',entries:[
      conversationEntry('Fri Oct 02 10:00:00 +0000 2026',[
        ['2100000000000000008','Tue Sep 29 10:00:00 +0000 2026'],
        ['2100000000000000001','Fri Oct 02 10:00:00 +0000 2026'],
        ['1987654321098765432','Tue Sep 01 09:00:00 +0000 2026',null,'target','998877665544332211'],
      ]),
      tweetEntry(['2100000000000000002','Thu Oct 01 10:00:00 +0000 2026']),
      cursorEntry('older-page'),
    ]},
  ]);
  const second=page([['2100000000000000003','Wed Sep 30 10:59:00 +0000 2026']],null);
  const deps=dependencies([first,second]);
  const summaries=[];
  const result=await readOwnerRepliesBefore({cutoffAt},{...deps,onPageSummary:summary=>summaries.push(summary)});
  assert.equal(result.coverageComplete,true);assert.equal(result.pagesRead,2);assert.equal(result.items.length,4);
  assert.equal(result.items.some(item=>item.id==='2100000000000000099'),false);
  assert.equal(result.items.some(item=>item.id==='1987654321098765432'),false);
  assert.equal(result.items.some(item=>item.id==='2100000000000000008'),true);
  assert.equal(summaries[0].entryKinds.pin,1);assert.equal(summaries[0].entryKinds['profile-conversation'],1);
  assert.equal(summaries[0].entryKinds.cursor,1);assert.equal(summaries[0].ownerItemCount,3);
  // The module holds a Sep 29 owner item, but the module's own time is its newest owner item (Oct 2).
  assert.equal(summaries[0].coverage.entryTimeReachedCutoff,false);
  assert.equal(summaries[0].coverage.reachedCutoff,false);
  assert.equal(summaries[1].coverage.entryTimeReachedCutoff,true);
  assert.equal(summaries[1].coverage.reachedCutoff,true);
  assert.equal(JSON.stringify(summaries).includes('post '),false);
  assert.equal(summaries[0].sortIndexRange.newest,sortIndex('Fri Oct 02 10:00:00 +0000 2026'));
});

test('sequence-only sortIndex (live shape) proves order; entry times reaching the cutoff end the read',async()=>{
  const cutoffAt='2026-09-30T11:00:00.000Z';
  let next=2105839060202291199n;
  const seq=entry=>({...entry,sortIndex:(next--).toString()});
  const deps=dependencies([
    payload([{type:'TimelineAddEntries',entries:[seq(tweetEntry(['2100000000000000004','Wed Sep 30 11:01:00 +0000 2026'])),cursorEntry('older-page')]}]),
    payload([{type:'TimelineAddEntries',entries:[seq(tweetEntry(['2100000000000000005','Wed Sep 30 10:59:00 +0000 2026'])),cursorEntry('oldest')]}]),
  ]);
  const summaries=[];
  const result=await readOwnerRepliesBefore({cutoffAt},{...deps,onPageSummary:summary=>summaries.push(summary)});
  assert.equal(result.coverageComplete,true);assert.equal(result.pagesRead,2);
  assert.equal(summaries[0].coverage.reachedCutoff,false);
  assert.equal(summaries[1].coverage.reachedCutoff,true);
});

test('an entry newer than the previous entry breaks order and never claims coverage',async()=>{
  let next=2105839060202291199n;
  const seq=entry=>({...entry,sortIndex:(next--).toString()});
  const deps=dependencies([payload([{type:'TimelineAddEntries',entries:[
    seq(tweetEntry(['2100000000000000002','Thu Oct 01 10:00:00 +0000 2026'])),
    seq(tweetEntry(['2100000000000000001','Fri Oct 02 10:00:00 +0000 2026'])),
    seq(tweetEntry(['2100000000000000003','Wed Sep 30 10:00:00 +0000 2026'])),
  ]}])]);
  const result=await readOwnerRepliesBefore({cutoffAt:'2026-09-30T11:00:00.000Z'},deps);
  assert.equal(result.coverageComplete,false);
});

test('a malformed bottom cursor is not treated as end-of-timeline coverage',async()=>{
  const malformedCursor={entryId:'cursor-bottom-empty',sortIndex:'0',content:{itemContent:{cursorType:'Bottom',value:''}}};
  const deps=dependencies([payload([{type:'TimelineAddEntries',entries:[
    tweetEntry(['2100000000000000006','Fri Oct 02 10:00:00 +0000 2026']),malformedCursor,
  ]}])]);
  const result=await readOwnerRepliesBefore({cutoffAt:'2026-09-30T11:00:00.000Z'},deps);
  assert.equal(result.coverageComplete,false);assert.equal(result.endReached,false);assert.equal(result.pagesRead,1);
});

test('a page limit or non-descending entry sortIndex never claims coverage',async()=>{
  const limited=dependencies([page([['2100000000000000001','Fri Oct 02 10:00:00 +0000 2026']], 'older-page')]);
  const result=await readOwnerRepliesBefore({cutoffAt:'2026-09-30T11:00:00.000Z',maxPages:1},limited);
  assert.equal(result.coverageComplete,false);assert.equal(result.endReached,false);assert.equal(result.pagesRead,1);
  const reversed=dependencies([page([
    ['2100000000000000002','Thu Oct 01 10:00:00 +0000 2026'],
    ['2100000000000000001','Fri Oct 02 10:00:00 +0000 2026'],
  ],null)]);
  const unordered=await readOwnerRepliesBefore({cutoffAt:'2026-09-30T11:00:00.000Z'},reversed);
  assert.equal(unordered.coverageComplete,false);assert.equal(unordered.endReached,true);
});

test('owner identity and current operation contract are required before timeline requests',async()=>{
  const deps=dependencies([]);
  deps.withContext=work=>work({...{ownerHandle:owner,lookupUser:async()=>({userId:ownerId,handle:owner})},
    ownerRepliesContract:null,request:async()=>assert.fail('must not request')});
  await assert.rejects(readOwnerRepliesBefore({cutoffAt:'2026-09-30T11:00:00.000Z'},deps),{code:'X_OWNER_REPLIES_CONTRACT_UNAVAILABLE'});
});
