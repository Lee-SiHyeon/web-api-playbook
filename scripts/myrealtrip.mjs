import { createMyrealtripAuth, WebAuthError } from '../lib/web-auth/myrealtrip.mjs';
import { runMyrealtripEnvelope, marketingErrorResult } from '../service-packs/affiliate/apps/affiliate-api-hub/adapters/myrealtrip-marketing.mjs';
import { stdinJson } from '../lib/cli.mjs';
try {
  const input=await stdinJson(64*1024);
  if(input.session||input.services)throw Error();
  const result=await createMyrealtripAuth().withSession(async(session, authentication)=>{
    const output=await runMyrealtripEnvelope({
      ...input,schemaVersion:1,acquiredAt:new Date().toISOString(),session,
    });
    return {...output,execution:{...output.execution,credentialProvider:'Windows DPAPI CurrentUser',renewal:authentication.renewal}};
  });
  console.log(JSON.stringify(result));
}catch(e){console.log(JSON.stringify(e instanceof WebAuthError?{ok:false,code:e.code}:marketingErrorResult(e)));process.exitCode=2;}
