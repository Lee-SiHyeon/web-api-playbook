import { createHash, timingSafeEqual } from 'node:crypto';
import {
  CafeApiError, CafeSession, DEFAULT_CAFE, buildObservedCafeRequest,
} from './session.mjs';

const HASH = /^[a-f0-9]{64}$/i;
const validText = (value, limit = 300) => typeof value === 'string' ? value.slice(0, limit) : '';

function extractResult(data) {
  const result = data?.message?.result ?? data?.result;
  if (!result || typeof result !== 'object') throw new CafeApiError('SCHEMA', 'Naver Cafe result schema is missing');
  return result;
}

function matchesHash(actual, expected) {
  if (!HASH.test(actual || '') || !HASH.test(expected || '')) return false;
  try { return timingSafeEqual(Buffer.from(actual.toLowerCase(), 'hex'), Buffer.from(expected.toLowerCase(), 'hex')); }
  catch { return false; }
}

function safeCount(value) {
  if (value == null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function safeIdentifier(value) {
  const identifier = String(value ?? '');
  return /^\d{1,24}$/.test(identifier) ? identifier : null;
}

function safePublicId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value !== 'string') return '';
  return value.slice(0, 64).replace(/[\x00-\x1f\x7f]/g, '');
}

function safeDate(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? '' : date.toISOString();
  }
  if (typeof value === 'string' && /^\d{10,13}$/.test(value)) {
    const raw = Number(value);
    const date = new Date(value.length === 10 ? raw * 1000 : raw);
    return Number.isNaN(date.valueOf()) ? '' : date.toISOString();
  }
  return validText(value, 64);
}

function safeFilename(attachment) {
  let filename = validText(attachment?.fullName || attachment?.name, 255)
    .replace(/[\x00-\x1f\x7f/\\:]/g, '_');
  const extension = validText(attachment?.extension, 24).replace(/[^A-Za-z0-9.]/g, '').replace(/^\.+/, '');
  if (extension && !filename.toLowerCase().endsWith(`.${extension.toLowerCase()}`)) filename = `${filename}.${extension}`;
  return filename;
}

function htmlToText(value) {
  if (typeof value !== 'string' || !value) return '';
  const html = value.slice(0, 4 * 1024 * 1024)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|template|iframe|object|svg|video|audio)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/<(?:br|hr)\b[^>]*\/?\s*>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|h[1-6]|li|tr|blockquote|pre|table|ul|ol)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  return html
    .replace(/&nbsp;|&#160;|&#x0*a0;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (match, digits) => {
      const code = Number(digits);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
    })
    .replace(/&#x([0-9a-f]+);/gi, (match, digits) => {
      const code = Number.parseInt(digits, 16);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
    })
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n+ */g, '\n')
    .trim()
    .slice(0, 1_000_000);
}

function safeAttachment(attachment, index) {
  const size = safeCount(attachment?.size);
  return Object.freeze({
    index,
    type: validText(attachment?.type, 40),
    filename: safeFilename(attachment),
    extension: validText(attachment?.extension, 24).replace(/[^A-Za-z0-9.]/g, ''),
    size,
  });
}

function safeArticleRow(value) {
  const row = value?.type === 'ARTICLE' && value.item && typeof value.item === 'object'
    ? value.item
    : value?.type == null && value?.item && typeof value.item === 'object' ? value.item : value;
  if (!row || typeof row !== 'object' || row.articleId == null || typeof row.subject !== 'string') return null;
  return Object.freeze({
    cafeId: row.cafeId == null ? null : String(row.cafeId),
    articleId: String(row.articleId),
    menuId: row.menuId == null ? null : String(row.menuId),
    menuName: validText(row.menuName, 100),
    subject: validText(row.subject, 500),
    writerNickname: validText(row.writerNickname || row.writerInfo?.nickname, 120),
    writeDate: safeDate(row.writeDate || row.addDate),
    writeDateTimestamp: safeCount(row.writeDateTimestamp),
    readCount: safeCount(row.readCount),
    commentCount: safeCount(row.commentCount),
    likeItCount: safeCount(row.likeItCount),
  });
}

function safeComments(items) {
  return items.map(item => Object.freeze({
    id: safePublicId(item?.id),
    refId: safePublicId(item?.refId),
    nickname: validText(item?.writer?.nick || item?.writer?.nickname, 120),
    content: htmlToText(item?.content),
    updatedAt: safeDate(item?.updateDate || item?.writeDate),
  }));
}

function safeMenu(value) {
  return Object.freeze({
    id: safeIdentifier(value?.menuId),
    cafeId: safeIdentifier(value?.cafeId),
    name: validText(value?.menuName, 120),
    menuType: validText(value?.menuType, 40),
    boardType: validText(value?.boardType, 40),
    listOrder: safeCount(value?.listOrder),
    indent: safeCount(value?.indent),
    fold: value?.fold === true,
    hasNewArticle: value?.hasNewArticle === true,
    hasRegion: value?.hasRegion === true,
    hidden: value?.hidden === true,
    festaMenu: value?.festaMenu === true,
    alarm: value?.alarm === true,
    subscription: value?.subscription === true,
    lastUpdateDate: validText(value?.lastUpdateDate, 64),
    searchRefDate: validText(value?.searchRefDate, 64),
  });
}

function validCafeContext(context = {}) {
  const cafeId = String(context.cafeId ?? DEFAULT_CAFE.id);
  const cafeSlug = String(context.cafeSlug ?? DEFAULT_CAFE.slug);
  const metadata = context.session?.metadata?.();
  if (metadata && (metadata.cafeId !== cafeId || metadata.cafeSlug !== cafeSlug)) {
    throw new CafeApiError('SESSION_SCOPE', 'Cafe session is bound to a different cafe');
  }
  return { cafeId, cafeSlug };
}

function validateDownloadSource(attachment) {
  let url;
  try { url = new URL(attachment?.url); } catch { throw new CafeApiError('ATTACHMENT_SCOPE', 'Attachment is not downloadable'); }
  if (url.origin !== 'https://downapi.cafe.naver.com' || url.username || url.password || url.search || url.hash
    || !/^\/v1\.0\/cafes\/article\/file\/[a-f0-9-]+\/download$/i.test(url.pathname)) {
    throw new CafeApiError('ATTACHMENT_SCOPE', 'Attachment is outside the observed Naver Cafe download route');
  }
  return url.href;
}

export class NaverCafeClient {
  #session;
  #context;
  #now;
  #verifiedMember = false;

  constructor({ session, context, now = Date.now } = {}) {
    if (!session || typeof session.request !== 'function' || typeof session.metadata !== 'function') {
      throw new CafeApiError('INPUT', 'An authenticated Naver Cafe session is required');
    }
    this.#session = session;
    this.#context = validCafeContext({ ...context, session });
    this.#now = now;
  }

  async identity() {
    const { data, evidence } = await this.#session.request('identity', this.#context);
    const result = extractResult(data);
    if (typeof result.loggedIn !== 'boolean') {
      throw new CafeApiError('SCHEMA', 'Cafe identity response is missing expected fields');
    }
    if (!result.loggedIn) return Object.freeze({ loggedIn: false, actorHash: null, evidence });
    if (typeof result.userId !== 'string' || !result.userId) throw new CafeApiError('SCHEMA', 'Cafe identity response is missing expected fields');
    const actorHash = createHash('sha256').update(result.userId, 'utf8').digest('hex');
    return Object.freeze({ loggedIn: result.loggedIn, actorHash, evidence });
  }

  async membership() {
    const { data, evidence } = await this.#session.request('member', this.#context);
    const result = extractResult(data);
    if (typeof result.cafeMember !== 'boolean') throw new CafeApiError('SCHEMA', 'Cafe membership response is missing cafeMember');
    if (result.cafeId != null && String(result.cafeId) !== this.#context.cafeId) {
      throw new CafeApiError('CAFE_MISMATCH', 'Cafe membership response is for a different cafe');
    }
    return Object.freeze({
      cafeMember: result.cafeMember,
      memberLevelName: validText(result.memberLevelName, 80),
      memberLevel: safeCount(result.memberLevel),
      evidence,
    });
  }

  async article({ articleId = DEFAULT_CAFE.articleId, maxBytes } = {}) {
    this.#requireVerifiedMember();
    const { data, evidence } = await this.#session.request('article', { ...this.#context, articleId, maxBytes });
    return this.#safeArticleResult(extractResult(data), evidence, articleId);
  }

  async #safeArticleResult(result, evidence, articleId) {
    const article = result.article;
    if (!article || typeof article !== 'object' || typeof article.subject !== 'string') {
      throw new CafeApiError('SCHEMA', 'Cafe article response is missing the article');
    }
    this.#assertArticleScope(result, article, articleId);
    if (article.isReadable !== true || result.user?.isCafeMember !== true || result.user?.isLogin !== true) {
      throw new CafeApiError('MEMBERSHIP_REQUIRED', 'This Cafe article is not readable by the current account');
    }
    const contentHtml = typeof article.contentHtml === 'string' ? article.contentHtml : '';
    const contentHtmlSha256 = createHash('sha256').update(contentHtml, 'utf8').digest('hex');
    const attaches = Array.isArray(result.attaches) ? result.attaches.slice(0, 100) : [];
    const safe = Object.freeze({
      cafeId: result.cafeId == null ? this.#context.cafeId : String(result.cafeId),
      articleId: String(result.articleId ?? articleId),
      article: Object.freeze({
        subject: validText(article.subject, 500),
        contentText: htmlToText(contentHtml),
        writeDate: safeDate(article.writeDate),
        readCount: safeCount(article.readCount),
        commentCount: safeCount(article.commentCount),
        isReadable: article.isReadable === true,
      }),
      attachments: Object.freeze(attaches.map(safeAttachment)),
      authority: Object.freeze({ isEnableAttachFileDownload: result.authority?.isEnableAttachFileDownload === true }),
      contentHtmlSha256,
      evidence,
    });
    return safe;
  }

  async comments({ articleId = DEFAULT_CAFE.articleId, maxBytes } = {}) {
    this.#requireVerifiedMember();
    const { data, evidence } = await this.#session.request('comments', { ...this.#context, articleId, maxBytes });
    const result = extractResult(data);
    if (result.cafeId != null && String(result.cafeId) !== this.#context.cafeId) throw new CafeApiError('CAFE_MISMATCH', 'Cafe comments are for a different cafe');
    if (result.articleId != null && String(result.articleId) !== String(articleId)) throw new CafeApiError('ARTICLE_MISMATCH', 'Cafe comments are for a different article');
    const items = result.comments?.items;
    if (!Array.isArray(items)) throw new CafeApiError('SCHEMA', 'Cafe comment response is missing comments.items');
    const canonical = items.map(item => ({ id: item?.id ?? null, refId: item?.refId ?? null, content: item?.content ?? '' }));
    return Object.freeze({
      articleId: String(result.articleId ?? articleId),
      displayCommentCount: safeCount(result.displayCommentCount),
      hasNext: result.comments?.hasNext === true || result.hasNext === true,
      hasPrev: result.comments?.hasPrev === true || result.hasPrev === true,
      comments: Object.freeze(safeComments(items)),
      commentsContentSha256: createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex'),
      evidence,
    });
  }

  async list({ page = 1, menu, maxBytes } = {}) {
    this.#requireVerifiedMember();
    const { data, evidence } = await this.#session.request('list', { ...this.#context, page, menu, maxBytes });
    const result = extractResult(data);
    if (result.cafeId != null && String(result.cafeId) !== this.#context.cafeId) throw new CafeApiError('CAFE_MISMATCH', 'Cafe list is for a different cafe');
    if (!Array.isArray(result.articleList)) throw new CafeApiError('SCHEMA', 'Cafe list response is missing articleList');
    const articles = result.articleList.map(safeArticleRow).filter(Boolean);
    return Object.freeze({
      cafeId: String(result.cafeId ?? this.#context.cafeId),
      cafeName: validText(result.cafeName, 160),
      page: Number(page),
      menuId: menu == null ? null : String(menu),
      hasNext: result.hasNext === true,
      articles: Object.freeze(articles),
      evidence: Object.freeze({ ...evidence, articleCount: articles.length }),
    });
  }

  async search({ query, page = 1, menu, maxBytes } = {}) {
    this.#requireVerifiedMember();
    const { data, evidence } = await this.#session.request('search', { ...this.#context, query, page, menu, maxBytes });
    const result = extractResult(data);
    if (result.cafeId != null && String(result.cafeId) !== this.#context.cafeId) throw new CafeApiError('CAFE_MISMATCH', 'Cafe search is for a different cafe');
    if (!Array.isArray(result.articleList)) throw new CafeApiError('SCHEMA', 'Cafe search response is missing articleList');
    const articles = result.articleList.map(safeArticleRow).filter(Boolean);
    const totalArticleCount = safeCount(result.pageInfo?.totalArticleCount);
    const normalizedPage = Number(page);
    return Object.freeze({
      query: validText(query?.trim?.() || '', 200),
      page: normalizedPage,
      menuId: menu == null ? null : String(menu),
      totalArticleCount,
      lastNavigationPageNumber: safeCount(result.pageInfo?.lastNavigationPageNumber),
      hasNext: totalArticleCount == null ? null : normalizedPage * 20 < totalArticleCount,
      nextNavigationVisible: typeof result.pageInfo?.visibleNextButton === 'boolean' ? result.pageInfo.visibleNextButton : null,
      articles: Object.freeze(articles),
      evidence: Object.freeze({ ...evidence, articleCount: articles.length }),
    });
  }

  async menus({ maxBytes } = {}) {
    this.#requireVerifiedMember();
    const { data, evidence } = await this.#session.request('menus', { ...this.#context, maxBytes });
    const result = extractResult(data);
    if (result.cafeId != null && String(result.cafeId) !== this.#context.cafeId) throw new CafeApiError('CAFE_MISMATCH', 'Cafe menus are for a different cafe');
    if (!Array.isArray(result.menus)) throw new CafeApiError('SCHEMA', 'Cafe menu response is missing menus');
    return Object.freeze({
      cafeId: String(result.cafeId ?? this.#context.cafeId),
      menus: Object.freeze(result.menus.map(safeMenu)),
      evidence: Object.freeze({ ...evidence, menuCount: result.menus.length }),
    });
  }

  async openAttachment({ articleId = DEFAULT_CAFE.articleId, index = 0, timeoutMs } = {}) {
    this.#requireVerifiedMember();
    const normalizedIndex = Number(index);
    if (!Number.isSafeInteger(normalizedIndex) || normalizedIndex < 0 || normalizedIndex > 99) {
      throw new CafeApiError('INPUT', 'Invalid attachment index');
    }
    const { data } = await this.#session.request('article', { ...this.#context, articleId });
    const result = extractResult(data);
    const article = result.article;
    this.#assertArticleScope(result, article, articleId);
    if (!article || article.isReadable !== true || result.user?.isCafeMember !== true || result.user?.isLogin !== true
      || result.isBlind === true || article.isBlind === true || result.authority?.isEnableAttachFileDownload !== true) {
      throw new CafeApiError('ATTACHMENT_BLOCKED', 'Cafe article does not allow attachment downloads');
    }
    const attaches = Array.isArray(result.attaches) ? result.attaches : [];
    const source = attaches[normalizedIndex];
    if (!source || source.blocked === true || source.isBlocked === true || source.infected === true
      || source.isInfected === true || source.virusDetected === true || source.isBlind === true || source.blind === true
      || ['BLOCKED', 'INFECTED', 'BLIND'].includes(String(source.status || source.fileStatus || '').toUpperCase())) {
      throw new CafeApiError('ATTACHMENT_BLOCKED', 'Cafe attachment is missing or blocked');
    }
    const attachmentUrl = validateDownloadSource(source);
    const filename = safeFilename(source);
    const extension = validText(source.extension, 24).replace(/[^A-Za-z0-9.]/g, '');
    const attachment = Object.freeze({ index: normalizedIndex, filename, extension, size: safeCount(source.size) });
    const referer = buildObservedCafeRequest('article', { ...this.#context, articleId }).referer;
    const response = await this.#session.openAttachmentRequest({ url: attachmentUrl, referer, timeoutMs });
    if (response.status >= 300 && response.status < 400) {
      let redirectOrigin = null;
      const location = response.headers.get('location');
      if (location) {
        try {
          const target = new URL(location, attachmentUrl);
          if (target.protocol === 'https:') redirectOrigin = target.origin;
        } catch {}
      }
      await response.body?.cancel();
      throw new CafeApiError('ATTACHMENT_REDIRECT', 'Cafe attachment returned a redirect; destination path omitted', {
        httpStatus: response.status, redirectOrigin,
      });
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new CafeApiError('ATTACHMENT_HTTP', 'Cafe attachment returned an unexpected status', { httpStatus: response.status });
    }
    return Object.freeze({ response, attachment, origin: 'https://downapi.cafe.naver.com' });
  }

  #assertArticleScope(result, article, requestedArticleId) {
    if (result.cafeId == null || String(result.cafeId) !== this.#context.cafeId) {
      throw new CafeApiError('CAFE_MISMATCH', 'Cafe article response is for a different cafe');
    }
    const actualArticleId = result.articleId ?? article?.articleId;
    if (actualArticleId == null || String(actualArticleId) !== String(requestedArticleId)) {
      throw new CafeApiError('ARTICLE_MISMATCH', 'Cafe article response is for a different article');
    }
  }

  #requireVerifiedMember() {
    if (!this.#verifiedMember) throw new CafeApiError('AUTH_UNVERIFIED', 'Verify the current Naver identity and Cafe membership before reading protected content');
  }

  async verifyStoredMember() {
    const expectedActorHash = this.#session.metadata().actorHash;
    if (!HASH.test(expectedActorHash || '')) throw new CafeApiError('AUTH_UNVERIFIED', 'Stored Cafe session has no verified account binding');
    const identity = await this.identity();
    if (!identity.loggedIn || !matchesHash(identity.actorHash, expectedActorHash)) {
      await this.#session.requireReauthentication('identity_mismatch');
      throw new CafeApiError('REAUTH_REQUIRED', 'Current Naver identity does not match the stored Cafe session');
    }
    const membership = await this.membership();
    if (!membership.cafeMember) throw new CafeApiError('MEMBERSHIP_REQUIRED', 'Current Naver account is not a member of this Cafe');
    this.#verifiedMember = true;
    return Object.freeze({ identity: Object.freeze({ loggedIn: true, actorHash: identity.actorHash, evidence: identity.evidence }), membership });
  }

  metadata() { return this.#session.metadata(); }
}

export async function createStoredCafeClient({ context = DEFAULT_CAFE, ...options } = {}) {
  const session = await CafeSession.fromStored({ context, ...options });
  const client = new NaverCafeClient({ session, context, now: options.now });
  await client.verifyStoredMember();
  return client;
}

export async function bootstrapSharedCafeSession({ context = DEFAULT_CAFE, expectedActorHash, ...options } = {}) {
  if (!HASH.test(expectedActorHash || '')) throw new CafeApiError('INPUT', 'Expected browser actor hash is required');
  const session = await CafeSession.fromSharedBlogVault({ context, ...options });
  const client = new NaverCafeClient({ session, context, now: options.now });
  const identity = await client.identity();
  if (!identity.loggedIn || !matchesHash(identity.actorHash, expectedActorHash)) {
    throw new CafeApiError('ACTOR_MISMATCH', 'Naver Cafe identity does not match the expected browser account');
  }
  const membership = await client.membership();
  if (!membership.cafeMember) throw new CafeApiError('MEMBERSHIP_REQUIRED', 'The current account is not a member of this Cafe');
  await session.persistVerified({ actorHash: identity.actorHash, cafeMember: true });
  return Object.freeze({
    stored: true,
    provider: 'windows_dpapi_current_user',
    cafeId: String(context.cafeId ?? DEFAULT_CAFE.id),
    cafeSlug: String(context.cafeSlug ?? DEFAULT_CAFE.slug),
    actorHash: identity.actorHash,
    cafeMember: membership.cafeMember,
    memberLevelName: membership.memberLevelName,
    verifiedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
    evidence: Object.freeze({ identity: identity.evidence, membership: membership.evidence }),
  });
}

export async function renewCafeSessionFromStoredActorPin({ context = DEFAULT_CAFE, ...options } = {}) {
  const actorHashPin = await CafeSession.readStoredActorPin({ context, vault: options.vault });
  const verified = await bootstrapSharedCafeSession({
    ...options,
    context,
    expectedActorHash: actorHashPin,
  });
  return Object.freeze({
    renewed: true,
    stored: verified.stored,
    provider: verified.provider,
    cafeId: verified.cafeId,
    cafeSlug: verified.cafeSlug,
    actorMatched: true,
    cafeMember: verified.cafeMember,
    memberLevelName: verified.memberLevelName,
    verifiedAt: verified.verifiedAt,
  });
}
