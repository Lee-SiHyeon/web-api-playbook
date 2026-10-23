export async function reuseStoredNaverSession({ loadNaverCookies, SessionClient, ownerBlogId,
  rememberSession = false } = {}) {
  if (typeof loadNaverCookies !== 'function' || typeof SessionClient !== 'function'
    || typeof ownerBlogId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(ownerBlogId)) {
    throw new Error('LOGIN_SESSION_REUSE_INPUT_INVALID');
  }
  let saved;
  try { saved = await loadNaverCookies(); }
  catch (error) {
    if (error?.message === 'NAVER_AUTH_COOKIES_MISSING') return null;
    throw error;
  }
  if (!Array.isArray(saved?.cookies) || !saved.cookies.length) return null;
  const client = new SessionClient({ cookies: saved.cookies, ownerBlogId, persistRotation: false,
    defaultHeaders: saved.userAgent ? { 'user-agent': saved.userAgent } : {} });
  try {
    const persisted = rememberSession ? await client.persistVerifiedSession() : null;
    const verified = persisted ? persisted.verification : await client.verifyRoot();
    if (!verified) throw new Error('LOGIN_SESSION_VERIFICATION_MISSING');
    if (verified.loginHTML) return null;
    if (!verified.verified || !verified.actorMatched || !verified.adminShell) throw new Error('LOGIN_SESSION_OWNER_MISMATCH');
    return { actor: ownerBlogId, checkedAt: verified.checkedAt, executionMode: 'stored_session_http',
      browserEngineUsed: false, sessionReused: true, sessionStored: persisted ? persisted.stored === true : saved.persisted,
      cookiesPersisted: persisted?.stored === true,
      protectedOwnerRead: true, protectedReadStatus: verified.httpStatus, loginPostCount: 0,
      imageModelInvoked: false, credentialProvider: saved.provider, userAgentRestored: !!saved.userAgent,
      states: { captured: true, client_exists: true, credential_propagated: true, remnant_free: true, live_replay: true } };
  } catch (error) {
    if (error?.code === 'AUTH_MISSING' || (error?.code === 'AUTH_UNVERIFIED'
      && (error.details?.loginHTML === true || error.details?.finalPath === 'https://nid.naver.com/nidlogin.login'))) return null;
    throw error;
  } finally {
    client.clear();
    saved.cookies.length = 0;
  }
}
