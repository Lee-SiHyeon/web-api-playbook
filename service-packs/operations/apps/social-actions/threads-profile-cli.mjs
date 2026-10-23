import {
  stageThreadsProfileEnvelope, readThreadsProfile, sendThreadsProfileLink,
  reconcileThreadsProfileLink, sendThreadsProfileBio, reconcileThreadsProfileBio,
} from './threads-profile.mjs';

const HELP = `Threads profile browser-assisted HTTP client

Commands:
  stage-write       Store one fresh, DevTools-blocked bio-link mutation in DPAPI
  stage-bio-write   Store one fresh, DevTools-blocked profile-bio mutation in DPAPI
  stage-profile-read Store one observed profile read query in DPAPI
  stage-links-read  Store one observed bio-links read query in DPAPI
  read              Read profile fields and links through protected HTTP session
  send-link         Journal and send one observed link mutation once
  send-bio          Journal and send one observed profile-bio mutation once
  reconcile-link    Independently read back a journaled link mutation
  reconcile-bio     Independently read back a journaled bio mutation

Input is one JSON object on stdin. Never pass cookies, tokens, or captured envelopes in command arguments.
`;

async function readInput() {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 1_000_000) throw Object.assign(new Error(), { code: 'THREADS_PROFILE_INPUT_LIMIT' });
  }
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error(), { code: 'THREADS_PROFILE_INPUT_INVALID' }); }
}

async function main() {
  const [command = 'help'] = process.argv.slice(2);
  if (['help', '--help', '-h'].includes(command)) {
    process.stdout.write(HELP);
    return;
  }
  const input = await readInput();
  let result;
  if (command === 'stage-write') result = await stageThreadsProfileEnvelope({ kind: 'write', ...input });
  else if (command === 'stage-bio-write') result = await stageThreadsProfileEnvelope({ kind: 'bio-write', ...input });
  else if (command === 'stage-profile-read') result = await stageThreadsProfileEnvelope({ kind: 'profile-read', ...input });
  else if (command === 'stage-links-read') result = await stageThreadsProfileEnvelope({ kind: 'links-read', ...input });
  else if (command === 'read') result = await readThreadsProfile();
  else if (command === 'send-link') result = await sendThreadsProfileLink(input);
  else if (command === 'send-bio') result = await sendThreadsProfileBio(input);
  else if (command === 'reconcile-link') result = await reconcileThreadsProfileLink(input);
  else if (command === 'reconcile-bio') result = await reconcileThreadsProfileBio(input);
  else throw Object.assign(new Error(), { code: 'THREADS_PROFILE_COMMAND_INVALID' });
  process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n');
}

main().catch(error => {
  const code = /^THREADS_PROFILE_[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'THREADS_PROFILE_OPERATION_FAILED';
  process.stderr.write(JSON.stringify({ ok: false, code }) + '\n');
  process.exitCode = 1;
});
