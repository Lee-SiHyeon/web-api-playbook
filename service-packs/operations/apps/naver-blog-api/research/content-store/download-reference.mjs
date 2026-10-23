// Materialize a connector-returned authenticated file reference. The temporary
// download URL arrives on stdin, never argv, logs, config or receipts.
import { createInterface } from 'node:readline';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const output = process.argv[2];
if (process.stdin.isTTY) process.stdin.setRawMode(true);
const input = createInterface({ input: process.stdin, terminal: false });
try {
  for await (const line of input) {
    const reference = JSON.parse(line);
    const url = new URL(reference.download_url);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.oaiusercontent.com') || !output) throw new Error('REFERENCE_SCOPE');
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error('DOWNLOAD_FAILED');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 5000000) throw new Error('DOWNLOAD_TOO_LARGE');
    JSON.parse(bytes.toString('utf8'));
    await writeFile(output, bytes, { flag: 'wx' });
    console.log(JSON.stringify({ downloadedBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }));
    break;
  }
} catch { console.error('CONNECTOR_DOWNLOAD_FAILED'); process.exitCode = 1; }
finally { input.close(); if (process.stdin.isTTY) process.stdin.setRawMode(false); }
