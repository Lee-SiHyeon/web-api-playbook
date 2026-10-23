import { finiteCount, metric, postIdOf } from './shared.mjs';

const PUBLIC_METRICS = Object.freeze(['views', 'likes', 'replies', 'reposts']);
const CREATOR_METRICS = Object.freeze(['impressions']);

function ownerHandle(item, deps) {
  const refs = item?.refs?.x ?? item?.refs?.twitter ?? {};
  let value = deps?.x?.ownerHandle ?? item?.ownerHandle ?? refs.handle ?? refs.ownerHandle ?? item?.authorHandle;
  if (value == null) {
    try {
      const rawUrl = refs.url ?? item?.url;
      const url = new URL(rawUrl);
      if (['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname.toLowerCase())) {
        value = /^\/@?([A-Za-z0-9_]{1,15})\/status\/\d{1,25}\/?$/.exec(url.pathname)?.[1];
      }
    } catch { /* A missing or non-X URL cannot identify an author. */ }
  }
  const handle = String(value ?? '').replace(/^@/, '');
  return /^[A-Za-z0-9_]{1,15}$/.test(handle) ? handle : '';
}

function publicValues(result) {
  const value = result?.item?.metrics ?? result?.metrics ?? result?.item ?? result;
  return {
    views: value?.views ?? null,
    likes: value?.likes ?? null,
    replies: value?.replies ?? null,
    reposts: value?.reposts ?? null,
  };
}

function manualImpressions(item, deps) {
  if (typeof deps.xManualSnapshot === 'function') return deps.xManualSnapshot(item);
  return item?.manualMetrics?.x ?? item?.refs?.x?.manualMetrics ?? item?.refs?.twitter?.manualMetrics ?? null;
}

async function readXPost(item, { deps, postId, handle, now }) {
  // A supplied readPost function is an explicit adapter boundary; callers
  // supplying a live reader own its existing read-budget enforcement.
  const injected = deps.x?.readPost ?? deps.readXPost;
  if (typeof injected === 'function') return injected({ item, postId, handle, now });

  const withSession = deps.x?.withSession;
  const session = deps.x?.session;
  if (typeof withSession !== 'function' && (!session || typeof session !== 'object')) return null;

  // Import the proven XClient only on a real, explicitly configured read. The
  // session is injected by the caller; this adapter never opens ProtectedStore,
  // reads cookies, or refreshes/renews a browser session.
  const { XClient, loadContracts } = await import('../../../../social-x/src/client.mjs');
  const { withReadBudget: realReadBudget } = await import('../../social-actions/x-read-budget.mjs');
  const contracts = deps.x?.contracts ?? await loadContracts();
  const budget = deps.x?.withReadBudget ?? realReadBudget;
  const owner = handle;
  const budgetRoot = deps.x?.readBudgetRoot;
  const at = typeof now === 'function' ? now : () => new Date(now ?? Date.now()).getTime();

  const run = async credentials => {
    const baseFetch = deps.x?.fetchImpl ?? credentials?.fetchImpl ?? globalThis.fetch;
    let budgetFailure = null;
    const fetchImpl = async (url, options = {}) => {
      const method = String(options.method ?? 'GET').toUpperCase();
      if (method !== 'GET') throw Object.assign(new Error('X_READ_METHOD_FORBIDDEN'), { code: 'X_READ_METHOD_FORBIDDEN' });
      let response;
      try {
        await budget(async () => {
          response = await baseFetch(url, options);
          return { status: response.status, headers: Object.fromEntries(response.headers.entries()) };
        }, { owner, operation: 'TweetDetail', ...(budgetRoot ? { root: budgetRoot } : {}), now: at });
      } catch (error) {
        // XClient intentionally converts transport exceptions to TRANSPORT;
        // preserve a local budget refusal so the caller can report its retry.
        budgetFailure = error;
        throw error;
      }
      return response;
    };
    const client = new XClient({
      ...credentials,
      contracts,
      fetchImpl,
      ...(credentials?.transactionProvider ? { transactionProvider: credentials.transactionProvider } : {}),
    });
    try {
      try { return await client.detail(postId, handle); }
      catch (error) { throw budgetFailure ?? error; }
    } finally {
      client.close();
    }
  };

  return typeof withSession === 'function' ? withSession(run) : run(session);
}

export function createXAdapter({ deps = {} } = {}) {
  return async function readXItem(item, context = {}) {
    const manualSource = 'x.creator-dashboard-manual';
    const publicSource = 'x.post-detail-readback';
    const handle = ownerHandle(item, deps);
    const postId = postIdOf(item, 'x');
    const values = { views: null, likes: null, replies: null, reposts: null };
    let publicReason = 'x_read_session_not_configured';
    let publicRetryable = false;

    if (handle && postId && /^\d{1,25}$/.test(postId)) {
      const result = await readXPost(item, {
        deps, postId, handle, now: context.now ?? Date.now(),
      });
      if (result !== null) {
        Object.assign(values, publicValues(result));
        publicReason = 'x_metric_not_returned';
      } else publicRetryable = true;
    } else {
      publicReason = !postId ? 'post_id_missing' : !handle ? 'owner_handle_missing' : 'post_id_invalid';
      publicRetryable = true;
    }

    const supplied = await manualImpressions(item, deps);
    const publicMetrics = Object.fromEntries(PUBLIC_METRICS.map(name => {
      const result = metric(finiteCount(values[name]), {
        source: publicSource, reason: values[name] == null ? publicReason : 'x_metric_invalid',
      });
      return [name, publicRetryable ? { ...result, retryable: true } : result];
    }));
    return {
      ...publicMetrics,
      impressions: metric(supplied && Object.hasOwn(supplied, 'impressions') ? supplied.impressions : null, {
        source: manualSource,
        reason: supplied && Object.hasOwn(supplied, 'impressions') ? 'manual_metric_invalid' : 'creator_dashboard_manual_entry_required',
      }),
    };
  };
}

export const X_PUBLIC_METRICS = PUBLIC_METRICS;
export const X_CREATOR_METRICS = CREATOR_METRICS;
export const xAdapterInternals = Object.freeze({ ownerHandle, publicValues });
