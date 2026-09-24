import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEcbCsv,
  fetchEcbReferenceRate,
  convertEurToKrw,
} from '../adapters/ecb-exchange-rates.mjs';

const fixture = [
  'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS',
  'EXR.D.KRW.EUR.SP00.A,D,KRW,EUR,SP00,A,2026-09-17,1590.10,A',
  'EXR.D.KRW.EUR.SP00.A,D,KRW,EUR,SP00,A,2026-09-18,1593.17,A',
].join('\n');

test('ECB CSV parser selects the latest official KRW per EUR observation', () => {
  const parsed = parseEcbCsv(fixture);
  assert.equal(parsed.referenceDate, '2026-09-18');
  assert.equal(parsed.quotePerBase, 1593.17);
  assert.equal(parsed.baseCurrency, 'EUR');
  assert.equal(parsed.settlementRate, false);
  assert.equal(convertEurToKrw(100, parsed), 159317);
});

test('ECB adapter records a browser-free credential-free receipt', async () => {
  const result = await fetchEcbReferenceRate({
    startPeriod: '2026-09-01',
    fetchImpl: async () => new Response(fixture, {
      status: 200,
      headers: { 'content-type': 'text/csv' },
    }),
  });
  assert.equal(result.receipt.browserUsed, false);
  assert.equal(result.receipt.credentialsUsed, false);
  assert.deepEqual(result.receipt.queryFields, ['format', 'startPeriod']);
});

test('ECB adapter fails closed on malformed data and invalid input', async () => {
  assert.throws(() => parseEcbCsv('invalid'), { code: 'SCHEMA' });
  await assert.rejects(fetchEcbReferenceRate({ currency: 'KRWW' }), { code: 'INPUT' });
});
