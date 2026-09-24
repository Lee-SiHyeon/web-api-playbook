import path from 'node:path';
import { ScopedSession } from '../scoped-session.mjs';
import { ProtectedStore } from '../protected-store.mjs';
import { withSessionLock } from '../session-lock.mjs';
import { WebAuthError } from './myrealtrip.mjs';

const ORIGIN='https://partners.coupang.com';
const ORIGINS=[ORIGIN,'https://login.coupang.com'];
const NAME='coupang-web-state';
const fail=code=>{throw new WebAuthError(code);};
export function createCoupangAuth({store=new ProtectedStore(),fetchImpl=fetch}={}) {
  const locked=fn=>withSessionLock(fn,{root:path.join(store.directory,'locks'),key:NAME});
  const save=(state,session)=>store.write(NAME,JSON.stringify({...state,session:session.toJSON(),updatedAt:new Date().toISOString()}));
  function load() {
    const raw=store.read(NAME); if(!raw)fail('SESSION_MISSING');
    let state;try{state=JSON.parse(raw);}catch{fail('AUTH_STATE_INVALID');}
    if(state?.version!==1||typeof state.email!=='string'||typeof state.affiliateCode!=='string'||
      JSON.stringify(state.session?.allowedOrigins)!==JSON.stringify(ORIGINS)||
      JSON.stringify(state.session?.cookieOrigins)!==JSON.stringify(ORIGINS))fail('AUTH_STATE_INVALID');
    return {state,session:ScopedSession.fromJSON(state.session,{fetchImpl})};
  }
  async function json(session,route) {
    const r=await session.request(ORIGIN+route);
    if(r.status===401)fail('REAUTH_REQUIRED');
    if(r.status===403)fail('AUTH_FORBIDDEN');
    if(r.status===429)fail('AUTH_THROTTLED');
    if(r.status!==200||!r.headers['content-type']?.includes('json'))fail('AUTH_RESPONSE_INVALID');
    let b;try{b=JSON.parse(r.raw.toString('utf8'));}catch{fail('AUTH_RESPONSE_INVALID');}
    if(b?.rCode!=='0')fail('AUTH_APPLICATION_REJECTED');
    return b.data;
  }
  async function owner(session,state) {
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
        if(command==='renew')return await renew(session,state);
        try{await owner(session,state);}catch(e){if(command!=='ensure'||e.code!=='REAUTH_REQUIRED')throw e;return await renew(session,state);}
        if(command==='dashboard') {
          const b=await json(session,'/api/v1/dashboard');
          if(!b||!Array.isArray(b.categories)||!b.dailyTrend||!b.monthlyAggregation)fail('DASHBOARD_SCHEMA_INVALID');
          return {authenticated:true,ownerVerified:true,browserUsed:false,dashboardRead:true};
        }
        return {authenticated:true,ownerVerified:true,browserUsed:false,renewal:'stored_session'};
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
          Object.entries(input.headers||{}).filter(([k])=>/^(accept|referer|lang|sec-ch-ua(?:-mobile|-platform)?)$/i.test(k)))},fetchImpl});
      const state={version:1,email:input.email,affiliateCode:input.affiliateCode};
      const result=await owner(session,state);save(state,session);
      return {...result,stored:true};
    }),
  };
}
