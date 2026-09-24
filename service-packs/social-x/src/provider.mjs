import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {XError} from './client.mjs';

// Trusted local code only. This module never reads browser databases or HAR files.
export async function openProvider({modulePath,env=process.env,now=Date.now,importModule=u=>import(u)}={}) {
  let provider;
  if(modulePath) {
    if(!path.isAbsolute(modulePath))throw new XError('PROVIDER_ABSOLUTE_PATH_REQUIRED');
    provider=(await importModule(pathToFileURL(modulePath).href)).default;
    if(typeof provider?.getSession!=='function')throw new XError('PROVIDER_INTERFACE');
  } else {
    provider={getSession:async()=>({authToken:env.X_AUTH_TOKEN,csrfToken:env.X_CSRF_TOKEN,bearerToken:env.X_BEARER_TOKEN})};
  }
  let session;
  try {
    session=await provider.getSession({origin:'https://x.com'});
    if(!session||typeof session!=='object')throw new XError('PROVIDER_SESSION');
    if(session.origin!==undefined&&session.origin!=='https://x.com')throw new XError('PROVIDER_ORIGIN');
    if(session.expiresAt!==undefined&&(!Number.isFinite(Date.parse(session.expiresAt))||Date.parse(session.expiresAt)<=now()))throw new XError('PROVIDER_EXPIRED');
    for(const key of ['authToken','csrfToken','bearerToken'])if(typeof session[key]!=='string'||!session[key])throw new XError('PROVIDER_INCOMPLETE');
  }catch(e){await provider.close?.();throw e;}
  let closed=false;
  return {
    credentials:{authToken:session.authToken,csrfToken:session.csrfToken,bearerToken:session.bearerToken},
    transactionProvider:typeof provider.getTransactionId==='function'?async({method,path})=>{
      if(closed)throw new XError('PROVIDER_CLOSED');
      if(!['GET','POST'].includes(method)||!/^\/i\/api\/graphql\/[\w-]+\/(UserByScreenName|UserOriginalsTimeline|TweetDetail|CreateTweet)$/.test(path))throw new XError('PROVIDER_REQUEST_SCOPE');
      return await provider.getTransactionId({origin:'https://x.com',method,path});
    }:undefined,
    async close(){if(closed)return;closed=true;for(const key of Object.keys(this.credentials))delete this.credentials[key];session=null;await provider.close?.();}
  };
}
