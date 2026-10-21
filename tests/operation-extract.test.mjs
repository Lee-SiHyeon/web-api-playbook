import test from 'node:test';
import assert from 'node:assert/strict';
import { extractOperationResponse } from '../lib/operation-extract.mjs';

// All responses are synthetic in-memory fixtures. No HTTP, browser, or service.
const response = (raw, extra = {}) => ({ status: 200, headers: {}, raw,
  url: 'https://example.invalid/catalog/list?page=1', ...extra });
const htmlConfig = extra => ({ format: 'html', html: { items: '.item',
  fields: { title: { selector: '.title', required: true } }, ...extra } });
const ssrConfig = extra => ({ format: 'ssr_json', ssr: { key: '__NEXT_DATA__', ...extra } });
const script = (raw, attributes = 'id="__NEXT_DATA__" type="application/json"') => `<script ${attributes}>${raw}</script>`;
const bodyLimit = 4 * 1024 * 1024;

function fails(code, fn) {
  assert.throws(fn, error => {
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.match(error.code, /^[A-Z][A-Z0-9_]+$/);
    assert.equal(error.cause, undefined);
    assert.deepEqual(Object.keys(error), ['code']);
    return true;
  });
}

test('defaults to JSON and preserves the result envelope without mutating arguments', () => {
  const input = Object.freeze(response('{"rows":[1,2],"hasMore":false}'));
  const config = Object.freeze({ requiredPointers: Object.freeze(['/rows/0', '/hasMore']) });
  assert.deepEqual(extractOperationResponse(input, config), {
    format: 'json', data: { rows: [1, 2], hasMore: false }, pageInfo: {},
  });
  assert.deepEqual(extractOperationResponse(response('\uFEFF{"ok":true}')).data, { ok: true });
});

test('JSON pointers support the root, escaped keys, empty keys, arrays, and present null/falsy values', () => {
  const data = { 'a/b': { '~key': [null, false, 0, ''] }, '': { leaf: true }, '~1': 'literal' };
  assert.deepEqual(extractOperationResponse(response(JSON.stringify(data)), {
    format: 'json', requiredPointers: ['', '/a~1b/~0key/0', '/a~1b/~0key/1',
      '/a~1b/~0key/2', '/a~1b/~0key/3', '//leaf', '/~01'],
  }), { format: 'json', data, pageInfo: {} });
  for (const raw of ['null', 'false', '0', '""', '[]']) {
    assert.deepEqual(extractOperationResponse(response(raw), { requiredPointers: [''] }).data, JSON.parse(raw));
  }
});

test('JSON required pointer mismatches fail, without coercion or inherited properties', () => {
  const raw = '{"rows":[{"id":7}],"value":null,"text":"abc"}';
  for (const pointer of ['/absent', '/rows/1', '/rows/01', '/rows/-', '/rows/length',
    '/rows/0/missing', '/value/child', '/text/0', '/constructor', '/toString']) {
    fails('EXTRACT_REQUIRED_MISSING', () => extractOperationResponse(response(raw), { requiredPointers: [pointer] }));
  }
  const own = '{"__proto__":{"constructor":3}}';
  assert.deepEqual(extractOperationResponse(response(own), { requiredPointers: ['/__proto__/constructor'] }).data, JSON.parse(own));
});

test('malformed JSON fails with a stable code, without including body content', () => {
  for (const raw of ['', ' ', '{"PRIVATE_FIXTURE":"value",}', '<html>PRIVATE_FIXTURE</html>',
    'window.value = {"ok":true};', '{"ok":true} {"again":true}', '[1,]']) {
    fails('EXTRACT_JSON_INVALID', () => extractOperationResponse(response(raw)));
  }
});

test('invalid JSON pointer declarations fail before parsing', () => {
  for (const pointer of ['plain', '#/a', '/bad~', '/bad~2', '/bad~01~3', 3, null]) {
    fails('EXTRACT_CONFIG_INVALID', () => extractOperationResponse(response('{'), { requiredPointers: [pointer] }));
  }
  for (const requiredPointers of [null, {}, '/a', new Array(1)]) {
    fails('EXTRACT_CONFIG_INVALID', () => extractOperationResponse(response('{}'), { requiredPointers }));
  }
});

test('text is returned verbatim and empty responses have null data', () => {
  const raw = '  Fixture\ntext <not-markup>\r\n';
  assert.deepEqual(extractOperationResponse(response(raw), { format: 'text' }), { format: 'text', data: raw, pageInfo: {} });
  for (const raw of ['', ' \r\n\t']) {
    assert.deepEqual(extractOperationResponse(response(raw, { status: 204 }), { format: 'empty' }), {
      format: 'empty', data: null, pageInfo: {},
    });
  }
  fails('EXTRACT_EMPTY_MISMATCH', () => extractOperationResponse(response('PRIVATE_FIXTURE'), { format: 'empty' }));
});

test('extraction is independent of HTTP status, headers, and registry/transport policy', () => {
  assert.deepEqual(extractOperationResponse(response('{"problem":true}', {
    status: 400, headers: { 'content-type': 'application/problem+json' },
  })), { format: 'json', data: { problem: true }, pageInfo: {} });
});

test('HTML extracts repeated records, normalized text, attributes, and optional nulls', () => {
  const raw = `<article class="item" data-id=" 1 "><h2 class="title"> Alpha &amp;\n <b>Beta</b> </h2>
      <a class="link" href="/products/1?x=1&amp;y=2">Open</a><span class="blank"> </span></article>
    <article class="item" data-id="2"><h2 class="title">Second</h2><a class="link">Open</a></article>`;
  const config = htmlConfig({ fields: {
    id: { selector: ':scope', attribute: 'data-id', required: true },
    title: { selector: '.title', required: true },
    link: { selector: '.link', attribute: 'href' },
    absent: { selector: '.absent' }, blank: { selector: '.blank' },
  } });
  const before = JSON.stringify(config);
  assert.deepEqual(extractOperationResponse(response(raw), config), {
    format: 'html', data: [
      { id: '1', title: 'Alpha & Beta', link: '/products/1?x=1&y=2', absent: null, blank: null },
      { id: '2', title: 'Second', link: null, absent: null, blank: null },
    ], pageInfo: {},
  });
  assert.equal(JSON.stringify(config), before);
});

test('HTML field and page maps preserve arbitrary own field names', () => {
  const fields = JSON.parse('{"__proto__":{"selector":".title"},"constructor":{"selector":".title"}}');
  const output = extractOperationResponse(response('<div class="item"><b class="title">ok</b></div>'),
    htmlConfig({ fields, page: fields }));
  const expected = JSON.parse('{"__proto__":"ok","constructor":"ok"}');
  assert.deepEqual(output.data, [expected]);
  assert.deepEqual(output.pageInfo, expected);
  assert.equal(Object.getPrototypeOf(output.data[0]), Object.prototype);
});

test('HTML selectors remain record-scoped, including :scope child selectors', () => {
  const raw = '<b class="title">outside</b><div class="item"><b class="title">first</b></div>'
    + '<div class="item"><b class="title">second</b></div>';
  assert.deepEqual(extractOperationResponse(response(raw), htmlConfig({
    fields: { title: { selector: ':scope > .title', required: true } },
  })).data, [{ title: 'first' }, { title: 'second' }]);
});

test('HTML page fields are document-scoped and relative HTTP next links use response.url', () => {
  const raw = `<base href="https://ignored.invalid/"><div class="item"><b class="title">one</b>
    <a class="detail" href="../products/1">View</a></div>
    <nav><a rel="next" href="?page=2&amp;sort=new">Next</a><span class="total"> 2 </span></nav>`;
  const config = htmlConfig({ fields: {
    title: { selector: '.title', required: true },
    detail: { selector: '.detail', attribute: 'href', absoluteUrl: true },
  }, page: {
    next: { selector: 'a[rel="next"]', attribute: 'href', required: true, absoluteUrl: true },
    total: { selector: '.total' }, previous: { selector: 'a[rel="prev"]', attribute: 'href' },
  } });
  assert.deepEqual(extractOperationResponse(response(raw), config), {
    format: 'html', data: [{ title: 'one', detail: 'https://example.invalid/products/1' }],
    pageInfo: { next: 'https://example.invalid/catalog/list?page=2&sort=new', total: '2', previous: null },
  });
});

test('HTML accepts an empty list while still extracting and validating page fields', () => {
  const config = htmlConfig({ page: { next: { selector: '[rel="next"]', attribute: 'href' } } });
  assert.deepEqual(extractOperationResponse(response('<main>No results</main>'), config), {
    format: 'html', data: [], pageInfo: { next: null },
  });
  assert.deepEqual(extractOperationResponse(response(''), htmlConfig()), { format: 'html', data: [], pageInfo: {} });
  fails('EXTRACT_REQUIRED_MISSING', () => extractOperationResponse(response('<main></main>'),
    htmlConfig({ page: { current: { selector: '.current', required: true } } })));
});

test('HTML required fields fail for absent elements, absent attributes, and blank values', () => {
  for (const raw of ['<div class="item"></div>', '<div class="item"><b class="title"> \n </b></div>']) {
    fails('EXTRACT_REQUIRED_MISSING', () => extractOperationResponse(response(raw), htmlConfig()));
  }
  for (const raw of ['<a class="item">Open</a>', '<a class="item" href="  ">Open</a>']) {
    fails('EXTRACT_REQUIRED_MISSING', () => extractOperationResponse(response(raw), htmlConfig({
      items: 'a.item', fields: { url: { selector: ':scope', attribute: 'href', required: true } },
    })));
  }
});

test('HTML ambiguous fields fail, even when optional, identical, or missing the requested attribute', () => {
  const raw = '<div class="item"><b class="title">same</b><b class="title">same</b></div>';
  for (const field of [{ selector: '.title' }, { selector: '.title', required: true }, { selector: '.title', attribute: 'href' }]) {
    fails('EXTRACT_SELECTOR_AMBIGUOUS', () => extractOperationResponse(response(raw), htmlConfig({ fields: { value: field } })));
    fails('EXTRACT_SELECTOR_AMBIGUOUS', () => extractOperationResponse(response(raw), htmlConfig({
      items: '.absent', fields: {}, page: { value: field },
    })));
  }
});

test('HTML invalid selectors fail on item, field, and page declarations, including empty lists', () => {
  for (const config of [htmlConfig({ items: '[' }), htmlConfig({ fields: { bad: { selector: '[' } } }),
    htmlConfig({ page: { bad: { selector: ':unsupported-fixture-pseudo' } } })]) {
    fails('EXTRACT_SELECTOR_INVALID', () => extractOperationResponse(response('<main></main>'), config));
  }
});

test('HTML follows tolerant HTML parsing rather than requiring well-formed XML', () => {
  assert.deepEqual(extractOperationResponse(response('<div class=item><b class=title>Recovered &amp; title'), htmlConfig()).data,
    [{ title: 'Recovered & title' }]);
});

test('HTML limit caps records in document order while preserving page information', () => {
  const raw = Array.from({ length: 4 }, (_, i) => `<div class="item"><b class="title">${i}</b></div>`).join('')
    + '<a rel="next" href="/next">More</a>';
  assert.deepEqual(extractOperationResponse(response(raw), htmlConfig({ limit: 2, page: {
    next: { selector: '[rel="next"]', attribute: 'href', absoluteUrl: true },
  } })), { format: 'html', data: [{ title: '0' }, { title: '1' }], pageInfo: { next: 'https://example.invalid/next' } });
  assert.equal(extractOperationResponse(response(raw), htmlConfig({ limit: 1 })).data.length, 1);
  // Only returned records are validated, rather than silently skipping bad ones.
  const broken = '<div class="item"><b class="title">ok</b></div><div class="item"></div>';
  assert.equal(extractOperationResponse(response(broken), htmlConfig({ limit: 1 })).data.length, 1);
  fails('EXTRACT_REQUIRED_MISSING', () => extractOperationResponse(response(broken), htmlConfig({ limit: 2 })));
});

test('HTML default and maximum item bounds are deterministic', () => {
  const raw = '<div class="item"><b class="title">ok</b></div>'.repeat(1001);
  for (const config of [htmlConfig(), htmlConfig({ limit: 1000 })]) {
    assert.equal(extractOperationResponse(response(raw), config).data.length, 1000);
  }
  for (const limit of [0, -1, 1.1, 1001, Infinity, NaN, '2', null]) {
    fails('EXTRACT_CONFIG_INVALID', () => extractOperationResponse(response(raw), htmlConfig({ limit })));
  }
});

test('absoluteUrl resolves root, path, protocol-relative, fragment, and absolute HTTP URLs', () => {
  for (const [href, expected] of [
    ['/next', 'https://example.invalid/next'], ['next', 'https://example.invalid/catalog/next'],
    ['//other.invalid/next', 'https://other.invalid/next'], ['#next', 'https://example.invalid/catalog/list?page=1#next'],
    ['http://other.invalid/next', 'http://other.invalid/next'],
  ]) {
    const raw = `<a class="item" href="${href}">Open</a>`;
    const config = htmlConfig({ fields: { link: { selector: ':scope', attribute: 'href', absoluteUrl: true } } });
    assert.equal(extractOperationResponse(response(raw), config).data[0].link, expected);
  }
  const config = htmlConfig({ fields: { link: { selector: ':scope', attribute: 'href', absoluteUrl: true } } });
  assert.equal(extractOperationResponse(response('<a class="item" href="https://other.invalid/next"></a>', {
    url: undefined,
  }), config).data[0].link, 'https://other.invalid/next');
});

test('absoluteUrl rejects invalid/non-HTTP values and relative URLs without a valid HTTP base', () => {
  const config = htmlConfig({ fields: { link: { selector: ':scope', attribute: 'href', absoluteUrl: true } } });
  for (const href of ['javascript:PRIVATE_FIXTURE()', 'data:text/plain,PRIVATE_FIXTURE', 'mailto:fixture@example.invalid', 'https://[broken']) {
    fails('EXTRACT_URL_INVALID', () => extractOperationResponse(response(`<a class="item" href="${href}"></a>`), config));
  }
  for (const url of [undefined, 'invalid', 'file:///tmp/fixture']) {
    fails('EXTRACT_URL_INVALID', () => extractOperationResponse(response('<a class="item" href="../next"></a>', { url }), config));
  }
});

test('SSR extracts a unique literal JSON script by ID and applies a selected pointer', () => {
  const raw = script('{"props":{"pageProps":{"rows":[{"id":1}],"next":null}}}')
    + script('{"unrelated":true}', 'id="other" type="application/json"');
  const config = { ...ssrConfig({ pointer: '/props/pageProps' }), requiredPointers: ['/rows/0/id', '/next'] };
  assert.deepEqual(extractOperationResponse(response(raw), config), {
    format: 'ssr_json', data: { rows: [{ id: 1 }], next: null }, pageInfo: {},
  });
  assert.deepEqual(extractOperationResponse(response(script('[1,2]')), ssrConfig()), { format: 'ssr_json', data: [1, 2], pageInfo: {} });
  assert.equal(extractOperationResponse(response(script('null')), ssrConfig()).data, null);
});

test('SSR JSON MIME keys select JSON and ld+json scripts, including parameters', () => {
  for (const type of ['application/ld+json', 'Application/LD+JSON; charset=utf-8', 'application/json', 'application/vnd.fixture+json']) {
    const key = type.split(';')[0].toLowerCase();
    assert.deepEqual(extractOperationResponse(response(script('{"name":"A &amp; B","html":"<b>ok</b>"}', `type="${type}"`)), {
      format: 'ssr_json', ssr: { key },
    }).data, { name: 'A &amp; B', html: '<b>ok</b>' });
  }
});

test('SSR keys are literal identifiers, never selectors or assignments', () => {
  const key = 'fixture[0]".data';
  assert.equal(extractOperationResponse(response(script('7', 'id=\'fixture[0]".data\'')), ssrConfig({ key })).data, 7);
  fails('EXTRACT_SSR_MISSING', () => extractOperationResponse(response(script('{"ok":true}')), ssrConfig({ key: '#__NEXT_DATA__' })));
  fails('EXTRACT_SSR_MISSING', () => extractOperationResponse(response(script('window.__NEXT_DATA__={"ok":true}', '')), ssrConfig()));
});

test('SSR rejects missing/duplicate scripts and missing selected/required pointers', () => {
  fails('EXTRACT_SSR_MISSING', () => extractOperationResponse(response('<main>No data</main>'), ssrConfig()));
  fails('EXTRACT_SSR_AMBIGUOUS', () => extractOperationResponse(response(script('{}') + script('{}')), ssrConfig()));
  fails('EXTRACT_SSR_AMBIGUOUS', () => extractOperationResponse(response(script('{}', 'type="application/ld+json"').repeat(2)),
    ssrConfig({ key: 'application/ld+json' })));
  fails('EXTRACT_REQUIRED_MISSING', () => extractOperationResponse(response(script('{}')), ssrConfig({ pointer: '/missing' })));
  fails('EXTRACT_REQUIRED_MISSING', () => extractOperationResponse(response(script('{"props":{}}')), {
    ...ssrConfig({ pointer: '/props' }), requiredPointers: ['/missing'],
  }));
});

test('SSR rejects malformed JSON, JS object literals, expressions, and executable suffixes without evaluation', () => {
  const marker = '__operationExtractFixtureExecuted';
  assert.equal(Object.hasOwn(globalThis, marker), false);
  for (const raw of ['', '{PRIVATE_FIXTURE}', '{"PRIVATE_FIXTURE":true,}', 'window.__NEXT_DATA__={"ok":true};',
    `(()=>{globalThis.${marker}=true;return {"ok":true}})()`, `{"ok":true};globalThis.${marker}=true`]) {
    fails('EXTRACT_JSON_INVALID', () => extractOperationResponse(response(script(raw)), ssrConfig()));
  }
  // Ordinary page scripts and event handlers are also never run.
  const raw = `<img src="https://example.invalid/not-fetched" onerror="globalThis.${marker}=true">`
    + script(`globalThis.${marker}=true`, '') + script('{"ok":true}');
  assert.deepEqual(extractOperationResponse(response(raw), ssrConfig()).data, { ok: true });
  assert.equal(Object.hasOwn(globalThis, marker), false);
});

test('body bounds count UTF-8 bytes and accept exactly the 4 MiB boundary', () => {
  const raw = 'x'.repeat(bodyLimit);
  assert.equal(extractOperationResponse(response(raw), { format: 'text' }).data.length, bodyLimit);
  assert.equal(extractOperationResponse(response('"' + 'x'.repeat(bodyLimit - 2) + '"')).data.length, bodyLimit - 2);
  assert.equal(extractOperationResponse(response('é'.repeat(bodyLimit / 2)), { format: 'text' }).data.length, bodyLimit / 2);
  const configs = [{ format: 'text' }, { format: 'json' }, { format: 'empty' }, htmlConfig(), ssrConfig()];
  for (const config of configs) {
    for (const raw of ['x'.repeat(bodyLimit + 1), 'é'.repeat(bodyLimit / 2 + 1)]) {
      fails('EXTRACT_BODY_TOO_LARGE', () => extractOperationResponse(response(raw), config));
    }
  }
});

test('declaration entry/selector/pointer bounds include exact boundaries', () => {
  const fields = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`f${i}`, { selector: '.missing' }]));
  assert.equal(Object.keys(extractOperationResponse(response(''), htmlConfig({ fields, page: fields })).pageInfo).length, 100);
  for (const key of ['fields', 'page']) {
    fails('EXTRACT_CONFIG_INVALID', () => extractOperationResponse(response(''), htmlConfig({
      [key]: { ...fields, extra: { selector: '.missing' } },
    })));
  }
  assert.equal(extractOperationResponse(response('{}'), { requiredPointers: Array(100).fill('') }).format, 'json');
  fails('EXTRACT_CONFIG_INVALID', () => extractOperationResponse(response('{}'), { requiredPointers: Array(101).fill('') }));
  const longKey = 'a'.repeat(4095);
  assert.equal(extractOperationResponse(response(JSON.stringify({ [longKey]: 1 })), { requiredPointers: [`/${longKey}`] }).format, 'json');
  fails('EXTRACT_CONFIG_INVALID', () => extractOperationResponse(response('{}'), { requiredPointers: [`/${longKey}a`] }));
  assert.deepEqual(extractOperationResponse(response(''), htmlConfig({ items: `.${'a'.repeat(1023)}` })).data, []);
  fails('EXTRACT_CONFIG_INVALID', () => extractOperationResponse(response(''), htmlConfig({ items: `.${'a'.repeat(1024)}` })));
  assert.equal(extractOperationResponse(response(script('true', `id="${'a'.repeat(256)}"`)), ssrConfig({ key: 'a'.repeat(256) })).data, true);
  fails('EXTRACT_CONFIG_INVALID', () => extractOperationResponse(response(''), ssrConfig({ key: 'a'.repeat(257) })));
});

test('invalid responses and declarations always produce coded errors', () => {
  for (const input of [undefined, null, [], {}, { raw: null }, { raw: Buffer.from('{}') }]) {
    fails('EXTRACT_RESPONSE_INVALID', () => extractOperationResponse(input));
  }
  for (const config of [null, [], 3, { format: 'xml' }, { format: null }, { format: 'html' },
    { format: 'ssr_json' }, ssrConfig({ key: '' }), ssrConfig({ key: 1 }), ssrConfig({ pointer: null }),
    htmlConfig({ items: '' }), htmlConfig({ fields: null }), htmlConfig({ page: [] }),
    htmlConfig({ fields: { bad: null } }), htmlConfig({ fields: { bad: { selector: '' } } }),
    htmlConfig({ fields: { bad: { selector: 'a', required: 'true' } } }),
    htmlConfig({ fields: { bad: { selector: 'a', attribute: '' } } }),
    htmlConfig({ fields: { bad: { selector: 'a', absoluteUrl: 'yes' } } }),
    { format: 'text', requiredPointers: ['/a'] }, { ...htmlConfig(), requiredPointers: ['/a'] },
  ]) fails('EXTRACT_CONFIG_INVALID', () => extractOperationResponse(response('{}'), config));
});
