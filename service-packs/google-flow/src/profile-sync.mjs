import { FlowClient } from './client.mjs';
import { FlowHttpTransport } from './http-transport.mjs';
import { readCredential, writeCredential } from './secure-credential-store.mjs';
import { FLOW_CREDENTIAL } from './session-name.mjs';
import { GOOGLE_FLOW_AUTH_CREDENTIAL, validateGoogleFlowAuthBundle } from './google-sso-recovery.mjs';
import { validateFlowSessionBundle } from './session-bundle.mjs';
import { connectProfileCdp, profileError } from './profile-cdp.mjs';

export function scopedProfileCookies(cookies, target, now = Date.now()) {
  const url = new URL(target);
  const domains = url.hostname === 'flow.google.com' ? ['google.com', 'flow.google.com'] : ['google.com', 'accounts.google.com'];
  return cookies.filter(c => {
    const domain = c.domain?.toLowerCase().replace(/^\./, '');
    const domainScoped = c.domain?.startsWith('.');
    return domains.includes(domain) && (domainScoped || domain === url.hostname)
      && !Object.hasOwn(c, 'partitionKey') && !c.partitionKeyOpaque
      && typeof c.value === 'string' && c.value.length > 0
      && (c.session === true || c.expires === -1 || c.expires > now / 1000)
      && typeof c.path === 'string' && (url.pathname === c.path || (url.pathname.startsWith(c.path)
        && (c.path.endsWith('/') || url.pathname[c.path.length] === '/')));
  }).map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path,
    secure: c.secure, httpOnly: c.httpOnly, hostOnly: !c.domain.startsWith('.'),
    session: c.session === true || c.expires === -1,
    ...(c.session === true || c.expires === -1 ? {} : { expires: c.expires }),
    ...(c.sameSite ? { sameSite: c.sameSite } : {}),
  }));
}

export function assertProfileOwner(html, expected) {
  const matches = [...html.matchAll(/"oPEP7c"\s*:\s*("(?:\\.|[^"\\])*")/g)];
  let actual;
  try { if (matches.length === 1) actual = JSON.parse(matches[0][1]); } catch {}
  if (typeof expected !== 'string' || !expected || typeof actual !== 'string'
    || actual.toLowerCase() !== expected.toLowerCase()) throw profileError('FLOW_PROFILE_OWNER_MISMATCH');
}

// Verify in memory first. A wrong-account or login document must never replace DPAPI.
export async function verifyProfileBundle(bundle, owner, { fetchImpl = fetch } = {}) {
  let candidate = JSON.stringify(bundle);
  let ownerFailure;
  const guardedFetch = async (url, options) => {
    const response = await fetchImpl(url, options);
    if (options.method === 'GET' && response.status === 200 && /^text\/html/i.test(response.headers.get('content-type') ?? '')) {
      try { assertProfileOwner(await response.clone().text(), owner); }
      catch (error) { ownerFailure = error; throw error; }
    }
    return response;
  };
  const transport = new FlowHttpTransport({ fetchImpl: guardedFetch,
    readCredentialImpl: () => candidate, writeCredentialImpl: (_name, value) => { candidate = value; } });
  const client = new FlowClient({ transport });
  try {
    await client.start();
    const listing = await client.getProjectMedia(bundle.projectId);
    return { bundle: JSON.parse(candidate), projectMediaCount: listing[1].length };
  } catch (error) {
    if (ownerFailure) throw ownerFailure;
    throw error;
  } finally { client.close(); candidate = null; }
}

export async function syncFromProfile({ profileDir, launch = true, connectImpl = connectProfileCdp,
  readCredentialImpl = readCredential, writeCredentialImpl = writeCredential,
  verifyImpl = verifyProfileBundle, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const originalFlow = readCredentialImpl(FLOW_CREDENTIAL);
  const originalGoogle = readCredentialImpl(GOOGLE_FLOW_AUTH_CREDENTIAL);
  let oldFlow, oldGoogle;
  try { oldFlow = JSON.parse(originalFlow); oldGoogle = validateGoogleFlowAuthBundle(JSON.parse(originalGoogle)); }
  catch { throw profileError('FLOW_PROFILE_EXPECTED_OWNER_REQUIRED'); }
  if (!/^[a-f0-9-]{16,64}$/i.test(oldFlow?.projectId) || oldFlow.projectId !== oldGoogle.projectId) {
    throw profileError('FLOW_PROFILE_PROJECT_MISMATCH');
  }
  const cdp = await connectImpl({ profileDir, launch });
  let targetId;
  try {
    const projectUrl = `https://flow.google.com/project/${oldFlow.projectId}`;
    // Create and close only our own tab. Never enumerate OAuth/login or other user tabs.
    ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', background: true }));
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Network.enable', {}, sessionId);
    await cdp.send('Page.navigate', { url: projectUrl }, sessionId);
    let ready = false;
    for (let i = 0; i < 40; i += 1) {
      const result = await cdp.send('Runtime.evaluate', { expression: `JSON.stringify({host:location.hostname,ready:document.readyState,challenge:[...document.querySelectorAll('iframe[src*="/bframe"]')].some(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'})})`, returnByValue: true }, sessionId);
      let state; try { state = JSON.parse(result.result?.value); } catch { state = {}; }
      if (state.challenge) throw profileError('FLOW_PROFILE_CHALLENGE_REQUIRED');
      if (state.host === 'accounts.google.com') throw profileError('FLOW_PROFILE_LOGIN_REQUIRED');
      if (state.host === 'flow.google.com' && state.ready === 'complete') { ready = true; break; }
      await sleep(500);
    }
    if (!ready) throw profileError('FLOW_PROFILE_PAGE_TIMEOUT');
    // Chrome, including its native device-bound key if present, owns refresh. We never sign a challenge.
    const flowCookies = await cdp.send('Network.getCookies', { urls: [projectUrl] }, sessionId);
    const googleCookies = await cdp.send('Network.getCookies', { urls: ['https://accounts.google.com/ServiceLogin'] }, sessionId);
    const flow = validateFlowSessionBundle({ origin: 'https://flow.google.com', projectId: oldFlow.projectId,
      cookies: scopedProfileCookies(flowCookies.cookies, projectUrl) });
    const google = validateGoogleFlowAuthBundle({ version: 1, origin: 'https://accounts.google.com',
      serviceOrigin: 'https://flow.google.com', projectId: oldFlow.projectId, owner: oldGoogle.owner,
      capturedAt: new Date().toISOString(), cookies: scopedProfileCookies(googleCookies.cookies, 'https://accounts.google.com/ServiceLogin') });
    const verified = await verifyImpl(flow, oldGoogle.owner);
    if (readCredentialImpl(FLOW_CREDENTIAL) !== originalFlow || readCredentialImpl(GOOGLE_FLOW_AUTH_CREDENTIAL) !== originalGoogle) {
      throw profileError('FLOW_PROFILE_STORE_CHANGED');
    }
    writeCredentialImpl(FLOW_CREDENTIAL, JSON.stringify(verified.bundle));
    try { writeCredentialImpl(GOOGLE_FLOW_AUTH_CREDENTIAL, JSON.stringify(google)); }
    catch { throw Object.assign(profileError('FLOW_PROFILE_PARTIAL_COMMIT'), { flowStored: true, googleAuthStored: false }); }
    return { mode: 'browser_assisted_session_sync', session: 'authenticated', provider: 'Windows DPAPI CurrentUser',
      projectId: flow.projectId, cookieCount: flow.cookieCount, googleCookieCount: google.cookies.length,
      projectMediaCount: verified.projectMediaCount, plaintextPersisted: false, generationRequests: 0 };
  } finally {
    if (targetId) await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    cdp.close();
  }
}
