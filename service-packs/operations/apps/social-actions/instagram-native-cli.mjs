import { stageNativeInstagram, sendNativeInstagram, reconcileNativeInstagram } from './instagram-native-publish.mjs';

const HELP = `Instagram observed native-request one-shot client

Commands:
  stage      Validate and protect one recent, inspector-blocked request envelope
  send       Send one protected request and record its result; never retries an existing journal
  reconcile  Read owner posts only and compare caption hash, Reel type, and owner identity

Input is one JSON object on standard input. Sensitive request data is read in memory and protected with
the current Windows user's DPAPI store. Never place request envelopes or session values in command arguments.
`;

async function readInput() {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 1_000_000) throw Object.assign(new Error(), { code: 'INSTAGRAM_INPUT_TOO_LARGE' });
  }
  if (!raw.trim()) throw Object.assign(new Error(), { code: 'INSTAGRAM_INPUT_REQUIRED' });
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error(), { code: 'INSTAGRAM_INPUT_INVALID' }); }
}

async function main() {
  const [command = 'help'] = process.argv.slice(2);
  if (['help', '--help', '-h'].includes(command)) {
    process.stdout.write(HELP);
    return;
  }
  if (!['stage', 'send', 'reconcile'].includes(command)) {
    throw Object.assign(new Error(), { code: 'INSTAGRAM_NATIVE_COMMAND_INVALID' });
  }
  const input = await readInput();
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error(), { code: 'INSTAGRAM_NATIVE_INPUT_INVALID' });
  }
  const result = command === 'stage' ? await stageNativeInstagram(input)
    : command === 'send' ? await sendNativeInstagram(input)
      : await reconcileNativeInstagram(input);
  process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n');
}

main().catch(error => {
  const code = /^[A-Z0-9_]{1,100}$/.test(error?.code || '') ? error.code : 'INSTAGRAM_NATIVE_FAILED';
  process.stderr.write(JSON.stringify({ ok: false, code }) + '\n');
  process.exitCode = 1;
});
