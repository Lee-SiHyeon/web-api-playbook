import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import { REVIEWED_REPAIR, reviewedRepairDocument, reorderExistingEditorUnits,
  verifyReviewedImageRemoval } from '../scripts/api/reviewed-structure-repair.mjs';
import { inspectEditorModel } from '../scripts/api/editor-model.mjs';
import { NaverEditorClient } from '../scripts/api/editor-client.mjs';
const p = (id, value) => ({ id, '@ctype': 'paragraph', style: { align: 'center' },
  nodes: [{ id: `${id}-node`, '@ctype': 'textNode', value, style: { bold: true },
    link: { url: 'https://example.test/unchanged' } }] });
function fixture() {
  return { documentId: '', document: { id: 'opaque-id', di: 'opaque-di', components: [
    { id: 'title', '@ctype': 'documentTitle', title: [p('title-p','Original title')] },
    { id: 'text', '@ctype': 'text', layout: 'default', value: [p('one','First paragraph'), p('two','Second paragraph')] },
    { id: 'image', '@ctype': 'image', src: 'https://postfiles.pstatic.net/existing.png',
      width: 773, height: 966, caption: [] },
  ] } };
}
test('reordering preserves text styles, hyperlinks, assets and opaque document metadata', () => {
  const model = fixture(), before = structuredClone(model);
  const changed = reorderExistingEditorUnits(model, [3,2,1]);
  assert.deepEqual(model, before);
  assert.equal(changed.documentId, '');
  assert.equal(changed.document.id, 'opaque-id');
  assert.equal(changed.document.di, 'opaque-di');
  assert.deepEqual(changed.document.components[1], model.document.components[2]);
  assert.deepEqual(changed.document.components[2].value[0], model.document.components[1].value[1]);
  assert.deepEqual(changed.document.components[3].value[0], model.document.components[1].value[0]);
  assert.deepEqual(inspectEditorModel(changed).units, [3,2,1].map(i => inspectEditorModel(model).units[i-1]));
  const ids = changed.document.components.map(c => c.id);
  assert.equal(new Set(ids).size, ids.length);
});
test('malformed and duplicated unit references are rejected', () => {
  for (const order of [[1,1],[0],[4],[1.5],[],null])
    assert.throws(() => reorderExistingEditorUnits(fixture(), order), /REPAIR_ORDER/);
});
test('image captions cannot be silently detached or discarded', () => {
  const model = fixture(); model.document.components[2].caption = [p('caption','Existing caption')];
  assert.throws(() => reorderExistingEditorUnits(model, [1,2,3,4]), /REPAIR_COMPONENT_SPAN/);
});
test('fixed repair refuses different source content and immutable plan changes', () => {
  assert.throws(() => reviewedRepairDocument(inspectEditorModel(fixture())), /REPAIR_SOURCE_CHANGED/);
  assert.throws(() => REVIEWED_REPAIR.order.push(1), TypeError);
  assert.throws(() => { REVIEWED_REPAIR.imagePairs[0][0] = 2; }, TypeError);
  assert.equal(REVIEWED_REPAIR.order.length, 86);
  assert.equal(new Set(REVIEWED_REPAIR.order).size, 86);
  // Every main-body unit is retained in the original order.
  assert.deepEqual(REVIEWED_REPAIR.order.filter(i => i >= 23), Array.from({length:74},(_,i)=>i+23));
});
test('image removal requires fresh verification and identical bytes AND pixels', () => {
  const audit = { checks: { allImagesVerified: true }, imageCount: 18,
    images: [1,2,3,4,7,8,9,13,15,18,26,38,50,60,66,73,83,87]
      .map((position,i)=>({position,sha256:`byte${i}`,pixelFingerprint:`pixel${i}`})) };
  for (const [drop,keep] of REVIEWED_REPAIR.imagePairs) {
    const a=audit.images.find(i=>i.position===drop);
    const b=audit.images.find(i=>i.position===keep);
    b.sha256=a.sha256; b.pixelFingerprint=a.pixelFingerprint;
  }
  verifyReviewedImageRemoval(audit);
  const wrong = structuredClone(audit); wrong.images.find(i=>i.position===60).sha256='different';
  assert.throws(()=>verifyReviewedImageRemoval(wrong), /REPAIR_IMAGE_NOT_DUPLICATE/);
  audit.checks.allImagesVerified=false;
  assert.throws(()=>verifyReviewedImageRemoval(audit), /REPAIR_IMAGES_UNVERIFIED/);
});
test('completed repair is retired for every caller before any network request', async () => {
  let requests = 0;
  for (const blogId of ['aicandoanything','anotherblog']) {
    const client = new NaverEditorClient({blogId,fetchImpl:()=>{requests++;throw Error('NETWORK_MUST_NOT_RUN');}});
    for (const options of [{}, {repairId:REVIEWED_REPAIR.id}, {repairId:'arbitrary',authorized:true},
      {repairId:REVIEWED_REPAIR.id,authorized:true}])
      await assert.rejects(client.repairReviewedStructure(options), {code:'REVIEWED_REPAIR_RETIRED_USE_PUBLICATION_GATE'});
  }
  assert.equal(requests,0);
});
test('retired repair CLI rejects apply before authentication or file arguments',async()=>{
 const script=fileURLToPath(new URL('../tools/discovery/repair-published-prefix.mjs',import.meta.url));
 await assert.rejects(promisify(execFile)(process.execPath,[script,'--mode=apply'],{env:{},timeout:5000}),error=>{
  assert.equal(error.code,2);
  assert.equal(JSON.parse(error.stderr).code,'REVIEWED_REPAIR_RETIRED_USE_PUBLICATION_GATE');
  return true;
 });
});
