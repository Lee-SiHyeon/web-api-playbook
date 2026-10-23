import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { PNG } from 'pngjs';
import { fingerprint } from '../../../../packages/contracts/src/index.mjs';

const PLATFORM='https://platform.editor.naver.com';
const PHOTO='https://blog.upphoto.naver.com';
const IMAGE='https://blogfiles.pstatic.net';
const CAFE_IMAGE='https://cafeptthumb-phinf.pstatic.net';
const fail=code=>{const e=new Error(code);e.code=code;throw e;};
const hash=data=>createHash('sha256').update(data).digest('hex');
export async function verifiedUploadComponent(receipt, {blogId,journal,fetchImpl=fetch,timeoutMs=20000}) {
  if(!journal||receipt?.blogId!==blogId||receipt?.operation!=='uploadPng'||receipt?.source!=='independent_http'||
     receipt?.readbackVerified!==true||!/^[a-f0-9]{64}$/.test(receipt.sha256||''))fail('UPLOAD_RECEIPT_UNVERIFIED');
  let url,record;
  try{
    url=new URL(receipt.publishedUrl);
    record=await journal.read(journal.key('uploadPng',{blogId},{sha256:receipt.sha256,fileName:receipt.fileName}));
  }catch{fail('UPLOAD_RECEIPT_UNVERIFIED')}
  if(url.origin!==IMAGE||url.search||url.hash||url.username||url.password||record.state!=='verified'||
     fingerprint(record.receipt)!==fingerprint(receipt))fail('UPLOAD_RECEIPT_UNVERIFIED');
  let response;
  try{response=await fetchImpl(url.href,{method:'GET',redirect:'manual',headers:{accept:'image/png'},signal:AbortSignal.timeout(timeoutMs)})}
  catch{fail('UPLOAD_READBACK_MISMATCH')}
  if(response.status!==200||!/image\/png/i.test(response.headers.get('content-type')||'')||
     hash(await bounded(response,10*1024*1024))!==receipt.sha256)fail('UPLOAD_READBACK_MISMATCH');
  return {'@ctype':'image',id:`SE-${randomUUID()}`,layout:'default',src:url.href+'?type=w1',
    internalResource:true,represent:true,path:url.pathname,domain:IMAGE,fileSize:receipt.fileSize,
    width:receipt.width,widthPercentage:0,height:receipt.height,originalWidth:receipt.width,
    originalHeight:receipt.height,fileName:receipt.fileName,format:'normal',displayFormat:'normal',
    origin:{'@ctype':'imageOrigin',srcFrom:'local'},contentMode:'normal',ai:false};
}
async function bounded(response,limit){
  const chunks=[];let count=0;
  for await(const chunk of response.body||[]){count+=chunk.length;if(count>limit)fail('MEDIA_RESPONSE_SIZE');chunks.push(chunk)}
  return Buffer.concat(chunks);
}
export function parseUploadXml(raw,{imageOrigin=IMAGE}={}){
  if(![IMAGE,CAFE_IMAGE].includes(imageOrigin))fail('MEDIA_CONTEXT_INVALID');
  if(typeof raw!=='string'||/<!|&/.test(raw)||!/^<\?xml[^>]*>\s*<item>/.test(raw))fail('MEDIA_RESPONSE_SCHEMA');
  const fields={};
  for(const match of raw.matchAll(/<([A-Za-z]+)>([^<]*)<\/\1>/g)){
    if(Object.hasOwn(fields,match[1]))fail('MEDIA_RESPONSE_SCHEMA');fields[match[1]]=match[2];
  }
  if(fields.index!=='0'||fields.imageType!=='PNG'||fields.animatedCnt!=='1'||
     !fields.url?.startsWith('/')||fields.url.startsWith('//')||/[\\?#]/.test(fields.url)||
     !fields.path?.startsWith('/')||!fields.fileName||
     !['width','height','fileSize'].every(k=>/^\d+$/.test(fields[k]||'')&&Number(fields[k])>0))fail('MEDIA_RESPONSE_SCHEMA');
  const url=new URL(fields.url,imageOrigin);
  if(url.origin!==imageOrigin||!url.pathname.endsWith('/'+fields.fileName))fail('MEDIA_RESPONSE_SCHEMA');
  return {...fields,url:url.href,width:Number(fields.width),height:Number(fields.height),fileSize:Number(fields.fileSize)};
}

export async function uploadPng({bytes,fileName,blogId,token,appCode,journal}, {fetchImpl=fetch,now=()=>new Date(),timeoutMs=20000}={}){
  if(!journal)fail('JOURNAL_REQUIRED');
  if(!Buffer.isBuffer(bytes)||bytes.length>10*1024*1024||bytes.length<24||
     bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||
     bytes.readUInt32BE(16)>4096||bytes.readUInt32BE(20)>4096||
     path.basename(fileName)!==fileName||!/^[-A-Za-z0-9_]+\.png$/.test(fileName))fail('MEDIA_INPUT');
  let png,claims;
  try{png=PNG.sync.read(bytes);claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8'));}catch{fail('MEDIA_CONTEXT_INVALID')}
  // The signed token is accepted only from fresh owner-verified editor options.
  // Its userId matched the observed upload query; it is not an account selector.
  if(!['blogpc001','cafepc001'].includes(appCode)||typeof token!=='string'||!/^\d+$/.test(String(claims.userId||''))||
     !Number.isFinite(claims.exp)||claims.exp*1000<=now().getTime())fail('MEDIA_CONTEXT_INVALID');
  const cafe=appCode==='cafepc001';
  const photo=cafe?'https://cafe.upphoto.naver.com':PHOTO;
  const imageOrigin=cafe?CAFE_IMAGE:IMAGE;
  const referer=cafe?'https://cafe.naver.com/':'https://blog.naver.com/';
  const request=async(url,init)=>{
    let response;try{response=await fetchImpl(url,{...init,redirect:'manual',signal:AbortSignal.timeout(timeoutMs)});}catch{fail(init.method==='POST'?'UPLOAD_OUTCOME_UNKNOWN':'MEDIA_TRANSPORT')}
    if(response.status!==200){await response.body?.cancel();fail(init.method==='POST'?'UPLOAD_OUTCOME_UNKNOWN':'MEDIA_AUTH_OR_HTTP')}
    return response;
  };
  const sessionResponse=await request(PLATFORM+'/api/'+appCode+'/v1/photo-uploader/session-key',{
    method:'GET',headers:{accept:'application/json','SE-Authorization':token,
      'SE-App-Id':`SE-${randomUUID()}`,referer} });
  if(!/application\/json/i.test(sessionResponse.headers.get('content-type')||''))fail('MEDIA_RESPONSE_SCHEMA');
  let session;try{session=JSON.parse((await bounded(sessionResponse,32768)).toString())}catch{fail('MEDIA_RESPONSE_SCHEMA')}
  if(session?.isSuccess!==true||typeof session.sessionKey!=='string'||
     !/^[A-Za-z0-9_-]{10,512}$/.test(session.sessionKey))fail('MEDIA_RESPONSE_SCHEMA');
  const url=new URL(`${photo}/${session.sessionKey}/simpleUpload/0`);
  Object.entries({userId:String(claims.userId),extractExif:'true',extractAnimatedCnt:'false',extractAnimatedInfo:'true',
    autorotate:'true',extractDominantColor:'false',type:'',customQuery:'',denyAnimatedImage:'false',skipXcamFiltering:'false'}).forEach(([k,v])=>url.searchParams.set(k,v));
  const sha256=hash(bytes),key=journal.key('uploadPng',{blogId},{sha256,fileName});
  await journal.reserve(key,{operation:'uploadPng',blogId,sha256,fileName});
  let uploadedReceipt=null;
  try{
    const form=new FormData();form.set('image',new Blob([bytes],{type:'image/png'}),fileName);
    const response=await request(url.href,{method:'POST',headers:{accept:'*/*',referer},body:form});
    if(!/text\/xml/i.test(response.headers.get('content-type')||''))fail('UPLOAD_OUTCOME_UNKNOWN');
    const item=parseUploadXml((await bounded(response,65536)).toString(),{imageOrigin});
    if([item.url,item.path,item.fileName].some(value=>String(value).includes(session.sessionKey)))fail('MEDIA_RESPONSE_SCHEMA');
    if(item.width!==png.width||item.height!==png.height||item.fileName!==fileName||item.fileSize!==bytes.length)fail('UPLOAD_READBACK_MISMATCH');
    // The unsigned result URL must survive a later CDN timeout. It permits a read-only reconciliation,
    // while an upload-session URL/token never enters the journal.
    uploadedReceipt={schemaVersion:1,operation:'uploadPng',source:'independent_http',blogId,
      ...(cafe?{cafeId:blogId,appCode}:{}),checkedAt:now().toISOString(),sha256,publishedUrl:item.url,fileName,
      width:item.width,height:item.height,fileSize:item.fileSize,readbackVerified:false};
    await journal.finish(key,'uploaded_pending_readback',uploadedReceipt);
    const readback=await request(item.url,{method:'GET',headers:{accept:'image/png'}});
    if(!/image\/png/i.test(readback.headers.get('content-type')||''))fail('UPLOAD_READBACK_MISMATCH');
    if(hash(await bounded(readback,10*1024*1024))!==sha256)fail('UPLOAD_READBACK_MISMATCH');
    const receipt={schemaVersion:1,operation:'uploadPng',source:'independent_http',blogId,
      ...(cafe?{cafeId:blogId,appCode}:{}),checkedAt:now().toISOString(),sha256,publishedUrl:item.url,fileName,width:item.width,height:item.height,
      fileSize:item.fileSize,readbackVerified:true};
    await journal.finish(key,'verified',receipt);return receipt;
  }catch(error){await journal.finish(key,uploadedReceipt?'uploaded_pending_readback':'submitted_unknown',{
    ...(uploadedReceipt??{}),code:/^[A-Z_]+$/.test(error.code||'')?error.code:'UPLOAD_OUTCOME_UNKNOWN'});fail('UPLOAD_OUTCOME_UNKNOWN')}
  finally{token='';session.sessionKey='';}
}
