import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareOperations } from '../lib/prepare-operations.mjs';

const baseUrl = 'https://prepare.fixture.invalid/app/';
const origin = new URL(baseUrl).origin;
const cli = fileURLToPath(new URL('../scripts/prepare-operations.mjs', import.meta.url));
const hasGap = (result, code) => result.gaps.some(gap => gap.code === code);
function entry(target = '/api/catalog?sort=fixture', { method = 'GET', postData, response = true, text = '{"ok":true}' } = {}) {
  return {
    startedDateTime: '2026-01-01T00:00:00.000Z',
    request: { method, url: new URL(target, baseUrl).href, headers: [], ...(postData === undefined ? {} : { postData }) },
    ...(response ? { response: { status: 200, content: { mimeType: 'application/json', text } } } : {}),
  };
}
const har = (...entries) => ({ log: { entries } });
function frozen(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'playbook-prepare-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
function run(args, cwd) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 10000, windowsHide: true });
}

test('merges exact HAR, HTML and bundle targets while preserving evidence and honest states', () => {
  const result = prepareOperations({
    har: har(entry()), html: '<a href="/api/catalog?sort=fixture">Read</a>',
    bundles: [{ name: 'app.js', source: 'fetch("/api/catalog?sort=fixture");' }], baseUrl, intent: 'List catalog',
  });
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.intent, 'List catalog');
  assert.equal(result.candidates.length, 1);
  const candidate = result.candidates[0];
  assert.equal(candidate.state, 'request_observed');
  assert.equal(candidate.requestObserved, true);
  assert.equal(candidate.replayVerified, false);
  assert.equal(candidate.valuesRecorded, false);
  assert.equal(candidate.identityComplete, true);
  assert.deepEqual(candidate.queryFields, ['sort']);
  assert.deepEqual(candidate.kinds, ['fetch_literal', 'har_request', 'navigation_link']);
  assert.deepEqual(candidate.provenance.map(item => item.source).sort(), ['HAR', 'HTML', 'source']);
  assert.equal(candidate.observations[0].sourceEntry, 1);
  assert.equal(candidate.observations[0].businessOutcome, 'unclassified');
  assert.equal(candidate.observations[0].responseSchema.properties.ok.type, 'boolean');
  assert.equal(result.coverage.requestObserved, 1);
  assert.equal(result.coverage.requestsExecuted, 0);
  assert.equal(result.coverage.liveNetworkUsed, false);
  assert.equal(result.coverage.replayVerified, 0);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.totalCapabilities, null);
  assert.deepEqual(result.coverage.bySource, { HAR: 1, HTML: 1, source: 1 });
  assert.ok(hasGap(result, 'offline_preparation_not_replay_verification'));
  assert.equal(hasGap(result, 'normalized_selector_collision'), false);
  assert.equal(JSON.stringify(result).includes('sort=fixture'), false);
});

test('HTML and source-only discoveries remain candidates, including mutation-shaped literals', () => {
  const result = prepareOperations({ html: '<a href="/api/read">read</a><script src="/assets/main.js"></script>',
    bundles: ['fetch("/api/change", {method:"POST", body:payload}); axios.get("/api/list");'], baseUrl });
  assert.equal(result.candidates.length, 4);
  for (const candidate of result.candidates) {
    assert.equal(candidate.state, 'candidate');
    assert.equal(candidate.requestObserved, false);
    assert.equal(candidate.replayVerified, false);
    assert.deepEqual(candidate.observations, []);
  }
  const mutation = result.candidates.find(candidate => candidate.path === '/api/change');
  assert.equal(mutation.method, 'POST');
  assert.equal(mutation.mutationCandidate, true);
  assert.equal(mutation.identityComplete, false);
  assert.deepEqual(mutation.bodyFields, []);
  assert.equal(mutation.encoding, null);
  assert.ok(hasGap(result, 'bundle_request_details_unknown'));
  assert.equal(result.coverage.requestObserved, 0);
});

test('normalized selector, path, cursor and body collisions stay separate with observation indices', () => {
  const result = prepareOperations({ har: har(
    entry('/api/users/100?action=first&cursor=cursorA'),
    entry('/api/users/200?action=other&cursor=cursorB'),
    entry('/api/rpc', { method: 'POST', postData: { mimeType: 'application/json', text: '{"action":"first","payload":"aaaa"}' } }),
    entry('/api/rpc', { method: 'POST', postData: { mimeType: 'application/json', text: '{"action":"other","payload":"bbbb"}' } }),
  ) });
  assert.equal(result.candidates.length, 4);
  const collisions = result.gaps.filter(gap => gap.code === 'normalized_selector_collision');
  assert.equal(collisions.length, 2);
  assert.ok(collisions.every(gap => gap.candidateIds.length === 2));
  assert.deepEqual(result.candidates.flatMap(candidate => candidate.observations.map(item => item.sourceEntry)).sort(), [1, 2, 3, 4]);
  assert.ok(result.candidates.every(candidate => candidate.state === 'request_observed'));
  assert.ok(hasGap(result, 'selector_values_omitted'));
  const json = JSON.stringify(result);
  for (const value of ['first', 'other', 'cursorA', 'cursorB', 'aaaa', 'bbbb', '/100', '/200']) assert.equal(json.includes(value), false, value);
  for (const observed of ['first', 'other', 'cursorA', 'cursorB', '{"action":"first","payload":"aaaa"}']) {
    assert.equal(json.includes(createHash('sha256').update(observed).digest('hex')), false);
  }
});

test('public IDs and output do not depend on observed request/response values or body hashes', () => {
  const first = prepareOperations({ har: har(entry('/api/rpc?action=alpha', { method: 'POST',
    postData: { mimeType: 'application/json', text: '{"name":"alice"}' }, text: '{"name":"carol"}' })) });
  const second = prepareOperations({ har: har(entry('/api/rpc?action=bravo', { method: 'POST',
    postData: { mimeType: 'application/json', text: '{"name":"david"}' }, text: '{"name":"ellen"}' })) });
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first).includes('Sha256'), false);
  assert.equal(JSON.stringify(first).includes('sha256'), false);
});

test('repeated exact requests merge, query-key ordering is canonical, repeated-value ordering is not', () => {
  const result = prepareOperations({ har: har(entry('/api/read?a=one&b=two'), entry('/api/read?b=two&a=one'),
    entry('/api/read?a=one&a=two'), entry('/api/read?a=two&a=one')) });
  assert.equal(result.candidates.length, 3);
  assert.deepEqual(result.candidates.find(candidate => candidate.queryFields.length === 2).observations.map(item => item.sourceEntry), [1, 2]);
  assert.equal(result.gaps.filter(gap => gap.code === 'normalized_selector_collision').length, 1);
});

test('HTML normalization collisions preserve every occurrence beyond discovery evidence display limits', () => {
  const html = Array.from({ length: 25 }, (_, index) => `<a href="/api/users/${100 + index}?action=read">read</a>`).join('');
  const result = prepareOperations({ html, baseUrl });
  assert.equal(result.candidates.length, 25);
  assert.equal(result.candidates.reduce((sum, candidate) => sum + candidate.provenance.length, 0), 25);
  const collision = result.gaps.find(gap => gap.code === 'normalized_selector_collision');
  assert.equal(collision.candidateIds.length, 25);
  assert.ok(result.candidates.every(candidate => candidate.path === '/api/users/:id'));
});

test('HTML base elements, templates, invalid links and absolute external links retain provenance', () => {
  const result = prepareOperations({ baseUrl,
    html: '<base href="/nested/"><template><a href="inside">in</a></template><a href="relative">r</a>'
      + '<a href="javascript:void(0)">invalid</a><a href="https://outside.fixture.invalid/read">outside</a>',
  });
  assert.ok(result.candidates.some(candidate => candidate.path === '/nested/inside'));
  assert.ok(result.candidates.some(candidate => candidate.path === '/nested/relative'));
  const outside = result.candidates.find(candidate => candidate.origin === 'https://outside.fixture.invalid');
  assert.equal(outside.provenance[0].sameOrigin, false);
  assert.ok(hasGap(result, 'html_target_unresolved'));
  assert.ok(result.candidates.every(candidate => candidate.state === 'candidate'));
});

test('profile declarations report implemented vs discovered without promoting or filling defaults', () => {
  const profile = frozen({ schemaVersion: 2, serviceId: 'fixture', operations: {
    catalog: { origin, method: 'GET', path: '/api/catalog', inputs: { query: { sort: { type: 'string', default: 'DO_NOT_INVENT' } } } },
    unseen: { origin, method: 'POST', path: '/api/unseen', bodyFields: ['name'] },
    malformed: { description: 'missing request metadata' },
  } });
  const result = prepareOperations({ har: har(entry(), entry('/api/unimplemented')), profile });
  assert.equal(result.coverage.implementedCount, 3);
  const catalog = result.coverage.implemented.find(item => item.operationId === 'catalog');
  assert.equal(catalog.state, 'declared_in_profile');
  assert.equal(catalog.match, 'exact_shape');
  assert.equal(catalog.candidateIds.length, 1);
  assert.equal(result.coverage.implemented.find(item => item.operationId === 'unseen').match, 'not_discovered');
  assert.equal(result.coverage.implemented.find(item => item.operationId === 'malformed').match, 'metadata_incomplete');
  assert.equal(result.coverage.discoveredOnlyCount, 1);
  assert.ok(hasGap(result, 'discovered_capability_not_declared'));
  assert.ok(hasGap(result, 'profile_operation_not_discovered'));
  assert.ok(hasGap(result, 'profile_operation_metadata_incomplete'));
  assert.ok(hasGap(result, 'profile_implementation_not_verified'));
  assert.equal(JSON.stringify(result).includes('DO_NOT_INVENT'), false);
  assert.ok(result.candidates.every(candidate => candidate.state === 'request_observed' && !candidate.replayVerified));
});

test('profile parameter templates and selector collisions are review-only matches', () => {
  const result = prepareOperations({ har: har(entry('/api/users/100?action=first'), entry('/api/users/200?action=other')),
    profile: { operations: { read: { origin, method: 'GET', path: '/api/users/{id}',
      inputs: { path: { id: { type: 'integer', required: true } }, query: { action: { type: 'string' } } } } } } });
  assert.equal(result.coverage.implemented[0].match, 'normalized_only');
  assert.equal(result.coverage.implemented[0].candidateIds.length, 2);
  assert.ok(hasGap(result, 'profile_match_requires_review'));
  assert.ok(result.candidates.every(candidate => !candidate.replayVerified));
});

test('optional typed fields are review-only matches and declared encodings do not silently match', () => {
  const result = prepareOperations({ har: har(entry('/api/read?page=fixture')), profile: { schemaVersion: 2, operations: {
    typed: { origin, method: 'GET', path: '/api/read', inputs: { query: {
      page: { type: 'string', required: true }, size: { type: 'integer', default: 100 },
    } } },
    otherEncoding: { origin, method: 'GET', path: '/api/read', queryFields: ['page'], encoding: 'application/json' },
  } } });
  assert.equal(result.coverage.implemented.find(item => item.operationId === 'typed').match, 'normalized_only');
  assert.equal(result.coverage.implemented.find(item => item.operationId === 'otherEncoding').match, 'not_discovered');
  assert.deepEqual(result.candidates[0].queryFields, ['page']);
  assert.ok(hasGap(result, 'profile_match_requires_review'));
});

test('requires an actual source, not intent, base URL or profile alone', () => {
  for (const input of [{}, { bundles: [] }, { intent: 'read', baseUrl, profile: { operations: {} } }]) {
    assert.throws(() => prepareOperations(input), { code: 'XHR_PREPARE_INPUT_REQUIRED' });
  }
  assert.throws(() => prepareOperations(null), { code: 'XHR_PREPARE_OPTIONS_INVALID' });
});

test('malformed source containers fail deterministically without executing source text', () => {
  const cases = [
    [{ har: null }, 'XHR_HAR_INVALID'], [{ har: { log: { entries: {} } } }, 'XHR_HAR_INVALID'],
    [{ html: 42 }, 'XHR_PREPARE_HTML_INVALID'], [{ html: '' }, 'XHR_PREPARE_HTML_INVALID'],
    [{ bundles: null }, 'XHR_PREPARE_BUNDLES_INVALID'], [{ bundles: [''] }, 'XHR_PREPARE_BUNDLE_INVALID'],
    [{ bundles: [{}] }, 'XHR_PREPARE_BUNDLE_INVALID'], [{ bundles: [{ name: 'bad', source: 42 }] }, 'XHR_PREPARE_BUNDLE_INVALID'],
    [{ html: '<p>x</p>', baseUrl: 'file:///tmp/source' }, 'XHR_PREPARE_BASE_URL_INVALID'],
    [{ har: har(), intent: {} }, 'XHR_PREPARE_INTENT_INVALID'],
    [{ har: har(), profile: { operations: [] } }, 'XHR_PREPARE_PROFILE_INVALID'],
  ];
  for (const [input, code] of cases) assert.throws(() => prepareOperations(input), { code });
});

test('valid but incomplete sources report gaps rather than fabricated scope or candidates', () => {
  const missingBase = prepareOperations({ html: '<a href="/api/read">read</a>', bundles: ['fetch("/api/read");'] });
  assert.deepEqual(missingBase.candidates, []);
  assert.equal(missingBase.stages.find(stage => stage.stage === 'html').status, 'blocked');
  assert.ok(hasGap(missingBase, 'base_url_required'));
  assert.ok(hasGap(missingBase, 'bundle_target_unresolved'));
  assert.ok(hasGap(missingBase, 'no_candidates_discovered'));
  const absolute = prepareOperations({ bundles: ['fetch("https://prepare.fixture.invalid/api/read");'] });
  assert.equal(absolute.candidates.length, 1);
  assert.equal(absolute.candidates[0].state, 'candidate');
  const emptyHar = prepareOperations({ har: har() });
  assert.deepEqual(emptyHar.candidates, []);
  assert.ok(hasGap(emptyHar, 'no_candidates_discovered'));
  const emptyHTML = prepareOperations({ html: '<p>nothing discoverable', baseUrl });
  assert.ok(hasGap(emptyHTML, 'no_candidates_in_source'));
});

test('malformed HAR entries and response schemas retain partial evidence without verification', () => {
  const result = prepareOperations({ har: har(null, { request: { url: 'data:text/plain,x' } },
    entry('/api/no-response', { response: false }), entry('/api/malformed-json', { text: 'not JSON' })) });
  assert.equal(result.candidates.length, 2);
  assert.equal(result.gaps.find(gap => gap.code === 'har_entries_skipped').count, 2);
  assert.ok(hasGap(result, 'response_body_unavailable'));
  assert.ok(hasGap(result, 'response_schema_unavailable'));
  assert.equal(result.stages.find(stage => stage.stage === 'har').status, 'partial');
  assert.ok(result.candidates.every(candidate => candidate.state === 'request_observed' && !candidate.replayVerified));
});

test('bundle comments, dynamic targets, unknown options and malformed literals are explicit limitations', () => {
  const result = prepareOperations({ baseUrl, bundles: [
    '// fetch("/api/commented");\n/* axios.get("/api/commented2"); */\n'
      + 'fetch(`/api/${identifier}`); fetch("/api/prefix/" + identifier); fetch(variable);'
      + 'xhr.open("GET", "/api/xhr-prefix/" + identifier); axios.get("/api/axios-prefix/" + identifier);'
      + 'fetch("/api/uncertain", options); fetch("/api/spread", {method:"POST", ...options});'
      + 'const endpoint="/api/literal"; fetch("/api/good");\n"unterminated',
  ] });
  assert.ok(hasGap(result, 'bundle_lexical_inspection_only'));
  assert.ok(hasGap(result, 'bundle_dynamic_target'));
  assert.ok(hasGap(result, 'bundle_unterminated_literal'));
  assert.ok(hasGap(result, 'bundle_request_details_unknown'));
  assert.equal(result.candidates.some(candidate => /commented|prefix/.test(candidate.path)), false);
  assert.equal(result.candidates.find(candidate => candidate.path === '/api/uncertain').method, 'UNKNOWN');
  assert.equal(result.candidates.find(candidate => candidate.path === '/api/spread').method, 'UNKNOWN');
  assert.equal(result.candidates.find(candidate => candidate.path === '/api/literal').method, 'UNKNOWN');
  assert.equal(result.candidates.find(candidate => candidate.path === '/api/good').method, 'GET');
  const comment = prepareOperations({ bundles: ['/* unfinished'] });
  assert.ok(hasGap(comment, 'bundle_unterminated_comment'));
});

test('literal escaped URLs, axios calls, XHR opens and fetch default options are candidates only', () => {
  const result = prepareOperations({ baseUrl, bundles: [
    String.raw`fetch("\u002fapi\x2fescaped"); axios.head("/api/head"); xhr.open("GET", "/api/xhr"); fetch("/api/default", {headers:{accept:"application/json"}});`,
  ] });
  assert.equal(result.candidates.length, 4);
  assert.equal(result.candidates.find(candidate => candidate.path === '/api/escaped').method, 'GET');
  assert.equal(result.candidates.find(candidate => candidate.path === '/api/head').method, 'HEAD');
  assert.equal(result.candidates.find(candidate => candidate.path === '/api/xhr').method, 'GET');
  assert.equal(result.candidates.find(candidate => candidate.path === '/api/default').method, 'GET');
  assert.ok(result.candidates.every(candidate => candidate.state === 'candidate'));
});

test('output is byte-stable, independent of wall clock, and accepts frozen nested inputs', () => {
  const input = frozen({ baseUrl, intent: 'Only metadata', har: har(entry(), entry()),
    html: '<a href="/api/catalog?sort=fixture">read</a>', bundles: [{ name: 'main.js', source: 'fetch("/api/catalog?sort=fixture");' }],
    profile: { operations: { read: { origin, method: 'GET', path: '/api/catalog', queryFields: ['sort'] } } } });
  const before = JSON.stringify(input);
  const first = prepareOperations(input);
  const serialized = JSON.stringify(first);
  assert.equal(JSON.stringify(prepareOperations(input)), serialized);
  assert.equal(JSON.stringify(input), before);
  assert.equal(serialized.includes('generatedAt'), false);
  first.candidates[0].queryFields.push('output-mutation');
  first.candidates[0].observations[0].responseSchema.properties.ok.type = 'changed';
  assert.equal(JSON.stringify(prepareOperations(input)), serialized);
});

test('preparation never calls HTTP, executes bundle code or mutates inputs', t => {
  const forbidden = () => assert.fail('offline preparation attempted external IO');
  t.mock.method(globalThis, 'fetch', forbidden);
  for (const module of [http, https]) for (const method of ['request', 'get']) t.mock.method(module, method, forbidden);
  for (const method of ['connect', 'createConnection']) t.mock.method(net, method, forbidden);
  const input = frozen({ baseUrl, har: har(entry('/api/change', { method: 'POST',
    postData: { mimeType: 'application/json', text: '{"name":"fixture-value"}' } })),
    bundles: ['globalThis.__PREPARE_SOURCE_EXECUTED = true; throw new Error("not executable"); fetch("/api/read");'] });
  const before = JSON.stringify(input);
  const result = prepareOperations(input);
  assert.equal(globalThis.__PREPARE_SOURCE_EXECUTED, undefined);
  assert.equal(JSON.stringify(input), before);
  assert.equal(result.coverage.requestsExecuted, 0);
  assert.equal(result.candidates.find(candidate => candidate.path === '/api/change').state, 'request_observed');
});

test('imports of prepare and its discovery dependency have no CLI, file or network effects', async t => {
  const dir = await directory(t);
  const modules = ['../lib/prepare-operations.mjs', '../scripts/discover-html.mjs', '../scripts/prepare-operations.mjs']
    .map(relative => pathToFileURL(fileURLToPath(new URL(relative, import.meta.url))).href);
  const source = `globalThis.fetch=()=>{throw new Error('network forbidden')}; ${modules.map(url => `await import(${JSON.stringify(url)});`).join(' ')}`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: dir, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.deepEqual(await fs.readdir(dir), []);
});

test('CLI reads local fixtures, supports repeated bundles and writes deterministic JSON only when requested', async t => {
  const dir = await directory(t);
  await fs.writeFile(path.join(dir, 'capture.har'), JSON.stringify(har(entry())));
  await fs.writeFile(path.join(dir, 'page.html'), '<a href="/api/catalog?sort=fixture">read</a>');
  await fs.writeFile(path.join(dir, 'one.js'), 'fetch("/api/catalog?sort=fixture");');
  await fs.writeFile(path.join(dir, 'two.js'), 'axios.get("/api/second");');
  await fs.writeFile(path.join(dir, 'profile.json'), JSON.stringify({ schemaVersion: 2,
    operations: { read: { origin, method: 'GET', path: '/api/catalog', inputs: { query: { sort: { type: 'string' } } } } } }));
  const args = ['--har=capture.har', '--html=page.html', '--bundle=one.js', '--bundle=two.js', `--base-url=${baseUrl}`,
    '--profile=profile.json', '--intent=read catalog'];
  const before = new Map(await Promise.all((await fs.readdir(dir)).map(async file => [file, await fs.readFile(path.join(dir, file))])));
  const first = run(args, dir);
  assert.equal(first.status, 0, first.stderr);
  const result = JSON.parse(first.stdout);
  assert.equal(result.intent, 'read catalog');
  assert.equal(result.candidates.length, 2);
  assert.equal(result.coverage.requestObserved, 1);
  assert.equal(result.coverage.implemented[0].state, 'declared_in_profile');
  assert.equal(run(args, dir).stdout, first.stdout);
  assert.deepEqual((await fs.readdir(dir)).sort(), [...before.keys()].sort());
  const written = run([...args, '--output=prepared.json'], dir);
  assert.equal(written.status, 0, written.stderr);
  assert.equal(await fs.readFile(path.join(dir, 'prepared.json'), 'utf8'), first.stdout);
  assert.equal(written.stdout, first.stdout);
  for (const [file, bytes] of before) assert.deepEqual(await fs.readFile(path.join(dir, file)), bytes);
  const secondWrite = run([...args, '--output=prepared.json'], dir);
  assert.equal(secondWrite.status, 1);
  assert.equal(JSON.parse(secondWrite.stderr).code, 'OUTPUT_RESERVATION_FAILED');
  assert.equal(await fs.readFile(path.join(dir, 'prepared.json'), 'utf8'), first.stdout);
});

test('CLI rejects invalid arguments and malformed/missing files without reserving an output', async t => {
  const dir = await directory(t);
  await fs.writeFile(path.join(dir, 'invalid.har'), 'not JSON');
  await fs.writeFile(path.join(dir, 'bad-shape.har'), '{"log":{}}');
  const cases = [
    [[], 'XHR_PREPARE_INPUT_REQUIRED'], [['--output=unused.json'], 'XHR_PREPARE_INPUT_REQUIRED'],
    [['--har=invalid.har', '--output=unused.json'], 'INPUT_JSON_INVALID'],
    [['--har=bad-shape.har'], 'XHR_HAR_INVALID'], [['--html=missing.html'], 'XHR_PREPARE_INPUT_READ_FAILED'],
    [['--har=missing.har'], 'INPUT_FILE_UNAVAILABLE'], [['--bundle='], 'XHR_PREPARE_ARGUMENTS_INVALID'],
    [['--network=true'], 'XHR_PREPARE_ARGUMENTS_INVALID'], [['--har=one', '--har=two'], 'XHR_PREPARE_ARGUMENTS_INVALID'],
  ];
  for (const [args, code] of cases) {
    const result = run(args, dir);
    assert.equal(result.status, 1, `${args}: ${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(result.stderr), { ok: false, code });
  }
  assert.deepEqual((await fs.readdir(dir)).sort(), ['bad-shape.har', 'invalid.har']);
});
