import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { NaverShoppingError, parseProductUrl, extractPreloadedState, normalizeProduct } from './naver-shopping.mjs';

const MAX_BYTES = 8 * 1024 * 1024;
const worker = fileURLToPath(new URL('../scripts/naver-brand-document-worker.py', import.meta.url));

export function readBrandDocument(url, { timeoutMs = 15000, responseByteLimit = MAX_BYTES } = {}) {
  const target = parseProductUrl(url);
  const canonical = `${target.storeUrl}/products/${target.productId}`;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000 ||
      !Number.isSafeInteger(responseByteLimit) || responseByteLimit < 1 || responseByteLimit > MAX_BYTES) {
    throw new NaverShoppingError('INPUT', 'Invalid document transport limits');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.NAVER_SHOPPING_PYTHON || 'python3', [worker], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'], shell: false,
    });
    let settled = false, metaSize = 0, bodySize = 0;
    const metadata = [], body = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { child.kill('SIGTERM'); reject(error); } else resolve(value);
    };
    const timer = setTimeout(() => finish(new NaverShoppingError('TRANSPORT', 'Document worker timed out')), timeoutMs + 5000);
    child.once('error', () => finish(new NaverShoppingError('TRANSPORT', 'Document worker could not start')));
    child.stdin.on('error', () => finish(new NaverShoppingError('TRANSPORT', 'Document worker input failed')));
    child.stdout.on('data', chunk => {
      metaSize += chunk.length;
      if (metaSize > 32768) finish(new NaverShoppingError('TRANSPORT', 'Document worker metadata exceeded its limit'));
      else metadata.push(chunk);
    });
    child.stderr.resume(); // Never forward library errors or raw upstream output.
    child.stdio[3].on('data', chunk => {
      bodySize += chunk.length;
      if (bodySize > responseByteLimit) finish(new NaverShoppingError('SIZE_LIMIT', 'Document exceeded the byte limit'));
      else body.push(chunk);
    });
    child.stdio[3].on('error', () => finish(new NaverShoppingError('TRANSPORT', 'Document body IPC failed')));
    child.once('close', code => {
      if (settled) return;
      try {
        const result = JSON.parse(Buffer.concat(metadata).toString('utf8'));
        if (!result.ok) {
          const error = result.error ?? {};
          return finish(new NaverShoppingError(error.code || 'TRANSPORT', error.message || 'Document read failed', error.receipt ?? null));
        }
        const bytes = Buffer.concat(body), receipt = result.receipt;
        if (code !== 0 || !receipt || receipt.httpStatus !== 200 || receipt.responseBytes !== bytes.length ||
            receipt.responseSha256 !== createHash('sha256').update(bytes).digest('hex')) {
          throw new Error('Invalid IPC receipt');
        }
        finish(null, { html: bytes.toString('utf8'), receipt });
      } catch {
        finish(new NaverShoppingError('TRANSPORT', 'Document worker returned invalid metadata'));
      }
    });
    child.stdin.end(JSON.stringify({ url: canonical, timeoutMs, responseByteLimit }));
  });
}

export function parseBrandProductDocument(html, productUrl, receipt) {
  const target = parseProductUrl(productUrl), state = extractPreloadedState(html);
  const raw = state.simpleProductForDetailPage, channel = state.channel;
  if (!raw || String(raw.id) !== target.productId || !channel ||
      typeof channel.channelUid !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(channel.channelUid) ||
      (raw.channel?.channelUid != null && raw.channel.channelUid !== channel.channelUid)) {
    throw new NaverShoppingError('SCHEMA_CHANGED', 'Product document identity or channel did not match', receipt);
  }
  const product = normalizeProduct({ ...raw, channel: { ...raw.channel, channelName: channel.channelName } },
    { storeUrl: target.storeUrl, checkedAt: receipt.checkedAt });
  product.sourceKind = 'product_document_state';
  return {
    scope: 'single_brand_product_document_snapshot', sourceProtocol: 'SSR_DOCUMENT',
    sourceStatePath: '__PRELOADED_STATE__.simpleProductForDetailPage',
    xhrApiRead: false, browserRequired: false, reviewBodiesIncluded: false,
    product, receipt,
  };
}

export async function getBrandProductDocument({ productUrl, timeoutMs, responseByteLimit } = {}) {
  const response = await readBrandDocument(productUrl, { timeoutMs, responseByteLimit });
  return parseBrandProductDocument(response.html, productUrl, response.receipt);
}
