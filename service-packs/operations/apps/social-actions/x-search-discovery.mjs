import { createHash } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';
import { ProtectedStore } from '../../../../lib/protected-store.mjs';
import { ScopedSession } from '../../../../lib/scoped-session.mjs';
import { withSessionLock } from '../../../../lib/session-lock.mjs';
import path from 'node:path';
const store = new ProtectedStore();
try {
  const result = await withSessionLock(async () => {
    const saved = JSON.parse(store.read('x-web-state'));
    const headers = saved.session.headersByOrigin?.['https://x.com'];
    if (headers) for (const key of ['authorization','x-csrf-token','x-client-transaction-id']) delete headers[key];
    const session = ScopedSession.fromJSON(saved.session);
    try {
      const boot = await session.request('https://x.com/manifest.js');
      if (boot.status !== 200) throw Object.assign(new Error(), { code:'X_SEARCH_BOOT_FAILED' });
      const initial = boot.raw.match(/(?:window\.)?__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;?\s*(?:window\.|<\/script>)/);
      const state = JSON.parse(initial?.[1]);
      const asset = boot.raw.match(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/main\.[A-Za-z0-9]+\.js/)?.[0];
      if (!asset) throw Object.assign(new Error(),{code:'X_SEARCH_ASSET_MISSING'});
      const publicSession = new ScopedSession({ allowedOrigins:['https://abs.twimg.com'], cookieOrigins:[],maxResponseBytes:4*1024*1024 });
      const script = await publicSession.request(asset);
      const source = script.raw;
      const defaults = {...state.featureSwitch?.defaultConfig,...state.featureSwitch?.user?.config};
      const match = source.match(/queryId:"([A-Za-z0-9_-]+)",operationName:"SearchTimeline",operationType:"query",metadata:\{featureSwitches:(\[[^\]]*\]),fieldToggles:(\[[^\]]*\])/);
      const keys = match ? JSON.parse(match[2]) : [];
      const variables = [];
      for (const found of source.matchAll(/fetchSearch(?:Timeline)?[:(]|Failed to render SearchTimeline/g)) {
        const fragment = source.slice(Math.max(0,found.index-250),found.index+1700);
        variables.push(fragment);
        if (variables.length>=4) break;
      }
      return {asset,assetSha256:createHash('sha256').update(source).digest('hex'),httpStatus:script.status,apiTransitionEnabled:defaults.responsive_web_api_transition_enabled?.value ?? null,
        contract:match?{queryId:match[1],operation:'SearchTimeline',features:Object.fromEntries(keys.filter(k=>typeof defaults[k]?.value==='boolean').map(k=>[k,defaults[k].value])),missingFeatures:keys.filter(k=>typeof defaults[k]?.value!=='boolean'),fieldNames:JSON.parse(match[3])}:null,
        variableCallsites:variables,writes:0};
    } finally { saved.session=session.toJSON();store.write('x-web-state',JSON.stringify(saved)); }
  },{root:path.join(store.directory,'locks'),key:'x-web-state'});
  if (process.argv.includes('--save') && result.contract) {
    const previous = JSON.parse(await readFile(new URL('./contracts/x-followers.json',import.meta.url),'utf8'));
    for(const key of [...result.contract.missingFeatures]) if(typeof previous.features[key]==='boolean') {
      result.contract.features[key]=previous.features[key];result.contract.missingFeatures=result.contract.missingFeatures.filter(k=>k!==key);
    }
    await writeFile(new URL('./contracts/x-search.json',import.meta.url),JSON.stringify({observedDate:'2026-09-30',method:'GET',sourceAsset:result.asset,sourceSha256:result.assetSha256,captured:false,discovery:'first_party_public_client_source',...result.contract},null,2));
  }
  console.log(JSON.stringify(result));
} catch(error) {console.log(JSON.stringify({code:error.code || 'X_SEARCH_DISCOVERY_FAILED',writes:0}));process.exitCode=2;}
