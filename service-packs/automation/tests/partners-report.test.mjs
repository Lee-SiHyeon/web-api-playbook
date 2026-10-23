import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {reportPayload,decodeDailyReport,collectDailyReport} from '../src/partners-report.mjs';
test('daily report preserves dates and rejects duplicate/out-of-range rows without implying attribution',()=>{
 const range={startDate:'2026-09-06',endDate:'2026-09-06'},metrics={orderCount:0,clickCount:0,gmv:0,commission:0,conversion:0};
 const data={rCode:'0',data:{lastUpdatedDate:'2026-09-06',...metrics,units:[{key:'2026-09-06',...metrics}]}};
 assert.equal(reportPayload(range).filters.length,2);assert.throws(()=>reportPayload({startDate:'2026-02-30',endDate:'2026-03-01'}));
 const result=decodeDailyReport(data,range);assert.equal(result.articleAttributionVerified,false);assert.equal(result.settlementVerified,false);assert.equal(result.days[0].date,range.startDate);
 assert.throws(()=>decodeDailyReport({...data,data:{...data.data,units:[...data.data.units,...data.data.units]}},range),/date mismatch/);
 assert.throws(()=>decodeDailyReport(data,{startDate:'2026-09-07',endDate:'2026-09-07'}),/date mismatch/);
 assert.throws(()=>decodeDailyReport({...data,data:{...data.data,commission:null}},range),/metric missing/);
});

test('daily report keeps observed POST body and writes a redacted range receipt offline',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'automation-report-'));let call;
 try{
  const range={startDate:'2026-09-06',endDate:'2026-09-06'},metrics={orderCount:0,clickCount:1,gmv:100,commission:5,conversion:0};
  const data={rCode:'0',data:{lastUpdatedDate:'2026-09-07',...metrics,units:[{key:'2026-09-06',...metrics}]}};
  const result=await collectDailyReport(range,dir,{COUPANG_COOKIE:'synthetic-cookie',COUPANG_X_TOKEN:'synthetic-token'},{uuid:()=> 'synthetic',now:()=>new Date('2026-09-08T00:00:00Z'),fetchImpl:async(url,options)=>{
   call={url,options};return {status:200,headers:new Headers({'content-type':'application/json'}),text:async()=>JSON.stringify(data)};
  }});
  assert.equal(call.url,'https://partners.coupang.com/api/v1/report/daily');assert.equal(call.options.method,'POST');
  assert.deepEqual(JSON.parse(call.options.body),reportPayload(range));assert.equal(call.options.headers.referer,undefined);
  assert.equal(result.articleAttributionVerified,false);assert.equal(result.settlementVerified,false);
  const saved=await readFile(result.file,'utf8');assert.equal(saved.includes('synthetic-cookie'),false);assert.equal(saved.includes('synthetic-token'),false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
