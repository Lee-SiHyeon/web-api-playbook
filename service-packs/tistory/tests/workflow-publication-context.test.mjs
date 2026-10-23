import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePublicationContext} from '../lib/workflows/publication-context.mjs';
test('bootstrap parser retains explicit false and excludes unrelated account data without evaluation',()=>{
 const blog={visibility:20,visibilityType:'0',categories:[{id:1,name:'Example',visibility:20}],privateEmail:'not-for-output',credential:'not-for-output'};
 const html=`<script>\nblog: ${JSON.stringify(blog)},\nneedCaptcha: false\nthrow Error('must not execute');</script>`;
 const result=parsePublicationContext(html);
 assert.equal(result.needCaptcha,false);
 assert.equal(result.settings.visibilityType,'0');
 assert.ok(!JSON.stringify(result).includes('not-for-output'));
 assert.throws(()=>parsePublicationContext('<html>Login</html>'),/shape changed/);
 assert.throws(()=>parsePublicationContext(html.replace('false','unknown')),/shape changed/);
});
