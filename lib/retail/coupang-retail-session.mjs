import path from 'node:path';
import { channel } from 'node:diagnostics_channel';
import { createHash } from 'node:crypto';
import { Cookie, CookieJar } from 'tough-cookie';
import { ProtectedStore } from '../protected-store.mjs';
import { ScopedSession } from '../scoped-session.mjs';
import { withSessionLock } from '../session-lock.mjs';
import { buildCoupangRscInput, parseCoupangRsc } from './coupang-rsc.mjs';
import { parseCoupangSignature, renewCoupangSignature, SIGNATURE_SOURCE } from './coupang-signature.mjs';

const ORIGIN='https://www.coupang.com';
export const COUPANG_RETAIL_STORE='coupang-retail-public-v1';
export const RETAIL_CONTEXT_LIMIT_MS=6*60*60*1000; // Local safety limit; server context lifetime is unverified.
export const RETAIL_COOKIE_NAMES=Object.freeze(['PCID','x-coupang-target-market','x-coupang-accept-language',
  'bm_mi','ak_bmsc','bm_sz','bm_so','bm_lso','_abck','bm_s','bm_sv','x-cp-s']);
const allowed=new Set([...RETAIL_COOKIE_NAMES,'sid']);
const deletedLoginCookies=new Set(['member_srl','ILOGIN','SAID']);
const fail=code=>{throw Object.assign(new Error(code),{code});};
const stateSchema='coupang-retail-public-session-v1';
const safeCode=e=>/^(?:COUPANG|SCOPED_SESSION|PROTECTED_STORE|SESSION_LOCK)_[A-Z_0-9]+$/.test(e?.code??'')?e.code:'COUPANG_RETAIL_FAILED';
const empty=o=>o && typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length===0;

function validateState(state,now) {
  if(state?.schema!==stateSchema||!Number.isFinite(Date.parse(state.bootstrapAt))||Date.parse(state.bootstrapAt)>now+1000
    ||!state.session)fail('COUPANG_RETAIL_STATE_INVALID');
  if(now-Date.parse(state.bootstrapAt)>RETAIL_CONTEXT_LIMIT_MS)fail('COUPANG_RETAIL_CONTEXT_REBOOTSTRAP_REQUIRED');
  const s=state.session;
  if(JSON.stringify(s.allowedOrigins)!==JSON.stringify([ORIGIN])||JSON.stringify(s.cookieOrigins)!==JSON.stringify([ORIGIN])
    ||s.allowLoopbackHttp!==false||!empty(s.defaultHeaders)||!empty(s.headersByOrigin)||s.maxRedirects!==0)
    fail('COUPANG_RETAIL_STATE_SCOPE');
  if(!Array.isArray(s.cookieJar?.cookies)||s.cookieJar.cookies.length>20)fail('COUPANG_RETAIL_STATE_SCOPE');
  const names=new Set();
  for(const c of s.cookieJar.cookies) {
    if(!allowed.has(c.key)||names.has(c.key)||!['coupang.com','www.coupang.com'].includes(c.domain)||c.path!=='/')fail('COUPANG_RETAIL_COOKIE_SCOPE');
    names.add(c.key);
  }
  if(!names.has('PCID')||!names.has('x-cp-s'))fail('COUPANG_RETAIL_CONTEXT_MISSING');
  ScopedSession.fromJSON(s); // Validate complete jar syntax before any network.
  if(Cookie.fromJSON(s.cookieJar.cookies.find(c=>c.key==='PCID'))?.expiryTime()<=now)fail('COUPANG_RETAIL_CONTEXT_REBOOTSTRAP_REQUIRED');
  const signature=s.cookieJar.cookies.find(c=>c.key==='x-cp-s');
  const fields=parseCoupangSignature(signature.value);
  if(Number(fields.c3)>now+1000)fail('COUPANG_RETAIL_SIGNATURE_CLOCK');
  return {signature,fields};
}

export function createCoupangRetailState(cookies,{bootstrapAt=new Date().toISOString()}={}) {
  if(!Array.isArray(cookies)||cookies.length>256)fail('COUPANG_RETAIL_IMPORT_INVALID');
  const selected=cookies.filter(c=>RETAIL_COOKIE_NAMES.includes(c.name));
  if(selected.length!==RETAIL_COOKIE_NAMES.length||new Set(selected.map(c=>c.name)).size!==selected.length)fail('COUPANG_RETAIL_IMPORT_INCOMPLETE');
  const session=new ScopedSession({allowedOrigins:[ORIGIN],cookieOrigins:[ORIGIN],cookies:selected,
    timeoutMs:20000,maxResponseBytes:8*1024*1024,maxRedirects:0});
  const state={schema:stateSchema,bootstrapAt,lastSuccessfulReadAt:null,session:session.toJSON()};
  validateState(state,Date.now());return state; // Secret result: protected store only.
}

export async function importCoupangRetailSession(envelope,{store=new ProtectedStore()}={}) {
  const now=Date.now(),age=now-Date.parse(envelope?.capturedAt);
  if(!Number.isFinite(age)||age<0||age>300000||envelope.origin!==ORIGIN||envelope.responseStatus!==200)
    fail('COUPANG_RETAIL_IMPORT_STALE_OR_INVALID');
  const state=createCoupangRetailState(envelope.cookies,{bootstrapAt:envelope.capturedAt});
  return withSessionLock(()=>store.write(COUPANG_RETAIL_STORE,JSON.stringify(state)),{root:path.join(store.directory,'locks'),key:COUPANG_RETAIL_STORE});
}

export async function coupangRetailStatus({store=new ProtectedStore()}={}) {
  const storage=store.status(COUPANG_RETAIL_STORE);if(!storage.available)return {storage,ready:false};
  const state=JSON.parse(store.read(COUPANG_RETAIL_STORE)),now=Date.now();
  try{const {signature,fields}=validateState(state,now);return {storage,ready:true,bootstrapAt:state.bootstrapAt,
    lastSuccessfulReadAt:state.lastSuccessfulReadAt,signatureExpiresAt:signature.expires,
    signatureRefreshDue:now-Number(fields.c3)>=SIGNATURE_SOURCE.refreshIntervalMs,
    opaqueContextRenewalVerified:false,liveCheckPerformed:false,localContextLimitMs:RETAIL_CONTEXT_LIMIT_MS};}
  catch(e){return {storage,ready:false,code:safeCode(e),liveCheckPerformed:false};}
}

export async function searchCoupangRetail(query,{store=new ProtectedStore(),fetchImpl=globalThis.fetch,forceRenew=false}={}) {
  const input=buildCoupangRscInput(query);
  return withSessionLock(async()=>{
    const raw=store.read(COUPANG_RETAIL_STORE);if(!raw)fail('COUPANG_RETAIL_CONTEXT_MISSING');
    let state;try{state=JSON.parse(raw);}catch{fail('COUPANG_RETAIL_STATE_INVALID');}
    const now=Date.now(),{signature,fields}=validateState(state,now),oldExpiresAt=signature.expires;
    const renewal={performed:false,browserUsed:false,oldExpiresAt,oldExpiredAtStart:Date.parse(oldExpiresAt)<=now,
      opaqueContextRenewed:false,loginRenewed:false,source:SIGNATURE_SOURCE};
    if(forceRenew||now-Number(fields.c3)>=SIGNATURE_SOURCE.refreshIntervalMs||Date.parse(oldExpiresAt)<=now+60000) {
      const renewed=renewCoupangSignature(signature.value,{now});signature.value=renewed.value;signature.expires=renewed.expiresAt;delete signature.maxAge;
      Object.assign(renewal,{performed:true,issuedAt:renewed.issuedAt,expiresAt:renewed.expiresAt,opaqueContextPreserved:renewed.opaqueContextPreserved});
    }
    const expected=CookieJar.deserializeSync(state.session.cookieJar).getCookieStringSync(input.url);
    const before=new Map(state.session.cookieJar.cookies.map(c=>[c.key,c])),changes=[];
    let calls=0,exactWireCookie=false;
    const dc=channel('undici:request:create');
    const listener=({request})=>{
      if(String(request.origin)!==ORIGIN||request.path!==new URL(input.url).pathname+new URL(input.url).search)return;
      const raw=request.headers;
      const entries=Array.isArray(raw)?Array.from({length:raw.length/2},(_,i)=>[raw[i*2],raw[i*2+1]])
        :String(raw).split('\r\n').filter(Boolean).map(s=>{const at=s.indexOf(':');return[s.slice(0,at),s.slice(at+1).trim()];});
      exactWireCookie=entries.some(([k,v])=>String(k).toLowerCase()==='cookie'&&v===expected);
    };
    const session=ScopedSession.fromJSON(state.session,{fetchImpl:async(url,init)=>{
      if(url!==input.url||init.method!=='GET'||init.redirect!=='manual'||++calls!==1)fail('COUPANG_RETAIL_REQUEST_SCOPE');
      return fetchImpl(url,init);
    }});
    const result={ok:false,checkedAt:new Date(now).toISOString(),operation:'retail_search_lowest_price_rsc',executionMode:'pure_http',
      browserUsed:false,browserUsedForInputs:false,browserUsedForRenewal:false,initialBootstrap:'authorized_browser_session',
      credentialProvider:'protected_store',ownerAuthenticationVerified:false,writesSubmitted:0,retries:0,renewal,
      receipt:{origin:ORIGIN,path:'/np/search',queryFields:[...new URL(input.url).searchParams.keys()],
        outgoingCookieNames:expected.split(';').filter(Boolean).map(c=>c.trim().split('=')[0]),exactCookieHeaderSent:false},
      states:{captured:true,client_exists:true,remnant_free:'recurring_read_and_signature_refresh_after_initial_bootstrap',credential_propagated:false,live_replay:false}};
    dc.subscribe(listener);
    try {
      const response=await session.request(input.url,{headers:input.headers,onCookiesApplied:e=>{
        for(const c of e.cookies) {
          const expires=Cookie.fromJSON(c)?.expiryTime(),deleted=expires<=Date.now();
          if(!['coupang.com','www.coupang.com'].includes(c.domain)||c.path!=='/'
            ||!allowed.has(c.key)&&!(deletedLoginCookies.has(c.key)&&deleted))fail('COUPANG_RETAIL_RESPONSE_COOKIE_SCOPE');
          const prior=before.get(c.key);
          if(c.key==='PCID'&&prior&&c.value!==prior.value&&!deleted)fail('COUPANG_RETAIL_IDENTITY_CHANGED');
          changes.push({name:c.key,deleted,valueChanged:!!prior&&prior.value!==c.value,
            expiryChanged:!!prior&&prior.expires!==c.expires,maxAge:c.maxAge??null,expires:c.expires??null});
        }
      }});
      Object.assign(result.receipt,{status:response.status,contentType:response.headers['content-type']?.split(';')[0]??null,
        bytes:Buffer.byteLength(response.raw),bodySha256:createHash('sha256').update(response.raw).digest('hex'),
        server:['envoy','AkamaiGHost'].includes(response.headers.server)?response.headers.server:null,
        accessDeniedTitle:/<title\b[^>]*>\s*Access Denied\s*<\/title>/i.test(response.raw),cookieChanges:changes});
      state.session=session.toJSON();state.session.cookieJar.cookies=state.session.cookieJar.cookies.filter(c=>allowed.has(c.key));
      if(response.status!==200)result.code=`COUPANG_RETAIL_HTTP_${response.status}`;
      else if(result.receipt.contentType!=='text/x-component')result.code='COUPANG_RETAIL_CONTENT_TYPE';
      else {result.data=parseCoupangRsc(response.raw,input.url);result.ok=true;state.lastSuccessfulReadAt=new Date().toISOString();
        result.projectionSha256=createHash('sha256').update(JSON.stringify(result.data)).digest('hex');}
      const usableNames=new Set(CookieJar.deserializeSync(state.session.cookieJar).getCookiesSync(input.url).map(c=>c.key));
      result.sessionReadyAfterRead=usableNames.has('PCID')&&usableNames.has('x-cp-s');
      if(!result.sessionReadyAfterRead){result.ok=false;result.code='COUPANG_RETAIL_CONTEXT_INVALIDATED';}
      // Preserve only observed same-origin rotations, including deletion, even on a rejection.
      result.storage=store.write(COUPANG_RETAIL_STORE,JSON.stringify(state));
    } catch(e){result.ok=false;result.code=safeCode(e);}
    finally{dc.unsubscribe(listener);}
    result.receipt.requestCount=calls;result.receipt.exactCookieHeaderSent=exactWireCookie;
    result.states.credential_propagated=fetchImpl===globalThis.fetch?exactWireCookie:'injected_transport_test';
    result.states.live_replay=result.ok&&fetchImpl===globalThis.fetch&&exactWireCookie&&calls===1;
    result.renewal.cookieRotationObserved=changes.some(c=>c.valueChanged||c.expiryChanged);
    result.renewal.verifiedByRead=result.ok&&renewal.performed&&result.states.live_replay;
    return result;
  },{root:path.join(store.directory,'locks'),key:COUPANG_RETAIL_STORE});
}
