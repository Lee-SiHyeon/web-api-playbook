import { readCredential, writeCredential } from '../scripts/secure-credential-store.mjs';
import { BLOG_ORIGIN, ScopedHttpSession } from './transport.mjs';

const credentialName = 'tistory-auth-state-v1';
const MAX_STATE_BYTES = 120 * 1024;

function invalidState() {
  const error = new Error('TISTORY_STATE_INVALID');
  error.code = 'TISTORY_STATE_INVALID';
  return error;
}

function validateState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.version !== 1
    || input.blogOrigin !== BLOG_ORIGIN || !input.session || typeof input.session !== 'object' || Array.isArray(input.session)) {
    throw invalidState();
  }
  let session;
  try { session = ScopedHttpSession.fromJSON(input.session).toJSON(); }
  catch { throw invalidState(); }
  const output = { version: 1, blogOrigin: BLOG_ORIGIN, session };
  if (input.identity != null) {
    if (typeof input.identity !== 'object' || Array.isArray(input.identity)) throw invalidState();
    const identity = {};
    for (const key of ['userId', 'appUserId', 'blogId']) {
      const value = input.identity[key];
      if (value != null && !(typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value))
        && !(typeof value === 'number' && Number.isSafeInteger(value))) throw invalidState();
      if (value != null) identity[key] = value;
    }
    output.identity = identity;
  }
  if (input.login != null) {
    if (typeof input.login !== 'object' || Array.isArray(input.login)) throw invalidState();
    output.login = input.login;
  }
  if (input.verifiedAt != null) {
    if (typeof input.verifiedAt !== 'string' || !Number.isFinite(Date.parse(input.verifiedAt))) throw invalidState();
    output.verifiedAt = input.verifiedAt;
  }
  return output;
}

export function loadState() {
  const stored = readCredential(credentialName);
  if (!stored) return null;
  if (Buffer.byteLength(stored, 'utf8') > MAX_STATE_BYTES) throw invalidState();
  let parsed;
  try { parsed = JSON.parse(stored); } catch { throw invalidState(); }
  return validateState(parsed);
}

export function saveState(state) {
  const validated = validateState(state);
  let serialized;
  try { serialized = JSON.stringify(validated); } catch { throw invalidState(); }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_STATE_BYTES || /[\r\n]/.test(serialized)) throw invalidState();
  return writeCredential(credentialName, serialized);
}
