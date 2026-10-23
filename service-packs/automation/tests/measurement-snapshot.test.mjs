import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {decodePartners,decodeBlog,decodePostCounts,tistoryBlogOrigin} from '../src/measurement-snapshot.mjs';
test('top-list absence is not zero and observed counts are not organic conversions',()=>{
 const r=decodePostCounts({status:'ok',data:{result:[{entryId:215,count:0}]}},['215','216']);
 assert.equal(r.posts[0].count,0);assert.equal(r.posts[1].count,null);
 assert.equal(r.posts[1].status,'not-in-top-list');assert.equal(r.organicTrafficVerified,false);
 assert.throws(()=>decodePostCounts({status:'ok',data:{result:[{entryId:215,count:'4'}]}},['215']),/metric_missing/);
});

test('snapshot sends only scoped read requests and preserves missing top-list values',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'automation-measurement-'));const calls=[];
 try{
  const metrics={orderCount:1,clickCount:2,gmv:3,commission:4,conversion:5};
  const payloads=new Map([
   ['https://partners.coupang.com/api/v1/dashboard',{rCode:'0',data:{dailyTrend:{key:'2026-10-01',lastUpdatedDate:'2026-10-02',...metrics},monthlyAggregation:{key:'2026-10',lastUpdatedDate:'2026-10-02',...metrics}}}],
   ['https://sample-blog.tistory.com/manage/v2/statistics/blog/count',{status:'ok',data:{result:{pv:{today:1,yesterday:2,total:3},uv:{today:4,yesterday:5,total:6}},timestamp:1,lastUpdateTime:'2026-10-02'}}],
   ['https://sample-blog.tistory.com/manage/statistics/dashboard/topEntry.json',{status:'ok',data:{result:[]}}]
  ]);
  const result=await (await import('../src/measurement-snapshot.mjs')).collectMeasurements(dir,{COUPANG_COOKIE:'synthetic-cookie',COUPANG_X_TOKEN:'synthetic-token',TISTORY_BLOG_ORIGIN:'https://sample-blog.tistory.com',TISTORY_COOKIE:'synthetic-tistory-cookie'},['215'],{uuid:()=> 'synthetic',now:()=>new Date('2026-10-02T00:00:00Z'),fetchImpl:async(url,options)=>{
   calls.push({url,options});return {status:200,headers:new Headers({'content-type':'application/json'}),text:async()=>JSON.stringify(payloads.get(String(url)))};
  }});
  assert.equal(result.status,'collected');assert.equal(calls.length,3);assert.ok(calls.every(call=>call.options.method===undefined));
  assert.deepEqual(result.sources.posts.posts,[{postId:'215',status:'not-in-top-list',count:null}]);
  assert.equal(calls.find(c=>c.url.includes('partners.coupang.com')).options.headers['x-token'],'synthetic-token');
  const saved=await readFile(result.file,'utf8');assert.equal(saved.includes('synthetic-cookie'),false);assert.equal(saved.includes('synthetic-token'),false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('measurements preserve period and zero without inventing missing metrics',()=>{
 const bucket={key:'2026-09-05',lastUpdatedDate:'2026-09-06',orderCount:0,clickCount:0,gmv:0,commission:0,conversion:0};
 const result=decodePartners({rCode:'0',data:{dailyTrend:bucket,monthlyAggregation:{...bucket,key:'2026-09'}}});
 assert.equal(result.daily.period,'2026-09-05');assert.equal(result.daily.clickCount,0);assert.equal(result.settlementVerified,false);
 assert.throws(()=>decodePartners({rCode:'0',data:{dailyTrend:{...bucket,clickCount:null},monthlyAggregation:bucket}}),/metric_missing/);
 assert.throws(()=>decodeBlog({status:'ok',data:{result:{pv:{today:0}}}}),/metric_missing/);
});

test('Tistory origin is constrained to one HTTPS tistory.com blog host',()=>{
 assert.equal(tistoryBlogOrigin('https://sample-blog.tistory.com'),'https://sample-blog.tistory.com');
 assert.equal(tistoryBlogOrigin('http://sample-blog.tistory.com'),null);
 assert.equal(tistoryBlogOrigin('https://sample-blog.tistory.com.evil.example'),null);
 assert.equal(tistoryBlogOrigin('https://sample-blog.tistory.com/path'),null);
});

test('invalid Tistory origin cannot receive the session cookie',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'automation-invalid-origin-'));const urls=[];
 try{
  const metrics={orderCount:1,clickCount:2,gmv:3,commission:4,conversion:5};
  const result=await (await import('../src/measurement-snapshot.mjs')).collectMeasurements(dir,{COUPANG_COOKIE:'synthetic-cookie',COUPANG_X_TOKEN:'synthetic-token',TISTORY_BLOG_ORIGIN:'https://sample-blog.tistory.com.evil.example',TISTORY_COOKIE:'synthetic-tistory-cookie'},[],{uuid:()=> 'synthetic',fetchImpl:async(url)=>{
   urls.push(String(url));return {status:200,headers:new Headers({'content-type':'application/json'}),text:async()=>JSON.stringify({rCode:'0',data:{dailyTrend:{key:'2026-10-01',lastUpdatedDate:'2026-10-02',...metrics},monthlyAggregation:{key:'2026-10',lastUpdatedDate:'2026-10-02',...metrics}}})};
  }});
  assert.equal(result.status,'partial');assert.equal(result.sources.blog.reason,'tistory_origin_missing');assert.equal(urls.length,1);assert.ok(urls[0].includes('partners.coupang.com'));
 }finally{await rm(dir,{recursive:true,force:true});}
});
