// Request BUILDERS only, ported from affiliate-api-hub/scripts/sns/writers/threads.mjs.
// Not wired into the CLI. Upload-only replays succeeded upstream (2026-09-28); configure/publish of an
// image or video post is NOT verified, so publish() rejects media with THREADS_MEDIA_PUBLISH_UNVERIFIED.
import {ThreadsError} from './errors.mjs';
import {ORIGIN} from './public.mjs';
let last=0;
// Evidence: BarcelonaComposerUploadID — numeric timestamp string, +1 if the clock repeats.
export function newUploadId(now=Date.now()){last=now>last?now:last+1;return String(last);}
function base(bytes,mimeType,entityName){
  const body=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes||[]);
  return {body,headers:{'Content-Type':mimeType,Offset:'0','X-Entity-Length':String(body.length),'X-Entity-Name':entityName,'X-Entity-Type':mimeType}};
}
// Evidence: logged-in excerpt `rupload_igphoto`.
export function buildPhotoUploadRequest({bytes,width,height,uploadId,mimeType='image/png',sidecar=false}){
  const entityName=`fb_uploader_${uploadId}`;const {body,headers}=base(bytes,mimeType,entityName);
  if(!body.length||!uploadId||!Number.isInteger(width)||width<1||!Number.isInteger(height)||height<1||!['image/png','image/jpeg'].includes(mimeType))throw new ThreadsError('THREADS_IMAGE_INVALID');
  headers['X-Instagram-Rupload-Params']=JSON.stringify({is_sidecar:sidecar?'1':'0',is_threads:'1',media_type:1,upload_id:uploadId,upload_media_height:height,upload_media_width:width});
  return {method:'POST',url:`${ORIGIN}/rupload_igphoto/${encodeURIComponent(entityName)}`,headers,body};
}
// Evidence: BarcelonaMediaUploadAPI `rupload_igvideo`; success shape {status:"ok",media_id:<number>}.
export function buildVideoUploadRequest({bytes,width,height,uploadId,sidecar=false}){
  const entityName=`fb_uploader_${uploadId}`;const {body,headers}=base(bytes,'video/mp4',entityName);
  if(!body.length||body.length>500*1024*1024||!/^\d{1,20}$/.test(String(uploadId))||!Number.isInteger(width)||width<1||!Number.isInteger(height)||height<1||body.length<12||body.toString('ascii',4,8)!=='ftyp')throw new ThreadsError('THREADS_VIDEO_INVALID');
  headers['X-Instagram-Rupload-Params']=JSON.stringify({extract_cover_frame:'1',is_sidecar:sidecar?'1':'0',is_threads:'1',media_type:2,upload_id:uploadId,upload_media_height:height,upload_media_width:width});
  return {method:'POST',url:`${ORIGIN}/rupload_igvideo/${encodeURIComponent(entityName)}`,headers,body};
}
export function validateVideoUploadResponse(p){if(!(p?.status==='ok'&&/^\d{1,30}$/.test(String(p?.media_id??''))))throw new ThreadsError('THREADS_VIDEO_UPLOAD_SCHEMA');return true;}
