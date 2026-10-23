import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {uploadPng} from '../../naver/apps/naver-blog-api/scripts/api/media-upload.mjs';
import {WriteJournal} from '../../naver/apps/naver-blog-api/scripts/api/write-journal.mjs';
import {CafeApiError} from './session.mjs';

export const CAFE_IMAGE_ORIGIN='https://cafeptthumb-phinf.pstatic.net';
const PLATFORM='https://platform.editor.naver.com';
const hash=b=>createHash('sha256').update(b).digest('hex');
const fail=code=>{throw new CafeApiError(code);};
export async function boundedMedia(response,limit=10*1024*1024){
  const parts=[];let size=0;
  for await(const part of response.body??[]){size+=part.length;if(size>limit)fail('MEDIA_RESPONSE_SIZE');parts.push(part);}
  return Buffer.concat(parts);
}
export async function cafeUploadContext(editor,{fetchImpl=fetch,capture=async()=>{}}={}){
  if(editor?.appCode!=='cafepc001'||typeof editor.token!=='string'||editor.article?.writerId!=null&&editor.article.writerId!==editor.userId)fail('MEDIA_OWNER_CONTEXT');
  const r=await fetchImpl(PLATFORM+'/api/cafepc001/v1/service_config',{method:'GET',redirect:'manual',headers:{'SE-Authorization':editor.token,referer:'https://cafe.naver.com/'},signal:AbortSignal.timeout(20000)});
  if(r.status!==200||!/application\/json/i.test(r.headers.get('content-type')??''))fail('MEDIA_CONTEXT_HTTP');
  const raw=await boundedMedia(r,128*1024);await capture('service-config',raw);
  let config;try{config=JSON.parse(raw);}catch{fail('MEDIA_CONTEXT_SCHEMA');}
  if(config.infraInfo?.photoInfra?.domain!=='cafe.upphoto.naver.com'||config.infraInfo.photoInfra.imageHost!==CAFE_IMAGE_ORIGIN||
    config.apiInfo?.fetchPhotoUploadSessionKey!==PLATFORM+'/api/cafepc001/v1/photo-uploader/session-key')fail('MEDIA_CONTEXT_SCHEMA');
  return {token:config.userInfo?.token||editor.token,appCode:'cafepc001'};
}
export function cafeImageComponent(receipt){
  const u=new URL(receipt.publishedUrl);
  if(receipt.appCode!=='cafepc001'||receipt.readbackVerified!==true||u.origin!==CAFE_IMAGE_ORIGIN||u.search||u.hash)fail('UPLOAD_RECEIPT_UNVERIFIED');
  return {id:`SE-${randomUUID()}`,'@ctype':'image',layout:'default',src:u.href+'?type=w1',path:u.pathname,domain:CAFE_IMAGE_ORIGIN,
    internalResource:true,represent:false,fileSize:receipt.fileSize,fileName:receipt.fileName,width:receipt.width,height:receipt.height,
    originalWidth:receipt.width,originalHeight:receipt.height,widthPercentage:0,format:'normal',displayFormat:'normal',
    origin:{'@ctype':'imageOrigin',srcFrom:'local'},contentMode:'normal',ai:false};
}
// Reuses the blog's journaled SmartEditor ONE transport/XML parser and exact-byte download verification.
// Tokens and upload-session URLs are confined to request memory; capture callbacks must protect raw bodies with DPAPI.
export class CafeMediaUploader{
  constructor({session,cafeId='31796283',journalDir,fetchImpl=fetch,capture=async()=>{}}){
    if(String(cafeId)!=='31796283'||!journalDir)fail('MEDIA_SCOPE');
    Object.assign(this,{session,cafeId,journal:new WriteJournal(journalDir),fetchImpl,capture,context:null});
  }
  async prepare({articleId,menuId}){
    const r=await this.session.managerRequest('articleEditor',{articleId,menuId});
    const e=r.data.result??r.data.message?.result;
    if(articleId!=null&&String(e.article?.articleId)!==String(articleId)||String(e.selectedMenu?.menu?.menuId)!==String(menuId))fail('MEDIA_SCOPE');
    this.context=await cafeUploadContext(e,{fetchImpl:this.fetchImpl,capture:this.capture});
  }
  async upload(block,{runDir}){
    if(!this.context)fail('MEDIA_CONTEXT_MISSING');
    const u=new URL(block.publishedUrl??'');
    if(u.protocol!=='https:'||!(/^(?:blogfiles|cafeptthumb-phinf|phinf|dthumb-phinf|ssl)\.pstatic\.net$/.test(u.hostname))||u.username||u.password||u.hash||u.search&&!block.videoFallback)fail('MEDIA_SOURCE_SCOPE');
    const r=await this.fetchImpl(u.href,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(20000)});
    if(r.status!==200||!/^image\/(png|jpeg)/i.test(r.headers.get('content-type')??''))fail('MEDIA_SOURCE_HTTP');
    let bytes=await boundedMedia(r);
    if(block.sha256&&hash(bytes)!==block.sha256)fail('MEDIA_SOURCE_HASH');
    if(block.file){const file=path.resolve(runDir,block.file);if(hash(await readFile(file))!==hash(bytes))fail('MEDIA_FINAL_IMAGE_MISMATCH');}
    if(block.videoFallback&&bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'){
      try{bytes=execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-i','pipe:0','-frames:v','1','-f','image2pipe','-vcodec','png','pipe:1'],{input:bytes,windowsHide:true,maxBuffer:10*1024*1024,timeout:20000});}catch{fail('MEDIA_THUMBNAIL_CONVERSION');}
    }
    const fileName='cafe-'+hash(bytes).slice(0,24)+'.png';
    const key=this.journal.key('uploadPng',{blogId:this.cafeId},{sha256:hash(bytes),fileName});
    let previous;try{previous=await this.journal.read(key);}catch{}
    let receipt;
    if(['verified','uploaded_pending_readback'].includes(previous?.state)){
      receipt=previous.receipt;
      const resultUrl=new URL(receipt.publishedUrl);
      if(resultUrl.origin!==CAFE_IMAGE_ORIGIN||resultUrl.search||resultUrl.hash||receipt.sha256!==hash(bytes)||receipt.cafeId!==this.cafeId)fail('UPLOAD_RECEIPT_UNVERIFIED');
      const check=await this.fetchImpl(receipt.publishedUrl,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(20000)});
      if(check.status!==200||hash(await boundedMedia(check))!==hash(bytes))fail('UPLOAD_READBACK_MISMATCH');
      if(previous.state==='uploaded_pending_readback'){receipt={...receipt,readbackVerified:true};delete receipt.code;await this.journal.finish(key,'verified',receipt);}
    }else{
      receipt=await uploadPng({bytes,fileName,blogId:this.cafeId,...this.context,journal:this.journal},{fetchImpl:this.fetchImpl});
    }
    return {component:cafeImageComponent(receipt),receipt};
  }
}
