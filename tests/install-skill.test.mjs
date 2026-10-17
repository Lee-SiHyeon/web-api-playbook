import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

test('installer excludes known session/provider artifacts case-insensitively without claiming a content audit', async () => {
  const parent = await realpath(os.tmpdir());
  const root = await realpath(await mkdtemp(path.join(parent, 'playbook-install-test-')));
  const source = path.join(root, 'source'), target = path.join(root, 'installed');
  try {
    for (const dir of ['scripts','lib','nested','.venv','.venv-oliveyoung','.AUTH']) await mkdir(path.join(source,dir),{recursive:true});
    for (const file of ['scripts/install-skill.mjs','lib/cli.mjs']) {
      await writeFile(path.join(source,file),await readFile(new URL('../'+file,import.meta.url)));
    }
    await writeFile(path.join(source,'package.json'),JSON.stringify({type:'module',version:'fixture'}));
    const forbidden=['auth.json','nested/Auth.JSON','cookies.json','session.backup.json','token.json',
      'nested/test.sealed','.venv/marker.txt','.venv-oliveyoung/marker.txt','.AUTH/marker.txt','.env.production'];
    for (const file of forbidden) await writeFile(path.join(source,file),'SYNTHETIC_ONLY');
    await writeFile(path.join(source,'.env.example'),'EXAMPLE=');
    const receipt=JSON.parse(execFileSync(process.execPath,[path.join(source,'scripts/install-skill.mjs'),'--target='+target],
      {encoding:'utf8',windowsHide:true}));
    for (const file of forbidden) await assert.rejects(access(path.join(target,file)),{code:'ENOENT'},file);
    await access(path.join(target,'.env.example'));
    assert.equal(receipt.installed,true);
    assert.equal(receipt.credentialsCopied,null);
    assert.equal(receipt.credentialExclusion,'known_paths_only_not_content_verified');
    assert.throws(()=>execFileSync(process.execPath,[path.join(source,'scripts/install-skill.mjs'),'--target='+target],
      {encoding:'utf8',windowsHide:true,stdio:'pipe'}));
  } finally {
    // Only our newly created, resolved test directory; never follow a computed caller path.
    if(path.dirname(root)!==parent || !path.basename(root).startsWith('playbook-install-test-')) throw Error('TEST_CLEANUP_SCOPE');
    await rm(root,{recursive:true,force:true});
  }
});
