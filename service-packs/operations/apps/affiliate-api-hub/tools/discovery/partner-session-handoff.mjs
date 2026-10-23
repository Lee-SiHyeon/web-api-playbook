import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PartnerProbeError } from '../../adapters/partner-account-probes.mjs';
import { MYREALTRIP_OPERATIONS, MyrealtripError } from '../../adapters/myrealtrip-marketing.mjs';

const cli = fileURLToPath(new URL('../../scripts/partner-session-probe.mjs', import.meta.url));
const marketingCli = fileURLToPath(new URL('../../scripts/myrealtrip.mjs', import.meta.url));

export function runPartnerProbe(envelope, options) {
  return runPrivateChild(cli, envelope, options);
}

export function runMyrealtrip(envelope, options) {
  let operation;
  try {
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
        Object.keys(envelope).some(key => !['schemaVersion', 'acquiredAt', 'session', 'operation', 'input'].includes(key)) ||
        envelope.schemaVersion !== 1 || !envelope.session || typeof envelope.session !== 'object' || Array.isArray(envelope.session) ||
        typeof envelope.session.token !== 'string' || !envelope.session.token || typeof envelope.acquiredAt !== 'string' ||
        !Number.isFinite(Date.parse(envelope.acquiredAt))) {
      throw new MyrealtripError('INPUT');
    }
    const age = Date.now() - Date.parse(envelope.acquiredAt);
    if (age < 0 || age > 5 * 60000) throw new MyrealtripError('HANDOFF_EXPIRED');
    operation = envelope.operation;
    if (operation === 'createFlightLanding' || operation === 'createFlightLink') throw new MyrealtripError('WRITE_JOURNAL_REQUIRED');
    if (!Object.hasOwn(MYREALTRIP_OPERATIONS, operation)) throw new MyrealtripError('SCOPE');
    const spec = MYREALTRIP_OPERATIONS[operation];
    if (!spec) throw new MyrealtripError('SCOPE');
    // createLink is the only write exposed here: the maintained CLI persists its
    // idempotency journal before the POST. Other POST workflows lack that guard.
    if (spec.method !== 'GET' && operation !== 'createLink') throw new MyrealtripError('WRITE_JOURNAL_REQUIRED');
    if (!envelope.input || typeof envelope.input !== 'object' || Array.isArray(envelope.input)) throw new MyrealtripError('INPUT');
  } catch (error) {
    if (error instanceof MyrealtripError) return Promise.resolve({ ok: false, code: error.code, outcome: error.outcome });
    return Promise.resolve({ ok: false, code: 'INPUT', outcome: 'not_sent' });
  }

  // The caller's session is used only for output redaction. It is never serialized
  // or passed to the child; the maintained CLI reads the current user's DPAPI store.
  const request = { operation, input: envelope.input };
  return runPrivateChild(marketingCli, request, options, [envelope.session.token]).catch(error => {
    if (operation === 'createLink') {
      throw new MyrealtripError('WRITE_OUTCOME_UNKNOWN', { outcome: 'unknown', causeCode: error.code || 'RUNNER_FAILED' });
    }
    throw error;
  });
}

function runPrivateChild(script, envelope, {
  signal, nodeExecutable = process.execPath, environment = process.env, spawnImpl = spawn,
} = {}, extraSensitiveValues = []) {
  if (typeof nodeExecutable !== 'string' || !nodeExecutable) throw new PartnerProbeError('RUNNER_INPUT');
  const encoded = JSON.stringify(envelope);
  if (Buffer.byteLength(encoded) > 65536) throw new PartnerProbeError('INPUT_SIZE');
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP'].filter(key => environment[key]).map(key => [key, environment[key]]));
    const secrets = [...extraSensitiveValues, envelope.session?.token, envelope.services?.myrealtrip?.token,
      ...(envelope.services?.brandconnect?.cookies ?? []).map(cookie => cookie.value)].filter(value => typeof value === 'string' && value);
    const child = spawnImpl(nodeExecutable, [script], {
      env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: false, signal,
    });
    let output = '';
    let failure;
    const timer = setTimeout(() => { failure = 'RUNNER_TIMEOUT'; child.kill(); }, script === marketingCli ? 55000 : 20000);
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8');
      if (Buffer.byteLength(output) > 65536) { failure = 'RUNNER_OUTPUT_SIZE'; output = ''; child.kill(); }
    });
    child.stdin.on('error', () => { failure ||= 'RUNNER_INPUT'; });
    child.once('error', () => { failure = 'RUNNER_FAILED'; });
    child.once('close', code => {
      clearTimeout(timer);
      let result;
      try {
        if (failure || ![0, 2].includes(code)) throw new Error();
        if (secrets.some(secret => output.includes(secret))) { failure = 'RUNNER_OUTPUT_REDACTED'; throw new Error(); }
        result = JSON.parse(output);
        if (typeof result.ok !== 'boolean') throw new Error();
      } catch { reject(new PartnerProbeError(failure || 'RUNNER_FAILED')); return; }
      finally { output = ''; secrets.fill(''); }
      resolve(result);
    });
    child.stdin.end(encoded);
  });
}
