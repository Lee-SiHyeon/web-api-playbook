import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Resolve the bundled playbook independently of the caller's working directory.
export function webApiPlaybookRoot() {
  return process.env.WEB_API_PLAYBOOK_ROOT || process.env.WEB_API_PLAYBOOK
    || fileURLToPath(new URL('../../../../..', import.meta.url));
}
export async function loadWebAuth(service) {
  const factories={myrealtrip:'createMyrealtripAuth',coupang:'createCoupangAuth',x:'createXAuth',linkprice:'createLinkpriceAuth',brandconnect:'createBrandconnectAuth'};
  if(!Object.hasOwn(factories,service))throw new Error('WEB_AUTH_SERVICE_INVALID');
  const root=webApiPlaybookRoot();
  let module;
  try{module=await import(pathToFileURL(path.join(root,'lib','web-auth',service+'.mjs')).href);}
  catch{throw new Error('WEB_AUTH_PLAYBOOK_NOT_INSTALLED');}
  return module[factories[service]]();
}
