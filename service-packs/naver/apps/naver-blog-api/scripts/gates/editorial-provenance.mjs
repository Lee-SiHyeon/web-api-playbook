import { text, documentFingerprint } from './publication-document.mjs';

export const editorialDimensions = ['hookPayoff','specificity','readerValue','economyFlow'];

// Records an explicit user instruction to publish this document without a
// separate editorial reviewer. This is not independent-review evidence or an
// authentication mechanism; the ordinary publish-once authorization still applies.
export function userDirectedEditorialWaiver(bundle, { now = new Date() } = {}) {
  const review = bundle?.qualityReview, directive = review?.userDirective;
  const age = now.getTime() - Date.parse(directive?.recordedAt);
  return directive?.source === 'conversation_user_instruction' &&
    directive?.approvedBy === 'user' &&
    directive?.scope === 'independent_editorial_review_only' &&
    text(directive?.instruction).length >= 12 &&
    text(directive?.conversationId).length >= 8 &&
    directive?.documentFingerprint === documentFingerprint(bundle?.document) &&
    directive?.blogId === bundle?.document?.blogId &&
    String(directive?.logNo || '') === String(bundle?.document?.logNo || '') &&
    Number.isFinite(age) && age >= 0 && age <= 120 * 60000 &&
    text(bundle?.authorExecutionId).length >= 8 &&
    review?.reviewerRole === 'author_self_review' &&
    review?.reviewerId === bundle?.authorId &&
    review?.provenance?.method === 'author_self_review' &&
    review.provenance.authorExecutionId === bundle.authorExecutionId &&
    review.provenance.reviewerExecutionId === bundle.authorExecutionId;
}

// The current ChatGPT task may review its own draft under the user's direct
// workflow. This is explicitly an owner review, never independent evidence.
export function ownerEditorialReviewProvenance(bundle) {
  const review = bundle?.qualityReview, provenance = review?.provenance;
  const execution = bundle?.authorExecutionId;
  return review?.reviewerRole === 'author_self_review' &&
    text(bundle?.authorId).length >= 3 &&
    review?.reviewerId === bundle?.authorId &&
    provenance?.method === 'chatgpt_owner_review' &&
    (execution === '/root' || text(execution).length >= 8) &&
    provenance.authorExecutionId === execution &&
    provenance.reviewerExecutionId === execution &&
    text(provenance.receipt).length >= 8;
}

export function editorialProvenanceAllowed(bundle, { now = new Date() } = {}) {
  return editorialReviewChecks(bundle).independentReviewProvenance === true ||
    ownerEditorialReviewProvenance(bundle) || userDirectedEditorialWaiver(bundle, { now });
}

// These records establish who reviewed which passages, not a calibrated quality
// score or an independent human opinion. Missing assessments never mean pass.
export function editorialReviewChecks(bundle) {
  const review = bundle?.qualityReview;
  const provenance = review?.provenance;
  // /root is the actual canonical primary-agent execution name. Its short
  // length must not force authors to invent a different reviewer identity.
  const execution = value => typeof value === 'string' && (value === '/root' || value.trim().length >= 8);
  const blocks = bundle?.document?.blocks || [];
  const assessments = review?.editorialAssessments;
  const assessedText = block => block?.type === 'table'
    ? [block.columns, ...(block.rows || [])].flat().join(' ')
    : block?.text || block?.label || (block?.items || []).join(' ');
  const grounded = item => item?.status === 'pass' && text(item.rationale).length >= 30 &&
    Array.isArray(item.blockIndexes) && item.blockIndexes.length > 0 &&
    item.blockIndexes.every(i => Number.isInteger(i) && i >= 0 && i < blocks.length &&
      text(assessedText(blocks[i])));
  return {
    independentReviewProvenance: ['separate_agent','human'].includes(provenance?.method) &&
      execution(bundle?.authorExecutionId) &&
      provenance?.authorExecutionId === bundle.authorExecutionId &&
      execution(provenance?.reviewerExecutionId) &&
      provenance.reviewerExecutionId !== bundle.authorExecutionId &&
      text(provenance?.receipt).length >= 8 &&
      !/same assistant|same model.*persona|self[-_ ]review|동일.*(?:어시스턴트|작성|모델)|자기검토/i.test(review?.reviewMode || ''),
    editorialAssessmentsPresent: editorialDimensions.every(k => grounded(assessments?.[k])),
    semanticRepetitionReviewed: grounded(assessments?.semanticRepetition),
    editorialReviewArtifactBound: typeof review?.evidenceFile === 'string' &&
      /^[a-f0-9]{64}$/.test(review?.evidenceSha256 || ''),
  };
}
