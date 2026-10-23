import http from 'node:http';
import { generateKeyPairSync, privateDecrypt, createDecipheriv, constants } from 'node:crypto';
import { storeSession, checkSession } from './client.mjs';
import { writeFileSync } from 'node:fs';

const service = 'toss-sharelink';
const aad = 'toss-sharelink:https://sharelink.toss.im:session:v1';
const keys = generateKeyPairSync('rsa', {modulusLength:3072});
const startedAt = Date.now(), expiresAt = startedAt + 300000;
let used = false;
function decode(text,min,max) {
  if(typeof text!=='string'||! /^[A-Za-z0-9+/]+={0,2}$/.test(text)||text.length>max*2)throw Error();
  const b=Buffer.from(text,'base64');
  if(b.length<min||b.length>max||b.toString('base64')!==text)throw Error();return b;
}
function decrypt(envelope) {
  if(envelope?.version!==1||envelope.service!==service)throw Error();
  const key=privateDecrypt({key:keys.privateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},decode(envelope.wrappedKey,384,384));
  try {
    if(key.length!==32)throw Error();
    const ciphertext=decode(envelope.ciphertext,17,524288);
    const d=createDecipheriv('aes-256-gcm',key,decode(envelope.iv,12,12));
    d.setAAD(Buffer.from(aad));d.setAuthTag(ciphertext.subarray(-16));
    const plain=Buffer.concat([d.update(ciphertext.subarray(0,-16)),d.final()]);
    try{return JSON.parse(plain.toString('utf8'));}finally{plain.fill(0);}
  }finally{key.fill(0);}
}
const server=http.createServer(async(req,res)=>{
  const origin=`http://127.0.0.1:${server.address().port}`;
  res.setHeader('cache-control','no-store');
  if(req.headers.host!==new URL(origin).host){res.writeHead(400).end();return;}
  if(req.method==='GET'&&req.url==='/'&&!used){
    res.writeHead(200,{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'; form-action 'self'; frame-ancestors 'none'"});
    res.end('<!doctype html><title>Protected Toss session handoff</title><form method="post" action="/submit"><label>Encrypted session<textarea name="envelope" required></textarea></label><button>Store session</button></form>');return;
  }
  if(req.method!=='POST'||req.url!=='/submit'||used||Date.now()>expiresAt||req.headers.origin!==origin||!/^application\/x-www-form-urlencoded(?:;|$)/i.test(req.headers['content-type']||'')){res.writeHead(404).end();return;}
  used=true;let result,bundle;
  try{
    let body='';for await(const part of req){body+=part.toString('utf8');if(Buffer.byteLength(body)>1048576)throw Error();}
    const form=new URLSearchParams(body);if([...form.keys()].length!==1||!form.has('envelope'))throw Error();
    bundle=decrypt(JSON.parse(form.get('envelope')));
    if(bundle.capturedAt<startedAt-300000||bundle.capturedAt>Date.now()+10000)throw Error();
    const saved=storeSession(bundle);
    if(Array.isArray(bundle.evidence)){
      const contracts=bundle.evidence.filter(c=>c.origin==='https://sharelink.toss.im'&&/^[a-z][a-z0-9-]{0,63}$/.test(c.operation||''));
      writeFileSync(new URL('./observed-contracts.json',import.meta.url),JSON.stringify({version:1,service,observedAt:new Date().toISOString(),contracts},null,2));
    }
    try{result={...saved,...await checkSession()};}catch(e){result={...saved,authenticated:false,code:/^[A-Z0-9_]+$/.test(e.code||'')?e.code:'TOSS_CHECK_FAILED'};}
  }catch{result={stored:false,code:'TOSS_HANDOFF_FAILED'};process.exitCode=2;}
  finally{if(bundle){bundle.cookies=[];bundle.expectedOwner=null;bundle.readRequests={};}}
  console.log(JSON.stringify(result));res.writeHead(result.stored?200:422,{'content-type':'application/json'}).end(JSON.stringify(result));
  server.close();server.closeIdleConnections();clearTimeout(timer);
});
await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
const timer=setTimeout(()=>{server.close();server.closeAllConnections();console.error('TOSS_HANDOFF_TIMEOUT');process.exitCode=2;},300000);
console.log(JSON.stringify({ready:true,service,aad,publicKey:keys.publicKey.export({format:'jwk'}),localForm:`http://127.0.0.1:${server.address().port}/`,expiresAt}));
