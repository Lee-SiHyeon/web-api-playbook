import {createHash,randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {requestPartners} from './partners-transport.mjs';

const date=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString().slice(0,10)===x;
export function reportPayload({startDate,endDate}){
 if(!date(startDate)||!date(endDate)||startDate>endDate)throw Error('Invalid report dates');
 return {filters:[{column:'startDate',operator:'EQUAL',value:[startDate]},{column:'endDate',operator:'EQUAL',value:[endDate]}]};
}
export function decodeDailyReport(d,range){
 reportPayload(range);
 if(d?.rCode!=='0'||!Array.isArray(d.data?.units)||typeof d.data.lastUpdatedDate!=='string')throw Error('Report schema mismatch');
 const metrics=row=>Object.fromEntries(['orderCount','clickCount','gmv','commission','conversion'].map(k=>{if(typeof row[k]!=='number'||!Number.isFinite(row[k]))throw Error('Report metric missing');return [k,row[k]];}));
 const seen=new Set();const days=d.data.units.map(row=>{
  if(!date(row.key)||row.key<range.startDate||row.key>range.endDate||seen.has(row.key))throw Error('Report date mismatch');seen.add(row.key);return {date:row.key,...metrics(row)};
 });
 return {requestedRange:range,scope:'default-channel-report',lastUpdatedDate:d.data.lastUpdatedDate,totals:metrics(d.data),days,articleAttributionVerified:false,settlementVerified:false};
}
export async function collectDailyReport(range,directory,env=process.env,{fetchImpl=globalThis.fetch,now=()=>new Date(),uuid=randomUUID}={}){
 const payload=reportPayload(range);if(!env.COUPANG_COOKIE||!env.COUPANG_X_TOKEN)throw Error('Report credentials missing');
 const {response,raw}=await requestPartners('/api/v1/report/daily',{method:'POST',cookie:env.COUPANG_COOKIE,xToken:env.COUPANG_X_TOKEN,body:payload,fetchImpl});
 if(response.status!==200||!response.headers.get('content-type')?.includes('application/json'))throw Error('Report HTTP failure '+response.status);
 const receipt={checkedAt:now().toISOString(),httpStatus:response.status,responseHash:createHash('sha256').update(raw).digest('hex'),...decodeDailyReport(JSON.parse(raw),range)};
 await mkdir(directory,{recursive:true});const file=join(directory,'partners-report-'+uuid()+'.json');await writeFile(file,JSON.stringify(receipt,null,2),{flag:'wx'});return {file,...receipt};
}
