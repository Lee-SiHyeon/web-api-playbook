import test from 'node:test';
import assert from 'node:assert/strict';
import { compileEditorModel, inspectEditorModel } from '../scripts/api/editor-model.mjs';
import { renderUnits } from '../scripts/gates/publication-document.mjs';
import { presentationDifferences } from '../scripts/gates/editor-style-contract.mjs';
import { lintCompiledModel } from '../scripts/api/model-lint.mjs';

// The adapter only ever reuses an image it can already see in the fresh model.
const IMAGE_URL = 'https://blogfiles.pstatic.net/synthetic/homefeed.png';
const fresh = () => ({ document: { id: 'SE-doc', components: [
  { id: 'SE-image', '@ctype': 'image', layout: 'default', src: `${IMAGE_URL}?type=w1`, caption: [] },
  { id: 'SE-title', '@ctype': 'documentTitle', layout: 'default', align: 'left', subTitle: null,
    title: [{ id: 'SE-tp', '@ctype': 'paragraph', nodes: [{ id: 'SE-tn', '@ctype': 'textNode', value: '이전 제목' }] }] },
  { id: 'SE-body', '@ctype': 'text', layout: 'default', value: [
    { id: 'SE-bp', '@ctype': 'paragraph', nodes: [{ id: 'SE-bn', '@ctype': 'textNode', value: '이전 본문입니다.' }] },
  ] },
] } });
const body = (model) => model.document.components.filter((component) => component['@ctype'] !== 'documentTitle');
const paragraphs = (component) => component.value;
const runsOf = (paragraph) => paragraph.nodes.map((node) => ({ text: node.value, style: node.style || null }));

test('authored runs become styled text nodes without changing the text units', () => {
  const document = { title: '홈판 서식 확인', blocks: [
    { type: 'paragraph', text: '어제 평균 1,784원이에요',
      runs: [{ text: '어제 평균 ' }, { text: '1,784원', bold: true, fontColor: '#1F6F6B' }, { text: '이에요' }] },
  ] };
  const model = compileEditorModel(fresh(), document), paragraph = paragraphs(body(model)[0])[0];
  assert.deepEqual(runsOf(paragraph), [
    { text: '어제 평균 ', style: null },
    { text: '1,784원', style: { '@ctype': 'nodeStyle', bold: true, fontColor: '#1f6f6b' } },
    { text: '이에요', style: null },
  ]);
  assert.equal(paragraph.style, undefined);
  assert.deepEqual(inspectEditorModel(model).units, renderUnits(document));
});

test('paragraph alignment is a paragraphStyle and the native default left is omitted', () => {
  const centered = compileEditorModel(fresh(), { title: '가운데 정렬 확인', blocks: [
    { type: 'paragraph', text: '가운데로 놓는 짧은 줄', align: 'center' },
  ] });
  assert.deepEqual(paragraphs(body(centered)[0])[0].style, { '@ctype': 'paragraphStyle', align: 'center' });
  const left = compileEditorModel(fresh(), { title: '왼쪽 정렬 확인', blocks: [
    { type: 'paragraph', text: '기본은 왼쪽이에요', align: 'left' },
    { type: 'paragraph', text: '정렬을 적지 않은 문단' },
  ] });
  for (const paragraph of paragraphs(body(left)[0])) assert.equal(paragraph.style, undefined);
});

test('a paragraph-wide default style covers unstyled runs and never overrides a run style', () => {
  const model = compileEditorModel(fresh(), { title: '기본 본문 스타일', blocks: [
    { type: 'paragraph', text: '회색 본문에 1,784원만 진하게', style: { fontColor: '#777777', fontSizeCode: 'fs15' },
      runs: [{ text: '회색 본문에 ' }, { text: '1,784원', bold: true }, { text: '만 진하게' }] },
    { type: 'paragraph', text: '스타일만 있는 문단', style: { fontColor: '#777777', fontSizeCode: 'fs15' } },
  ] });
  const [withRuns] = paragraphs(body(model)[0]), [withoutRuns] = paragraphs(body(model)[1]);
  assert.deepEqual(runsOf(withRuns), [
    { text: '회색 본문에 ', style: { '@ctype': 'nodeStyle', fontColor: '#777777', fontSizeCode: 'fs15' } },
    { text: '1,784원', style: { '@ctype': 'nodeStyle', fontColor: '#777777', fontSizeCode: 'fs15', bold: true } },
    { text: '만 진하게', style: { '@ctype': 'nodeStyle', fontColor: '#777777', fontSizeCode: 'fs15' } },
  ]);
  assert.deepEqual(runsOf(withoutRuns), [
    { text: '스타일만 있는 문단', style: { '@ctype': 'nodeStyle', fontColor: '#777777', fontSizeCode: 'fs15' } },
  ]);
});

test('quotation layouts come from the six layouts the editor offers', () => {
  const document = (layout) => ({ title: '인용구 서식', blocks: [
    { type: 'quote', text: '한 줄로 남기는 기준', ...(layout ? { layout } : {}) },
    { type: 'heading', presentation: 'quotation', text: '소제목도 인용구로', layout: layout || undefined },
  ] });
  const model = compileEditorModel(fresh(), document('quotation_line'));
  for (const component of body(model)) {
    assert.equal(component['@ctype'], 'quotation');
    assert.equal(component.layout, 'quotation_line');
  }
  assert.equal(body(compileEditorModel(fresh(), document()))[0].layout, 'default');
  assert.throws(() => compileEditorModel(fresh(), document('quotation_note')), { message: 'INVALID_QUOTATION_LAYOUT' });
});

test('table cell alignment and table alignment are carried per cell', () => {
  const model = compileEditorModel(fresh(), { title: '표 정렬 확인', blocks: [
    { type: 'table', columns: ['품목', '리터당 상한', '적용 기간'],
      rows: [['휘발유', '1,784원', '12월 11일까지'], ['경유', '1,773원', '같은 기간']], cellAlign: 'center' },
    { type: 'table', columns: ['왼쪽', '기본'], rows: [['가', '나']] },
  ] });
  const [centered, standard] = body(model).map((component) => component.rows.flatMap((row) => row.cells));
  assert.deepEqual([...new Set(centered.map((cell) => cell.textAlign))], ['center']);
  assert.deepEqual([...new Set(standard.map((cell) => cell.textAlign))], ['left']);
  assert.equal(body(model)[0].align, 'left');
  assert.throws(() => compileEditorModel(fresh(), { title: '표 정렬 오류', blocks: [
    { type: 'table', columns: ['가', '나'], rows: [['다', '라']], cellAlign: 'justify' },
  ] }), { message: 'INVALID_TABLE_ALIGN' });
});

test('an image carries the ai mark only when its rights are recorded as generated', () => {
  const generated = compileEditorModel(fresh(), { title: 'AI 이미지 표시', blocks: [
    { type: 'image', publishedUrl: IMAGE_URL, ai: true, rights: { basis: 'generated', source: 'synthetic prompt' } },
    { type: 'paragraph', presentation: 'caption', text: 'AI 생성 이미지' },
  ] });
  assert.equal(body(generated)[0].ai, true);
  const owned = compileEditorModel(fresh(), { title: '보유 이미지', blocks: [
    { type: 'image', publishedUrl: IMAGE_URL, rights: { basis: 'owned', source: 'own camera' } },
  ] });
  assert.equal(body(owned)[0].ai, undefined);
  assert.throws(() => compileEditorModel(fresh(), { title: '근거 없는 AI 표시', blocks: [
    { type: 'image', publishedUrl: IMAGE_URL, ai: true },
  ] }), { message: 'AI_MARK_REQUIRES_GENERATED_RIGHTS' });
});

test('a caption paragraph can carry its own alignment and size', () => {
  const model = compileEditorModel(fresh(), { title: '캡션 서식', blocks: [
    { type: 'image', publishedUrl: IMAGE_URL },
    { type: 'paragraph', presentation: 'caption', text: '출처: 산업통상부 (2026년 11월 13일)',
      align: 'center', style: { fontColor: '#777777', fontSizeCode: 'fs13' } },
  ] });
  const caption = paragraphs({ value: body(model)[0].caption })[0];
  assert.deepEqual(caption.style, { '@ctype': 'paragraphStyle', align: 'center' });
  assert.deepEqual(runsOf(caption), [{ text: '출처: 산업통상부 (2026년 11월 13일)',
    style: { '@ctype': 'nodeStyle', fontColor: '#777777', fontSizeCode: 'fs13' } }]);
});

test('invalid runs, colors, sizes, alignments and notice styles fail closed', () => {
  const compile = (block) => compileEditorModel(fresh(), { title: '오류 확인 문단', blocks: [block] });
  assert.throws(() => compile({ type: 'paragraph', text: '본문과 다른 런', runs: [{ text: '본문과 다른' }] }),
    { message: 'INLINE_RUNS_TEXT_MISMATCH' });
  assert.throws(() => compile({ type: 'paragraph', text: '없는 필드', runs: [{ text: '없는 필드', color: '#ffffff' }] }),
    { message: 'INVALID_INLINE_RUNS' });
  assert.throws(() => compile({ type: 'paragraph', text: '짧은 색', style: { fontColor: '#fff' } }),
    { message: 'INVALID_INLINE_STYLE' });
  assert.throws(() => compile({ type: 'paragraph', text: '없는 크기', style: { fontSizeCode: 'fs99' } }),
    { message: 'INVALID_INLINE_STYLE' });
  assert.throws(() => compile({ type: 'paragraph', text: '없는 정렬', align: 'middle' }),
    { message: 'INVALID_PARAGRAPH_ALIGN' });
  assert.throws(() => compile({ type: 'notice', presentation: 'panel', text: '공시 패널', align: 'center' }),
    { message: 'NOTICE_PRESENTATION_FIXED' });
});

test('a document that authors no presentation compiles to the same shapes as before', () => {
  const document = { title: '서식 없는 문서', blocks: [
    { type: 'notice', presentation: 'panel', text: '이 포스팅은 쿠팡 파트너스 활동의 일환입니다.' },
    { type: 'heading', text: '읽을 수 있는 소제목' },
    { type: 'paragraph', text: '본문 한 문단입니다.' },
    { type: 'quote', text: '인용 한 줄' },
    { type: 'table', columns: ['가', '나'], rows: [['다', '라']] },
    { type: 'link', display: 'label', label: '공식 원문', url: 'https://example.com/release' },
    { type: 'image', publishedUrl: IMAGE_URL },
    { type: 'divider' },
  ] };
  const model = compileEditorModel(fresh(), document), components = body(model);
  assert.equal(components[0]['@ctype'], 'table');
  assert.equal(components[0].rows[0].cells[0].backgroundColor, '#f2f2f2');
  assert.deepEqual(components[1].value[0].nodes[0].style, { '@ctype': 'nodeStyle', bold: true });
  assert.equal(components[2].value[0].style, undefined);
  assert.deepEqual(components[2].value[0].nodes[0], { id: components[2].value[0].nodes[0].id, value: '본문 한 문단입니다.', '@ctype': 'textNode' });
  assert.equal(components[3]['@ctype'], 'quotation');
  assert.equal(components[3].layout, 'default');
  assert.equal(components[4].rows[1].cells[0].textAlign, 'left');
  assert.equal(components[6].ai, undefined);
  assert.deepEqual(inspectEditorModel(model).units, renderUnits(document));
  assert.deepEqual(presentationDifferences(document, model), []);
});

test('a style the editor model lost is reported, not treated as applied', async () => {
  const document = { title: '되읽기 확인', blocks: [
    { type: 'paragraph', text: '가운데 정렬', align: 'center',
      runs: [{ text: '가운데 ' }, { text: '정렬', bold: true }] },
  ] };
  const model = compileEditorModel(fresh(), document);
  const dropped = structuredClone(model);
  delete dropped.document.components[1].value[0].style;
  delete dropped.document.components[1].value[0].nodes[1].style;
  const differences = presentationDifferences(document, dropped);
  assert.deepEqual(differences.map((difference) => difference.difference), ['align', 'bold']);
  assert.deepEqual((await lintCompiledModel({ model: dropped, document, fetchImpl: () => { throw Error('no media'); } })).checks.presentationApplied, false);
  assert.equal((await lintCompiledModel({ model, document, fetchImpl: () => { throw Error('no media'); } })).checks.presentationApplied, true);
});
