import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'src', 'cli.mjs');

function run(args, input = '') {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repo, input, encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8' },
  });
}

test('attachment upload requires session, confirmation and one caller intent before reading the packet', () => {
  const result = run(['attachment', 'upload', '--session-stdin']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CLI_ATTACHMENT_UPLOAD_OPTIONS_REQUIRED/);
  assert.equal(result.stdout, '');
});

test('attachment upload rejects an incomplete packet without attempting a request', () => {
  const result = run(['attachment', 'upload', '--session-stdin', '--confirm', '--intent-id', 'test-once'], '{}');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CLI_ATTACHMENT_UPLOAD_PACKET_INVALID/);
  assert.equal(result.stdout, '');
});

test('attachment retention, explicit task cleanup, and business JSON output are distinct options', () => {
  const result = run(['attachment', 'upload', '--session-stdin', '--confirm', '--intent-id', 'test-options',
    '--cleanup-task-asset', '--output=json'], '{}');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CLI_ATTACHMENT_UPLOAD_PACKET_INVALID/);
  assert.equal(result.stdout, '');
});

test('direct upload accepts a private HOME filePath with explicit native policy before owner authentication', async () => {
  const scratchRoot = process.env.TMPDIR || path.join(os.homedir(), '.nad-scratch', 'tmp');
  const directory = await mkdtemp(path.join(scratchRoot, 'grok-cli-attachment-path-test-'));
  const filePath = path.join(directory, 'fixture.bin');
  await writeFile(filePath, Buffer.alloc(1024 * 1024 + 1, 0x41), { mode: 0o600 });
  const packet = {
    sessionBundle: { schemaVersion: 1, serviceId: 'grok-web', origin: 'https://grok.com', origins: [{
      origin: 'https://grok.com', cookies: [{ name: 'sso', value: 'bad;cookie', origin: 'https://grok.com', domain: '.grok.com', path: '/', secure: true, httpOnly: true }], headers: [],
    }] },
    expectedIdentity: 'fixture-owner',
    fileName: 'fixture.bin',
    fileMimeType: 'application/octet-stream',
    filePath,
    policy: { directUploadMaxSizeBytes: 16 * 1024 * 1024, maxUploadFileSizeBytes: 150 * 1024 * 1024 },
    assetServerOrigin: 'https://assets.grok.com',
    assetCookieScope: { domain: '.grok.com', path: '/', secure: true, httpOnly: true },
    assetSsoCookie: { name: 'sso', value: 'fixture-sso', domain: '.grok.com', path: '/', secure: true, httpOnly: true },
    assetRequestHeaders: { referer: 'https://grok.com/', 'user-agent': 'Mozilla/5.0 Chrome/154.0.0.0', 'sec-ch-ua-platform': '"Linux"' },
  };
  try {
    const result = run(['attachment', 'upload', '--session-stdin', '--confirm', '--intent-id', 'test-filepath-policy'], JSON.stringify(packet));
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /CLI_ATTACHMENT_UPLOAD_PACKET_INVALID/);
    assert.match(result.stderr, /SESSION|COOKIE/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('direct upload rejects file paths outside HOME and native policy values above captured limits', () => {
  const common = { sessionBundle: { schemaVersion: 1, serviceId: 'grok-web', origin: 'https://grok.com', origins: [{
      origin: 'https://grok.com', cookies: [{ name: 'sso', value: 'bad;cookie', origin: 'https://grok.com', domain: '.grok.com', path: '/', secure: true, httpOnly: true }], headers: [],
    }] }, expectedIdentity: 'fixture-owner', fileName: 'fixture.bin',
    fileMimeType: 'application/octet-stream', assetServerOrigin: 'https://assets.grok.com',
    assetCookieScope: { domain: '.grok.com', path: '/', secure: true, httpOnly: true },
    assetSsoCookie: { name: 'sso', value: 'fixture-sso', domain: '.grok.com', path: '/', secure: true, httpOnly: true },
    assetRequestHeaders: { referer: 'https://grok.com/' } };
  const outsidePath = run(['attachment', 'upload', '--session-stdin', '--confirm', '--intent-id', 'outside-path'], JSON.stringify({
    ...common, filePath: '/etc/hostname', policy: { directUploadMaxSizeBytes: 16 * 1024 * 1024, maxUploadFileSizeBytes: 150 * 1024 * 1024 },
  }));
  assert.equal(outsidePath.status, 1);
  assert.match(outsidePath.stderr, /CLI_ATTACHMENT_UPLOAD_PACKET_INVALID/);
  const invalidPolicy = run(['attachment', 'upload', '--session-stdin', '--confirm', '--intent-id', 'invalid-policy'], JSON.stringify({
    ...common, fileBytesBase64: 'NDI=', policy: { directUploadMaxSizeBytes: 16 * 1024 * 1024 + 1, maxUploadFileSizeBytes: 150 * 1024 * 1024 },
  }));
  assert.equal(invalidPolicy.status, 1);
  assert.match(invalidPolicy.stderr, /CLI_ATTACHMENT_NATIVE_POLICY_INVALID/);
});

test('presigned upload has a real CLI branch and requires its explicit feature policy and storage origins', () => {
  const missing = run(['attachment', 'upload-presigned', '--session-stdin']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /CLI_ATTACHMENT_UPLOAD_OPTIONS_REQUIRED/);
  const incomplete = run(['attachment', 'upload-presigned', '--session-stdin', '--confirm', '--intent-id', 'presigned-once'], '{}');
  assert.equal(incomplete.status, 1);
  assert.match(incomplete.stderr, /CLI_PRESIGNED_ATTACHMENT_PACKET_INVALID/);
  assert.equal(incomplete.stdout, '');
});

test('presigned upload refuses simultaneous file sources and non-HTTPS storage policy before authentication', () => {
  const packet = { sessionBundle: {}, expectedIdentity: 'fixture-owner', fileName: 'fixture.txt',
    fileMimeType: 'text/plain', fileBytesBase64: 'NDI=', policy: {}, allowedSignedUploadOrigins: ['http://example.com'] };
  for (const extra of [{}, { allowedSignedUploadOrigins: ['https://[::1]'] },
    { filePath: '/home/worker/fixture.txt', allowedSignedUploadOrigins: ['https://example.com'] }]) {
    const result = run(['attachment', 'upload-presigned', '--session-stdin', '--confirm', '--intent-id', 'presigned-once'], JSON.stringify({ ...packet, ...extra }));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CLI_PRESIGNED_ATTACHMENT_PACKET_INVALID/);
    assert.equal(result.stdout, '');
  }
});

test('presigned init accepts only the two observed optional SDK metadata headers', () => {
  const packet = { sessionBundle: {}, expectedIdentity: 'fixture-owner', fileName: 'fixture.txt',
    fileMimeType: 'text/plain', fileBytesBase64: 'NDI=', policy: {},
    allowedSignedUploadOrigins: ['https://upload.example.test'] };
  for (const initRequestMetadataHeaders of [
    { authorization: 'must-not-be-forwarded' },
    { cookie: 'must-not-be-forwarded' },
    { 'x-unobserved-header': 'not-allowlisted' },
    { 'x-xai-request-id': 'bad\r\nheader' },
    { 'x-statsig-id': '' },
  ]) {
    const result = run(['attachment', 'upload-presigned', '--session-stdin', '--confirm', '--intent-id', 'presigned-header-guard'],
      JSON.stringify({ ...packet, initRequestMetadataHeaders }));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CLI_PRESIGNED_ATTACHMENT_PACKET_INVALID/);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /must-not-be-forwarded|not-allowlisted|bad/);
  }
});

test('presigned upload method requirement is only an assertion about the server reply', () => {
  const packet = { sessionBundle: {}, expectedIdentity: 'fixture-owner', fileName: 'fixture.txt',
    fileMimeType: 'text/plain', fileBytesBase64: 'NDI=', policy: {},
    allowedSignedUploadOrigins: ['https://upload.example.test'] };
  const result = run(['attachment', 'upload-presigned', '--session-stdin', '--confirm', '--intent-id', 'presigned-method-guard'],
    JSON.stringify({ ...packet, requiredUploadMethod: 'single_put' }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CLI_PRESIGNED_ATTACHMENT_PACKET_INVALID/);
  assert.equal(result.stdout, '');
});

test('upload reference status and abort have explicit CLI routes and validate input before requests', () => {
  for (const subcommand of ['status', 'abort']) {
    const args = ['attachment', subcommand, '--session-stdin', '--reference-key', 'fixture-key'];
    if (subcommand === 'abort') args.push('--confirm', '--intent-id', 'fixture-abort');
    const result = run(args, '{}');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CLI_UPLOAD_REFERENCE_PACKET_INVALID/);
    assert.equal(result.stdout, '');
  }
});
