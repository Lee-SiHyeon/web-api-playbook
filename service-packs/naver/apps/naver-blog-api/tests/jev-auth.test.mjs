import test from 'node:test';
import assert from 'node:assert/strict';
import {readWindowsJevKey,jevSecretPath} from '../workflows/affiliate-content-e2e/jev-auth.mjs';

test('unsupported host or absent local store does not start a credential subprocess',()=>{
 const execute=()=>assert.fail('Must not read a credential');
 assert.equal(readWindowsJevKey({platform:'linux',execute}),'');
 assert.equal(readWindowsJevKey({platform:'win32',exists:()=>false,execute}), '');
});

test('DPAPI loader keeps the key out of argv and environment',()=>{
 const secret='fixture-only-key-not-real';
 const value=readWindowsJevKey({platform:'win32',filename:'C:/fixture/key.dpapi',exists:()=>true,execute(command,args,options){
   assert.equal(command,'powershell.exe');
   assert.equal(JSON.stringify(args).includes(secret),false);
   assert.equal(JSON.stringify(options.env).includes(secret),false);
   assert.equal(options.env.JEV_LOCAL_SECRET_PATH,'C:/fixture/key.dpapi');
   assert.equal(Object.keys(options.env).some(name=>name.toLowerCase()==='psmodulepath'),false);
   assert.equal(Object.keys(options.env).some(name=>['ai_gateway_api_key','typesafe_api_key','jev_api_key'].includes(name.toLowerCase())),false);
   assert.deepEqual(options.stdio,['ignore','pipe','pipe']);
   assert.equal(options.windowsHide,true);
   return secret;
 }});
 assert.equal(value,secret);
});

test('decryption errors are redacted',()=>assert.throws(()=>readWindowsJevKey({platform:'win32',exists:()=>true,execute(){throw new Error('secret stderr');}}),error=>error.message==='JEV_LOCAL_SECRET_UNREADABLE'&&error.cause===undefined));

test('provider stores are separate and unknown providers are rejected',()=>{
 assert.notEqual(jevSecretPath('C:/fixture','vercel'),jevSecretPath('C:/fixture','typesafe'));
 assert.throws(()=>jevSecretPath('C:/fixture','../other'),/PROVIDER_INVALID/);
});
