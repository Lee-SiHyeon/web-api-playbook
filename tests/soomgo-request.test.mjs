import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  createSoomgoRequestClient,
  dispatchSoomgoRequest,
  prepareSoomgoRequest,
  SOOMGO_REQUEST_CAPABILITIES,
} from '../lib/freelance/soomgo-request.mjs';
import { runFreelanceCommand } from '../scripts/freelance.mjs';

const now = () => Date.parse('2026-10-27T03:00:00.000Z');
const readJson = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});
const formFixture = async () => (await readJson('./fixtures/freelance/soomgo-request-form-20261027.json')).form;
const formResult = form => ({
  schemaVersion: 1, service: 'soomgo', operation: 'service_request_form',
  observedAt: '2026-10-27T03:00:00.000Z', status: 'read_only_schema', form,
  requests: [],
});
const addressOptionsResult = items => ({
  schemaVersion: 1,
  service: 'soomgo',
  operation: 'address_options',
  depth: 3,
  items,
  coverage: { returned: items.length, sourceTotal: null, complete: false, next: null },
  requests: [{ method: 'GET', origin: 'https://api.soomgo.com', path: '/v1/requests/forms/addresses',
    httpStatus: 200, browserUsed: false, credentialsUsed: false, cookiesSent: false, queryFields: ['depth'] }],
});

test('GET service form uses a catalog-selected slug, fixed origin, exact encoded route and no credentials', async () => {
  const fixture = await readJson('./fixtures/freelance/soomgo-request-form-20261027.json');
  let calls = 0;
  const client = createSoomgoRequestClient({ now, fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url.origin, 'https://api.soomgo.com');
    assert.equal(url.pathname,
      '/v2/services/%EA%B0%80%EC%A0%95-%EC%9D%B4%EC%82%AC-%ED%88%AC%EB%A3%B8-%EC%93%B0%EB%A6%AC%EB%A3%B8/form');
    assert.deepEqual([...url.searchParams], []);
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    assert.equal(new Headers(init.headers).get('cookie'), null);
    assert.equal(new Headers(init.headers).get('authorization'), null);
    return jsonResponse({ code: 0, reason: '', request: '', response: fixture.form });
  } });

  const result = await client.getServiceForm({ service: {
    id: 729, slug: '가정-이사-투룸-쓰리룸', name: '가정이사(투룸 이상)',
  } });
  assert.equal(calls, 1);
  assert.equal(result.operation, 'service_request_form');
  assert.equal(result.form.id, '67bc352e8980cc4b1952edfe');
  assert.equal(result.form.service.id, 729);
  assert.equal(result.form.items.length, 13);
  assert.equal(result.requests[0].httpStatus, 200);
  assert.equal(result.requests[0].anonymous, true);
  assert.equal(result.requests[0].browserUsed, false);
  assert.equal(result.requests[0].cookiesSent, false);
  assert.equal(result.dispatch.supported, false);
  assert.equal(result.dispatch.requestSent, false);
});

test('service route is constructed only from an explicit catalog service record and response identity must match', async () => {
  let calls = 0;
  const client = createSoomgoRequestClient({ fetchImpl: async () => { calls++; return jsonResponse({}); } });
  await assert.rejects(client.getServiceForm({ service: { id: 729, slug: '../requests', name: 'x' } }),
    { code: 'SOOMGO_REQUEST_SERVICE_INVALID' });
  await assert.rejects(client.getServiceForm({ service: { id: 729, slug: 'known-service', name: 'Known' } }),
    { code: 'SOOMGO_REQUEST_FORM_SCHEMA_INVALID' });
  assert.equal(calls, 1);
  const fixture = await formFixture();
  fixture.service.id = 730;
  const mismatched = createSoomgoRequestClient({ fetchImpl: async () => jsonResponse({
    code: 0, response: fixture,
  }) });
  await assert.rejects(mismatched.getServiceForm({ service: { id: 729, slug: 'known-service', name: 'Known' } }),
    { code: 'SOOMGO_REQUEST_FORM_IDENTITY_OR_SCHEMA_INVALID' });
});

test('form parser preserves item and choice IDs, types, validation, extras and missing conditional mapping', async () => {
  const fixture = await formFixture();
  const client = createSoomgoRequestClient({ fetchImpl: async () => jsonResponse({ code: 0, response: fixture }) });
  const result = await client.getServiceForm({ service: {
    id: 729, slug: '가정-이사-투룸-쓰리룸', name: '가정이사(투룸 이상)',
  } });
  const first = result.form.items[0];
  assert.deepEqual({ id: first.id, type: first.type, typeName: first.typeName,
    required: first.required, instantMatch: first.instantMatch },
  { id: 4, type: 1, typeName: 'checkbox', required: true, instantMatch: true });
  assert.deepEqual(first.answerSchema.map(option => [option.id, option.text]), [
    [1, '포장이사'], [2, '반포장이사'], [3, '일반이사'], [4, '보관이사'],
  ]);
  const date = result.form.items.find(item => item.id === 5);
  assert.deepEqual(JSON.parse(JSON.stringify(date.answerSchema[0].validation)),
    { input: 'datetime', rangeFromToday: [0, 365] });
  const extra = result.form.items.find(item => item.id === 9).answerSchema.find(option => option.id === 11);
  assert.deepEqual(JSON.parse(JSON.stringify(extra.extra)), { type: 1,
    placeholder: 'ex. 청소기, 공기청정기, 스타일러', validation: { input: 'string', maxLength: 255 } });
  assert.equal(result.form.items.every(item => item.conditionalState === 'not_exposed'), true);
  assert.equal(result.conditionalCoverage.complete, false);
});

test('address option read follows the exact observed source route and never marks an unknown total complete', async () => {
  const fixture = await readJson('./fixtures/freelance/soomgo-addresses-area3-first-record.json');
  let calls = 0;
  const client = createSoomgoRequestClient({ now, fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url.origin, 'https://api.soomgo.com');
    assert.equal(url.pathname, '/v1/requests/forms/addresses');
    assert.deepEqual([...url.searchParams], [['depth', 'area3']]);
    assert.equal(init.method, 'GET');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'manual');
    assert.equal(new Headers(init.headers).get('cookie'), null);
    assert.equal(new Headers(init.headers).get('authorization'), null);
    return jsonResponse({ code: 0, reason: '', request: '', response: { addresses: fixture.items } });
  } });
  const result = await client.listAddressOptions();
  assert.equal(calls, 1);
  assert.equal(result.operation, 'address_options');
  assert.equal(result.items[0].addressRowid, 3);
  assert.deepEqual([result.items[0].addr1, result.items[0].addr2, result.items[0].addr3], ['서울', '강남구', '개포1동']);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.sourceTotal, null);
  assert.equal(result.requests[0].queryFields.includes('depth'), true);
});

test('service request preparation returns only a prepared-only state for an empty real form', async () => {
  const form = await formFixture();
  const result = prepareSoomgoRequest(formResult(form), { now });
  assert.equal(result.status, 'prepared_only');
  assert.equal(result.validation.payloadComplete, false);
  assert.deepEqual(result.validation.missingRequiredItemIds, [4, 5, 6, 7, 19, 12, 13, 15]);
  assert.deepEqual(result.validation.unresolvedConditionalItemIds, form.items.map(item => item.id));
  assert.equal(result.gates.authentication, 'not_attempted');
  assert.equal(result.gates.termsConsent, 'not_confirmed');
  assert.equal(result.gates.dispatchSupported, false);
  assert.equal(result.gates.requestSent, false);
  assert.equal(result.gates.externallySubmitted, false);
  assert.equal(result.requests.length, 0);
});

test('fully answered service-form data can be complete while submission stays unavailable', () => {
  const form = {
    id: 'fixture-form-1', name: 'Basic Request', serviceId: 10, description: '',
    service: { id: 10, slug: 'fixture-service', name: 'Fixture' }, updatedAt: '2026-10-27T00:00:00',
    items: [
      { id: 1, type: 1, subType: 1, name: 'checkbox', required: true, instantMatch: true,
        question: 'Choose one', description: '', conditional: null,
        answerSchema: [{ id: 2, text: 'A', validation: null }, { id: 8, text: 'B', validation: null }] },
      { id: 2, type: 3, name: 'text', required: true, instantMatch: false,
        question: 'Describe it', description: '', conditional: null,
        answerSchema: [{ id: 1, placeholder: 'Description', validation: { input: 'string', maxLength: 20 } }] },
      { id: 3, type: 5, name: 'datepicker', required: true, instantMatch: false,
        question: 'Date', description: '', conditional: null,
        answerSchema: [{ id: 1, text: 'Date', validation: { input: 'datetime', rangeFromToday: [0, 365] } }] },
    ],
  };
  const result = prepareSoomgoRequest(formResult(form), { now, answersByItemId: {
    '1': { answerIds: [8] }, '2': { value: 'A desk' }, '3': { value: '2026-10-30' },
  } });
  assert.equal(result.validation.payloadComplete, true);
  assert.equal(result.validation.scope, 'service_form_answers_only');
  assert.equal(result.validation.requestReady, false);
  assert.equal(result.validation.uiStateMappingComplete, false);
  assert.deepEqual(result.validation.unresolvedUiStateMappingItemIds, [2]);
  assert.equal(result.validation.wireMappingComplete, false);
  assert.equal(result.validation.wireMappingVerified, false);
  assert.deepEqual(result.validation.unresolvedWireMappingItemIds, [1, 2, 3]);
  assert.deepEqual(result.validation.missingRequiredItemIds, []);
  assert.deepEqual(result.validation.invalidItemIds, []);
  assert.deepEqual(result.validation.unresolvedConditionalItemIds, []);
  assert.deepEqual(result.preparedAnswers.filter(item => item.answers?.length)
    .map(item => [item.itemId, item.answers]), [
    [1, [{ answerId: 8, value: 'B', extraValue: '' }]],
    [3, [{ answerId: 1, value: '2026-10-30', extraValue: '' }]],
  ]);
  assert.deepEqual(result.preparedAnswers.find(item => item.itemId === 2), {
    itemId: 2, type: 'text_field', value: 'A desk', uiStateMapping: 'not_observed',
  });
  assert.equal(result.gates.dispatchSupported, false);
  assert.equal(result.gates.externallySubmitted, false);
  assert.equal(result.status, 'prepared_only');
});

test('real form retains location choices only when selected address exists in a first-party address snapshot', async () => {
  const form = await formFixture();
  const addressFixture = await readJson('./fixtures/freelance/soomgo-addresses-area3-first-record.json');
  const addressOptions = addressOptionsResult(addressFixture.items);
  const answersByItemId = {
    4: { answerIds: [1] },
    5: { value: '2026-10-30' },
    6: { addressRowid: 3 },
    7: { value: '10층' },
    19: { value: '15평 / 2명' },
    8: { answerIds: [1] },
    9: { answerIds: [1] },
    10: { answerIds: [1] },
    12: { addressRowid: 3 },
    13: { value: '15층' },
    14: { answerIds: [2] },
    15: { answerIds: [1] },
  };
  const result = prepareSoomgoRequest(formResult(form), { now, answersByItemId, addressOptions });
  const addressAnswer = result.preparedAnswers.find(item => item.itemId === 6);
  assert.equal(addressAnswer.address.addressRowid, 3);
  assert.deepEqual(result.preparedAnswers.find(item => item.itemId === 6).address.values,
    { addr1: '서울', addr2: '강남구', addr3: '개포1동' });
  assert.equal(addressAnswer.address.uiStateMapping, 'observed');
  assert.deepEqual(addressAnswer.answers, [
    { answerId: 1, value: '서울', extraValue: '' },
    { answerId: 2, value: '강남구', extraValue: '' },
    { answerId: 3, value: '개포1동', extraValue: '' },
  ]);
  assert.deepEqual(result.validation.missingRequiredItemIds, []);
  assert.deepEqual(result.validation.unsupportedItemIds, []);
  assert.equal(result.validation.payloadComplete, false,
    'the live form omits conditional and address-answer mapping even after required question answers were entered');
  assert.deepEqual(result.validation.unresolvedConditionalItemIds, form.items.map(item => item.id));
  assert.deepEqual(result.validation.unresolvedRuleItemIds.filter(id => id === 6 || id === 12), []);
  assert.equal(result.preparedAnswers.find(item => item.itemId === 4).answers[0].value, '포장이사');
  assert.equal(result.preparedAnswers.find(item => item.itemId === 4).answers[0].extraValue, '');
  assert.equal(result.preparedAnswers.find(item => item.itemId === 5).answers[0].extraValue, '');
  assert.equal(result.validation.uiStateMappingComplete, false);
  assert.deepEqual(result.validation.unresolvedUiStateMappingItemIds, [7, 19, 8, 13, 14, 15]);
  assert.equal(result.validation.wireMappingComplete, false);
  assert.equal(result.validation.wireMappingVerified, false);
  assert.deepEqual(result.validation.unresolvedWireMappingItemIds, [4, 5, 6, 7, 19, 8, 9, 10, 12, 13, 14, 15]);
});

test('date answer must use the observed plain YYYY-MM-DD value', () => {
  const form = {
    id: 'fixture-date', name: 'Date', serviceId: 14, description: '',
    service: { id: 14, slug: 'fixture-date', name: 'Date' }, updatedAt: '',
    items: [{ id: 1, type: 5, name: 'datepicker', required: true, instantMatch: false,
      question: 'Select date', description: '', conditional: null,
      answerSchema: [{ id: 1, validation: { input: 'datetime', rangeFromToday: [0, 365] } }],
    }],
  };
  assert.throws(() => prepareSoomgoRequest(formResult(form), { now,
    answersByItemId: { 1: { value: '2026-10-30T00:00:00+09:00' } },
  }), { code: 'SOOMGO_REQUEST_ANSWER_INVALID' });
  assert.throws(() => prepareSoomgoRequest(formResult(form), { now,
    answersByItemId: { 1: { value: '2026-10-30Tbad' } },
  }), { code: 'SOOMGO_REQUEST_ANSWER_INVALID' });
});

test('two-level address fields remain blocked until their answer schema is captured', async () => {
  const form = {
    id: 'fixture-address2', name: 'Address2', serviceId: 15, description: '',
    service: { id: 15, slug: 'fixture-address2', name: 'Address2' }, updatedAt: '',
    items: [{ id: 1, type: 7, name: 'address2', required: true, instantMatch: false,
      question: 'Select region', description: '', conditional: null,
      answerSchema: [{ id: 1 }, { id: 2 }],
    }],
  };
  const addressFixture = await readJson('./fixtures/freelance/soomgo-addresses-area3-first-record.json');
  const result = prepareSoomgoRequest(formResult(form), { now, addressOptions: addressOptionsResult(addressFixture.items),
    answersByItemId: { 1: { addr1: '서울', addr2: '강남구' } },
  });
  assert.equal(result.validation.payloadComplete, false);
  assert.deepEqual(result.validation.unsupportedItemIds, [1]);
  assert.equal(result.preparedAnswers.some(item => item.itemId === 1), false);
});

test('required address input without verified options remains incomplete and cannot invent region ids', async () => {
  const form = await formFixture();
  const result = prepareSoomgoRequest(formResult(form), { now, answersByItemId: {
    6: { addressRowid: 3 },
  } });
  assert.equal(result.validation.payloadComplete, false);
  assert.deepEqual(result.validation.invalidItemIds, [6]);
  assert.equal(result.preparedAnswers.some(item => item.itemId === 6), false);
});

test('address selections must match an exact row in the first-party catalog', async () => {
  const form = await formFixture();
  const addressFixture = await readJson('./fixtures/freelance/soomgo-addresses-area3-first-record.json');
  const addressOptions = addressOptionsResult(addressFixture.items);
  assert.throws(() => prepareSoomgoRequest(formResult(form), { now, addressOptions,
    answersByItemId: { 6: { addr1: 'Seoul', addr2: 'Gangnam', addr3: 'Invented Dong' } },
  }), { code: 'SOOMGO_REQUEST_ADDRESS_NOT_IN_CATALOG' });
});

test('extra answer requirements remain unresolved rather than silently dropping a selected follow-up', () => {
  const form = {
    id: 'fixture-form-extra', name: 'Extra', serviceId: 12, description: '',
    service: { id: 12, slug: 'fixture-extra', name: 'Fixture' }, updatedAt: '',
    items: [{ id: 1, type: 1, name: 'checkbox', required: true, instantMatch: false,
      question: 'Pick', description: '', conditional: null,
      answerSchema: [
        { id: 1, text: 'Other', validation: null,
          extra: { type: 1, placeholder: 'Describe', validation: { input: 'string', maxLength: 8 } } },
      ],
    }],
  };
  const missingExtra = prepareSoomgoRequest(formResult(form), { now, answersByItemId: { 1: { answerIds: [1] } } });
  assert.equal(missingExtra.validation.payloadComplete, false);
  assert.deepEqual(missingExtra.validation.unresolvedRuleItemIds, [1]);
  assert.throws(() => prepareSoomgoRequest(formResult(form), { now,
    answersByItemId: { 1: { answerIds: [1], extraTextByAnswerId: { 1: '123456789' } } },
  }), { code: 'SOOMGO_REQUEST_ANSWER_INVALID' });
});

test('unknown question, unsupported file answers, and duplicate choices are not treated as complete', () => {
  const form = {
    id: 'fixture-form-unknown', name: 'Unknown', serviceId: 13, description: '',
    service: { id: 13, slug: 'fixture-unknown', name: 'Fixture' }, updatedAt: '',
    items: [
      { id: 1, type: 1, name: 'checkbox', required: true, instantMatch: false,
        question: 'Pick', description: '', conditional: null, answerSchema: [{ id: 1, text: 'A' }] },
      { id: 2, type: 9, name: 'image', required: true, instantMatch: false,
        question: 'Attach', description: '', conditional: null, answerSchema: [{ id: 1 }] },
      { id: 3, type: 77, name: 'unknown', required: false, instantMatch: false,
        question: 'Unknown', description: '', conditional: null, answerSchema: [{ id: 1 }] },
    ],
  };
  const result = prepareSoomgoRequest(formResult(form), { now,
    answersByItemId: { 1: { answerIds: [1, 1] }, 2: { imageId: 'unverified-upload' } },
  });
  assert.equal(result.validation.payloadComplete, false);
  assert.deepEqual(result.validation.invalidItemIds, [1, 2]);
  assert.deepEqual(result.validation.missingRequiredItemIds, []);
});

test('dispatch helper rejects before any transport and the client exposes no submit method', async () => {
  let calls = 0;
  const client = createSoomgoRequestClient({ fetchImpl: async () => { calls++; return jsonResponse({}); } });
  assert.equal(typeof client.getServiceForm, 'function');
  assert.equal(typeof client.listAddressOptions, 'function');
  assert.equal(client.submitRequest, undefined);
  assert.throws(() => dispatchSoomgoRequest(), { code: 'SOOMGO_REQUEST_SUBMIT_UNAVAILABLE' });
  assert.equal(SOOMGO_REQUEST_CAPABILITIES.requestDispatch, 'not_implemented');
  assert.equal(calls, 0);
});

test('6045-row address catalog flows from CLI GET to local preparation without a 128-KiB catalog cap', async t => {
  const form = await formFixture();
  const formCapture = await readJson('./fixtures/freelance/soomgo-request-form-20261027.json');
  const addressRows = Array.from({ length: 6045 }, (_, index) => ({
    addressRowid: index + 1,
    addr1: '서울',
    addr2: '강남구',
    addr3: `Fixture동${index + 1}`,
    address: `서울 강남구 Fixture동${index + 1}`,
  }));
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ pathname: url.pathname, query: [...url.searchParams], method: init.method });
    if (url.pathname === '/v2/services/%EA%B0%80%EC%A0%95-%EC%9D%B4%EC%82%AC-%ED%88%AC%EB%A3%B8-%EC%93%B0%EB%A6%AC%EB%A3%B8/form') {
      return jsonResponse({ code: 0, reason: '', request: '', response: form });
    }
    if (url.pathname === '/v1/requests/forms/addresses') {
      return jsonResponse({ code: 0, reason: '', request: '', response: { addresses: addressRows } });
    }
    assert.fail(`unobserved route: ${url.pathname}`);
  };
  const scratchRoot = '/home/worker/.nad-scratch/tmp';
  await mkdir(scratchRoot, { recursive: true });
  const scratch = await mkdtemp(path.join(scratchRoot, 'soomgo-address-cli-test-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const formPath = path.join(scratch, 'form.json');
  const answersPath = path.join(scratch, 'answers.json');
  const addressesPath = path.join(scratch, 'addresses.json');
  const formFromCli = await runFreelanceCommand([
    'soomgo', 'request-form', '--service-id=729', '--service-slug=가정-이사-투룸-쓰리룸', '--service-name=가정이사(투룸 이상)',
  ], { fetchImpl, now });
  const addressOptions = await runFreelanceCommand(['soomgo', 'address-options', '--depth=3'], { fetchImpl, now });
  assert.equal(addressOptions.result.items.length, 6045);
  assert.equal(addressOptions.result.coverage.complete, false);
  await writeFile(formPath, JSON.stringify(formFromCli.result));
  await writeFile(answersPath, JSON.stringify({ 6: { addressRowid: 6045 } }));
  const addressJson = JSON.stringify(addressOptions.result);
  await writeFile(addressesPath, addressJson);
  const addressBytes = (await stat(addressesPath)).size;
  assert.ok(addressBytes > 128 * 1024);
  assert.ok(addressBytes < 2 * 1024 * 1024);

  const prepared = await runFreelanceCommand([
    'soomgo', 'request-prepare', `--form=${formPath}`, `--answers=${answersPath}`, `--addresses=${addressesPath}`,
  ], { fetchImpl, now });
  assert.equal(prepared.result.operation, 'prepare_request');
  assert.equal(prepared.result.status, 'prepared_only');
  assert.equal(prepared.result.networkUsed, false);
  assert.equal(prepared.result.writesSubmitted, 0);
  assert.equal(prepared.result.validation.payloadComplete, false,
    'conditional branches and address answer-ID serialization remain unresolved');
  assert.equal(prepared.result.preparedAnswers.find(item => item.itemId === 6).address.addressRowid, 6045);
  assert.equal(prepared.result.gates.externallySubmitted, false);
  assert.deepEqual(calls, [
    { pathname: '/v2/services/%EA%B0%80%EC%A0%95-%EC%9D%B4%EC%82%AC-%ED%88%AC%EB%A3%B8-%EC%93%B0%EB%A6%AC%EB%A3%B8/form', query: [], method: 'GET' },
    { pathname: '/v1/requests/forms/addresses', query: [['depth', 'area3']], method: 'GET' },
  ]);
});

test('CLI rejects an address catalog over 2 MiB while direct answers stay bounded at 128 KiB', async t => {
  const formCapture = await readJson('./fixtures/freelance/soomgo-request-form-20261027.json');
  const scratchRoot = '/home/worker/.nad-scratch/tmp';
  await mkdir(scratchRoot, { recursive: true });
  const scratch = await mkdtemp(path.join(scratchRoot, 'soomgo-request-size-test-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const formPath = path.join(scratch, 'form.json');
  const oversizeAddressPath = path.join(scratch, 'oversize-addresses.json');
  const oversizeAnswersPath = path.join(scratch, 'oversize-answers.json');
  await writeFile(formPath, JSON.stringify({ ...formResult(formCapture.form) }));
  await writeFile(oversizeAddressPath, 'x'.repeat(2 * 1024 * 1024 + 1));
  const oversizedAnswers = JSON.stringify({ 1: { value: 'x'.repeat(128 * 1024 + 1) } });
  assert.ok(Buffer.byteLength(oversizedAnswers) < 512 * 1024);
  await writeFile(oversizeAnswersPath, oversizedAnswers);
  await assert.rejects(runFreelanceCommand([
    'soomgo', 'request-prepare', `--form=${formPath}`, `--addresses=${oversizeAddressPath}`,
  ]), { code: 'SOOMGO_REQUEST_ADDRESSES_INPUT_INVALID' });
  await assert.rejects(runFreelanceCommand([
    'soomgo', 'request-prepare', `--form=${formPath}`, `--answers=${oversizeAnswersPath}`,
  ]), { code: 'SOOMGO_REQUEST_INPUT_TOO_LARGE' });

  const giantAnswer = { 1: { value: 'x'.repeat(128 * 1024 + 1) } };
  assert.throws(() => prepareSoomgoRequest(formResult({
    id: 'input-boundary', name: 'Boundary', serviceId: 1, service: { id: 1, slug: 'boundary', name: 'Boundary' },
    items: [{ id: 1, type: 3, name: 'text', required: true, instantMatch: false,
      question: 'text', conditional: null, answerSchema: [{ id: 1, validation: { maxLength: 200000 } }] }],
  }), { answersByItemId: giantAnswer }), { code: 'SOOMGO_REQUEST_INPUT_TOO_LARGE' });
});
