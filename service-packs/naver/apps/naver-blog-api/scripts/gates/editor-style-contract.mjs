import { text } from './publication-document.mjs';

// Presentation vocabulary for SmartEditor ONE documents. Nothing here is
// guessed: every value below was read out of a captured artifact, and the
// unverified parts are named as unverified instead of being filled in.
//
// Observed 2026-11-16 in the editor bundle the blog editor actually loads
// (https://editor-static.pstatic.net/e/basic.desktop/1.78.1/se-app-context.js):
//
//   paragraph factory
//     Gg = function(e=[Wg()], t={}) { return {"@ctype":"paragraph",
//       style: Bg({"@ctype":"paragraphStyle"}, pick(t, ["lineHeight","align"])), nodes:e}; }
//   text-node factory
//     Wg = function(e="", t={}) { return {"@ctype":"textNode",
//       style: Bg({"@ctype":"nodeStyle", ai:!0}, characterStyle(t)), value:e}; }
//   nodeStyle reset shape
//     {ctype:"nodeStyle", fontColor:null, fontFamily:null, fontSizeCode:null,
//      backgroundColor:null, bold:null, italic:null, underline:null,
//      strikeThrough:null, subscript:null, superscript:null, ai:...}
//   align option values offered by the toolbar: left | center | right | justify
//   fontSizeCode values allowed on text: fs11 fs13 fs15 fs16 fs19 fs24 fs28 fs30 fs34 fs38
//   quotation layouts: default | quotation_line | quotation_bubble |
//                      quotation_underline | quotation_postit | quotation_corner
//   table component: {id, ctype, layout, width, columnCount, rows, align,
//                     borderStyleName, borderInlineStyle}
//   tableCell: {..., textAlign}  (default "left"; center/right come from the toolbar)
//   image component toPlainJSON includes `ai` (default false) and `align`
//   default theme: text value {fontSizeCode:"fs15", lineHeight:1.8, align:"left",
//                    fontColor:"#000"}; image caption {fontSizeCode:"fs13",
//                    align:"center", fontColor:"#555", lineHeight:1.5}
//
// The same {"@ctype":"paragraphStyle","align":...} / {"@ctype":"nodeStyle",...}
// write is implemented by the device-verified app path
// (app-api-playbook apps/naver-blog-ai/app/src/main/java/dev/blogai/companion/core/BridgeCompositionCompiler.java:235),
// whose readback is recorded in
// app-api-playbook references/naver-blog-native-presets-e2e-2026-10-26.md
// ("모델의 세 텍스트 문단에도 paragraphStyle.align=center가 존재한다").
//
// What is NOT verified here, and must not be presented as verified:
// - whether the blog HTTP write paths (/RabbitUpdate, /RabbitTempPostUpdate)
//   keep a paragraph align other than the default, the image `ai` flag, or a
//   table-cell textAlign on readback. The readback comparison below reports
//   what actually came back instead of assuming it survived.
// - the naver-cafe pack records that its server discards tableCell.textAlign
//   (service-packs/naver-cafe/discovery/media-contracts-lifehackailab-2026-10-13.json),
//   so cell alignment is offered for the blog pack only and is reported, never
//   assumed.
export const EDITOR_STYLE_EVIDENCE = Object.freeze({
  observedOn: '2026-11-16',
  bundle: 'https://editor-static.pstatic.net/e/basic.desktop/1.78.1/se-app-context.js',
  appCompiler: 'app-api-playbook: apps/naver-blog-ai/app/src/main/java/dev/blogai/companion/core/BridgeCompositionCompiler.java',
  paragraphStyleType: 'paragraphStyle',
  nodeStyleType: 'nodeStyle',
  unverified: Object.freeze([
    'blog HTTP write readback of paragraphStyle.align != left',
    'blog HTTP write readback of image.ai',
    'blog HTTP write readback of tableCell.textAlign != left',
  ]),
});

export const ALIGNMENTS = Object.freeze(['left', 'center', 'right', 'justify']);
export const CELL_ALIGNMENTS = Object.freeze(['left', 'center', 'right']);
export const FONT_SIZE_CODES = Object.freeze(['fs11', 'fs13', 'fs15', 'fs16', 'fs19', 'fs24', 'fs28', 'fs30', 'fs34', 'fs38']);
export const QUOTATION_LAYOUTS = Object.freeze([
  'default', 'quotation_line', 'quotation_bubble', 'quotation_underline', 'quotation_postit', 'quotation_corner',
]);
export const NODE_STYLE_FIELDS = Object.freeze(['bold', 'italic', 'underline', 'strikeThrough', 'fontColor', 'fontSizeCode']);
const BOOLEAN_STYLE_FIELDS = Object.freeze(['bold', 'italic', 'underline', 'strikeThrough']);
const RUN_FIELDS = Object.freeze(['text', ...NODE_STYLE_FIELDS]);
const COLOR = /^#[0-9a-f]{6}$/i;

const failure = (code, details) => Object.assign(new Error(code), details ? { details } : {});

// Validate an authored style object and return the same fields with only the
// dimensions the author actually set. Unknown keys fail closed: an invented
// style field must never reach the editor document.
export function styleFields(value, code = 'INVALID_INLINE_STYLE') {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw failure(code);
  const style = {};
  for (const [field, raw] of Object.entries(value)) {
    if (!NODE_STYLE_FIELDS.includes(field)) throw failure(code, { field });
    if (BOOLEAN_STYLE_FIELDS.includes(field)) {
      if (typeof raw !== 'boolean') throw failure(code, { field });
      style[field] = raw;
    } else if (field === 'fontColor') {
      if (typeof raw !== 'string' || !COLOR.test(raw)) throw failure(code, { field, value: raw });
      style[field] = raw.toLowerCase();
    } else {
      if (typeof raw !== 'string' || !FONT_SIZE_CODES.includes(raw)) throw failure(code, { field, value: raw });
      style[field] = raw;
    }
  }
  return Object.keys(style).length ? style : null;
}

// Paragraph-level alignment. `left` is the native default, so it is accepted
// but not written, exactly as the device-verified app compiler does.
export function paragraphAlign(block, code = 'INVALID_PARAGRAPH_ALIGN') {
  if (block?.align == null) return null;
  if (!ALIGNMENTS.includes(block.align)) throw failure(code, { align: block.align });
  return block.align;
}

export function cellTextAlign(block, code = 'INVALID_TABLE_ALIGN') {
  if (block?.cellAlign == null) return 'left';
  if (!CELL_ALIGNMENTS.includes(block.cellAlign)) throw failure(code, { cellAlign: block.cellAlign });
  return block.cellAlign;
}

export function tableAlign(block, code = 'INVALID_TABLE_ALIGN') {
  if (block?.align == null) return 'left';
  if (!CELL_ALIGNMENTS.includes(block.align)) throw failure(code, { align: block.align });
  return block.align;
}

export function quotationLayout(block, code = 'INVALID_QUOTATION_LAYOUT') {
  if (block?.layout == null) return 'default';
  if (!QUOTATION_LAYOUTS.includes(block.layout)) throw failure(code, { layout: block.layout });
  return block.layout;
}

// Authored inline runs. `runs` must reproduce `block.text` exactly so every
// existing gate that reads block.text keeps working unchanged.
export function inlineRuns(block, code = 'INVALID_INLINE_RUNS') {
  if (block?.runs == null) return null;
  if (!Array.isArray(block.runs) || !block.runs.length) throw failure(code);
  const runs = block.runs.map((run) => {
    if (!run || typeof run !== 'object' || Array.isArray(run)) throw failure(code);
    for (const field of Object.keys(run)) if (!RUN_FIELDS.includes(field)) throw failure(code, { field });
    if (typeof run.text !== 'string' || !run.text.length || /[\r\n]/.test(run.text)) throw failure(code, { field: 'text' });
    const style = Object.fromEntries(NODE_STYLE_FIELDS.filter((field) => run[field] !== undefined).map((field) => [field, run[field]]));
    return { text: run.text, style: styleFields(style, code) };
  });
  if (block.text !== undefined && text(block.text) !== text(runs.map((run) => run.text).join('')))
    throw failure('INLINE_RUNS_TEXT_MISMATCH', { text: text(block.text), runs: text(runs.map((run) => run.text).join('')) });
  return runs;
}

// Native style objects. A style is omitted rather than written as null: the
// app compiler rejects `style: null` at the same server boundary.
export function nodeStyle(fields) {
  return fields && Object.keys(fields).length ? { '@ctype': 'nodeStyle', ...fields } : null;
}

export function paragraphStyle(align) {
  return align && align !== 'left' ? { '@ctype': 'paragraphStyle', align } : null;
}

export function mergeNodeStyle(...styles) {
  const merged = Object.assign({}, ...styles.filter(Boolean));
  return Object.keys(merged).length ? merged : null;
}

const observedFields = (style) => {
  if (!style || typeof style !== 'object') return null;
  const fields = {};
  for (const field of NODE_STYLE_FIELDS) {
    const value = style[field];
    if (value == null) continue;
    fields[field] = field === 'fontColor' ? String(value).toLowerCase() : value;
  }
  return Object.keys(fields).length ? fields : null;
};

const joinRunText = (runs) => (runs || []).map((run) => run.text).join('');

// Adjacent runs that carry the same style are one run. Editor readback may
// split or merge text nodes; comparing merged runs keeps that harmless.
function mergeRuns(runs) {
  const merged = [];
  for (const run of runs) {
    if (!run.text) continue;
    const key = JSON.stringify(run.style || null);
    const previous = merged.at(-1);
    if (previous && JSON.stringify(previous.style || null) === key) previous.text += run.text;
    else merged.push({ text: run.text, style: run.style || null });
  }
  return merged;
}

function paragraphRecord(align, runs) {
  return { text: text(joinRunText(runs)), align: align || 'left', runs: mergeRuns(runs) };
}

function observedParagraphs(component) {
  return (component?.value || []).map((paragraph) => paragraphRecord(
    paragraph?.style?.align || 'left',
    (paragraph?.nodes || []).filter((node) => node?.['@ctype'] === 'textNode' || node?.value !== undefined)
      .map((node) => ({ text: String(node.value ?? ''), style: observedFields(node.style) })),
  )).filter((paragraph) => paragraph.text);
}

// Paragraphs the author asked presentation for, in document order.
function requestedParagraphs(document) {
  const blocks = document?.blocks || [];
  const requests = [];
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (!['paragraph', 'heading', 'quote'].includes(block?.type)) continue;
    const align = paragraphAlign(block), runs = inlineRuns(block), style = styleFields(block.style);
    if (block.presentation === 'caption' && ['image', 'video'].includes(blocks[index - 1]?.type)) {
      if (!runs && !style && !align) continue;
      requests.push(paragraphRecord(align, runs || [{ text: text(block.text), style }]));
      continue;
    }
    requests.push({ ...paragraphRecord(align, runs || [{ text: text(block.text), style }]),
      quotation: block.type === 'quote' || (block.type === 'heading' && block.presentation === 'quotation') });
  }
  return requests;
}

// Does the authored presentation intent appear in the given editor model?
// Only dimensions the author actually set are compared, so a theme default or
// a server-side null fill cannot masquerade as a lost style.
export function presentationDifferences(document, model) {
  const expected = requestedParagraphs(document);
  const observed = (model?.document?.components || []).flatMap((component) =>
    component?.['@ctype'] === 'quotation' || component?.['@ctype'] === 'text'
      ? observedParagraphs(component)
      : component?.['@ctype'] === 'table'
        ? (component.rows || []).flatMap((row) => (row.cells || []).flatMap((cell) => observedParagraphs(cell)))
        : component?.['@ctype'] === 'image' || component?.['@ctype'] === 'video'
          ? observedParagraphs({ value: component.caption })
          : []);
  const used = new Set();
  const differences = [];
  for (const request of expected) {
    const wanted = request.runs.some((run) => run.style);
    if (request.align === 'left' && !wanted) continue;
    const index = observed.findIndex((candidate, position) => !used.has(position) && candidate.text === request.text);
    if (index < 0) {
      differences.push({ text: request.text.slice(0, 24), difference: 'paragraph_missing' });
      continue;
    }
    used.add(index);
    const actual = observed[index];
    if (request.align !== actual.align)
      differences.push({ text: request.text.slice(0, 24), difference: 'align', expected: request.align, observed: actual.align });
    const expectedStyle = characterStyles(request.runs);
    const actualStyle = characterStyles(actual.runs);
    if (expectedStyle.length !== actualStyle.length) {
      differences.push({ text: request.text.slice(0, 24), difference: 'run_length' });
      continue;
    }
    const reported = new Set();
    for (let position = 0; position < expectedStyle.length; position++) {
      const want = expectedStyle[position], got = actualStyle[position] || {};
      for (const field of Object.keys(want)) {
        if (want[field] !== got[field] && !reported.has(field)) {
          reported.add(field);
          differences.push({ text: request.text.slice(0, 24), difference: field,
            expected: want[field], observed: got[field] ?? null });
          break;
        }
      }
    }
  }
  return differences;
}

const characterStyles = (runs) => runs.flatMap((run) => Array.from({ length: [...run.text].length }, () => run.style || {}));
