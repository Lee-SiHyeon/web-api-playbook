import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run } from './run.mjs';
import { buildFromFiles } from './build-vertical-brief.mjs';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

export async function runVertical(verticalId = 'travel') {
  const profile = JSON.parse(
    await readFile(path.join(currentDir, 'verticals', `${verticalId}.json`), 'utf8'),
  );
  const args = [
    `--seed=${profile.seeds.join(',')}`,
    `--top=${profile.top || 100}`,
    `--autocomplete-seeds=${profile.autocompleteSeeds || 50}`,
  ];
  await run(args);
  return buildFromFiles(verticalId);
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invoked === import.meta.url) {
  const result = await runVertical(process.argv[2] || 'travel');
  console.log(JSON.stringify({
    completed: true,
    vertical: result.vertical,
    topOpportunityCount: result.topOpportunities.length,
  }));
}
