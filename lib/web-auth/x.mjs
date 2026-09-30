import path from 'node:path';
import { CookieJar } from 'tough-cookie';
import { ScopedSession } from '../scoped-session.mjs';
import { ProtectedStore } from '../protected-store.mjs';
import { withSessionLock } from '../session-lock.mjs';
import { WebAuthError } from './myrealtrip.mjs';
import { createHttpXTransaction } from './x-transaction.mjs';
import { cachedXOwner, rememberXOwner, forgetXOwner } from './x-owner-cache.mjs';

const ORIGINS=['https://x.com','https://api.x.com'];
const NAME='x-web-state';
const fail=c=>{throw new WebAuthError(c);};
const validOwnerUrl=value=>{try{const u=new URL(value);return u.origin==='https://api.x.com'&&u.pathname==='/1.1/account/settings.json'&&!u.hash&&!u.username&&!u.password&&[...u.searchParams].every(([k,v])=>(k.startsWith('include_')&&v==='true')||(k==='ext'&&v==='ssoConnections'));}catch{return false;}};
export function createXAuth({store=new ProtectedStore(),fetchImpl=fetch}={}) {
  const locked=fn=>withSessionLock(fn,{root:path.join(store.directory,'locks'),key:NAME});
  const save=s=>store.write(NAME,JSON.stringify(s));
  function load() {
    let s; const raw=store.read(NAME);if(!raw)fail('SESSION_MISSING');
    try{s=JSON.parse(raw);}catch{fail('AUTH_STATE_INVALID');}
    if(s?.version!==1||!validOwnerUrl(s.ownerUrl)||!/^\w{1,15}$/.test(s.handle)||
      JSON.stringify(s.session?.allowedOrigins)!==JSON.stringify(ORIGINS)||
      JSON.stringify(s.session?.cookieOrigins)!==JSON.stringify(ORIGINS))fail('AUTH_STATE_INVALID');
    return s;
  }
  function credentials(s) {
    const jar=CookieJar.deserializeSync(s.session.cookieJar);
    const cookies=jar.getCookiesSync('https://api.x.com/');
    const authToken=cookies.find(c=>c.key==='auth_token')?.value;
    const csrfToken=cookies.find(c=>c.key==='ct0')?.value;
    if(!authToken||!csrfToken)fail('REAUTH_REQUIRED');
    // The stored browser user-agent goes along: api.x.com/graphql answers 404 to Node's default agent (observed 2026-09-28).
    const ua=s.session.defaultHeaders?.['user-agent'];
    return {authToken,csrfToken,bearerToken:s.session.headersByOrigin['https://api.x.com'].authorization.replace(/^Bearer /,''),...(ua?{clientHeaders:{'user-agent':ua}}:{})};
  }
  async function verify(s, { persist = true, allowCached = false } = {}) {
    const c=credentials(s);
    s.session.headersByOrigin['https://api.x.com']['x-csrf-token']=c.csrfToken;
    let session=ScopedSession.fromJSON(s.session,{fetchImpl});
    try {
      const transaction=await createHttpXTransaction(session,{fetchImpl,expectedOwner:s.handle});
      s.session=session.toJSON();
      s.session.headersByOrigin['https://api.x.com']['x-csrf-token']=credentials(s).csrfToken;
      let owner = transaction.ownerProof;
      if (!owner && transaction.ownerIncomplete && allowCached) owner = cachedXOwner(s.handle,c.authToken);
      if (!owner && transaction.ownerIncomplete) {
        s.session.headersByOrigin['https://api.x.com']['x-client-transaction-id']=await transaction.generate('GET','/1.1/account/settings.json');
        session=ScopedSession.fromJSON(s.session,{fetchImpl});
        const r=await session.request(s.ownerUrl);
        if(r.status!==200 || !r.headers['content-type']?.includes('json')) throw new WebAuthError('AUTH_RESPONSE_INVALID',{operation:'owner_verify',httpStatus:r.status});
        let b;try{b=JSON.parse(r.raw);}catch{fail('AUTH_RESPONSE_INVALID');}
        if(b.errors?.length || b.screen_name?.toLowerCase()!==s.handle.toLowerCase())fail('OWNER_MISMATCH');
        owner={screen_name:b.screen_name,receipt:{ownerVerified:true,ownerVerificationMethod:'account_settings'}};
      }
      if(!owner)fail('OWNER_MISMATCH');
      if(!owner.receipt.ownerVerificationCached) rememberXOwner(s.handle,c.authToken,owner);
      const ownerVerificationMethod=owner.receipt.ownerVerificationMethod;
      s.session=session.toJSON();credentials(s);
      s.ownerVerifiedAt=new Date().toISOString();
      return {receipt:{authenticated:true,ownerVerified:true,browserUsed:false,renewal:'stored_web_session',ownerVerificationMethod,ownerVerificationCached:owner.receipt.ownerVerificationCached===true},transaction};
    } catch(error) {
      forgetXOwner(s.handle,c.authToken);
      throw error;
    } finally {
      s.session=session.toJSON();
      delete s.session.headersByOrigin['https://api.x.com']['x-client-transaction-id'];
      if(persist)save(s);
    }
  }
  return {
    status:()=>({service:'x',sessionStored:store.status(NAME).available,currentAuthentication:'not_checked',passwordLoginImplemented:false}),
    health:()=>locked(async()=>(await verify(load())).receipt),
    ensure:()=>locked(async()=>(await verify(load())).receipt),
    importSession:input=>locked(async()=>{
      if(!validOwnerUrl(input.ownerUrl)||!/^\w{1,15}$/.test(input.handle)||!Array.isArray(input.cookies)||
        typeof input.authorization!=='string'||!/^Bearer [A-Za-z0-9%._~-]+$/.test(input.authorization)||
        typeof input.userAgent!=='string'||/[\r\n]/.test(input.userAgent))fail('AUTH_IMPORT_INVALID');
      const csrf=input.cookies.find(c=>c.name==='ct0')?.value;if(!csrf)fail('AUTH_IMPORT_INVALID');
      const session=new ScopedSession({allowedOrigins:ORIGINS,cookieOrigins:ORIGINS,
        cookies:input.cookies.filter(c=>['auth_token','ct0','twid'].includes(c.name)),
        defaultHeaders:{accept:'application/json','user-agent':input.userAgent},
        headersByOrigin:{'https://api.x.com':{authorization:input.authorization,'x-csrf-token':csrf,
          'x-twitter-auth-type':'OAuth2Session','x-twitter-active-user':'yes','x-twitter-client-language':'en',referer:'https://x.com/'}},fetchImpl});
      const s={version:1,handle:input.handle,ownerUrl:input.ownerUrl,session:session.toJSON()};
      const {receipt}=await verify(s,{persist:false});
      save(s);
      return {...receipt,stored:true};
    }),
    withSession:callback=>locked(async()=>{
      const s=load();const {transaction}=await verify(s,{allowCached:true});const c=credentials(s);
      const session=ScopedSession.fromJSON(s.session,{fetchImpl});
      let closed=false;
      c.transactionProvider=async({method,path:route})=>{if(closed)fail('SESSION_CLOSED');return transaction.generate(method,route);};
      let businessSession=session;
      c.fetchImpl=async(rawUrl,init={})=>{
        if(closed)fail('SESSION_CLOSED');
        const url=new URL(rawUrl),method=init.method||'GET';
        if(method!=='GET')fail('X_BUSINESS_READ_ONLY');
        if(url.origin==='https://api.x.com'&&/^\/graphql\/[\w-]+\/(UserByScreenName|UserTweets|UserOriginalsTimeline|TweetDetail)$/.test(url.pathname)) {
          const current=businessSession.toJSON();
          const currentCredentials=credentials({...s,session:current});
          current.headersByOrigin[url.origin]['x-csrf-token']=currentCredentials.csrfToken;
          current.headersByOrigin[url.origin]['x-client-transaction-id']=await transaction.generate(method,url.pathname);
          businessSession=ScopedSession.fromJSON(current,{fetchImpl});
          const r=await businessSession.request(url.href);
          if([401,403].includes(r.status))forgetXOwner(s.handle,c.authToken);
          return new Response(r.raw,{status:r.status,headers:r.headers});
        }
        if(url.origin==='https://x.com'&&url.pathname==='/manifest.js') {
          const r=await businessSession.request(url.href);
          return new Response(r.raw,{status:r.status,headers:r.headers});
        }
        if(url.origin==='https://abs.twimg.com'&&/^\/responsive-web\/client-web\/main\.[\w-]+\.js$/.test(url.pathname)) {
          const publicSession=new ScopedSession({allowedOrigins:[url.origin],cookieOrigins:[],fetchImpl});
          const r=await publicSession.request(url.href);
          return new Response(r.raw,{status:r.status,headers:r.headers});
        }
        fail('X_BUSINESS_SCOPE');
      };
      try{return await callback(c);}finally{closed=true;for(const k of Object.keys(c))c[k]='';s.session=businessSession.toJSON();delete s.session.headersByOrigin['https://api.x.com']['x-client-transaction-id'];save(s);}
    }),
  };
}
