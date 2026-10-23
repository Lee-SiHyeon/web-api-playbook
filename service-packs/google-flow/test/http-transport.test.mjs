import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FlowHttpTransport } from '../src/http-transport.mjs';
import { resetTestCredentialStore, readCredential, writeCredential } from '../src/secure-credential-store.mjs';
import { FLOW_CREDENTIAL } from '../src/session-name.mjs';
import { bindCaptchaToken, buildTextVideoSubmission, getBatchPayload, omitGenerationInput, RPC } from '../src/protocol.mjs';
import { classifyFlowRedirect } from '../src/http-transport.mjs';

const FLOW_ORIGIN = 'https://flow.google.com';
const PROJECT_ID = '123e4567-e89b-42d3-a456-426614174000';

beforeEach(() => resetTestCredentialStore());

test('loadable SDK diagnostic provenance does not authorize the production HTTP writer', async () => {
  let calls = 0;
  const transport = new FlowHttpTransport({ fetchImpl: async () => {
    calls += 1;
    throw new Error('No diagnostic POST is allowed through this writer');
  } });
  transport.bundle = { origin: FLOW_ORIGIN, projectId: PROJECT_ID };
  transport.document = { sourcePath: '/project/' + PROJECT_ID, at: 'synthetic-at', sid: 'synthetic-sid', bl: 'synthetic-bl' };
  const submission = buildTextVideoSubmission({ prompt: 'synthetic', projectId: PROJECT_ID, duration: 8, resolution: '720p' });
  await assert.rejects(transport.createVideo(bindCaptchaToken(submission.freq, 'synthetic-sdk-input').freq,
    { inputMode: 'browser_sdk_diagnostic' }), error => error.code === 'FLOW_GENERATION_REQUEST_INVALID' && error.rejected === true);
  assert.equal(calls, 0);
});

function credential(overrides = {}) {
  return {
    version: 1,
    origin: FLOW_ORIGIN,
    projectId: PROJECT_ID,
    cookieHeader: 'SID=initial; __Secure-1PSID=initial-secure',
    ...overrides,
  };
}

function htmlResponse({ includeRequestToken = true, status = 200, setCookies = [] } = {}) {
  const tokenField = includeRequestToken ? '"SNlM0e":"synthetic-at",' : '';
  const html = `<script>{${tokenField}"FdrFJe":"synthetic-sid","cfb2h":"synthetic-bl"}</script>`;
  return makeResponse(html, {
    status,
    mime: 'text/html; charset=utf-8',
    setCookies,
    url: `${FLOW_ORIGIN}/project/${PROJECT_ID}`,
  });
}

function makeResponse(body, { status = 200, mime, setCookies = [], url = '', location } = {}) {
  const headers = new Headers(mime ? { 'content-type': mime } : {});
  if (location) headers.set('location', location);
  const response = new Response(body, {
    status,
    headers,
  });
  Object.defineProperty(response, 'url', { value: url });
  Object.defineProperty(response.headers, 'getSetCookie', { value: () => setCookies });
  return response;
}

function seedCredential(value = credential()) {
  writeCredential(FLOW_CREDENTIAL, JSON.stringify(value));
}

function readStoredCredential() {
  return JSON.parse(readCredential(FLOW_CREDENTIAL));
}

test('cookie arrays are filtered by Flow domain, request path, expiry, and secure origin', async () => {
  const now = Date.now() / 1000;
  seedCredential(credential({
    cookieHeader: undefined,
    cookies: [
      { name: 'domain_cookie', value: 'kept', domain: '.google.com', path: '/', expires: now + 3600, secure: true },
      { name: 'path_cookie', value: 'kept', domain: 'flow.google.com', path: '/project', expires: now + 3600, secure: false },
      { name: 'session_cookie', value: 'kept', domain: '.flow.google.com', path: '/project/', session: true, secure: true },
      { name: 'wrong_domain', value: 'excluded', domain: '.example.com', path: '/', expires: now + 3600, secure: true },
      { name: 'google_host_only', value: 'excluded', domain: 'google.com', hostOnly: true, path: '/', expires: now + 3600, secure: true },
      { name: 'wrong_path', value: 'excluded', domain: '.google.com', path: '/private', expires: now + 3600, secure: true },
      { name: 'expired_cookie', value: 'excluded', domain: '.google.com', path: '/', expires: now - 1, secure: true },
      { name: 'invalid_secure_flag', value: 'excluded', domain: '.google.com', path: '/', expires: now + 3600, secure: 'yes' },
    ],
  }));

  let requestCookie;
  let requestUrl;
  const transport = new FlowHttpTransport({
    fetchImpl: async (url, options) => {
      requestUrl = new URL(url);
      requestCookie = options.headers.cookie;
      return htmlResponse();
    },
  });
  await transport.start();

  assert.equal(requestUrl.origin, FLOW_ORIGIN);
  assert.equal(requestUrl.protocol, 'https:');
  assert.equal(requestCookie, 'domain_cookie=kept; path_cookie=kept; session_cookie=kept');
});

test('observed cookie rotation is persisted before missing document-token parsing fails', async () => {
  seedCredential();
  const transport = new FlowHttpTransport({
    fetchImpl: async () => htmlResponse({
      includeRequestToken: false,
      setCookies: ['SID=rotated; Domain=.google.com; Path=/; Secure'],
    }),
  });

  await assert.rejects(transport.start(), error => {
    assert.match(error.message, /omitted required request token SNlM0e/);
    assert.equal(error.code, 'FLOW_DOCUMENT_REQUEST_TOKEN_MISSING');
    assert.equal(error.sessionStatus, 'undetermined');
    assert.deepEqual(error.documentDiagnostics, {
      httpStatus: 200,
      mime: 'text/html',
      sourcePathHints: {
        requestPathKind: 'project',
        responsePathKind: 'project',
        responsePathMatchesRequestedProject: true,
      },
      markerPresence: {
        inspected: true,
        SNlM0e: false,
        FdrFJe: true,
        cfb2h: true,
        xZbWve: false,
      },
      validStringPresence: {
        inspected: true,
        SNlM0e: false,
        FdrFJe: true,
        cfb2h: true,
        xZbWve: false,
      },
    });
    const safeDetails = JSON.stringify({
      message: error.message,
      code: error.code,
      sessionStatus: error.sessionStatus,
      diagnostics: error.documentDiagnostics,
    });
    assert.doesNotMatch(safeDetails, /synthetic-at|synthetic-sid|123e4567-e89b-42d3-a456-426614174000/);
    return true;
  });
  assert.match(readStoredCredential().cookieHeader, /SID=rotated/);
  assert.doesNotMatch(readStoredCredential().cookieHeader, /SID=initial(?:;|$)/);
});

test('missing-token diagnostics report only a safe response-path hint and never claim expiry', async () => {
  seedCredential();
  const responseProjectId = '223e4567-e89b-42d3-a456-426614174000';
  const transport = new FlowHttpTransport({
    fetchImpl: async () => makeResponse(
      '<script>{"SNlM0e":null,"FdrFJe":"synthetic-sid","cfb2h":"synthetic-bl"}</script>',
      {
        status: 200,
        mime: 'text/html; charset=utf-8',
        url: `${FLOW_ORIGIN}/project/${responseProjectId}?private=query-value`,
      },
    ),
  });

  await assert.rejects(transport.start(), error => {
    assert.equal(error.code, 'FLOW_DOCUMENT_REQUEST_TOKEN_MISSING');
    assert.equal(error.sessionStatus, 'undetermined');
    assert.deepEqual(error.documentDiagnostics.sourcePathHints, {
      requestPathKind: 'project',
      responsePathKind: 'project',
      responsePathMatchesRequestedProject: false,
    });
    assert.equal(error.documentDiagnostics.markerPresence.SNlM0e, true);
    assert.equal(error.documentDiagnostics.validStringPresence.SNlM0e, false);
    const safeDetails = JSON.stringify(error.documentDiagnostics);
    assert.doesNotMatch(safeDetails, /123e4567|223e4567|private=query-value|synthetic-sid/);
    return true;
  });
});

test('legacy flat headers rotate only existing root-scoped cookie names', async () => {
  seedCredential();
  const transport = new FlowHttpTransport({
    fetchImpl: async () => htmlResponse({ setCookies: [
      'SID=path-rotated; Domain=.google.com; Path=/project; Secure',
      '__Secure-OSID=; Domain=.google.com; Path=/; Max-Age=0; Secure',
      'new-cookie=not-added; Domain=.google.com; Path=/; Secure',
    ] }),
  });

  await transport.start();

  const stored = readStoredCredential();
  assert.match(stored.cookieHeader, /(?:^|;\s*)SID=initial(?:;|$)/);
  assert.doesNotMatch(stored.cookieHeader, /(?:^|;\s*)new-cookie=/);
  assert.equal(stored.reauthRequired, undefined);
});

test('array-cookie rotations keep each cookie domain and path metadata', async () => {
  const expires = Date.now() / 1000 + 3600;
  seedCredential(credential({
    cookieHeader: undefined,
    cookies: [
      { name: 'SID', value: 'old-root', domain: '.google.com', path: '/', expires, secure: true },
      { name: 'SID', value: 'old-project', domain: '.google.com', path: '/project', expires, secure: true },
    ],
  }));
  const transport = new FlowHttpTransport({
    fetchImpl: async () => htmlResponse({
      includeRequestToken: false,
      setCookies: [
        'SID=new-root; Domain=.google.com; Path=/; Secure',
        'SID=new-project; Domain=.google.com; Path=/project; Secure',
      ],
    }),
  });

  await assert.rejects(transport.start(), /omitted required request token SNlM0e/);
  const stored = readStoredCredential();
  assert.equal(stored.cookieHeader, undefined);
  assert.deepEqual(stored.cookies.map(cookie => [cookie.value, cookie.path]), [
    ['new-root', '/'],
    ['new-project', '/project'],
  ]);
});

test('an auth-cookie deletion only invalidates the session when its stored domain and path match', async t => {
  const expires = Date.now() / 1000 + 3600;
  const cases = [
    ['different path', 'SID=; Domain=.google.com; Path=/project; Max-Age=0; Secure'],
    ['different domain', 'SID=; Domain=flow.google.com; Path=/; Max-Age=0; Secure'],
  ];
  for (const [name, setCookie] of cases) {
    await t.test(name, async () => {
      seedCredential(credential({
        cookieHeader: undefined,
        cookies: [{ name: 'SID', value: 'existing', domain: '.google.com', path: '/', expires, secure: true, hostOnly: false }],
      }));
      const transport = new FlowHttpTransport({
        fetchImpl: async () => htmlResponse({ setCookies: [setCookie] }),
      });

      await transport.start();

      const stored = readStoredCredential();
      assert.equal(stored.reauthRequired, undefined);
      assert.deepEqual(stored.cookies.map(cookie => [cookie.name, cookie.domain, cookie.path, cookie.value]), [
        ['SID', '.google.com', '/', 'existing'],
      ]);
    });
  }
});

test('new Flow-origin cookies are persisted with observed scope and sent only on matching requests', async () => {
  const expiry = new Date(Date.now() + 2 * 60 * 60 * 1000).toUTCString();
  seedCredential(credential({
    cookieHeader: undefined,
    cookies: [
      { name: 'SID', value: 'existing', domain: '.google.com', path: '/', expires: Date.now() / 1000 + 3600, secure: true },
      { name: 'project_only', value: 'old-path-scoped', domain: 'flow.google.com', path: '/project', expires: Date.now() / 1000 + 3600, secure: true, hostOnly: true },
    ],
  }));
  const body = JSON.stringify([['wrb.fr', RPC.projectMedia, JSON.stringify([null, [], []]), null, null, null]]);
  let calls = 0;
  let rpcCookie;
  let rpcReferer;
  const transport = new FlowHttpTransport({
    fetchImpl: async (_url, options) => {
      calls += 1;
      if (calls === 1) return htmlResponse({ setCookies: [
        '__Secure-1PSIDRTS=rotated-one; Domain=.google.com; Path=/; Max-Age=3600; Secure; HttpOnly; SameSite=None',
        `__Secure-3PSIDRTS=rotated-three; Domain=google.com; Path=/; Expires=${expiry}; Secure; HttpOnly; SameSite=Lax`,
        'project_only=path-scoped; Domain=flow.google.com; Path=/project; Secure',
        '__Host-flow=host-only; Path=/; Secure; HttpOnly',
        'empty_value=; Domain=.google.com; Path=/; Secure',
      ] });
      rpcCookie = options.headers.cookie;
      rpcReferer = options.headers.referer;
      return makeResponse(body, {
        mime: 'application/json; charset=utf-8',
        url: `${FLOW_ORIGIN}/_/AiSandboxAngularFrontend/data/batchexecute`,
      });
    },
  });

  await transport.start();
  await transport.rpc(RPC.projectMedia, '[]');

  const stored = readStoredCredential();
  const byName = new Map(stored.cookies.map(cookie => [cookie.name, cookie]));
  const firstPartyCookie = byName.get('__Secure-1PSIDRTS');
  assert.deepEqual({
    domain: firstPartyCookie.domain,
    hostOnly: firstPartyCookie.hostOnly,
    path: firstPartyCookie.path,
    secure: firstPartyCookie.secure,
    httpOnly: firstPartyCookie.httpOnly,
    sameSite: firstPartyCookie.sameSite,
    session: firstPartyCookie.session,
  }, {
    domain: 'google.com', hostOnly: false, path: '/', secure: true,
    httpOnly: true, sameSite: 'None', session: false,
  });
  assert.ok(firstPartyCookie.expires > Date.now() / 1000);
  const secondFirstPartyCookie = byName.get('__Secure-3PSIDRTS');
  assert.equal(secondFirstPartyCookie.domain, 'google.com');
  assert.equal(secondFirstPartyCookie.sameSite, 'Lax');
  assert.equal(secondFirstPartyCookie.httpOnly, true);
  assert.ok(secondFirstPartyCookie.expires > Date.now() / 1000);
  assert.equal(byName.get('project_only').path, '/project');
  assert.equal(byName.get('project_only').value, 'path-scoped');
  assert.equal(byName.get('project_only').hostOnly, false);
  assert.equal(stored.cookies.filter(cookie => cookie.name === 'project_only').length, 1);
  assert.equal(byName.get('__Host-flow').domain, 'flow.google.com');
  assert.equal(byName.get('__Host-flow').hostOnly, true);
  assert.equal(byName.get('empty_value').value, '');
  assert.match(rpcCookie, /(?:^|;\s*)__Secure-1PSIDRTS=rotated-one(?:;|$)/);
  assert.match(rpcCookie, /(?:^|;\s*)__Secure-3PSIDRTS=rotated-three(?:;|$)/);
  assert.match(rpcCookie, /(?:^|;\s*)__Host-flow=host-only(?:;|$)/);
  assert.match(rpcCookie, /(?:^|;\s*)empty_value=(?:;|$)/);
  assert.doesNotMatch(rpcCookie, /(?:^|;\s*)project_only=/);
  assert.equal(rpcReferer, `${FLOW_ORIGIN}/`);
  assert.equal(stored.cookieCount, stored.cookies.length);
});

test('cookie updates require a real Flow response and reject broader or insecure prefix scopes', async () => {
  const now = Date.now() / 1000;
  const unsafeCookies = [
    '__Secure-1PSIDRTS=missing-secure; Domain=.google.com; Path=/; HttpOnly',
    '__Host-invalid=domain; Domain=.google.com; Path=/; Secure',
    '__Host-invalid-path=path; Path=/project; Secure',
    'broad_domain=value; Domain=.com; Path=/; Secure',
    'other_google_subdomain=value; Domain=.evil.google.com; Path=/; Secure',
    'insecure_none=value; Domain=.google.com; Path=/; SameSite=None',
  ];
  seedCredential(credential({
    cookieHeader: undefined,
    cookies: [{ name: 'SID', value: 'existing', domain: '.google.com', path: '/', expires: now + 3600, secure: true }],
  }));
  const transport = new FlowHttpTransport({
    fetchImpl: async () => htmlResponse({ setCookies: unsafeCookies }),
  });
  await transport.start();
  assert.deepEqual(readStoredCredential().cookies.map(cookie => cookie.name), ['SID']);

  const foreignTransport = new FlowHttpTransport({
    fetchImpl: async () => makeResponse('<script>{"SNlM0e":"fresh-at","FdrFJe":"fresh-sid","cfb2h":"fresh-bl"}</script>', {
      mime: 'text/html; charset=utf-8',
      setCookies: ['foreign=must-not-persist; Domain=.google.com; Path=/; Secure'],
      url: 'https://accounts.google.com/ServiceLogin',
    }),
  });
  seedCredential(credential({
    cookieHeader: undefined,
    cookies: [{ name: 'SID', value: 'existing', domain: '.google.com', path: '/', expires: now + 3600, secure: true }],
  }));
  await foreignTransport.start();
  assert.deepEqual(readStoredCredential().cookies.map(cookie => cookie.name), ['SID']);
});

test('observed cookie rotation is persisted before an RPC body contract failure', async () => {
  seedCredential();
  let calls = 0;
  const transport = new FlowHttpTransport({
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return htmlResponse();
      return makeResponse('[]', {
        mime: 'application/json; charset=utf-8',
        setCookies: ['SID=rotated; Domain=.google.com; Path=/; Secure'],
        url: `${FLOW_ORIGIN}/_/AiSandboxAngularFrontend/data/batchexecute`,
      });
    },
  });
  await transport.start();

  await assert.rejects(transport.rpc(RPC.projectMedia, '[]'), /did not contain the expected RPC result/);
  assert.match(readStoredCredential().cookieHeader, /SID=rotated/);
});

test('HTTP 401 stays classified by status while an observed auth-cookie deletion is persisted', async () => {
  seedCredential();
  const transport = new FlowHttpTransport({
    fetchImpl: async () => makeResponse('sign-in response', {
      status: 401,
      mime: 'text/html',
      setCookies: ['SID=; Max-Age=0; Domain=.google.com; Path=/'],
      url: `${FLOW_ORIGIN}/project/${PROJECT_ID}`,
    }),
  });

  await assert.rejects(transport.start(), error => {
    assert.equal(error.httpStatus, 401);
    assert.match(error.message, /HTTP 401/);
    return true;
  });
  assert.equal(readStoredCredential().reauthRequired, true);
  assert.doesNotMatch(readStoredCredential().cookieHeader, /(?:^|;\s*)SID=/);
});

test('RPC HTTP 401 retains its status and operation classification after cookie rotation', async () => {
  seedCredential();
  let calls = 0;
  const transport = new FlowHttpTransport({
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return htmlResponse();
      return makeResponse('sign-in response', {
        status: 401,
        mime: 'text/html',
        setCookies: ['SID=rotated; Domain=.google.com; Path=/; Secure'],
        url: `${FLOW_ORIGIN}/_/AiSandboxAngularFrontend/data/batchexecute`,
      });
    },
  });
  await transport.start();

  await assert.rejects(transport.rpc(RPC.projectMedia, '[]'), error => {
    assert.equal(error.httpStatus, 401);
    assert.equal(error.rpcId, RPC.projectMedia);
    assert.match(error.message, /HTTP 401/);
    return true;
  });
  assert.match(readStoredCredential().cookieHeader, /SID=rotated/);
});

test('document redirect diagnostics classify the safe destination and never follow or expose its URL', async () => {
  seedCredential();
  let calls = 0;
  const privateLocation = 'https://accounts.google.com/ServiceLogin?authuser=private-value&continue=https%3A%2F%2Fflow.google.com';
  const transport = new FlowHttpTransport({
    fetchImpl: async (_url, options) => {
      calls += 1;
      assert.equal(options.redirect, 'manual');
      return makeResponse('private-body-marker', {
        status: 302, mime: 'text/html', location: privateLocation,
        url: `${FLOW_ORIGIN}/project/${PROJECT_ID}`,
      });
    },
  });
  await assert.rejects(transport.start(), error => {
    assert.equal(error.httpStatus, 302);
    assert.equal(error.redirectCategory, 'accounts_login');
    assert.equal(error.code, 'FLOW_DOCUMENT_REDIRECT');
    assert.doesNotMatch(error.message, /private-value|private-body-marker|ServiceLogin|continue=/);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(classifyFlowRedirect(`https://flow.google.com/project/${PROJECT_ID}?session=private`), 'flow_project');
  assert.equal(classifyFlowRedirect('https://flow.google.com/?session=private'), 'flow_root');
  assert.equal(classifyFlowRedirect('https://unrelated.example/path?secret=private'), 'other');
});

test('an observed auth-cookie deletion takes priority over HTTP 200 and redirect classification', async t => {
  const deletion = 'SID=; Domain=.google.com; Path=/; Max-Age=0; Secure';
  const cases = [
    ['HTTP 200', () => htmlResponse({ status: 200, setCookies: [deletion] }), 200, null],
    ['HTTP 302 login redirect', () => makeResponse('private response body', {
      status: 302,
      mime: 'text/html',
      setCookies: [deletion],
      location: 'https://accounts.google.com/ServiceLogin?authuser=private&continue=private',
      url: `${FLOW_ORIGIN}/project/${PROJECT_ID}`,
    }), 302, 'accounts_login'],
  ];

  for (const [name, makeResponseValue, status, redirectCategory] of cases) {
    await t.test(name, async () => {
      resetTestCredentialStore();
      seedCredential();
      let calls = 0;
      const transport = new FlowHttpTransport({ fetchImpl: async () => {
        calls += 1;
        return makeResponseValue();
      } });

      await assert.rejects(transport.start(), error => {
        assert.equal(error.code, 'FLOW_DOCUMENT_AUTH_COOKIE_DELETED');
        assert.equal(error.httpStatus, status);
        assert.equal(error.sessionStatus, 'undetermined');
        assert.equal(error.redirectCategory ?? null, redirectCategory);
        assert.equal(error.documentDiagnostics.httpStatus, status);
        assert.doesNotMatch(error.message, /authuser=private|continue=private|private response body/);
        return true;
      });
      assert.equal(calls, 1, 'the redirect is not followed');
      assert.equal(readStoredCredential().reauthRequired, true);
      assert.doesNotMatch(readStoredCredential().cookieHeader, /(?:^|;\s*)SID=/);
    });
  }
});

test('deleting an observed OSID cookie invalidates auth while preserving the HTTP status', async () => {
  const expires = Date.now() / 1000 + 3600;
  seedCredential(credential({
    cookieHeader: undefined,
    cookies: [{ name: 'OSID', value: 'private-osid-value', domain: '.google.com', path: '/', expires, secure: true }],
  }));
  const transport = new FlowHttpTransport({
    fetchImpl: async () => makeResponse('private sign-in body', {
      status: 401,
      mime: 'text/html',
      setCookies: ['OSID=; Domain=.google.com; Path=/; Max-Age=0; Secure'],
      url: `${FLOW_ORIGIN}/project/${PROJECT_ID}`,
    }),
  });
  await assert.rejects(transport.start(), error => {
    assert.equal(error.httpStatus, 401);
    assert.doesNotMatch(error.message, /private-osid-value|private sign-in body/);
    return true;
  });
  assert.equal(readStoredCredential().reauthRequired, true);
  assert.equal(readStoredCredential().cookies.some(cookie => cookie.name === 'OSID'), false);
});

test('direct create rejects extra RPCs, cross-project context, and control characters before POST', async () => {
  seedCredential();
  let calls = 0;
  const transport = new FlowHttpTransport({
    fetchImpl: async (_url, options) => {
      calls += 1;
      if (calls === 1) return htmlResponse();
      throw new Error('A create POST must not be sent for malformed test requests.');
    },
  });
  await transport.start();
  const active = buildTextVideoSubmission({ prompt: 'synthetic', projectId: PROJECT_ID, duration: 8, resolution: '720p' });
  const validFreq = bindCaptchaToken(active.freq, 'synthetic-one-time-input').freq;

  const multiRpc = JSON.parse(validFreq);
  multiRpc[0].push(['as29s', '[]', null, 'generic']);
  await assert.rejects(transport.createVideo(JSON.stringify(multiRpc)), error => error.rejected === true);

  const otherProject = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const crossProject = buildTextVideoSubmission({ prompt: 'synthetic', projectId: otherProject, duration: 8, resolution: '720p' });
  await assert.rejects(transport.createVideo(bindCaptchaToken(crossProject.freq, 'synthetic-other-project').freq), error => error.rejected === true);

  const controlToken = JSON.parse(validFreq);
  const controlPayload = JSON.parse(controlToken[0][0][1]);
  controlPayload[1][10][0] = 'bad\ninput';
  controlToken[0][0][1] = JSON.stringify(controlPayload);
  await assert.rejects(transport.createVideo(JSON.stringify(controlToken)), error => error.rejected === true);
  assert.equal(calls, 1);
});

test('a valid observed generation contract sends one pure HTTP POST to its protected project', async () => {
  seedCredential();
  const mediaId = '11111111-1111-4111-8111-111111111111';
  const responseData = [null, null, null, [[mediaId]]];
  const responseBody = JSON.stringify([['wrb.fr', RPC.generateTextVideo, JSON.stringify(responseData), null, null, null]]);
  const requests = [];
  const transport = new FlowHttpTransport({
    fetchImpl: async (url, options) => {
      requests.push({ url: new URL(url), options });
      if (requests.length === 1) return htmlResponse();
      return makeResponse(responseBody, {
        mime: 'application/json; charset=utf-8',
        url: `${FLOW_ORIGIN}/_/AiSandboxAngularFrontend/data/batchexecute`,
      });
    },
  });
  await transport.start();
  const submission = buildTextVideoSubmission({ prompt: 'synthetic', projectId: PROJECT_ID, duration: 8, resolution: '720p' });
  const freq = bindCaptchaToken(submission.freq, 'synthetic-one-time-input').freq;
  const result = await transport.createVideo(freq);

  assert.equal(result.payload[3][0][0], mediaId);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].options.method, 'POST');
  assert.equal(requests[1].options.redirect, 'manual');
  assert.equal(requests[1].url.searchParams.get('rpcids'), RPC.generateTextVideo);
  assert.equal(requests[1].options.headers.origin, FLOW_ORIGIN);
  assert.equal(requests[1].options.headers.referer, `${FLOW_ORIGIN}/`);
  assert.equal(new URLSearchParams(requests[1].options.body).get('f.req'), freq);
});

test('the explicit absent-input mode accepts only the one-operation active-project request with field 11 omitted', async () => {
  seedCredential();
  const mediaId = '11111111-1111-4111-8111-111111111111';
  const responseData = [null, null, null, [[mediaId]]];
  const responseBody = JSON.stringify([['wrb.fr', RPC.generateTextVideo, JSON.stringify(responseData), null, null, null]]);
  const requests = [];
  const transport = new FlowHttpTransport({
    fetchImpl: async (url, options) => {
      requests.push({ url: new URL(url), options });
      if (requests.length === 1) return htmlResponse();
      return makeResponse(responseBody, {
        mime: 'application/json; charset=utf-8',
        url: `${FLOW_ORIGIN}/_/AiSandboxAngularFrontend/data/batchexecute`,
      });
    },
  });
  await transport.start();
  const submission = buildTextVideoSubmission({ prompt: 'synthetic', projectId: PROJECT_ID, duration: 8, resolution: '720p' });
  const absent = omitGenerationInput(submission.freq).freq;

  await assert.rejects(transport.createVideo(absent), error => error.rejected === true);
  const multiRpc = JSON.parse(absent);
  multiRpc[0].push(['as29s', '[]', null, 'generic']);
  await assert.rejects(transport.createVideo(JSON.stringify(multiRpc), { inputMode: 'absent_probe' }), error => error.rejected === true);
  const crossProject = buildTextVideoSubmission({ prompt: 'synthetic',
    projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', duration: 8, resolution: '720p' });
  await assert.rejects(transport.createVideo(omitGenerationInput(crossProject.freq).freq,
    { inputMode: 'absent_probe' }), error => error.rejected === true);
  const wrongProbeModel = JSON.parse(absent);
  const wrongProbePayload = JSON.parse(wrongProbeModel[0][0][1]);
  wrongProbePayload[0][0][1] = 'abra_t2v_6s';
  wrongProbeModel[0][0][1] = JSON.stringify(wrongProbePayload);
  await assert.rejects(transport.createVideo(JSON.stringify(wrongProbeModel),
    { inputMode: 'absent_probe' }), error => error.rejected === true);
  const extraNullField = JSON.parse(absent);
  const extraPayload = JSON.parse(extraNullField[0][0][1]);
  extraPayload[1].push(null);
  extraNullField[0][0][1] = JSON.stringify(extraPayload);
  await assert.rejects(transport.createVideo(JSON.stringify(extraNullField),
    { inputMode: 'absent_probe' }), error => error.rejected === true);
  assert.equal(requests.length, 1, 'invalid and non-opt-in requests must stop before POST');

  const result = await transport.createVideo(absent, { inputMode: 'absent_probe' });
  assert.equal(result.payload[3][0][0], mediaId);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].options.method, 'POST');
  assert.equal(requests[1].options.redirect, 'manual');
  assert.equal(requests[1].url.searchParams.get('rpcids'), RPC.generateTextVideo);
  const sentFreq = new URLSearchParams(requests[1].options.body).get('f.req');
  assert.equal(sentFreq, absent);
  const sentContext = JSON.parse(JSON.parse(sentFreq)[0][0][1])[1];
  assert.equal(sentContext.length, 10);
  assert.equal(Object.hasOwn(sentContext, 10), false);
});

test('a synthetic candidate ErrorInfo tuple preserves only its allowlisted reason and safe shape diagnostics', async () => {
  seedCredential();
  const responseBody = JSON.stringify([['wrb.fr', RPC.generateTextVideo, null, null, null,
    [7, 'private server message', [['type.googleapis.com/google.rpc.ErrorInfo', [
      'PUBLIC_ERROR_UNUSUAL_ACTIVITY', 'private.example.internal', {
        OWNER_ONLY_KEY: 'secret metadata value', unrelatedReason: 'PUBLIC_ERROR_UNUSUAL_ACTIVITY_TOO_MUCH_TRAFFIC',
      },
    ]]]]]]);
  let calls = 0;
  const transport = new FlowHttpTransport({
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return htmlResponse();
      return makeResponse(responseBody, {
        mime: 'application/json; charset=utf-8',
        url: `${FLOW_ORIGIN}/_/AiSandboxAngularFrontend/data/batchexecute`,
      });
    },
  });
  await transport.start();
  const submission = buildTextVideoSubmission({ prompt: 'synthetic', projectId: PROJECT_ID, duration: 8, resolution: '720p' });
  await assert.rejects(transport.createVideo(bindCaptchaToken(submission.freq, 'synthetic-one-time-input').freq), error => {
    assert.equal(error.code, undefined);
    assert.equal(error.serverCode, undefined);
    assert.equal(error.errorCandidateReason, 'PUBLIC_ERROR_UNUSUAL_ACTIVITY');
    assert.equal(error.errorInfoSchemaVerified, false);
    assert.equal(error.rpcStatus, 7);
    assert.equal(error.httpStatus, 200);
    assert.equal(error.ambiguous, true);
    assert.notEqual(error.rejected, true);
    assert.equal(error.errorMessagePresent, true);
    assert.equal(error.errorInfoPresent, true);
    assert.equal(error.errorInfoCount, 1);
    assert.equal(error.errorDomainPresent, true);
    assert.equal(error.errorMetadataPresent, true);
    assert.equal(error.errorMetadataCount, 2);
    assert.equal(error.errorReasonConflict, false);
    const safeSerialized = JSON.stringify(error);
    for (const forbidden of ['private server message', 'private.example.internal', 'OWNER_ONLY_KEY',
      'secret metadata value', 'unrelatedReason', 'PUBLIC_ERROR_UNUSUAL_ACTIVITY_TOO_MUCH_TRAFFIC']) {
      assert.equal(safeSerialized.includes(forbidden), false, `raw ErrorInfo content leaked: ${forbidden}`);
    }
    return true;
  });
  assert.equal(calls, 2);
});

test('untyped, unknown, and cross-schema RPC error strings do not become server reasons', async t => {
  const frames = [
    { name: 'legacy top-level enum', frame: [7, null, null, null, null, 'PUBLIC_ERROR_UNUSUAL_ACTIVITY'] },
    { name: 'unknown typed reason', frame: [7, null, [['type.googleapis.com/google.rpc.ErrorInfo', ['PUBLIC_ERROR_NEW_UNKNOWN']]]] },
    { name: 'wrong type URL', frame: [7, null, [['type.googleapis.com/example.ErrorInfo', ['PUBLIC_ERROR_UNUSUAL_ACTIVITY']]]] },
    { name: 'object-shaped cross-schema detail', frame: [7, null, [['type.googleapis.com/google.rpc.ErrorInfo', {
      reason: 'PUBLIC_ERROR_UNUSUAL_ACTIVITY', domain: 'must-not-be-read', metadata: { hidden: 'x' },
    }]]] },
    { name: 'malformed domain slot', frame: [7, null, [['type.googleapis.com/google.rpc.ErrorInfo', [
      'PUBLIC_ERROR_UNUSUAL_ACTIVITY', { hiddenDomain: 'do-not-store' }, { hiddenMetadata: 'do-not-store' },
    ]]]] },
    { name: 'malformed metadata slot', frame: [7, null, [['type.googleapis.com/google.rpc.ErrorInfo', [
      'PUBLIC_ERROR_UNUSUAL_ACTIVITY', 'must-not-be-read', [['hiddenKey', 'hiddenValue']],
    ]]]] },
    { name: 'extra candidate slot', frame: [7, null, [['type.googleapis.com/google.rpc.ErrorInfo', [
      'PUBLIC_ERROR_UNUSUAL_ACTIVITY', 'must-not-be-read', { hidden: 'x' }, 'unexpected-slot',
    ]]]] },
  ];
  for (const { name, frame } of frames) {
    await t.test(name, async () => {
      seedCredential();
      const responseBody = JSON.stringify([['wrb.fr', RPC.generateTextVideo, null, null, null, frame]]);
      const transport = new FlowHttpTransport({ fetchImpl: async (_url, options) => options.method === 'GET'
        ? htmlResponse()
        : makeResponse(responseBody, { mime: 'application/json; charset=utf-8',
          url: `${FLOW_ORIGIN}/_/AiSandboxAngularFrontend/data/batchexecute` }) });
      await transport.start();
      const submission = buildTextVideoSubmission({ prompt: 'synthetic', projectId: PROJECT_ID, duration: 8, resolution: '720p' });
      await assert.rejects(transport.createVideo(bindCaptchaToken(submission.freq, 'synthetic-one-time-input').freq), error => {
        assert.equal(error.serverCode, undefined);
        assert.equal(error.rpcStatus, 7);
        assert.equal(error.ambiguous, true);
        assert.equal(error.errorInfoSchemaVerified, name === 'legacy top-level enum' || name === 'wrong type URL'
          ? undefined : false);
        assert.equal(error.errorCandidateReason, undefined);
        const safeSerialized = JSON.stringify(error);
        for (const forbidden of ['must-not-be-read', 'hiddenDomain', 'hiddenMetadata', 'do-not-store',
          'hiddenKey', 'hiddenValue', 'unexpected-slot']) {
          assert.equal(safeSerialized.includes(forbidden), false);
        }
        return true;
      });
    });
  }
});

test('conflicting typed public ErrorInfo reasons are reported without selecting one', async () => {
  seedCredential();
  const responseBody = JSON.stringify([['wrb.fr', RPC.generateTextVideo, null, null, null, [7, null, [
    ['type.googleapis.com/google.rpc.ErrorInfo', ['PUBLIC_ERROR_UNUSUAL_ACTIVITY']],
    ['type.googleapis.com/google.rpc.ErrorInfo', ['PUBLIC_ERROR_UNUSUAL_ACTIVITY_TOO_MUCH_TRAFFIC']],
  ]]]]);
  const transport = new FlowHttpTransport({ fetchImpl: async (_url, options) => options.method === 'GET'
    ? htmlResponse()
    : makeResponse(responseBody, { mime: 'application/json; charset=utf-8',
      url: `${FLOW_ORIGIN}/_/AiSandboxAngularFrontend/data/batchexecute` }) });
  await transport.start();
  const submission = buildTextVideoSubmission({ prompt: 'synthetic', projectId: PROJECT_ID, duration: 8, resolution: '720p' });
  await assert.rejects(transport.createVideo(bindCaptchaToken(submission.freq, 'synthetic-one-time-input').freq), error => {
    assert.equal(error.serverCode, undefined);
    assert.equal(error.errorCandidateReason, undefined);
    assert.equal(error.errorInfoSchemaVerified, false);
    assert.equal(error.errorInfoPresent, true);
    assert.equal(error.errorInfoCount, 2);
    assert.equal(error.errorReasonConflict, true);
    return true;
  });
});

test('the HTTP generation wrapper preserves duplicate-RPC ambiguity code and status', async () => {
  seedCredential();
  let calls = 0;
  const success = ['wrb.fr', RPC.generateTextVideo, JSON.stringify({ accepted: true }), null, null, null];
  const error = ['wrb.fr', RPC.generateTextVideo, null, null, null, [7, null, []]];
  const responseBody = JSON.stringify([success, error]);
  const transport = new FlowHttpTransport({ fetchImpl: async (_url, options) => {
    calls += 1;
    return options.method === 'GET' ? htmlResponse() : makeResponse(responseBody, {
      mime: 'application/json; charset=utf-8',
      url: `${FLOW_ORIGIN}/_/AiSandboxAngularFrontend/data/batchexecute`,
    });
  } });
  await transport.start();
  const submission = buildTextVideoSubmission({ prompt: 'synthetic', projectId: PROJECT_ID, duration: 8, resolution: '720p' });
  await assert.rejects(transport.createVideo(bindCaptchaToken(submission.freq, 'synthetic-one-time-input').freq), failure => {
    assert.equal(failure.code, 'FLOW_RPC_DUPLICATE_RESULT');
    assert.equal(failure.httpStatus, 200);
    assert.equal(failure.ambiguous, true);
    assert.notEqual(failure.rejected, true);
    return true;
  });
  assert.equal(calls, 2, 'the duplicate frame must not trigger another POST');
});

test('duplicate matching RPC frames are ambiguous for success/error and duplicate-success pairs', () => {
  const success = ['wrb.fr', RPC.generateTextVideo, JSON.stringify({ accepted: true }), null, null, null];
  const error = ['wrb.fr', RPC.generateTextVideo, null, null, null, [7, null, []]];
  for (const [name, entries] of [
    ['success and error', [success, error]],
    ['two successes', [success, success]],
  ]) {
    assert.throws(() => getBatchPayload(JSON.stringify(entries), RPC.generateTextVideo, { ambiguousOnMissing: true }),
      errorValue => {
        assert.equal(errorValue.code, 'FLOW_RPC_DUPLICATE_RESULT', name);
        assert.equal(errorValue.rpcId, RPC.generateTextVideo, name);
        assert.equal(errorValue.ambiguous, true, name);
        assert.notEqual(errorValue.rejected, true, name);
        return true;
      });
  }
});

test('post-response generation diagnostics preserve HTTP status for auth deletion, MIME, and body-read failures', async t => {
  const cases = ['auth-cookie-deletion', 'unexpected-mime', 'body-read'];
  for (const kind of cases) {
    await t.test(kind, async () => {
      seedCredential();
      let calls = 0;
      const transport = new FlowHttpTransport({
        fetchImpl: async () => {
          calls += 1;
          if (calls === 1) return htmlResponse();
          if (kind === 'auth-cookie-deletion') return makeResponse('ignored', {
            status: 200,
            mime: 'application/json; charset=utf-8',
            setCookies: ['__Secure-1PSID=; Domain=.google.com; Path=/; Max-Age=0; Secure'],
            url: `${FLOW_ORIGIN}/_/AiSandboxAngularFrontend/data/batchexecute`,
          });
          if (kind === 'unexpected-mime') return makeResponse('ignored', {
            status: 200, mime: 'text/html', url: `${FLOW_ORIGIN}/_/AiSandboxAngularFrontend/data/batchexecute`,
          });
          const brokenBody = new ReadableStream({ start(controller) { controller.error(new Error('synthetic read failure')); } });
          return makeResponse(brokenBody, {
            status: 200, mime: 'application/json; charset=utf-8',
            url: `${FLOW_ORIGIN}/_/AiSandboxAngularFrontend/data/batchexecute`,
          });
        },
      });
      await transport.start();
      const submission = buildTextVideoSubmission({ prompt: 'synthetic', projectId: PROJECT_ID, duration: 8, resolution: '720p' });
      await assert.rejects(transport.createVideo(bindCaptchaToken(submission.freq, 'synthetic-one-time-input').freq), error => {
        assert.equal(error.httpStatus, 200);
        assert.equal(error.ambiguous, true);
        return true;
      });
      assert.equal(calls, 2);
    });
  }
});
