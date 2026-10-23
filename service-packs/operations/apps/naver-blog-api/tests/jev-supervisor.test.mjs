import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JevSupervisor, jevConfig, choiceValue } from '../workflows/affiliate-content-e2e/jev-supervisor.mjs';

const invalidConfidenceValues = JSON.parse(readFileSync(new URL('../research/evaluations/collector-classifier-regression-v1.json', import.meta.url), 'utf8')).cases.confidenceRejection.invalidValues;
const questions = {
  format: {
    type: 'choice',
    instructions: 'Which allowed editorial format best fits `topic`?',
    criteria: {
      comparison: 'Several comparable products and decision criteria are available',
      explainer: 'The main value is explaining one problem or rule',
      other: 'Neither option fits',
    },
  },
};

test('shadow mode records provider absence and keeps deterministic control flow', async () => {
  const supervisor = new JevSupervisor({
    config: jevConfig({}, { mode: 'shadow' }),
    fetchImpl: async () => assert.fail('No provider call is allowed without credentials'),
  });
  const receipt = await supervisor.evaluate({
    decisionId: 'format',
    state: { topic: 'test' },
    questions,
    fallbacks: { format: 'comparison' },
  });
  assert.equal(receipt.providerResult, 'provider_unavailable');
  assert.equal(choiceValue(receipt, 'format'), 'comparison');
  assert.equal(receipt.comparisons.format.adoptedSource, 'deterministic_fallback');
});

test('shadow mode never adopts a remote answer even when it is confident', async () => {
  const supervisor = new JevSupervisor({
    config: jevConfig({}, {
      mode: 'shadow', provider: 'custom', customEndpoint: 'https://fixture.test', customKey: 'fixture', confidenceFloor: 0.7,
    }),
    fetchImpl: async () => new Response(JSON.stringify({
      model: 'fixture',
      answers: { format: { type: 'choice', choice: 'explainer', probabilities: { comparison: 0.05, explainer: 0.9, other: 0.05 }, confidence: 0.9 } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  const receipt = await supervisor.evaluate({
    decisionId: 'format', state: { topic: 'test' }, questions, fallbacks: { format: 'comparison' },
  });
  assert.equal(choiceValue(receipt, 'format'), 'comparison');
  assert.equal(receipt.comparisons.format.eligible, true);
  assert.equal(receipt.comparisons.format.differsFromFallback, true);
});

test('active mode adopts only an allowlisted high-confidence answer', async () => {
  const supervisor = new JevSupervisor({
    config: jevConfig({}, {
      mode: 'active', provider: 'custom', customEndpoint: 'https://fixture.test', customKey: 'fixture', confidenceFloor: 0.8,
    }),
    fetchImpl: async () => new Response(JSON.stringify({
      answers: { format: { type: 'choice', choice: 'explainer', probabilities: { comparison: 0.05, explainer: 0.9, other: 0.05 }, confidence: 0.9 } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  const receipt = await supervisor.evaluate({
    decisionId: 'format', state: { topic: 'test' }, questions, fallbacks: { format: 'comparison' },
  });
  assert.equal(choiceValue(receipt, 'format'), 'explainer');
  assert.equal(receipt.comparisons.format.adoptedSource, 'jev_active');
});

test('a single allowed choice is resolved deterministically without a provider call', async () => {
  const supervisor = new JevSupervisor({
    config: jevConfig({}, { mode: 'active', provider: 'custom', customEndpoint: 'https://fixture.test', customKey: 'fixture' }),
    fetchImpl: async () => assert.fail('A single-option decision must not call the provider'),
  });
  const receipt = await supervisor.evaluate({
    decisionId: 'single-topic',
    state: { candidates: { only: { keyword: '감기 몸살' } } },
    questions: {
      topic: {
        type: 'choice',
        instructions: 'Choose the only allowed topic.',
        criteria: { only: 'The user explicitly selected this topic' },
      },
    },
    fallbacks: { topic: 'only' },
  });
  assert.equal(receipt.providerResult, 'deterministic_only');
  assert.equal(choiceValue(receipt, 'topic'), 'only');
});

test('Vercel key uses only its documented gateway route and Jev model', async () => {
  const config = jevConfig({ AI_GATEWAY_API_KEY: 'fixture-vercel-key' });
  assert.equal(config.provider, 'vercel');
  assert.equal(config.model, 'typesafe-ai/jev');
  const supervisor = new JevSupervisor({ config, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://ai-gateway.vercel.sh/typesafe/v1/systemone');
    assert.equal(options.headers.authorization, 'Bearer fixture-vercel-key');
    assert.equal(options.redirect, 'error');
    assert.equal(JSON.parse(options.body).model, 'typesafe-ai/jev');
    return new Response(JSON.stringify({ answers: { format: { type: 'choice', choice: 'comparison', confidence: 0.95 } } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  const result = await supervisor.evaluate({ decisionId: 'gateway', state: {}, questions, fallbacks: { format: 'comparison' } });
  assert.equal(result.providerResult, 'ok');
  assert.equal(result.comparisons.format.differsFromFallback, false);
  assert.equal(JSON.stringify(result).includes('fixture-vercel-key'), false);
});

test('explicit TypeSafe provider cannot borrow a Vercel key', () => {
  const config = jevConfig({ AI_GATEWAY_API_KEY: 'fixture-vercel-key', JEV_PROVIDER: 'typesafe' });
  assert.equal(config.apiKey, '');
  assert.equal(config.endpoint, 'https://api.typesafe.ai/v1/systemone');
});

test('HTTP authentication failure is recorded without an automatic retry', async () => {
  let calls = 0;
  const supervisor = new JevSupervisor({
    config: jevConfig({ AI_GATEWAY_API_KEY: 'fixture-vercel-key' }),
    fetchImpl: async () => { calls++; return new Response('{}', { status: 401 }); },
  });
  const result = await supervisor.evaluate({ decisionId: 'failure', state: {}, questions, fallbacks: { format: 'other' } });
  assert.equal(calls, 1);
  assert.equal(result.providerResult, 'provider_http_401');
  assert.equal(choiceValue(result, 'format'), 'other');
});

test('out-of-range scores are not adopted even with high reported confidence', async () => {
  const supervisor = new JevSupervisor({
    config: jevConfig({ AI_GATEWAY_API_KEY: 'fixture-vercel-key', JEV_MODE: 'active' }),
    fetchImpl: async () => new Response(JSON.stringify({ answers: { quality: { type: 'score', score: 99, confidence: 1 } } }),
      { status: 200 }),
  });
  const result = await supervisor.evaluate({
    decisionId: 'range', state: {},
    questions: { quality: { type: 'score', instructions: 'Rate quality', criteria: ['poor', 'good'] } },
    fallbacks: { quality: 0 },
  });
  assert.equal(result.adopted.quality.score, 0);
  assert.equal(result.comparisons.quality.eligible, false);
});

test('null and array provider answer envelopes fall back without throwing', async () => {
  for (const answers of [null, []]) {
    const supervisor = new JevSupervisor({
      config: jevConfig({ AI_GATEWAY_API_KEY: 'fixture-vercel-key', JEV_MODE: 'active' }),
      fetchImpl: async () => new Response(JSON.stringify({ answers }), { status: 200 }),
    });
    const result = await supervisor.evaluate({ decisionId: 'bad-envelope', state: {}, questions, fallbacks: { format: 'comparison' } });
    assert.equal(result.adopted.format.choice, 'comparison');
    assert.equal(result.comparisons.format.eligible, false);
    assert.equal(result.providerResult, 'provider_schema_invalid');
  }
});

test('choice and score answers require finite numeric confidence in the zero-to-one range', async () => {
  for (const confidence of invalidConfidenceValues) {
    const supervisor = new JevSupervisor({
      config: jevConfig({ AI_GATEWAY_API_KEY: 'fixture-vercel-key', JEV_MODE: 'active' }),
      fetchImpl: async () => new Response(JSON.stringify({ answers: {
        format: { type: 'choice', choice: 'explainer', confidence },
        quality: { type: 'score', score: 1, confidence },
      } }), { status: 200 }),
    });
    const result = await supervisor.evaluate({
      decisionId: 'bad-confidence', state: {},
      questions: {
        ...questions,
        quality: { type: 'score', instructions: 'Rate quality', criteria: ['poor', 'good'] },
      },
      fallbacks: { format: 'comparison', quality: 0 },
    });
    assert.equal(result.adopted.format.choice, 'comparison');
    assert.equal(result.adopted.quality.score, 0);
    assert.equal(result.comparisons.format.eligible, false);
    assert.equal(result.comparisons.quality.eligible, false);
  }
});
