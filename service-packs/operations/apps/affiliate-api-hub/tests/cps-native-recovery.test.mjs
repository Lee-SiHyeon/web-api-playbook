import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectNativeRecovery,
  readNativePage,
  validateDestination,
  parseOhouseStream,
  parseKbbookBooks,
  decodeTurbo,
  isPublicIpv4,
  isPublicIpv6,
  isPublicIp,
  merchantIds,
  nativeRecoveryMerchants,
} from '../adapters/cps-vendors/agy-native-recovery.mjs';
import { nativeRecoveryAllowed, independentRefreshAllowed } from '../scripts/cps-reverify.mjs';

test('nativeRecoveryAllowed guard enforces strict evidence, approved root origin, and rejection/challenge denial', () => {
  const ohouseAdapter = { nativeRecoveryMerchants: ['ohouse'] };
  const kbbookAdapter = { nativeRecoveryMerchants: ['kbbook'] };
  const genericAdapter = { nativeRecoveryMerchants: ['ohouse', 'kbbook'] };
  const unconfiguredAdapter = {};

  const validOhouseReceipt = {
    id: 'rec-ohouse-root-200',
    requestUrl: 'https://ohou.se/',
    responseStatus: 200,
    responseSha256: '0e5f40701c5c6b7c5efda643d9eb7897d48980e86a4c98373df7b2a99d0269ab',
    observedAt: '2026-09-27T12:04:10.572Z',
    browserUsed: false,
    cookiesSent: false,
    authorizationSent: false,
    transport: 'native_recovery_fetch',
  };

  const validOhouseRecord = {
    type: 'RetailProduct',
    sourceLocalId: '3345612',
    title: '매트리스 모음전',
    evidence: [
      {
        receiptId: 'rec-ohouse-root-200',
        locator: 'script:window.__reactRouterContext:streamController.enqueue:production[id=3345612]',
        fields: ['sourceLocalId', 'title', 'price'],
      },
    ],
  };

  const validKbbookReceipt = {
    id: 'rec-kbbook-root-200',
    requestUrl: 'https://www.kyobobook.co.kr/',
    responseStatus: 200,
    responseSha256: '7871b8af96c2896283c40d3e07a8f4139cfd297d6d7aeb242af9d295b49d4a2c',
    observedAt: '2026-09-27T12:04:11.598Z',
    browserUsed: false,
    cookiesSent: false,
    authorizationSent: false,
    transport: 'native_recovery_fetch',
  };

  const validKbbookRecord = {
    type: 'RetailProduct',
    sourceLocalId: 'S000221075112',
    title: '머니 트렌드 2027',
    evidence: [
      {
        receiptId: 'rec-kbbook-root-200',
        locator: 'script:self.__next_f:saleCmdtid=S000221075112',
        fields: ['sourceLocalId', 'title', 'price'],
      },
    ],
  };

  const priorValidReportOhouse = {
    receipts: [validOhouseReceipt],
    records: [validOhouseRecord],
  };

  const priorValidReportKbbook = {
    receipts: [validKbbookReceipt],
    records: [validKbbookRecord],
  };

  // 1. Approved merchants pass when root receipt is valid and linked by evidence
  assert.equal(nativeRecoveryAllowed('ohouse', ohouseAdapter, priorValidReportOhouse), true);
  assert.equal(nativeRecoveryAllowed('kbbook', kbbookAdapter, priorValidReportKbbook), true);
  assert.equal(nativeRecoveryAllowed('ohouse', genericAdapter, priorValidReportOhouse), true);
  assert.equal(nativeRecoveryAllowed('kbbook', genericAdapter, priorValidReportKbbook), true);

  // 2. Unapproved merchants rejected
  assert.equal(nativeRecoveryAllowed('stories', genericAdapter, priorValidReportOhouse), false);
  assert.equal(nativeRecoveryAllowed('coskr', genericAdapter, priorValidReportOhouse), false);
  assert.equal(nativeRecoveryAllowed('gmarket', genericAdapter, priorValidReportOhouse), false);
  assert.equal(nativeRecoveryAllowed('unknown', genericAdapter, priorValidReportOhouse), false);

  // 3. Missing adapter capability rejected
  assert.equal(nativeRecoveryAllowed('ohouse', unconfiguredAdapter, priorValidReportOhouse), false);
  assert.equal(nativeRecoveryAllowed('kbbook', unconfiguredAdapter, priorValidReportKbbook), false);
  assert.equal(nativeRecoveryAllowed('ohouse', kbbookAdapter, priorValidReportOhouse), false);

  // 4. Denies if no previous report, no receipts, or no records
  assert.equal(nativeRecoveryAllowed('ohouse', ohouseAdapter, null), false);
  assert.equal(nativeRecoveryAllowed('ohouse', ohouseAdapter, { receipts: [] }), false);
  assert.equal(nativeRecoveryAllowed('ohouse', ohouseAdapter, { receipts: [validOhouseReceipt], records: [] }), false);

  // 5. Denies if root receipt URL is not the exact approved root URL
  const wrongOriginReport = {
    receipts: [{ ...validOhouseReceipt, requestUrl: 'https://store.ohou.se/' }],
    records: [validOhouseRecord],
  };
  assert.equal(nativeRecoveryAllowed('ohouse', ohouseAdapter, wrongOriginReport), false);

  // 6. Denies if receipt was credentialed, used browser, or used cookies
  assert.equal(nativeRecoveryAllowed('ohouse', ohouseAdapter, {
    receipts: [{ ...validOhouseReceipt, browserUsed: true }],
    records: [validOhouseRecord],
  }), false);
  assert.equal(nativeRecoveryAllowed('ohouse', ohouseAdapter, {
    receipts: [{ ...validOhouseReceipt, cookiesSent: true }],
    records: [validOhouseRecord],
  }), false);
  assert.equal(nativeRecoveryAllowed('ohouse', ohouseAdapter, {
    receipts: [{ ...validOhouseReceipt, authorizationSent: true }],
    records: [validOhouseRecord],
  }), false);

  // 7. Denies if receipt is undated or hashless
  assert.equal(nativeRecoveryAllowed('ohouse', ohouseAdapter, {
    receipts: [{ ...validOhouseReceipt, observedAt: null }],
    records: [validOhouseRecord],
  }), false);
  assert.equal(nativeRecoveryAllowed('ohouse', ohouseAdapter, {
    receipts: [{ ...validOhouseReceipt, responseSha256: null }],
    records: [validOhouseRecord],
  }), false);

  // 8. Denies if records do not link to receipt with both sourceLocalId and title fields
  const unlinkedReport = {
    receipts: [validOhouseReceipt],
    records: [{
      type: 'RetailProduct',
      sourceLocalId: '123',
      title: 'Item',
      evidence: [{ receiptId: 'other-receipt', fields: ['sourceLocalId', 'title'] }],
    }],
  };
  assert.equal(nativeRecoveryAllowed('ohouse', ohouseAdapter, unlinkedReport), false);

  const missingTitleFieldReport = {
    receipts: [validOhouseReceipt],
    records: [{
      type: 'RetailProduct',
      sourceLocalId: '123',
      title: 'Item',
      evidence: [{ receiptId: 'rec-ohouse-root-200', fields: ['sourceLocalId'] }],
    }],
  };
  assert.equal(nativeRecoveryAllowed('ohouse', ohouseAdapter, missingTitleFieldReport), false);

  // 9. Stops on fresh native recovery rejection
  const freshNativeRejectionReport = {
    receipts: [
      validOhouseReceipt,
      {
        id: 'fresh-rejection',
        responseStatus: 403,
        requestUrl: 'https://ohou.se/',
        transport: 'native_recovery_fetch',
      },
    ],
    records: [validOhouseRecord],
  };
  assert.equal(nativeRecoveryAllowed('ohouse', ohouseAdapter, freshNativeRejectionReport), false);

  // 10. Stops on 200 challenge
  const challengeReport = {
    receipts: [
      {
        ...validOhouseReceipt,
        stopReason: 'VISIBLE_CHALLENGE',
      },
    ],
    records: [validOhouseRecord],
  };
  assert.equal(nativeRecoveryAllowed('ohouse', ohouseAdapter, challengeReport), false);

  // 11. Stops if another transport was rejected in the same run
  const sameRunRejectionReport = {
    receipts: [
      validOhouseReceipt,
      {
        id: 'other-transport-rej',
        responseStatus: 403,
        transport: 'shared_public_page_reader',
        sameRunRejection: true,
      },
    ],
    records: [validOhouseRecord],
  };
  assert.equal(nativeRecoveryAllowed('ohouse', ohouseAdapter, sameRunRejectionReport), false);

  // 12. Denies if transport is not native_recovery_fetch
  assert.equal(nativeRecoveryAllowed('ohouse', ohouseAdapter, {
    receipts: [{ ...validOhouseReceipt, transport: 'shared_public_page_reader' }],
    records: [validOhouseRecord],
  }), false);
  assert.equal(nativeRecoveryAllowed('ohouse', ohouseAdapter, {
    receipts: [{ ...validOhouseReceipt, transport: null }],
    records: [validOhouseRecord],
  }), false);

  // 13. Denies if responseSha256 is not exactly 64-char hex
  assert.equal(nativeRecoveryAllowed('ohouse', ohouseAdapter, {
    receipts: [{ ...validOhouseReceipt, responseSha256: 'mock-sha' }],
    records: [validOhouseRecord],
  }), false);
  assert.equal(nativeRecoveryAllowed('ohouse', ohouseAdapter, {
    receipts: [{ ...validOhouseReceipt, responseSha256: '0e5f' }],
    records: [validOhouseRecord],
  }), false);
  assert.equal(nativeRecoveryAllowed('ohouse', ohouseAdapter, {
    receipts: [{ ...validOhouseReceipt, responseSha256: '0e5f40701c5c6b7c5efda643d9eb7897d48980e86a4c98373df7b2a99d0269ag' }],
    records: [validOhouseRecord],
  }), false);

  // 14. Denies if any stopReason is present
  assert.equal(nativeRecoveryAllowed('ohouse', ohouseAdapter, {
    receipts: [{ ...validOhouseReceipt, stopReason: 'REQUEST_TIMEOUT' }],
    records: [validOhouseRecord],
  }), false);
  assert.equal(nativeRecoveryAllowed('ohouse', ohouseAdapter, {
    receipts: [{ ...validOhouseReceipt, stopReason: 'RESPONSE_BODY_FAILED' }],
    records: [validOhouseRecord],
  }), false);

  // 15. Denies if finalUrl does not match approved root URL
  assert.equal(nativeRecoveryAllowed('ohouse', ohouseAdapter, {
    receipts: [{ ...validOhouseReceipt, finalUrl: 'https://store.ohou.se/' }],
    records: [validOhouseRecord],
  }), false);
  // Passes if finalUrl matches approved root URL
  assert.equal(nativeRecoveryAllowed('ohouse', ohouseAdapter, {
    receipts: [{ ...validOhouseReceipt, finalUrl: 'https://ohou.se/' }],
    records: [validOhouseRecord],
  }), true);

  // 16. Denies if evidence locator is empty or whitespace
  assert.equal(nativeRecoveryAllowed('ohouse', ohouseAdapter, {
    receipts: [validOhouseReceipt],
    records: [{ ...validOhouseRecord, evidence: [{ receiptId: 'rec-ohouse-root-200', locator: '', fields: ['sourceLocalId', 'title'] }] }],
  }), false);
  assert.equal(nativeRecoveryAllowed('ohouse', ohouseAdapter, {
    receipts: [validOhouseReceipt],
    records: [{ ...validOhouseRecord, evidence: [{ receiptId: 'rec-ohouse-root-200', locator: '   ', fields: ['sourceLocalId', 'title'] }] }],
  }), false);
  assert.equal(nativeRecoveryAllowed('ohouse', ohouseAdapter, {
    receipts: [validOhouseReceipt],
    records: [{ ...validOhouseRecord, evidence: [{ receiptId: 'rec-ohouse-root-200', locator: null, fields: ['sourceLocalId', 'title'] }] }],
  }), false);

  // Independent refresh rules for Coupang, Naver, and SSG remain untouched
  const independentAdapter = { refreshableAfterPublicBlockMerchants: ['coupang', 'nbtnaver', 'emart'] };
  assert.equal(independentRefreshAllowed('coupang', independentAdapter, { receipts: [{ status: 403, requestUrl: 'https://www.coupang.com/' }] }), true);
  assert.equal(independentRefreshAllowed('emart', independentAdapter, { receipts: [{ status: 403, requestUrl: 'https://www.ssg.com/' }] }), true);
  assert.equal(independentRefreshAllowed('nbtnaver', independentAdapter, { receipts: [{ status: 403, requestUrl: 'https://smartstore.naver.com/' }] }), true);
});

test('decodeTurbo reconstructs object graphs and prevents prototype pollution without eval/Function', () => {
  const flat = [
    { _1: 2, _3: 4, _5: 6 },
    'title', 'Test Product',
    'price', 15000,
    'tags', [7],
    'sale',
  ];
  const decoded = decodeTurbo(flat);
  assert.deepEqual(decoded, {
    title: 'Test Product',
    price: 15000,
    tags: ['sale'],
  });

  // Malicious prototype pollution payload
  const malicious = [
    { _1: 2, _3: 4, _5: 6 },
    '__proto__', { _7: 8 },
    'constructor', { _7: 8 },
    'prototype', { _7: 8 },
    'polluted', 'yes',
  ];
  const safeDecoded = decodeTurbo(malicious);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(safeDecoded?.polluted, undefined);
});

test('parseOhouseStream preserves ID/title without invented URL or currency/priceText', () => {
  const productObj = {
    _1: 2, _3: 4, _5: 6, _7: 8, _9: 10, _11: 12, _13: 14,
  };
  const streamArray = [
    { _15: 16 }, // 0: root
    'id', 987654, // 1, 2
    'name', '고밀도 푹신 워셔블 실내화 룸슈즈', // 3, 4
    'selling_price', 12900, // 5, 6
    'original_price', 25000, // 7, 8
    'review_avg', 4.85, // 9, 10
    'review_count', 3200, // 11, 12
    'brand_name', '홈앤리빙', // 13, 14
    'loaderData', { _17: 18 }, // 15, 16
    'pages/index.page', { _19: [productObj] }, // 17, 18
    'products', // 19
  ];
  const streamArg = JSON.stringify(JSON.stringify(streamArray));
  const mockHtml = `
    <!DOCTYPE html>
    <html>
      <head><title>오늘의집</title></head>
      <body>
        <script>
          window.__reactRouterContext = {};
          window.__reactRouterContext.streamController = {
            enqueue: function() {}
          };
          window.__reactRouterContext.streamController.enqueue(${streamArg});
        </script>
      </body>
    </html>
  `;

  const records = parseOhouseStream(mockHtml, 'test-receipt-ohouse');
  assert.equal(records.length, 1);
  const r = records[0];
  assert.equal(r.type, 'RetailProduct');
  assert.equal(r.sourceLocalId, '987654');
  assert.equal(r.title, '고밀도 푹신 워셔블 실내화 룸슈즈');
  // URL, currency, priceText must NOT be fabricated from ID / amount
  assert.equal(r.url, null);
  assert.equal(r.brand, '홈앤리빙');
  assert.deepEqual(r.price, {
    amount: 12900,
    currency: null,
    priceText: null,
    listAmount: 25000,
    priceKind: 'displayed_sale_price',
  });
  assert.deepEqual(r.rating, {
    value: 4.85,
    best: null,
    worst: null,
    reviewCount: 3200,
    ratingCount: null,
  });
  assert.equal(r.evidence[0].receiptId, 'test-receipt-ohouse');
  assert.equal(r.evidence[0].locator, 'script:window.__reactRouterContext:streamController.enqueue:production[id=987654]');
  // Evidence fields must NOT include 'url'
  assert.deepEqual(r.evidence[0].fields, ['sourceLocalId', 'title', 'price', 'rating', 'brand']);
});

test('parseKbbookBooks preserves ID/title without invented URL or currency/priceText', () => {
  const bookPayload = {
    id: '101',
    saleCmdtid: 'S000299999999',
    cmdtCode: '9791199999999',
    cmdtName: '트렌드 코리아 2027',
    discountPrice: 19800,
    saleCmdtSapr: 19800,
    pbcmName: '미래의창',
    mdChoice: {
      title: '새로운 시대를 여는 열쇳말',
      description: '불확실성의 파도를 넘는 대한민국 소비 트렌드 전망',
    },
  };
  const pushContent = JSON.stringify(`14:{"items":[${JSON.stringify(bookPayload)}]}`);
  const mockHtml = `
    <!DOCTYPE html>
    <html>
      <head><title>교보문고</title></head>
      <body>
        <script>
          self.__next_f.push([1,${pushContent}])
        </script>
      </body>
    </html>
  `;

  const books = parseKbbookBooks(mockHtml, 'test-receipt-kbbook');
  assert.equal(books.length, 1);
  const b = books[0];
  assert.equal(b.type, 'RetailProduct');
  assert.equal(b.sourceLocalId, 'S000299999999');
  assert.equal(b.title, '트렌드 코리아 2027');
  // URL, currency, priceText must NOT be fabricated from ID / amount
  assert.equal(b.url, null);
  assert.equal(b.brand, '미래의창');
  assert.equal(b.description, '불확실성의 파도를 넘는 대한민국 소비 트렌드 전망');
  assert.deepEqual(b.price, {
    amount: 19800,
    currency: null,
    priceText: null,
    priceKind: 'displayed_discount_price',
  });
  assert.equal(b.evidence[0].receiptId, 'test-receipt-kbbook');
  assert.equal(b.evidence[0].locator, 'script:self.__next_f:saleCmdtid=S000299999999');
  // Evidence fields must NOT include 'url'
  assert.deepEqual(b.evidence[0].fields, ['sourceLocalId', 'title', 'price', 'brand', 'description']);
});

test('validateDestination rejects unsupported, credentialed, private, and downgraded origins', async () => {
  const approvedOrigin = 'https://ohou.se';

  // Approved public destination
  const mockPublicLookup = async () => [{ address: '104.18.2.1', family: 4 }];
  const validCheck = await validateDestination(new URL('https://ohou.se/'), approvedOrigin, mockPublicLookup);
  assert.equal(validCheck.ok, true);

  // Scheme rejected
  const httpCheck = await validateDestination(new URL('http://ohou.se/'), approvedOrigin, mockPublicLookup);
  assert.equal(httpCheck.ok, false);
  assert.equal(httpCheck.stopReason, 'HTTPS_SCHEME_REQUIRED');

  // Origin mismatch rejected
  const otherOriginCheck = await validateDestination(new URL('https://store.ohou.se/'), approvedOrigin, mockPublicLookup);
  assert.equal(otherOriginCheck.ok, false);
  assert.equal(otherOriginCheck.stopReason, 'ORIGIN_REJECTED');

  // Credentials rejected
  const credCheck = await validateDestination(new URL('https://user:pass@ohou.se/'), approvedOrigin, mockPublicLookup);
  assert.equal(credCheck.ok, false);
  assert.equal(credCheck.stopReason, 'URL_CREDENTIALS_REJECTED');

  // Nonstandard port rejected
  const portCheck = await validateDestination(new URL('https://ohou.se:8443/'), approvedOrigin, mockPublicLookup);
  assert.equal(portCheck.ok, false);
  assert.equal(portCheck.stopReason, 'NONSTANDARD_PORT_REJECTED');

  // Private IPv4 directly rejected
  assert.equal(isPublicIpv4('127.0.0.1'), false);
  assert.equal(isPublicIpv4('10.0.0.1'), false);
  assert.equal(isPublicIpv4('192.168.1.1'), false);
  assert.equal(isPublicIpv4('169.254.1.1'), false);
  assert.equal(isPublicIpv4('172.16.0.1'), false);
  assert.equal(isPublicIpv4('104.18.2.1'), true);

  // DNS resolving to private IP rejected
  const mockPrivateLookup = async () => [{ address: '127.0.0.1', family: 4 }];
  const privateDnsCheck = await validateDestination(new URL('https://ohou.se/'), approvedOrigin, mockPrivateLookup);
  assert.equal(privateDnsCheck.ok, false);
  assert.equal(privateDnsCheck.stopReason, 'NON_PUBLIC_ADDRESS_REJECTED');

  // IPv6 public/private address checks
  assert.equal(isPublicIpv6('::1'), false);
  assert.equal(isPublicIpv6('::'), false);
  assert.equal(isPublicIpv6('fe80::1'), false);
  assert.equal(isPublicIpv6('fc00::1'), false);
  assert.equal(isPublicIpv6('2001:db8::1'), false);
  assert.equal(isPublicIpv6('2002::1'), false);
  assert.equal(isPublicIpv6('2606:4700:4700::1111'), true);
  assert.equal(isPublicIpv6('2001:4860:4860::8888'), true);

  assert.equal(isPublicIp('127.0.0.1'), false);
  assert.equal(isPublicIp('104.18.2.1'), true);
  assert.equal(isPublicIp('::1'), false);
  assert.equal(isPublicIp('2606:4700:4700::1111'), true);

  // public v4 + private v6 rejected
  const mockPublicV4PrivateV6 = async () => [
    { address: '104.18.2.1', family: 4 },
    { address: 'fe80::1', family: 6 },
  ];
  const mixedPrivateCheck = await validateDestination(new URL('https://ohou.se/'), approvedOrigin, mockPublicV4PrivateV6);
  assert.equal(mixedPrivateCheck.ok, false);
  assert.equal(mixedPrivateCheck.stopReason, 'NON_PUBLIC_ADDRESS_REJECTED');

  // public v4 + public v6 allowed
  const mockPublicV4PublicV6 = async () => [
    { address: '104.18.2.1', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
  ];
  const mixedPublicCheck = await validateDestination(new URL('https://ohou.se/'), approvedOrigin, mockPublicV4PublicV6);
  assert.equal(mixedPublicCheck.ok, true);

  // public v6 only allowed
  const mockPublicV6Only = async () => [
    { address: '2606:4700:4700::1111', family: 6 },
  ];
  const v6OnlyCheck = await validateDestination(new URL('https://ohou.se/'), approvedOrigin, mockPublicV6Only);
  assert.equal(v6OnlyCheck.ok, true);
});

test('readNativePage caps request budget across redirects and preserves unread bytes as null', async () => {
  const approvedOrigin = 'https://ohou.se';
  const mockPublicLookup = async () => [{ address: '104.18.2.1', family: 4 }];

  // Budget capped: budget of 2 with 2 redirects stops on exhaustion
  let callCount = 0;
  const mockFetchInfiniteRedirect = async (url) => {
    callCount += 1;
    return {
      status: 301,
      headers: new Headers({
        location: `https://ohou.se/hop-${callCount}`,
      }),
      body: {
        cancel: async () => {},
      },
    };
  };

  const budgetResult = await readNativePage('https://ohou.se/', approvedOrigin, {
    budget: 2,
    fetchFn: mockFetchInfiniteRedirect,
    lookupFn: mockPublicLookup,
  });

  assert.equal(budgetResult.ok, false);
  assert.equal(budgetResult.stopReason, 'REQUEST_BUDGET_EXHAUSTED');
  assert.equal(callCount, 2);
  assert.equal(budgetResult.receipts.length, 2);
  // Unread redirect responses must record bytes as null (not 0)
  for (const r of budgetResult.receipts) {
    assert.equal(r.bytes, null);
    assert.equal(r.responseStatus, 301);
  }

  // Downgrade redirect rejected
  const mockFetchDowngrade = async () => ({
    status: 301,
    headers: new Headers({ location: 'http://ohou.se/insecure' }),
    body: { cancel: async () => {} },
  });

  const downgradeResult = await readNativePage('https://ohou.se/', approvedOrigin, {
    budget: 4,
    fetchFn: mockFetchDowngrade,
    lookupFn: mockPublicLookup,
  });
  assert.equal(downgradeResult.ok, false);
  assert.equal(downgradeResult.stopReason, 'REDIRECT_HTTPS_DOWNGRADE_REJECTED');

  // Redirect outside approved origin rejected
  const mockFetchOutside = async () => ({
    status: 302,
    headers: new Headers({ location: 'https://evil.com/phish' }),
    body: { cancel: async () => {} },
  });

  const outsideResult = await readNativePage('https://ohou.se/', approvedOrigin, {
    budget: 4,
    fetchFn: mockFetchOutside,
    lookupFn: mockPublicLookup,
  });
  assert.equal(outsideResult.ok, false);
  assert.equal(outsideResult.stopReason, 'REDIRECT_OUTSIDE_ALLOWED_ORIGIN');
});

test('readNativePage stops on 403 without fallback and detects 200 visible challenge', async () => {
  const approvedOrigin = 'https://ohou.se';
  const mockPublicLookup = async () => [{ address: '104.18.2.1', family: 4 }];

  // 403 Stop without fallback
  const mockFetch403 = async () => ({
    status: 403,
    headers: new Headers({ 'content-type': 'text/html' }),
    body: { cancel: async () => {} },
  });

  const blockedResult = await readNativePage('https://ohou.se/', approvedOrigin, {
    fetchFn: mockFetch403,
    lookupFn: mockPublicLookup,
  });
  assert.equal(blockedResult.ok, false);
  assert.equal(blockedResult.blocked, true);
  assert.equal(blockedResult.stopReason, 'HTTP_ACCESS_BLOCKED');
  assert.equal(blockedResult.receipts[0].responseStatus, 403);
  assert.equal(blockedResult.receipts[0].bytes, null);

  // 200 Visible Challenge detected and tagged
  const mockChallengeHtml = `
    <!DOCTYPE html>
    <html>
      <head><title>Attention Required! | Cloudflare</title></head>
      <body>
        <h1>Please verify you are a human</h1>
      </body>
    </html>
  `;
  const challengeBytes = new TextEncoder().encode(mockChallengeHtml);
  let read = false;
  const mockFetchChallenge = async () => ({
    status: 200,
    headers: new Headers({
      'content-type': 'text/html; charset=utf-8',
      'cf-mitigated': 'challenge',
    }),
    body: {
      getReader: () => ({
        read: async () => {
          if (read) return { done: true, value: undefined };
          read = true;
          return { done: false, value: challengeBytes };
        },
        cancel: async () => {},
      }),
    },
  });

  const challengeResult = await readNativePage('https://ohou.se/', approvedOrigin, {
    fetchFn: mockFetchChallenge,
    lookupFn: mockPublicLookup,
  });
  assert.equal(challengeResult.ok, false);
  assert.equal(challengeResult.blocked, true);
  assert.equal(challengeResult.stopReason, 'VISIBLE_CHALLENGE');
  assert.equal(challengeResult.receipts[0].stopReason, 'VISIBLE_CHALLENGE');
});

test('collectNativeRecovery operates on root embedded catalog only and validates merchant IDs', async () => {
  await assert.rejects(
    () => collectNativeRecovery('invalid_merchant'),
    /MERCHANT_NOT_IN_NATIVE_RECOVERY:invalid_merchant/
  );

  const emptyFixture = {
    ok: true,
    status: 200,
    contentType: 'text/html; charset=utf-8',
    url: 'https://ohou.se/',
    html: '<html><body>No data</body></html>',
    redirects: [],
    receipts: [
      {
        id: 'mock-root-ohouse',
        requestUrl: 'https://ohou.se/',
        responseStatus: 200,
        contentType: 'text/html; charset=utf-8',
        bytes: 100,
        responseSha256: 'mock-sha',
        observedAt: '2026-09-27T12:00:00.000Z',
        browserUsed: false,
        cookiesSent: false,
        authorizationSent: false,
        transport: 'native_recovery_fetch',
      },
    ],
  };

  const report = await collectNativeRecovery('ohouse', {
    fixture: emptyFixture,
    now: () => new Date('2026-09-27T12:00:00.000Z'),
  });

  assert.equal(report.merchantId, 'ohouse');
  assert.equal(report.siteUrl, 'https://ohou.se/');
  assert.equal(report.status, 'reachable_no_normalized_records');
  assert.equal(report.records.length, 0);

  // Product detail is not followed; operations.product_detail is not_observed
  assert.equal(report.operations.product_detail.state, 'not_observed');

  // Adapter does NOT inject historical rejection into receipts
  assert.equal(report.receipts.length, 1);
  assert.equal(report.receipts[0].id, 'mock-root-ohouse');
  assert.equal(report.receipts[0].browserUsed, false);
  assert.equal(report.receipts[0].cookiesSent, false);
  assert.equal(report.receipts[0].authorizationSent, false);
});
