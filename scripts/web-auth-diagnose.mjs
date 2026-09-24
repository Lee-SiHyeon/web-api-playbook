// One captured protected GET, with no browser request retries or raw output.
import { ScopedSession } from '../lib/scoped-session.mjs';
import { stdinJson } from '../lib/cli.mjs';
try {
  const i=await stdinJson(128*1024),url=new URL(i.url);
  if(!((url.origin==='https://api.x.com'&&url.pathname==='/1.1/account/settings.json')||
    (url.origin==='https://partners.coupang.com'&&url.pathname==='/api/v1/config')))throw Error();
  const allowed=/^(accept|accept-language|authorization|referer|user-agent|lang|sec-ch-ua(?:-mobile|-platform)?|x-client-transaction-id|x-csrf-token|x-twitter-active-user|x-twitter-auth-type|x-twitter-client-language)$/i;
  const headers=Object.fromEntries(Object.entries(i.headers).filter(([k])=>allowed.test(k)));
  const origins=url.hostname==='api.x.com'?['https://x.com',url.origin]:[url.origin];
  const session=new ScopedSession({allowedOrigins:origins,cookieOrigins:origins,cookies:i.cookies,headersByOrigin:{[url.origin]:headers}});
  const r=await session.request(url.href);
  let b;try{b=JSON.parse(r.raw);}catch{}
  console.log(JSON.stringify({ok:true,httpStatus:r.status,mime:r.headers['content-type'],jsonKeys:b?Object.keys(b).filter(k=>/^[\w.-]{1,80}$/.test(k)).slice(0,30):[],
    serviceCodes:Array.isArray(b?.errors)?b.errors.map(e=>e.code).filter(Number.isInteger):[],
    ownerMatches:url.hostname==='api.x.com'?b?.screen_name===i.expected:b?.data?.member?.email===i.expected,
    browserUsed:false,capturedHeadersUsed:true,recurringTokenGenerationVerified:false}));
}catch(e){console.log(JSON.stringify({ok:false,code:/^(SCOPED_SESSION_|AUTH_)[A-Z_]+$/.test(e.code||'')?e.code:'AUTH_DIAGNOSTIC_FAILED'}));process.exitCode=2;}
