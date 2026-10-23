import { createThreadsInsightsClient } from './threads-insights.mjs';
const [operation, startDate, endDate, code] = process.argv.slice(2);
try {
  if (!['summary', 'audience', 'links', 'posts', 'aiSummary', 'post', 'postRates'].includes(operation)) throw Object.assign(new Error('THREADS_INSIGHTS_USAGE'), { code: 'THREADS_INSIGHTS_USAGE' });
  const client = await createThreadsInsightsClient({ startDate, endDate });
  let post;
  if (['post', 'postRates'].includes(operation)) {
    const result = await client.read('posts');
    post = result.data.posts.find(item => item.code === code);
    if (!post) throw Object.assign(new Error('THREADS_INSIGHTS_POST_NOT_IN_FIRST_PAGE'), { code: 'THREADS_INSIGHTS_POST_NOT_IN_FIRST_PAGE' });
  }
  console.log(JSON.stringify(await client.read(operation, post)));
} catch (error) {
  console.log(JSON.stringify({ service: 'threads', code: error.code || 'THREADS_INSIGHTS_TRANSPORT', httpStatus: error.httpStatus ?? null,
    retryAt: error.retryAt ?? null, socialWrites: 0 }));
  process.exitCode = 2;
}
