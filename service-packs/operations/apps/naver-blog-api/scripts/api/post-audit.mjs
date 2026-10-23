import { PNG } from 'pngjs';
import { fingerprint } from '../../../../packages/contracts/src/index.mjs';
import { sha256, imageIdentity } from '../gates/publication-document.mjs';
import { inspectDuplication } from '../gates/content-duplication.mjs';

async function inspectImage(unit, position, fetchImpl) {
  const url = new URL(unit.value);
  if (url.protocol !== 'https:' || !/(^|\.)pstatic\.net$/.test(url.hostname) ||
      url.username || url.password || url.port || url.hash) throw Error('IMAGE_SCOPE');
  const response = await fetchImpl(url.href, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
  const mime = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
  if (response.status !== 200 || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime))
    throw Error('IMAGE_RESPONSE');
  const chunks = []; let length = 0;
  for await (const chunk of response.body || []) {
    length += chunk.length;
    if (length > 10 * 1024 * 1024) throw Error('IMAGE_SIZE');
    chunks.push(chunk);
  }
  if (!length) throw Error('IMAGE_EMPTY');
  const bytes = Buffer.concat(chunks), item = { position, sha256: sha256(bytes), bytes: length, mime };
  if (mime === 'image/png') {
    if (bytes.length < 24 || bytes.readUInt32BE(16) > 4096 || bytes.readUInt32BE(20) > 4096)
      throw Error('IMAGE_DIMENSIONS');
    const png = PNG.sync.read(bytes, { checkCRC: true });
    item.width = png.width; item.height = png.height;
    item.pixelFingerprint = fingerprint({ width: png.width, height: png.height, sha256: sha256(png.data) });
  }
  return item;
}

export async function auditPost(observation, { fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  if (observation?.source !== 'independent_http' || observation.httpStatus !== 200 ||
      !observation.targetIdentityVerified || !observation.smartEditorBodyPresent || !Array.isArray(observation.units))
    throw Error('POST_OBSERVATION_REQUIRED');
  const resources = new Map((observation.imageResources || []).map(image => [image.position, image.url]));
  const imageUnits = observation.units.map((unit, index) => ({ unit, position: index + 1 }))
    .filter(({ unit }) => unit.type === 'image');
  if (imageUnits.length > 100) throw Error('IMAGE_COUNT_LIMIT');
  const images = [], failures = [];
  for (let start = 0; start < imageUnits.length; start += 4) {
    const batch = imageUnits.slice(start, start + 4);
    const results = await Promise.allSettled(batch.map(({ unit, position }) => {
      const value = resources.get(position) || unit.value;
      if (imageIdentity(value) !== unit.value) return Promise.reject(Error('IMAGE_IDENTITY_MISMATCH'));
      return inspectImage({ ...unit, value }, position, fetchImpl);
    }));
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') images.push(result.value);
      else failures.push({ position: batch[i].position, code: /^[A-Z_]+$/.test(result.reason?.message || '') ? result.reason.message : 'IMAGE_AUDIT_FAILED' });
    });
  }
  const groups = new Map();
  for (const item of images) {
    const key = item.pixelFingerprint || item.sha256;
    groups.set(key, [...(groups.get(key) || []), item.position]);
  }
  const duplicateImages = [...groups.values()].filter(indices => indices.length > 1);
  const duplication = inspectDuplication(observation.units);
  const checks = { noDuplicateProse: duplication.noDuplicateProse,
    disclosureFirst: duplication.disclosureUnit === 1,
    allImagesVerified: failures.length === 0, noDuplicateImages: duplicateImages.length === 0 };
  return { schemaVersion: 1, source: 'independent_http', checkedAt: now().toISOString(),
    blogId: observation.blogId, logNo: observation.logNo, sourceHtmlSha256: observation.htmlSha256,
    unitCount: observation.units.length, imageCount: imageUnits.length,
    uniqueVerifiedImageContents: groups.size, checks, passed: Object.values(checks).every(Boolean),
    duplication, duplicateImages, images, failures,
    limitations: ['Exact bytes and decoded PNG pixels; recompressed non-PNG images are not compared visually.',
      'This audit does not verify current prices, claims, or overall editorial quality.'] };
}
