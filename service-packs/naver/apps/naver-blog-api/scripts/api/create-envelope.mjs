import { inspectEditorModel } from './editor-model.mjs';
import { fingerprint } from '../../../../packages/contracts/src/index.mjs';
import { renderUnits, text } from '../gates/publication-document.mjs';
const fields = ['blogId', 'documentModel', 'mediaResources', 'populationParams', 'productApiVersion', 'tokenId'].sort();
const fail = (code, details) => { const error = Error(code); if (details) error.details = details; throw error; };

export function createJournalKey(journal, job) {
  return journal.key('createPost', { blogId: job.blogId }, {
    title: text(job.title), units: renderUnits(job.publicationBundle.document), publishSettings: job.publishSettings });
}

// The browser supplies the opaque document metadata and normal SDK token. The
// HTTP compiler replaces the entire body, preserving only observed metadata.
export function createSeedDocument(document) {
  if (!document?.title || !Array.isArray(document.blocks) || document.logNo) fail('CREATE_DOCUMENT_REQUIRED');
  const blocks = renderUnits(document).filter(u => ['text', 'quote'].includes(u.type))
    .map(u => ({ type: 'paragraph', text: u.value }));
  if (!blocks.length || blocks.length > 200 || blocks.some(b => b.text.length > 5000) ||
      blocks.reduce((sum, b) => sum + b.text.length, 0) > 80000) fail('CREATE_DOCUMENT_LIMIT');
  return { blogId: document.blogId, title: text(document.title), blocks };
}

export function validateCreateEnvelope(envelope, { blogId, document, now = new Date(), requireClosed = true } = {}) {
  if (envelope?.blogId !== blogId || !/^[a-zA-Z0-9_-]{3,50}$/.test(blogId || '')) fail('CREATE_SCOPE');
  const age = now.getTime() - Date.parse(envelope.observedAt || '');
  if (!Number.isFinite(age) || age < 0 || age > 60000) fail('CREATE_HANDOFF_EXPIRED');
  if (envelope.browserRequestCancelled !== true || requireClosed && envelope.browserClosed !== true)
    fail('CREATE_BROWSER_NOT_CLOSED_OR_CANCELLED');
  if (typeof envelope.body !== 'string' || Buffer.byteLength(envelope.body) > 2 * 1024 * 1024) fail('CREATE_BODY');
  const body = new URLSearchParams(envelope.body);
  if (JSON.stringify([...body.keys()].sort()) !== JSON.stringify(fields) ||
      body.get('blogId') !== blogId || body.get('productApiVersion') !== 'v1') fail('CREATE_FIELDS');
  const token = body.get('tokenId');
  if (!token || token.length > 8192 || /[\x00-\x20\x7f]/.test(token) ||
      Buffer.from(token, 'base64').toString('utf8').startsWith('FAILURE.')) fail('CREATE_TOKEN');
  let model, population, media;
  try {
    model = JSON.parse(body.get('documentModel')); population = JSON.parse(body.get('populationParams'));
    media = JSON.parse(body.get('mediaResources')); inspectEditorModel(model);
  } catch { fail('CREATE_SCHEMA'); }
  // Fresh new-post captures have documentId:""; document.id and di are supplied
  // by SmartEditor. Preserve the empty outer ID instead of inventing one.
  if (typeof model.documentId !== 'string' || !model.document?.id || !model.document.di ||
      typeof population?.editorSource !== 'string' || !population.editorSource ||
      population?.configuration?.openType !== 0 || population?.populationMeta?.postWriteTimeType !== 'now' ||
      population?.populationMeta?.noticePostYn !== false ||
      ![undefined, null, 0, '0', ''].includes(population?.populationMeta?.logNo)) fail('CREATE_FRESH_PRIVATE_SEED_REQUIRED', {
        documentIdType: typeof model.documentId, documentIdPresent: Boolean(model.documentId),
        documentInnerIdPresent: Boolean(model.document?.id), documentDiPresent: Boolean(model.document?.di),
        editorSourceType: typeof population?.editorSource, privateSeed: population?.configuration?.openType === 0,
        currentTiming: population?.populationMeta?.postWriteTimeType === 'now',
        noticeDisabled: population?.populationMeta?.noticePostYn === false,
        newPostIdentity: [undefined, null, 0, '0', ''].includes(population?.populationMeta?.logNo) });
  if (JSON.stringify(Object.keys(media || {}).sort()) !== '["file","image","video"]' ||
      Object.values(media).some(value => !Array.isArray(value) || value.length)) fail('CREATE_MEDIA');
  if (document) {
    const seed = createSeedDocument(document);
    const observed=inspectEditorModel(model),expected={title:seed.title,units:renderUnits(seed)};
    if (seed.blogId !== blogId || fingerprint(observed) !== fingerprint(expected)) {
      const mismatch=expected.units.findIndex((unit,index)=>fingerprint(unit)!==fingerprint(observed.units[index]??null));
      const summary=unit=>unit?{type:unit.type,length:unit.value?.length??0,fingerprint:fingerprint(unit)}:null;
      fail('CREATE_SEED_CONTENT_MISMATCH',{
        titleMatches:observed.title===expected.title,expectedUnitCount:expected.units.length,observedUnitCount:observed.units.length,
        expectedFingerprint:fingerprint(expected),observedFingerprint:fingerprint(observed),firstMismatchIndex:mismatch,
        expectedUnit:mismatch>=0?summary(expected.units[mismatch]):null,observedUnit:mismatch>=0?summary(observed.units[mismatch]):null,
      });
    }
  }
  return { model, population, token, handoffAgeMs: age };
}
