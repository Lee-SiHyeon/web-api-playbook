import { createHash } from 'node:crypto';
import { buildEvidenceMatrix } from './evidence.mjs';
import { requireCapturedOperation, requireCapturedRequestOperation } from './contract.mjs';
import { GeminiClientError } from './errors.mjs';
import { GeminiWebHttpTransport } from './http-transport.mjs';
import { executeMutationOnce } from './mutation.mjs';
import { parseBatchResponse, requireRpcResponse } from './batch-response.mjs';
import { JOB_DIR, findUnresolvedMutation, markMutationReconciled, mutationIntentDigest } from './journal.mjs';
import { buildHistoryListRequest, historyListRpcId } from './rpc-adapters.mjs';
import { buildCapturedTextRequest, inspectCapturedAttachmentReference } from './text-adapter.mjs';
import { geminiDocumentHasExpectedOwner, refreshGeminiHttpSession } from './http-session-bootstrap.mjs';
import { renewGeminiSession } from './session-renewal.mjs';
import { buildHistoryDetailRequest, inspectHistoryDetailResponse } from './history-detail.mjs';
import {
  extractConversationSummaries, readModels, readSettings, readPublicShareLinks, readAnonymousSharedConversation, searchConversations,
  readSharedConversation,
} from './conversation-lifecycle.mjs';
import {
  mutateConversationOnce, createConversationShareOnce, revokePublicShareLinkOnce,
} from './lifecycle-mutation.mjs';
import { submitCapturedMediaOnce } from './media-direct-once.mjs';
import { decodeGeminiMediaResponse } from './media-response.mjs';
import { validateMediaCapture } from './media-capture.mjs';
import { downloadGeminiMediaAssetOnce, downloadGeminiTaskMediaAssetOnce } from './media-download.mjs';
import { downloadGeminiOriginalImageOnce } from './original-image-download.mjs';
import {
  uploadAttachmentOnce as sendAttachmentUploadOnce, validateAttachmentUploadCookieSnapshot,
} from './attachment-upload.mjs';
import { validateSessionBundle } from './session.mjs';
import {
  createGeminiModelSelectionController, GEMINI_MODEL_SELECTION_SOURCE, readCapturedGeminiModelRequestMetadata,
} from './model-selection.mjs';
import {
  readGeminiPreference, testAndRestoreGeminiPreference, updateGeminiPreferenceOnce,
} from './settings-update.mjs';

const historyDetailTaskTickets = new WeakMap();

function clearTaskReadbackValues(value, seen = new Set()) {
  if (Buffer.isBuffer(value)) {
    value.fill(0);
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      try {
        if (typeof value[index] === 'string') value[index] = '';
        else clearTaskReadbackValues(value[index], seen);
      } catch { /* Best-effort clearing of parsed task data. */ }
    }
    return;
  }
  for (const key of Object.keys(value)) {
    try {
      if (typeof value[key] === 'string') value[key] = '';
      else clearTaskReadbackValues(value[key], seen);
    } catch { /* Frozen metadata summaries are not writable. */ }
  }
}

export class GeminiWebClient {
  constructor({ contract, session, fetchImpl } = {}) {
    if (!contract) throw new GeminiClientError('CONTRACT_NOT_CAPTURED', 'An observed Gemini web contract is required.');
    this.contract = contract;
    this.transport = new GeminiWebHttpTransport({ contract, session, fetchImpl });
    this.verifiedOwner = null;
    this.nextHistoryRequestId = Number(this.transport.session?.batchContext?.requestId || 0);
    this.modelSelection = createGeminiModelSelectionController({ client: this });
    this.operationHandlers = Object.freeze({
      identity: this.verifyOwner.bind(this),
      history_list: this.listHistory.bind(this),
      history_read: this.readHistoryDetail.bind(this),
      history_search: this.searchHistory.bind(this),
      model_list: this.listModels.bind(this),
      model_select: this.selectModelChoice.bind(this),
      selection_state: this.getSelectedModelChoice.bind(this),
      settings_read: this.readSettings.bind(this),
      settings_update: this.updateSettingsPreference.bind(this),
      share_read: this.readPublicShareLinks.bind(this),
      share_public_read: this.readSharedConversation.bind(this),
      edit: this.renameConversation.bind(this),
      delete: this.deleteConversation.bind(this),
      share_create: this.createConversationShare.bind(this),
      share_revoke: this.revokePublicShareLink.bind(this),
      attachment_upload: this.uploadAttachmentOnce.bind(this),
      image: this.generateImageOnce.bind(this),
      video: this.generateVideoOnce.bind(this),
      text: this.generateTextOnce.bind(this),
    });
    this.implementedCapabilities = Object.freeze({
      history: Object.freeze({ clientExists: true, remnantFree: true }),
      image: Object.freeze({ clientExists: true, remnantFree: false }),
      video: Object.freeze({ clientExists: true, remnantFree: false }),
    });
  }

  evidence() {
    return buildEvidenceMatrix(this.contract, this.implementedCapabilities);
  }

  operationEvidence() {
    return Object.freeze(Object.fromEntries(Object.entries(this.operationHandlers).map(([name, handler]) => {
      const operation = this.contract.operations?.[name];
      const pairedResponse = operation?.observation?.requestResponse === true;
      const requestCaptured = operation?.observation?.request === true || pairedResponse;
      const requestOnlyMutation = operation?.effect === 'mutation'
        && requestCaptured && operation?.observation?.requestResponse === false;
      return [name, Object.freeze({
        handlerName: handler.name.replace(/^bound /, ''),
        installed: typeof handler === 'function',
        ...(name === 'model_select' || name === 'selection_state' ? {
          sourceControlCaptured: true,
          sourceControlContractPath: GEMINI_MODEL_SELECTION_SOURCE.localControlContractFragment,
        } : {}),
        contractCaptured: name === 'attachment_upload' ? this.contract.attachmentUpload !== undefined
          : pairedResponse || requestOnlyMutation,
        requestCaptured: name === 'attachment_upload' ? this.contract.attachmentUpload !== undefined : requestCaptured,
        ...(operation?.effect === 'mutation' ? {
          normalUiRequestCaptured: requestCaptured,
          normalUiResponseCaptured: pairedResponse,
          mutationContractType: requestOnlyMutation && operation?.request?.path === '/_/BardChatUi/data/batchexecute'
            ? 'request_only_batchexecute'
            : requestOnlyMutation ? 'request_only_other_http'
            : pairedResponse ? 'ui_paired' : 'missing',
        } : {}),
      })];
    })));
  }

  async invoke(operationName, ...args) {
    const handler = this.operationHandlers[operationName];
    if (!handler) throw new GeminiClientError('OPERATION_ADAPTER_NOT_IMPLEMENTED', 'No reviewed Gemini operation handler is installed.');
    return handler(...args);
  }

  async read(capability, requestSpec) {
    const operation = requireCapturedOperation(this.contract, capability);
    if (operation.effect !== 'read') {
      throw new GeminiClientError('OPERATION_EFFECT_MISMATCH', 'A mutating Gemini operation cannot use the read method.');
    }
    return this.transport.request(capability, requestSpec);
  }

  async verifyOwner(expectedOwner) {
    if (typeof expectedOwner !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(expectedOwner)) {
      throw new GeminiClientError('OWNER_EXPECTATION_INVALID', 'A valid expected Gemini account address is required.');
    }
    const requestSpec = {
      method: 'GET',
      path: '/app',
      query: [],
      headers: {},
    };
    const response = await this.read('identity', requestSpec);
    const html = response.body.toString('utf8');
    const anonymous = await this.transport.request('identity', requestSpec, { omitCredentials: true });
    const anonymousHtml = anonymous.body.toString('utf8');
    const anonymousOwnerAbsent = !geminiDocumentHasExpectedOwner(anonymousHtml, expectedOwner, { allowMissingWiz: true });
    const ownerMatched = geminiDocumentHasExpectedOwner(html, expectedOwner, { allowMissingWiz: true }) && anonymousOwnerAbsent;
    this.verifiedOwner = ownerMatched ? expectedOwner.trim().toLowerCase() : null;
    const identityHeaders = this.transport.session?.requestHeaders?.identity ?? {};
    const result = Object.freeze({
      ownerMatched,
      anonymousOwnerAbsent,
      httpStatus: response.httpStatus,
      responseBytes: response.responseBytes,
      responseSha256: createHash('sha256').update(response.body).digest('hex'),
      anonymousHttpStatus: anonymous.httpStatus,
      credentialPropagated: response.credentialPropagated,
      request: Object.freeze({
        method: requestSpec.method,
        origin: this.contract.operations.identity.request.origin,
        path: requestSpec.path,
        queryKeys: Object.freeze([]),
        headerNames: Object.freeze([...new Set([
          ...Object.keys(requestSpec.headers), ...Object.keys(identityHeaders),
        ].map((name) => name.toLowerCase()))].sort()),
        valuesPersisted: false,
      }),
    });
    response.body.fill(0);
    anonymous.body.fill(0);
    return result;
  }

  async refreshSession(expectedOwner) {
    const refreshed = await refreshGeminiHttpSession({ client: this, expectedOwner });
    this.transport.session = Object.freeze({
      ...this.transport.session,
      batchContext: refreshed.batchContext,
    });
    this.nextHistoryRequestId = Number(refreshed.batchContext.requestId);
    this.verifiedOwner = refreshed.ownerMatched === true && refreshed.anonymousOwnerAbsent === true
      ? String(expectedOwner).trim().toLowerCase() : null;
    return refreshed;
  }

  async renewSession({ expectedOwner, acquireSession } = {}) {
    const result = await renewGeminiSession({ client: this, expectedOwner, acquireSession,
      createCandidate: (options) => new GeminiWebClient(options),
    });
    this.modelSelection = createGeminiModelSelectionController({ client: this });
    return result;
  }

  async listHistory() {
    const session = this.transport.session;
    if (!session?.batchContext || !Number.isSafeInteger(this.nextHistoryRequestId) || this.nextHistoryRequestId < 0) {
      throw new GeminiClientError('SESSION_CONTEXT_REQUIRED', 'A numeric Gemini request sequence is required for history reads.');
    }
    const requestSession = Object.freeze({
      ...session,
      batchContext: Object.freeze({ ...session.batchContext, requestId: String(this.nextHistoryRequestId) }),
    });
    this.nextHistoryRequestId += 1;
    const requestSpec = buildHistoryListRequest(this.contract, requestSession);
    const response = await this.read('history_list', requestSpec);
    const operation = requireCapturedOperation(this.contract, 'history_list');
    const frames = parseBatchResponse(response.body, {
      lengthUnit: operation.response.frameLengthUnit,
      frameLengthOverheadUnits: operation.response.frameLengthOverheadUnits,
    });
    const rpc = requireRpcResponse(frames, historyListRpcId());
    return Object.freeze({
      httpStatus: response.httpStatus,
      contentType: response.contentType,
      responseBytes: response.responseBytes,
      responseSha256: createHash('sha256').update(response.body).digest('hex'),
      credentialPropagated: response.credentialPropagated,
      rpcId: rpc.rpcId,
      data: rpc.data,
    });
  }

  async readHistoryDetail({ apiConversationId, visibleRouteId, expectedIntent, mediaCapability = 'history' } = {}) {
    const operation = requireCapturedOperation(this.contract, 'history_read');
    if (operation.effect !== 'read') {
      throw new GeminiClientError('OPERATION_EFFECT_MISMATCH', 'A mutating Gemini operation cannot use the history detail read method.');
    }
    if (!this.transport.session?.batchContext
        || !Number.isSafeInteger(this.nextHistoryRequestId) || this.nextHistoryRequestId < 0) {
      throw new GeminiClientError('SESSION_CONTEXT_REQUIRED', 'A numeric Gemini request sequence is required for history detail reads.');
    }
    const requestId = String(this.nextHistoryRequestId++);
    const { requestSpec, binding } = buildHistoryDetailRequest(this.contract, this.transport.session, {
      apiConversationId,
      visibleRouteId,
      requestId,
    });
    const response = await this.read('history_read', {
      ...requestSpec,
      headers: this.transport.session.requestHeaders?.history_read ?? {},
    });
    const detail = inspectHistoryDetailResponse(response.body, operation, {
      expectedIntent,
      expectedApiConversationId: apiConversationId,
      assetOrigins: this.contract.assetOrigins,
      capability: mediaCapability,
    });
    const responseSha256 = createHash('sha256').update(response.body).digest('hex');
    response.body.fill(0);
    const result = {
      httpStatus: response.httpStatus,
      contentType: response.contentType,
      responseBytes: response.responseBytes,
      responseSha256,
      credentialPropagated: response.credentialPropagated,
      binding,
      summary: detail.summary,
    };
    Object.defineProperties(result, {
      payload: { value: detail.internal.payload, enumerable: false },
      media: { value: detail.internal.media, enumerable: false },
    });
    const frozen = Object.freeze(result);
    if (detail.summary.rpcMatchCount === 1 && detail.summary.taskIntentMatched === true
        && detail.summary.apiConversationIdMatched === true && binding.bound === true) {
      historyDetailTaskTickets.set(frozen, Object.freeze({
        client: this,
        owner: this.verifiedOwner,
        capability: mediaCapability,
        candidateUrls: Object.freeze((detail.internal.media?.assetCandidates ?? []).map((candidate) => candidate.url)),
        excludedCandidateUrls: Object.freeze((detail.internal.media?.assetCandidates ?? []).map((candidate) => candidate.url)),
      }));
    }
    return frozen;
  }

  async searchHistory({ expectedOwner, query } = {}) {
    return searchConversations(this, { expectedOwner, query });
  }

  async listModels({ expectedOwner } = {}) {
    return readModels(this, { expectedOwner });
  }

  async listModelChoices({ expectedOwner } = {}) {
    return this.modelSelection.choices({ expectedOwner });
  }

  selectModelChoice(choice) {
    return this.modelSelection.select(choice);
  }

  getSelectedModelChoice({ isTemporaryChat = false } = {}) {
    const selected = this.modelSelection.selected();
    return Object.freeze({
      ...selected,
      preparedRequestMetadata: this.modelSelection.requestMetadata({ isTemporaryChat }),
      selectionEffect: 'local_client_state_and_per_request_metadata',
      serverPreferenceWritePerformed: false,
      businessRequestDispatched: false,
    });
  }

  async readSettings({ expectedOwner, keys } = {}) {
    return readSettings(this, { expectedOwner, keys });
  }

  async readPreference({ expectedOwner, preferenceKey } = {}) {
    return readGeminiPreference(this, { expectedOwner, preferenceKey });
  }

  async updateSettingsPreference({
    expectedOwner, preferenceKey, value, baselineValue, confirmed, callerIntent, journalRoot,
  } = {}) {
    return updateGeminiPreferenceOnce(this, {
      expectedOwner, preferenceKey, value, baselineValue, confirmed, callerIntent, journalRoot,
    });
  }

  async testAndRestoreSettingsPreference({
    expectedOwner, preferenceKey, expectedBaselineValue, callerIntent, confirmed, journalRoot,
  } = {}) {
    return testAndRestoreGeminiPreference(this, {
      expectedOwner, preferenceKey, expectedBaselineValue, callerIntent, confirmed, journalRoot,
    });
  }

  async readPublicShareLinks({ expectedOwner } = {}) {
    return readPublicShareLinks(this, { expectedOwner });
  }

  async readSharedConversation({ shareId, expectedOwner } = {}) {
    return readSharedConversation(this, { shareId, expectedOwner });
  }

  async readAnonymousSharedConversation({ shareId } = {}) {
    return readAnonymousSharedConversation(this, { shareId });
  }

  async renameConversation({ newTitle, ...mutation } = {}) {
    return mutateConversationOnce(this, {
      ...mutation,
      operationName: 'edit',
      requiredPayloadValues: [newTitle],
    });
  }

  async deleteConversation(mutation = {}) {
    return mutateConversationOnce(this, {
      ...mutation,
      operationName: 'delete',
      requiredPayloadValues: [],
    });
  }

  async createConversationShare(mutation = {}) {
    return createConversationShareOnce(this, mutation);
  }

  async revokePublicShareLink(mutation = {}) {
    return revokePublicShareLinkOnce(this, mutation);
  }

  async uploadAttachmentOnce({
    expectedOwner,
    callerIntent,
    capture,
    uploadCookies,
    file,
    journalRoot,
    fetchImpl,
    continuationCaptureProvider,
    useInstalledContinuationTemplate,
    uploadCookieRefreshProvider,
    uploadResponseHandler,
  } = {}) {
    if (typeof expectedOwner !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(expectedOwner)
        || typeof callerIntent !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(callerIntent)) {
      throw new GeminiClientError('MUTATION_INTENT_INVALID', 'A valid owner and stable upload caller intent are required.');
    }
    const identity = await this.verifyOwner(expectedOwner);
    if (identity.ownerMatched !== true || identity.anonymousOwnerAbsent !== true) {
      return Object.freeze({
        service: this.contract.service,
        operation: 'attachment_upload',
        requestSent: false,
        ownerMatched: identity.ownerMatched,
        anonymousOwnerAbsent: identity.anonymousOwnerAbsent,
        credentialPropagated: identity.credentialPropagated,
        outputStatus: 'owner_gate_failed',
      });
    }
    if (uploadCookieRefreshProvider !== undefined && typeof uploadCookieRefreshProvider !== 'function') {
      throw new GeminiClientError('ATTACHMENT_UPLOAD_OPTIONS_INVALID', 'The fresh upload-cookie provider must be a function.');
    }
    let latestIdentity = identity;
    const verifyFreshUploadCookies = uploadCookieRefreshProvider ? async (details) => {
      const freshCookies = validateAttachmentUploadCookieSnapshot(
        this.contract.attachmentUpload, details.uploadUrl,
        await uploadCookieRefreshProvider(),
      );
      const previousSession = this.transport.session;
      const previousOwner = this.verifiedOwner;
      const freshValues = new Map(freshCookies.map((cookie) => [cookie.name, cookie.value]));
      const nextSession = validateSessionBundle({
        ...previousSession,
        cookies: previousSession.cookies.map((cookie) => ({
          ...cookie,
          ...(freshValues.has(cookie.name) ? { value: freshValues.get(cookie.name) } : {}),
        })),
      }, this.contract);
      this.transport.session = nextSession;
      try {
        latestIdentity = await this.verifyOwner(expectedOwner);
        if (latestIdentity.ownerMatched !== true || latestIdentity.anonymousOwnerAbsent !== true) {
          throw new GeminiClientError('ATTACHMENT_UPLOAD_OWNER_REFRESH_FAILED', 'Fresh upload cookies did not retain the verified Gemini owner.');
        }
        return freshCookies;
      } catch (error) {
        this.transport.session = previousSession;
        this.verifiedOwner = previousOwner;
        throw error;
      }
    } : undefined;
    const result = await sendAttachmentUploadOnce({
      contract: this.contract.attachmentUpload,
      capture,
      uploadCookies,
      file,
      actor: expectedOwner,
      callerIntent,
      journalRoot,
      fetchImpl,
      continuationCaptureProvider,
      useInstalledContinuationTemplate,
      uploadCookieRefreshProvider: verifyFreshUploadCookies,
      uploadResponseHandler,
    });
    const wrapped = {
      service: this.contract.service,
      operation: 'attachment_upload',
      ownerMatched: true,
      anonymousOwnerAbsent: true,
      credentialPropagated: latestIdentity.credentialPropagated,
      ...(uploadCookieRefreshProvider ? { freshUploadCookieOwnerVerified: latestIdentity.ownerMatched === true
        && latestIdentity.anonymousOwnerAbsent === true } : {}),
      ...result,
    };
    if (result.internal?.attachmentRef) {
      Object.defineProperty(wrapped, 'internal', { value: result.internal, enumerable: false });
    }
    return Object.freeze(wrapped);
  }

  async generateImageOnce(options = {}) {
    return this.generateMediaOnce({ ...options, capability: 'image' });
  }

  async generateVideoOnce(options = {}) {
    return this.generateMediaOnce({ ...options, capability: 'video' });
  }

  async generateMediaOnce({
    capability = 'image', capture, expectedOwner, expectedIntent, callerIntent, journalRoot = JOB_DIR,
  } = {}) {
    if (!['image', 'video'].includes(capability)) {
      throw new GeminiClientError('OPERATION_ADAPTER_NOT_IMPLEMENTED', 'Only the observed Gemini image and video media adapters are installed.');
    }
    const inspectedCapture = validateMediaCapture(capture, { capability, expectedIntent });
    const identity = await this.refreshSession(expectedOwner);
    if (identity.ownerMatched !== true || identity.anonymousOwnerAbsent !== true) {
      return Object.freeze({
        summary: Object.freeze({
          service: this.contract.service, operation: capability, requestSent: false,
          ownerMatched: identity.ownerMatched, anonymousOwnerAbsent: identity.anonymousOwnerAbsent,
          credentialPropagated: identity.credentialPropagated, outputStatus: 'owner_gate_failed',
        }),
      });
    }
    if (!this.transport.session?.batchContext) {
      throw new GeminiClientError('SESSION_CONTEXT_REQUIRED', 'A current Gemini history context is required for task readback.');
    }

    let before = await this.listHistory();
    const beforeRows = extractConversationSummaries(before.data);
    const beforeCount = beforeRows.length;
    const beforeIds = new Set(beforeRows.map((row) => row.conversationId));
    before = null;
    let direct;
    let mainMedia;
    let afterRows = [];
    let detail = null;
    let readbackErrorCode = null;
    try {
      direct = await submitCapturedMediaOnce({
        baseContract: this.contract,
        sessionBundle: this.transport.session,
        capture,
        capability,
        actor: expectedOwner,
        callerIntent,
        expectedIntent,
        journalRoot,
      });
      const responseSha256 = createHash('sha256').update(direct.body).digest('hex');
      mainMedia = decodeGeminiMediaResponse(direct.body, {
        capability,
        contentType: direct.contentType,
        assetOrigins: this.contract.assetOrigins,
        expectedIntent,
      });

      let apiConversationId = null;
      const responseConversationIds = [...new Set(mainMedia.internal.resourceIds
        .filter((item) => /^(?:conversation|thread)Id$/i.test(item.kind)
          && /^c_[0-9a-f]{16}$/.test(item.value))
        .map((item) => item.value))];
      try {
        const after = await this.listHistory();
        afterRows = extractConversationSummaries(after.data);
        const newRows = afterRows.filter((row) => !beforeIds.has(row.conversationId));
        const responseId = responseConversationIds.length === 1 ? responseConversationIds[0] : null;
        apiConversationId = responseId && afterRows.some((row) => row.conversationId === responseId)
          ? responseId : newRows.length === 1 ? newRows[0].conversationId : null;
      } catch (error) {
        readbackErrorCode = error instanceof GeminiClientError ? error.code : 'HISTORY_LIST_READBACK_FAILED';
      }

      if (apiConversationId) {
        try {
          detail = await this.readHistoryDetail({
            apiConversationId,
            visibleRouteId: apiConversationId.slice(2),
            expectedIntent,
            mediaCapability: capability,
          });
        } catch (error) {
          readbackErrorCode = error instanceof GeminiClientError ? error.code : 'HISTORY_DETAIL_READBACK_FAILED';
        }
      } else if (!readbackErrorCode) {
        readbackErrorCode = responseConversationIds.length > 1 || afterRows.length === 0
          ? 'TASK_CONVERSATION_UNBOUND' : 'TASK_CONVERSATION_DELTA_AMBIGUOUS';
      }

      const detailMedia = detail?.media;
      const detailAssets = detailMedia?.assetCandidates ?? [];
      const mainAssets = mainMedia.internal.assetCandidates;
      const detailInline = detailMedia?.inlineMediaCandidates ?? [];
      const mainInline = mainMedia.internal.inlineMediaCandidates;
      const detailUrls = new Set(detailAssets.map((candidate) => candidate.url));
      const sharedAssetUrls = [...new Set(mainAssets.filter((candidate) => detailUrls.has(candidate.url)).map((candidate) => candidate.url))];
      const detailInlineFingerprints = new Set(detailInline.map((candidate) => createHash('sha256').update(candidate.body).digest('hex')));
      const matchingMainInline = mainInline.find((candidate) => detailInlineFingerprints.has(
        createHash('sha256').update(candidate.body).digest('hex'),
      ));
      const detailPromptMatched = detail?.summary.taskIntentMatched === true;
      const detailApiIdMatched = detail?.summary.apiConversationIdMatched === true;
      const routeBound = detail?.binding.bound === true;
      const directReadbackVerified = Boolean(detail && detail.httpStatus === 200 && detailPromptMatched
        && detailApiIdMatched && routeBound);
      const sharedAssetUrl = sharedAssetUrls.length === 1 ? sharedAssetUrls[0] : null;
      const inlineMedia = matchingMainInline ?? (mainInline.length === 0 ? detailInline[0] ?? null : null);
      const mediaReferenceVerified = Boolean(sharedAssetUrl || inlineMedia);
      const taskVerified = directReadbackVerified && mediaReferenceVerified;

      let journalReconciled = false;
      if (taskVerified) {
        const intentKeyHash = mutationIntentDigest({ capability, actor: expectedOwner, callerIntent });
        const pending = await findUnresolvedMutation(capability, intentKeyHash, { root: journalRoot });
        if (pending) {
          await markMutationReconciled(pending.jobPath, { found: true, resultCategory: 'task_detail_media_reference_readback' });
          journalReconciled = true;
        }
      }

      const summary = Object.freeze({
        service: this.contract.service,
        operation: capability,
        ownerMatched: true,
        anonymousOwnerAbsent: true,
        browserRequestAborted: capture?.browserAbortVerified === true,
        exactIntentMatched: inspectedCapture.inspection.intentMatch === true,
        directDispatchCount: direct.dispatchCount,
        retryCount: 0,
        httpStatus: direct.httpStatus,
        contentType: String(direct.contentType).split(';', 1)[0].trim().toLowerCase(),
        responseBytes: direct.responseBytes,
        responseSha256,
        credentialPropagated: direct.credentialPropagated,
        responseFraming: mainMedia.summary.framing,
        responseRpcIds: mainMedia.summary.rpcIds,
        responseStatusFieldCount: mainMedia.summary.statusErrorFieldPaths.length,
        responseTaskIdentifierFieldCount: mainMedia.summary.namedTaskIdentifierFieldPaths.length,
        responseAssetUrlCandidateCount: mainMedia.summary.allowedAssetUrlCandidateCount,
        responseInlineMediaCandidateCount: mainMedia.summary.inlineMediaCandidateCount,
        responsePromptEchoMatched: mainMedia.summary.expectedIntentMatched,
        historyListBeforeCount: beforeCount,
        historyListAfterCount: afterRows.length,
        newConversationCount: afterRows.filter((row) => !beforeIds.has(row.conversationId)).length,
        detailHttpStatus: detail?.httpStatus ?? null,
        detailResponseBytes: detail?.responseBytes ?? null,
        detailResponseSha256: detail?.responseSha256 ?? null,
        detailResponseCount: detail?.summary.rpcMatchCount ?? 0,
        detailPromptMatched,
        detailApiIdEchoed: detailApiIdMatched,
        detailRouteBound: routeBound,
        detailAssetUrlCandidateCount: detailMedia?.assetCandidates?.length ?? 0,
        detailInlineMediaCandidateCount: detailMedia?.inlineMediaCandidates?.length ?? 0,
        mainDetailAssetUrlMatched: sharedAssetUrl !== null,
        taskReadbackVerified: taskVerified,
        journalReconciled,
        assetDownloadPending: sharedAssetUrl !== null,
        outputStatus: taskVerified ? 'task_readback_verified_asset_pending'
          : directReadbackVerified ? 'task_readback_verified_asset_unresolved'
            : 'direct_dispatch_needs_task_readback',
        ...(readbackErrorCode ? { readbackErrorCode } : {}),
      });
      const result = { summary };
      Object.defineProperty(result, 'internal', {
        value: Object.freeze({
          assetUrl: sharedAssetUrl,
          assetCapability: capability,
          assetReferenceVerified: sharedAssetUrl !== null,
          inlineMedia: inlineMedia ? Object.freeze({ mime: inlineMedia.mime, body: inlineMedia.body }) : null,
          taskReadbackVerified: taskVerified,
          responseIdMatchAvailable: false,
        }),
        enumerable: false,
      });
      return Object.freeze(result);
    } finally {
      if (Buffer.isBuffer(direct?.body)) direct.body.fill(0);
      afterRows = [];
      beforeIds.clear();
      for (const item of mainMedia?.internal?.inlineMediaCandidates ?? []) item.body.fill(0);
      for (const item of detail?.media?.inlineMediaCandidates ?? []) item.body.fill(0);
      detail = null;
      mainMedia = null;
    }
  }

  async downloadMediaOnce(options = {}) {
    return downloadGeminiMediaAssetOnce({
      ...options,
      allowedOrigins: this.contract.assetOrigins,
      requireExactRedirectIdentity: true,
    });
  }

  async downloadTaskMediaAssetOnce(taskReadback, {
    artifactRoot,
    artifactName,
    previousArtifactPath = null,
    fetchImpl = globalThis.fetch,
  } = {}) {
    const ticket = taskReadback && typeof taskReadback === 'object'
      ? historyDetailTaskTickets.get(taskReadback) : null;
    if (!ticket || ticket.client !== this || !ticket.owner || ticket.owner !== this.verifiedOwner
        || taskReadback.httpStatus !== 200 || taskReadback.summary?.rpcMatchCount !== 1
        || taskReadback.summary?.taskIntentMatched !== true || taskReadback.summary?.apiConversationIdMatched !== true
        || taskReadback.binding?.bound !== true) {
      throw new GeminiClientError('MEDIA_TASK_READBACK_REQUIRED', 'A successful owner-checked hNvQHb task readback is required before media download.');
    }
    const mediaContract = this.contract.mediaAssetDownload;
    if (!mediaContract) {
      throw new GeminiClientError('MEDIA_TASK_CONTRACT_NOT_CAPTURED', 'An installed hNvQHb task media contract is required.');
    }
    const candidateByUrl = new Map((taskReadback.media?.assetCandidates ?? []).map((candidate) => [candidate.url, candidate]));
    const selected = [...new Set(ticket.candidateUrls)].filter((url) => {
      const candidate = candidateByUrl.get(url);
      if (!candidate) return false;
      let parsed;
      try { parsed = new URL(url); } catch { return false; }
      const pathFamily = parsed.pathname.split('/').map((part) => (
        part.length > 40 || /^[0-9a-f-]{16,}$/i.test(part) ? '{id}' : part
      )).join('/');
      const queryKeyNames = [...new Set([...parsed.searchParams.keys()])].sort();
      return mediaContract.sources.some((source) => source.capability === ticket.capability
        && source.origin === parsed.origin && source.pathFamily === pathFamily
        && JSON.stringify(source.queryKeyNames) === JSON.stringify(queryKeyNames));
    });
    if (selected.length !== 1) {
      throw new GeminiClientError(selected.length ? 'MEDIA_TASK_ASSET_AMBIGUOUS' : 'MEDIA_TASK_ASSET_NOT_OBSERVED',
        'The task detail did not provide exactly one asset in the installed source family.');
    }
    if (!Array.isArray(this.transport.session?.mediaCookies)) {
      throw new GeminiClientError('MEDIA_SESSION_CREDENTIALS_REQUIRED', 'The current session has no scoped media redirect credentials.');
    }
    const result = await downloadGeminiTaskMediaAssetOnce({
      url: selected[0],
      capability: ticket.capability,
      mediaAssetContract: mediaContract,
      cookieCookies: this.transport.session.mediaCookies,
      allowedOrigins: this.contract.assetOrigins,
      artifactRoot,
      artifactName,
      previousArtifactPath,
      fetchImpl,
    });
    const excludedCandidateCount = (taskReadback.media?.assetCandidates ?? []).filter((candidate) => {
      let parsed;
      try { parsed = new URL(candidate.url); } catch { return false; }
      const pathFamily = parsed.pathname.split('/').map((part) => (
        part.length > 40 || /^[0-9a-f-]{16,}$/i.test(part) ? '{id}' : part
      )).join('/');
      const queryKeyNames = [...new Set([...parsed.searchParams.keys()])].sort();
      return mediaContract.excludedCandidates.some((excluded) => excluded.origin === parsed.origin
        && excluded.pathFamily === pathFamily
        && JSON.stringify(excluded.queryKeyNames) === JSON.stringify(queryKeyNames));
    }).length;
    return Object.freeze({
      ...result,
      taskBinding: 'hNvQHb_prompt_and_api_id',
      taskPromptMatched: true,
      apiConversationIdEchoed: true,
      routeBound: true,
      taskAssetCandidateCount: ticket.candidateUrls.length,
      excludedTaskCandidateCount: excludedCandidateCount,
    });
  }

  async downloadOriginalImageOnce({
    expectedOwner = this.verifiedOwner,
    apiConversationId,
    visibleRouteId,
    expectedIntent,
    preparedRequest,
    artifactRoot,
    artifactName,
    expectedArtifactPath = null,
  } = {}) {
    if (!expectedOwner || this.verifiedOwner !== String(expectedOwner).trim().toLowerCase()) {
      throw new GeminiClientError('ORIGINAL_IMAGE_OWNER_BINDING_REQUIRED', 'A verified owner-bound Gemini client is required.');
    }
    let taskReadback;
    try {
      taskReadback = await this.readHistoryDetail({
        apiConversationId,
        visibleRouteId,
        expectedIntent,
        mediaCapability: 'image',
      });
      const downloaded = await downloadGeminiOriginalImageOnce({
        client: this,
        taskReadback,
        expectedOwner,
        apiConversationId,
        visibleRouteId,
        expectedIntent,
        preparedRequest,
        artifactRoot,
        artifactName,
        expectedArtifactPath,
      });
      return Object.freeze({
        ...downloaded,
        taskReadback: Object.freeze({
          httpStatus: taskReadback.httpStatus,
          responseBytes: taskReadback.responseBytes,
          responseSha256: taskReadback.responseSha256,
          rpcMatchCount: taskReadback.summary.rpcMatchCount,
          taskPromptMatched: taskReadback.summary.taskIntentMatched,
          apiConversationIdMatched: taskReadback.summary.apiConversationIdMatched,
          routeBound: taskReadback.binding.bound,
        }),
      });
    } finally {
      if (taskReadback) {
        clearTaskReadbackValues(taskReadback.payload);
        clearTaskReadbackValues(taskReadback.media);
      }
      taskReadback = null;
    }
  }

  async mutateOnce(capability, requestSpec, { journalRoot, actor, callerIntent } = {}) {
    const operation = requireCapturedOperation(this.contract, capability);
    if (operation.effect !== 'mutation' || operation.retryPolicy !== 'never') {
      throw new GeminiClientError('OPERATION_EFFECT_MISMATCH', 'Only an observed no-retry mutation can use this method.');
    }
    return executeMutationOnce({
      transport: this.transport,
      capability,
      requestSpec,
      actor,
      callerIntent,
      root: journalRoot,
    });
  }

  async captureMutationResponseOnce(operationName, requestSpec, { journalRoot, actor, callerIntent } = {}) {
    const operation = requireCapturedRequestOperation(this.contract, operationName);
    if (operation.effect !== 'mutation' || operation.retryPolicy !== 'never') {
      throw new GeminiClientError('OPERATION_EFFECT_MISMATCH', 'First-response capture requires an observed no-retry mutation request.');
    }
    const captureTransport = {
      request: (name, spec, options) => this.transport.request(name, spec, { ...options, captureUnpairedResponse: true }),
    };
    return executeMutationOnce({
      transport: captureTransport,
      capability: operationName,
      requestSpec,
      actor,
      callerIntent,
      root: journalRoot,
    });
  }

  async generateTextOnce(capturedRequest, prompt, {
    journalRoot, actor, callerIntent, preserveClientRequestId = false, preserveCapturedToken = false,
  } = {}) {
    const selected = this.modelSelection.selected();
    if (selected.selectedModeId !== null) {
      const expected = this.modelSelection.requestMetadata({ isTemporaryChat: false });
      const captured = readCapturedGeminiModelRequestMetadata(capturedRequest);
      if (captured.modeId !== expected.modeId || captured.modeCategory !== (expected.modeCategory ?? null)
          || captured.thinkingLevel !== expected.thinkingLevel
          || captured.isTemporaryChat !== expected.isTemporaryChat) {
        throw new GeminiClientError(
          'MODEL_SELECTION_CAPTURE_MISMATCH',
          'The captured native text request metadata does not match the selected model state.',
        );
      }
    }
    const requestSpec = buildCapturedTextRequest(this.contract, this.transport.session, capturedRequest, {
      prompt, preserveClientRequestId, preserveCapturedToken,
    });
    const operation = this.contract.operations.text;
    if (operation.observation.requestResponse === true) {
      return this.mutateOnce('text', requestSpec, { journalRoot, actor, callerIntent });
    }
    return this.captureMutationResponseOnce('text', requestSpec, { journalRoot, actor, callerIntent });
  }

  async generateTextWithAttachmentOnce(capturedRequest, prompt, attachmentRef, options = {}) {
    const attachmentBinding = inspectCapturedAttachmentReference(capturedRequest, attachmentRef);
    const result = await this.generateTextOnce(capturedRequest, prompt, options);
    return Object.freeze({ ...result, attachmentBinding });
  }
}
