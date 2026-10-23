#!/usr/bin/env node
import { readFile, stat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createYouTubeDiscoveryClient } from '../adapters/youtube-discovery.mjs';
import { buildPromotionGraph, validatePromotionGraph } from '../../../packages/contracts/src/creator-promotions.mjs';
import { fingerprint, validateClaim, validateProductCandidate, validateRunManifest } from '../../../packages/contracts/src/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const flags = new Set(['video-id', 'channel-id', 'query', 'input', 'merchant-input', 'run-id', 'output-dir',
  'api-key-stdin', 'max-pages', 'max-items']);
function parse(args) {
  const out = {};
  for (const arg of args) {
    const match = /^--([a-z-]+)(?:=(.+))?$/.exec(arg);
    if (!match || !flags.has(match[1]) || Object.hasOwn(out, match[1])) fail('CREATOR_ARGUMENT_INVALID');
    out[match[1]] = match[2] ?? true;
  }
  return out;
}
function integer(value, fallback, maximum) {
  const number = value === undefined ? fallback : typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) fail('CREATOR_LIMIT_INVALID');
  return number;
}
async function inputFile(file) {
  if (typeof file !== 'string') fail('CREATOR_INPUT_INVALID');
  const info = await stat(file);
  if (!info.isFile() || info.size > 16 * 1024 * 1024) fail('CREATOR_INPUT_TOO_LARGE');
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { fail('CREATOR_INPUT_JSON_INVALID'); }
}
async function memoryKey() {
  if (process.stdin.isTTY) fail('CREATOR_STDIN_REQUIRED');
  const chunks = []; let size = 0;
  try {
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 8192) fail('CREATOR_CREDENTIAL_INPUT_TOO_LARGE');
      chunks.push(Buffer.from(chunk));
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!object(value) || value.provider !== 'youtube' || typeof value.apiKey !== 'string' ||
        Object.keys(value).some(key => !['provider', 'apiKey'].includes(key))) fail('CREATOR_CREDENTIAL_SERVICE_MISMATCH');
    return value.apiKey;
  } catch (error) { fail(error.code ?? 'CREATOR_CREDENTIAL_INPUT_INVALID'); }
  finally { chunks.forEach(chunk => chunk.fill(0)); }
}
function normalizeVideo(video, receipt) {
  if (!object(video)) fail('CREATOR_VIDEO_SCHEMA_INVALID');
  const request = receipt?.request ?? receipt ?? video.sourceReceipt ?? {};
  return { ...video, sourceUrl: video.sourceUrl ?? video.url ?? video.source?.url,
    observedAt: video.observedAt ?? video.source?.observedAt ?? receipt?.checkedAt,
    sourceReceipt: { httpStatus: request.httpStatus, responseHash: request.responseSha256 ?? request.responseHash,
      sourceKind: video.source?.kind ?? receipt?.contractProvenance?.kind ?? null } };
}
async function save(dir, name, value, key) {
  const serialized = JSON.stringify(value, null, 2) + '\n';
  if (key && (serialized.includes(key) || serialized.includes(JSON.stringify(key).slice(1, -1)))) fail('CREATOR_SECRET_IN_RESULT');
  const handle = await open(path.join(dir, name), 'wx', 0o600);
  try { await handle.writeFile(serialized); } finally { await handle.close(); }
}

let credential;
try {
  const [mode, ...tail] = process.argv.slice(2), opts = parse(tail);
  if (!['video-page', 'search-page', 'channel-feed', 'search', 'import'].includes(mode)) fail('CREATOR_MODE_INVALID');
  for (const flag of ['video-id', 'channel-id', 'query', 'input', 'merchant-input', 'run-id', 'output-dir']) {
    if (opts[flag] !== undefined && (typeof opts[flag] !== 'string' || !opts[flag].trim() || /[\x00-\x1f\x7f]/.test(opts[flag]))) fail('CREATOR_ARGUMENT_INVALID');
  }
  if (opts['api-key-stdin'] !== undefined) {
    if (opts['api-key-stdin'] !== true || mode === 'import') fail('CREATOR_CREDENTIAL_ARGUMENT_INVALID');
    credential = await memoryKey();
  }
  const maxPages = integer(opts['max-pages'], 1, 20), maxItems = integer(opts['max-items'], 50, 500);
  const runId = opts['run-id'] ?? `creator-${new Date().toISOString().replace(/[^0-9]/g, '')}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,79}$/.test(runId)) fail('CREATOR_RUN_ID_INVALID');
  const dir = path.resolve(opts['output-dir'] ?? path.join(root, 'runs', runId));
  const client = createYouTubeDiscoveryClient({ apiKey: credential });
  let videos = [], receipts = [], sourceCoverage;
  if (mode === 'video-page') {
    if (!opts['video-id']) fail('CREATOR_VIDEO_ID_REQUIRED');
    const result = await client.getVideoPageMetadata({ videoId: opts['video-id'] });
    videos = [normalizeVideo(result.video, result.receipt)]; receipts = [result.receipt];
    sourceCoverage = { mode: 'explicit_public_document', browserUsed: false, isXhr: false, automaticFallback: false };
  } else if (mode === 'search-page') {
    if (!opts.query) fail('CREATOR_QUERY_REQUIRED');
    const search = await client.getSearchPageVideos({ query: opts.query, maxItems: Math.min(maxItems, 50) });
    receipts.push(search.receipt);
    for (const selected of search.videos) {
      const result = await client.getVideoPageMetadata({ videoId: selected.videoId });
      if (result.video.channelId !== selected.channelId) fail('CREATOR_SEARCH_CHANNEL_MISMATCH');
      videos.push(normalizeVideo(result.video, result.receipt)); receipts.push(result.receipt);
    }
    sourceCoverage = { mode: 'explicit_public_document_search', browserUsed: false, isXhr: false,
      automaticFallback: false, completeCatalog: false, selectedVideos: videos.length };
  } else if (mode === 'channel-feed') {
    if (!opts['channel-id']) fail('CREATOR_CHANNEL_ID_REQUIRED');
    const result = await client.getChannelFeed({ channelId: opts['channel-id'] });
    videos = result.videos.slice(0, maxItems).map(video => normalizeVideo(video, result.receipt));
    receipts = [result.receipt]; sourceCoverage = { mode: 'known_channel_feed', completeCatalog: false };
  } else if (mode === 'search') {
    if (!opts.query) fail('CREATOR_QUERY_REQUIRED');
    const result = await client.collectSearchVideos({ query: opts.query, maxPages, maxItems });
    videos = result.videos.map(video => normalizeVideo(video, (result.receipts ?? []).find(receipt => receipt.request?.httpStatus === 200)));
    receipts = result.receipts ?? []; sourceCoverage = result.collection ?? { completeCatalog: false };
  } else {
    const input = await inputFile(opts.input);
    const rows = Array.isArray(input) ? input : input.videos;
    if (!Array.isArray(rows) || rows.length > maxItems) fail('CREATOR_INPUT_VIDEO_LIMIT');
    videos = rows.map(video => normalizeVideo(video)); sourceCoverage = { mode: 'caller_supplied_records', networkUsed: false };
  }
  const merchantInput = opts['merchant-input'] ? await inputFile(opts['merchant-input']) : [];
  const merchantObservations = Array.isArray(merchantInput) ? merchantInput : merchantInput.observations;
  if (!Array.isArray(merchantObservations) || merchantObservations.length > 500) fail('CREATOR_MERCHANT_INPUT_INVALID');
  const generatedAt = new Date().toISOString();
  const trustedLiveVideos = mode === 'import' ? new Set() : new Set(videos);
  const result = buildPromotionGraph({ videos, merchantObservations, generatedAt,
    trustedVideoVerifier: video => trustedLiveVideos.has(video), trustedMerchantVerifier: undefined });
  validatePromotionGraph(result);
  result.claims.forEach(validateClaim); result.productCandidates.forEach(validateProductCandidate);
  const codeFiles = ['apps/affiliate-api-hub/scripts/collect-creator-promotions.mjs', 'apps/affiliate-api-hub/adapters/youtube-discovery.mjs',
    'packages/contracts/src/creator-promotions.mjs', 'packages/contracts/src/index.mjs'];
  const code = Object.fromEntries(await Promise.all(codeFiles.map(async file => [file, fingerprint(await readFile(path.join(root, file), 'utf8'))])));
  const manifest = { schemaVersion: 1, runId, goal: 'Collect public creator collaboration/discount announcements and source-grounded ontology records',
    createdAt: generatedAt, codeHash: fingerprint(code), inputHash: fingerprint({ mode, videoIds: videos.map(video => video.videoId), merchantObservations }),
    templateHash: fingerprint({ graphVersion: result.graph.graphVersion }), rubricHash: fingerprint({ rawAnnouncementIsNotVerifiedDeal: true }),
    publishingAuthorized: false, externalOntologyWritesSent: false, sourceCoverage };
  validateRunManifest(manifest);
  await mkdir(path.dirname(dir), { recursive: true });
  await mkdir(dir);
  const sourceSnapshot = videos.map(video => ({ videoId: video.videoId, channelId: video.channelId, channelTitle: video.channelTitle,
    title: video.title, publishedAt: video.publishedAt, observedAt: video.observedAt, sourceUrl: video.sourceUrl,
    descriptionHash: video.descriptionSha256 ?? fingerprint(video.description), sourceKind: video.source?.kind ?? null,
    descriptionPersisted: false }));
  const artifacts = { 'INPUT_MANIFEST.json': manifest, 'source-snapshot.json': { videos: sourceSnapshot, receipts, sourceCoverage },
    'creator-promotion-graph.json': result.graph, 'claim-evidence-ledger.json': { schemaVersion: 1, claims: result.claims, sourceEvidence: result.sourceEvidence },
    'product-candidates.json': result.productCandidates, 'collection-receipt.json': { schemaVersion: 1, runId, generatedAt, code,
      videoCount: videos.length, graphNodeCount: result.graph['@graph'].length, claimCount: result.claims.length,
      productCandidateCount: result.productCandidates.length, diagnostics: result.diagnostics, livePublishingVerified: false } };
  for (const [name, value] of Object.entries(artifacts)) await save(dir, name, value, credential);
  console.log(JSON.stringify({ ok: true, runId, output: dir, videos: videos.length, nodes: result.graph['@graph'].length,
    claims: result.claims.length, products: result.productCandidates.length, sourceCoverage, externalWritesSent: false }));
} catch (error) {
  const code = /^[A-Z][A-Z0-9_]{1,100}$/.test(error?.code ?? '') ? error.code : 'CREATOR_COLLECTION_FAILED';
  console.error(JSON.stringify({ ok: false, code })); process.exitCode = 1;
} finally { credential = undefined; }
