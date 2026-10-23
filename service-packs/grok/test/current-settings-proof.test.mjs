import assert from 'node:assert/strict';
import test from 'node:test';
import { currentSettingsRoundtripMatchesReceipt } from '../src/feature-checklist.mjs';

const digest = character => character.repeat(64);
function fixture() {
  const read = hash => ({ httpStatus: 200, mime: 'application/json', responseBytes: 100,
    rawBodySha256: hash, rawDigestKind: 'raw_http_body', requestDigest: digest('a') });
  const write = hash => ({ state: 'completed', verified: true, httpStatus: 200, readbackStatus: 200,
    otherPreferencesUnchanged: true, otherSettingsUnchanged: true, responseReceipt: {
      operationId: 'settings.update', responseStatus: 200, responseContentType: 'application/json',
      responseBytes: 100, responseDigest: hash, responseDigestKind: 'raw_http_body',
      requestDigest: digest('b'), intentDigest: hash, attemptCount: 1, explicitRetries: 0,
      ownerVerified: true, tlsVerified: true, trustEnv: false, redirectsFollowed: false,
    } });
  const proof = {
    schema: 'grok-settings-current-source-roundtrip-v2', outcome: 'verified', sourceStable: true,
    ownerVerified: true, ownerScopeSha256: digest('c'), preference: 'autoWrapLongLinesCode', baseline: false,
    remotePrivacyFieldsSubmitted: false, rawSettingsCredentialsValuesPersisted: false,
    writeAttempts: { apply: 1, restore: 1 }, changedValueMatched: true, baselineRestored: true,
    wholeSettingsRestored: true, sourceBeforeImports: { 'src/client.mjs': digest('d'),
      'scripts/verify-settings-roundtrip-once.mjs': digest('e') },
    ownerRead: read(digest('f')), before: read(digest('a')), afterApply: read(digest('b')),
    afterRestore: read(digest('a')), apply: write(digest('b')), restore: write(digest('a')),
  };
  const receipt = { operationId: 'settings.update', ownerScopeSha256: digest('c'), httpStatus: 200,
    responseBytes: 100, responseDigest: digest('b'), responseDigestKind: 'raw_http_body',
    requestDigest: digest('b'), intentDigest: digest('b'), codeSha256: { 'src/client.mjs': digest('d') },
    restoreReplay: { requestDigest: digest('b'), intentDigest: digest('a') },
    semanticReadback: { beforeValue: false, afterValue: true, restoreBeforeValue: true, restoreAfterValue: false },
  };
  return { proof, receipt };
}

test('current settings proof binds actual raw response, changed value, restore and source', () => {
  const { proof, receipt } = fixture();
  assert.equal(currentSettingsRoundtripMatchesReceipt(receipt, proof), true);
});

for (const [name, mutate] of [
  ['different owner', p => { p.ownerScopeSha256 = digest('a'); }],
  ['source drift', p => { p.sourceBeforeImports['src/client.mjs'] = digest('a'); }],
  ['parsed digest passed as raw', p => { p.apply.responseReceipt.responseDigestKind = 'parsed_json_data'; }],
  ['different after-read body', p => { p.afterApply.rawBodySha256 = digest('c'); }],
  ['unrestored settings', p => { p.wholeSettingsRestored = false; }],
  ['retry', p => { p.apply.responseReceipt.attemptCount = 2; }],
  ['redirect', p => { p.restore.responseReceipt.redirectsFollowed = true; }],
  ['missing owner response', p => { delete p.ownerRead; }],
  ['missing execution runner hash', p => { delete p.sourceBeforeImports['scripts/verify-settings-roundtrip-once.mjs']; }],
]) {
  test(`current settings proof rejects ${name}`, () => {
    const { proof, receipt } = fixture(); mutate(proof);
    assert.equal(currentSettingsRoundtripMatchesReceipt(receipt, proof), false);
  });
}
