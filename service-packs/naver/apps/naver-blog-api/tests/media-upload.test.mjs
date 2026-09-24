import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {PNG} from 'pngjs';
import {uploadPng,parseUploadXml,verifiedUploadComponent} from '../scripts/api/media-upload.mjs';
import {WriteJournal} from '../scripts/api/write-journal.mjs';
const NOW=new Date('2026-09-20T12:00:00Z');
async function fixture(t,options={}){
  const dir=await mkdtemp(path.join(os.tmpdir(),'naver-upload-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const png=new PNG({width:12,height:8});png.data.fill(150);const bytes=PNG.sync.write(png);
  const token='synthetic.'+Buffer.from(JSON.stringify({userId:'123456',exp:NOW.getTime()/1000+600})).toString('base64url')+'.signature';
  const calls=[];
  const xml=`<?xml version="1.0"?><item><index>0</index><url>/synthetic/probe.png</url><path>/synthetic/</path><fileName>probe.png</fileName><width>12</width><height>8</height><fileSize>${bytes.length}</fileSize><imageType>PNG</imageType><animatedCnt>1</animatedCnt><animatedLoop>0</animatedLoop></item>`;
  const input={bytes,fileName:'probe.png',blogId:'syntheticblog',token,appCode:'blogpc001',journal:new WriteJournal(dir)};
  const fetchImpl=async(raw,init)=>{
    const url=new URL(raw);calls.push({url,init});assert.equal(init.redirect,'manual');
    assert.equal(new Headers(init.headers).has('cookie'),false);
    if(url.hostname==='platform.editor.naver.com'){
      assert.equal(new Headers(init.headers).get('SE-Authorization'),token);
      if(options.loginHtml)return new Response('<html>login</html>',{headers:{'content-type':'text/html'}});
      return new Response(JSON.stringify({isSuccess:true,sessionKey:'synthetic-session-key'}),{headers:{'content-type':'application/json'}});
    }
    assert.equal(new Headers(init.headers).has('SE-Authorization'),false);
    if(url.hostname==='blog.upphoto.naver.com'){
      assert.equal(url.searchParams.get('userId'),'123456');
      assert.equal(url.searchParams.get('skipXcamFiltering'),'false');
      assert.deepEqual([...init.body.keys()],['image']);
      assert.deepEqual(Buffer.from(await init.body.get('image').arrayBuffer()),bytes);
      if(options.lost)throw Error('synthetic private URL/session must not escape');
      return new Response(options.foreign?xml.replace('/synthetic/probe.png','//evil.invalid/probe.png'):xml,{headers:{'content-type':'text/xml'}});
    }
    assert.equal(url.hostname,'blogfiles.pstatic.net');
    return new Response(options.mismatch?Buffer.from('wrong'):bytes,{headers:{'content-type':'image/png'}});
  };
  return {input,fetchImpl,calls,xml};
}
test('PNG upload scopes each credential and verifies exact downloaded bytes before issuing a usable receipt',async t=>{
  const f=await fixture(t),receipt=await uploadPng(f.input,{fetchImpl:f.fetchImpl,now:()=>NOW});
  assert.equal(receipt.readbackVerified,true);assert.equal(f.calls.filter(c=>c.init.method==='POST').length,1);
  assert.doesNotMatch(JSON.stringify(receipt),/synthetic-session-key|signature/);
  const component=await verifiedUploadComponent(receipt,{blogId:f.input.blogId,journal:f.input.journal,fetchImpl:f.fetchImpl});
  assert.equal(component.src,receipt.publishedUrl+'?type=w1');assert.equal(component.path,'/synthetic/probe.png');
  await assert.rejects(verifiedUploadComponent({...receipt,width:999},{blogId:f.input.blogId,journal:f.input.journal,fetchImpl:f.fetchImpl}),/UPLOAD_RECEIPT_UNVERIFIED/);
  await assert.rejects(verifiedUploadComponent(receipt,{blogId:'otherblog',journal:f.input.journal,fetchImpl:f.fetchImpl}),/UPLOAD_RECEIPT_UNVERIFIED/);
});
for(const options of [{lost:true},{mismatch:true},{foreign:true}])test('ambiguous or invalid upload is never retried '+JSON.stringify(options),async t=>{
  const f=await fixture(t,options);
  await assert.rejects(uploadPng(f.input,{fetchImpl:f.fetchImpl,now:()=>NOW}),/UPLOAD_OUTCOME_UNKNOWN/);
  await assert.rejects(uploadPng(f.input,{fetchImpl:f.fetchImpl,now:()=>NOW}),/WRITE_ALREADY_ATTEMPTED/);
  assert.equal(f.calls.filter(c=>c.init.method==='POST').length,1);
});
test('non-PNG input, login HTML and expired upload context fail before POST',async t=>{
  const f=await fixture(t,{loginHtml:true});
  await assert.rejects(uploadPng({...f.input,bytes:Buffer.from('not an image')},{fetchImpl:f.fetchImpl,now:()=>NOW}),/MEDIA_INPUT/);
  await assert.rejects(uploadPng(f.input,{fetchImpl:f.fetchImpl,now:()=>new Date('2027-01-01')}),/MEDIA_CONTEXT_INVALID/);
  await assert.rejects(uploadPng(f.input,{fetchImpl:f.fetchImpl,now:()=>NOW}),/MEDIA_RESPONSE_SCHEMA/);
  assert.equal(f.calls.filter(c=>c.init.method==='POST').length,0);
});
test('upload XML rejects entity expansion, duplicate fields and a foreign asset host',async t=>{
  const f=await fixture(t);
  for(const xml of ['<!DOCTYPE x>'+f.xml,f.xml.replace('<index>0</index>','<index>0</index><index>0</index>'),f.xml.replace('/synthetic/probe.png','//evil.invalid/probe.png')])assert.throws(()=>parseUploadXml(xml),/MEDIA_RESPONSE_SCHEMA/);
});
