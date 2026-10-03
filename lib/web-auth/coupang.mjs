import path from 'node:path';
import { ScopedSession } from '../scoped-session.mjs';
import { ProtectedStore } from '../protected-store.mjs';
import { withSessionLock } from '../session-lock.mjs';
import { WebAuthError } from './myrealtrip.mjs';
import { coupangForbiddenCode } from './coupang-response.mjs';
import {
  assertCoupangOwnerBinding,
  COUPANG_AUTH_COOKIE_NAMES,
  COUPANG_PARTNERS_ORIGIN,
  COUPANG_ROUTING_COOKIE_NAMES,
  createCoupangOwnerBinding,
  createCoupangServiceFetch,
  verifyCoupangBoundOwner,
} from './coupang-attested-session.mjs';

const ORIGIN='https://partners.coupang.com';
const ORIGINS=[ORIGIN,'https://login.coupang.com'];
const NAME='coupang-web-state';
const fail=code=>{throw new WebAuthError(code);};
export function createCoupangAuth({store=new ProtectedStore(),fetchImpl=fetch}={}) {
  const locked=fn=>withSessionLock(fn,{root:path.join(store.directory,'locks'),key:NAME});
  const httpDeniedSessions=new WeakSet();
  const serviceFetch=createCoupangServiceFetch(fetchImpl);
  const attestedOrigins=[COUPANG_PARTNERS_ORIGIN];
  const allowedAttestedCookieNames=new Set([...COUPANG_AUTH_COOKIE_NAMES,...COUPANG_ROUTING_COOKIE_NAMES]);
  const safeAttestedSession=session=>{
    let serialized;
    try{serialized=session.toJSON();}catch{fail('AUTH_STATE_INVALID');}
    if(!Array.isArray(serialized?.cookieJar?.cookies))fail('AUTH_STATE_INVALID');
    serialized.cookieJar.cookies=serialized.cookieJar.cookies.filter(cookie=>allowedAttestedCookieNames.has(cookie?.key));
    try{return ScopedSession.fromJSON(serialized,{fetchImpl:serviceFetch});}catch{fail('AUTH_STATE_INVALID');}
  };
  const save=(state,session)=>{
    if(httpDeniedSessions.has(session))return;
    let savedSession=session;
    if(state.version===2){
      savedSession=safeAttestedSession(session);
      assertCoupangOwnerBinding(savedSession,state);
    }
    return store.write(NAME,JSON.stringify({...state,session:savedSession.toJSON(),updatedAt:new Date().toISOString()}));
  };
  function load() {
    const raw=store.read(NAME); if(!raw)fail('SESSION_MISSING');
    let state;try{state=JSON.parse(raw);}catch{fail('AUTH_STATE_INVALID');}
    if(typeof state?.email!=='string'||typeof state.affiliateCode!=='string')fail('AUTH_STATE_INVALID');
    if(state.version===1){
      if(JSON.stringify(state.session?.allowedOrigins)!==JSON.stringify(ORIGINS)||
        JSON.stringify(state.session?.cookieOrigins)!==JSON.stringify(ORIGINS))fail('AUTH_STATE_INVALID');
      return {state,session:ScopedSession.fromJSON(state.session,{fetchImpl:serviceFetch})};
    }
    if(state.version===2){
      if(JSON.stringify(state.session?.allowedOrigins)!==JSON.stringify(attestedOrigins)||
        JSON.stringify(state.session?.cookieOrigins)!==JSON.stringify(attestedOrigins))fail('AUTH_STATE_INVALID');
      const session=safeAttestedSession(ScopedSession.fromJSON(state.session,{fetchImpl:serviceFetch}));
      assertCoupangOwnerBinding(session,state);
      return {state,session};
    }
    fail('AUTH_STATE_INVALID');
  }
  async function json(session,route) {
    const r=await session.request(ORIGIN+route);
    if(r.status===401)fail('REAUTH_REQUIRED');
    if(r.status===403) {
      const code=coupangForbiddenCode(r);
      if(code==='COUPANG_HTTP_ACCESS_DENIED')httpDeniedSessions.add(session);
      fail(code);
    }
    if(r.status===429)fail('AUTH_THROTTLED');
    if(r.status!==200||!r.headers['content-type']?.includes('json'))fail('AUTH_RESPONSE_INVALID');
    let b;try{b=JSON.parse(r.raw.toString('utf8'));}catch{fail('AUTH_RESPONSE_INVALID');}
    if(b?.rCode!=='0')fail('AUTH_APPLICATION_REJECTED');
    return b.data;
  }
  async function owner(session,state) {
    if(state.version===2){
      try{return await verifyCoupangBoundOwner(session,state);}
      catch(error){httpDeniedSessions.add(session);throw error;}
    }
    const b=await json(session,'/api/v1/config');
    if(!b?.member?.valid||!b.affiliate?.affiliateCode)fail('REAUTH_REQUIRED');
    if(b.member.email?.toLowerCase()!==state.email.toLowerCase()||b.affiliate.affiliateCode!==state.affiliateCode)fail('OWNER_MISMATCH');
    return {authenticated:true,ownerVerified:true,browserUsed:false};
  }
  async function renew(session,state) {
    // Actual portal login URL returned by /api/v1/config, not the developer API.
    await session.request(ORIGIN+'/api/v1/prelogin');
    return {...await owner(session,state),renewal:'web_sso_redirect'};
  }
  async function run(command) {
    return locked(async()=>{
      const {state,session}=load();
      try {
        if(command==='renew'){
          if(state.version===2)fail('REAUTH_REQUIRED');
          return await renew(session,state);
        }
        let verification;
        try{verification=await owner(session,state);}catch(e){if(command!=='ensure'||state.version===2||e.code!=='REAUTH_REQUIRED')throw e;return await renew(session,state);}
        if(command==='dashboard') {
          if(state.version===2)return {...verification,dashboardRead:true};
          const b=await json(session,'/api/v1/dashboard');
          if(!b||!Array.isArray(b.categories)||!b.dailyTrend||!b.monthlyAggregation)fail('DASHBOARD_SCHEMA_INVALID');
          return {authenticated:true,ownerVerified:true,browserUsed:false,dashboardRead:true};
        }
        return state.version===2
          ? {...verification,renewal:'attested_session_reused'}
          : {authenticated:true,ownerVerified:true,browserUsed:false,renewal:'stored_session'};
      } finally {save(state,session);}
    });
  }
  return {
    status:()=>({service:'coupang',sessionStored:store.status(NAME).available,currentAuthentication:'not_checked',passwordLoginImplemented:false}),
    health:()=>run('health'),ensure:()=>run('ensure'),renew:()=>run('renew'),dashboard:()=>run('dashboard'),
    importSession:input=>locked(async()=>{
      if(!Array.isArray(input.cookies)||!input.cookies.length||typeof input.email!=='string'||!input.email.includes('@')||
        typeof input.affiliateCode!=='string'||!input.affiliateCode||typeof input.userAgent!=='string'||/[\r\n]/.test(input.userAgent))fail('AUTH_IMPORT_INVALID');
      const session=new ScopedSession({allowedOrigins:ORIGINS,cookieOrigins:ORIGINS,cookies:input.cookies,
        defaultHeaders:{'user-agent':input.userAgent},headersByOrigin:{[ORIGIN]:Object.fromEntries(
          Object.entries(input.headers||{}).filter(([k])=>/^(accept|referer|lang|sec-ch-ua(?:-mobile|-platform)?)$/i.test(k)))},fetchImpl:serviceFetch});
      const state={version:1,email:input.email,affiliateCode:input.affiliateCode};
      const result=await owner(session,state);save(state,session);
      return {...result,stored:true};
    }),
    importAttestedSession:input=>locked(async()=>{
      if(!Array.isArray(input?.cookies)||!input.cookies.length||typeof input.email!=='string'||!input.email.includes('@')||
        typeof input.affiliateCode!=='string'||!input.affiliateCode||typeof input.userAgent!=='string'||/[\r\n]/.test(input.userAgent))fail('AUTH_IMPORT_INVALID');
      const {state:prior}=load();
      if(typeof prior.email!=='string'||typeof prior.affiliateCode!=='string'||
        prior.email.trim().toLowerCase()!==input.email.trim().toLowerCase()||prior.affiliateCode!==input.affiliateCode)fail('OWNER_MISMATCH');
      const filteredCookies=input.cookies.filter(cookie=>allowedAttestedCookieNames.has(cookie?.name));
      const seenNames=new Set();
      for(const cookie of filteredCookies){
        if(seenNames.has(cookie.name))fail('AUTH_IMPORT_INVALID');
        seenNames.add(cookie.name);
      }
      const session=new ScopedSession({allowedOrigins:attestedOrigins,cookieOrigins:attestedOrigins,cookies:filteredCookies,
        defaultHeaders:{'user-agent':input.userAgent},headersByOrigin:{[COUPANG_PARTNERS_ORIGIN]:Object.fromEntries(
          Object.entries(input.headers||{}).filter(([k])=>/^(accept|referer|lang|sec-ch-ua(?:-mobile|-platform)?)$/i.test(k)))},fetchImpl:serviceFetch});
      const state={version:2,email:input.email,affiliateCode:input.affiliateCode,session:null,
        ownerBinding:createCoupangOwnerBinding(session,{email:input.email,affiliateCode:input.affiliateCode},input.observedProof)};
      const result=await verifyCoupangBoundOwner(session,state);
      const savedSession=safeAttestedSession(session);
      assertCoupangOwnerBinding(savedSession,state);
      store.write(NAME,JSON.stringify({...state,session:savedSession.toJSON(),updatedAt:new Date().toISOString()}));
      return {...result,stored:true};
    }),
  };
}
