import { evaluateShoppingReadiness } from '../adapters/naver-shopping-readiness.mjs';

// Accept sanitized probe results only; never browser cookies or raw account data.
let input = '';
try {
  if (process.argv.length !== 2 || process.stdin.isTTY) throw new Error('INPUT_REQUIRED');
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 65536) throw new Error('INPUT_SIZE');
  }
  const result = evaluateShoppingReadiness(JSON.parse(input));
  input = '';
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = result.readyForScopedDiscovery ? 0 : 2;
} catch {
  process.stdout.write(JSON.stringify({ ok: false, code: 'INVALID_SANITIZED_PROBE' }) + '\n');
  process.exitCode = 2;
} finally { input = ''; }
