import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {scopedLoginHeader,runAuthorizedPublisher} from '../tools/discovery/publisher-session-handoff.mjs';
const cookies=[{name:'NID_AUT',value:'synthetic-auth-secret',domain:'.naver.com',path:'/',expires:-1},{name:'NID_SES',value:'synthetic-session-secret',domain:'.naver.com',path:'/',expires:-1}];
test('one-time handoff reaches the actual CLI interface with only required environment values',async()=>{
  let captured;
  const spawnImpl=(exe,args,options)=>{captured={exe,args,options:{...options,env:{...options.env}}};
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();
    queueMicrotask(()=>{child.stdout.emit('data',Buffer.from('{"ok":true,"source":"independent_http"}'));child.emit('close',0)});return child;};
  const result=await runAuthorizedPublisher({cookies,args:['--command=list-drafts','--blog-id=syntheticblog'],nodeExecutable:'synthetic-node'},
    {spawnImpl,env:{SystemRoot:'C:/Windows',UNRELATED_SECRET:'must-not-propagate',NODE_OPTIONS:'--require=unwanted'}});
  assert.equal(result.ok,true);assert.deepEqual(Object.keys(captured.options.env).sort(),['NAVER_COOKIE','SystemRoot']);
  assert.equal(captured.options.env.NAVER_COOKIE,scopedLoginHeader(cookies));
  assert.equal(captured.options.shell,false);assert.equal(captured.options.windowsHide,true);
  assert.equal(captured.args[0],'scripts/api/publisher-cli.mjs');
  assert.doesNotMatch(JSON.stringify(result),/secret/);
});
test('handoff rejects wrong domains, expired and ambiguous credentials without spawning',async()=>{
  for(const invalid of [[],[...cookies,cookies[0]],cookies.map(c=>({...c,domain:'.invalid.test'})),cookies.map(c=>({...c,expires:1})),cookies.map(c=>({...c,value:c.value+'\r\n'}))])assert.throws(()=>scopedLoginHeader(invalid),/AUTH_MISSING/);
});
test('a fault that echoes credentials is redacted at the runner boundary',async()=>{
  const spawnImpl=()=>{const c=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();queueMicrotask(()=>{c.stderr.emit('data',Buffer.from(cookies[0].value));c.emit('close',1)});return c;};
  const result=await runAuthorizedPublisher({cookies,args:['--command=list-drafts'],nodeExecutable:'synthetic-node'},{spawnImpl,env:{}});
  assert.deepEqual(result,{ok:false,code:'RUNNER_OUTPUT_REDACTED'});
});
