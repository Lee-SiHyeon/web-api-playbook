import { DOMParser } from 'linkedom';
import { ClientTransaction } from 'x-client-transaction-id';
import { ScopedSession } from '../scoped-session.mjs';
import { WebAuthError } from './myrealtrip.mjs';

// Pinned 0.3.1 algorithm, fresh X HTML/JS inputs. No browser and no stored transaction IDs.
export async function createHttpXTransaction(session, {fetchImpl=fetch}={}) {
  try {
    const response=await session.request('https://x.com/home');
    if(response.status!==200||!response.headers['content-type']?.includes('html'))throw Error();
    const document=new DOMParser().parseFromString(response.raw,'text/html');
    const generator=new ClientTransaction(document);
    // The package's source fetch has no size/timeout bound. Keep it on our public-CDN transport.
    const scriptUrl=generator.getOnDemandFileUrl(document);
    if(!/^https:\/\/abs\.twimg\.com\/responsive-web\/client-web(?:-legacy)?\/ondemand\.s\.[\w-]+\.js$/.test(scriptUrl))throw Error();
    const publicSession=new ScopedSession({allowedOrigins:['https://abs.twimg.com'],cookieOrigins:[],fetchImpl,maxResponseBytes:4*1024*1024});
    const source=await publicSession.request(scriptUrl);
    if(source.status!==200)throw Error();
    const indices=[...source.raw.matchAll(/\(\w\[(\d{1,2})\],\s*16\)/g)].map(m=>Number(m[1]));
    if(indices.length<2)throw Error();
    generator.getIndices=async()=>[indices[0],indices.slice(1)];
    await generator.initialize();
    return { generate: async (method,route) => {
      if(!['GET','POST'].includes(method)||!/^\/(?:i\/api\/)?(?:1\.1\/account\/settings\.json|graphql\/[\w-]+\/[\w]+)$/.test(route))throw new WebAuthError('X_TRANSACTION_SCOPE');
      return generator.generateTransactionId(method,route);
    }};
  } catch(e) {
    if(e instanceof WebAuthError)throw e;
    throw new WebAuthError('X_TRANSACTION_BOOTSTRAP_FAILED');
  }
}
