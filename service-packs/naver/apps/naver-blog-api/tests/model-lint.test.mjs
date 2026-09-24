import test from 'node:test';
import assert from 'node:assert/strict';
import { compileEditorModel } from '../scripts/api/editor-model.mjs';
import { lintCompiledModel } from '../scripts/api/model-lint.mjs';

const fresh = () => ({ document: { components: [{ id: 'SE-title', '@ctype': 'documentTitle', title: [{ id: 'p', '@ctype': 'paragraph', nodes: [{ id: 'n', '@ctype': 'textNode', value: 'old' }] }] }] } });
const doc = columns => ({ blogId: 'aicandoanything', title: 'A lint fixture title', blocks: [
  { type: 'notice', presentation: 'panel', text: '2026년 9월 24일 공식 원문을 확인해 정리했습니다.' },
  { type: 'heading', presentation: 'quotation', text: '비교 표' },
  { type: 'table', columns: columns.map((_, i) => `열${i + 1}`), rows: [columns], columnWidths: columns.map(() => 100 / columns.length) },
  { type: 'paragraph', text: '표를 읽는 방법을 한 문장으로 설명합니다.' },
  { type: 'link', display: 'label', label: '공식 발표 원문', url: 'https://example.com/release' },
] });
const noMedia = async () => { throw Error('no media expected'); };

test('model lint passes a compiled 3-column document without a browser', async () => {
  const d = doc(['4.6분 / 2.8분', '20KB / 18KB', '복셀 월드']);
  const r = await lintCompiledModel({ model: compileEditorModel(fresh(), d), document: d, fetchImpl: noMedia });
  assert.equal(r.passed, true, JSON.stringify(r.failedChecks));
  assert.equal(r.browserUsed, false);
  assert.equal(r.layoutRisk, 'low');
});

test('4-column tables and unbreakable cell tokens require a native preview', async () => {
  let d = doc(['a', 'b', 'c', 'd']);
  let r = await lintCompiledModel({ model: compileEditorModel(fresh(), d), document: d, fetchImpl: noMedia });
  assert.equal(r.passed, true);
  assert.equal(r.layoutRisk, 'needs_native_preview');
  assert.deepEqual(r.riskFactors.map(f => f.factor), ['table_columns']);
  d = doc(['https-free-but-very-long-token-value', 'b']);
  r = await lintCompiledModel({ model: compileEditorModel(fresh(), d), document: d, fetchImpl: noMedia });
  assert.deepEqual(r.riskFactors.map(f => f.factor), ['table_cell_token']);
});

test('model defects fail closed: missing heading style, panel or link label', async () => {
  const d = doc(['a', 'b']);
  let m = compileEditorModel(fresh(), d);
  delete m.document.components[2].value[0].nodes[0].style;
  assert.equal((await lintCompiledModel({ model: m, document: d, fetchImpl: noMedia })).checks.headingsStyled, false);
  m = compileEditorModel(fresh(), d);
  m.document.components[1].rows[0].cells[0].backgroundColor = '#ffffff';
  assert.equal((await lintCompiledModel({ model: m, document: d, fetchImpl: noMedia })).checks.disclosurePanels, false);
  m = compileEditorModel(fresh(), d);
  m.document.components.at(-1).value[0].nodes[0].link.url = 'https://example.com/other';
  assert.equal((await lintCompiledModel({ model: m, document: d, fetchImpl: noMedia })).checks.linksLabeled, false);
});
