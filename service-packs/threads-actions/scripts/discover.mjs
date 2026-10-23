// Read-only: GET one public profile document (no cookies) and print the profile query metadata it preloads.
// Never prints LSD/CSRF values. Does not write contracts automatically; compare and update by hand.
import {extractBootstrap,handleOK,ORIGIN} from '../src/public.mjs';
const handle=process.argv[2]||'threads';
if(!handleOK(handle)){console.error('HANDLE_INVALID');process.exit(1);}
const res=await fetch(`${ORIGIN}/@${handle}`,{redirect:'error',headers:{accept:'text/html'},signal:AbortSignal.timeout(15000)});
const html=await res.text();
const {lsd,site,profileContract}=extractBootstrap(html);
console.log(JSON.stringify({checkedAt:new Date().toISOString(),httpStatus:res.status,lsdPresent:Boolean(lsd),siteDataPresent:Boolean(site),
  profileQuery:profileContract?{name:profileContract.name,docId:profileContract.docId,variableKeys:Object.keys(profileContract.variables)}:null},null,2));
