import test from 'node:test';
import assert from 'node:assert/strict';
import {tableRows,documentTables,renderUnits} from '../scripts/gates/publication-document.mjs';
import {compileEditorModel,inspectEditorModel} from '../scripts/api/editor-model.mjs';
import {parsePublicDocument} from '../scripts/api/public-document.mjs';
import {evaluateExactReadback,evaluatePublicationReview} from '../scripts/gates/publication-review-gates.mjs';
import {tableBoundsValid} from '../scripts/hybrid/editor-preview.mjs';
const table={type:'table',columns:['모델','가격'],rows:[['Grok','$30'],['Claude','$20']],columnWidths:[40,60],claimClass:'factual',claimIds:['price']};
const document={blogId:'example',logNo:'123456789',title:'Native comparison',blocks:[{type:'notice',text:'정보',presentation:'panel'},table]};
const seed={document:{components:[{'@ctype':'documentTitle',title:[{'@ctype':'paragraph',nodes:[{'@ctype':'textNode',value:'Old'}]}]}]}};
const para=value=>`<p class="se-text-paragraph">${value}</p>`;
const content=`<div class="se-component se-table"><table><tr><td>${para('정보')}</td></tr></table></div>`;
const parse=body=>parsePublicDocument(`<meta property="og:url" content="https://blog.naver.com/example/123456789"><meta property="og:title" content="Native comparison"><div id="post-view123456789"><div class="se-main-container">${content}${body}</div></div>`,{url:'https://blog.naver.com/PostView.naver?blogId=example&logNo=123456789'});
const markup=matrix=>`<div class="se-component se-table"><table>${matrix.map(row=>`<tr>${row.map(cell=>`<td>${para(cell)}</td>`).join('')}</tr>`).join('')}</table></div>`;
const job={blogId:'example',target:{type:'update',logNo:'123456789'},publicationBundle:{document},authorization:{approvedAt:new Date(Date.now()-1000).toISOString()}};
test('native comparison table compiles with header styles and coexists with notice panel',()=>{
 const model=compileEditorModel(seed,document),c=model.document.components[2];
 assert.equal(c['@ctype'],'table');assert.equal(c.columnCount,2);assert.equal(c.rows.length,3);
 assert.equal(c.rows[0].cells[0].value[0].nodes[0].style.bold,true);
 assert.equal(c.rows[1].cells[0].value[0].nodes[0].style.bold,false);
 assert.deepEqual(inspectEditorModel(model).units,renderUnits(document));
 const observed=parse(markup(tableRows(table)));
 assert.deepEqual(observed.tables,documentTables(document));
 assert.equal(evaluateExactReadback(job,observed).passed,true);
});
test('equal flattened text without an actual table fails exact table readback',()=>{
 const observed=parse(`<div class="se-component se-text">${tableRows(table).flat().map(para).join('')}</div>`);
 assert.deepEqual(observed.units,renderUnits(document));
 assert.equal(evaluateExactReadback(job,observed).checks.nativeTablesMatch,false);
});
test('changed row grouping fails even when the ordered cells are identical',()=>{
 const flat=tableRows(table).flat();const observed=parse(markup([flat.slice(0,3),flat.slice(3)]));
 assert.deepEqual(observed.units,renderUnits(document));
 assert.equal(evaluateExactReadback(job,observed).checks.nativeTablesMatch,false);
});
for(const [name,patch] of Object.entries({empty:{rows:[]},ragged:{rows:[['Grok']]},blank:{rows:[['Grok','']]},html:{rows:[['Grok','<b>30</b>']]},link:{rows:[['Grok','https://example.com']]},width:{columnWidths:[20,20]},nested:{rows:[['Grok',{}]]}})){
 test(`rejects ${name} native table`,()=>assert.throws(()=>tableRows({...table,...patch})));
}
test('table claims are classified and evidence-bound',()=>{
 const bad=structuredClone(job);delete bad.publicationBundle.document.blocks[1].claimClass;
 const result=evaluatePublicationReview(bad);assert.equal(result.checks.claimClassificationPresent,false);
 const missing=evaluatePublicationReview(job);assert.equal(missing.checks.materialClaimCoverage,false);
});
test('table-level horizontal overflow and vertically clipped cells fail despite fitting individual text widths',()=>{
 const cell={scrollWidth:130,clientWidth:130,scrollHeight:60,clientHeight:60};
 const layout={column:{left:20,right:370},tables:[{left:20,right:370,cells:[cell,cell]}]};
 assert.equal(tableBoundsValid(layout),true);
 assert.equal(tableBoundsValid({...layout,tables:[{...layout.tables[0],right:430}]}),false);
 assert.equal(tableBoundsValid({...layout,tables:[{...layout.tables[0],cells:[cell,{...cell,scrollHeight:100}]}]}),false);
});
