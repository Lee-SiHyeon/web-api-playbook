import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createGrokCffiAttachmentAssetReader, MAX_ATTACHMENT_ASSET_BYTES } from '../src/grok-attachment-asset-reader.mjs';

test('Node and the real Python packet validator accept presigned-size attachment readback without network', async () => {
  const artifacts = path.join(homedir(), 'artifacts');
  const scratch = process.env.TMPDIR ?? path.join(homedir(), '.nad-scratch', 'tmp');
  await Promise.all([mkdir(artifacts, { recursive: true }), mkdir(scratch, { recursive: true })]);
  const outputRoot = await mkdtemp(path.join(artifacts, '.attachment-limit-test-'));
  const temporary = await mkdtemp(path.join(scratch, 'attachment-validator-'));
  const scriptPath = path.join(temporary, 'validate_only.py');
  const realHelper = fileURLToPath(new URL('../scripts/grok_attachment_asset_download.py', import.meta.url));
  await writeFile(scriptPath, `import json,runpy,sys\nm=runpy.run_path(${JSON.stringify(realHelper)})\nm['validate_packet'](json.load(sys.stdin))\nm['emit'](failure='VALIDATION_ONLY_NO_NETWORK')\n`);
  const packet = {
    assetUrl: 'https://assets.grok.com/users/fixture-owner/files/fixture?cache=1', assetOrigin: 'https://assets.grok.com',
    mimeType: 'text/plain', expectedBytes: 16 * 1024 * 1024 + 1, maxBytes: 32 * 1024 * 1024,
    expectedSha256: 'a'.repeat(64), ownerIdentityDigest: 'b'.repeat(64),
    assetCookieScope: { domain: '.grok.com', path: '/', secure: true, httpOnly: true },
    ssoCookieValue: 'fixture-owner-cookie',
    headers: { referer: 'https://grok.com/', 'user-agent': 'Chrome/154.0.0.0', 'sec-ch-ua-platform': '"Linux"' },
    outputRoot, outputName: 'fixture.txt',
  };
  try {
    const read = createGrokCffiAttachmentAssetReader({ pythonExecutable: 'python3', scriptPath });
    const result = await read(packet);
    assert.equal(result.failure, 'VALIDATION_ONLY_NO_NETWORK');
    assert.equal(result.verified, false);
    await assert.rejects(read({ ...packet, expectedBytes: MAX_ATTACHMENT_ASSET_BYTES + 1, maxBytes: MAX_ATTACHMENT_ASSET_BYTES + 1 }),
      { code: 'ATTACHMENT_ASSET_READER_INPUT_INVALID' });
    await assert.rejects(read({ ...packet, maxBytes: packet.expectedBytes - 1 }), { code: 'ATTACHMENT_ASSET_READER_INPUT_INVALID' });
  } finally { await Promise.all([rm(temporary, { recursive: true, force: true }), rm(outputRoot, { recursive: true, force: true })]); }
});
