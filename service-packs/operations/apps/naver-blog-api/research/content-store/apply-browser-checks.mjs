import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function applyBrowserChecks(bundle, checks, now = new Date()) {
  const output = structuredClone(bundle);
  for (const product of output.affiliates) {
    const check = checks.find(c => c.productId === product.productId && c.itemId === product.itemId && c.vendorItemId === product.vendorItemId);
    if (!check) continue;
    const age = now - new Date(check.checkedAt);
    if (!Number.isFinite(age) || age < -300000 || age > 86400000 || check.method !== 'browser_public_landing') throw new Error('STALE_OR_INVALID_BROWSER_EVIDENCE');
    product.browserCheck = { productId: check.productId, itemId: check.itemId, vendorItemId: check.vendorItemId,
      productMatched: check.productMatched === true, itemMatched: check.itemMatched === true, titleMatched: check.titleMatched === true,
      vendorObserved: check.vendorObserved === true, attributionPresent: check.attributionPresent === true,
      method: check.method, checkedAt: check.checkedAt };
    product.landingVerified = check.productMatched === true && check.itemMatched === true && check.titleMatched === true && check.attributionPresent === true;
  }
  output.updatedAt = now.toISOString();
  return output;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [bundlePath, checksPath, outputPath] = process.argv.slice(2);
  const bundle = JSON.parse(await readFile(bundlePath, 'utf8'));
  const checks = JSON.parse(await readFile(checksPath, 'utf8'));
  await writeFile(outputPath, JSON.stringify(applyBrowserChecks(bundle, checks), null, 2) + '\n', { flag: 'wx' });
}
