import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
const defaultRoot=()=>path.join(process.env.LOCALAPPDATA,'affiliate-content-operations','x-read-budget');
const number=value=>/^\d+$/.test(String(value??''))?Number(value):null;
const reserve=budget=>Math.ceil((budget.limit||0)*0.05);
export function readBudgetObservation(response,now=Date.now()) {
 const h=response.headers||{},limit=number(h['x-rate-limit-limit']),remaining=number(h['x-rate-limit-remaining']);
 const reset=number(h['x-rate-limit-reset']),retry=number(h['retry-after']);
 if(response.status!==429&&remaining===null)return null;
 const budget={limit,remaining:response.status===429?0:remaining,resetAt:reset?reset*1000:null,observedAt:now};
 if(response.status===429)budget.nextAt=Math.max(now+(retry||0)*1000,budget.resetAt||now+900000);
 else if(budget.resetAt>now){const available=remaining-reserve(budget);budget.nextAt=available>0?Math.min(budget.resetAt,now+Math.ceil((budget.resetAt-now)/available)):budget.resetAt;}
 else budget.nextAt=remaining===0?now+900000:now;
 return budget;
}
export function readBudgetNotBefore(budget,now=Date.now()) {
 if(!budget)return now;
 if(budget.remaining===0)return Math.max(now,budget.nextAt||0);
 if(budget.resetAt&&budget.resetAt<=now)return now;
 return Math.max(now,budget.nextAt||0);
}
function filename(root,owner,operation) {
 if(!/^[A-Za-z0-9_]{1,64}$/.test(owner||'')||!/^\w{1,64}$/.test(operation||''))throw Object.assign(new Error(),{code:'X_READ_BUDGET_INPUT'});
 return path.join(root,`${owner.toLowerCase()}-${operation}.json`);
}
async function load(file){try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function waitError(budget,operation,retryAt,now=Date.now()) {
 return Object.assign(new Error('X_READ_BUDGET_WAIT'),{code:'X_READ_BUDGET_WAIT',receipt:{operation,localBudget:true,writeSent:false,rateLimitLimit:budget.limit,rateLimitRemaining:budget.remaining,rateLimitReset:budget.resetAt?Math.ceil(budget.resetAt/1000):null,readBudgetRetryAt:retryAt,retryAfterSeconds:Math.max(0,Math.ceil((retryAt-now)/1000))}});
}
export async function assertReadCapacity(owner,operation,{needed=1,root=defaultRoot(),now=Date.now()}={}) {
 const budget=await load(filename(root,owner,operation));
 if(budget?.remaining===0&&readBudgetNotBefore(budget,now)>now)throw waitError(budget,operation,readBudgetNotBefore(budget,now),now);
 if(budget?.resetAt>now&&Number.isFinite(budget.remaining)&&budget.remaining-reserve(budget)<needed)throw waitError(budget,operation,budget.resetAt,now);
}
// The verified service session lock serializes callers, including both bots.
// Only fixed rate headers are retained; no response body or session data.
export async function withReadBudget(work,{owner,operation,root=defaultRoot(),now=Date.now,wait=delay}={}) {
 const file=filename(root,owner,operation),budget=await load(file),at=now(),notBefore=readBudgetNotBefore(budget,at);
 if(notBefore-at>30000)throw waitError(budget,operation,notBefore,at);
 if(notBefore>at)await wait(notBefore-at);
 const response=await work(),observation=readBudgetObservation(response,now());
 if(observation){await mkdir(root,{recursive:true});const temporary=file+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(observation));await rename(temporary,file);}
 return response;
}
