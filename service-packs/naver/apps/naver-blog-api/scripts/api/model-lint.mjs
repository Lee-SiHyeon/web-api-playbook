import { fingerprint } from '../../../../packages/contracts/src/index.mjs';
import { text, imageIdentity, renderUnits } from '../gates/publication-document.mjs';
import { inspectEditorModel, editorPresentationFingerprint } from './editor-model.mjs';

// Browser-free review of an HTTP-compiled editor model. It checks everything
// the native preview checks that is determined by the model itself, fetches
// every media asset over HTTP, and classifies layout risk. It does NOT replace
// the rendered preview: geometry (table width, spacing, overflow) is only
// predicted. Use it to iterate on a draft without a browser, then run one
// native preview on the final revision (or rebind an earlier preview when the
// compiled presentation is provably unchanged).

// Observed on 2026-09-24 (naver_editor mobile, 400 px viewport): 3-column tables
// with wrapped Korean cells rendered inside the column; a 4-column table with
// short cells overflowed (475 px > 380 px). Tokens longer than this many
// characters could not be wrapped and are treated as a risk.
export const LAYOUT_LIMITS = Object.freeze({ maxTableColumns: 3, maxCellToken: 14, maxParagraph: 600, minImageWidth: 200 });

const paragraphText = values => (values || []).map(p => text((p.nodes || []).map(n => n.value || '').join(''))).filter(Boolean);
const longestToken = value => Math.max(0, ...String(value).split(/\s+/).map(t => [...t].length));

export async function lintCompiledModel({ model, document, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const checks = {}, riskFactors = [], media = [];
  const components = model?.document?.components || [];
  const body = components.filter(c => c['@ctype'] !== 'documentTitle');
  const observed = inspectEditorModel(model);
  checks.titleMatches = observed.title === text(document.title);
  checks.unitsMatch = fingerprint(observed.units) === fingerprint(renderUnits(document));

  const blocks = document.blocks || [];
  // Walk blocks and components together; captions fold into their media component.
  let ci = 0;
  const pairs = [];
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    if (b.type === 'spacer') continue;
    if (b.type === 'paragraph' && b.presentation === 'caption' && ['image', 'video'].includes(blocks[bi - 1]?.type)) continue;
    pairs.push({ block: b, index: bi, component: body[ci++] });
  }
  checks.componentCountMatches = ci === body.length;

  const headings = pairs.filter(p => p.block.type === 'heading');
  checks.headingsStyled = headings.every(({ block, component }) =>
    component?.['@ctype'] === (block.presentation === 'quotation' ? 'quotation' : 'text') &&
    component.value?.[0]?.nodes?.[0]?.style?.bold === true);
  const panels = pairs.filter(p => p.block.type === 'notice' && p.block.presentation === 'panel');
  checks.disclosurePanels = panels.every(({ component }) =>
    component?.['@ctype'] === 'table' && component.columnCount === 1 && component.rows?.[0]?.cells?.[0]?.backgroundColor === '#f2f2f2');
  checks.linksLabeled = pairs.filter(p => p.block.type === 'link').every(({ block, component }) => {
    const nodes = (component?.value || []).flatMap(p => p.nodes || []);
    return nodes.some(n => n.link?.url === block.url && text(n.value) === text(block.display === 'label' ? block.label : block.url)) &&
      (block.display !== 'label' || text(block.label).length >= 4);
  });
  const captionOf = index => blocks[index + 1]?.type === 'paragraph' && blocks[index + 1].presentation === 'caption' ? [text(blocks[index + 1].text)] : [];
  const images = pairs.filter(p => p.block.type === 'image'), videos = pairs.filter(p => p.block.type === 'video');
  checks.imagesBound = images.every(({ block, component }) => component?.['@ctype'] === 'image' &&
    imageIdentity(component.src) === imageIdentity(block.publishedUrl) && !component.link === !block.href);
  checks.imageCaptions = images.every(({ index, component }) => fingerprint(paragraphText(component?.caption)) === fingerprint(captionOf(index)));
  checks.videosBound = videos.every(({ block, component }) => component?.['@ctype'] === 'video' && component.vid === block.videoId &&
    (!block.uploadReceipt || component.thumbnail?.src === block.uploadReceipt.thumbnail?.url && text(component.mediaMeta?.title) === text(block.uploadReceipt.mediaMeta?.title)));
  checks.videoCaptions = videos.every(({ index, component }) => fingerprint(paragraphText(component?.caption)) === fingerprint(captionOf(index)));
  const tables = pairs.filter(p => p.block.type === 'table');
  checks.tablesCompiled = tables.every(({ block, component }) => component?.['@ctype'] === 'table' &&
    component.columnCount === block.columns.length && component.rows?.length === block.rows.length + 1);

  // Media reachability over HTTP (no browser): every image and video thumbnail.
  for (const { block, component } of [...images, ...videos]) {
    const url = block.type === 'image' ? component?.src : component?.thumbnail?.src;
    let status = null, mime = null, bytes = 0;
    try {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const r = await fetchImpl(url, { signal: controller.signal, headers: { referer: 'https://blog.naver.com/' } });
        status = r.status; mime = (r.headers.get('content-type') || '').split(';')[0];
        bytes = (await r.arrayBuffer()).byteLength;
      } finally { clearTimeout(timer); }
    } catch { status = null; }
    media.push({ type: block.type, url, status, mime, bytes });
  }
  checks.mediaReachable = media.every(m => m.status === 200 && /^image\//.test(m.mime || '') && m.bytes > 0);

  // Layout risk: only geometry that the model cannot prove.
  for (const { block, index } of tables) {
    if (block.columns.length > LAYOUT_LIMITS.maxTableColumns) riskFactors.push({ block: index, factor: 'table_columns', value: block.columns.length });
    const token = Math.max(...[block.columns, ...block.rows].flat().map(longestToken));
    if (token > LAYOUT_LIMITS.maxCellToken) riskFactors.push({ block: index, factor: 'table_cell_token', value: token });
  }
  for (const [index, b] of blocks.entries()) {
    const t = text(b.text || (b.items || []).join(' '));
    if (t.length > LAYOUT_LIMITS.maxParagraph) riskFactors.push({ block: index, factor: 'long_paragraph', value: t.length });
    if (b.type === 'image' && Number(b.uploadReceipt?.width) < LAYOUT_LIMITS.minImageWidth) riskFactors.push({ block: index, factor: 'narrow_image', value: b.uploadReceipt?.width ?? null });
  }
  const failedChecks = Object.keys(checks).filter(k => checks[k] !== true);
  return {
    schemaVersion: 1, source: 'compiled_model_http', browserUsed: false, checkedAt: new Date().toISOString(),
    passed: failedChecks.length === 0, checks, failedChecks,
    layoutRisk: riskFactors.length ? 'needs_native_preview' : 'low', riskFactors, media,
    compiledPresentationFingerprint: editorPresentationFingerprint(model),
    renderUnitsFingerprint: fingerprint(renderUnits(document)),
    limitation: 'Geometry is predicted, not rendered. Publication still requires a native preview bound to this compiled presentation.',
  };
}
