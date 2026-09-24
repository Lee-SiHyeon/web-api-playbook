import { runMyrealtripEnvelope, MyrealtripError, marketingErrorResult } from '../adapters/myrealtrip-marketing.mjs';

let text = '', envelope;
try {
  if (process.argv.length !== 2 || process.stdin.isTTY) throw new MyrealtripError('STDIN_REQUIRED');
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text) > 65536) throw new MyrealtripError('INPUT_SIZE');
  }
  try { envelope = JSON.parse(text); } catch { throw new MyrealtripError('INPUT_JSON'); }
  text = '';
  const result = await runMyrealtripEnvelope(envelope);
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify(marketingErrorResult(error)) + '\n');
  process.exitCode = 2;
} finally { text = ''; envelope = null; }
