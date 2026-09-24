import { probePartnerEnvelope, PartnerProbeError } from '../adapters/partner-account-probes.mjs';

// The caller writes a fresh envelope to this child process's stdin. No secret
// command arguments, environment dump, credential files, or browser fallback.
let text = '';
let envelope;
try {
  if (process.argv.length !== 2 || process.stdin.isTTY) throw new PartnerProbeError('STDIN_REQUIRED');
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text) > 64 * 1024) throw new PartnerProbeError('INPUT_SIZE');
  }
  try { envelope = JSON.parse(text); } catch { throw new PartnerProbeError('INPUT_JSON'); }
  text = '';
  const result = await probePartnerEnvelope(envelope);
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = result.ok ? 0 : 2;
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error instanceof PartnerProbeError ? error.code : 'PROBE_FAILED' }) + '\n');
  process.exitCode = 2;
} finally {
  text = '';
  envelope = null;
}
