import test from 'node:test';
import assert from 'node:assert/strict';
import { createXClient, decodeXTimeline, collectXPages, fetchXXhr, contractsFromSource } from '../research/content-store/x-xhr.mjs';
const tweet = (id, author = 'sama') => ({ __typename:'Tweet', rest_id:id, core:{user_results:{result:{core:{screen_name:author}}}},
  legacy:{full_text:'short',created_at:'2026-09-21T00:00:00Z',favorite_count:0,reply_count:2},
  note_tweet:{note_tweet_results:{result:{text:'Full long post'}}}, views:{count:'1234'}, secret:'must-not-leak' });
const page = (posts, cursor) => [{type:'TimelineAddEntries',entries:[...posts.map(t=>({content:{itemContent:{tweet_results:{result:t}}}})),
  ...(cursor?[{content:{cursorType:'Bottom',value:cursor}}]:[])]}];
test('X public bootstrap timeout has a safe read code and is sent only once', async () => {
  let calls = 0;
  await assert.rejects(createXClient({ session: { authToken: 'fixture', csrfToken: 'fixture' },
    fetchImpl: async () => { calls++; throw new DOMException('private response', 'TimeoutError'); } }),
  error => error.code === 'X_READ_TIMEOUT' && error.receipt.method === 'GET' && error.receipt.writeSent === false
    && !JSON.stringify(error.receipt).includes('private'));
  assert.equal(calls, 1);
});

test('X JSON parser binds author, keeps full note text, and separates missing from zero metrics', () => {
  const row=tweet('2100351958167220547'); row.quoted_status_result={result:tweet('2100351958167220548','other')};
  const r=decodeXTimeline(page([row,tweet('2100351958167220549','other')],'next'),'sama');
  assert.equal(r.items.length,1); assert.equal(r.items[0].text,'Full long post'); assert.equal(r.items[0].engagement.likes,0);
  assert.equal(r.items[0].title,'Full long post'); assert.equal(r.items[0].summary,'Full long post');
  assert.equal(r.items[0].engagement.reposts,null); assert.equal(r.items[0].engagement.views,1234);
  assert.equal(JSON.stringify(r).includes('must-not-leak'),false); assert.equal(r.nextCursor,'next');
});
test('X pagination consumes server cursor, deduplicates posts, and stops cycles', async () => {
  const calls=[]; const client={profile:async()=>({id:'1'}),timeline:async(id,cursor)=>{calls.push(cursor);return {instructions:page([tweet('2100351958167220547')],'same'),receipt:{httpStatus:200}}}};
  const r=await collectXPages(client,'sama',{maxPages:5,limit:10});
  assert.deepEqual(calls,[undefined,'same']); assert.equal(r.items.length,1); assert.equal(r.receipt.stopReason,'cursor_cycle');
});
test('X missing session cannot silently invoke HTML or public embed fallback', async () => {
  let calls=0; await assert.rejects(fetchXXhr('sama',8,{fetchImpl:async()=>{calls++;}}),/SESSION_REQUIRED/); assert.equal(calls,0);
});
test('X missing source feature stays unresolved instead of inventing a value', () => {
  const source=['UserByScreenName','UserTweets','TweetDetail'].map(n=>`queryId:"observed",operationName:"${n}",operationType:"query",metadata:{featureSwitches:["flag"],fieldToggles:[]}`).join(';');
  assert.deepEqual(contractsFromSource(source,{}).UserTweets.missing,['flag']);
  assert.equal(contractsFromSource(source,{flag:{value:false}}).UserTweets.features.flag,false);
});

test('X rejects malformed credentials before any network request', async () => {
  let calls = 0;
  for (const authToken of [12, {}, 'a;b', 'a\r\nb', 'a b', 'x'.repeat(4097)]) {
    await assert.rejects(createXClient({ session: { authToken, csrfToken: 'fixture' }, fetchImpl: async () => { calls++; } }), /X_SESSION_INVALID/);
  }
  assert.equal(calls, 0);
});

test('X item limits preserve overflow before the next server cursor', async () => {
  const client = { profile: async () => ({id:'1'}), timeline: async () => ({ instructions: page([
    tweet('2100351958167220547'), tweet('2100351958167220548'), tweet('2100351958167220549')
  ], 'next'), receipt: {} }) };
  const result = await collectXPages(client, 'sama', {limit: 2});
  assert.deepEqual(result.items.map(p => p.id), ['2100351958167220547','2100351958167220548']);
  assert.deepEqual(result.remainder.map(p => p.id), ['2100351958167220549']);
  assert.equal(result.nextCursor, 'next');
});

test('X excludes promoted items nested in a timeline entry', () => {
  const instructions = page([tweet('2100351958167220547')]);
  instructions[0].entries[0].content.itemContent.promotedMetadata = { advertiser: 'fixture' };
  assert.equal(decodeXTimeline(instructions,'sama').items.length, 0);
});
test('X timeline decoder keeps profile conversation module, pin, cursor, and outer sortIndex separate', () => {
  const own=tweet('2100351958167220601','sama');
  own.core.user_results.result.rest_id='42';
  const pinned=tweet('2100351958167220602','sama');
  pinned.core.user_results.result.rest_id='42';
  const instructions=[
    {type:'TimelinePinEntry',entries:[{entryId:'pin-2100351958167220602',sortIndex:'2100351958167220602',
      content:{itemContent:{tweet_results:{result:pinned}}}}]},
    {type:'TimelineAddEntries',entries:[
      {entryId:'profile-conversation-2100351958167220601',sortIndex:'2100351958167220601',content:{entryType:'TimelineTimelineModule',
        items:[{entryId:'tweet-2100351958167220601',item:{itemContent:{tweet_results:{result:own}}}}]}},
      {entryId:'cursor-bottom-next',sortIndex:'0',content:{itemContent:{cursorType:'Bottom',value:'next'}}},
    ]},
  ];
  const result=decodeXTimeline(instructions,'sama');
  assert.deepEqual(result.timelineEntries.map(entry=>[entry.kind,entry.sortIndex,entry.ownerItems.length]),[
    ['pin','2100351958167220602',1],['profile-conversation','2100351958167220601',1],['cursor','0',0],
  ]);
  assert.equal(result.items.find(item=>item.id==='2100351958167220602').isPinned,true);
  assert.equal(result.nextCursor,'next');
  const malformed=decodeXTimeline([{type:'TimelineAddEntries',entries:[{entryId:'cursor-bottom-empty',sortIndex:'0',
    content:{itemContent:{cursorType:'Bottom',value:''}}}]}],'sama');
  assert.equal(malformed.invalidCursor,true);assert.equal(malformed.nextCursor,null);
});
test('authenticated source-enabled transition uses web route for profile requests',async()=>{
 const state={featureSwitch:{defaultConfig:{responsive_web_api_transition_enabled:{value:true},responsive_web_grok_bio_auto_translation_is_enabled:{value:false}}}};
 const source=['UserByScreenName','UserTweets','TweetDetail'].map(n=>`queryId:"observed",operationName:"${n}",operationType:"query",metadata:{featureSwitches:[],fieldToggles:[]}`).join(';')+'AAAA'+'x'.repeat(60);
 const calls=[];
 const client=await createXClient({session:{authToken:'fixture',csrfToken:'fixture'},fetchImpl:async(raw)=>{
   const url=String(raw);calls.push(url);
   if(url==='https://x.com/manifest.js')return new Response(`window.__INITIAL_STATE__=${JSON.stringify(state)};window.fixture=1;https://abs.twimg.com/responsive-web/client-web/main.fixture.js`);
   if(url.includes('abs.twimg.com'))return new Response(source);
   assert.equal(new URL(url).origin,'https://x.com');assert.match(new URL(url).pathname,/^\/i\/api\/graphql\/observed\/UserByScreenName$/);
   return new Response(JSON.stringify({data:{user:{result:{__typename:'User',rest_id:'123',core:{screen_name:'sama'},privacy:{protected:false}}}}}),{headers:{'content-type':'application/json'}});
 }});
 try{assert.equal((await client.profile('sama')).id,'123');assert.equal(calls.length,3);}finally{client.close();}
});
