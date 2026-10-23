import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm, realpath, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { summarizeAgentHar, compareContractShapes } from '../lib/browser-evidence.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const match = /^--(agent-browser|browser|output)=(.+)$/.exec(arg);
  if (!match) throw new Error('FIXTURE_ARGUMENT_INVALID');
  return [match[1], match[2]];
}));
let scratch, server, output, base, closed = false;
const received = [], commands = [], steps = [];
const fixtureSecret = 'SYNTHETIC_FIXTURE_SECRET_DO_NOT_RETAIN';
const audio = Buffer.from('524946462400000057415645666d74201000000001000100401f0000803e0000020010006461746100000000', 'hex');
const products = [{ id: 'fixture-1', price: 1200 }, { id: 'fixture-2', price: 2400 }];
let executable, commandArgs, childEnvironment, measuredVersion = null;

async function command(...tail) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...commandArgs, ...tail], { windowsHide: true, env: childEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, done = false;
    const finish = (exitCode, forcedCode = null) => {
      if (done) return; done = true; clearTimeout(timer);
      let value; try { value = JSON.parse(stdout); } catch {}
      commands.push({ command: tail[0], exitCode, success: value?.success === true,
        code: forcedCode ?? (/^[a-z_]+$/.test(value?.code ?? '') ? value.code : null),
        socketTimeout: /os error 10060/.test((value?.error ?? '') + stderr) });
      if (forcedCode || exitCode !== 0 || value?.success !== true) reject(new Error('FIXTURE_BROWSER_COMMAND_FAILED'));
      else resolve(value.data);
    };
    const timer = setTimeout(() => { child.kill(); child.stdout.destroy(); child.stderr.destroy(); finish(null, 'command_timeout'); }, 45000);
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) child.kill(); else stdout += chunk; });
    child.stderr.on('data', chunk => { if (stderr.length < 8192) stderr += chunk.toString().slice(0, 8192 - stderr.length); });
    child.on('error', () => { if (!done) { done = true; clearTimeout(timer); reject(new Error('FIXTURE_PROCESS_FAILED')); } });
    child.on('close', exitCode => finish(exitCode));
  });
}

async function cleanup() {
  if (commandArgs && !closed) { try { await command('close'); closed = true; } catch {} }
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (scratch && closed) {
    // Only delete the directory created by this process, after checking containment.
    const tempBase = await realpath(tmpdir());
    const target = await realpath(scratch);
    if (path.dirname(target) !== tempBase || !path.basename(target).startsWith('playbook-browser-fixture-')) throw new Error('FIXTURE_CLEANUP_SCOPE');
    try { await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); }
    catch { return false; }
  }
  return closed;
}

try {
  if (!args['agent-browser'] || !args.browser || !args.output) throw new Error('FIXTURE_ARGUMENT_INVALID');
  executable = await realpath(args['agent-browser']);
  const browser = await realpath(args.browser);
  output = await open(args.output, 'wx');
  const version = spawnSync(executable, ['--version'], { windowsHide: true, timeout: 5000, encoding: 'utf8', maxBuffer: 4096 });
  measuredVersion = /^agent-browser (\d+\.\d+\.\d+)\s*$/.exec(version.stdout ?? '')?.[1] ?? null;
  if (version.status !== 0 || measuredVersion !== '0.39.1') throw new Error('FIXTURE_VERSION_UNSUPPORTED');
  scratch = await mkdtemp(path.join(tmpdir(), 'playbook-browser-fixture-'));
  await mkdir(path.join(scratch, 'home'));
  await writeFile(path.join(scratch, 'config.json'), '{}');
  childEnvironment = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'LANG', 'LC_ALL'].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
  childEnvironment.HOME = path.join(scratch, 'home');
  childEnvironment.USERPROFILE = path.join(scratch, 'home');
  const namespace = `playbook-fixture-${randomUUID()}`;
  commandArgs = ['--config', path.join(scratch, 'config.json'), '--namespace', namespace, '--session', 'fixture',
    '--profile', path.join(scratch, 'profile'), '--executable-path', browser, '--idle-timeout', '30s', '--json'];
  server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    received.push({ method: request.method, path: url.pathname });
    if (url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html', 'set-cookie': `fixture_session=${fixtureSecret}; SameSite=Lax` });
      response.end(`<!doctype html><html><body><h1>Playbook local fixture</h1><iframe src="/frame"></iframe>
      ${['Search','Next','Options','Redirect','Audio','Failure','Stream'].map(name => `<button id="button-${name}">${name}</button>`).join('')}
      <script>
      const urls = {Search:'/api/search?q=${fixtureSecret}',Next:'/api/search?page=2',Options:'/api/options',Redirect:'/api/redirect',Audio:'/api/audio',Failure:'/api/fail',Stream:'/api/stream'};
      for(const [name,url] of Object.entries(urls)) document.getElementById('button-'+name).onclick=async()=>{
        const response=await fetch(url,{headers:{'x-fixture-secret':'${fixtureSecret}'}});
        const bytes=await response.arrayBuffer(); const p=document.createElement('p');p.id='ready-'+name;
        p.textContent=name==='Audio'?String(bytes.byteLength):new TextDecoder().decode(bytes);document.body.appendChild(p);
      };
      </script></body></html>`);
    } else if (url.pathname === '/frame') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<p>Fixture frame</p>'); }
    else if (url.pathname === '/api/redirect') { response.writeHead(302, { location: '/api/search?page=3' }); response.end(''); }
    else if (url.pathname === '/api/audio') { response.writeHead(200, { 'content-type': 'audio/wav' }); response.end(audio); }
    else if (url.pathname === '/api/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: fixture-one\n\ndata: fixture-two\n\n'); }
    else if (url.pathname === '/api/fail') { response.writeHead(503, { 'content-type': 'application/json' }); response.end('{"error":"fixture_unavailable"}'); }
    else if (url.pathname === '/api/options') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ options: ['small', 'large'] })); }
    else if (url.pathname === '/api/search') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ products, page: Number(url.searchParams.get('page') ?? 1) })); }
    else { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  await command('open', 'about:blank');
  await command('network', 'har', 'start', '--content', 'all');
  const startedAt = new Date().toISOString();
  await command('open', base + '/');
  for (const name of ['Search','Next','Options','Redirect','Audio','Failure','Stream']) {
    const before = await command('network', 'requests');
    await command('snapshot');
    await command('find', 'role', 'button', 'click', '--name', name);
    await command('wait', '#ready-' + name);
    const after = await command('network', 'requests');
    steps.push({ id: name.toLowerCase(), state: 'completed', requestsBefore: before.requests?.length ?? null,
      requestsAfter: after.requests?.length ?? null, attribution: 'bounded_action_window_not_initiator_proof' });
  }
  const browserText = await command('get', 'text', '#ready-Search');
  const browserValue = typeof browserText === 'string' ? browserText : browserText?.text;
  const httpResponse = await fetch(base + '/api/search?q=direct');
  const httpData = await httpResponse.json();
  const uiData = JSON.parse(browserValue);
  const valuesMatched = JSON.stringify(uiData.products) === JSON.stringify(httpData.products);
  const harFile = path.join(scratch, 'capture.har');
  await command('network', 'har', 'stop', harFile);
  const har = JSON.parse(await readFile(harFile, 'utf8'));
  const evidence = summarizeAgentHar(har);
  const audioEntry = har.log.entries.find(entry => new URL(entry.request.url).pathname === '/api/audio');
  const embeddedAudio = audioEntry?.response?.content;
  const audioMatched = embeddedAudio?.encoding === 'base64' && sha(Buffer.from(embeddedAudio.text, 'base64')) === sha(audio);
  const cleaned = await cleanup(); server = null;
  const result = { schema: 'web-api-browser-fixture-v1', checkedAt: new Date().toISOString(), startedAt,
    scope: 'isolated_local_synthetic_fixture', productionSitesTested: 0, userProfileUsed: false,
    agentBrowserVersion: measuredVersion, nativeBinarySha256: sha(await readFile(executable)), browserChannel: 'explicit_executable',
    browserUsedForCapture: true, independentHttpClient: 'node_fetch',
    assertions: { searchValuesMatched: valuesMatched, audioBytesMatched: audioMatched,
      documentObserved: har.log.entries.some(entry => entry._resourceType?.toLowerCase() === 'document'),
      failedResponsePreserved: har.log.entries.some(entry => entry.response?.status === 503),
      secretsRemoved: !JSON.stringify(evidence).includes(fixtureSecret), ownedBrowserClosed: closed, temporaryFilesRemoved: cleaned },
    captureGaps: { redirectResponseMissing: !har.log.entries.some(entry => entry.response?.status === 302), initiatorMissing: true },
    steps, serverRequestCount: received.length, evidence,
    selfShapeComparison: compareContractShapes(evidence, evidence),
    limitations: ['no_production_site_replay', 'initiator_stacks_not_exported', 'har_redirect_ancestry_not_attested', 'same_shape_does_not_prove_same_values'] };
  await output.writeFile(JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ schema: result.schema, assertions: result.assertions, capturedEntries: evidence.coverage.entries, steps: steps.length }));
  if (!Object.values(result.assertions).every(Boolean)) process.exitCode = 2;
} catch (error) {
  const cleanupSucceeded = await cleanup().catch(() => false); server = null;
  const result = { schema: 'web-api-browser-fixture-v1', checkedAt: new Date().toISOString(), scope: 'isolated_local_synthetic_fixture',
    ok: false, agentBrowserVersion: measuredVersion, code: /^[A-Z][A-Z0-9_]+$/.test(error.message ?? '') ? error.message : 'FIXTURE_FAILED',
    completedSteps: steps, commands, cleanupSucceeded, productionSitesTested: 0 };
  if (output) await output.writeFile(JSON.stringify(result, null, 2) + '\n');
  console.error(JSON.stringify(result)); process.exitCode = 1;
} finally { await output?.close(); }
