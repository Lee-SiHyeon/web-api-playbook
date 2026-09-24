import test from 'node:test';
import assert from 'node:assert/strict';
import { JevSupervisor, jevConfig, choiceValue } from '../workflows/affiliate-content-e2e/jev-supervisor.mjs';

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

test('Vercel gateway config uses the Jev model and refuses redirects', async () => {
  const config = jevConfig({ AI_GATEWAY_API_KEY: 'fixture-vercel-key' });
  assert.equal(config.provider, 'vercel');
  assert.equal(config.endpoint, 'https://ai-gateway.vercel.sh/typesafe/v1/systemone');
  assert.equal(config.model, 'typesafe-ai/jev');
  const supervisor = new JevSupervisor({config,fetchImpl:async(url,options)=>{
    assert.equal(url,config.endpoint);
    assert.equal(options.redirect,'error');
    assert.equal(options.headers.authorization,'Bearer fixture-vercel-key');
    return new Response(JSON.stringify({answers:{format:{type:'choice',choice:'comparison',confidence:0.95}}}),{status:200});
  }});
  const receipt=await supervisor.evaluate({decisionId:'gateway',state:{},questions,fallbacks:{format:'comparison'}});
  assert.equal(receipt.providerResult,'ok');
  assert.equal(JSON.stringify(receipt).includes('fixture-vercel-key'),false);
});

test('out-of-range score is not adopted even with high confidence', async () => {
  const supervisor = new JevSupervisor({
    config: jevConfig({AI_GATEWAY_API_KEY:'fixture-vercel-key',JEV_MODE:'active'}),
    fetchImpl:async()=>new Response(JSON.stringify({answers:{quality:{type:'score',score:99,confidence:1}}}),{status:200}),
  });
  const receipt=await supervisor.evaluate({decisionId:'range',state:{},questions:{quality:{type:'score',instructions:'Rate quality',criteria:['poor','good']}},fallbacks:{quality:0}});
  assert.equal(receipt.adopted.quality.score,0);
  assert.equal(receipt.comparisons.quality.eligible,false);
});
