import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createAuthenticatedChromeFetch } from '../src/authenticated-chrome-fetch.mjs';
import { MAX_DIRECT_MULTIPART_BASE64_LENGTH, MAX_DIRECT_MULTIPART_BODY_BYTES,
  MAX_DIRECT_MULTIPART_OVERHEAD_BYTES } from '../src/grok-attachment-constants.mjs';

const helperPath = path.resolve('scripts/authenticated-chrome-transport.py');

function directUploadRegistry() {
  return {
    schemaVersion: 1,
    serviceId: 'grok-web',
    serviceOrigin: 'https://grok.com',
    allowedOrigins: ['https://grok.com'],
    identityOperationId: null,
    operations: [{
      id: 'attachment.upload.direct',
      kind: 'submit',
      method: 'POST',
      urlTemplate: 'https://grok.com/http/upload-file-v2/direct',
      authMode: 'session',
      effect: 'file_upload',
      request: {
        inputSchema: { properties: { multipartBodyBase64: { type: 'string', minLength: 1, maxLength: 22370212 } }, required: ['multipartBodyBase64'] },
        bodyTemplate: '{{input.multipartBodyBase64}}',
        bodyEncoding: 'base64',
        maxBodyBytes: MAX_DIRECT_MULTIPART_BODY_BYTES,
        streamBodyFile: true,
        contentType: 'multipart/form-data; boundary=GrokWebAttachmentUploadV2Boundary',
        headers: { origin: 'https://grok.com', referer: 'https://grok.com/' },
        credentialBindings: { cookies: ['sso'], headers: [] },
      },
      response: { mode: 'json', statuses: [200], contentTypes: ['application/json'], maxBytes: 4096 },
      evidence: {
        source: 'first_party_sdk_contract',
        capturedAt: '2026-10-06T00:00:00Z',
        requestMethod: 'POST',
        requestPath: '/http/upload-file-v2/direct',
        httpStatus: null,
        responseContentType: 'unknown',
        securityBoundary: 'not_applicable',
        securitySignals: [],
        sourceUrl: 'https://cdn.grok.com/_next/static/chunks/1e3r6boa1v4lr.js',
        sourceSha256: '0d8f5bd1ba17b16404c055b9fbcf854cf492e06784aaa9660753e2d9d1f2cc13',
        sourceFunctionName: 'uploadFileV2',
        sourceDeclaredHeaders: [],
        browserWriteCapture: false,
        clientCallsiteFabricated: false,
        browserHeadersCaptured: false,
        directReplayReceipt: 'verification/grok-attachment-upload-live-2026-10-06.json',
        firstLiveReplayPermit: true,
      },
    }],
  };
}

async function fakeStreamingPython(t, responseBody) {
  const scratchRoot = process.env.TMPDIR || path.join(os.homedir(), '.nad-scratch', 'tmp');
  await lstat(scratchRoot);
  const directory = await mkdtemp(path.join(scratchRoot, 'grok-stream-fetch-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const recordPath = path.join(directory, 'body-observed.json');
  const executable = path.join(directory, 'python');
  const bodyBase64 = Buffer.from(JSON.stringify(responseBody)).toString('base64');
  const script = `#!/usr/bin/env node
const {createHash}=require('node:crypto');
const {lstatSync,readFileSync,writeFileSync}=require('node:fs');
const path=require('node:path');
async function main(){
 let packetText='';for await(const chunk of process.stdin)packetText+=chunk;
 const packet=JSON.parse(packetText);const st=lstatSync(packet.bodyFilePath);const body=readFileSync(packet.bodyFilePath);
 writeFileSync(${JSON.stringify(recordPath)},JSON.stringify({operationId:packet.operationId,bodyBytes:packet.bodyBytes,bodySha256:packet.bodySha256,bodyBase64:packet.bodyBase64,bodyFilePresent:true,bodyMode:(st.mode&0o777).toString(8),directoryMode:(lstatSync(path.dirname(packet.bodyFilePath)).mode&0o777).toString(8),actualBytes:body.length,actualSha256:createHash('sha256').update(body).digest('hex'),bodyPath:packet.bodyFilePath}));
 const bodyBase64=${JSON.stringify(bodyBase64)};
 process.stdout.write(JSON.stringify({status:200,contentType:'application/json',httpVersion:'h2',requestHeaderNames:['content-length','content-type','cookie','origin','referer'],requestMeta:{cookieNames:['sso'],bodyBytes:packet.bodyBytes,bodySha256:packet.bodySha256,bodyMode:'private_file_stream'},bodyBase64,setCookies:[]}));
}
main().catch(()=>{process.exitCode=1});
`;
  await writeFile(executable, script, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { executable, recordPath };
}

test('direct upload request streams a private file through the helper and removes it after HTTP response', async t => {
  const bytes = Buffer.alloc(1024 * 1024 + 1, 0x41);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const { executable, recordPath } = await fakeStreamingPython(t, { verified: true });
  const fetchImpl = createAuthenticatedChromeFetch({ registry: directUploadRegistry(), pythonExecutable: executable });
  const response = await fetchImpl('https://grok.com/http/upload-file-v2/direct', {
    method: 'POST',
    headers: {
      cookie: 'sso=test-session-cookie',
      'content-type': 'multipart/form-data; boundary=GrokWebAttachmentUploadV2Boundary',
      origin: 'https://grok.com',
      referer: 'https://grok.com/',
    },
    body: bytes,
    redirect: 'manual',
    sourceDiscoveryPermit: 'first-live:attachment.upload.direct',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { verified: true });
  const observed = JSON.parse(await readFile(recordPath, 'utf8'));
  assert.equal(observed.operationId, 'attachment.upload.direct');
  assert.equal(observed.bodyBase64, '');
  assert.equal(observed.bodyFilePresent, true);
  assert.equal(observed.bodyMode, '600');
  assert.equal(observed.directoryMode, '700');
  assert.equal(observed.actualBytes, bytes.length);
  assert.equal(observed.bodyBytes, bytes.length);
  assert.equal(observed.actualSha256, sha256);
  assert.equal(observed.bodySha256, sha256);
  assert.equal(await lstat(observed.bodyPath).then(() => true, error => error.code !== 'ENOENT'), false);
  assert.equal(response.transportEvidence.privateTempBodyCleanup, 'removed');
  assert.equal(response.transportEvidence.requestMeta.bodySha256, sha256);
  bytes.fill(0);
});

test('Node and Python request-body gates reject one byte over the shared native multipart cap', async t => {
  assert.equal(MAX_DIRECT_MULTIPART_OVERHEAD_BYTES, 443);
  assert.equal(MAX_DIRECT_MULTIPART_BASE64_LENGTH, 22370212);
  const python = process.env.PYTHON ?? 'python3';
  const constantsHarness = `import importlib.util,json\nspec=importlib.util.spec_from_file_location('transport',${JSON.stringify(helperPath)})\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nprint(json.dumps({'maxBodyBytes':m.MAX_DIRECT_MULTIPART_BODY_BYTES}))\n`;
  const constantsResult = spawnSync(python, ['-c', constantsHarness], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
  });
  assert.equal(constantsResult.status, 0, constantsResult.stderr);
  assert.equal(JSON.parse(constantsResult.stdout).maxBodyBytes, MAX_DIRECT_MULTIPART_BODY_BYTES);
  const { executable, recordPath } = await fakeStreamingPython(t, { verified: true });
  const fetchImpl = createAuthenticatedChromeFetch({ registry: directUploadRegistry(), pythonExecutable: executable });
  const oversized = Buffer.alloc(MAX_DIRECT_MULTIPART_BODY_BYTES + 1, 0x41);
  await assert.rejects(fetchImpl('https://grok.com/http/upload-file-v2/direct', {
    method: 'POST', headers: { cookie: 'sso=test-session-cookie',
      'content-type': 'multipart/form-data; boundary=GrokWebAttachmentUploadV2Boundary',
      origin: 'https://grok.com', referer: 'https://grok.com/' },
    body: oversized, redirect: 'manual', sourceDiscoveryPermit: 'first-live:attachment.upload.direct',
  }), { code: 'AUTH_CHROME_REQUEST_TOO_LARGE' });
  assert.equal(await lstat(recordPath).then(() => true, error => error.code !== 'ENOENT'), false);
  oversized.fill(0);

  const harness = `import importlib.util,json,sys\nfrom urllib.parse import urlsplit\nspec=importlib.util.spec_from_file_location('transport',${JSON.stringify(helperPath)})\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\np={'operationId':'attachment.upload.direct','bodyFilePath':'/not/opened/request-body.bin','bodyBytes':${MAX_DIRECT_MULTIPART_BODY_BYTES + 1},'bodySha256':'${'a'.repeat(64)}','bodyBase64':''}\ntry:m.open_direct_upload_body(p,urlsplit('https://grok.com/http/upload-file-v2/direct'),'POST')\nexcept SystemExit:pass\n`;
  const result = spawnSync(python, ['-c', harness], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR } });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { error: 'AUTH_CHROME_REQUEST_REJECTED', stage: 'streamed_body_scope' });
});

test('Python helper validates and rewinds a matching 1 MiB plus one private streamed body', async t => {
  const scratchRoot = process.env.TMPDIR || path.join(os.homedir(), '.nad-scratch', 'tmp');
  const directory = await mkdtemp(path.join(scratchRoot, 'grok-http-body-'));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bodyPath = path.join(directory, 'request-body.bin');
  const bytes = Buffer.alloc(1024 * 1024 + 1, 0x42);
  const bodySha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(bodyPath, bytes, { mode: 0o600 });
  bytes.fill(0);
  const packet = {
    operationId: 'attachment.upload.direct', bodyFilePath: bodyPath, bodyBytes: 1024 * 1024 + 1,
    bodySha256, bodyBase64: '',
  };
  const harness = `import hashlib,importlib.util,json,sys\nfrom urllib.parse import urlsplit\nspec=importlib.util.spec_from_file_location('transport',${JSON.stringify(helperPath)})\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\np=json.loads(${JSON.stringify(JSON.stringify(packet))})\nbody,f,n,digest,mode=m.open_direct_upload_body(p,urlsplit('https://grok.com/http/upload-file-v2/direct'),'POST')\nh=hashlib.sha256();total=0\nfor chunk in iter(lambda:f.read(65536),b''):\n total+=len(chunk);h.update(chunk)\nf.close()\nprint(json.dumps({'byteCount':n,'streamedByteCount':total,'computedSha256':digest,'streamedSha256':h.hexdigest(),'mode':mode},separators=(',',':')))\n`;
  const result = spawnSync(process.env.PYTHON ?? 'python3', ['-c', harness], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: scratchRoot },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    byteCount: packet.bodyBytes,
    streamedByteCount: packet.bodyBytes,
    computedSha256: bodySha256,
    streamedSha256: bodySha256,
    mode: 'private_file_stream',
  });
});
