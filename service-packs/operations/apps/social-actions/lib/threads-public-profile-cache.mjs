import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withSessionLock } from '../../tistory-api/lib/lock.mjs';

export const THREADS_PUBLIC_PROFILE_CACHE_TTL_MS = 10 * 60_000;
const OWNER = 'lifehack__ailab';
const validId = value => /^\d{1,30}$/.test(String(value ?? ''));
const validHandle = value => typeof value === 'string' && /^[A-Za-z0-9_.]{1,30}$/.test(value);
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const digest = value => createHash('sha256').update(value.toLowerCase()).digest('hex');

export function threadsPublicProfileCacheRoot() {
  if (process.env.NODE_TEST_CONTEXT) return path.join(os.tmpdir(), `social-actions-test-public-profile-${process.pid}`);
  return path.join(process.env.LOCALAPPDATA || os.homedir(), 'affiliate-content-operations', 'threads-watchdog', 'public-profile-cache');
}

function cacheFile(root, handle) {
  if (!validHandle(handle)) throw Object.assign(new Error('THREADS_PUBLIC_PROFILE_CACHE_INPUT_INVALID'), { code: 'THREADS_PUBLIC_PROFILE_CACHE_INPUT_INVALID' });
  return path.join(root, digest(handle), 'snapshot.json');
}

function projectPost(value, handle) {
  if (!value || !validId(value.id) || value.author?.toLowerCase() !== handle.toLowerCase()
    || typeof value.text !== 'string' || value.text.length > 5000 || !/^[A-Za-z0-9_-]{5,30}$/.test(value.code || '')
    || value.url !== `https://www.threads.com/@${handle}/post/${value.code}`) {
    throw Object.assign(new Error('THREADS_PUBLIC_PROFILE_CACHE_INVALID'), { code: 'THREADS_PUBLIC_PROFILE_CACHE_INVALID' });
  }
  const result = { id: String(value.id), code: value.code, author: handle, url: value.url, text: value.text };
  for (const key of ['isReply', 'canReply', 'hasLiked', 'isRepostedByViewer', 'isPinnedToProfile']) {
    if (typeof value[key] === 'boolean' || value[key] === null) result[key] = value[key];
  }
  for (const key of ['directReplyCount', 'likeCount', 'repostCount', 'quoteCount']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0 || value[key] === null) result[key] = value[key];
  }
  if (validTime(value.publishedAt)) result.publishedAt = new Date(value.publishedAt).toISOString();
  return result;
}

function projectProfile(value, handle) {
  if (!value || value.handle?.toLowerCase() !== handle.toLowerCase() || !Array.isArray(value.posts)
    || typeof value.fullTimeline !== 'boolean' || typeof value.coverage !== 'string' || value.coverage.length > 80) {
    throw Object.assign(new Error('THREADS_PUBLIC_PROFILE_CACHE_INVALID'), { code: 'THREADS_PUBLIC_PROFILE_CACHE_INVALID' });
  }
  const posts = value.posts.map(post => projectPost(post, handle));
  const pinnedPosts = Array.isArray(value.pinnedPosts) ? value.pinnedPosts.map(post => projectPost(post, handle)) : [];
  const result = { handle, posts, pinnedPosts, pinnedPostIds: [...new Set([...posts, ...pinnedPosts]
    .filter(post => post.isPinnedToProfile === true).map(post => post.id))],
  fullTimeline: value.fullTimeline, coverage: value.coverage,
  pinState: typeof value.pinState === 'string' && value.pinState.length <= 80 ? value.pinState : 'not_exposed' };
  if (value.page && Number.isSafeInteger(value.page.pageCount) && value.page.pageCount >= 0
    && Number.isSafeInteger(value.page.requestedLimit) && value.page.requestedLimit >= 1
    && typeof value.page.hasNextPage === 'boolean' && typeof value.page.truncatedByLimit === 'boolean') {
    result.page = { pageCount: value.page.pageCount, requestedLimit: value.page.requestedLimit,
      hasNextPage: value.page.hasNextPage, truncatedByLimit: value.page.truncatedByLimit };
  }
  return result;
}

function validateCache(value, handle) {
  if (value?.schemaVersion !== 1 || value.service !== 'threads' || value.owner !== OWNER
    || value.handle?.toLowerCase() !== handle.toLowerCase() || !validId(value.actorId) || !validId(value.ownerId)
    || !validTime(value.relationshipCheckedAt) || !value.relationship || typeof value.relationship.following !== 'boolean'
    || typeof value.relationship.outgoingRequest !== 'boolean' || typeof value.relationship.blocking !== 'boolean'
    || value.followsOwner !== null && typeof value.followsOwner !== 'boolean'
    || value.private !== null && typeof value.private !== 'boolean'
    || value.profile !== null && (!validTime(value.profileCheckedAt) || !value.profile || typeof value.profile !== 'object')) {
    throw Object.assign(new Error('THREADS_PUBLIC_PROFILE_CACHE_INVALID'), { code: 'THREADS_PUBLIC_PROFILE_CACHE_INVALID' });
  }
  return value;
}

export async function readThreadsPublicActor(handle, { root = threadsPublicProfileCacheRoot(), now = Date.now(), requireProfile = false } = {}) {
  const file = cacheFile(root, handle);
  let value;
  try { value = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  validateCache(value, handle);
  const age = now - Date.parse(value.relationshipCheckedAt);
  if (age < 0 || age >= THREADS_PUBLIC_PROFILE_CACHE_TTL_MS) return null;
  const profileFresh = value.profile && now - Date.parse(value.profileCheckedAt) >= 0
    && now - Date.parse(value.profileCheckedAt) < THREADS_PUBLIC_PROFILE_CACHE_TTL_MS;
  if (requireProfile && !profileFresh) return null;
  return { service: 'threads', owner: OWNER, ownerId: value.ownerId, ownerVerified: true,
    handle: value.handle, id: value.actorId, relationship: value.relationship,
    followsOwner: value.followsOwner, private: value.private,
    ...(profileFresh ? { profile: value.profile, profileCheckedAt: value.profileCheckedAt } : {}),
    relationshipCheckedAt: value.relationshipCheckedAt, cacheHit: true };
}

export async function writeThreadsPublicActor({ handle, id, ownerId, relationship, followsOwner = null, private: privateAccount = null,
  profile } = {}, { root = threadsPublicProfileCacheRoot(), now = Date.now() } = {}) {
  const normalized = typeof handle === 'string' ? handle.toLowerCase() : handle;
  const file = cacheFile(root, normalized);
  if (!validId(id) || !validId(ownerId) || !relationship || typeof relationship.following !== 'boolean'
    || typeof relationship.outgoingRequest !== 'boolean' || typeof relationship.blocking !== 'boolean'
    || followsOwner !== null && typeof followsOwner !== 'boolean'
    || privateAccount !== null && typeof privateAccount !== 'boolean') {
    throw Object.assign(new Error('THREADS_PUBLIC_PROFILE_CACHE_INVALID'), { code: 'THREADS_PUBLIC_PROFILE_CACHE_INVALID' });
  }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = path.join(path.dirname(file), 'snapshot.lock');
  return withSessionLock(async () => {
    let prior = null;
    try { prior = validateCache(JSON.parse(await readFile(file, 'utf8')), normalized); }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'THREADS_PUBLIC_PROFILE_CACHE_INVALID') throw error; }
    const projectedProfile = profile === undefined ? prior?.profile ?? null : projectProfile(profile, normalized);
    const value = { schemaVersion: 1, service: 'threads', owner: OWNER, ownerId: String(ownerId),
      handle: normalized, actorId: String(id), relationship: { following: relationship.following,
        outgoingRequest: relationship.outgoingRequest, blocking: relationship.blocking === true },
      followsOwner, private: privateAccount, relationshipCheckedAt: new Date(now).toISOString(),
      profile: projectedProfile,
      ...(profile !== undefined ? { profileCheckedAt: new Date(now).toISOString() }
        : prior?.profileCheckedAt ? { profileCheckedAt: prior.profileCheckedAt } : {}) };
    if (value.profile === null) delete value.profileCheckedAt;
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handleFile = await open(temporary, 'wx', 0o600);
    try { await handleFile.writeFile(JSON.stringify(value) + '\n'); await handleFile.sync(); }
    finally { await handleFile.close(); }
    await rename(temporary, file);
    return { cached: true, handle: normalized, id: String(id), checkedAt: value.relationshipCheckedAt };
  }, { lockPath: lock, timeoutMs: 10_000 });
}
