import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createMyrealtripClient, runMyrealtripEnvelope, verifyMyrealtripLink,
  marketingErrorResult, MyrealtripError } from '../adapters/myrealtrip-marketing.mjs';
import { runMyrealtrip } from '../tools/discovery/partner-session-handoff.mjs';

const session = { token: 'fixture-secret-token', expectedPartnerId: 42, expectedEmail: 'fixture@example.com' };
const targetUrl = 'https://www.myrealtrip.com/offers/174730';
const mylink = 'https://myrealt.rip/fixture';
const result = data => ({ data, meta: {}, result: { status: 200, code: 'success' } });
const account = () => Response.json(result({ id: 42, email: session.expectedEmail, privateAccountField: 'do-not-return' }));
const link = () => Response.json(result({ id: 100, mylink, expirationMinutes: 604800 }));
const flight = { depAirportCd: 'SEL', arrAirportCd: 'NRT', airline: 'KE', depDate: '2026-10-15', arrDate: '2026-10-18', tripTypeCd: 'RT', adult: 1, child: 0, infant: 0, cabinClass: 'ECONOMY' };
const landingUrl = 'https://air-web.myrealtrip.com/results?trip=C.SEL.A.NRT.2026-10-15%2FA.NRT.C.SEL.2026-10-18&adult=1&child=0&infant=0&cabins=ECONOMY&airlines=KE&tripType=ROUND_TRIP';
const bridge = target => new Response(null, { status: 301, headers: { location: 'https://www.myrealtrip.com/main/bridge/marketing?return_url=' + encodeURIComponent(target + (target.includes('?') ? '&' : '?') + 'mylink_id=100&t_scope=web') } });
const fails = (code, cause) => error => error instanceof MyrealtripError && error.code === code && (!cause || error.causeCode === cause);
const env = (operation, input) => ({ schemaVersion: 1, acquiredAt: new Date().toISOString(), session, operation, input });

test('link command validates the actor before POST and verifies destination without credentials', async () => {
  const calls = [];
  const receipt = await runMyrealtripEnvelope(env('createLink', { targetUrl }), { fetchImpl: async (url, options) => {
    calls.push(url);
    if (url.endsWith('/partners')) return account();
    if (url.endsWith('/mylink')) {
      assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'manual');
      assert.deepEqual(options.headers, { accept: 'application/json', 'partner-access-token': session.token, 'content-type': 'application/json' });
      assert.deepEqual(JSON.parse(options.body), { targetUrl }); return link();
    }
    assert.equal(url, mylink); assert.deepEqual(options.headers, { accept: 'text/html' }); return bridge(targetUrl);
  } });
  assert.equal(calls.length, 3); assert.equal(receipt.verification.verified, true);
  assert.equal(receipt.data.mylink, mylink);
  assert.doesNotMatch(JSON.stringify(receipt), /fixture-secret-token|fixture@example|privateAccountField|do-not-return/);
});

test('bad actor blocks every marketing request', async () => {
  let calls = 0;
  await assert.rejects(runMyrealtripEnvelope(env('createLink', { targetUrl }), { fetchImpl: async () => {
    calls++; return Response.json(result({ id: 99, email: session.expectedEmail }));
  } }), error => error.code === 'ACCOUNT_MISMATCH');
  assert.equal(calls, 1);
});

test('unobserved operations, destinations, fields, dates and handoff age fail before HTTP', async () => {
  const cases = [
    [env('deleteLink', {}), 'SCOPE'],
    [env('createLink', { targetUrl: 'https://www.myrealtrip.com.attacker.example/offers/123' }), 'TARGET_SCOPE'],
    [env('createLink', { targetUrl: 'https://user:pass@www.myrealtrip.com/offers/123' }), 'URL'],
    [env('createLink', { targetUrl: 'https://experiences.myrealtrip.com/products/3419212?utm=x' }), 'TARGET_SCOPE'],
    [env('createLink', { targetUrl: 'https://experiences.myrealtrip.com/offers/3419212' }), 'TARGET_SCOPE'],
    [env('createLink', { targetUrl, headers: { cookie: 'private' } }), 'INPUT'],
    [env('sales', { fromDate: '2026-02-30', toDate: '2026-03-01' }), 'DATE'],
    [env('reservations', { startDate: '2026-09-20', endDate: '2026-09-01' }), 'DATE_RANGE'],
    [env('createFlightLink', { ...flight, tripTypeCd: 'OW' }), 'UNOBSERVED_VARIANT'],
    [env('createFlightLink', { ...flight, infant: 2 }), 'PASSENGERS'],
    [{ ...env('sales', {}), acquiredAt: '2000-01-01T00:00:00Z' }, 'HANDOFF_EXPIRED'],
  ];
  for (const [input, code] of cases) await assert.rejects(runMyrealtripEnvelope(input, { fetchImpl: () => assert.fail('must not send') }), fails(code));
});

test('reservation query uses observed defaults and never returns unknown private row fields', async () => {
  let calls = 0;
  const client = await createMyrealtripClient(session, { fetchImpl: async (url, options) => {
    if (++calls === 1) return account();
    assert.deepEqual(Object.fromEntries(new URL(url).searchParams), { dateSearchType: 'TRIP_END_DATE', endDate: '2026-09-21', page: '2', pageSize: '15', reservationStatus: '', startDate: '2026-09-01' });
    assert.equal(options.method, 'GET'); assert.equal(options.body, undefined);
    return Response.json({ ...result([{ unobservedPrivateField: 'person@example.com' }]), meta: { pagination: { page: 2, pageSize: 15, totalCount: 16 } } });
  } });
  const output = await client.execute('reservations', { startDate: '2026-09-01', endDate: '2026-09-21', page: 2 });
  assert.equal(output.data.recordCount, 1); assert.equal(output.data.rowSchemaVerified, false);
  assert.doesNotMatch(JSON.stringify(output), /person@example|unobservedPrivateField/);
  client.close(); await assert.rejects(client.execute('sales', {}), fails('SESSION_CLOSED'));
});

test('public lookup uses URLSearchParams and returns only observed fields', async () => {
  const row = { airlineCd: 'KE', airlineKorNm: '대한항공', airlineEngNm: 'Korean Air', airlineImgUrl: 'https://example.com/image.png', extra: 'hidden' };
  const client = await createMyrealtripClient(session, { fetchImpl: async url => {
    if (url.endsWith('/partners')) return account();
    assert.equal(new URL(url).searchParams.get('keyword'), '대한 & test');
    assert.equal([...new URL(url).searchParams].length, 1);
    return Response.json(result({ airlines: [row] }));
  } });
  const output = await client.execute('searchAirlines', { keyword: '대한 & test' });
  assert.equal(output.data.airlines[0].airlineCd, 'KE'); assert.equal(output.data.airlines[0].extra, undefined);
});

test('flight orchestration validates landing fields and shortens exactly once', async () => {
  const calls = [];
  const client = await createMyrealtripClient(session, { fetchImpl: async (url, options) => {
    calls.push(url);
    if (url.endsWith('/partners')) return account();
    if (url.endsWith('/query-landing-url')) { assert.deepEqual(JSON.parse(options.body), flight); return Response.json(result({ url: landingUrl, gid: 0 })); }
    assert.deepEqual(JSON.parse(options.body), { targetUrl: landingUrl }); return link();
  } });
  const output = await client.createFlightLink(flight);
  assert.equal(calls.length, 3); assert.equal(output.receipts.length, 2); assert.equal(output.data.landingUrl, landingUrl);
});

test('wrong flight destination is uncertain and never forwarded to shortening', async () => {
  let calls = 0;
  const client = await createMyrealtripClient(session, { fetchImpl: async () => ++calls === 1 ? account() : Response.json(result({ url: landingUrl.replace('airlines=KE', 'airlines=OZ'), gid: 123 })) });
  await assert.rejects(client.createFlightLink(flight), fails('WRITE_OUTCOME_UNKNOWN', 'FLIGHT_MISMATCH'));
  assert.equal(calls, 2);
});

test('uncertain POST is not retried, and a finished flight landing step is retained', async () => {
  let calls = 0;
  const client = await createMyrealtripClient(session, { fetchImpl: async url => {
    calls++; if (url.endsWith('/partners')) return account();
    if (url.endsWith('/query-landing-url')) return Response.json(result({ url: landingUrl, gid: 123 }));
    throw Error('fixture-secret-token must not appear');
  } });
  let error; try { await client.createFlightLink(flight); } catch (caught) { error = caught; }
  assert.equal(calls, 3); assert.equal(error.code, 'WRITE_OUTCOME_UNKNOWN');
  assert.equal(error.completedStep, 'createFlightLanding'); assert.equal(error.resumeTargetUrl, landingUrl);
  assert.doesNotMatch(JSON.stringify(marketingErrorResult(error)), /fixture-secret-token/);
});

test('expired tokens, rate limits, redirects, oversized bodies and HTML retain distinct failures', async () => {
  const cases = [
    [() => Response.json({ data: null, result: { status: 401 } }), 'REAUTH_REQUIRED'],
    [() => new Response(null, { status: 429 }), 'THROTTLED'],
    [() => new Response(null, { status: 302, headers: { location: 'https://attacker.example' } }), 'REDIRECT'],
    [() => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }), 'MIME'],
    [() => new Response(' '.repeat(1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } }), 'SIZE'],
    [() => Response.json(result({ quantity: '0' })), 'SCHEMA'],
  ];
  for (const [response, code] of cases) {
    let calls = 0;
    const client = await createMyrealtripClient(session, { fetchImpl: async () => ++calls === 1 ? account() : response() });
    await assert.rejects(client.execute('salesSummary', { fromDate: '2026-09-01', toDate: '2026-09-30' }), fails(code));
    assert.equal(calls, 2);
  }
});

test('link verification checks nested target and duplicate query values without following redirects', async () => {
  await assert.rejects(verifyMyrealtripLink(mylink, targetUrl, { expectedLinkId: 100, fetchImpl: async () => bridge('https://attacker.example/offers/174730') }), fails('LINK_DESTINATION'));
  await assert.rejects(verifyMyrealtripLink(mylink, targetUrl + '?x=1&x=2', { expectedLinkId: 100, fetchImpl: async () => bridge(targetUrl + '?x=1') }), fails('LINK_DESTINATION'));
  await assert.rejects(verifyMyrealtripLink(mylink, targetUrl, { expectedLinkId: 101, fetchImpl: async () => bridge(targetUrl) }), fails('LINK_ATTRIBUTION'));
  const output = await verifyMyrealtripLink(mylink, landingUrl, { expectedLinkId: 100, fetchImpl: async () => bridge(landingUrl) });
  assert.equal(output.verified, true);
});

test('failed link verification preserves the successful link instead of resubmitting it', async () => {
  let calls = 0;
  const output = await runMyrealtripEnvelope(env('createLink', { targetUrl }), { fetchImpl: async url => {
    calls++; if (url.endsWith('/partners')) return account(); if (url.endsWith('/mylink')) return link(); throw Error('offline');
  } });
  assert.equal(output.ok, true); assert.equal(output.data.mylink, mylink);
  assert.equal(output.verification.verified, false); assert.equal(calls, 3);
});

test('real stdin runner rejects stale input and a faulty runner cannot echo its token', async () => {
  assert.deepEqual(await runMyrealtrip({ ...env('createLink', { targetUrl }), acquiredAt: '2000-01-01T00:00:00Z' }), { ok: false, code: 'HANDOFF_EXPIRED', outcome: 'not_sent' });
  const spawnImpl = (exe, args, options) => {
    assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    assert.deepEqual(options.env, { SystemRoot: 'fixture-root' }); assert.doesNotMatch(JSON.stringify(args), /fixture-secret/);
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdin = new EventEmitter();
    child.stdin.end = text => {
      assert.equal(JSON.parse(text).session.token, session.token);
      queueMicrotask(() => { child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, accidental: session.token }))); child.emit('close', 0); });
    };
    return child;
  };
  await assert.rejects(runMyrealtrip(env('createLink', { targetUrl }), { spawnImpl, environment: { SystemRoot: 'fixture-root', UNRELATED_SECRET: 'private' } }), fails('WRITE_OUTCOME_UNKNOWN', 'RUNNER_OUTPUT_REDACTED'));
});
