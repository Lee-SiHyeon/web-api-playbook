import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decodeConversation} from '../src/conversation.mjs';
import {decodeComments,RedditClient} from '../src/reddit.mjs';
const tweet=(id,parent,author='reader')=>({itemContent:{tweet_results:{result:{__typename:'Tweet',rest_id:id,core:{user_results:{result:{core:{screen_name:author}}}},legacy:{full_text:'hello',in_reply_to_status_id_str:parent}}}}});
test('X replies retain author and require a parent path; quoted, unrelated and promoted posts excluded',()=>{
 const root=tweet('1',null,'SpaceXAI'),a=tweet('2','1'),b=tweet('3','2'),unrelated=tweet('4','8'),ad={...tweet('5','1'),promotedMetadata:{}};
 root.itemContent.tweet_results.result.quoted_status_result={result:tweet('99',null)};
 const result=decodeConversation([{entries:[{content:root},{content:{items:[{item:b},{item:a},{item:unrelated},{item:ad}]}}]}],'1');
 assert.deepEqual(result.replies.map(t=>t.id),['3','2']);assert.equal(result.excludedUnconnected,1);assert.equal(result.replies[0].metrics.likes,null);assert.equal(result.complete,false);
});
test('X conversation readback exposes attached media identity and type without media URLs',()=>{
 const post=tweet('10',null,'lifehack__ailab');
 const legacy=post.itemContent.tweet_results.result.legacy;
 legacy.extended_entities={media:[{id_str:'2104487500400267264',type:'video',original_info:{width:1080,height:1920},video_info:{duration_millis:58500,variants:[{url:'https://video.twimg.com/private'}]},media_url_https:'https://pbs.twimg.com/private'}]};
 const result=decodeConversation([{entries:[{content:post}]}],'10');
 assert.deepEqual(result.focal.media,[{id:'2104487500400267264',type:'video',width:1080,height:1920,durationMs:58500,variantCount:1}]);
 assert.equal(JSON.stringify(result).includes('video.twimg.com'),false);
 assert.equal(JSON.stringify(result).includes('pbs.twimg.com'),false);
});
test('X note tweet readback restores URLs from the note entity set, not only legacy entities',()=>{
 const post=tweet('11',null,'lifehack__ailab');
 const result=post.itemContent.tweet_results.result;
 result.note_tweet={note_tweet_results:{result:{text:'긴 글 https://t.co/NOTEAAAAAA\n\n본문',entity_set:{urls:[{url:'https://t.co/NOTEAAAAAA',expanded_url:'https://toss.shopping/_m/abc'}]}}}};
 result.legacy.entities={urls:[{url:'https://t.co/LEGACYBBBB',expanded_url:'https://toss.shopping/_m/abc'}]};
 assert.equal(decodeConversation([{entries:[{content:post}]}],'11').focal.text,'긴 글 https://toss.shopping/_m/abc\n\n본문');
});
const listing=children=>({kind:'Listing',data:{children}});
test('Reddit comment tree preserves deleted-parent replies and incomplete more placeholders',()=>{
 const data=[listing([{kind:'t3',data:{id:'abc',title:'Grok'}}]),listing([{kind:'t1',data:{id:'def',body:'[deleted]',replies:listing([{kind:'t1',data:{id:'ghi',body:'Price matters',parent_id:'t1_def'}}])}},{kind:'more',data:{count:8}}])];
 const r=decodeComments(data,'abc');assert.equal(r.removed,1);assert.equal(r.comments[0].parentId,'t1_def');assert.equal(r.unexpanded[0].count,8);assert.equal(r.complete,false);
 assert.throws(()=>decodeComments(data,'wrong'),/POST_MISMATCH/);
});
test('Reddit OAuth-only and 403 never retried or converted to empty results',async()=>{
 assert.throws(()=>new RedditClient({}),/OAUTH_REQUIRED/);let calls=0;
 const c=new RedditClient({accessToken:'test',userAgent:'test collector',fetchImpl:async()=>{calls++;return new Response('blocked',{status:403});}});
 await assert.rejects(()=>c.search('Grok 4.7'),e=>e.code==='ACCESS_BLOCKED'&&e.receipt.status===403);assert.equal(calls,1);c.close();await assert.rejects(()=>c.comments('abc'),/CLOSED/);
});
