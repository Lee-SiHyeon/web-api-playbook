import { createMyrealtripAuth, WebAuthError } from '../lib/web-auth/myrealtrip.mjs';
import { createCoupangAuth } from '../lib/web-auth/coupang.mjs';
import { createXAuth } from '../lib/web-auth/x.mjs';
import { createLinkpriceAuth } from '../lib/web-auth/linkprice.mjs';
import { stdinJson } from '../lib/cli.mjs';

try {
  const [service, command='status'] = process.argv.slice(2);
  const factories={myrealtrip:createMyrealtripAuth,coupang:createCoupangAuth,x:createXAuth,linkprice:createLinkpriceAuth};
  if (!Object.hasOwn(factories,service)) throw new WebAuthError('SERVICE_NOT_IMPLEMENTED');
  const auth=factories[service]();
  let result;
  if (command==='status') result=auth.status();
  else if (command==='login' && auth.login) result=await auth.login();
  else if (command==='ensure') result=await auth.ensure();
  else if (command==='health') result=await auth.health();
  else if (command==='refresh' && auth.refresh) result=await auth.refresh();
  else if (command==='renew' && auth.renew) result=await auth.renew();
  else if (command==='dashboard' && auth.dashboard) result=await auth.dashboard();
  else if (command==='sites' && auth.sites) result=await auth.sites();
  else if (command==='import-session' && auth.importSession) result=await auth.importSession(await stdinJson(128*1024));
  else if (command==='import-tokens' && auth.importTokens) result=await auth.importTokens(await stdinJson(128*1024));
  else if (command==='otp-send' && auth.sendOtp) result=await auth.sendOtp();
  else if (command==='otp-verify' && auth.verifyOtp) result=await auth.verifyOtp((await stdinJson(4096)).code);
  else throw new WebAuthError('COMMAND_NOT_ALLOWED');
  console.log(JSON.stringify({ok:true,service,command,...result}));
} catch(e) {
  console.log(JSON.stringify({ok:false,code:e instanceof WebAuthError ? e.code : 'WEB_LOGIN_FAILED',...(e instanceof WebAuthError && e.receipt ? {receipt:e.receipt}:{})}));
  process.exitCode=2;
}
