import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { webApiPlaybookRoot } from '../affiliate-api-hub/adapters/web-auth-provider.mjs';
const root = webApiPlaybookRoot();
const [{ ProtectedStore }, { ScopedSession }, { withSessionLock }] = await Promise.all(['protected-store', 'scoped-session', 'session-lock'].map(name => import(pathToFileURL(path.join(root, 'lib', name + '.mjs')).href)));
const store = new ProtectedStore();
const { decodeXHomeOwner } = await import(pathToFileURL(path.join(root, 'lib/web-auth/x-owner-home.mjs')).href);
try {
  const receipt = await withSessionLock(async () => {
    const saved = JSON.parse(store.read('x-web-state'));
    if (saved.handle !== 'lifehack__ailab' || JSON.stringify(saved.session?.allowedOrigins) !== JSON.stringify(['https://x.com', 'https://api.x.com'])) throw Object.assign(new Error(), { code: 'X_DIAGNOSTIC_SCOPE' });
    if (saved.session.headersByOrigin?.['https://x.com']) for (const key of ['authorization', 'x-csrf-token', 'x-client-transaction-id']) delete saved.session.headersByOrigin['https://x.com'][key];
    const session = ScopedSession.fromJSON(saved.session);
    try {
      const response = await session.request('https://x.com/home');
      const match = response.raw.match(/(?:window\.)?__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;?\s*(?:window\.|<\/script>)/);
      let state; try { state = JSON.parse(match?.[1]); } catch {}
      const currentId = state?.session?.user_id;
      const users = state?.entities?.users?.entities;
      const user = typeof currentId === 'string' ? users?.[currentId] : null;
      const proof = decodeXHomeOwner(response, saved.handle);
      return { operation: 'authenticated_home_viewer_diagnostic', httpStatus: response.status, mime: response.headers['content-type'], currentViewerPresent: Boolean(currentId), currentViewerEntityPresent: Boolean(user), viewerHandleMatches: user?.screen_name === saved.handle, ownerVerified: proof.receipt.ownerVerified, ownerVerificationMethod: proof.receipt.ownerVerificationMethod, writes: 0, browserUsed: false };
    } finally {
      saved.session = session.toJSON(); store.write('x-web-state', JSON.stringify(saved));
    }
  }, { root: path.join(store.directory, 'locks'), key: 'x-web-state' });
  console.log(JSON.stringify(receipt));
} catch (error) { console.log(JSON.stringify({ code: error.code || 'X_DIAGNOSTIC_FAILED', writes: 0 })); }
