import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { read } from '../../scripts/client.mjs';

const OPERATIONS = Object.freeze([
  ['visit/visit', 'dailyViews'],
  ['user/referer/search', 'inflowKeywords'],
  ['rank/cvContentPc', 'topPostsByConversions'],
]);

function dateInSeoul(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDate(date, amount) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function normalizedDate(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  const match = text.match(/^(\d{4})[-./]\s?(\d{1,2})[-./]\s?(\d{1,2})/);
  if (!match) return null;
  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
}

function inWindow(date, startDate, endDate) {
  return date !== null && date >= startDate && date <= endDate;
}

function countAt(values, index) {
  const value = values?.[index];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function statRows(reply) {
  const list = reply?.data?.result?.statDataList;
  if (!Array.isArray(list)) return [];
  return list.map(item => item?.data?.rows).filter(rows => rows && typeof rows === 'object');
}

function cleanKeyword(value) {
  if (typeof value !== 'string') return null;
  const keyword = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 160);
  return keyword || null;
}

function extractLogNo(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value, 'https://blog.naver.com');
    const queryLogNo = url.searchParams.get('logNo');
    if (/^\d{1,20}$/.test(queryLogNo || '')) return queryLogNo;
    const pathLogNo = url.pathname.match(/\/(\d{1,20})\/?$/)?.[1];
    return /^\d{1,20}$/.test(pathLogNo || '') ? pathLogNo : null;
  } catch {
    return null;
  }
}

function apiCode(error) {
  const candidate = String(error?.code || 'ERROR');
  return /^[A-Z][A-Z0-9_]{0,39}$/.test(candidate) ? candidate : 'ERROR';
}

function isAuthError(error) {
  return ['AUTH_MISSING', 'AUTH', 'REAUTH', 'REAUTH_REQUIRED', 'SESSION_EXPIRED'].includes(apiCode(error));
}

function emptyData() {
  return {
    posts: [],
    blog: { dailyViews: [], inflowKeywords: [], topPostsByConversions: [] },
  };
}

function mapDailyViews(reply, startDate, endDate) {
  const byDate = new Map();
  for (const rows of statRows(reply)) {
    for (let index = 0; index < (rows.date || []).length; index++) {
      const date = normalizedDate(rows.date[index]);
      const views = countAt(rows.visit, index);
      if (inWindow(date, startDate, endDate) && views !== null) byDate.set(date, { date, views });
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function mapInflowKeywords(reply, startDate, endDate) {
  const items = [];
  for (const rows of statRows(reply)) {
    for (let index = 0; index < (rows.searchQuery || []).length; index++) {
      const date = normalizedDate(rows.date?.[index]);
      const keyword = cleanKeyword(rows.searchQuery[index]);
      if (!inWindow(date, startDate, endDate) || !keyword) continue;
      const count = countAt(rows.cv, index);
      items.push({ date, keyword, ...(count === null ? {} : { count }) });
    }
  }
  return items.slice(0, 200);
}

function mapTopPosts(reply, startDate, endDate) {
  const byKey = new Map();
  for (const rows of statRows(reply)) {
    const uris = rows.uri || [];
    for (let index = 0; index < uris.length; index++) {
      const logNo = extractLogNo(uris[index]);
      const date = normalizedDate(rows.date?.[index]) || normalizedDate(rows.createDate?.[index]);
      if (!logNo || !inWindow(date, startDate, endDate)) continue;
      const rank = countAt(rows.rank, index);
      const conversions = countAt(rows.cv, index);
      const key = `${logNo}:${date}`;
      byKey.set(key, {
        post: { logNo, date, views: null, inflowKeywords: [] },
        topPost: { logNo, date, ...(rank === null ? {} : { rank }), ...(conversions === null ? {} : { conversions }) },
      });
    }
  }
  const values = [...byKey.values()].sort((a, b) => (
    (a.topPost.rank ?? Number.MAX_SAFE_INTEGER) - (b.topPost.rank ?? Number.MAX_SAFE_INTEGER)
      || b.topPost.date.localeCompare(a.topPost.date)
  ));
  return {
    posts: values.map(value => value.post),
    topPostsByConversions: values.map(value => value.topPost),
  };
}

export async function collectPostStats({
  blogId,
  days = 7,
  readImpl = read,
  now = new Date(),
} = {}) {
  if (typeof blogId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(blogId)) throw Object.assign(new Error('Invalid blog id'), { code: 'INPUT' });
  if (!Number.isInteger(days) || days < 1 || days > 90) throw Object.assign(new Error('Invalid days'), { code: 'INPUT' });

  const checkedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const endDate = dateInSeoul(new Date(checkedAt));
  const startDate = shiftDate(endDate, -(days - 1));
  const query = { timeDimension: 'DATE', startDate, exclude: '', _: String(new Date(checkedAt).getTime()) };
  const replies = {};
  const failures = [];
  const succeeded = new Set();

  for (const [operation, name] of OPERATIONS) {
    try {
      replies[name] = await readImpl({ operation, query: { ...query } });
      succeeded.add(name);
    } catch (error) {
      failures.push({ operation, code: apiCode(error) });
      if (isAuthError(error)) {
        return {
          schemaVersion: 1,
          checkedAt,
          blogId,
          ...emptyData(),
          coverage: {
            status: 'auth_required',
            requestedDays: days,
            startDate,
            endDate,
            blogDailyViews: false,
            blogInflowKeywords: false,
            topPostsByConversions: false,
            perPostViews: false,
            perPostInflowKeywords: false,
            missing: ['Naver stats session required'],
          },
          failures,
        };
      }
    }
  }

  const data = emptyData();
  if (succeeded.has('dailyViews')) data.blog.dailyViews = mapDailyViews(replies.dailyViews, startDate, endDate);
  if (succeeded.has('inflowKeywords')) data.blog.inflowKeywords = mapInflowKeywords(replies.inflowKeywords, startDate, endDate);
  if (succeeded.has('topPostsByConversions')) {
    const posts = mapTopPosts(replies.topPostsByConversions, startDate, endDate);
    data.posts = posts.posts;
    data.blog.topPostsByConversions = posts.topPostsByConversions;
  }

  const missing = [
    'per-post daily views (visit/visit is blog-level only)',
    'per-post inflow keywords (user/referer/search is blog-level only)',
  ];
  const status = failures.length > 0
    ? (succeeded.size > 0 ? 'partial' : 'unavailable')
    : (missing.length > 0 ? 'partial' : 'complete');
  return {
    schemaVersion: 1,
    checkedAt,
    blogId,
    ...data,
    coverage: {
      status,
      requestedDays: days,
      startDate,
      endDate,
      blogDailyViews: succeeded.has('dailyViews'),
      blogInflowKeywords: succeeded.has('inflowKeywords'),
      topPostsByConversions: succeeded.has('topPostsByConversions'),
      perPostViews: false,
      perPostInflowKeywords: false,
      missing,
    },
    failures,
  };
}

function parseArgs(args) {
  const values = {};
  for (const arg of args) {
    const match = arg.match(/^--(blog-id|out|days)=(.*)$/);
    if (!match || Object.hasOwn(values, match[1])) throw Object.assign(new Error('Invalid arguments'), { code: 'INPUT' });
    values[match[1]] = match[2];
  }
  if (!values['blog-id'] || !values.out) throw Object.assign(new Error('Missing required arguments'), { code: 'INPUT' });
  const days = values.days === undefined ? 7 : Number(values.days);
  if (!Number.isInteger(days) || days < 1 || days > 90) throw Object.assign(new Error('Invalid days'), { code: 'INPUT' });
  return { blogId: values['blog-id'], out: values.out, days };
}

async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  const record = await collectPostStats({ blogId: options.blogId, days: options.days });
  const out = path.resolve(options.out);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ status: record.coverage.status, posts: record.posts.length, dailyViewDays: record.blog.dailyViews.length, failures: record.failures.length }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(apiCode(error));
    process.exitCode = 1;
  });
}
