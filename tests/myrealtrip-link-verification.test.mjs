import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyMyrealtripLink, MyrealtripError } from '../service-packs/affiliate/apps/affiliate-api-hub/adapters/myrealtrip-marketing.mjs';

const shortLink = 'https://myrealt.rip/fixture';
const target = 'https://www.myrealtrip.com/offers/174730?date=2026-10-15&option=A&option=B';
const expectedLinkId = 100;

function destination(tracking = 'mylink_id=100&t_scope=web') {
  return `${target}&${tracking}`;
}

function redirectTo(value) {
  return new Response(null, { status: 301, headers: {
    location: `https://www.myrealtrip.com/main/bridge/marketing?return_url=${encodeURIComponent(value)}`,
  } });
}

const rejected = code => error => error instanceof MyrealtripError && error.code === code;
const verify = value => verifyMyrealtripLink(shortLink, target, {
  expectedLinkId, fetchImpl: async () => redirectTo(value),
});

test('browser and official partner tracking shapes preserve repeated options without credentials or redirect follow', async () => {
  for (const tracking of ['mylink_id=100&t_scope=web', 'mylink_id=100&t_scope=604800&utm_source=mktpartner']) {
    let calls = 0;
    const result = await verifyMyrealtripLink(shortLink, target, { expectedLinkId, fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, shortLink);
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'manual');
      assert.deepEqual(options.headers, { accept: 'text/html' });
      return redirectTo(destination(tracking));
    } });
    assert.equal(result.verified, true);
    assert.equal(result.credentialSent, false);
    assert.equal(result.followedRedirect, false);
    assert.equal(calls, 1);
  }
});

test('unknown added query cannot turn a matched product into a verified link', async () => {
  for (const extra of ['dateTo=2026-10-20', 'optionOverride=C', 'redirect=https%3A%2F%2Fexample.invalid', 'unobserved=1']) {
    await assert.rejects(verify(`${destination()}&${extra}`), rejected('LINK_DESTINATION'));
  }
});

test('original dates, repeated options and their ordering remain exact', async () => {
  for (const changed of [
    destination().replace('date=2026-10-15', 'date=2026-10-16'),
    destination().replace('option=A&option=B', 'option=B&option=A'),
    destination().replace('&option=B', ''),
    destination().replace('option=A&option=B', 'option=A&option=B&option=C'),
  ]) await assert.rejects(verify(changed), rejected('LINK_DESTINATION'));
});

test('tracking values and multiplicity fail closed when outside the observed contract', async () => {
  for (const tracking of [
    'mylink_id=100&t_scope=unknown',
    'mylink_id=100&t_scope=web&t_scope=web',
    'mylink_id=100&t_scope=604800&utm_source=other',
    'mylink_id=100&utm_source=mktpartner&utm_source=mktpartner',
  ]) await assert.rejects(verify(destination(tracking)), rejected('LINK_DESTINATION'));
});

test('missing, duplicated and incorrect attribution are rejected independently', async () => {
  for (const tracking of ['t_scope=web', 'mylink_id=101', 'mylink_id=100&mylink_id=100']) {
    await assert.rejects(verify(destination(tracking)), rejected('LINK_ATTRIBUTION'));
  }
});

test('invalid short-link origins and credentials are rejected before HTTP', async () => {
  for (const link of [
    'http://myrealt.rip/fixture', 'https://myrealt.rip.example.invalid/fixture',
    'https://user:password@myrealt.rip/fixture', 'https://myrealt.rip/fixture?override=1',
  ]) await assert.rejects(verifyMyrealtripLink(link, target, {
    expectedLinkId, fetchImpl: () => assert.fail('must not send'),
  }), rejected('URL'));
});

test('external, different-product and duplicated bridge destinations are rejected', async () => {
  for (const value of [destination().replace('/174730?', '/174731?'), destination().replace('www.myrealtrip.com', 'example.invalid')]) {
    await assert.rejects(verify(value), rejected('LINK_DESTINATION'));
  }
  await assert.rejects(verifyMyrealtripLink(shortLink, target, { expectedLinkId, fetchImpl: async () => {
    const response = redirectTo(destination());
    response.headers.set('location', `${response.headers.get('location')}&return_url=${encodeURIComponent(destination())}`);
    return response;
  } }), rejected('LINK_DESTINATION'));
});
