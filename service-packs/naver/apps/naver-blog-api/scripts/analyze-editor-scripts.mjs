import { readdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { ApiError, BLOG_ID } from './client.mjs';
import { fetchAndAnalyzePublicScript } from '../tools/discovery/public-script-analysis.mjs';

export function selectLatestEditorEvidenceName(names = []) {
  if (!Array.isArray(names)) throw new ApiError('INPUT', 'Evidence names must be an array');
  const candidates = names.filter(name => /^live-editor-(?:surface|read)-\d{8}T\d{6}Z\.json$/.test(name))
    .sort((a, b) => {
      const stampA = /-(\d{8}T\d{6}Z)\.json$/.exec(a)?.[1] || '';
      const stampB = /-(\d{8}T\d{6}Z)\.json$/.exec(b)?.[1] || '';
      return stampB.localeCompare(stampA) || b.localeCompare(a);
    });
  return candidates[0] ?? null;
}

async function latestReadEvidence() {
  const directory = new URL('../evidence/', import.meta.url);
  const name = selectLatestEditorEvidenceName(await readdir(directory));
  if (!name) throw new ApiError('EVIDENCE_MISSING', 'No completed editor evidence exists');
  return { name, data: JSON.parse(await readFile(new URL(name, directory), 'utf8')) };
}

function timestamp(value = new Date()) {
  return value.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export async function runPublicScriptAnalysis({ fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  const evidence = await latestReadEvidence();
  if (evidence.data.completed !== true || evidence.data.actor !== BLOG_ID) {
    throw new ApiError('EVIDENCE_INVALID', 'Latest read evidence is not a completed authorized run');
  }
  const urls = [...new Set((evidence.data.frontier || [])
    .filter(entry => entry?.kind === 'script' && typeof entry.url === 'string' && entry.url.startsWith('https://ssl.pstatic.net/'))
    .map(entry => entry.url))].slice(0, 100);
  const analyses = [];
  const failures = [];
  for (const url of urls) {
    try { analyses.push(await fetchAndAnalyzePublicScript(url, { fetchImpl })); }
    catch (error) {
      failures.push({ url: new URL(url).origin + new URL(url).pathname,
        code: error instanceof ApiError ? error.code : 'ANALYSIS_FAILED' });
    }
  }
  const checkedAt = now();
  const record = {
    schemaVersion: 1,
    checkedAt: checkedAt.toISOString(),
    actor: BLOG_ID,
    mode: 'public_editor_script_static_analysis',
    sourceEvidence: evidence.name,
    scriptsAttempted: urls.length,
    scriptsAnalyzed: analyses.length,
    mutationRequests: 0,
    credentialsUsed: false,
    analyses,
    failures,
  };
  const destination = new URL(`../evidence/public-editor-script-analysis-${timestamp(checkedAt)}.json`, import.meta.url);
  await writeFile(destination, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  return { destination, record };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedPath === import.meta.url) {
  runPublicScriptAnalysis().then(({ destination, record }) => {
    console.log(JSON.stringify({ completed: true, scriptsAnalyzed: record.scriptsAnalyzed,
      evidenceFile: destination.pathname.split('/').at(-1), mutationRequests: 0 }));
  }).catch(error => {
    console.error(JSON.stringify({ code: error instanceof ApiError ? error.code : 'ANALYSIS_FAILED',
      message: error instanceof ApiError ? error.message : 'Public script analysis failed' }));
    process.exitCode = 1;
  });
}
