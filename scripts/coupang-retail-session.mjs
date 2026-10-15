import { writeFile } from 'node:fs/promises';
import { coupangRetailStatus, importCoupangRetailSession, searchCoupangRetail } from '../lib/retail/coupang-retail-session.mjs';
const fail=()=>{throw Object.assign(new Error('COUPANG_RETAIL_USAGE'),{code:'COUPANG_RETAIL_USAGE'});};
try {
  const [command,...args]=process.argv.slice(2);let result;
  if(command==='status'&&args.length===0)result=await coupangRetailStatus();
  else if(command==='import'&&args.length===0){let raw='';for await(const chunk of process.stdin){raw+=chunk;if(raw.length>128*1024)fail();}
    const input=JSON.parse(raw);raw='';result=await importCoupangRetailSession(input);}
  else if(['search','renew'].includes(command)){
    const query=args.find(a=>a.startsWith('--query='))?.slice(8),out=args.find(a=>a.startsWith('--out='))?.slice(6);
    if(!query||args.length!==(out?2:1)||args.some(a=>!a.startsWith('--query=')&&!a.startsWith('--out=')))fail();
    result=await searchCoupangRetail(query,{forceRenew:command==='renew'});
    if(out)await writeFile(out,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
    console.log(JSON.stringify({ok:result.ok,code:result.code,status:result.receipt.status,products:result.data?.products.length??0,
      signatureRenewed:result.renewal.verifiedByRead,oldSignatureExpired:result.renewal.oldExpiredAtStart,
      cookieRotation:result.renewal.cookieRotationObserved,browserUsed:result.browserUsed,states:result.states,output:out}));
    if(!result.ok)process.exitCode=2;
  }else fail();
  if(!['search','renew'].includes(command))console.log(JSON.stringify(result));
}catch(e){console.log(JSON.stringify({ok:false,code:/^(?:COUPANG|SCOPED_SESSION|PROTECTED_STORE|SESSION_LOCK)_[A-Z_0-9]+$/.test(e?.code??'')?e.code:'COUPANG_RETAIL_FAILED'}));process.exitCode=2;}
