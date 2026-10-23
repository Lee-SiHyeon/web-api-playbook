import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {ThreadsError} from './errors.mjs';
import {ORIGIN} from './public.mjs';

const printable=v=>typeof v==='string'&&v.length>0&&v.length<=4096&&/^[\x21-\x7e]+$/.test(v)&&!/[;,]/.test(v);
const REQUIRED_COOKIES=['sessionid','csrftoken','ds_user_id'];
// Write scope only: the exact Threads web routes this client sends with account credentials.
const WRITE_PATHS=/^\/api\/v1\/media\/configure_text_only_post\/$/;

// Trusted local code only. This module never reads browser databases or HAR files.
export async function openProvider({modulePath,env=process.env,now=Date.now,importModule=u=>import(u)}={}){
  let provider;
  if(modulePath){
    if(!path.isAbsolute(modulePath))throw new ThreadsError('PROVIDER_ABSOLUTE_PATH_REQUIRED');
    provider=(await importModule(pathToFileURL(modulePath).href)).default;
    if(typeof provider?.getSession!=='function')throw new ThreadsError('PROVIDER_INTERFACE');
  } else {
    provider={getSession:async()=>({owner:env.THREADS_OWNER,
      cookies:{sessionid:env.THREADS_SESSIONID,csrftoken:env.THREADS_CSRFTOKEN,ds_user_id:env.THREADS_DS_USER_ID},
      lsd:env.THREADS_LSD,appId:env.THREADS_APP_ID,asbdId:env.THREADS_ASBD_ID,webSessionId:env.THREADS_WEB_SESSION_ID,userAgent:env.THREADS_USER_AGENT})};
  }
  let session;
  try{
    session=await provider.getSession({origin:ORIGIN});
    if(!session||typeof session!=='object')throw new ThreadsError('PROVIDER_SESSION');
    if(session.origin!==undefined&&session.origin!==ORIGIN)throw new ThreadsError('PROVIDER_ORIGIN');
    if(session.expiresAt!==undefined&&(!Number.isFinite(Date.parse(session.expiresAt))||Date.parse(session.expiresAt)<=now()))throw new ThreadsError('PROVIDER_EXPIRED');
    if(!/^[A-Za-z0-9_.]{1,30}$/.test(session.owner??''))throw new ThreadsError('PROVIDER_INCOMPLETE');
    for(const k of REQUIRED_COOKIES)if(!printable(session.cookies?.[k]))throw new ThreadsError('PROVIDER_INCOMPLETE');
    if(!/^\d{1,25}$/.test(session.cookies.ds_user_id))throw new ThreadsError('PROVIDER_INCOMPLETE');
    for(const k of ['lsd','appId'])if(!printable(session[k]))throw new ThreadsError('PROVIDER_INCOMPLETE');
    for(const k of ['asbdId','webSessionId'])if(session[k]!==undefined&&session[k]!==null&&session[k]!==''&&!printable(session[k]))throw new ThreadsError('PROVIDER_INCOMPLETE');
  }catch(e){await provider.close?.();throw e;}
  let closed=false;
  const credentials={owner:session.owner,ownerId:session.cookies.ds_user_id,
    cookies:Object.fromEntries(REQUIRED_COOKIES.map(k=>[k,session.cookies[k]])),
    lsd:session.lsd,appId:session.appId,asbdId:session.asbdId||undefined,webSessionId:session.webSessionId||undefined,
    userAgent:typeof session.userAgent==='string'&&session.userAgent&&!/[\r\n]/.test(session.userAgent)?session.userAgent:undefined};
  session=null;
  return {
    credentials,
    // Credentials are only released for an exact https://www.threads.com write path.
    headersFor(url){
      if(closed)throw new ThreadsError('PROVIDER_CLOSED');
      const u=new URL(url);
      if(u.origin!==ORIGIN||!WRITE_PATHS.test(u.pathname)||u.search||u.hash)throw new ThreadsError('PROVIDER_REQUEST_SCOPE');
      const c=credentials;
      const h={cookie:Object.entries(c.cookies).map(([k,v])=>`${k}=${v}`).join('; '),'X-CSRFToken':c.cookies.csrftoken,'X-IG-App-ID':c.appId,'X-FB-LSD':c.lsd};
      if(c.asbdId)h['X-ASBD-ID']=c.asbdId;
      if(c.webSessionId)h['X-Web-Session-ID']=c.webSessionId;
      if(c.userAgent)h['User-Agent']=c.userAgent;
      return h;
    },
    async close(){if(closed)return;closed=true;for(const k of Object.keys(credentials))delete credentials[k];await provider.close?.();}
  };
}
