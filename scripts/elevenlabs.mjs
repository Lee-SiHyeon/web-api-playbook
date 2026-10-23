import { stdinJson } from '../lib/cli.mjs';
import { elevenLabsSessionStatus, importElevenLabsSession } from '../lib/elevenlabs-session.mjs';

function fail(code) { throw Object.assign(new Error(code), { code }); }

try {
  const [command, ...args] = process.argv.slice(2);
  let result;
  if (command === 'status' && args.length === 0) {
    result = await elevenLabsSessionStatus();
  } else if (command === 'import-session' && args.length === 0) {
    const envelope = await stdinJson(256 * 1024);
    result = await importElevenLabsSession(envelope);
    result = { ok: true, stored: result.stored, provider: result.provider, persistent: result.persistent };
  } else {
    fail('ELEVENLABS_USAGE');
  }
  console.log(JSON.stringify(result));
} catch (error) {
  const code = /^ELEVENLABS_[A-Z_0-9]+$/.test(error?.code ?? '')
    ? error.code
    : /^PROTECTED_STORE_[A-Z_0-9]+$/.test(error?.code ?? '')
      ? error.code
      : 'ELEVENLABS_OPERATION_FAILED';
  console.log(JSON.stringify({ ok: false, code }));
  process.exitCode = 2;
}
