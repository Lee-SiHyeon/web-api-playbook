import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createChromeCompatibleFetch } from '../src/chrome-http-fetch.mjs';

async function fakePython(t, response, { inspectEnvironment = false } = {}) {
  const scratchRoot = process.env.TMPDIR || path.join(os.homedir(), '.nad-scratch', 'tmp');
  await mkdir(scratchRoot, { recursive: true });
  const directory = await mkdtemp(path.join(scratchRoot, 'grok-chrome-fetch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'python');
  const responseLiteral = JSON.stringify(response);
  const environmentProbe = inspectEnvironment ? `
  const names = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE'];
  reply.bodyBase64 = Buffer.from(JSON.stringify({
    unrelatedSecretPresent: Object.hasOwn(process.env, 'GROK_TEST_UNRELATED_SECRET_SENTINEL'),
    allowedEnvironmentPresent: Object.fromEntries(names.map(name => [name, Object.hasOwn(process.env, name)])),
    bytecodeFlagSet: process.env.PYTHONDONTWRITEBYTECODE === '1',
  })).toString('base64');
` : '';
  const script = `#!/usr/bin/env node
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const packet = JSON.parse(input);
  const body = JSON.parse(Buffer.from(packet.bodyBase64, 'base64').toString('utf8'));
  const allowed = packet.url === 'https://grok.com/rest/models'
    && packet.method === 'POST'
    && packet.credentials === 'omit'
    && JSON.stringify(packet.headers) === '{"content-type":"application/json"}'
    && JSON.stringify(body) === '{"locale":"en"}';
  if (!allowed) { process.exitCode = 2; return; }
  const reply = ${responseLiteral};
${environmentProbe}
  process.stdout.write(JSON.stringify(reply));
});
`;
  await writeFile(executable, script, { mode: 0o700 });
  await chmod(executable, 0o700);
  return executable;
}

test('Chrome-compatible helper bridge is constrained to the cookie-free public model request', async t => {
  const payload = Buffer.from('{"models":[]}').toString('base64');
  const pythonExecutable = await fakePython(t, {
    status: 200, contentType: 'application/json', httpVersion: 'h2', bodyBase64: payload,
  });
  const fetchImpl = createChromeCompatibleFetch({ pythonExecutable });
  const response = await fetchImpl('https://grok.com/rest/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"locale":"en"}',
    credentials: 'omit',
    redirect: 'manual',
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.equal(response.transportEvidence.httpVersion, 'h2');
  assert.deepEqual(await response.json(), { models: [] });
});

test('Chrome-compatible helper rejects private origins and caller-supplied cookies before spawning', async () => {
  const fetchImpl = createChromeCompatibleFetch({ pythonExecutable: '/path/that/must/not/be/run' });
  await assert.rejects(fetchImpl('https://accounts.x.ai/api/auth/sso/check', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    credentials: 'omit', redirect: 'manual',
  }), { code: 'CHROME_TRANSPORT_REQUEST_BLOCKED' });
  await assert.rejects(fetchImpl('https://grok.com/rest/models', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: 'sid=not-allowed' },
    body: '{"locale":"en"}', credentials: 'omit', redirect: 'manual',
  }), { code: 'CHROME_TRANSPORT_REQUEST_BLOCKED' });
});

test('Python child keeps runtime and certificate variables but drops unrelated inherited secrets', async t => {
  const sentinelName = 'GROK_TEST_UNRELATED_SECRET_SENTINEL';
  const sentinelValue = 'must-never-be-in-child';
  const certValues = {
    SSL_CERT_FILE: '/tmp/grok-test-ca.pem',
    SSL_CERT_DIR: '/tmp/grok-test-certs',
    REQUESTS_CA_BUNDLE: '/tmp/grok-test-requests-ca.pem',
  };
  const originals = new Map([sentinelName, ...Object.keys(certValues)].map(name => [name, process.env[name]]));
  process.env[sentinelName] = sentinelValue;
  Object.assign(process.env, certValues);
  try {
    const pythonExecutable = await fakePython(t, {
      status: 200, contentType: 'application/json', httpVersion: 'h2', bodyBase64: '',
    }, { inspectEnvironment: true });
    const response = await createChromeCompatibleFetch({ pythonExecutable })('https://grok.com/rest/models', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"locale":"en"}',
      credentials: 'omit', redirect: 'manual',
    });
    const observed = await response.json();

    assert.equal(observed.unrelatedSecretPresent, false);
    assert.equal(observed.bytecodeFlagSet, true);
    for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']) {
      assert.equal(observed.allowedEnvironmentPresent[name], typeof process.env[name] === 'string');
    }
    for (const name of Object.keys(certValues)) assert.equal(observed.allowedEnvironmentPresent[name], true);
  } finally {
    for (const [name, value] of originals) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
