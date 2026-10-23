import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createStoredCafeClient } from '../lib/client.mjs';

// A bounded, read-only collection run. Normalized content stays in ignored runtime/.
// The shareable receipt contains counts, hashes and account-match booleans only.
try {
  const observed = JSON.parse(await readFile(new URL('../discovery/observed-contracts-2026-09-26.json', import.meta.url), 'utf8'));
  const output = path.resolve('runtime', `read-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(output, { recursive: true });
  const client = await createStoredCafeClient();
  const identity = await client.identity();
  const membership = await client.membership();
  const actorMatched = identity.loggedIn === true && identity.actorHash === client.metadata().actorHash;
  if (!actorMatched || membership.cafeMember !== true) throw Object.assign(new Error(), { code: 'AUTH_UNVERIFIED' });
  const values = {};
  for (const [name, run] of [
    ['menus', () => client.menus()],
    ['article21', () => client.article({ articleId: '21' })],
    ['comments21', () => client.comments({ articleId: '21' })],
    ['latestPage1', () => client.list({ page: 1 })],
    ['latestPage2', () => client.list({ page: 2 })],
    ['board1', () => client.list({ page: 1, menu: 1 })],
    ['search', () => client.search({ query: '소싱', page: 1 })],
  ]) {
    values[name] = await run();
    await writeFile(path.join(output, `${name}.json`), JSON.stringify(values[name], null, 2) + '\n', { flag: 'wx' });
  }
  const article = values.article21;
  const comments = values.comments21;
  const receipt = {
    version: 1, checkedAt: new Date().toISOString(), cafeId: '31714934', cafeSlug: 'serenacademmy',
    mode: 'pure_http_stored_session', browserUsedForHTTPRequest: false, publicWrites: 0,
    authentication: { provider: 'windows_dpapi_current_user', sameAccount: actorMatched,
      cafeMember: membership.cafeMember, memberLevelName: membership.memberLevelName,
      newProcessAfterBootstrap: true, storedSlot: 'naver-cafe-session', secretValuesIncluded: false },
    coverage: { menuCount: values.menus.menus.length, boardCount: values.menus.menus.filter(x => x.menuType === 'B').length,
      menuIdsPresent: values.menus.menus.every(x => x.id != null && x.id !== ''),
      articleId: article.articleId, articleReadable: article.article.isReadable,
      articleHtmlMatchesBrowser: article.contentHtmlSha256 === observed.browserFingerprints.articleHtmlSha256,
      articleHtmlSha256: article.contentHtmlSha256,
      commentsCount: comments.comments.length, commentsTotal: comments.displayCommentCount,
      commentsHaveNext: comments.hasNext, commentIdsPresent: comments.comments.every(x => x.id != null && x.id !== ''),
      commentsMatchBrowser: comments.commentsContentSha256 === observed.browserFingerprints.commentsSha256,
      commentsSha256: comments.commentsContentSha256,
      latestPage1Count: values.latestPage1.articles.length, latestPage2Count: values.latestPage2.articles.length,
      pagesDisjoint: !values.latestPage1.articles.some(x => values.latestPage2.articles.some(y => x.articleId === y.articleId)),
      board1Count: values.board1.articles.length, searchCount: values.search.articles.length,
      searchTotal: values.search.totalArticleCount, attachmentCount: article.attachments.length },
    operations: [identity.evidence, membership.evidence, ...Object.values(values).map(x => x.evidence)],
    outputDirectory: output,
  };
  await writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(receipt, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'CAFE_READ_FAILED' }));
  process.exitCode = 1;
}
