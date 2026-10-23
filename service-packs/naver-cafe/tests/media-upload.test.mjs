import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PNG} from 'pngjs';
import {uploadPng,parseUploadXml} from '../../naver/apps/naver-blog-api/scripts/api/media-upload.mjs';
import {WriteJournal} from '../../naver/apps/naver-blog-api/scripts/api/write-journal.mjs';
import {cafeImageComponent,cafeUploadContext} from '../lib/media-upload.mjs';
import {validateCafeDocument,richDocument,cafeText,cafeTable,documentFingerprint} from '../lib/editor-document.mjs';

test('cafepc001 reuses upload transport with cafe hosts, one POST and exact bytes; no session values enter receipt',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'cafe-upload-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const png=new PNG({width:12,height:8});png.data.fill(120);const bytes=PNG.sync.write(png);
 const token='fixture.'+Buffer.from(JSON.stringify({userId:'123456',exp:Date.now()/1000+600})).toString('base64url')+'.fixture';let posts=0;
 const xml=`<?xml version="1.0"?><item><index>0</index><url>/fixture/cafe.png</url><path>/fixture/</path><fileName>cafe.png</fileName><width>12</width><height>8</height><fileSize>${bytes.length}</fileSize><imageType>PNG</imageType><animatedCnt>1</animatedCnt></item>`;
 const receipt=await uploadPng({bytes,fileName:'cafe.png',blogId:'31796283',appCode:'cafepc001',token,journal:new WriteJournal(dir)},{fetchImpl:async(url,init)=>{
  const u=new URL(url),h=new Headers(init.headers);assert.equal(h.has('cookie'),false);
  if(u.hostname==='platform.editor.naver.com'){assert.equal(u.pathname,'/api/cafepc001/v1/photo-uploader/session-key');return Response.json({isSuccess:true,sessionKey:'fixture-session-key'});}
  assert.equal(h.has('SE-Authorization'),false);
  if(init.method==='POST'){posts++;assert.equal(u.hostname,'cafe.upphoto.naver.com');assert.equal(h.get('referer'),'https://cafe.naver.com/');return new Response(xml,{headers:{'content-type':'text/xml'}});}
  assert.equal(u.hostname,'cafeptthumb-phinf.pstatic.net');return new Response(bytes,{headers:{'content-type':'image/png'}});
 }});
 assert.equal(posts,1);assert.equal(receipt.cafeId,'31796283');assert.equal(cafeImageComponent(receipt).represent,false);
 assert.doesNotMatch(JSON.stringify(receipt),/fixture-session-key|fixture\./);assert.throws(()=>parseUploadXml(xml,{imageOrigin:'https://evil.invalid'}));
});

test('upload context rejects changed service configuration and wrong owner before mutation',async()=>{
 const editor={appCode:'cafepc001',token:'fixture',userId:'owner',article:{writerId:'owner'}};
 await assert.rejects(cafeUploadContext(editor,{fetchImpl:async()=>Response.json({infraInfo:{photoInfra:{domain:'evil.invalid'}}})}),/MEDIA_CONTEXT_SCHEMA/);
 await assert.rejects(cafeUploadContext({...editor,userId:'other'}),/MEDIA_OWNER_CONTEXT/);
});

test('rich document readback fingerprints include captions, image links, table cells and representative selection',()=>{
 const m=richDocument([cafeText('보존할 내용'),cafeTable(['열'],[['행']]),{'@ctype':'image',id:'i',src:'https://cafeptthumb-phinf.pstatic.net/i.png?type=w1',internalResource:true,represent:true}]);
 const checked=validateCafeDocument(JSON.stringify(m));assert.equal(checked.images.length,1);
 const ids=structuredClone(m);ids.document.components[0].id='changed';assert.equal(documentFingerprint(ids),checked.fingerprint);
 const changed=structuredClone(m);changed.document.components[2].represent=false;assert.notEqual(documentFingerprint(changed),checked.fingerprint);
 changed.document.components[2].link={'@ctype':'urlLink',url:'https://blog.naver.com/aicandoanything/1'};assert.throws(()=>validateCafeDocument(JSON.stringify(changed)),/CONTENT_IMAGE_LINK_SCHEMA/);
 changed.document.components[2].link='https://blog.naver.com/aicandoanything/1';assert.doesNotThrow(()=>validateCafeDocument(JSON.stringify(changed)));
 changed.document.components[2].src='https://evil.invalid/i.png?type=w1';assert.throws(()=>validateCafeDocument(JSON.stringify(changed)),/CONTENT_IMAGE_SCOPE/);
});
