import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile,readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CafeApiError, CafeSession } from './session.mjs';
import { NaverCafeClient } from './client.mjs';
import { validateCafeDocument, documentFingerprint } from './editor-document.mjs';

export const LIFEHACK_CAFE = Object.freeze({ cafeId: '31796283', cafeSlug: 'lifehackailab' });
const JOURNAL_DIR = fileURLToPath(new URL('../runtime/write-journals/', import.meta.url));
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function id(value, label) {
  const normalized = String(value ?? '');
  if (!/^\d{1,24}$/.test(normalized)) throw new CafeApiError('INPUT', `Invalid ${label}`);
  return normalized;
}

// The reader's htmlToText collapses runs of blank lines and spaces, so a multi-paragraph body is compared with all
// whitespace folded to single spaces (a body with blank lines otherwise never matched its own readback).
// Blank paragraphs come back as a zero-width space (U+200B, observed 2026-09-27), which \s does not cover.
const foldText = s => String(s).replace(/[​-‍⁠﻿]/g, ' ').replace(/\s+/g, ' ').trim();
// Hyperlinks (owner 2026-10-10 "네이버 카페도 링크 하이퍼링크를 똑바로 붙이던지"): "[label](https://…)" in the text becomes a
// textNode carrying an urlLink, the same SmartEditor node the blog compiler writes; the reader returns only the label.
export const LINK_RE = /\[([^\]\n]{1,200})\]\((https:\/\/[^\s)]+)\)/g;
export const linkPlain = s => String(s).replace(LINK_RE, '$1');
const sameText = (contentText, expected) => foldText(contentText).includes(foldText(linkPlain(expected)));

function title(value, label = 'title') {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\r\n\0]/.test(value)) {
    throw new CafeApiError('INPUT', `Invalid ${label}`);
  }
  return value.trim();
}

function resultOf(data) {
  const result = data?.result ?? data?.message?.result;
  if (result == null || typeof result !== 'object') throw new CafeApiError('SCHEMA', 'Cafe management result is missing');
  return result;
}

function ulid() {
  let stamp = BigInt(Date.now());
  const left = Array(10);
  for (let i = 9; i >= 0; i--) { left[i] = CROCKFORD[Number(stamp & 31n)]; stamp >>= 5n; }
  const random = randomBytes(16);
  return left.join('') + Array.from({ length: 16 }, (_, i) => CROCKFORD[random[i] & 31]).join('');
}

function textDocument(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200_000 || /\0/.test(value)) {
    throw new CafeApiError('INPUT', 'Article text is required');
  }
  // A blank line is a paragraph with one empty text node, as SmartEditor writes it. A paragraph with no nodes made
  // articleCreate fail with HTTP 500 / 99999 (observed 2026-09-27: "첫 줄\n\n다음 줄" refused, one line accepted).
  const node = (text, url) => ({ id: `SE-${randomUUID()}`, value: text, ...(url ? { link: { '@ctype': 'urlLink', url } } : {}), '@ctype': 'textNode' });
  const lineNodes = line => {
    const nodes = []; let at = 0;
    for (const m of line.matchAll(LINK_RE)) {
      if (m.index > at) nodes.push(node(line.slice(at, m.index)));
      nodes.push(node(m[1], new URL(m[2]).href)); at = m.index + m[0].length;
    }
    if (at < line.length || !nodes.length) nodes.push(node(line.slice(at)));
    return nodes;
  };
  const paragraphs = value.replace(/\r\n?/g, '\n').split('\n').map(line => ({
    id: `SE-${randomUUID()}`,
    nodes: lineNodes(line),
    '@ctype': 'paragraph',
  }));
  return JSON.stringify({
    document: {
      version: '2.10.2', theme: 'default', language: 'ko-KR', id: ulid(),
      components: [{ id: `SE-${randomUUID()}`, layout: 'default', value: paragraphs, '@ctype': 'text' }],
    },
    documentId: '',
  });
}

function articlePayload({ cafeId, menuId, subject, text, contentJson, tags = [], options = {} }) {
  if (!Array.isArray(tags) || tags.length > 10 || tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 30)) {
    throw new CafeApiError('INPUT', 'Invalid Cafe tags');
  }
  const defaults = {
    open: false, naverOpen: true, externalOpen: true, enableComment: true,
    enableScrap: true, enableCopy: true, useAutoSource: false, useCcl: false,
  };
  if (options == null || typeof options !== 'object' || Array.isArray(options)
    || Object.entries(options).some(([key, value]) => !(key in defaults) || typeof value !== 'boolean')) {
    throw new CafeApiError('INPUT', 'Invalid Cafe article options');
  }
  return {
    cafeId, contentJson: contentJson ?? textDocument(text), from: 'pc', menuId: Number(menuId),
    subject, tagList: tags.map(tag => tag.trim()), editorVersion: 4, parentId: 0,
    ...defaults, ...options, cclTypes: [],
  };
}

function addBoardPayload(current, name) {
  const ids = current.menus.map(menu => Number(menu.menuId));
  if (ids.some(value => !Number.isSafeInteger(value) || value <= 0)) throw new CafeApiError('SCHEMA', 'Invalid current Cafe menu ID');
  return {
    wholeArticleViewTypeCode: current.wholeArticleViewTypeCode,
    basicMenuCodes: current.basicMenuCodes,
    menuIdOrder: [...ids, -1],
    addedMenus: {
      NORMAL: [{
        menuId: -1, menuCode: 'NORMAL', menuName: name, hidden: false, hideable: true,
        articleHeadUse: false, articleHeads: [], indent: false,
        writeLevel: 1, commentWriteLevel: 1, showCommentWriteLevel: true, readLevel: 1,
        defaultWriteOpenType: 1, menuDescription: '', templateId: 0,
        upArticleMinimumCount: 5, upArticleTopViewUse: false, upArticleUse: true,
        upArticleViewCount: 3, writeFormId: 0, kinQuestionLink: null, rCodes: [],
      }],
    },
    modifiedMenus: {}, deletedMenuIds: [],
  };
}

function deleteBoardPayload(current, menuId) {
  return {
    wholeArticleViewTypeCode: current.wholeArticleViewTypeCode,
    basicMenuCodes: current.basicMenuCodes,
    menuIdOrder: current.menus.map(menu => Number(menu.menuId)).filter(value => String(value) !== menuId),
    addedMenus: {}, modifiedMenus: {}, deletedMenuIds: [Number(menuId)],
  };
}

function modifiedNormalMenu(menu, info, name) {
  const regions = info.region?.regionCodeDetails;
  if (Array.isArray(regions) && regions.length) {
    throw new CafeApiError('UNSUPPORTED_BOARD_REGION', 'Regional board settings need a separate captured contract');
  }
  return {
    menuId: Number(menu.menuId), menuCode: 'NORMAL', menuName: name,
    hidden: info.hidden === true, hideable: menu.hideable === true,
    articleHeadUse: info.articleHeadUse === true,
    articleHeads: Array.isArray(info.articleHeads) ? info.articleHeads : [],
    indent: info.indent === true,
    writeLevel: Number(info.writeLevel), commentWriteLevel: Number(info.commentWriteLevel),
    showCommentWriteLevel: info.showCommentWriteLevel === true,
    readLevel: Number(info.readLevel),
    defaultWriteOpenType: info.defaultWriteOpenType ?? 1,
    menuDescription: typeof info.menuDescription === 'string' ? info.menuDescription : '',
    templateId: info.templateId ?? 0,
    upArticleMinimumCount: Number(info.upArticleMinimumCount),
    upArticleTopViewUse: info.upArticleTopViewUse === true,
    upArticleUse: info.upArticleUse === true,
    upArticleViewCount: Number(info.upArticleViewCount),
    writeFormId: info.writeFormId ?? 0,
    kinQuestionLink: info.kinQuestionLink ?? null,
    rCodes: [],
  };
}

async function saveJournal(file, record, exclusive = false) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: exclusive ? 'wx' : 'w' });
}

export class NaverCafeManager {
  #session;
  #reader;
  #context;
  #journalDir;

  constructor({ session, reader, context,journalDir=JOURNAL_DIR }) {
    this.#session = session;
    this.#reader = reader;
    this.#context = context;
    this.#journalDir=journalDir;
  }

  static async fromStored({ context = LIFEHACK_CAFE } = {}) {
    if (String(context.cafeId) !== LIFEHACK_CAFE.cafeId || context.cafeSlug !== LIFEHACK_CAFE.cafeSlug) {
      throw new CafeApiError('CAFE_SCOPE', 'This management client is bound to 생활이득AI연구소');
    }
    const session = await CafeSession.fromStored({ context });
    const reader = new NaverCafeClient({ session, context });
    const verified = await reader.verifyStoredMember();
    if (verified.membership.memberLevelName !== '카페매니저' || verified.membership.memberLevel !== 999) {
      throw new CafeApiError('MANAGER_REQUIRED', 'Cafe manager authority is required');
    }
    return new NaverCafeManager({ session, reader, context });
  }

  async managerMenus() {
    const { data, evidence } = await this.#session.managerRequest('managerMenus');
    const result = resultOf(data);
    if (String(result.cafeId) !== this.#context.cafeId || !Array.isArray(result.menus)
      || !Array.isArray(result.basicMenuCodes) || typeof result.wholeArticleViewTypeCode !== 'string') {
      throw new CafeApiError('SCHEMA', 'Cafe management menu response is invalid');
    }
    return { ...result, evidence };
  }

  async #allArticles() {
    const rows = [];
    for (let page = 1; page <= 1000; page++) {
      const batch = await this.#reader.list({ page });
      rows.push(...batch.articles);
      if (!batch.hasNext) return rows;
    }
    throw new CafeApiError('FULL_SCAN_REQUIRED', 'Cafe article scan exceeded the supported page limit');
  }

  async #journaled(operation, reference, send, reconcile) {
    const runId = randomUUID();
    const stableId=operation==='articleUpdate'?createHash('sha256').update(JSON.stringify({operation,reference})).digest('hex'):runId;
    const file = path.join(this.#journalDir, `${stableId}.json`);
    let previous;try{previous=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw new CafeApiError('JOURNAL_UNREADABLE');}
    if(previous){
      const checked=await reconcile();
      if(checked?.verified)return {...checked.result,journal:file,evidence:previous.response??null,alreadyDone:true};
      throw new CafeApiError('NEEDS_RECONCILIATION','An article update was already attempted; no second send is allowed',{journal:file});
    }
    const record = {
      version: 1, runId, cafeId: this.#context.cafeId, operation, reference,
      attemptCount: 1, state: 'pending_send', recordedAt: new Date().toISOString(),
    };
    await saveJournal(file, record, true);
    let sent = null;
    let sendError = null;
    try { sent = await send(); }
    catch (error) { sendError = error; }
    if (sent) {
      record.state = 'sent';
      record.response = sent.evidence;
      await saveJournal(file, record);
    }
    let checked = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { checked = await reconcile(sent?.data); }
      catch { checked = null; }
      if (checked?.verified) break;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (checked?.verified) {
      record.state = 'verified';
      record.verifiedAt = new Date().toISOString();
      record.result = checked.result;
      await saveJournal(file, record);
      return { ...checked.result, journal: file, evidence: sent?.evidence ?? null };
    }
    record.state = 'needs_reconciliation';
    record.failedAt = new Date().toISOString();
    record.errorCode = sendError instanceof CafeApiError ? sendError.code : sendError ? 'TRANSPORT' : 'READBACK';
    // Why the service refused (status codes only, no body): without it a WRITE_REJECTED could not be diagnosed
    // (2026-09-27, 냉동삼겹살 mirror).
    if (sendError instanceof CafeApiError && sendError.details) {
      const { httpStatus = null, applicationStatus = null, errorCode = null } = sendError.details;
      record.cause = { httpStatus, applicationStatus, applicationErrorCode: errorCode };
    }
    await saveJournal(file, record);
    throw new CafeApiError('NEEDS_RECONCILIATION', 'The Cafe write result is uncertain; inspect the journal and live state before retrying',
      { journal: file, causeCode: record.errorCode, ...(record.cause ? { httpStatus: record.cause.httpStatus, errorCode: record.cause.applicationErrorCode } : {}) });
  }

  async createPost({ menuId, subject, text, contentJson, tags = [], options = {} }) {
    const rich = contentJson == null ? null : validateCafeDocument(contentJson);
    if(rich) text=rich.text;
    const normalizedMenuId = id(menuId, 'menu ID');
    const normalizedSubject = title(subject, 'article subject');
    const menus = await this.managerMenus();
    if (!menus.menus.some(menu => String(menu.menuId) === normalizedMenuId && menu.menuCode === 'NORMAL')) {
      throw new CafeApiError('MENU_NOT_FOUND', 'Target Cafe board is unavailable');
    }
    if ((await this.#allArticles()).some(row => row.subject === normalizedSubject)) {
      throw new CafeApiError('DUPLICATE_TITLE', 'An article with the exact title already exists');
    }
    const article = articlePayload({ cafeId: this.#context.cafeId, menuId: normalizedMenuId,
      subject: normalizedSubject, text, contentJson, tags, options });
    const reference = { menuId: normalizedMenuId, subject: normalizedSubject,
      contentSha256: createHash('sha256').update(text, 'utf8').digest('hex') };
    return this.#journaled('articleCreate', reference,
      () => this.#session.managerRequest('articleCreate', { menuId: normalizedMenuId, article }),
      async () => {
        const found = (await this.#allArticles()).filter(row => row.subject === normalizedSubject
          && row.menuId === normalizedMenuId);
        if (found.length !== 1) return { verified: false };
        const read = await this.#reader.article({ articleId: found[0].articleId });
        if (!sameText(read.article.contentText, text)) return { verified: false };
        if(rich && !(await this.#verifyRich({articleId:found[0].articleId,menuId:normalizedMenuId,rich,options:article,tags:article.tagList})))return {verified:false};
        return { verified: true, result: { cafeId: this.#context.cafeId,
          articleId: found[0].articleId, menuId: normalizedMenuId, subject: normalizedSubject,
          ownerReadback: true } };
      });
  }

  async #verifyRich({articleId,menuId,rich,options,tags}){
    const e=resultOf((await this.#session.managerRequest('articleEditor',{articleId,menuId})).data);
    let model;try{model=JSON.parse(e.article.contentJson);}catch{return false;}
    const optionNames=['open','naverOpen','externalOpen','enableComment','enableScrap','enableCopy','useAutoSource'];
    if(String(e.selectedMenu?.menu?.menuId)!==menuId||e.article.writerId!==e.userId||documentFingerprint(model)!==rich.fingerprint||
      optionNames.some(k=>e.options?.[k]!==options[k])||JSON.stringify(e.options?.cclTypes??[])!==JSON.stringify(options.cclTypes??[])||
      JSON.stringify(e.article.tagList??[])!==JSON.stringify(tags))return false;
    const raw=await this.#session.request('article',{...this.#context,articleId});
    const article=resultOf(raw.data).article;
    const html=article?.contentHtml??'';
    if(rich.images.some(image=>!html.includes(new URL(image.src).pathname)))return false;
    const represented=rich.images.find(x=>x.represent===true);
    if(represented){
      // The mobile article read omits representativeImage; the observed list contract returns representImage.
      let found=null;
      for(let page=1;page<=1000;page++){
        const result=resultOf((await this.#session.request('list',{...this.#context,page})).data);
        const rows=result.articleList??[];
        found=rows.map(row=>row.item??row).find(row=>String(row.articleId)===articleId);
        if(found||rows.length<50)break;
      }
      if(!String(found?.representImage??'').includes(new URL(represented.src).pathname))return false;
    }
    return true;
  }

  // Read-only: the owner editor's stored document links (label → url), to confirm hyperlinks survived a write.
  async inspectPost({articleId,expectedSubject}){
    const normalizedArticleId=id(articleId,'article ID');
    const row=(await this.#allArticles()).find(r=>r.articleId===normalizedArticleId);
    if(!row||expectedSubject&&row.subject!==expectedSubject)throw new CafeApiError('ARTICLE_MISMATCH');
    const e=resultOf((await this.#session.managerRequest('articleEditor',{articleId:normalizedArticleId,menuId:row.menuId})).data);
    if(e.article.writerId!==e.userId)throw new CafeApiError('OWNER_REQUIRED');
    return {articleId:normalizedArticleId,subject:row.subject,menuId:row.menuId,tags:e.article.tagList??[],options:e.options};
  }

  async articleLinks({ articleId }) {
    const normalizedArticleId = id(articleId, 'article ID');
    const menuId = id((await this.#allArticles()).find(row => row.articleId === normalizedArticleId)?.menuId, 'menu ID');
    const editor = resultOf((await this.#session.managerRequest('articleEditor', { articleId: normalizedArticleId, menuId })).data);
    let doc; try { doc = JSON.parse(editor.article?.contentJson ?? ''); } catch { throw new CafeApiError('SCHEMA', 'Current editor document is invalid'); }
    const links = [];
    for (const c of doc?.document?.components ?? []) for (const p of c.value ?? []) for (const n of p.nodes ?? [])
      if (n.link?.url) links.push({ label: n.value, url: n.link.url, ctype: n.link['@ctype'] });
    return { articleId: normalizedArticleId, subject: editor.article?.subject ?? null, links };
  }

  async updatePost({ articleId, expectedSubject, subject, text, contentJson, tags }) {
    const rich=contentJson==null?null:validateCafeDocument(contentJson);
    if(rich)text=rich.text;
    const normalizedArticleId = id(articleId, 'article ID');
    const normalizedExpected = title(expectedSubject, 'expected article subject');
    const normalizedSubject = title(subject ?? expectedSubject, 'article subject');
    const before = await this.#reader.article({ articleId: normalizedArticleId });
    if (before.article.subject !== normalizedExpected) throw new CafeApiError('ARTICLE_MISMATCH', 'Article subject differs from the expected target');
    const menuId = id((await this.#allArticles()).find(row => row.articleId === normalizedArticleId)?.menuId, 'menu ID');
    if (normalizedSubject !== normalizedExpected
      && (await this.#allArticles()).some(row => row.articleId !== normalizedArticleId && row.subject === normalizedSubject)) {
      throw new CafeApiError('DUPLICATE_TITLE', 'An article with the exact title already exists');
    }
    const editor = resultOf((await this.#session.managerRequest('articleEditor', { articleId: normalizedArticleId, menuId })).data);
    if (String(editor.article?.articleId) !== normalizedArticleId || editor.article?.writerId !== editor.userId
      || String(editor.selectedMenu?.menu?.menuId) !== menuId || typeof editor.article?.contentJson !== 'string') {
      throw new CafeApiError('OWNER_REQUIRED', 'The article is unavailable in the current owner editor');
    }
    if (text != null && !rich) {
      let oldDocument;
      try { oldDocument = JSON.parse(editor.article.contentJson); }
      catch { throw new CafeApiError('SCHEMA', 'Current editor document is invalid'); }
      if (!Array.isArray(oldDocument?.document?.components)
        || oldDocument.document.components.some(component => component?.['@ctype'] !== 'text')) {
        throw new CafeApiError('RICH_CONTENT', 'Text replacement would remove non-text components');
      }
    }
    const originalOptions = editor.options ?? {};
    const optionNames = [
      'open', 'naverOpen', 'externalOpen', 'enableComment', 'enableScrap', 'enableCopy',
      'useAutoSource',
    ];
    const options = Object.fromEntries(optionNames.map(key => [key, originalOptions[key] === true]));
    options.useCcl = Array.isArray(originalOptions.cclTypes) && originalOptions.cclTypes.length > 0;
    const article = articlePayload({ cafeId: this.#context.cafeId, menuId,
      subject: normalizedSubject, text, contentJson: contentJson ?? (text == null ? editor.article.contentJson : undefined),
      tags: tags ?? editor.article.tagList ?? [], options });
    article.parentId = Number(editor.article.parentId ?? 0);
    article.headId = Number(editor.article.headId ?? editor.selectedMenu?.selectedHead?.headId ?? 0);
    article.cclTypes = Array.isArray(originalOptions.cclTypes) ? originalOptions.cclTypes : [];
    const expectedText = text == null ? before.article.contentText : linkPlain(text.trim());
    return this.#journaled('articleUpdate', { articleId: normalizedArticleId,
      previousSubject: normalizedExpected, subject: normalizedSubject,menuId,
      contentSha256:rich?.fingerprint??createHash('sha256').update(expectedText).digest('hex'),images:rich?.images.length??0 },
    () => this.#session.managerRequest('articleUpdate', { articleId: normalizedArticleId, menuId, article }),
    async () => {
      const after = await this.#reader.article({ articleId: normalizedArticleId });
      const verified = after.article.subject === normalizedSubject && sameText(after.article.contentText, expectedText)
        && (!rich || await this.#verifyRich({articleId:normalizedArticleId,menuId,rich,options:article,tags:article.tagList}));
      return { verified, result: { cafeId: this.#context.cafeId, articleId: normalizedArticleId,
        subject: normalizedSubject,menuId,ownerReadback: verified,...(rich?{images:rich.images.length,richDocumentVerified:verified,representativeSet:rich.images.some(x=>x.represent===true)}:{}) } };
    });
  }

  async deletePost({ articleId, expectedSubject }) {
    const normalizedArticleId = id(articleId, 'article ID');
    const normalizedSubject = title(expectedSubject, 'expected article subject');
    const before = await this.#reader.article({ articleId: normalizedArticleId });
    if (before.article.subject !== normalizedSubject) throw new CafeApiError('ARTICLE_MISMATCH', 'Article subject differs from the expected target');
    return this.#journaled('articleDelete', { articleId: normalizedArticleId, subject: normalizedSubject },
      () => this.#session.managerRequest('articleDelete', { articleId: normalizedArticleId }),
      async () => {
        const remaining = (await this.#allArticles()).some(row => row.articleId === normalizedArticleId);
        return { verified: !remaining, result: { cafeId: this.#context.cafeId,
          articleId: normalizedArticleId, subject: normalizedSubject, absentFromFullList: !remaining } };
      });
  }

  async addBoard({ name }) {
    const normalizedName = title(name, 'board name');
    const before = await this.managerMenus();
    if (before.menus.some(menu => menu.menuName === normalizedName)) {
      throw new CafeApiError('DUPLICATE_BOARD', 'A Cafe board with this name already exists');
    }
    const editedMenuInfo = addBoardPayload(before, normalizedName);
    return this.#journaled('boardAdd', { name: normalizedName },
      () => this.#session.managerRequest('menuSave', { editedMenuInfo }),
      async () => {
        const after = await this.managerMenus();
        const found = after.menus.filter(menu => menu.menuName === normalizedName && Number(menu.menuId) > 0);
        return { verified: found.length === 1, result: { cafeId: this.#context.cafeId,
          menuId: found.length === 1 ? String(found[0].menuId) : null, name: normalizedName,
          managerReadback: found.length === 1 } };
      });
  }

  async renameBoard({ menuId, expectedName, name }) {
    const normalizedMenuId = id(menuId, 'menu ID');
    const normalizedExpected = title(expectedName, 'expected board name');
    const normalizedName = title(name, 'board name');
    const before = await this.managerMenus();
    const menu = before.menus.find(item => String(item.menuId) === normalizedMenuId);
    if (!menu || menu.menuName !== normalizedExpected || menu.menuCode !== 'NORMAL') {
      throw new CafeApiError('BOARD_MISMATCH', 'Board differs from the expected target');
    }
    if (before.menus.some(item => String(item.menuId) !== normalizedMenuId && item.menuName === normalizedName)) {
      throw new CafeApiError('DUPLICATE_BOARD', 'A Cafe board with this name already exists');
    }
    const detail = resultOf((await this.#session.managerRequest('managerMenuInfo', { menuId: normalizedMenuId })).data);
    const info = detail.menus?.[0];
    if (!info || String(info.menuId) !== normalizedMenuId || info.menuCode !== 'NORMAL') {
      throw new CafeApiError('SCHEMA', 'Board settings response is invalid');
    }
    const editedMenuInfo = {
      wholeArticleViewTypeCode: before.wholeArticleViewTypeCode,
      basicMenuCodes: before.basicMenuCodes,
      menuIdOrder: before.menus.map(item => Number(item.menuId)),
      addedMenus: {}, modifiedMenus: { NORMAL: [modifiedNormalMenu(menu, info, normalizedName)] },
      deletedMenuIds: [],
    };
    return this.#journaled('boardRename', { menuId: normalizedMenuId,
      previousName: normalizedExpected, name: normalizedName },
    () => this.#session.managerRequest('menuSave', { editedMenuInfo }),
    async () => {
      const after = await this.managerMenus();
      const found = after.menus.find(item => String(item.menuId) === normalizedMenuId);
      const verified = found?.menuName === normalizedName;
      return { verified, result: { cafeId: this.#context.cafeId, menuId: normalizedMenuId,
        name: normalizedName, managerReadback: verified } };
    });
  }

  async deleteBoard({ menuId, expectedName }) {
    const normalizedMenuId = id(menuId, 'menu ID');
    const normalizedName = title(expectedName, 'expected board name');
    const before = await this.managerMenus();
    const target = before.menus.find(menu => String(menu.menuId) === normalizedMenuId);
    if (!target || target.menuName !== normalizedName) throw new CafeApiError('BOARD_MISMATCH', 'Board differs from the expected target');
    const posts = await this.#reader.list({ page: 1, menu: Number(normalizedMenuId) });
    if (posts.articles.length || posts.hasNext) throw new CafeApiError('BOARD_NOT_EMPTY', 'Delete or move board posts first');
    const check = resultOf((await this.#session.managerRequest('menuDeletableCheck', { menuId: normalizedMenuId })).data);
    if (check.deletable !== true) throw new CafeApiError('BOARD_NOT_DELETABLE', 'Naver Cafe does not allow deleting this board');
    const editedMenuInfo = deleteBoardPayload(before, normalizedMenuId);
    return this.#journaled('boardDelete', { menuId: normalizedMenuId, name: normalizedName },
      () => this.#session.managerRequest('menuSave', { editedMenuInfo }),
      async () => {
        const after = await this.managerMenus();
        const absent = !after.menus.some(menu => String(menu.menuId) === normalizedMenuId);
        return { verified: absent, result: { cafeId: this.#context.cafeId,
          menuId: normalizedMenuId, name: normalizedName, absentFromManagerMenuList: absent } };
      });
  }
}
