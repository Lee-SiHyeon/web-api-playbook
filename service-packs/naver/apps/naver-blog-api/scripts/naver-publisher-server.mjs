import http from 'node:http';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  evaluatePublisherJobGate,
  evaluatePublisherResultGate,
} from './gates/publisher-gates.mjs';
import { parseJsonText, readJsonFile } from './gates/json-io.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Map(process.argv.slice(2).map(value => {
  const [key, ...rest] = value.split('=');
  return [key.replace(/^--/, ''), rest.join('=')];
}));
const jobPath = path.resolve(args.get('job') || path.join(root, 'publisher-job.json'));
const resultPath = path.resolve(args.get('result') || path.join(root, 'publisher-result.json'));
const rejectedResultPath = path.resolve(args.get('rejected-result') || resultPath.replace(/\.json$/i, '.rejected.json'));
const jobGatePath = path.resolve(args.get('job-gate') || jobPath.replace(/\.json$/i, '.gate.json'));
const resultGatePath = path.resolve(args.get('result-gate') || resultPath.replace(/\.json$/i, '.gate.json'));
const port = Number(args.get('port') || 48766);
const maxBytes = 3 * 1024 * 1024;
const diagnosticModes = new Set(['inspect', 'component_probe', 'clear_probe', 'tab_probe']);

await mkdir(path.dirname(resultPath), {recursive: true});

const server = http.createServer(async (request, response) => {
  console.log(JSON.stringify({
    event: 'request',
    method: request.method,
    url: request.url,
    at: new Date().toISOString(),
  }));
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  response.setHeader('access-control-allow-headers', 'content-type');
  if (request.method === 'OPTIONS') {
    response.writeHead(204); response.end(); return;
  }
  if (request.method === 'GET' && request.url === '/health') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ok: true, jobPath, resultPath}));
    return;
  }
  if (request.method === 'GET' && request.url === '/job') {
    try {
      const text = await readFile(jobPath, 'utf8');
      const job = parseJsonText(text);
      if(job.publish===true||job.dryRun===false) {
        response.writeHead(410);
        response.end(JSON.stringify({error:'browser_publishing_retired',runner:'publisher:api'}));
        return;
      }
      const gate = await evaluatePublisherJobGate(job, {baseDir: path.dirname(jobPath)});
      await writeFile(jobGatePath, JSON.stringify(gate, null, 2) + '\n', 'utf8');
      if (!gate.passed) {
        response.writeHead(422);
        response.end(JSON.stringify({error: 'job_gate_failed', failedChecks: gate.failedChecks}));
        return;
      }
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(text);
    } catch {
      response.writeHead(404); response.end(JSON.stringify({error: 'job_not_found'}));
    }
    return;
  }
  if (request.method === 'POST' && request.url === '/result') {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) request.destroy();
      else chunks.push(chunk);
    });
    request.on('end', async () => {
      try {
        const record = parseJsonText(Buffer.concat(chunks).toString('utf8'));
        const job = await readJsonFile(jobPath);
        if(job.publish===true||job.dryRun===false) {
          response.writeHead(410);
          response.end(JSON.stringify({error:'browser_publishing_retired',runner:'publisher:api'}));
          return;
        }
        const gate = diagnosticModes.has(job.mode)
          ? {
              schemaVersion: 1,
              checkedAt: new Date().toISOString(),
              gate: 'diagnostic-result',
              passed: record?.jobId === job.jobId && record?.ok === true && record?.mode === job.mode,
              checks: {
                jobIdMatches: record?.jobId === job.jobId,
                resultOk: record?.ok === true,
                modeMatches: record?.mode === job.mode,
              },
              failedChecks: [],
            }
          : evaluatePublisherResultGate(job, record);
        if (gate.gate === 'diagnostic-result') {
          gate.failedChecks = Object.entries(gate.checks).filter(([, value]) => value !== true).map(([name]) => name);
        }
        await writeFile(resultGatePath, JSON.stringify(gate, null, 2) + '\n', 'utf8');
        if (!gate.passed) {
          await writeFile(rejectedResultPath, JSON.stringify({record, gate}, null, 2) + '\n', 'utf8');
          response.writeHead(422);
          response.end(JSON.stringify({error: 'result_gate_failed', failedChecks: gate.failedChecks}));
          console.error(JSON.stringify({rejected: resultPath, rejectedResultPath, jobId: record.jobId || null, failedChecks: gate.failedChecks}));
          return;
        }
        await writeFile(resultPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ok: true}));
        console.log(JSON.stringify({saved: resultPath, ok: record.ok, jobId: record.jobId || null}));
      } catch {
        response.writeHead(400); response.end(JSON.stringify({error: 'invalid_result'}));
      }
    });
    return;
  }
  response.writeHead(404); response.end();
});

server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({
    listening: `http://127.0.0.1:${server.address().port}`,
    jobPath,
    resultPath,
    rejectedResultPath,
    jobGatePath,
    resultGatePath,
  }));
});
