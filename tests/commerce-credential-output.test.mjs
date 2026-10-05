import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCredentialFreeResult } from '../lib/commerce/credential-output.mjs';

test('nested session cookie and authorization values cannot reach price outputs',()=>{
  const credentials={session:{cookies:[{name:'session-cookie-name',value:'fixture-cookie-value'}],authorization:'Bearer fixture-auth-token'}};
  for(const value of ['fixture-cookie-value','Bearer fixture-auth-token']){
    assert.throws(()=>assertCredentialFreeResult({offers:[{title:value}]},credentials),{code:'COMMERCE_SECRET_IN_RESULT'});
  }
});

test('session origin metadata and cookie names are allowed without exposing credential values',()=>{
  const credentials={session:{allowedOrigins:['https://m.oliveyoung.co.kr'],cookies:[{name:'session-cookie-name',value:'fixture-cookie-value'}]}};
  assert.doesNotThrow(()=>assertCredentialFreeResult({receipt:{origin:'https://m.oliveyoung.co.kr',cookieField:'session-cookie-name'}},credentials));
});

test('application identifiers and access keys cannot become catalog output or query URLs',()=>{
  for(const field of ['applicationId','appId','accessKey','clientSecret']){
    assert.throws(()=>assertCredentialFreeResult({url:'https://public.example/?id=fixture-app-value'},{[field]:'fixture-app-value'}),{code:'COMMERCE_SECRET_IN_RESULT'});
  }
});
