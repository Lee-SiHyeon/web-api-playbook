import { runOliveyoungEnvelope, OliveyoungError, oliveyoungErrorResult } from '../adapters/oliveyoung-curator.mjs';

let input = '', envelope;
try {
  if (process.argv.length !== 2 || process.stdin.isTTY) throw new OliveyoungError('STDIN_REQUIRED');
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 65536) throw new OliveyoungError('INPUT_SIZE');
  }
  try { envelope = JSON.parse(input); } catch { throw new OliveyoungError('INPUT_JSON'); }
  input = '';
  const result = await runOliveyoungEnvelope(envelope);
  process.stdout.write(JSON.stringify(result) + '\n');
  if (!result.ok) process.exitCode = 2;
} catch (error) {
  process.stdout.write(JSON.stringify(oliveyoungErrorResult(error)) + '\n');
  process.exitCode = 2;
} finally { input = ''; envelope = null; }
