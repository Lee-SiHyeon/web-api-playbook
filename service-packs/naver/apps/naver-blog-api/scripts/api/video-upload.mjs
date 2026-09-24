import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import {fingerprint} from '../../../../packages/contracts/src/index.mjs';

const PLATFORM='https://platform.editor.naver.com',NEXUS='https://nexus.vod.naver.com';
export const VIDEO_CHUNK_BYTES=5*1024*1024;
export const VIDEO_MAX_BYTES=256*1024*1024;
const digest=b=>createHash('sha256').update(b).digest('hex');
const fail=(code,details)=>{const e=Error(code);e.code=code;if(details)e.details=details;throw e;};
const vid=v=>typeof v==='string'&&/^[A-F0-9]{36}$/.test(v);
const positive=n=>Number.isFinite(n)&&n>0;
const secret=v=>typeof v==='string'&&v.length>8&&v.length<8192&&!/[\x00-\x20\x7f]/.test(v);
const safeThumbnail=value=>{let u;try{u=new URL(value)}catch{fail('VIDEO_THUMBNAIL_SCHEMA')}
 if(u.origin!=='https://phinf.pstatic.net'||!u.pathname.startsWith('/image.nmv/')||u.search||u.hash||u.username||u.password)fail('VIDEO_THUMBNAIL_SCHEMA');return u.href;};
export function validateVideoInput(bytes,fileName){
 if(!Buffer.isBuffer(bytes)||bytes.length<32||bytes.length>VIDEO_MAX_BYTES||path.basename(fileName)!==fileName||
 !/^[-A-Za-z0-9_]+\.(mp4|webm)$/.test(fileName))fail('VIDEO_INPUT');
 const webm=fileName.endsWith('.webm')&&bytes.subarray(0,4).toString('hex')==='1a45dfa3';
 const mp4=fileName.endsWith('.mp4')&&bytes.subarray(4,8).toString()==='ftyp';
 if(!webm&&!mp4)fail('VIDEO_CONTAINER_MISMATCH');return webm?'video/webm':'video/mp4';
}
async function bounded(response,limit){
 const chunks=[];let size=0;
 for await(const chunk of response.body||[]){size+=chunk.length;if(size>limit)fail('VIDEO_RESPONSE_SIZE');chunks.push(chunk)}
 return Buffer.concat(chunks);
}
async function request(url,init,{fetchImpl,timeoutMs},write=false){
 if(new URL(url).hostname.endsWith('.vod.naver.com'))init={...init,headers:{origin:'https://blog.naver.com',referer:'https://blog.naver.com/',...init.headers}};
 let response;try{response=await fetchImpl(url,{...init,redirect:'manual',signal:AbortSignal.timeout(timeoutMs)})}
 catch(e){fail(write?'VIDEO_OUTCOME_UNKNOWN':'VIDEO_TRANSPORT',{transport:e.name||'Error'})}
 if(response.status!==200){await response.body?.cancel();fail(write?'VIDEO_OUTCOME_UNKNOWN':'VIDEO_HTTP',{httpStatus:response.status})}
 return response;
}
async function json(url,init,deps,write=false){
 const res=await request(url,init,deps,write);
 if(!/(?:application\/json|text\/plain)/i.test(res.headers.get('content-type')||''))fail(write?'VIDEO_OUTCOME_UNKNOWN':'VIDEO_RESPONSE_SCHEMA',{httpStatus:res.status,jsonContentType:false});
 try{return JSON.parse((await bounded(res,512*1024)).toString('utf8'))}catch{fail(write?'VIDEO_OUTCOME_UNKNOWN':'VIDEO_RESPONSE_SCHEMA')}
}
// Exact field selections observed in editor 1.78.1 on 2026-09-24.
// GraphQL is a read despite POST. The id is a runtime upload-session key.
const stages=[
 {types:['Ingest','VideoHeader'],fragments:'fragment ingest on Ingest { videoId encodeType }\nfragment videoHeader on VideoHeader { videoCodec videoBitrate audioCodec audioBitrate audioSamplingRate audioChannel audioSamplingBit duration width height fps rotation fileSize }',spread:'...ingest ...videoHeader'},
 {types:['VideoHashCode','Thumbnails','Encoding','Hls','AbrHls'],fragments:'fragment videoHashCode on VideoHashCode { videoMD5 videoSHA256 }\nfragment thumbnails on Thumbnails { type path timeMark }\nfragment encoding on Encoding { encoding complete percentage totalFrames qualityId }\nfragment hls on Hls { status qualityId }\nfragment abrHls on AbrHls { status }',spread:'...videoHashCode ...thumbnails ...encoding ...hls ...abrHls'}
];
export function videoStatusQuery(key,stage=0){
 if(!secret(key)||![0,1].includes(stage))fail('VIDEO_RUNTIME_SESSION_REQUIRED');
 const spec=stages[stage];
 return '{ _0_0: video(id: '+JSON.stringify(key)+', type: '+JSON.stringify(spec.types)+') { type status data { '+spec.spread+' } errors { code message } } }\n'+spec.fragments;
}
async function pollStatus(key,stage,deps){
 const p=await json(NEXUS+'/postman/api/v1/files',{method:'POST',headers:{'content-type':'text/plain'},body:JSON.stringify({query:videoStatusQuery(key,stage)})},deps);
 if(p?.code!==200||!Array.isArray(p.data?._0_0)||!Array.isArray(p.errors)||p.errors.length)fail('VIDEO_STATUS_SCHEMA');
 const entries=p.data._0_0;
 if(entries.some(e=>!stages[stage].types.includes(e.type)||!Array.isArray(e.data)||!Array.isArray(e.errors)))fail('VIDEO_STATUS_SCHEMA');
 if(entries.some(e=>e.status==='error'||e.status==='failed'||e.errors.length))fail('VIDEO_PROCESSING_FAILED');
 return new Map(entries.map(e=>[e.type,e]));
}
const done=(map,type)=>map.get(type)?.status==='done'&&map.get(type)?.data?.length>0;
async function thumbnailReadback(url,deps){
 const response=await request(safeThumbnail(url),{method:'GET',headers:{accept:'image/jpeg'}},deps);
 if(!/image\/jpeg/i.test(response.headers.get('content-type')||''))fail('VIDEO_THUMBNAIL_READBACK');
 const bytes=await bounded(response,10*1024*1024);
 if(bytes.length<4||bytes.readUInt16BE(0)!==0xffd8)fail('VIDEO_THUMBNAIL_READBACK');
 return {url,sha256:digest(bytes),bytes:bytes.length};
}
async function finishProcessing(base,key,deps){
 const all=new Map();let stage=0;
 for(let poll=0;poll<deps.maxPolls;poll++){
  const entries=await pollStatus(key,stage,deps);for(const [type,item]of entries)all.set(type,item);
  if(stage===0&&done(all,'Ingest')&&done(all,'VideoHeader')){stage=1;continue;}
  if(stage===1&&done(all,'VideoHashCode')&&done(all,'Thumbnails')&&(done(all,'Hls')||done(all,'AbrHls'))){
   const header=all.get('VideoHeader').data[0],ingest=all.get('Ingest').data[0],hash=all.get('VideoHashCode').data[0];
   if(ingest.videoId!==base.videoId||ingest.encodeType!=='normal'||header.fileSize!==base.fileSize||
    ![header.width,header.height,header.duration].every(positive)||header.duration>25200||![0,90,180,270].includes(header.rotation))fail('VIDEO_PROCESSING_MISMATCH');
   if(hash.videoSHA256?.toLowerCase()!==base.sha256)fail('VIDEO_SOURCE_HASH_MISMATCH');
   const thumb=all.get('Thumbnails').data.find(t=>t.type==='SCENE'&&t.timeMark===0);
   if(!thumb)fail('VIDEO_THUMBNAIL_SCHEMA');
   const thumbnail=await thumbnailReadback(thumb.path,deps),rotated=[90,270].includes(header.rotation);
   return {...base,checkedAt:deps.now().toISOString(),state:'ready',fileTransferred:true,processingReady:true,
    sourceHashVerified:true,serverSourceSha256:hash.videoSHA256.toLowerCase(),thumbnail,playTime:header.duration,
    width:rotated?header.height:header.width,height:rotated?header.width:header.height,
    rotation:header.rotation,format:'normal',readbackVerified:true};
  }
  await deps.sleep(deps.pollIntervalMs);
 }
 return {...base,checkedAt:deps.now().toISOString(),state:'processing_pending',fileTransferred:base.fileTransferred===true,processingReady:false,readbackVerified:false};
}
function dependencies(options={}){
 return {fetchImpl:fetch,now:()=>new Date(),timeoutMs:30000,maxPolls:60,pollIntervalMs:2000,
 sleep:ms=>new Promise(r=>setTimeout(r,ms)),...options};
}
function metadata(value={}){
 const title=value.title??'',description=value.description??'',tags=value.tags??[];
 if(typeof title!=='string'||!title.trim()||title.length>40||typeof description!=='string'||description.length>1000||
 !Array.isArray(tags)||tags.length>10||tags.some(t=>typeof t!=='string'||!t.trim()||t.length>30)||typeof(value.ai??false)!=='boolean')fail('VIDEO_METADATA');
 return {title,description,tags,ai:value.ai??false};
}
export const videoJournalKey=(journal,{blogId,sha256,fileName})=>journal.key('uploadVideo',{blogId},{sha256,fileName});
export async function uploadVideo({bytes,fileName,blogId,token,appCode,journal,meta},options={}){
 if(!journal)fail('JOURNAL_REQUIRED');
 const mime=validateVideoInput(bytes,fileName),mediaMeta=metadata(meta),deps=dependencies(options);
 let claims;try{claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url'))}catch{fail('VIDEO_CONTEXT_INVALID')}
 if(appCode!=='blogpc001'||!secret(token)||!Number.isFinite(claims.exp)||claims.exp*1000<=deps.now().getTime())fail('VIDEO_CONTEXT_INVALID');
 const sha256=digest(bytes),journalKey=videoJournalKey(journal,{blogId,sha256,fileName});
 // Existing logical attempts are read before acquiring a new upload identity.
 try{await journal.read(journalKey);fail('WRITE_ALREADY_ATTEMPTED_READBACK_REQUIRED')}catch(e){if(e.code!=='ENOENT')throw e;}
 const grant=await json(PLATFORM+'/api/blogpc001/v2/video-uploader/token',{method:'GET',headers:{
  accept:'application/json','SE-Authorization':token,'SE-App-Id':'SE-'+randomUUID(),referer:'https://blog.naver.com/'}},deps);
 if(!secret(grant?.token)||grant.type!=='UPLOAD'||!vid(grant.videoId)||grant.data?.serviceId!==2||
 !(typeof grant.data?.userId==='string'&&grant.data.userId.length>0&&grant.data.userId.length<=200&&!/[\x00-\x1f\x7f]/.test(grant.data.userId))||grant.data.fileSizeLimit<bytes.length)fail('VIDEO_TOKEN_SCHEMA');
 const base={schemaVersion:1,operation:'uploadVideo',source:'independent_http',blogId,sha256,fileName,fileSize:bytes.length,
  mimeType:mime,videoId:grant.videoId,serviceId:2,mediaMeta,checkedAt:deps.now().toISOString()};
 await journal.reserve(journalKey,{...base,phase:'allocating'});
 let runtimeKey='',progress={...base,state:'allocation_pending',fileTransferred:false,readbackVerified:false};
 try{
  const allocation=await json(NEXUS+'/warp/2/upload/v4/'+grant.videoId+'/sessions',{method:'POST',
   headers:{'content-type':'application/json; charset=UTF-8'},body:JSON.stringify({token:grant.token,userId:grant.data.userId,
    serviceId:2,chunkSize:VIDEO_CHUNK_BYTES,fileName,fileSize:bytes.length,chunkUpload:true})},deps,true);
  if(allocation.videoId!==grant.videoId||allocation.serviceId!==2||!secret(allocation.key)||allocation.chunkUpload!==true||
   allocation.fileSize!==bytes.length||allocation.fileName!==fileName||allocation.chunkSize!==VIDEO_CHUNK_BYTES||
   !Array.isArray(allocation.servers)||!allocation.servers.length)fail('VIDEO_ALLOCATION_SCHEMA');
  // Hostnames are provided by the observed allocation, but still confined to VOD.
  const server=allocation.servers[0];
  if(typeof server!=='string'||!/^warp-[a-z0-9-]+\.vod\.naver\.com$/.test(server))fail('VIDEO_UPLOAD_ORIGIN');
  runtimeKey=allocation.key;
  progress={...base,state:'transferring',fileTransferred:false,acknowledgedChunks:0,readbackVerified:false};
  await journal.finish(journalKey,'transferring',progress);
  for(let offset=0,index=1;offset<bytes.length;offset+=VIDEO_CHUNK_BYTES,index++){
   const chunk=bytes.subarray(offset,Math.min(offset+VIDEO_CHUNK_BYTES,bytes.length)),form=new FormData();
   for(const [key,value]of Object.entries({key:runtimeKey,fileName,fileSize:bytes.length,chunkIndex:index,
    chunkSize:VIDEO_CHUNK_BYTES,currentChunkSize:chunk.length,chunkUpload:true}))form.set(key,String(value));
   form.set('file',new Blob([chunk],{type:mime}),fileName);
   const ack=await json('https://'+server+'/upload/v2/files',{method:'POST',body:form},deps,true);
   if(ack.result!==true||ack.chunkIndex!==index||ack.chunkSize!==chunk.length)fail('VIDEO_CHUNK_ACK_MISMATCH');
   progress={...progress,acknowledgedChunks:index};await journal.finish(journalKey,'transferring',progress);
  }
  progress={...progress,state:'processing_pending',fileTransferred:true};
  await journal.finish(journalKey,'processing_pending',progress);
  const receipt=await finishProcessing({...base,fileTransferred:true},runtimeKey,deps);
  await journal.finish(journalKey,receipt.processingReady?'verified':'processing_pending',receipt);return receipt;
 }catch(e){
  await journal.finish(journalKey,'submitted_unknown',{...progress,state:'submitted_unknown',
   code:/^[A-Z_]+$/.test(e.code||'')?e.code:'VIDEO_OUTCOME_UNKNOWN',details:e.details||{}});
  fail(e.code||'VIDEO_OUTCOME_UNKNOWN',e.details);
 }finally{token='';grant.token='';runtimeKey='';}
}
export async function reconcileVideoUpload({blogId,sha256,fileName,journal,runtimeSessionKey},options={}){
 const deps=dependencies(options),key=videoJournalKey(journal,{blogId,sha256,fileName}),record=await journal.read(key);
 if(record.operation!=='uploadVideo'||record.blogId!==blogId||record.sha256!==sha256||record.fileName!==fileName)fail('VIDEO_JOURNAL_SCOPE');
 if(record.state==='verified'){await verifiedVideoComponent(record.receipt,{blogId,journal,...deps});return record.receipt}
 // Session keys are intentionally not persisted. A process restart never causes a new POST.
 if(!secret(runtimeSessionKey))fail('VIDEO_RUNTIME_SESSION_REQUIRED');
 const base=Object.fromEntries(['schemaVersion','operation','source','blogId','sha256','fileName','fileSize','mimeType','videoId','serviceId','mediaMeta'].map(k=>[k,record[k]]));
 const receipt=await finishProcessing({...base,fileTransferred:record.receipt?.fileTransferred===true},runtimeSessionKey,deps);
 await journal.finish(key,receipt.processingReady?'verified':'processing_pending',receipt);return receipt;
}
export async function verifiedVideoComponent(receipt,{blogId,journal,...options}){
 if(!journal||receipt?.operation!=='uploadVideo'||receipt.source!=='independent_http'||receipt.blogId!==blogId||
 receipt.processingReady!==true||receipt.readbackVerified!==true||receipt.sourceHashVerified!==true||!vid(receipt.videoId)||
 !/^[a-f0-9]{64}$/.test(receipt.sha256||'')||receipt.serverSourceSha256!==receipt.sha256||
 ![receipt.width,receipt.height,receipt.playTime,receipt.fileSize].every(positive))fail('VIDEO_RECEIPT_UNVERIFIED');
 const record=await journal.read(videoJournalKey(journal,receipt));
 if(record.state!=='verified'||fingerprint(record.receipt)!==fingerprint(receipt))fail('VIDEO_RECEIPT_UNVERIFIED');
 const thumb=await thumbnailReadback(receipt.thumbnail?.url,dependencies(options));
 if(thumb.sha256!==receipt.thumbnail.sha256)fail('VIDEO_THUMBNAIL_READBACK');
 const {title,description,tags,ai}=metadata(receipt.mediaMeta);
 return {'@ctype':'video',id:'SE-'+randomUUID(),layout:'default',contentMode:'normal',vid:receipt.videoId,internalResource:true,
  fileSize:receipt.fileSize,playTime:receipt.playTime,width:receipt.width,height:receipt.height,
  originalWidth:receipt.width,originalHeight:receipt.height,format:'normal',represent:false,
  thumbnail:{'@ctype':'thumbnail',src:thumb.url,alt:''},mediaMeta:{'@ctype':'mediaMeta',title,description,tags},
  caption:[],origin:{'@ctype':'videoOrigin',srcFrom:'local'},ai,videoInfraServiceId:'2'};
}
