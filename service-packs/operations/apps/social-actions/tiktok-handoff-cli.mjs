import { persistTikTokSessionFromCookies } from './lib/tiktok-auth-session.mjs';
import { stageTikTokEnvelope, markTikTokEnvelopeHelperClosed, stageTikTokOwnerListEnvelope } from './tiktok-publisher.mjs';

try {
  const operation = process.argv[2];
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 1_000_000) throw Object.assign(new Error(), { code: 'TIKTOK_HANDOFF_INPUT_LIMIT' });
  }
  let result;
  if (operation === 'session') result = await persistTikTokSessionFromCookies(JSON.parse(raw));
  else if (operation === 'envelope') result = await stageTikTokEnvelope(JSON.parse(raw));
  else if (operation === 'read-envelope') result = await stageTikTokOwnerListEnvelope(JSON.parse(raw));
  else if (operation === 'closed') result = await markTikTokEnvelopeHelperClosed();
  else throw Object.assign(new Error(), { code: 'TIKTOK_HANDOFF_OPERATION_INVALID' });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ ok: false,
    code: /^TIKTOK_[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'TIKTOK_HANDOFF_FAILED' }));
  process.exitCode = 1;
}
