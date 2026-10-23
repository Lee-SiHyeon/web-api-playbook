#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { collectModetourDocument, compareModetourDocumentToBrowser, MODETOUR_DOCUMENT_URL } from '../src/travel-price/modetour-document.mjs';

const args = process.argv.slice(2);
if (args.some(arg => !/^--(?:out|browser-evidence)=.+/.test(arg))) throw new Error('ARGUMENT_INVALID');
const option = name => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const hash = value => createHash('sha256').update(value).digest('hex');
const result = await collectModetourDocument();
const evidencePath = option('browser-evidence');
let browser = null;
if (evidencePath) {
  const raw = await readFile(evidencePath);
  const evidence = JSON.parse(raw);
  const contract = evidence.contracts?.find(row => row.type === 'Document' && row.method === 'GET'
    && `${row.origin}${row.path}` === MODETOUR_DOCUMENT_URL && row.paired === true
    && row.status === 200 && row.mimeType === 'text/html');
  browser = { evidenceFile: path.basename(evidencePath), evidenceSha256: hash(raw),
    capturedAt: evidence.checkedAt, captured: !!contract && evidence.capture?.truncated === false,
    bodyCapture: evidence.bodyCapture?.status ?? 'not_recorded',
    comparison: compareModetourDocumentToBrowser(result.items, evidence.renderedRecommendations) };
}
const implementation = {};
for (const file of ['src/travel-price/modetour-document.mjs', 'scripts/modetour-document.mjs']) {
  implementation[`service-packs/ontology/${file}`] = hash(await readFile(new URL(`../${file}`, import.meta.url)));
}
const parserSha256 = implementation['service-packs/ontology/src/travel-price/modetour-document.mjs'];
const ok = result.items.length > 0 && (!browser || (browser.captured && browser.comparison.ok));
const receipt = { schemaVersion: 1, verifier: 'scripts/modetour-document.mjs', ok, ...result, parserSha256,
  schema: 'web-api-public-read-receipt-v1', service: 'ontology-modetour', capabilityId: 'catalog.document_recommendations',
  anonymous: true, authenticated: false, secretsPersistedInEvidence: false,
  schemaVerified: true, expectedResultVerified: ok, implementation,
  request: { ...result.request, origin: 'https://www.modetour.com', path: '/package/overseas',
    httpStatus: result.response.status, mime: 'text/html', responseBytes: result.response.bytes,
    checkedAt: result.checkedAt, browserUsed: false, anonymous: true, cookieSent: false, credentialsUsed: false },
  contractProvenance: { kind: browser?.captured ? 'browser_http_observed' : 'source_unverified',
    sourceURL: MODETOUR_DOCUMENT_URL, sourceSha256: browser?.evidenceSha256 ?? null,
    resourceType: 'Document', requestResponsePaired: browser?.captured ?? false,
    truncated: browser?.captured ? false : null, capturedAt: browser?.capturedAt ?? null },
  browserEvidence: browser,
  fiveStates: { captured: browser?.captured ?? false, client_exists: true, remnant_free: true,
    remnant_free_scope: 'complete_recurring_document_read', credential_propagated: 'not_applicable_anonymous', live_replay: true },
  writesSubmitted: 0,
  note: 'Captured refers to the dated Document request/status/MIME evidence. The independent HTTP body was parsed; no browser response-body equality or XHR product-feed capture is claimed.' };
if (option('out')) {
  const out = path.resolve(option('out'));
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
}
console.log(JSON.stringify({ ok, count: result.items.length, httpStatus: result.response.status,
  browserComparison: browser?.comparison ?? null, fiveStates: receipt.fiveStates }));
if (!ok) process.exitCode = 1;
