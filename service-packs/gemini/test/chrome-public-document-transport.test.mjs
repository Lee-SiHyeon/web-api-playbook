import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { parsePublicStatusOptions } from '../src/cli.mjs';
import { readPublicDocumentChrome, chromePublicDocumentInternals } from '../src/chrome-public-document-transport.mjs';
import { MAX_DOCUMENT_BYTES } from '../src/public-document.mjs';

const html = `<html lang="en-US"><head><title>Google Gemini</title>
<script id="bard-initial-data">WIZ_global_data={FdrFJe:'private-fixture'};</script>
<script id="base-js" src="https://gemini.gstatic.com/base.js"></script></head>
<body><chat-app-orchestrator></chat-app-orchestrator></body></html>`;

function spawnFixture({ stdout = Buffer.alloc(0), stderr = '', exitCode = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; child.emit('close', -9); };
  queueMicrotask(() => {
    if (stdout.length) child.stdout.write(stdout);
    if (stderr) child.stderr.write(stderr);
    child.stdout.end();
    child.stderr.end();
    child.emit('close', exitCode);
  });
  return child;
}

test('Chrome-compatible CLI options require only the fixed transport and absolute Python path', () => {
  assert.deepEqual(parsePublicStatusOptions([]), { transport: 'node', pythonPath: undefined });
  assert.deepEqual(parsePublicStatusOptions(['--transport', 'chrome', '--python', '/usr/bin/python3']), {
    transport: 'chrome', pythonPath: '/usr/bin/python3',
  });
  assert.throws(() => parsePublicStatusOptions(['--transport', 'chrome', '--python', 'python3']), { code: 'PUBLIC_DOCUMENT_PYTHON_PATH_INVALID' });
  assert.throws(() => parsePublicStatusOptions(['--url', 'https://attacker.invalid/']), { code: 'CLI_ARGUMENT_INVALID' });
  assert.throws(() => parsePublicStatusOptions(['--method', 'OPTIONS']), { code: 'CLI_ARGUMENT_INVALID' });
});

test('transport invokes a fixed helper with no endpoint, method, request body, credentials, or inherited secrets', async () => {
  let observed;
  const frame = Buffer.concat([Buffer.from('{"status":200,"contentType":"text/html; charset=utf-8","headerBytes":8192,"httpVersion":"h2"}\n'), Buffer.from(html)]);
  const receipt = await readPublicDocumentChrome({
    pythonPath: '/usr/bin/python3',
    spawnImpl: (command, args, options) => {
      observed = { command, args, options };
      return spawnFixture({ stdout: frame });
    },
  });
  assert.equal(observed.command, '/usr/bin/python3');
  assert.deepEqual(observed.args, [chromePublicDocumentInternals.HELPER_PATH]);
  assert.equal(observed.options.shell, false);
  assert.deepEqual(observed.options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(Object.hasOwn(observed.options, 'input'), false);
  assert.deepEqual(Object.keys(observed.options.env).sort(), ['LANG', 'LC_ALL', 'PATH']);
  assert.equal(receipt.executionMode, 'chrome_compatible_http');
  assert.equal(receipt.bodyBytes, Buffer.byteLength(html));
  assert.deepEqual(receipt.transport, {
    library: 'curl_cffi', libraryVersion: '0.16.3', browserProfile: 'chrome150', platform: 'Linux x86_64',
    negotiatedHttpVersion: 'h2', responseHeaderBytes: 8192,
  });
  assert.equal(receipt.directReadVerified, true);
  assert.equal(receipt.authenticationVerified, false);
  assert.equal(receipt.chatLiveReplay, false);
  assert.doesNotMatch(JSON.stringify(receipt), /private-fixture/);
});

test('child failures redact stderr and oversized child output is stopped at the Node boundary', async () => {
  await assert.rejects(readPublicDocumentChrome({
    pythonPath: '/usr/bin/python3',
    spawnImpl: () => spawnFixture({ stderr: 'Authorization: private-token', exitCode: 1 }),
  }), error => error.code === 'PUBLIC_DOCUMENT_TRANSPORT_FAILED' && !error.message.includes('private-token'));

  let child;
  await assert.rejects(readPublicDocumentChrome({
    pythonPath: '/usr/bin/python3',
    spawnImpl: () => {
      child = spawnFixture();
      return child;
    },
  }), { code: 'PUBLIC_DOCUMENT_TRANSPORT_FAILED' });

  const tooLarge = Buffer.concat([
    Buffer.from('{"status":200,"contentType":"text/html"}\n'),
    Buffer.alloc(MAX_DOCUMENT_BYTES + 2048, 0x61),
  ]);
  let boundedChild;
  await assert.rejects(readPublicDocumentChrome({
    pythonPath: '/usr/bin/python3',
    spawnImpl: () => {
      boundedChild = new EventEmitter();
      boundedChild.stdout = new PassThrough();
      boundedChild.stderr = new PassThrough();
      boundedChild.kill = () => { boundedChild.killed = true; boundedChild.emit('close', -9); };
      queueMicrotask(() => boundedChild.stdout.write(tooLarge));
      return boundedChild;
    },
  }), { code: 'PUBLIC_DOCUMENT_TOO_LARGE' });
  assert.equal(boundedChild.killed, true);
  assert.equal(child.killed, undefined);
});

test('rejects unknown negotiated HTTP versions and out-of-bound reported header bytes', async () => {
  const frame = Buffer.concat([Buffer.from('{"status":200,"contentType":"text/html","headerBytes":128,"httpVersion":"h9"}\n'), Buffer.from(html)]);
  await assert.rejects(readPublicDocumentChrome({
    pythonPath: '/usr/bin/python3',
    spawnImpl: () => spawnFixture({ stdout: frame }),
  }), { code: 'PUBLIC_DOCUMENT_TRANSPORT_FAILED' });
  const tooManyHeaders = Buffer.concat([Buffer.from('{"status":200,"contentType":"text/html","headerBytes":262145,"httpVersion":"h2"}\n'), Buffer.from(html)]);
  await assert.rejects(readPublicDocumentChrome({
    pythonPath: '/usr/bin/python3',
    spawnImpl: () => spawnFixture({ stdout: tooManyHeaders }),
  }), { code: 'PUBLIC_DOCUMENT_TRANSPORT_FAILED' });
});
