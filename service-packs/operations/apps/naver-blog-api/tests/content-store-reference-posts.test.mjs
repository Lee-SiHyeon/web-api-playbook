import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fetchPublicPost, inspectPostUrl } from '../research/content-store/public-posts.mjs';
import { fetchXPost } from '../research/content-store/x-post.mjs';
import { collect, withReferenceInbox } from '../research/content-store/collect.mjs';

const id = '2103363875118702749';
const xUrl = `https://x.com/author/status/${id}`;
const threadsUrl = 'https://www.threads.com/@author/post/Abc12345';
const shareUrl = 'https://www.threads.com/share/AbcDEF123/';
const videoUrl = 'https://www.youtube.com/watch?v=zn2nB9jNmxU';
const webUrl = 'https://vynzo.ai/learn/ai-video/ai-influencer';
const html = text => `<script type="application/json">${JSON.stringify({code:'Abc12345',caption:{text},user:{username:'author'},taken_at:1790400000,like_count:2})}</script>`;
const htmlResponse = text => new Response(html(text),{headers:{'content-type':'text/html'}});
const articleHtml = `<html><head><meta property="og:title" content="AI production workflow"><meta property="og:site_name" content="Vynzo"><meta property="article:published_time" content="2026-09-28T10:00:00Z"><link rel="canonical" href="https://www.vynzo.ai/learn/ai-video/ai-influencer"></head><body><article><h1>AI production workflow</h1><p>${'Full production workflow, editing failures, and exact costs. '.repeat(12)}</p></article></body></html>`;
const config = urls => ({schemaVersion:1,perSourceLimit:3,sources:[],postUrls:urls.map((url,n)=>({id:`reference-${n}`,field:'ai',url}))});

test('Threads share resolves only observed same-service redirects and binds exact body identity',async()=>{
  const calls=[];
  const result=await fetchPublicPost(shareUrl+'?tracking=discard',{fetchImpl:async(url,options)=>{
    calls.push(String(url)); assert.equal(options.redirect,'manual');
    return calls.length===1 ? new Response(null,{status:302,headers:{location:threadsUrl+'?x=tracking#fragment'}}) : htmlResponse('A'.repeat(1601));
  }});
  assert.deepEqual(calls,[shareUrl,threadsUrl]);
  assert.equal(result.status,'collected');assert.equal(result.items[0].url,threadsUrl);
  assert.deepEqual(result.receipt.httpStatuses,[302,200]);
  assert.equal(result.items[0].bodyLength,1601);assert.equal(result.items[0].bodyTruncated,true);
  assert.equal(result.items[0].bodySha256,createHash('sha256').update('A'.repeat(1601)).digest('hex'));
});

test('public web article uses anonymous same-publisher HTTP and validates the article body',async()=>{
  assert.deepEqual(inspectPostUrl(`${webUrl}?utm_source=scout#section`),{platform:'web_article',url:webUrl,host:'vynzo.ai'});
  for(const url of ['https://127.0.0.1/article','https://localhost/article','https://service.internal/article','https://example.test/']) {
    assert.equal(inspectPostUrl(url).platform,'unsupported',url);
  }
  const calls=[];
  const result=await fetchPublicPost(webUrl,{fetchImpl:async(url,options)=>{
    calls.push({url:String(url),options});
    if(calls.length===1)return new Response(null,{status:301,headers:{location:'https://www.vynzo.ai/learn/ai-video/ai-influencer'}});
    return new Response(articleHtml,{headers:{'content-type':'text/html; charset=utf-8'}});
  }});
  assert.equal(result.status,'collected');assert.equal(result.items[0].title,'AI production workflow');
  assert.equal(result.items[0].publisher,'Vynzo');assert.equal(result.items[0].contentCoverage,'full_text');
  assert.equal(result.items[0].sourceKind,'public_web_article');assert.ok(result.items[0].bodySha256);
  assert.deepEqual(result.receipt.httpStatuses,[301,200]);assert.equal(result.receipt.liveReplay,true);
  assert.equal(result.receipt.executionMode,'pure_http');assert.equal(result.receipt.credentialsUsed,false);
  assert.equal(calls[0].options.redirect,'manual');assert.deepEqual(Object.keys(calls[0].options.headers),['accept']);
  const collected=await collect(config([webUrl]),{fetchImpl:async()=>new Response(articleHtml,{headers:{'content-type':'text/html'}})});
  assert.equal(collected.candidates[0].sourceKind,'public_web_article');
  assert.equal(collected.candidates[0].originalArticleFetched,true);
  assert.equal(collected.candidates[0].bodyEvidence.sha256,result.items[0].bodySha256);
});

test('public web article rejects off-host redirects and non-article responses',async()=>{
  let calls=0;
  const redirected=await fetchPublicPost(webUrl,{fetchImpl:async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://other.example/article'}});}});
  assert.equal(redirected.receipt.code,'WEB_ARTICLE_REDIRECT_SCOPE');assert.equal(calls,1);
  const nonHtml=await fetchPublicPost(webUrl,{fetchImpl:async()=>new Response('not a document',{headers:{'content-type':'application/octet-stream'}})});
  assert.equal(nonHtml.receipt.code,'WEB_ARTICLE_CONTENT_TYPE');
  const invalidPdf=await fetchPublicPost(webUrl,{fetchImpl:async()=>new Response('not a pdf',{headers:{'content-type':'application/pdf'}})});
  assert.equal(invalidPdf.receipt.code,'WEB_PDF_SIGNATURE');
  const shell=await fetchPublicPost(webUrl,{fetchImpl:async()=>new Response('<html><head><title>Sign in</title></head><body>Sign in to continue</body></html>',{headers:{'content-type':'text/html'}})});
  assert.equal(shell.receipt.code,'WEB_ARTICLE_CONTENT_UNVERIFIED');
});

test('SmartStore public FAQ reads only the FAQ-ID-bound cus_answer body',async()=>{
  const url='https://help.sell.smartstore.naver.com/faq/content.help?faqId=4121';
  const answer=`<p>${'정산 시점과 계좌 지급을 확인합니다. '.repeat(24)}</p><div><p>중첩 답변 본문</p></div>`;
  const faqHtml=`<html><body><li><a data-content-no="4121">[정산관리] 정산금액 입금 시기</a><div class="cus_answer">${answer}</div></li><li>다른 FAQ 제목</li></body></html>`;
  const result=await fetchPublicPost(url,{fetchImpl:async()=>new Response(faqHtml,{headers:{'content-type':'text/html;charset=UTF-8'}})});
  assert.equal(result.status,'collected');
  assert.equal(result.items[0].title,'스마트스토어 고객센터 도움말: [정산관리] 정산금액 입금 시기');
  assert.match(result.items[0].summary,/중첩 답변 본문/);
  assert.doesNotMatch(result.items[0].summary,/다른 FAQ 제목/);
  assert.equal(result.items[0].sourceKind,'official_service_help');
  assert.equal(result.items[0].contentCoverage,'full_text');
  assert.equal(result.receipt.liveReplay,true);
  assert.equal(result.receipt.credentialsUsed,false);

  const mismatched=await fetchPublicPost('https://help.sell.smartstore.naver.com/faq/content.help?faqId=5882',{
    fetchImpl:async()=>new Response(faqHtml,{headers:{'content-type':'text/html'}})});
  assert.equal(mismatched.status,'unavailable');
  assert.equal(mismatched.receipt.code,'WEB_ARTICLE_CONTENT_UNVERIFIED');
});

test('public PDF is read over anonymous HTTP, text-extracted and fingerprinted',async()=>{
  const pdfBytes=Buffer.from('%PDF-1.7 mock bitstream');
  const thesisText=('Persona-level realness differs from message-level relatability. Interaction and trust should be recorded separately. '.repeat(16)).trim();
  let extractorCalls=0;
  const pdfExtractor=async bytes=>{
    extractorCalls++;assert.deepEqual(Buffer.from(bytes),pdfBytes);
    return {ok:true,title:'Exploring Virtual Influencer Effectiveness',text:thesisText,pageCount:99,parserVersion:'test'};
  };
  const fetchImpl=async(_url,options)=>{
    assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');
    assert.deepEqual(Object.keys(options.headers),['accept']);
    return new Response(pdfBytes,{headers:{'content-type':'application/pdf;charset=UTF-8'}});
  };
  const result=await fetchPublicPost(webUrl,{fetchImpl,pdfExtractor});
  assert.equal(result.status,'collected');assert.equal(result.items[0].title,'Exploring Virtual Influencer Effectiveness');
  assert.equal(result.items[0].contentCoverage,'full_text');assert.equal(result.items[0].sourceKind,'public_web_article');
  assert.equal(result.items[0].bodySha256,createHash('sha256').update(thesisText).digest('hex'));
  assert.equal(result.receipt.collectionMethod,'public_pdf_http');assert.equal(result.receipt.pageCount,99);
  assert.equal(result.receipt.contentType,'application/pdf;charset=UTF-8');assert.equal(result.receipt.liveReplay,true);
  assert.equal(result.receipt.executionMode,'pure_http');assert.equal(result.receipt.credentialsUsed,false);
  assert.equal(extractorCalls,1);
});

test('Threads share rejects off-host, HTTP, credential, port, login and cyclic destinations',async()=>{
  for(const location of ['https://evil.test/a','http://www.threads.com/@author/post/Abc12345',
    'https://user:pass@www.threads.com/@author/post/Abc12345','https://www.threads.com:8443/@author/post/Abc12345','https://www.threads.com/login',shareUrl]){
    let calls=0;
    const result=await fetchPublicPost(shareUrl,{fetchImpl:async()=>{calls++;return new Response(null,{status:302,headers:{location}});}});
    assert.equal(result.status,'unavailable');assert.equal(calls,1,location);
  }
});

test('canonical Threads URL and sharing alias deduplicate into one candidate',async()=>{
  const result=await collect(config([shareUrl,threadsUrl]),{fetchImpl:async url=>String(url)===shareUrl
    ? new Response(null,{status:302,headers:{location:threadsUrl}}) : htmlResponse('A public post')});
  assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].sourceIds.length,2);
  assert.equal(result.candidates[0].originalArticleFetched,true);
});

test('a permalink read replaces stale longer feed text and tracking URL with validated post evidence',async()=>{
  const input=config([threadsUrl]);input.sources=[{id:'feed',field:'ai',kind:'rss_feed',url:'https://example.test/feed.xml'}];
  const result=await collect(input,{fetchImpl:async url=>String(url).includes('example.test')
    ? new Response(`<rss><channel><item><title>Old RSS headline</title><description>${'Old feed text '.repeat(90)}</description><link>${threadsUrl}?utm_source=rss</link></item></channel></rss>`,{headers:{'content-type':'application/rss+xml'}})
    : htmlResponse('The complete post caption')});
  assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].originalArticleFetched,true);
  assert.equal(result.candidates[0].contentCoverage,'post_text');assert.ok(result.candidates[0].bodyEvidence.sha256);
  assert.equal(result.candidates[0].summary,'The complete post caption');
  assert.equal(result.candidates[0].title,'The complete post caption');
});

test('YouTube aliases retain video identity while metadata stays partial with no fabricated date or transcript',async()=>{
  for(const url of ['https://youtu.be/zn2nB9jNmxU?si=tracking','https://m.youtube.com/watch?v=zn2nB9jNmxU&t=1','https://www.youtube.com/shorts/zn2nB9jNmxU']) assert.equal(inspectPostUrl(url).url,videoUrl);
  const result=await collect(config([videoUrl]),{fetchImpl:async()=>Response.json({title:'Example video',author_name:'Creator',type:'video',provider_name:'YouTube',html:'<iframe src="https://www.youtube.com/embed/zn2nB9jNmxU?feature=oembed"></iframe>'})});
  assert.equal(result.sources[0].url,videoUrl);assert.equal(result.sources[0].status,'partial');
  assert.equal(result.candidates[0].sourceKind,'video_reference');assert.equal(result.candidates[0].originalArticleFetched,false);
  assert.equal(result.candidates[0].publishedAt,null);assert.equal(result.candidates[0].bodyEvidence,null);
  const mismatch=await fetchPublicPost(videoUrl,{fetchImpl:async()=>Response.json({title:'Wrong video',author_name:'Creator',type:'video',provider_name:'YouTube',html:'<iframe src="https://www.youtube.com/embed/abcdefghijk"></iframe>'})});
  assert.equal(mismatch.receipt.code,'YOUTUBE_METADATA_IDENTITY');
});

test('X oEmbed never masquerades as full text and recognizes a shortened preview',async()=>{
  const result=await fetchPublicPost(xUrl,{xPostReader:async()=>null,fetchImpl:async()=>Response.json({url:xUrl,author_url:'https://x.com/author',html:`<blockquote><p>Long text preview… https://t.co/example</p><a href="${xUrl}">September 25, 2026</a></blockquote>`})});
  assert.equal(result.status,'partial');assert.equal(result.items[0].bodyTruncated,true);
  assert.equal(result.receipt.contentCoverage,'preview');
});

test('a rejected stored X session does not cause an anonymous fallback',async()=>{
  let calls=0;
  const result=await fetchPublicPost(xUrl,{xPostReader:async()=>{throw Object.assign(new Error('X_HTTP_403'),{code:'X_HTTP_403',receipt:{httpStatus:403}});},fetchImpl:async()=>{calls++;throw new Error('unexpected');}});
  assert.equal(calls,0);assert.equal(result.status,'unavailable');assert.equal(result.receipt.httpStatus,403);
  assert.equal(result.receipt.authenticationAttempted,true);
});

test('stored X provider is preferred and exact public post is selected rather than replies',async()=>{
  const events=[];
  const tweet = (postId,author) => ({content:{itemContent:{tweet_results:{result:{__typename:'Tweet',rest_id:postId,core:{user_results:{result:{core:{screen_name:author}}}},legacy:{full_text:'The full post',created_at:'Fri Sep 25 06:00:01 +0000 2026'}}}}}});
  const receipt={httpStatus:200,sha256:'a'.repeat(64),bytes:450,contractEvidence:'observed_public_client_source'};
  const provider={status:()=>({sessionStored:true}),withSession:async fn=>{events.push('stored');return fn({fetchImpl:async()=>{throw new Error('not used');}});}};
  const createClient=async()=>({receipts:[receipt],profile:async h=>events.push(`public:${h}`),detail:async()=>({receipt,instructions:[{entries:[tweet('2103363875118702000','author'),tweet(id,'author'),tweet(id,'other')]}]}),close:()=>events.push('closed')});
  const result=await fetchXPost({id,handle:'author',url:xUrl},{provider,createClient,fetchImpl:async()=>{}});
  assert.deepEqual(events,['stored','public:author','closed']);assert.equal(result.items.length,1);
  assert.equal(result.items[0].id,id);assert.equal(result.receipt.credentialsUsed,true);
  assert.equal(result.receipt.liveReplay,true);assert.equal(result.items[0].text,undefined);
});

test('reference inbox joins normal collector without arbitrary sources or duplicate IDs',()=>{
  assert.equal(withReferenceInbox(config([]),config([videoUrl])).postUrls.length,1);
  assert.throws(()=>withReferenceInbox(config([videoUrl]),config([videoUrl])),/SOURCE_CONFIG/);
  assert.throws(()=>withReferenceInbox(config([]),{schemaVersion:1,perSourceLimit:1,sources:[{id:'news',field:'ai',kind:'google_news_rss',query:'test'}]}),/POST_URLS_ONLY/);
});
