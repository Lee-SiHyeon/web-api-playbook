import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateExactReadback} from '../scripts/gates/publication-review-gates.mjs';
const expected='https://blogfiles.pstatic.net/signed-path/image.png';
function check(value){return evaluateExactReadback({publicationBundle:{document:{blocks:[{type:'image',publishedUrl:expected}]} }},{units:[{type:'image',value}]}).checks.fullOrderedContentMatches;}
test('observed Naver upload/public CDN aliases preserve exact image path identity',()=>{
 assert.equal(check('https://postfiles.pstatic.net/signed-path/image.png'),true);
 assert.equal(check(expected),true);
});
for(const url of ['https://postfiles.pstatic.net/different/image.png','https://other.pstatic.net/signed-path/image.png','https://postfiles.pstatic.net.evil.test/signed-path/image.png','http://postfiles.pstatic.net/signed-path/image.png','https://u:p@postfiles.pstatic.net/signed-path/image.png'])test(`different image source is rejected: ${url.replace('u:p@','')}`,()=>assert.equal(check(url),false));
