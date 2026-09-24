import { ApiWorkflow } from './api-workflow.mjs';
import { ApiError } from '../../scripts/client.mjs';
import { createInterface } from 'node:readline';

const workflow = new ApiWorkflow();
let buffer = '', serial = Promise.resolve(), closing = false;
let idle;
function resetIdle() { clearTimeout(idle); idle = setTimeout(() => shutdown(), 10 * 60 * 1000); }
async function shutdown() {
  if (closing) return;
  closing = true; clearTimeout(idle);
  await workflow.close().catch(() => {});
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.exit(0);
}
const methods = {
  prepare: () => workflow.prepare(), login: input => workflow.login(input), status: () => workflow.status(),
  authStatus: () => workflow.authStatus(), verifyHTTP: () => workflow.verifyHTTP(), enableHTTP: () => workflow.enableHTTP(),
  api: input => workflow.api(input), inspect: input => workflow.inspect(input), scan: input => workflow.scan(input),
  frontier: () => workflow.frontier(), evidence: () => workflow.evidence(),
  closeBrowser: () => workflow.closeBrowser(), stop: () => workflow.close(),
};
async function command(line) {
  let input;
  resetIdle();
  try {
    if (Buffer.byteLength(line) > 16384) throw new ApiError('INPUT', 'Input exceeds budget');
    input = JSON.parse(line); line = '';
    if (!Object.hasOwn(methods, input.method)) throw new ApiError('INPUT', 'Unsupported command');
    const result = await methods[input.method](input.args);
    if (input.args) { input.args.password = ''; input.args.username = ''; }
    console.log(JSON.stringify({ id: input.id, result }));
    if (input.method === 'stop') await shutdown();
  } catch (error) {
    if (input?.args) { input.args.password = ''; input.args.username = ''; }
    console.log(JSON.stringify({ id: input?.id, error: { code: error instanceof ApiError ? error.code : 'HEADLESS_FAILED',
      message: error instanceof ApiError ? error.message : 'Headless operation failed; raw details omitted' } }));
  }
}
if (process.stdin.isTTY) {
  // Raw input prevents the PTY from echoing passwords into console output.
  process.stdin.setRawMode(true); process.stdin.setEncoding('utf8'); process.stdin.resume();
  process.stdin.on('data', chunk => {
    if (chunk.includes('\u0003')) { void shutdown(); return; }
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 32768) { buffer = ''; console.log(JSON.stringify({ error: { code: 'INPUT_SIZE' } })); return; }
    let boundary;
    while ((boundary = buffer.search(/[\r\n]/)) !== -1) {
      const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
      if (line.trim()) serial = serial.then(() => command(line));
    }
  });
} else {
  const lines = createInterface({ input: process.stdin });
  lines.on('line', line => { serial = serial.then(() => command(line)); });
  lines.on('close', () => { serial.finally(() => shutdown()); });
}
process.once('SIGINT', () => { void shutdown(); });
resetIdle();
console.log(JSON.stringify({ ready: true, authenticated: false, credentialInputEcho: false, headless: true,
  existingChromeConnection: false, loginToHTTPConnected: true, writes: 0 }));
