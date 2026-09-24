import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OliveyoungError, selectSessionCookies } from '../../adapters/oliveyoung-curator.mjs';

const cli = fileURLToPath(new URL('../../scripts/oliveyoung.mjs', import.meta.url));

// Pass the result of service-scoped CDP Network.getCookies and observed request headers.
// Nothing in this helper reads browser profiles, localStorage, passwords or token files.
export function sessionFromCapture({ cookies, headers = {} }) {
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return { cookies: selectSessionCookies(cookies), authorization: lower.authorization ?? '',
    userAgent: lower['user-agent'] ?? '', gateway: lower['x-oy-gw'] === 'Y' };
}

export function runOliveyoung(envelope, { signal, nodeExecutable = process.execPath,
  environment = process.env, spawnImpl = spawn, timeoutMs = 60000 } = {}) {
  const encoded = JSON.stringify(envelope);
  if (Buffer.byteLength(encoded) > 65536) throw new OliveyoungError('INPUT_SIZE');
  if (typeof nodeExecutable !== 'string' || !nodeExecutable) throw new OliveyoungError('RUNNER_INPUT');
  const write = ['createLink', 'completeLink'].includes(envelope.operation);
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP'].filter(key => environment[key]).map(key => [key, environment[key]]));
    const secrets = [envelope.session?.authorization, ...(envelope.session?.cookies ?? []).map(cookie => cookie.value)].filter(Boolean);
    const child = spawnImpl(nodeExecutable, [cli], { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: false, signal });
    let output = '', failure;
    const timer = setTimeout(() => { failure = 'RUNNER_TIMEOUT'; child.kill(); }, timeoutMs);
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8');
      if (Buffer.byteLength(output) > 2097152) { failure = 'RUNNER_OUTPUT_SIZE'; output = ''; child.kill(); }
    });
    child.stdin.on('error', () => { failure ||= 'RUNNER_INPUT'; });
    child.once('error', () => { failure = 'RUNNER_FAILED'; });
    child.once('close', code => {
      clearTimeout(timer);
      let result;
      try {
        if (failure || ![0, 2].includes(code)) throw new Error();
        if (secrets.some(secret => output.includes(secret) || output.includes(JSON.stringify(secret).slice(1, -1)))) { failure = 'OUTPUT_REDACTED'; throw new Error(); }
        result = JSON.parse(output);
        if (typeof result.ok !== 'boolean') throw new Error();
      } catch {
        reject(new OliveyoungError(write ? 'WRITE_OUTCOME_UNKNOWN' : failure || 'RUNNER_FAILED',
          write ? { nextOperation: 'generated', causeCode: failure || 'RUNNER_FAILED' } : {}));
        return;
      } finally { output = ''; secrets.fill(''); }
      resolve(result);
    });
    child.stdin.end(encoded);
  });
}
