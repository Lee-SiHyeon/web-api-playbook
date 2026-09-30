const fail = (code, receipt = {}) => { throw Object.assign(new Error(code), { code, receipt }); };
export function isMissingXOwnerRoute(response) {
  if (response.status !== 404 || !response.headers?.['content-type']?.includes('json')) return false;
  try { const errors = JSON.parse(response.raw)?.errors; return Array.isArray(errors) && errors.length > 0 && errors.every(e => e.code === 34); } catch { return false; }
}
export function decodeXHomeOwner(response, expectedHandle) {
  if (!/^[A-Za-z0-9_]{1,15}$/.test(expectedHandle || '')) fail('X_HOME_OWNER_INPUT');
  const receipt = { operation: 'authenticated_home_owner', httpStatus: response.status, mime: response.headers?.['content-type'] || null, browserUsed: false, ownerVerificationMethod: 'server_rendered_authenticated_home' };
  if (response.status !== 200 || !receipt.mime?.includes('text/html')) fail('X_HOME_OWNER_UNVERIFIED', receipt);
  const match = String(response.raw).match(/(?:window\.)?__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;?\s*(?:window\.|<\/script>)/);
  let state; try { state = JSON.parse(match?.[1]); } catch { fail('X_HOME_OWNER_UNVERIFIED', receipt); }
  const id = state.session?.user_id;
  const user = state.entities?.users?.entities?.[id];
  if (state.session?.isLoaded === false && state.session.isRestrictedSession === false && typeof id === 'string' && /^\d{1,25}$/.test(id) && !user) fail('X_HOME_VIEWER_INCOMPLETE', receipt);
  if (state.session?.isLoaded !== true || state.session.isRestrictedSession !== false || typeof id !== 'string' || !/^\d{1,25}$/.test(id)
    || user?.id_str !== id || typeof user.screen_name !== 'string' || user.screen_name.toLowerCase() !== expectedHandle.toLowerCase()) fail('X_HOME_OWNER_UNVERIFIED', receipt);
  return { screen_name: user.screen_name, userId: id, receipt: { ...receipt, authenticated: true, ownerVerified: true } };
}
export async function verifyXHomeOwner(session, expectedHandle) {
  return decodeXHomeOwner(await session.request('https://x.com/home'), expectedHandle);
}
