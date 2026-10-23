import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {readXCreateJournalSlot,journaledRequest} from '../../affiliate-api-hub/scripts/sns/writers/journal.mjs';

test('QuickFact HTTP 200 without a created ID preserves its journal and prevents another send',async()=>{
 const journalDir=await mkdtemp(path.join(tmpdir(),'x-quickfact-hold-'));
 try{
  const runKey='qf-x-fixture',request={method:'POST',url:'https://x.com/i/api/graphql/fixture/CreateTweet'};
  const file=path.join(journalDir,`x.${runKey}.000001.jsonl`);
  const contents=[
   {type:'intent',channel:'x',runKey,sequence:1,request,at:'2026-10-03T07:37:03.190Z'},
   {type:'result',channel:'x',runKey,sequence:1,httpStatus:200,at:'2026-10-03T07:37:03.561Z'}
  ].map(event=>JSON.stringify(event)+'\n').join('');
  await writeFile(file,contents);
  const slot=await readXCreateJournalSlot({runKey,journalDir});
  assert.equal(slot.resolved,false);
  assert.equal(slot.postId,null);
  await assert.rejects(journaledRequest({channel:'x',runKey,journalDir,request,
   send:()=>assert.fail('an uncertain QuickFact write must never be resent')}),
  {code:'SNS_JOURNAL_RECONCILIATION_REQUIRED'});
  assert.equal(await readFile(file,'utf8'),contents);
 }finally{await rm(journalDir,{recursive:true,force:true});}
});
