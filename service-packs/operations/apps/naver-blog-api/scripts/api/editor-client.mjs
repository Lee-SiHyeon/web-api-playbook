import { fingerprint } from "../../../../packages/contracts/src/index.mjs";
import { parsePublicDocument } from "./public-document.mjs";
import { verifyAffiliateRedirect, AFFILIATE_ACCOUNTS } from '../gates/affiliate-link-gate.mjs';
import { compileEditorModel, inspectEditorModel, editorPresentationFingerprint } from "./editor-model.mjs";
import { uploadPng, verifiedUploadComponent } from "./media-upload.mjs";
import { validateCreateEnvelope, createJournalKey } from './create-envelope.mjs';
import { auditPost } from './post-audit.mjs';
import { REVIEWED_REPAIR, reviewedRepairDocument, reorderExistingEditorUnits,
  verifyReviewedImageRemoval } from './reviewed-structure-repair.mjs';
import {
  evaluatePublisherJobGate,
  evaluatePublisherResultGate,
} from "../gates/publisher-gates.mjs";
import { evaluateExactReadback } from "../gates/publication-review-gates.mjs";
import {
  documentFingerprint,
  renderUnits,
  text,
} from "../gates/publication-document.mjs";

const ORIGIN = "https://blog.naver.com";
const logId = (value) => /^\d{6,}$/.test(String(value || ""));
export class EditorApiError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "EditorApiError";
    this.code = code;
    this.details = details;
  }
}
async function boundedBody(response, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size > limit) throw new EditorApiError("RESPONSE_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
export class NaverEditorClient {
  #session;
  #fetch;
  #blogId;
  #now;
  #journal;
  #timeout;
  #affiliateAccounts;
  constructor({
    blogId,
    session,
    fetchImpl = globalThis.fetch,
    now = () => new Date(),
    journal,
    timeoutMs = 20000,
    affiliateAccounts = AFFILIATE_ACCOUNTS,
  }) {
    if (
      !/^[a-zA-Z0-9_-]{3,50}$/.test(blogId || "") ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 100 ||
      timeoutMs > 30000
    )
      throw new EditorApiError("INPUT");
    this.#blogId = blogId;
    this.#session = session;
    this.#fetch = fetchImpl;
    this.#now = now;
    this.#journal = journal;
    this.#timeout = timeoutMs;
    this.#affiliateAccounts = affiliateAccounts;
  }
  async #request(
    path,
    query = {},
    form = null,
    { authenticated = true, html = false } = {},
  ) {
    const url = new URL(path, ORIGIN);
    if (url.origin !== ORIGIN) throw new EditorApiError("SCOPE");
    for (const [k, v] of Object.entries({ blogId: this.#blogId, ...query }))
      if (v != null) url.searchParams.set(k, String(v));
    const headers = {
      accept: html ? "text/html" : "application/json",
      referer: `${ORIGIN}/PostWriteForm.naver?blogId=${this.#blogId}`,
    };
    if (authenticated) {
      if (!this.#session?.cookieFor) throw new EditorApiError("AUTH_MISSING");
      headers.cookie = this.#session.cookieFor(url.href);
      if (!headers.cookie) throw new EditorApiError("AUTH_MISSING");
    }
    let body;
    if (form) {
      url.search = "";
      body = new URLSearchParams({ blogId: this.#blogId, ...form });
      headers["content-type"] =
        "application/x-www-form-urlencoded;charset=UTF-8";
    }
    let response, raw;
    try {
      response = await this.#fetch(url.href, {
        method: form ? "POST" : "GET",
        redirect: "manual",
        headers,
        body,
        signal: AbortSignal.timeout(this.#timeout),
      });
      raw = await boundedBody(response);
    } catch (e) {
      if (e instanceof EditorApiError) throw e;
      throw new EditorApiError(form ? "WRITE_OUTCOME_UNKNOWN" : "TRANSPORT");
    }
    if (authenticated) this.#session?.acceptResponse?.(response, url.href);
    if (authenticated && [301, 302, 303, 307, 308, 401, 403].includes(response.status))
      this.#session?.requireReauthentication?.();
    if (response.status !== 200)
      throw new EditorApiError(
        [301, 302, 303, 307, 308, 401, 403].includes(response.status)
          ? "AUTH_OR_ACCESS"
          : "HTTP_STATUS",
        { status: response.status },
      );
    if (html) {
      if (!/text\/html/i.test(response.headers.get("content-type") || ""))
        throw new EditorApiError("RESPONSE_MIME");
      return { body: raw, url: url.href, status: response.status };
    }
    if (!/application\/json/i.test(response.headers.get("content-type") || ""))
      throw new EditorApiError("AUTH_OR_SCHEMA");
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new EditorApiError("RESPONSE_SCHEMA");
    }
    if (
      data?.isSuccess !== true ||
      !data.result ||
      typeof data.result !== "object"
    )
      throw new EditorApiError("APPLICATION_REJECTED");
    return data.result;
  }
  async loadEditor(logNo, { allowEmpty = false } = {}) {
    if (logNo != null && !logId(logNo)) throw new EditorApiError("INPUT");
    const query = logNo == null ? {} : { logNo };
    const [se, manager] = await Promise.all([
      this.#request("/PostWriteFormSeOptions.naver", query),
      this.#request("/PostWriteFormManagerOptions.naver", query),
    ]);
    if (
      manager.blogId !== this.#blogId ||
      manager.isWriterBlogOwner !== true ||
      !manager.formView ||
      typeof manager.formView.editorSource !== "string"
    )
      throw new EditorApiError("ACTOR_SCOPE_UNVERIFIED");
    if (
      logNo != null &&
      String(manager.formView.postFormMeta?.logNo) !== String(logNo)
    )
      throw new EditorApiError("TARGET_SCOPE_UNVERIFIED");
    let model;
    try {
      model = se.documentModel === null ? null : JSON.parse(se.documentModel);
      if (!(allowEmpty && logNo == null && model === null)) inspectEditorModel(model);
    } catch {
      throw new EditorApiError("EDITOR_MODEL_SCHEMA");
    }
    this.#session?.markOwnerVerified?.();
    // Tokens and opaque editor fields stay only in this return object's memory.
    return {
      model,
      form: manager.formView,
      uploadContext: { token: se.token, appCode: se.appCode },
      checkedAt: this.#now().toISOString(),
    };
  }
  async sessionStatus() {
    try {
      await this.loadEditor(undefined, { allowEmpty: true });
      return { source: 'independent_http', blogId: this.#blogId, protectedOwnerVerified: true,
        checkedAt: this.#now().toISOString(), ...this.#session?.status?.() };
    } catch (error) {
      if (!['AUTH_MISSING', 'AUTH_OR_ACCESS', 'AUTH_OR_SCHEMA', 'ACTOR_SCOPE_UNVERIFIED'].includes(error.code || error.message)) throw error;
      this.#session?.requireReauthentication?.();
      return { source: 'independent_http', blogId: this.#blogId, protectedOwnerVerified: false,
        checkedAt: this.#now().toISOString(), ...this.#session?.status?.(), authState: 'reauth_required' };
    }
  }
  async uploadImage({ bytes, fileName }) {
    const context = await this.loadEditor(undefined, { allowEmpty: true });
    return uploadPng({ bytes, fileName, blogId: this.#blogId,
      ...context.uploadContext, journal: this.#journal },
      { fetchImpl: this.#fetch, now: this.#now, timeoutMs: this.#timeout });
  }
  async #compile(model, document) {
    const uploadedComponents = [];
    for (const block of document?.blocks || []) {
      if (block.type !== 'image' || !block.uploadReceipt) continue;
      if (block.sha256 !== block.uploadReceipt.sha256 || block.publishedUrl !== block.uploadReceipt.publishedUrl)
        throw new EditorApiError('UPLOAD_RECEIPT_UNVERIFIED');
      uploadedComponents.push(await verifiedUploadComponent(block.uploadReceipt, {
        blogId: this.#blogId, journal: this.#journal, fetchImpl: this.#fetch, timeoutMs: this.#timeout }));
    }
    return compileEditorModel(model, document, { uploadedComponents });
  }
  async compilePreview(logNo, document) {
    if (document.blogId !== this.#blogId || String(document.logNo) !== String(logNo))
      throw new EditorApiError('SCOPE');
    const current = await this.loadEditor(logNo);
    return this.#compile(current.model, document);
  }
  async listDrafts() {
    const result = await this.#request("/TempPostList.naver", {
      editorVersion: 4,
      onlyCount: false,
    });
    if (
      !Array.isArray(result.tempPostList) ||
      !Number.isInteger(result.totalCount) ||
      result.tempPostList.some(
        (p) => !logId(p.logNo) || typeof p.title !== "string",
      )
    )
      throw new EditorApiError("RESPONSE_SCHEMA");
    return result;
  }
  async readDraft(logNo) {
    if (!logId(logNo)) throw new EditorApiError("INPUT");
    const result = await this.#request("/RabbitTempPostRead.naver", { logNo });
    if (String(result.tempPostFormView?.postFormMeta?.logNo) !== String(logNo))
      throw new EditorApiError("TARGET_SCOPE_UNVERIFIED");
    let model;
    try {
      model = JSON.parse(result.documentModel);
      inspectEditorModel(model);
    } catch {
      throw new EditorApiError("EDITOR_MODEL_SCHEMA");
    }
    return { model, form: result.tempPostFormView };
  }
  async #draftContext(draftLogNo) {
    if (!logId(draftLogNo)) throw new EditorApiError("EXISTING_DRAFT_REQUIRED");
    // Fresh blank editor options establish ownership and provide editorSource.
    // A blank editor legitimately returns documentModel:null; the draft supplies
    // the current document and its observed opaque metadata.
    const context = await this.loadEditor(undefined, { allowEmpty: true });
    const listing = await this.listDrafts();
    const listed = listing.tempPostList.filter(p => String(p.logNo) === String(draftLogNo));
    if (listed.length !== 1 || listed[0].editorVersion !== 4 || !Number.isSafeInteger(listed[0].modiDate) || listed[0].modiDate <= 0)
      throw new EditorApiError("DRAFT_REVISION_REQUIRED");
    const current = await this.readDraft(draftLogNo);
    context.modiDate = listed[0].modiDate;
    context.model = current.model;
    context.form = { ...context.form,
      postConfiguration: current.form.postConfiguration,
      postFormMeta: current.form.postFormMeta };
    return context;
  }
  async prepareDraft(document) {
    if (document?.blogId !== this.#blogId) throw new EditorApiError("SCOPE");
    const context = await this.#draftContext(document.logNo);
    await this.#compile(context.model, document);
    return { schemaVersion: 1, kind: "independent_http_draft_preflight",
      source: "independent_http", checkedAt: this.#now().toISOString(),
      document, draftLogNo: String(document.logNo),
      baseModiDate: context.modiDate,
      baseDocumentFingerprint: fingerprint(inspectEditorModel(context.model)) };
  }
  async readPost(logNo, { authenticated = false } = {}) {
    if (!logId(logNo)) throw new EditorApiError("INPUT");
    const response = await this.#request("/PostView.naver", { logNo }, null, {
      html: true,
      authenticated,
    });
    return parsePublicDocument(response.body, {
      url: response.url,
      httpStatus: response.status,
      checkedAt: this.#now().toISOString(),
    });
  }
  #population(context) {
    // Copy only fields observed in the actual wire contract. Do not synthesize
    // editorSource, anti-abuse telemetry, default category, or publication state.
    const configurationKeys = [
      "openType",
      "commentYn",
      "searchYn",
      "sympathyYn",
      "scrapType",
      "outSideAllowYn",
      "twitterPostingYn",
      "facebookPostingYn",
      "cclYn",
    ];
    const metaKeys = [
      "categoryId",
      "logNo",
      "directorySeq",
      "directoryDetail",
      "mrBlogTalkCode",
      "postWriteTimeType",
      "tags",
      "moviePanelParticipation",
      "greenReviewBannerYn",
      "continueSaved",
      "noticePostYn",
      "autoByCategoryYn",
      "postLocationSupportYn",
      "postLocationJson",
      "prePostDate",
      "thisDayPostInfo",
      "scrapYn",
    ];
    const pick = (source, keys) =>
      Object.fromEntries(
        keys.filter((k) => Object.hasOwn(source, k)).map((k) => [k, source[k]]),
      );
    return {
      configuration: pick(context.form.postConfiguration, configurationKeys),
      populationMeta: pick(context.form.postFormMeta, metaKeys),
      editorSource: context.form.editorSource,
    };
  }
  async saveDraft({
    document,
    templateLogNo,
    draftLogNo,
    baseDocumentFingerprint,
    baseModiDate,
    observedAutoSaveNo,
  }) {
    if (!this.#journal) throw new EditorApiError("JOURNAL_REQUIRED");
    if (observedAutoSaveNo != null)
      throw new EditorApiError("AUTOSAVE_CONTEXT_NOT_ACCEPTED");
    if (
      templateLogNo != null ||
      document?.blogId !== this.#blogId ||
      String(document?.logNo || "") !== String(draftLogNo || "")
    )
      throw new EditorApiError("SCOPE");
    const context = await this.#draftContext(draftLogNo);
    if (
      baseDocumentFingerprint !== fingerprint(inspectEditorModel(context.model)) ||
      baseModiDate !== context.modiDate
    )
      throw new EditorApiError("SOURCE_DOCUMENT_CHANGED");
    const model = await this.#compile(context.model, document);
    const population = this.#population(context);
    // Manual save was observed without autoSaveNo. Never copy autosave state
    // from another editor or manufacture an autosave identifier.
    delete population.populationMeta.prePostDate;
    const key = this.#journal.key(
      "saveDraft",
      { blogId: this.#blogId, logNo: draftLogNo || null },
      inspectEditorModel(model),
    );
    await this.#journal.reserve(key, {
      operation: "saveDraft",
      blogId: this.#blogId,
      logNo: draftLogNo || null,
    });
    let saved, accepted = false;
    try {
      saved = await this.#request(
        "/RabbitTempPostUpdate.naver",
        {},
        { ...this.#wire(model, population), modiDate: String(context.modiDate), forceUpdate: "false" },
      );
      if (!logId(saved.logNo) || !Number.isFinite(saved.modiDate))
        throw new EditorApiError("WRITE_OUTCOME_UNKNOWN");
      if (draftLogNo && String(saved.logNo) !== String(draftLogNo))
        throw new EditorApiError("WRITE_OUTCOME_UNKNOWN");
      accepted = true;
    } catch { /* The stable draft ID permits independent reconciliation. */ }
    try {
      const readback = await this.readDraft(draftLogNo);
      if (
        fingerprint(inspectEditorModel(model)) !==
        fingerprint(inspectEditorModel(readback.model))
      )
        throw new EditorApiError("DRAFT_READBACK_MISMATCH");
      await this.#journal.finish(key, "verified", { logNo: draftLogNo, accepted });
      return {
        operation: "saveDraft",
        source: "independent_http",
        published: false,
        logNo: draftLogNo,
        accepted,
        readbackVerified: true,
      };
    } catch (e) {
      await this.#journal.finish(key, "submitted_unknown", {
        code: e.code || "READBACK_FAILED",
        logNo: draftLogNo,
      });
      throw new EditorApiError("WRITE_OUTCOME_UNKNOWN", {
        readbackRequired: true,
      });
    }
  }
  async reconcileDraft(job) {
    if (job?.document?.blogId !== this.#blogId || !logId(job?.draftLogNo) ||
        String(job.document.logNo) !== String(job.draftLogNo)) throw new EditorApiError('SCOPE');
    const current = await this.#draftContext(job.draftLogNo);
    const observation = inspectEditorModel(current.model);
    const expected = { title: text(job.document.title), units: renderUnits(job.document) };
    const readbackVerified = fingerprint(observation) === fingerprint(expected);
    if (readbackVerified && this.#journal) {
      const key = this.#journal.key('saveDraft', { blogId: this.#blogId, logNo: job.draftLogNo }, expected);
      await this.#journal.finish(key, 'verified', { logNo: job.draftLogNo, reconciled: true });
    }
    return { source: 'independent_http', operation: 'saveDraft', readOnly: true,
      published: false, readbackVerified, observation };
  }
  #wire(model, population) {
    return {
      documentModel: JSON.stringify(model),
      mediaResources: JSON.stringify({ image: [], video: [], file: [] }),
      populationParams: JSON.stringify(population),
      productApiVersion: "v1",
    };
  }
  #privateProbeDocument(logNo, title) {
    return { blogId: this.#blogId, logNo: String(logNo), title, blocks: [
      { type: "paragraph", text: "이 글은 API 연동을 확인하기 위한 비공개 검증용 글입니다." },
      { type: "paragraph", text: "첫 번째 문단: 독립 HTTP 수정 요청의 반영을 확인합니다." },
      { type: "paragraph", text: "두 번째 문단: 문단의 누락과 순서 변경을 확인합니다." },
      { type: "paragraph", text: "이 검증 결과는 상업용 원고의 품질 심사 통과를 의미하지 않습니다." },
    ] };
  }
  #checkPrivateProbe(context) {
    const observed = inspectEditorModel(context.model);
    if (context.form.postConfiguration?.openType !== 0 ||
        !/^API 연동 검증용 임시 초안 \d{8}$/.test(observed.title) ||
        observed.units.length > 8 || !observed.units.length ||
        observed.units.some(u => u.type !== "text" || u.value.length > 400 || /https?:\/\//i.test(u.value)) ||
        !observed.units[0].value.startsWith("이 글은 API 연동을 확인하기 위한"))
      throw new EditorApiError("PRIVATE_PROBE_TARGET_REQUIRED");
    return observed;
  }
  async preparePrivateProbe(logNo) {
    const context = await this.loadEditor(logNo);
    const observed = this.#checkPrivateProbe(context);
    return { schemaVersion: 1, kind: "private_transport_probe",
      blogId: this.#blogId, logNo: String(logNo),
      checkedAt: this.#now().toISOString(),
      sourceDocumentFingerprint: fingerprint(observed),
      document: this.#privateProbeDocument(logNo, observed.title) };
  }
  async verifyPrivateUpdate(probe) {
    const age = this.#now().getTime() - Date.parse(probe?.checkedAt || "");
    if (probe?.kind !== "private_transport_probe" || probe.blogId !== this.#blogId ||
        !logId(probe.logNo) || !Number.isFinite(age) || age < 0 || age > 30 * 60000)
      throw new EditorApiError("PRIVATE_PROBE_PREFLIGHT_REQUIRED");
    if (!this.#journal) throw new EditorApiError("JOURNAL_REQUIRED");
    const context = await this.loadEditor(probe.logNo);
    const observed = this.#checkPrivateProbe(context);
    const document = this.#privateProbeDocument(probe.logNo, observed.title);
    if (probe.sourceDocumentFingerprint !== fingerprint(observed) ||
        fingerprint(probe.document) !== fingerprint(document))
      throw new EditorApiError("SOURCE_DOCUMENT_CHANGED");
    const model = compileEditorModel(context.model, document);
    const job = { blogId: this.#blogId, target: { logNo: probe.logNo },
      publicationBundle: { document }, publishSettings: { visibility: "private" },
      authorization: { approvedAt: probe.checkedAt } };
    const key = this.#journal.key("privateTransportProbe", { blogId: this.#blogId,
      logNo: probe.logNo }, document);
    const receipt = await this.#submitUpdate(job, this.#wire(model, this.#population(context)), key, { technicalProbe: true });
    const after = await this.loadEditor(probe.logNo);
    this.#checkPrivateProbe(after);
    return { kind: "private_transport_probe", operation: "updatePost",
      source: "independent_http", publiclyPublished: false, publicationQualityVerified: false,
      privateVisibilityVerified: true, readbackVerified: true, ...receipt };
  }
  async prepareUpdate(job) {
    if (
      job?.blogId !== this.#blogId ||
      job?.target?.type !== "update" ||
      !logId(job.target.logNo) ||
      !job.publicationBundle?.document
    )
      throw new EditorApiError("SCOPE");
    const context = await this.loadEditor(job.target.logNo);
    const model = await this.#compile(
      context.model,
      job.publicationBundle.document,
    );
    return {
      schemaVersion: 1,
      kind: "independent_http_update_preflight",
      source: "independent_http",
      blogId: this.#blogId,
      logNo: String(job.target.logNo),
      checkedAt: this.#now().toISOString(),
      sourceDocumentFingerprint: fingerprint(inspectEditorModel(context.model)),
      documentFingerprint: documentFingerprint(job.publicationBundle.document),
      publicationBundleFingerprint: fingerprint(job.publicationBundle),
      compiledDocumentFingerprint: fingerprint(inspectEditorModel(model)),
      compiledPresentationFingerprint: editorPresentationFingerprint(model),
    };
  }
  async repairReviewedStructure({ repairId, authorized = false } = {}) {
    if (!authorized || repairId !== REVIEWED_REPAIR.id || this.#blogId !== REVIEWED_REPAIR.blogId)
      throw new EditorApiError('REVIEWED_REPAIR_AUTHORIZATION_REQUIRED');
    if (!this.#journal) throw new EditorApiError('JOURNAL_REQUIRED');
    const logNo = REVIEWED_REPAIR.logNo;
    const initial = await this.loadEditor(logNo);
    const original = inspectEditorModel(initial.model);
    const document = reviewedRepairDocument(original);
    if (initial.form.postConfiguration?.openType !== 2)
      throw new EditorApiError('REPAIR_PUBLIC_TARGET_REQUIRED');
    const publicBefore = await this.readPost(logNo);
    reviewedRepairDocument(publicBefore);
    verifyReviewedImageRemoval(await auditPost(publicBefore, { fetchImpl: this.#fetch, now: this.#now }));
    // Check concurrency again after slow image downloads. Keep opaque fields in
    // memory; the write uses the latest observed manager and editor responses.
    const current = await this.loadEditor(logNo);
    if (fingerprint(current.model) !== fingerprint(initial.model) ||
        fingerprint(current.form.postConfiguration) !== fingerprint(initial.form.postConfiguration) ||
        fingerprint(current.form.postFormMeta) !== fingerprint(initial.form.postFormMeta))
      throw new EditorApiError('SOURCE_DOCUMENT_CHANGED');
    const model = reorderExistingEditorUnits(current.model, REVIEWED_REPAIR.order);
    const job = { blogId: this.#blogId, target: { logNo },
      publicationBundle: { document }, publishSettings: { visibility: 'public' },
      authorization: { approvedAt: this.#now().toISOString() } };
    const key = this.#journal.key('reviewedStructureRepair', { blogId: this.#blogId, logNo },
      { repairId, sourceFingerprint: REVIEWED_REPAIR.sourceFingerprint });
    const result = await this.#submitUpdate(job, this.#wire(model, this.#population(current)), key);
    try {
      const after = await this.loadEditor(logNo);
      const preservedMeta = form => Object.fromEntries(['categoryId', 'tags', 'postWriteTimeType',
        'prePostDate', 'noticePostYn'].map(k => [k, form.postFormMeta[k]]));
      if (fingerprint(inspectEditorModel(after.model)) !== fingerprint(inspectEditorModel(model)) ||
          fingerprint(after.form.postConfiguration) !== fingerprint(current.form.postConfiguration) ||
          fingerprint(preservedMeta(after.form)) !== fingerprint(preservedMeta(current.form)))
        throw Error('REPAIR_OWNER_READBACK_MISMATCH');
    } catch {
      await this.#journal.finish(key, 'submitted_unknown', { code: 'REPAIR_OWNER_READBACK_MISMATCH' });
      throw new EditorApiError('WRITE_OUTCOME_UNKNOWN', { readbackRequired: true });
    }
    return { ok: true, operation: 'reviewedStructureRepair', repairId,
      source: 'independent_http', url: result.observation.url, logNo,
      accepted: result.accepted, readbackVerified: true, publicVisibilityVerified: true,
      beforeUnits: 96, afterUnits: 86, beforeImages: 18, afterImages: 13,
      proseAndLinksPreserved: true, publicationQualityVerified: false,
      limitation: 'Structural correction only; current commercial facts were not revalidated.' };
  }
  async updatePost(job, { baseDir } = {}) {
    if (
      job?.blogId !== this.#blogId ||
      job?.target?.type !== "update" ||
      !logId(job.target.logNo)
    )
      throw new EditorApiError("SCOPE");
    if (job?.publish !== true || job?.dryRun !== false)
      throw new EditorApiError("EXPLICIT_UPDATE_REQUIRED");
    if (!this.#journal) throw new EditorApiError("JOURNAL_REQUIRED");
    const gate = await evaluatePublisherJobGate(job, {
      baseDir,
      now: this.#now(),
    });
    if (!gate.passed)
      throw new EditorApiError("PUBLICATION_GATE_FAILED", {
        failedChecks: gate.failedChecks,
      });
    const context = await this.loadEditor(job.target.logNo);
    const preflightAge =
      this.#now().getTime() - Date.parse(job.preflight?.checkedAt || "");
    if (
      !Number.isFinite(preflightAge) ||
      preflightAge < 0 ||
      preflightAge > 30 * 60000 ||
      job.preflight?.kind !== "independent_http_update_preflight"
    )
      throw new EditorApiError("PREFLIGHT_EXPIRED");
    if (
      job.preflight?.sourceDocumentFingerprint !==
      fingerprint(inspectEditorModel(context.model))
    )
      throw new EditorApiError("SOURCE_DOCUMENT_CHANGED");
    const expectedVisibility = { public: 2, private: 0 };
    if (
      !Object.hasOwn(expectedVisibility, job.publishSettings.visibility) ||
      context.form.postConfiguration.openType !==
        expectedVisibility[job.publishSettings.visibility] ||
      job.publishSettings.timing !== "current"
    )
      throw new EditorApiError("UNOBSERVED_VISIBILITY_OR_SCHEDULE_CHANGE");
    const model = await this.#compile(
      context.model,
      job.publicationBundle.document,
    );
    const wire = this.#wire(model, this.#population(context));
    if (job.preflight.compiledPresentationFingerprint !== editorPresentationFingerprint(model))
      throw new EditorApiError('RENDERED_PRESENTATION_CHANGED');
    // Gate again immediately before the mutation, after reads/compilation.
    const finalGate = await evaluatePublisherJobGate(job, {
      baseDir,
      now: this.#now(),
    });
    if (!finalGate.passed)
      throw new EditorApiError("PUBLICATION_GATE_FAILED", {
        failedChecks: finalGate.failedChecks,
      });
    const key = this.#updateKey(job);
    const affiliate = await verifyAffiliateRedirect(job, { fetchImpl: this.#fetch,
      accounts: this.#affiliateAccounts, now: this.#now() });
    if (!affiliate.passed) throw new EditorApiError('AFFILIATE_PUBLICATION_BLOCKED', affiliate);
    const { accepted, observation } = await this.#submitUpdate(job, wire, key);
    return this.#publicationReceipt(job, accepted, observation);
  }
  async #submitUpdate(job, wire, key, { technicalProbe = false } = {}) {
    await this.#journal.reserve(key, {
      operation: "updatePost",
      blogId: this.#blogId,
      logNo: job.target.logNo,
      jobId: job.jobId,
    });
    let accepted = false;
    try {
      const result = await this.#request("/RabbitUpdate.naver", {}, wire);
      const redirect = new URL(result.redirectUrl, ORIGIN);
      if (
        redirect.origin !== ORIGIN ||
        redirect.pathname !== "/PostView.naver" ||
        redirect.searchParams.get("blogId") !== this.#blogId ||
        redirect.searchParams.get("logNo") !== String(job.target.logNo)
      )
        throw new EditorApiError("WRITE_OUTCOME_UNKNOWN");
      accepted = true;
    } catch {
      /* A lost response may follow a successful write. Read, never retry. */
    }
    let observation, readback, audit;
    try {
      observation = await this.readPost(job.target.logNo, {
        authenticated: job.publishSettings.visibility === "private",
      });
      readback = evaluateExactReadback(job, observation, { now: this.#now() });
      if (readback.passed) audit = await auditPost(observation, { fetchImpl: this.#fetch, now: this.#now });
    } catch {
      /* Keep the journal uncertain. */
    }
    // This internal exception belongs only to the fixed noncommercial private
    // transport fixture above. User jobs cannot opt out of affiliate disclosure.
    const auditPassed = audit?.passed === true || technicalProbe && audit?.checks.noDuplicateProse === true &&
      audit?.checks.allImagesVerified === true && audit?.checks.noDuplicateImages === true;
    const verified = readback?.passed === true && auditPassed;
    await this.#journal.finish(
      key,
      verified ? "verified" : "submitted_unknown",
      { accepted, readbackVerified: verified },
    );
    if (!verified)
      throw new EditorApiError("WRITE_OUTCOME_UNKNOWN", {
        accepted,
        readbackRequired: true,
      });
    return { accepted, observation, readback };
  }
  #publicationReceipt(job, accepted, observation) {
    const paragraphs = observation.units.filter((u) =>
      ["text", "quote"].includes(u.type),
    );
    const images = observation.units.filter((u) => u.type === "image");
    const affiliateUrl =
      job.affiliate?.url ||
      job.publicationBundle.document.blocks.find((b) =>
        ["link", "oglink"].includes(b.type),
      )?.url;
    const requiredMarkers = Array.isArray(job.requiredMarkers)
      ? job.requiredMarkers
      : [];
    const payload = {
      jobId: job.jobId,
      ok: true,
      mode: job.mode,
      operation: job.target.type === 'create' ? 'createPost' : 'updatePost',
      source: "independent_http",
      accepted,
      readbackVerified: true,
      data: {
        published: true,
        independentReadback: observation,
        receipt: {
          url: observation.url,
          logNo: observation.logNo,
          pageTitle: observation.title,
          paragraphCount: paragraphs.length,
          maxParagraphLength: Math.max(
            0,
            ...paragraphs.map((p) => p.value.length),
          ),
          uniqueImageCount: new Set(images.map((i) => i.value)).size,
          componentCounts: {
            "se-image": images.length,
            "se-quotation": observation.units.filter((u) => u.type === "quote")
              .length,
            "se-horizontalLine": observation.units.filter(
              (u) => u.type === "divider",
            ).length,
          },
          publicStatus: observation.httpStatus,
          publicReadback: {
            smartEditorBodyPresent: observation.smartEditorBodyPresent,
            affiliateLinkPresent: observation.links?.includes(affiliateUrl) === true,
            markerPresence: Object.fromEntries(
              requiredMarkers.map((marker) => [
                marker,
                observation.units.some((u) => u.value.includes(marker)),
              ]),
            ),
          },
        },
      },
    };
    const resultGate = evaluatePublisherResultGate(job, payload, {
      now: this.#now(),
    });
    if (!resultGate.passed)
      throw new EditorApiError("RESULT_GATE_FAILED", {
        failedChecks: resultGate.failedChecks,
      });
    return { ...payload, resultGate };
  }
  #updateKey(job) {
    return this.#journal.key(
      "updatePost",
      { blogId: this.#blogId, logNo: job.target.logNo },
      {
        document: {
          title: text(job.title),
          units: renderUnits(job.publicationBundle.document),
        },
        publishSettings: job.publishSettings,
      },
    );
  }
  async reconcileUpdate(job) {
    if (job?.blogId !== this.#blogId || job?.target?.type !== "update")
      throw new EditorApiError("SCOPE");
    const observation = await this.readPost(job.target.logNo, {
      authenticated: job.publishSettings.visibility === "private",
    });
    const gate = evaluateExactReadback(job, observation, { now: this.#now() });
    const audit = gate.passed ? await auditPost(observation, { fetchImpl: this.#fetch, now: this.#now }) : null;
    const verified = gate.passed && audit?.passed === true;
    if (verified && this.#journal)
      await this.#journal.finish(this.#updateKey(job), "verified", {
        reconciled: true,
        readbackVerified: true,
      });
    return {
      source: "independent_http",
      readOnly: true,
      readbackVerified: verified,
      gate,
      audit,
      observation,
    };
  }
  async prepareCreate(job, envelope) {
    if (job?.blogId !== this.#blogId || job?.target?.type !== 'create' || job.target.logNo ||
        job.inputProvider !== 'headless_sdk' || !['private','public'].includes(job.publishSettings?.visibility)) throw new EditorApiError('CREATE_SCOPE');
    const prepared = validateCreateEnvelope(envelope, { blogId: this.#blogId,
      document: job.publicationBundle?.document, now: this.#now() });
    if (job.publishSettings.categoryId != null && Number(prepared.population.populationMeta.categoryId) !== job.publishSettings.categoryId)
      throw new EditorApiError('CREATE_CATEGORY_MISMATCH');
    await this.loadEditor(undefined, { allowEmpty: true });
    const model = await this.#compile(prepared.model, job.publicationBundle.document);
    return { schemaVersion: 1, kind: 'headless_input_http_create_preflight', source: 'independent_http',
      inputProvider: 'headless_sdk', blogId: this.#blogId, checkedAt: this.#now().toISOString(),
      sourceDocumentFingerprint: fingerprint(inspectEditorModel(prepared.model)),
      compiledDocumentFingerprint: fingerprint(inspectEditorModel(model)),
      compiledPresentationFingerprint: editorPresentationFingerprint(model),
      documentFingerprint: documentFingerprint(job.publicationBundle.document),
      publicationBundleFingerprint: fingerprint(job.publicationBundle), browserEngineFree: false };
  }
  #createKey(job) {
    return createJournalKey(this.#journal, job);
  }
  async createPost(job, { envelope, baseDir } = {}) {
    if (!envelope) throw new EditorApiError('CREATE_TOKEN_PROVIDER_UNVERIFIED');
    if (job?.blogId !== this.#blogId || job?.target?.type !== 'create' || job.target.logNo ||
        job.inputProvider !== 'headless_sdk' || job.publish !== true || job.dryRun !== false)
      throw new EditorApiError('EXPLICIT_CREATE_REQUIRED');
    if (!this.#journal) throw new EditorApiError('JOURNAL_REQUIRED');
    const checkGate = async () => {
      const gate = await evaluatePublisherJobGate(job, { baseDir, now: this.#now() });
      if (!gate.passed) throw new EditorApiError('PUBLICATION_GATE_FAILED', { failedChecks: gate.failedChecks });
    };
    await checkGate();
    const prepared = validateCreateEnvelope(envelope, { blogId: this.#blogId,
      document: job.publicationBundle.document, now: this.#now() });
    const age = this.#now().getTime() - Date.parse(job.preflight?.checkedAt || '');
    if (job.preflight?.kind !== 'headless_input_http_create_preflight' || !Number.isFinite(age) || age < 0 || age > 30 * 60000 ||
        job.preflight.sourceDocumentFingerprint !== fingerprint(inspectEditorModel(prepared.model)))
      throw new EditorApiError('CREATE_PREFLIGHT_MISMATCH');
    await this.loadEditor(undefined, { allowEmpty: true });
    const model = await this.#compile(prepared.model, job.publicationBundle.document);
    if (job.preflight.compiledDocumentFingerprint !== fingerprint(inspectEditorModel(model)))
      throw new EditorApiError('CREATE_COMPILED_DOCUMENT_MISMATCH');
    prepared.population.configuration.openType = { private: 0, public: 2 }[job.publishSettings.visibility];
    if (job.preflight.compiledPresentationFingerprint !== editorPresentationFingerprint(model))
      throw new EditorApiError('RENDERED_PRESENTATION_CHANGED');
    const wire = { ...this.#wire(model, prepared.population), tokenId: prepared.token };
    await checkGate();
    if (job.publishSettings.categoryId != null && Number(prepared.population.populationMeta.categoryId) !== job.publishSettings.categoryId)
      throw new EditorApiError('CREATE_CATEGORY_MISMATCH');
    const affiliate = await verifyAffiliateRedirect(job, { fetchImpl: this.#fetch, accounts: this.#affiliateAccounts, now: this.#now() });
    if (!affiliate.passed) throw new EditorApiError('AFFILIATE_PUBLICATION_BLOCKED', affiliate);
    validateCreateEnvelope(envelope, { blogId: this.#blogId, document: job.publicationBundle.document, now: this.#now() });
    const key = this.#createKey(job);
    await this.#journal.reserve(key, { operation: 'createPost', blogId: this.#blogId,
      expectedDocumentFingerprint: fingerprint(inspectEditorModel(model)), visibility: job.publishSettings.visibility });
    let logNo;
    try {
      const result = await this.#request('/RabbitWrite.naver', {}, wire);
      const redirect = new URL(result.redirectUrl, ORIGIN);
      if (redirect.origin !== ORIGIN || redirect.pathname !== '/PostView.naver' ||
          redirect.searchParams.get('blogId') !== this.#blogId || !logId(redirect.searchParams.get('logNo')))
        throw new EditorApiError('WRITE_OUTCOME_UNKNOWN');
      logNo = redirect.searchParams.get('logNo');
      // Persist the returned identity before readback; restart reconciliation is
      // possible even when the process dies during a later verification GET.
      await this.#journal.finish(key, 'submitted_unknown', { logNo, accepted: true, retryAllowed: false });
      return await this.reconcileCreate(job);
    } catch (error) {
      await this.#journal.finish(key, 'submitted_unknown', { logNo: logNo || null, retryAllowed: false }).catch(() => {});
      throw new EditorApiError('WRITE_OUTCOME_UNKNOWN', { logNo: logNo || null, readbackRequired: true, retryAllowed: false });
    } finally { wire.tokenId = ''; }
  }
  async reconcileCreate(job) {
    if (job?.blogId !== this.#blogId || job?.target?.type !== 'create' || !this.#journal)
      throw new EditorApiError('CREATE_SCOPE');
    const key = this.#createKey(job), record = await this.#journal.read(key);
    const logNo = record.receipt?.logNo;
    if (!logId(logNo)) throw new EditorApiError('CREATE_IDENTITY_UNKNOWN_NO_RETRY');
    const owner = await this.loadEditor(logNo);
    const observation = await this.readPost(logNo, { authenticated: job.publishSettings.visibility === 'private' });
    const readback = evaluateExactReadback(job, observation, { now: this.#now(), createdLogNo: logNo });
    const expected = { title: text(job.title), units: renderUnits(job.publicationBundle.document) };
    const audit = await auditPost(observation, { fetchImpl: this.#fetch, now: this.#now });
    if (!readback.passed || !audit.passed || owner.form.postConfiguration?.openType !== { private: 0, public: 2 }[job.publishSettings.visibility] ||
        job.publishSettings.categoryId != null && Number(owner.form.postFormMeta?.categoryId) !== job.publishSettings.categoryId ||
        !observation.links?.includes(job.affiliate.url) ||
        fingerprint(inspectEditorModel(owner.model)) !== fingerprint(expected))
      throw new EditorApiError('CREATE_READBACK_MISMATCH');
    const receipt = { ...this.#publicationReceipt(job, true, observation), schemaVersion: 1, operation: 'createPost', source: 'independent_http',
      inputProvider: 'headless_sdk', blogId: this.#blogId, logNo, checkedAt: this.#now().toISOString(),
      accepted: true, readbackVerified: true, protectedOwnerVerified: true,
      visibilityVerified: job.publishSettings.visibility, browserClosedBeforeHTTPWrite: true,
      browserEngineFree: false, documentFingerprint: fingerprint(expected),
      htmlSha256: observation.htmlSha256, exactReadback: readback, audit };
    await this.#journal.finish(key, 'verified', receipt);
    return receipt;
  }
}
