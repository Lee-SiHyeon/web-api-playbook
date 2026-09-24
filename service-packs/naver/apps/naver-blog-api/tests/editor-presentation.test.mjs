import test from 'node:test';
import assert from 'node:assert/strict';
import {compileEditorModel,inspectEditorModel,editorPresentationFingerprint} from '../scripts/api/editor-model.mjs';
import {renderUnits} from '../scripts/gates/publication-document.mjs';
import {seedModel} from './support/publication-fixture.mjs';

test('heading style and labeled links survive compilation without extra raw URLs',()=>{
  const document={title:'서식을 보존하는 테스트',blocks:[
    {type:'heading',text:'읽을 수 있는 소제목'},
    {type:'spacer'},
    {type:'link',display:'label',label:'옵션 확인',url:'https://link.coupang.com/a/example123'},
  ]};
  const model=compileEditorModel(seedModel(),document),components=model.document.components;
  assert.equal(components[1].value[0].nodes[0].style.bold,true);
  assert.equal(components[1].value[1].nodes[0].value,'');
  assert.equal(components[2].value.length,1);
  assert.equal(components[2].value[0].nodes[0].value,'옵션 확인');
  assert.equal(components[2].value[0].nodes[0].link.url,document.blocks[2].url);
  assert.deepEqual(inspectEditorModel(model).units,renderUnits(document));
  const changed=structuredClone(model);changed.document.components[1].value[0].nodes[0].style.bold=false;
  assert.notEqual(editorPresentationFingerprint(model),editorPresentationFingerprint(changed));
  assert.equal(editorPresentationFingerprint(model),editorPresentationFingerprint(compileEditorModel(seedModel(),document)));
});

test('native gray disclosure and quotation headings preserve text and bind their presentation',()=>{
  const document={title:'네이버 서식 확인',blocks:[
    {type:'notice',text:'쿠팡 파트너스 활동의 일환입니다.',presentation:'panel'},
    {type:'heading',text:'그레이도, 화이트도 샀어요',presentation:'quotation'},
    {type:'paragraph',text:'내용은 그대로 보존합니다.'},
  ]};
  const model=compileEditorModel(seedModel(),document),components=model.document.components;
  assert.equal(components[1]['@ctype'],'table');
  const cell=components[1].rows[0].cells[0];
  assert.equal(cell.backgroundColor,'#f2f2f2');
  assert.equal(cell.width,100);
  assert.equal(cell.value[0].nodes[0].style.backgroundColor,undefined);
  assert.equal(components[2]['@ctype'],'quotation');
  assert.equal(components[2].value[0].nodes[0].style.bold,true);
  assert.deepEqual(inspectEditorModel(model).units,renderUnits(document));
  const changed=structuredClone(document);delete changed.blocks[0].presentation;
  assert.notEqual(editorPresentationFingerprint(model),editorPresentationFingerprint(compileEditorModel(seedModel(),changed)));
  const unshaded=structuredClone(model);unshaded.document.components[1].rows[0].cells[0].backgroundColor='#ffffff';
  assert.notEqual(editorPresentationFingerprint(model),editorPresentationFingerprint(unshaded));
});
