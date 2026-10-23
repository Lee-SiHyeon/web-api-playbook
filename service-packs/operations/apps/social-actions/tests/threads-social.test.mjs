import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildThreadsFeedbackHubVariables,
  buildThreadsFollowersVariables,
  decodeThreadsEngagement,
  decodeThreadsComments,
  decodeThreadsFollowers,
  decodeThreadsProfileDocument,
  decodeThreadsPost,
  THREADS_SOCIAL_CONTRACTS,
} from '../threads-social.mjs';

const OWNER_ID = '17824859444';
const POST_ID = '3996994421430736442';

function follower(username, id, overrides = {}) {
  return {
    node: {
      pk: id,
      username,
      friendship_status: { followed_by: true, following: false, outgoing_request: false },
      is_verified: false,
      text_post_app_is_private: null,
      ...overrides,
    },
  };
}

test('Threads followers query stays on the captured first-page contract', () => {
  assert.deepEqual(THREADS_SOCIAL_CONTRACTS.followers, {
    operation: 'BarcelonaFriendshipsFollowersTabQuery',
    docId: '27993451613683779',
    path: '/graphql/query',
    first: 20,
  });
  assert.deepEqual(buildThreadsFollowersVariables(OWNER_ID), {
    first: 20,
    userID: OWNER_ID,
    __relay_internal__pv__BarcelonaIsInternalUserrelayprovider: false,
    __relay_internal__pv__BarcelonaIsLoggedInrelayprovider: true,
    __relay_internal__pv__BarcelonaIsCrawlerrelayprovider: false,
    __relay_internal__pv__BarcelonaShouldShowFediverseListsrelayprovider: true,
  });
});

test('Threads followers decoder validates owner and reports first-page boundary without exposing cursor', () => {
  const result = decodeThreadsFollowers({ data: { user: {
    id: OWNER_ID,
    followers: {
      edges: [follower('sample_user', '10000000001')],
      page_info: { has_next_page: true, end_cursor: 'opaque-next-page-cursor' },
    },
  } } }, OWNER_ID);

  assert.equal(result.followers.length, 1);
  assert.deepEqual(result.followers[0], {
    id: '10000000001', username: 'sample_user', following: false,
    followsOwner: true, outgoingRequest: false, verified: false, private: null,
  });
  assert.equal(result.page.fullList, false);
  assert.equal(result.page.hasNextPage, true);
  assert.equal(Object.hasOwn(result.page, 'endCursor'), false);
});

test('Threads followers decoder rejects wrong owner and duplicate rows', () => {
  const connection = {
    edges: [follower('sample_user', '10000000001'), follower('other_name', '10000000001')],
    page_info: { has_next_page: false, end_cursor: null },
  };
  assert.throws(() => decodeThreadsFollowers({ data: { user: { id: '1', followers: connection } } }, OWNER_ID),
    { code: 'THREADS_SOCIAL_FOLLOWERS_OWNER_MISMATCH' });
  assert.throws(() => decodeThreadsFollowers({ data: { user: { id: OWNER_ID, followers: connection } } }, OWNER_ID),
    { code: 'THREADS_SOCIAL_FOLLOWERS_ROW_SCHEMA' });
});

test('Threads feedback hub decoder separates like, repost, quote, and unknown activity kinds', () => {
  assert.deepEqual(THREADS_SOCIAL_CONTRACTS.feedbackHub, {
    operation: 'BarcelonaFeedbackHubDialogQuery',
    docId: '27639876885686872',
    path: '/api/graphql',
  });
  const variables = buildThreadsFeedbackHubVariables(POST_ID);
  assert.equal(variables.post_id, POST_ID);
  assert.equal(variables.sort_type, 'default');
  assert.equal(variables.__relay_internal__pv__BarcelonaIsLoggedInrelayprovider, true);

  const actor = { id: '10000000002', username: 'another_user', friendship_status: {
    followed_by: false, following: true, outgoing_request: false,
  } };
  const result = decodeThreadsEngagement({ data: { feedback_hub: { post_activity: [
    { extra: { icon_name: 'like' }, actor, timestamp: 100, post: { pk: POST_ID } },
    { extra: { icon_name: 'repost' }, actor, timestamp: 101, post: { pk: POST_ID } },
    { extra: { icon_name: 'quote' }, actor, timestamp: 102, post: { pk: POST_ID } },
    { extra: { icon_name: 'reply' }, actor, timestamp: 103, post: { pk: POST_ID } },
  ] } } }, POST_ID);

  assert.deepEqual(result.counts, { like: 1, repost: 1, quote: 1 });
  assert.deepEqual(result.unsupportedKinds, [{ kind: 'reply', count: 1 }]);
  assert.equal(result.exhaustive, false);
  assert.equal(result.activities.like[0].followsOwner, false);
});

test('Threads feedback hub decoder rejects cross-post activity', () => {
  assert.throws(() => decodeThreadsEngagement({ data: { feedback_hub: { post_activity: [
    { extra: { icon_name: 'like' }, actor: { id: '10000000002', username: 'another_user' }, post: { pk: '2999999999999999999' } },
  ] } } }, POST_ID), { code: 'THREADS_SOCIAL_ENGAGEMENT_POST_MISMATCH' });
});

test('Threads post decoder preserves an unknown reply permission separately from false', () => {
  const payload = { data: { media: {
    id: POST_ID,
    code: 'AbCdEf12345',
    user: { username: 'owner_user' },
    caption: { text: 'sample post' },
    has_liked: false,
    text_post_app_info: { is_reply: false, can_reply: false, direct_reply_count: 1,
      share_info: { is_reposted_by_viewer: false },
      pinned_post_info: { is_pinned_to_profile: true } },
  } } };
  const post = decodeThreadsPost(payload, { postId: POST_ID, expectedAuthor: 'owner_user' });
  assert.equal(post.canReply, false);
  assert.equal(post.isPinnedToProfile, true);
  payload.data.media.text_post_app_info.can_reply = undefined;
  assert.equal(decodeThreadsPost(payload, { postId: POST_ID }).canReply, null);
});

test('Threads comments decoder binds target identity separately and distinguishes direct roots from descendants', () => {
  const reply = (id, username, text) => ({ node: {
    id, code: `c${id}`, user: { username }, caption: { text }, has_liked: false,
    text_post_app_info: { is_reply: true, can_reply: null, direct_reply_count: 0 },
  } });
  const result = decodeThreadsComments({ data: { media: {
    id: POST_ID,
    text_post_app_info: { direct_replies: {
      edges: [{ node: { posts: { edges: [
        reply('3996994421430736450', 'first_reply', 'first'),
        reply('3996994421430736451', 'nested_reply', 'nested'),
      ] } } }],
      page_info: { has_next_page: true, end_cursor: 'opaque' },
    } },
  } } }, { postId: POST_ID, expectedAuthor: 'owner_user', rootPost: {
    id: POST_ID, author: 'owner_user', canReply: null, directReplyCount: 1,
  } });
  assert.equal(result.postAuthor, 'owner_user');
  assert.equal(result.canReply, null);
  assert.equal(result.totalDirectReplyCount, 1);
  assert.equal(result.comments[0].directParentPostId, POST_ID);
  assert.equal(result.comments[1].directParentPostId, null);
  assert.equal(result.page.fullList, false);
});

test('self-thread children bind only an adjacent owner continuation to the exact requested root',()=>{
  const child={pk:'3997530329766474170_17824859444',code:'ChildCode',user:{pk:OWNER_ID,username:'owner_user'},
    caption:{text:'exact owner notice'},text_post_app_info:{is_reply:true,self_thread_info:{id:'17949418365319769',
      post_position_in_self_thread:2,self_thread_length:2}}};
  const payload={data:{media:{id:POST_ID,text_post_app_info:{direct_replies:{edges:[],page_info:{has_next_page:false,end_cursor:null}},
    self_thread:{posts:{edges:[{node:child}]}}}}}};
  const rootPost={id:POST_ID,author:'owner_user',canReply:null,directReplyCount:0,
    selfThreadInfo:{id:'17949418365319769',position:1,length:2}};
  let result=decodeThreadsComments(payload,{postId:POST_ID,expectedAuthor:'owner_user',rootPost});
  assert.equal(result.comments.length,0);
  assert.equal(result.selfThreadChildren.length,1);
  assert.equal(result.selfThreadChildren[0].id,'3997530329766474170');
  assert.equal(result.selfThreadChildren[0].directParentPostId,POST_ID);
  assert.equal(result.selfThreadChildren[0].relationSource,'self_thread_adjacent_position');
  assert.equal(result.selfThreadPage.fullList,false);

  child.text_post_app_info.self_thread_info.id='different-thread';
  result=decodeThreadsComments(payload,{postId:POST_ID,expectedAuthor:'owner_user',rootPost});
  assert.equal(result.selfThreadChildren.length,0);
  child.text_post_app_info.self_thread_info.id='17949418365319769';
  child.text_post_app_info.self_thread_info.post_position_in_self_thread=3;
  result=decodeThreadsComments(payload,{postId:POST_ID,expectedAuthor:'owner_user',rootPost});
  assert.equal(result.selfThreadChildren.length,0);
});

test('observed image-only reply preserves identity and parent without fabricated caption', () => {
  const row={pk:'3891469961060290476',user:{pk:'71658648332',username:'image_reply'},caption:null,
    media_type:1,has_liked:false,text_post_app_info:{is_reply:true,direct_reply_count:3}};
  const payload={data:{media:{pk:POST_ID,text_post_app_info:{direct_replies:{
    edges:[{node:{posts:{edges:[{node:row}]}}}],page_info:{has_next_page:false,end_cursor:null}}}}}};
  const options={postId:POST_ID,rootPost:{id:POST_ID,author:'owner_user',canReply:true,directReplyCount:1}};
  const result=decodeThreadsComments(payload,options);
  assert.equal(result.comments[0].text,'');
  assert.equal(result.comments[0].contentType,'image');
  assert.equal(result.comments[0].authorId,'71658648332');
  assert.equal(result.comments[0].directParentPostId,POST_ID);
  assert.equal(result.page.fullList,false);
  row.media_type=undefined;
  assert.throws(()=>decodeThreadsComments(payload,options),{code:'THREADS_SOCIAL_COMMENT_ROW_SCHEMA'});
});

test('observed caption-null image carousel preserves comment identity and accepts only bounded image children',()=>{
  const row={pk:'3953371615114422445',user:{pk:'71658648332',username:'image_carousel_reply'},caption:null,
    media_type:8,carousel_media:[{media_type:1},{media_type:1},{media_type:1},{media_type:1}],has_liked:false,
    text_post_app_info:{is_reply:true,direct_reply_count:0}};
  const payload={data:{media:{pk:POST_ID,text_post_app_info:{direct_replies:{
    edges:[{node:{posts:{edges:[{node:row}]}}}],page_info:{has_next_page:false,end_cursor:null}}}}}};
  const options={postId:POST_ID,rootPost:{id:POST_ID,author:'owner_user',canReply:true,directReplyCount:1}};
  const result=decodeThreadsComments(payload,options);
  assert.deepEqual(result.comments.map(comment=>({id:comment.id,authorId:comment.authorId,parent:comment.directParentPostId,
    text:comment.text,contentType:comment.contentType,captionPresent:comment.captionPresent})),[
    {id:'3953371615114422445',authorId:'71658648332',parent:POST_ID,text:'',contentType:'image_carousel',captionPresent:false},
  ]);

  row.carousel_media=[];
  assert.throws(()=>decodeThreadsComments(payload,options),{code:'THREADS_SOCIAL_COMMENT_ROW_SCHEMA'});
  row.carousel_media=[{media_type:1},null];
  assert.throws(()=>decodeThreadsComments(payload,options),{code:'THREADS_SOCIAL_COMMENT_ROW_SCHEMA'});
  row.carousel_media=[{media_type:1},{media_type:2}];
  assert.throws(()=>decodeThreadsComments(payload,options),{code:'THREADS_SOCIAL_COMMENT_ROW_SCHEMA'});
  row.carousel_media=Array.from({length:21},()=>({media_type:1}));
  assert.throws(()=>decodeThreadsComments(payload,options),{code:'THREADS_SOCIAL_COMMENT_ROW_SCHEMA'});
  row.carousel_media=[{media_type:1}];row.media_type=7;
  assert.throws(()=>decodeThreadsComments(payload,options),{code:'THREADS_SOCIAL_COMMENT_ROW_SCHEMA'});
  row.media_type=8;row.caption={text:null};
  assert.throws(()=>decodeThreadsComments(payload,options),{code:'THREADS_SOCIAL_COMMENT_ROW_SCHEMA'});
});

test('caption-null image carousel self-thread child keeps the exact adjacent-parent proof',()=>{
  const child={pk:'3997530329766474170_17824859444',user:{pk:OWNER_ID,username:'owner_user'},caption:null,media_type:8,
    carousel_media:[{media_type:1},{media_type:1}],text_post_app_info:{is_reply:true,
      self_thread_info:{id:'17949418365319769',post_position_in_self_thread:2,self_thread_length:2}}};
  const payload={data:{media:{id:POST_ID,text_post_app_info:{direct_replies:{edges:[],page_info:{has_next_page:false,end_cursor:null}},
    self_thread:{posts:{edges:[{node:child}]}}}}}};
  const rootPost={id:POST_ID,author:'owner_user',canReply:null,directReplyCount:0,
    selfThreadInfo:{id:'17949418365319769',position:1,length:2}};
  let result=decodeThreadsComments(payload,{postId:POST_ID,expectedAuthor:'owner_user',rootPost});
  assert.equal(result.selfThreadChildren.length,1);
  assert.equal(result.selfThreadChildren[0].text,'');
  assert.equal(result.selfThreadChildren[0].contentType,'image_carousel');
  assert.equal(result.selfThreadChildren[0].captionPresent,false);
  assert.equal(result.selfThreadChildren[0].directParentPostId,POST_ID);
  child.text_post_app_info.self_thread_info.post_position_in_self_thread=3;
  result=decodeThreadsComments(payload,{postId:POST_ID,expectedAuthor:'owner_user',rootPost});
  assert.equal(result.selfThreadChildren.length,0);
});

test('Threads comments decoder refuses unbound parent identity', () => {
  assert.throws(() => decodeThreadsComments({ data: { media: {
    id: POST_ID, text_post_app_info: { direct_replies: {
      edges: [], page_info: { has_next_page: false, end_cursor: null },
    } },
  } } }, { postId: POST_ID }), { code: 'THREADS_SOCIAL_COMMENTS_SCHEMA' });
});

test('Threads profile document parser binds viewer and marks its initial window partial', () => {
  const post = {
    id: POST_ID,
    code: 'AbCdEf12345',
    user: { username: 'owner_user' },
    caption: { text: 'profile post' },
    text_post_app_info: { is_reply: false, can_reply: true, direct_reply_count: 0,
      pinned_post_info: { is_pinned_to_profile: true } },
    has_liked: false,
    taken_at: 1_700_000_000,
  };
  const html = `<html><script type="application/json">${JSON.stringify([
    ['BarcelonaSharedData', [], { viewer: { username: 'lifehack__ailab', id: OWNER_ID } }],
    post,
  ])}</script></html>`;
  const result = decodeThreadsProfileDocument(html, {
    handle: 'owner_user', viewerOwner: 'lifehack__ailab', viewerId: OWNER_ID,
  });
  assert.equal(result.posts.length, 1);
  assert.deepEqual(result.pinnedPostIds, [POST_ID]);
  assert.equal(result.fullTimeline, false);
  assert.throws(() => decodeThreadsProfileDocument(html, {
    handle: 'owner_user', viewerOwner: 'other_owner', viewerId: OWNER_ID,
  }), { code: 'THREADS_SOCIAL_PROFILE_VIEWER_MISMATCH' });
});
