import { randomUUID } from 'node:crypto';
import { fingerprint } from '../../../../packages/contracts/src/index.mjs';
import { inspectEditorModel } from './editor-model.mjs';
import { text } from '../gates/publication-document.mjs';

// One reviewed maintenance operation, not an option to skip publication gates.
// Bind the target AND the entire existing article. No caller-supplied prose,
// assets, links, deletions, ordering, title or publication settings are accepted.
export const REVIEWED_REPAIR = Object.freeze({
  id: '2026-09-21-twelve-cm-duplicate-prefix',
  blogId: 'aicandoanything', logNo: '224417664446',
  sourceFingerprint: '2bedf7aee195ea1112dee4504a709586194c6b1e0c3639d647d415929086bfec',
  ownerSourceFingerprint: '7e05f1ae371356cc1cf5df66a4e646b2e94bd1732ddd033bc1af5dd8f7ea8a48',
  imagePairs: Object.freeze([[1,60],[4,66],[7,73],[13,83],[15,87]].map(Object.freeze)),
  order: Object.freeze([23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,2,5,
    39,40,41,42,43,44,45,46,47,20,48,49,50,11,51,52,53,54,55,56,57,58,59,60,
    22,61,62,63,64,65,3,66,8,67,68,69,70,71,72,73,74,75,76,77,78,79,9,16,
    80,81,82,83,84,85,86,87,17,18,21,88,89,90,91,92,93,94,95,96]),
});

export function reviewedRepairDocument(observation) {
  let source = { title: observation?.title, units: observation?.units };
  // The fresh owner response for this exact article uses blogfiles; the public
  // HTML uses postfiles for the same paths. Bind both complete observations,
  // then verify the mapped result, rather than generally treating hosts equal.
  if (fingerprint(source) === REVIEWED_REPAIR.ownerSourceFingerprint)
    source = { title: source.title, units: source.units.map(u => u.type === 'image'
      ? { ...u, value: u.value.replace(/^https:\/\/blogfiles\.pstatic\.net\//, 'https://postfiles.pstatic.net/') } : u) };
  if (fingerprint(source) !== REVIEWED_REPAIR.sourceFingerprint)
    throw Error('REPAIR_SOURCE_CHANGED');
  const units = REVIEWED_REPAIR.order.map(position => source.units[position - 1]);
  return { blogId: REVIEWED_REPAIR.blogId, logNo: REVIEWED_REPAIR.logNo,
    title: source.title, blocks: units.map((u, i) => {
      if (u.type === 'image') return { type: 'image', publishedUrl: u.value };
      if (u.type === 'linkcard') return { type: 'oglink', url: u.value };
      if (u.type === 'divider') return { type: 'divider' };
      return { type: u.type === 'quote' ? 'quote' : i === 0 ? 'notice' : 'paragraph', text: u.value };
    }) };
}

// Preserve every retained paragraph's nodes, styles and hyperlinks. Text
// components may contain many paragraphs; split them without flattening styles.
// This utility cannot write. The caller must separately validate its repair plan.
export function reorderExistingEditorUnits(model, order) {
  const before = inspectEditorModel(model), total = before.units.length;
  if (!Array.isArray(order) || !order.length || new Set(order).size !== order.length ||
      order.some(p => !Number.isInteger(p) || p < 1 || p > total)) throw Error('REPAIR_ORDER');
  const title = model.document.components.find(c => c['@ctype'] === 'documentTitle');
  const atomic = [];
  for (const component of model.document.components) {
    const type = component['@ctype'];
    if (type === 'documentTitle') continue;
    if (type === 'text' || type === 'quotation') {
      let pending = [];
      for (const paragraph of component.value) {
        pending.push(structuredClone(paragraph));
        if (!text(paragraph.nodes.map(n => n.value || '').join(''))) continue;
        atomic.push({ ...structuredClone(component), id: `SE-${randomUUID()}`, value: pending });
        pending = [];
      }
      if (pending.length && atomic.length && atomic.at(-1)['@ctype'] === type)
        atomic.at(-1).value.push(...pending);
    } else {
      // An image caption would introduce another unit; fail instead of losing it.
      const one = inspectEditorModel({ document: { components: [title, component] } });
      if (one.units.length !== 1) throw Error('REPAIR_COMPONENT_SPAN');
      atomic.push(structuredClone(component));
    }
  }
  if (atomic.length !== total) throw Error('REPAIR_COMPONENT_SPAN');
  const result = structuredClone(model);
  result.document.components = [structuredClone(title), ...order.map(p => atomic[p - 1])];
  const expected = { title: before.title, units: order.map(p => before.units[p - 1]) };
  if (fingerprint(inspectEditorModel(result)) !== fingerprint(expected)) throw Error('REPAIR_RENDER_MISMATCH');
  return result;
}

export function verifyReviewedImageRemoval(audit) {
  if (!audit?.checks?.allImagesVerified || audit.imageCount !== 18 || audit.images?.length !== 18)
    throw Error('REPAIR_IMAGES_UNVERIFIED');
  for (const [drop, keep] of REVIEWED_REPAIR.imagePairs) {
    const a = audit.images.find(i => i.position === drop), b = audit.images.find(i => i.position === keep);
    if (!a?.sha256 || a.sha256 !== b?.sha256 || !a.pixelFingerprint || a.pixelFingerprint !== b?.pixelFingerprint)
      throw Error('REPAIR_IMAGE_NOT_DUPLICATE');
  }
}
