// Anonymous public read discovery. No cookie jar, credentials, or remote mutations.
import { mkdir, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36';
export const CAPTURE_DIR = 'C:/Users/User/AppData/Local/Temp/travel-price-captures';
const last = new Map();
const counts = new Map();
export async function readPublic(seller, name, url, options={}) {
  if ((counts.get(seller)||0)>=40) throw new Error('seller request budget exhausted');
  const method=options.method||'GET';
  if (!['GET','POST'].includes(method)) throw new Error('read method only');
  // POST is allowed only for a positively identified search/detail read contract.
  if (method==='POST'&&!options.readContract) throw new Error('POST requires observed readContract');
  for (const k of Object.keys(options.headers||{})) if (/cookie|authorization|token/i.test(k)) throw new Error('credential header prohibited');
  const host=new URL(url).host;
  const wait=2050-(Date.now()-(last.get(host)||0));
  if(wait>0) await new Promise(r=>setTimeout(r,wait));
  last.set(host,Date.now()); counts.set(seller,(counts.get(seller)||0)+1);
  const checkedAt=new Date().toISOString();
  let bytes, response, error;
  try {
    response=await fetch(url,{method,redirect:'manual',headers:{'user-agent':UA,'accept-language':'ko-KR,ko;q=0.9','accept':options.accept||'*/*',...options.headers},body:options.body,signal:AbortSignal.timeout(options.timeoutMs||16000)});
    bytes=Buffer.from(await response.arrayBuffer());
  } catch(e) { error={name:e.name,message:e.message,code:e.cause?.code}; }
  await mkdir(CAPTURE_DIR,{recursive:true});
  let base=path.join(CAPTURE_DIR,`${seller}-${name}`);
  try { await access(base+'.meta.json'); base+=`-${Date.now()}`; } catch(e) { if(e.code!=='ENOENT') throw e; }
  const type=response?.headers.get('content-type')||'';
  const ext=/json/i.test(type)?'.json':/javascript/i.test(type)||/\.js(?:\?|$)/.test(url)?'.js':'.html';
  const meta={seller,name,url,method,requestBody:options.body||null,readContract:options.readContract||null,requestHeaderNames:['user-agent','accept-language','accept',...Object.keys(options.headers||{})],checkedAt,status:response?.status||null,contentType:type,location:response?.headers.get('location')||null,bytes:bytes?.length||0,sha256:bytes?createHash('sha256').update(bytes).digest('hex'):null,capture:bytes?base+ext:null,error};
  if(bytes) await writeFile(base+ext,bytes,{flag:'wx'});
  await writeFile(base+'.meta.json',JSON.stringify(meta,null,2)+'\n',{flag:'wx'});
  const text=bytes?.toString('utf8')||'';
  return {meta,text,bytes,json:()=>JSON.parse(text)};
}
export function scriptUrls(html,base) { return [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map(m=>new URL(m[1].replaceAll('&amp;','&'),base).href); }
export function snippets(text,re,radius=180,limit=30) { return [...text.matchAll(re)].slice(0,limit).map(m=>({offset:m.index,text:text.slice(Math.max(0,m.index-radius),m.index+m[0].length+radius)})); }
