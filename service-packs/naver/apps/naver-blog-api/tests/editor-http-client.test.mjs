import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fingerprint } from "../../../packages/contracts/src/index.mjs";
import { NaverEditorClient } from "../scripts/api/editor-client.mjs";
import { WriteJournal } from "../scripts/api/write-journal.mjs";
import { environmentSession } from "../scripts/api/environment-session.mjs";
import {
  compileEditorModel,
  inspectEditorModel,
} from "../scripts/api/editor-model.mjs";
import { renderUnits } from "../scripts/gates/publication-document.mjs";
import { publisherContentFingerprint } from "../scripts/gates/publisher-gates.mjs";
import {
  NOW,
  bind,
  publicationFixture,
  seedModel,
  publicHtml,
  IMAGE_URL, IMAGE_BYTES,
} from "./support/publication-fixture.mjs";

const json = (result) =>
  new Response(JSON.stringify({ isSuccess: true, result }), {
    headers: { "content-type": "application/json" },
  });
async function setup(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "naver-http-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const job = await publicationFixture(directory),
    requests = [];
  const state={configuration:null,ownerSearchOverride:options.ownerSearchOverride,postedConfiguration:null};
  let posted = false;
  const fetchImpl = async (raw, init) => {
    const u = new URL(raw);
    requests.push({ url: u, init });
    assert.equal(init.redirect, "manual");
    if (u.pathname === '/BlogTagListInfo.naver') return new Response(JSON.stringify({taglist: [{msg:'',logno:String(job.target.logNo),tagName:encodeURIComponent(job.publishSettings.tags.join(','))}]}), {headers:{'content-type':'text/plain;charset=UTF-8'}});
    if (u.origin+u.pathname === IMAGE_URL) {
      assert.equal(new Headers(init.headers).has('cookie'),false);
      return new Response(IMAGE_BYTES,{headers:{'content-type':'image/png'}});
    }
    if (u.origin === 'https://link.coupang.com') {
      assert.equal(new Headers(init.headers).has('cookie'), false);
      return new Response(null, { status: 302, headers: { location:
        `https://www.coupang.com/vp/products/1000?itemId=2000&vendorItemId=3000&lptag=${options.wrongAffiliate ? 'AF999' : 'AF1234567'}` } });
    }
    if (u.pathname === "/PostView.naver")
      return new Response(
        publicHtml(
          posted
            ? job.publicationBundle.document
            : {
                ...job.publicationBundle.document,
                title: "이전 테스트 제목입니다",
              },
        ),
        { headers: { "content-type": "text/html" } },
      );
    assert.equal(
      new Headers(init.headers).get("cookie"),
      "NID_AUT=synthetic-aut; NID_SES=synthetic-ses",
    );
    if (options.transportFailure)
      throw new Error("raw secret must never escape");
    if (options.redirect)
      return new Response("", {
        status: 302,
        headers: { location: "https://nid.naver.com/login?secret=synthetic" },
      });
    if (options.loginHtml)
      return new Response("<html>login</html>", {
        headers: { "content-type": "text/html" },
      });
    if (u.pathname === "/PostWriteFormSeOptions.naver")
      return json({
        documentModel: JSON.stringify(seedModel()),
        token: "synthetic-editor-token",
      });
    if (u.pathname === "/PostWriteFormManagerOptions.naver")
      return json({
        blogId: options.wrongActor ? "anotherblog" : job.blogId,
        isWriterBlogOwner: !options.notOwner,
        formView: {
          editorSource: "synthetic-editor-source",
          postConfiguration: state.configuration?{...state.configuration,
            ...(state.ownerSearchOverride!==undefined?{searchYn:state.ownerSearchOverride}:{}),...(options.wrongOutside?{outSideAllowYn:true}:{})}:{
            openType: 2,
            commentYn: true,
            searchYn: options.initialSearch??true,
            sympathyYn: true,
            scrapType: 2,
            outSideAllowYn: false,
            twitterPostingYn: false,
            facebookPostingYn: false,
            cclYn: false,
          },
          postFormMeta: {
            logNo: Number(job.target.logNo),
            categoryId: 1,
            directorySeq: 0,
            directoryDetail: null,
            mrBlogTalkCode: null,
            postWriteTimeType: "now",
            tags: state.tags ?? '',
            moviePanelParticipation: false,
            greenReviewBannerYn: false,
            continueSaved: false,
            noticePostYn: false,
            autoByCategoryYn: false,
            postLocationSupportYn: false,
            postLocationJson: null,
            prePostDate: null,
            thisDayPostInfo: null,
            scrapYn: false,
          },
        },
      });
    if (u.pathname === "/RabbitUpdate.naver") {
      posted = !options.readbackMismatch;
      const form = init.body;
      state.postedConfiguration=JSON.parse(form.get('populationParams')).configuration;
      state.tags=JSON.parse(form.get('populationParams')).populationMeta.tags;
      state.configuration={...state.postedConfiguration};
      assert.deepEqual(
        [...form.keys()],
        [
          "blogId",
          "documentModel",
          "mediaResources",
          "populationParams",
          "productApiVersion",
        ],
      );
      assert.equal(
        JSON.parse(form.get("populationParams")).editorSource,
        "synthetic-editor-source",
      );
      assert.equal(
        JSON.parse(form.get("populationParams")).populationMeta.logNo,
        Number(job.target.logNo),
      );
      assert.deepEqual(
        inspectEditorModel(JSON.parse(form.get("documentModel"))).units,
        renderUnits(job.publicationBundle.document),
      );
      if (options.lostResponse)
        throw new Error("private request body deliberately omitted");
      return json({
        redirectUrl: `https://blog.naver.com/PostView.naver?blogId=${job.blogId}&logNo=${job.target.logNo}`,
      });
    }
    throw new Error("Unexpected mock request");
  };
  const session = environmentSession({
    NAVER_COOKIE: "NID_AUT=synthetic-aut; NID_SES=synthetic-ses",
  });
  const createClient = () =>
    new NaverEditorClient({
      blogId: job.blogId,
      affiliateAccounts: { fixtureblog: 'AF1234567' },
      session,
      fetchImpl,
      now: () => NOW,
      journal: new WriteJournal(path.join(directory, "journal")),
    });
  return {
    directory,
    job,
    requests,
    client: createClient(),
    createClient,
    session,
    state,
  };
}

test("independent HTTP update sends observed form then verifies exact public content", async (t) => {
  const { directory, job, requests, client } = await setup(t);
  const preflight = await client.prepareUpdate(job);
  assert.equal(
    preflight.sourceDocumentFingerprint,
    job.preflight.sourceDocumentFingerprint,
  );
  const result = await client.updatePost(job, { baseDir: directory });
  assert.equal(result.readbackVerified, true);
  assert.equal(requests.filter((r) => r.init.method === "POST").length, 1);
  assert.equal(new Headers(requests.at(-1).init.headers).has("cookie"), false);
  assert.doesNotMatch(
    JSON.stringify(result),
    /synthetic-(aut|ses|editor-token|editor-source)/,
  );
});

test('ordinary API update rejects an empty tag list before every publication POST', async t => {
  const {directory, job, requests, client} = await setup(t);
  job.publishSettings.tags = []; bind(job);
  await assert.rejects(client.updatePost(job, {baseDir: directory}), error => error.code === 'PUBLICATION_GATE_FAILED' && error.details.failedChecks.includes('publicationTagsPresent'));
  assert.equal(requests.filter(request => request.init.method === 'POST').length, 0);
});
test("lost write response is reconciled by HTTP readback without POST retry", async (t) => {
  const { directory, job, requests, client } = await setup(t, {
    lostResponse: true,
  });
  const result = await client.updatePost(job, { baseDir: directory });
  assert.equal(result.accepted, false);
  assert.equal(result.readbackVerified, true);
  assert.equal(requests.filter((r) => r.init.method === "POST").length, 1);
});

for(const [initialSearch,requested,expected] of [[false,undefined,false],[true,undefined,true],[false,true,true],[true,false,false]])test(`update search setting ${initialSearch} / ${requested} changes only when explicit`,async t=>{
  const {client,job,directory,requests,state}=await setup(t,{initialSearch});
  if(requested!==undefined){job.publishSettings.searchAllowed=requested;bind(job);}
  const receipt=await client.updatePost(job,{baseDir:directory});
  assert.equal(receipt.configurationVerified,true);assert.equal(receipt.searchAllowedVerified,expected);
  assert.deepEqual(state.postedConfiguration,{openType:2,commentYn:true,searchYn:expected,sympathyYn:true,scrapType:2,outSideAllowYn:false,twitterPostingYn:false,facebookPostingYn:false,cclYn:false});
  const reconciled=await client.reconcileUpdate(job);assert.equal(reconciled.configurationVerified,true);assert.equal(reconciled.readbackVerified,true);assert.equal(reconciled.searchAllowedVerified,expected);
  assert.equal(requests.filter(r=>r.init.method==='POST').length,1);
});
test('update with exact public body but wrong owner search state stays uncertain until a read-only reconcile matches',async t=>{
  const {client,job,directory,requests,state}=await setup(t,{initialSearch:false,ownerSearchOverride:false});
  job.publishSettings.searchAllowed=true;bind(job);
  await assert.rejects(client.updatePost(job,{baseDir:directory}),{code:'WRITE_OUTCOME_UNKNOWN'});
  assert.equal((await client.reconcileUpdate(job)).readbackVerified,false);
  await assert.rejects(client.updatePost(job,{baseDir:directory}),/WRITE_ALREADY_ATTEMPTED/);
  state.ownerSearchOverride=undefined;
  const reconciled=await client.reconcileUpdate(job);assert.equal(reconciled.readbackVerified,true);assert.equal(reconciled.searchAllowedVerified,true);
  assert.equal(requests.filter(r=>r.init.method==='POST').length,1);
});
test('update readback detects an unintended change to preserved sharing configuration',async t=>{
  const {client,job,directory,requests}=await setup(t,{wrongOutside:true});
  job.publishSettings.searchAllowed=true;bind(job);
  await assert.rejects(client.updatePost(job,{baseDir:directory}),{code:'WRITE_OUTCOME_UNKNOWN'});
  assert.equal(requests.filter(r=>r.init.method==='POST').length,1);
});
test('update refuses unapproved or nonboolean search intent before a publication write',async t=>{
  for(const value of [null,1,'true']){
    const {client,job,directory,requests}=await setup(t);job.publishSettings.searchAllowed=value;bind(job);
    await assert.rejects(client.updatePost(job,{baseDir:directory}),{code:'PUBLICATION_GATE_FAILED'});assert.equal(requests.filter(r=>r.init.method==='POST').length,0);
  }
  const {client,job,directory,requests}=await setup(t);job.publishSettings.searchAllowed=false;
  await assert.rejects(client.updatePost(job,{baseDir:directory}),{code:'PUBLICATION_GATE_FAILED'});assert.equal(requests.filter(r=>r.init.method==='POST').length,0);
});

test('label-only affiliate anchors satisfy the publication receipt without visible raw URLs',async t=>{
  const {directory,job,requests,client}=await setup(t);
  job.publicationBundle.document.blocks[1].display='label';
  bind(job);
  const result=await client.updatePost(job,{baseDir:directory});
  assert.equal(result.resultGate.passed,true);
  assert.equal(result.data.receipt.publicReadback.affiliateLinkPresent,true);
  assert.equal(result.data.independentReadback.units.some(u=>u.value.includes(job.affiliate.url)),false);
  assert.equal(result.data.independentReadback.links.includes(job.affiliate.url),true);
  assert.equal(requests.filter(r=>r.init.method==='POST').length,1);
});
test('wrong live affiliate attribution prevents every publication POST', async t => {
  const {client,job,directory,requests}=await setup(t,{wrongAffiliate:true});
  await assert.rejects(client.updatePost(job,{baseDir:directory}),{code:'AFFILIATE_PUBLICATION_BLOCKED'});
  assert.equal(requests.some(r=>r.init.method==='POST'),false);
});
for(const [name,mutate] of [
 ['no images with zero optional minimums',j=>{j.minImageCount=0;j.minImageComponents=0;j.publicationBundle.document.blocks=j.publicationBundle.document.blocks.filter(b=>b.type!=='image');}],
 ['native mobile images absent',j=>j.publicationBundle.renderReviews.mobile.imageCount=0],
 ['native desktop image not loaded',j=>j.publicationBundle.renderReviews.desktop.presentationChecks.imagesLoaded=false],
 ['missing image purpose',j=>delete j.publicationBundle.document.blocks.find(b=>b.type==='image').purpose],
 ['image rights missing',j=>delete j.publicationBundle.document.blocks.find(b=>b.type==='image').rights],
 ['unsupported article format',j=>j.publicationBundle.format='seasonal_checklist'],
 ['unsupported affiliate provider',j=>{const url='https://myrealt.rip/synthetic';j.affiliate.url=url;j.publicationBundle.document.blocks.find(b=>b.type==='link').url=url;}],
 ['local HTML substituted for native review',j=>j.publicationBundle.renderReviews.mobile.channel='local_html'],
 ['unreviewed AI image',j=>j.publicationBundle.document.blocks.find(b=>b.type==='image').rights={basis:'generated',source:'synthetic generation'}],
])test(`publication refuses ${name} before network`,async t=>{
 const {client,job,directory,requests}=await setup(t);mutate(job);bind(job);
 await assert.rejects(client.updatePost(job,{baseDir:directory}),{code:'PUBLICATION_GATE_FAILED'});
 assert.equal(requests.length,0);
});
for (const mode of ['missingAffiliate','missingBodyLink']) test(`${mode} blocks update before network`,async t=>{
  const {client,job,directory,requests}=await setup(t);
  if (mode==='missingAffiliate') delete job.affiliate;
  else job.publicationBundle.document.blocks=job.publicationBundle.document.blocks.filter(b=>b.type!=='link');
  bind(job);
  await assert.rejects(client.updatePost(job,{baseDir:directory}),e=>e.code==='PUBLICATION_GATE_FAILED' && e.details.failedChecks.includes('monetizedAffiliateVerified'));
  assert.equal(requests.length,0);
});
test("uncertain writes stay blocked after restart and job-id changes", async (t) => {
  const { directory, job, requests, client, createClient } = await setup(t, {
    readbackMismatch: true,
  });
  await assert.rejects(client.updatePost(job, { baseDir: directory }), {
    code: "WRITE_OUTCOME_UNKNOWN",
  });
  job.jobId += "-retry";
  job.preflight.checkedAt = "2026-09-20T09:59:00.000Z";
  job.authorization.contentFingerprint = publisherContentFingerprint(job);
  await assert.rejects(
    createClient().updatePost(job, { baseDir: directory }),
    /WRITE_ALREADY_ATTEMPTED_READBACK_REQUIRED/,
  );
  assert.equal(requests.filter((r) => r.init.method === "POST").length, 1);
});
test("changed source document prevents overwriting a concurrent edit", async (t) => {
  const { directory, job, requests, client } = await setup(t);
  job.preflight.sourceDocumentFingerprint = "0".repeat(64);
  job.authorization.contentFingerprint = publisherContentFingerprint(job);
  await assert.rejects(client.updatePost(job, { baseDir: directory }), {
    code: "SOURCE_DOCUMENT_CHANGED",
  });
  assert.equal(
    requests.some((r) => r.init.method === "POST"),
    false,
  );
});
for (const [name, options, code] of [
  ["login redirect", { redirect: true }, "AUTH_OR_ACCESS"],
  ["HTTP 200 login HTML", { loginHtml: true }, "AUTH_OR_SCHEMA"],
  ["wrong blog actor", { wrongActor: true }, "ACTOR_SCOPE_UNVERIFIED"],
  ["non-owner", { notOwner: true }, "ACTOR_SCOPE_UNVERIFIED"],
  ["transport with sensitive error", { transportFailure: true }, "TRANSPORT"],
])
  test(`${name} cannot establish an authenticated client`, async (t) => {
    const { client, job } = await setup(t, options);
    await assert.rejects(
      client.loadEditor(job.target.logNo),
      (e) => e.code === code && !e.message.includes("secret"),
    );
  });
test("environment credentials are scoped, ephemeral and not serializable", () => {
  assert.throws(() => environmentSession({}), /AUTH_MISSING/);
  const session = environmentSession({
    NAVER_COOKIE: "NID_AUT=synthetic-aut; NID_SES=synthetic-ses",
    UNRELATED_SECRET: "synthetic-unrelated",
  });
  assert.throws(() => session.cookieFor("https://example.com"), /SCOPE/);
  assert.equal(JSON.stringify(session), '{"provider":"runtime_environment"}');
  session.clear();
  assert.throws(
    () => session.cookieFor("https://blog.naver.com"),
    /AUTH_MISSING/,
  );
});
test("unobserved creation, unsupported components and new media never fall back to a browser", async (t) => {
  const { client, job } = await setup(t);
  await assert.rejects(client.createPost(), {
    code: "CREATE_TOKEN_PROVIDER_UNVERIFIED",
  });
  const doc = structuredClone(job.publicationBundle.document);
  doc.blocks.push({
    type: "image",
    publishedUrl: "https://postfiles.pstatic.net/new.png",
  });
  assert.throws(
    () => compileEditorModel(seedModel(), doc),
    /UNOBSERVED_MEDIA_UPLOAD_REQUIRED/,
  );
  const model = seedModel();
  model.document.components.push({ "@ctype": "unknown" });
  assert.throws(
    () => inspectEditorModel(model),
    /UNSUPPORTED_EDITOR_COMPONENT/,
  );
});
test("API normal execution dependency graph has no browser automation", async () => {
  const seen = new Set();
  async function visit(url) {
    if (seen.has(url.href)) return;
    seen.add(url.href);
    const code = await readFile(url, "utf8");
    assert.doesNotMatch(
      code,
      /(?:from\s*|import\s*\()\s*['"](?:playwright|puppeteer)|chrome\.scripting|connectOverCDP|tools\/discovery/,
    );
    for (const match of code.matchAll(/from\s*['"](\.[^'"]+)['"]/g))
      await visit(new URL(match[1], url));
  }
  await visit(new URL("../scripts/api/publisher-cli.mjs", import.meta.url));
  assert.ok(seen.size >= 10);
});

test("draft revision prevents overwrites and a lost update response is reconciled without resubmission", async (t) => {
  const { directory, job, session } = await setup(t);
  const document = { ...job.publicationBundle.document, logNo: '123456790' };
  const calls = [];
  let savedModel = seedModel();
  const freshForm = {
    editorSource: "synthetic-editor-source",
    postConfiguration: {
      openType: 2,
      commentYn: true,
      searchYn: true,
      sympathyYn: true,
      scrapType: 2,
      outSideAllowYn: false,
      twitterPostingYn: false,
      facebookPostingYn: false,
      cclYn: false,
    },
    postFormMeta: {
      logNo: null,
      categoryId: 1,
      directorySeq: 0,
      directoryDetail: null,
      mrBlogTalkCode: null,
      postWriteTimeType: "now",
      tags: null,
      moviePanelParticipation: false,
      greenReviewBannerYn: false,
      continueSaved: false,
      noticePostYn: false,
      autoByCategoryYn: false,
      postLocationSupportYn: false,
      postLocationJson: null,
      thisDayPostInfo: null,
      scrapYn: false,
    },
  };
  const fetchImpl = async (raw, init) => {
    const u = new URL(raw);
    calls.push(u.pathname);
    if (u.pathname === "/PostWriteFormSeOptions.naver")
      return json({ documentModel: null });
    if (u.pathname === "/PostWriteFormManagerOptions.naver")
      return json({
        blogId: job.blogId,
        isWriterBlogOwner: true,
        formView: freshForm,
      });
    if (u.pathname === "/TempPostList.naver") {
      assert.equal(u.searchParams.get("editorVersion"), "4");
      assert.equal(u.searchParams.get("onlyCount"), "false");
      return json({
        totalCount: 1,
        tempPostList: [
          {
            logNo: 123456790,
            title: document.title,
            modiDate: 1,
            editorVersion: 4,
          },
        ],
      });
    }
    if (u.pathname === "/RabbitTempPostUpdate.naver") {
      assert.deepEqual(
        [...init.body.keys()],
        [
          "blogId",
          "documentModel",
          "mediaResources",
          "populationParams",
          "productApiVersion",
          "modiDate",
          "forceUpdate",
        ],
      );
      assert.equal(
        Object.hasOwn(JSON.parse(init.body.get("populationParams")).populationMeta, 'autoSaveNo'),
        false,
      );
      assert.equal(init.body.get('modiDate'),'1');
      assert.equal(init.body.get('forceUpdate'),'false');
      savedModel = JSON.parse(init.body.get("documentModel"));
      throw Error('synthetic response lost after successful save');
    }
    if (u.pathname === "/RabbitTempPostRead.naver")
      return json({
        documentModel: JSON.stringify(savedModel),
        tempPostFormView: {
          ...freshForm,
          postFormMeta: { ...freshForm.postFormMeta, logNo: 123456790 },
        },
      });
    throw new Error("UNEXPECTED_REQUEST");
  };
  const client = new NaverEditorClient({
    blogId: job.blogId,
    session,
    fetchImpl,
    now: () => NOW,
    journal: new WriteJournal(path.join(directory, "draft-journal")),
  });
  await assert.rejects(client.saveDraft({ document, observedAutoSaveNo: 1000 }), {
    code: "AUTOSAVE_CONTEXT_NOT_ACCEPTED",
  });
  assert.equal(calls.length, 0);
  await assert.rejects(client.saveDraft({ document, draftLogNo: document.logNo,
    baseDocumentFingerprint: fingerprint(inspectEditorModel(seedModel())), baseModiDate: 2 }), {code:'SOURCE_DOCUMENT_CHANGED'});
  assert.equal(calls.includes('/RabbitTempPostUpdate.naver'),false);
  const result = await client.saveDraft({
    document,
    draftLogNo: document.logNo,
    baseDocumentFingerprint: fingerprint(inspectEditorModel(seedModel())),
    baseModiDate: 1,
  });
  assert.equal(result.published, false);
  assert.equal(result.readbackVerified, true);
  assert.equal(result.accepted, false);
  assert.equal((await client.reconcileDraft({ document, draftLogNo: document.logNo })).readbackVerified,true);
  assert.equal((await client.listDrafts()).totalCount, 1);
  assert.equal(
    calls.filter((p) => p === "/RabbitTempPostUpdate.naver").length,
    1,
  );
});
