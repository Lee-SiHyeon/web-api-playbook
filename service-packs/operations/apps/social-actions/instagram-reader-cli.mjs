import { readInstagramProfile, readInstagramPosts } from './instagram-reader.mjs';

async function readInput() {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 16 * 1024) throw Object.assign(new Error(), { code: 'INSTAGRAM_READ_INPUT_TOO_LARGE' });
  }
  if (!raw.trim()) throw Object.assign(new Error(), { code: 'INSTAGRAM_READ_INPUT_REQUIRED' });
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error(), { code: 'INSTAGRAM_READ_INPUT_INVALID' }); }
}

const allowedCodes = new Set([
  'INSTAGRAM_READ_INPUT', 'INSTAGRAM_READ_INPUT_TOO_LARGE', 'INSTAGRAM_READ_INPUT_REQUIRED',
  'INSTAGRAM_READ_INPUT_INVALID', 'INSTAGRAM_READ_COMMAND_INVALID', 'INSTAGRAM_TARGET_SCOPE', 'INSTAGRAM_TARGET_INVALID',
  'INSTAGRAM_FEATURE_FLAG_MISSING', 'INSTAGRAM_PROFILE_FLAG_CONTRACT_CHANGED',
  'INSTAGRAM_POSTS_CONTRACT_CHANGED', 'INSTAGRAM_POST_LIMIT_INVALID', 'INSTAGRAM_CURSOR_INVALID',
  'INSTAGRAM_POST_SCHEMA_INVALID', 'INSTAGRAM_POST_OWNER_MISMATCH', 'INSTAGRAM_PROFILE_TARGET_MISSING',
  'INSTAGRAM_PROFILE_TARGET_MISMATCH', 'INSTAGRAM_POSTS_SOURCE_MISSING', 'INSTAGRAM_POSTS_VIEWER_MISMATCH',
  'INSTAGRAM_POSTS_SCHEMA_INVALID', 'META_ACTION_INPUT', 'META_SESSION_MISSING', 'META_REAUTH_REQUIRED',
  'META_INTERACTION_REQUIRED', 'META_SESSION_BUSY', 'META_OWNER_CONTRACT_UNVERIFIED',
  'META_LOGIN_OR_BOOTSTRAP_REQUIRED', 'META_DOCUMENT_OWNER_MISMATCH', 'META_DOCUMENT_MIME',
  'META_DOCUMENT_COMPLEXITY', 'META_RESPONSE_LIMIT', 'META_SCRIPT_LIMIT', 'META_SCRIPT_SCOPE',
  'META_SOURCE_AMBIGUOUS', 'META_OPERATION_SOURCE_MISSING', 'META_OPERATION_DOCUMENT_MISSING',
  'META_TOKEN_DERIVATION_CHANGED', 'META_BOOTSTRAP_TOKEN_MISSING', 'META_BOOTSTRAP_FIELD_MISSING',
  'META_APP_ID_MISSING', 'META_REQUEST_SCOPE', 'META_GRAPHQL_MIME', 'META_GRAPHQL_NOT_JSON',
  'META_GRAPHQL_REJECTED', 'META_GRAPHQL_DATA_MISSING', 'META_FEATURE_FLAG_MISSING',
]);

async function main() {
  const [command] = process.argv.slice(2);
  if (!['profile', 'posts'].includes(command)) throw Object.assign(new Error(), { code: 'INSTAGRAM_READ_COMMAND_INVALID' });
  const input = await readInput();
  const result = command === 'profile' ? await readInstagramProfile(input) : await readInstagramPosts(input);
  console.log(JSON.stringify({ ok: true, ...result }));
}

main().catch(error => {
  const value = error.code || error.message;
  const code = typeof value === 'string' && (allowedCodes.has(value) || /^META_(?:DOCUMENT|SCRIPT|GRAPHQL)_HTTP_\d{3}$/.test(value))
    ? value : 'INSTAGRAM_READ_FAILED';
  console.log(JSON.stringify({ ok: false, service: 'instagram', code }));
  process.exitCode = 2;
});
