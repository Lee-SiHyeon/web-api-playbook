import test from 'node:test';
import assert from 'node:assert/strict';
import { compileEditorModel, editorPresentationFingerprint } from '../scripts/api/editor-model.mjs';
import { documentFingerprint, renderUnits, unitsFingerprint } from '../scripts/gates/publication-document.mjs';
import { prepareEditorPreview, createEditorPreviewRoute } from '../scripts/hybrid/editor-preview.mjs';

const sourceLogNo = '224418405166';
const sourceUrl = `https://blog.naver.com/PostWriteFormSeOptions.naver?blogId=aicandoanything&logNo=${sourceLogNo}`;
const paragraphs = value => [{'@ctype': 'paragraph', nodes: [{'@ctype': 'textNode', value}]}];
function fixture() {
  const document = {blogId: 'aicandoanything', title: 'A new hotel post', blocks: [
    {type: 'notice', text: 'Affiliate disclosure', claimClass: 'guidance'},
    {type: 'image', publishedUrl: 'https://blogfiles.pstatic.net/test/banner.png', href: 'https://myrealt.rip/newpost'},
    {type: 'paragraph', text: 'The exact new article body.', claimClass: 'guidance'},
  ]};
  const source = {documentId: 'protected-source-container', document: {components: [
    {'@ctype': 'documentTitle', title: paragraphs('Existing post')},
    {'@ctype': 'image', src: document.blocks[1].publishedUrl},
  ]}};
  return {document, source, model: compileEditorModel(source, document)};
}
function routeStub({url = sourceUrl, method = 'GET', body} = {}) {
  const calls = {fetch: 0, fulfill: 0, abort: 0, continue: 0};
  return {calls, route: {
    request: () => ({url: () => url, method: () => method}),
    fetch: async () => {calls.fetch++; return {json: async () => structuredClone(body)};},
    fulfill: async value => {calls.fulfill++; calls.fulfilled = value.json;},
    abort: async () => {calls.abort++;},
    continue: async () => {calls.continue++;},
  }};
}

test('create preview uses the explicit existing source without assigning its logNo to the final document', () => {
  const {model, document} = fixture();
  const originalDocument = structuredClone(document), originalModel = structuredClone(model);
  const preview = prepareEditorPreview({model, document, previewSourceLogNo: sourceLogNo});
  assert.deepEqual(preview.target, {blogId: document.blogId, logNo: sourceLogNo});
  assert.equal(preview.navigationUrl, `https://blog.naver.com/aicandoanything/postupdate?logNo=${sourceLogNo}`);
  assert.equal(Object.hasOwn(preview.document, 'logNo'), false);
  assert.equal(preview.documentFingerprint, documentFingerprint(originalDocument));
  assert.notEqual(preview.documentFingerprint, documentFingerprint({...originalDocument, logNo: sourceLogNo}));
  assert.equal(preview.compiledPresentationFingerprint, editorPresentationFingerprint(originalModel));
  assert.equal(preview.observedUnitsFingerprint, unitsFingerprint(renderUnits(originalDocument)));
  document.title = 'Later caller mutation'; model.document.components[0].title = paragraphs('Later mutation');
  assert.deepEqual(preview.document, originalDocument);
  assert.deepEqual(preview.model, originalModel);
});

test('existing update preview keeps its original target and accepts only the same explicit source', () => {
  const {model, document} = fixture(); document.logNo = sourceLogNo;
  assert.equal(prepareEditorPreview({model, document}).target.logNo, sourceLogNo);
  assert.equal(prepareEditorPreview({model, document, previewSourceLogNo: sourceLogNo}).target.logNo, sourceLogNo);
  assert.throws(() => prepareEditorPreview({model, document, previewSourceLogNo: '999999999'}), /PREVIEW_TARGET/);
});

for (const value of [undefined, null, '', 'not-a-post', 'https://blog.naver.com/224418405166', ['224418405166'], 123]) {
  test(`create preview rejects an absent or malformed source ${JSON.stringify(value)}`, () => {
    assert.throws(() => prepareEditorPreview({...fixture(), previewSourceLogNo: value}), /PREVIEW_TARGET/);
  });
}
for (const blogId of ['', '../another-blog', 'aicandoanything?logNo=1', 'https://other.example']) {
  test(`preview rejects invalid blog scope ${JSON.stringify(blogId)}`, () => {
    const {model, document} = fixture(); document.blogId = blogId;
    assert.throws(() => prepareEditorPreview({model, document, previewSourceLogNo: sourceLogNo}), /PREVIEW_TARGET/);
  });
}
test('a create document must omit logNo rather than supplying an empty target', () => {
  const {model, document} = fixture(); document.logNo = null;
  assert.throws(() => prepareEditorPreview({model, document, previewSourceLogNo: sourceLogNo}), /PREVIEW_TARGET/);
});
for (const [name, change] of [
  ['title', m => {m.document.components[0].title = paragraphs('Wrong title');}],
  ['text', m => {m.document.components.at(-1).value = paragraphs('Wrong body');}],
  ['image target', m => {m.document.components.find(c => c['@ctype'] === 'image').link = 'https://myrealt.rip/wrong';}],
]) {
  test(`preview rejects compiled ${name} differing from the untouched final document`, () => {
    const {model, document} = fixture(); change(model);
    assert.throws(() => prepareEditorPreview({model, document, previewSourceLogNo: sourceLogNo}), /PREVIEW_COMPILED_DOCUMENT_MISMATCH/);
  });
}

test('only the scoped protected GET receives the compiled model and the new-document binding remains unchanged', async () => {
  const {model, document, source} = fixture();
  const preview = prepareEditorPreview({model, document, previewSourceLogNo: sourceLogNo});
  const originalReply = {isSuccess: true, result: {documentModel: JSON.stringify(source), unrelatedSetting: 'preserved'}};
  const stub = routeStub({body: originalReply}), blocked = []; let injected = 0;
  await createEditorPreviewRoute(preview, {blocked, onInjected: () => {injected++;}})(stub.route);
  assert.equal(stub.calls.fetch, 1); assert.equal(stub.calls.fulfill, 1); assert.equal(injected, 1);
  assert.deepEqual(JSON.parse(stub.calls.fulfilled.result.documentModel), model);
  assert.equal(stub.calls.fulfilled.result.unrelatedSetting, 'preserved');
  assert.deepEqual(JSON.parse(originalReply.result.documentModel), source);
  assert.equal(Object.hasOwn(preview.document, 'logNo'), false);
  assert.equal(preview.documentFingerprint, documentFingerprint(document));
  assert.deepEqual(blocked, []);
});

for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
  for (const url of ['https://blog.naver.com/RabbitWrite.naver', 'https://other.example/autosave']) {
    test(`preview blocks ${method} ${url} before any network forwarding or injection`, async () => {
      const preview = prepareEditorPreview({...fixture(), previewSourceLogNo: sourceLogNo});
      const stub = routeStub({url, method}), blocked = []; let injected = 0;
      await createEditorPreviewRoute(preview, {blocked, onInjected: () => {injected++;}})(stub.route);
      assert.equal(stub.calls.abort, 1); assert.equal(stub.calls.fetch, 0); assert.equal(stub.calls.continue, 0);
      assert.equal(stub.calls.fulfill, 0); assert.equal(injected, 0);
      assert.deepEqual(blocked, [{method, path: new URL(url).pathname}]);
    });
  }
}
for (const url of [
  sourceUrl.replace('aicandoanything', 'different_blog'),
  sourceUrl.replace(sourceLogNo, '999999999'),
  sourceUrl + '&blogId=different_blog',
  sourceUrl + '&logNo=999999999',
]) {
  test(`preview rejects mismatched or ambiguous protected source ${url}`, async () => {
    const preview = prepareEditorPreview({...fixture(), previewSourceLogNo: sourceLogNo});
    const stub = routeStub({url});
    await assert.rejects(createEditorPreviewRoute(preview, {blocked: [], onInjected: () => {}})(stub.route), /PREVIEW_TARGET/);
    assert.equal(stub.calls.fetch, 0); assert.equal(stub.calls.fulfill, 0); assert.equal(stub.calls.continue, 0);
  });
}
for (const body of [{isSuccess: false}, {isSuccess: true}, {isSuccess: true, result: {documentModel: {}}}]) {
  test(`preview rejects unsupported protected reply ${JSON.stringify(body)}`, async () => {
    const preview = prepareEditorPreview({...fixture(), previewSourceLogNo: sourceLogNo});
    const stub = routeStub({body}); let injected = 0;
    await assert.rejects(createEditorPreviewRoute(preview, {blocked: [], onInjected: () => {injected++;}})(stub.route), /PREVIEW_SCHEMA/);
    assert.equal(stub.calls.fulfill, 0); assert.equal(injected, 0);
  });
}
test('foreign-origin GET cannot receive the compiled private document', async () => {
  const preview = prepareEditorPreview({...fixture(), previewSourceLogNo: sourceLogNo});
  const stub = routeStub({url: sourceUrl.replace('blog.naver.com', 'other.example')}); let injected = 0;
  await createEditorPreviewRoute(preview, {blocked: [], onInjected: () => {injected++;}})(stub.route);
  assert.equal(stub.calls.continue, 1); assert.equal(stub.calls.fetch, 0); assert.equal(stub.calls.fulfill, 0); assert.equal(injected, 0);
});
