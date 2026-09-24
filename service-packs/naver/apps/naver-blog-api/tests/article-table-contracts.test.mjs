import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {articleBlockText} from '../scripts/gates/article-block-text.mjs';
import {travelPlanningLayoutChecks} from '../scripts/gates/travel-planning-contract.mjs';
import {evaluateMarketAnalysisArticle,marketNoticeValid,marketAsOfLabel} from '../scripts/gates/market-analysis-article-contract.mjs';
import {evaluateSingleOfferHotdeal} from '../scripts/gates/single-offer-hotdeal-contract.mjs';
import {hotelPromotionLayoutChecks} from '../scripts/gates/hotel-promotion-contract.mjs';
import {seoulShillaLayoutChecks} from '../scripts/gates/seoul-shilla-contract.mjs';
import {shillaFixture} from './support/seoul-shilla-fixture.mjs';
import {iclubLayoutChecks} from '../scripts/gates/iclub-hotel-contract.mjs';
import {marketAnalysisFixture} from './support/market-analysis-fixture.mjs';
import {singleOfferHotdealFixture} from './support/single-offer-hotdeal-fixture.mjs';
import {hotelPromotionFixture} from './support/hotel-promotion-fixture.mjs';
import {iclubFixture} from './support/iclub-hotel-fixture.mjs';
import {NOW} from './support/publication-fixture.mjs';
const asTable=b=>({...b,type:'table',text:undefined,columns:['항목','내용'],rows:[['조건',b.text]]});
async function directory(t){const p=await mkdtemp(path.join(os.tmpdir(),'article-table-'));t.after(()=>rm(p,{recursive:true,force:true}));return p;}
test('only schema-valid native table cells supply visible contract text',()=>{
 assert.match(articleBlockText({type:'table',columns:['혜택','조건'],rows:[['쿠폰','다른 쿠폰과 중복 불가']]}),/중복 불가/);
 assert.throws(()=>articleBlockText({type:'table',rows:[['쿠폰','중복 불가']]}),/INVALID_PUBLICATION_TABLE/);
 assert.throws(()=>articleBlockText({type:'table',columns:['항목','값'],rows:[['현재가']]}),/INVALID_PUBLICATION_TABLE/);
});
test('travel uncertainty in a table passes, but removing desired-time or unconfirmed status fails',()=>{
 const table={type:'table',columns:['항목','상태'],rows:[['예약','예약 전'],['08:30','희망 입장 시각']]};
 const check=b=>travelPlanningLayoutChecks({document:{blocks:[b]}}).travelUncertaintyVisible;
 assert.equal(check(table),true);assert.equal(check({...table,rows:[['예약','예약 전'],['08:30','확정 시간']]}),false);
 assert.equal(check({...table,rows:[['예약','완료'],['08:30','희망 입장 시각']]}),false);
});
test('market period qualifiers remain required when facts are moved to tables',async t=>{
 const job=await marketAnalysisFixture(await directory(t));const blocks=job.publicationBundle.document.blocks;
 for(let i=0;i<blocks.length;i++)if(blocks[i].type==='paragraph'&&blocks[i].claimClass==='factual')blocks[i]=asTable(blocks[i]);
 assert.equal(evaluateMarketAnalysisArticle(job,{now:NOW}).checks.marketReturnPeriodsVisible,true);
 for(const b of blocks)if(b.type==='table')b.rows=b.rows.map(r=>r.map(v=>v.replace(/24\s*시간/g,'기간')));
 assert.equal(evaluateMarketAnalysisArticle(job,{now:NOW}).checks.marketReturnPeriodsVisible,false);
});
test('positive dated record wording needs exact observation timestamp and rejects current-price claims',async t=>{
 const job=await marketAnalysisFixture(await directory(t));const b=job.publicationBundle.document.blocks;
 b[0].text=`관측 기준: ${marketAsOfLabel(NOW)}. 공개 데이터에 기반한 당시 시장 기록입니다. 투자 판단은 자신의 위험 기준에 따라 해주세요.`;
 assert.equal(marketNoticeValid(b[0].text),true);assert.equal(evaluateMarketAnalysisArticle(job,{now:NOW}).checks.marketFresh,true);
 assert.equal(marketNoticeValid(b[0].text.replace(/\d{2}:\d{2}/,'')),false);
 b.push({type:'paragraph',text:'지금 현재 가격입니다.'});assert.equal(evaluateMarketAnalysisArticle(job,{now:NOW}).checks.marketFresh,false);
});
test('hotdeal shipping qualifiers and prohibited promises are read from native table cells',async t=>{
 const job=await singleOfferHotdealFixture(await directory(t));const blocks=job.publicationBundle.document.blocks;
 for(let i=0;i<blocks.length;i++)if(blocks[i].type==='paragraph')blocks[i]=asTable(blocks[i]);
 const checks=evaluateSingleOfferHotdeal(job,{now:NOW}).checks;assert.equal(checks.hotdealShippingScopeVisible,true);assert.equal(checks.hotdealShippingEligibilityVisible,true);
 for(const b of blocks)if(b.type==='table')b.rows=b.rows.map(r=>r.map(v=>v.replace(job.commercialSnapshot.shippingQuote.conditions,'조건 삭제')));
 assert.equal(evaluateSingleOfferHotdeal(job,{now:NOW}).checks.hotdealShippingScopeVisible,false);
 blocks.push({type:'table',columns:['상품','평가'],rows:[['옵션','역대 최저가']]});assert.equal(evaluateSingleOfferHotdeal(job,{now:NOW}).checks.hotdealNoUnsupportedSuperlatives,false);
});
test('Shilla table qualifiers preserve conflicting coupon amounts, use deadline and already-discounted meaning',async t=>{
 const {job}=await shillaFixture(await directory(t));const bundle=job.publicationBundle;
 const offers=bundle.products[0].datedOffers;
 bundle.document.blocks=[{type:'paragraph',text:'2026년 9월 22일 조회한 세금 포함 1박 총액이며, 쿠폰 반영가에는 할인이 이미 들어 있습니다. 판매 옵션별 예시입니다.'},
 {type:'table',columns:['할인 전','쿠폰 반영가'],rows:offers.map(o=>[o.normalTotalKrw.toLocaleString('en-US')+'원',o.displayedTotalKrw.toLocaleString('en-US')+'원'])},
 {type:'table',columns:['할인액','최소 구매금액','적용 조건'],rows:[['5만원','카드: 60만원 / 상세: “55원 이상”','표기 불일치 · 결제 화면 확인']]},
 {type:'table',columns:['항목','조건'],rows:[['쿠폰 사용기한','2026년 9월 30일 23:59'],['숙박일 적용','쿠폰 기한과 별개로 원하는 투숙일의 적용 여부 확인']]}];
 let c=seoulShillaLayoutChecks(bundle);for(const k of ['shillaPricesAndBasisVisible','shillaCouponConflictVisible','shillaUseDeadlineVisible'])assert.equal(c[k],true,k);
 const original=structuredClone(bundle.document.blocks);
 bundle.document.blocks[2].rows[0][1]='카드: 60만원 / 상세: “55만원 이상”';assert.equal(seoulShillaLayoutChecks(bundle).shillaCouponConflictVisible,false);
 bundle.document.blocks=structuredClone(original);bundle.document.blocks[3].rows[0][1]='2026년 9월 29일 23:59';assert.equal(seoulShillaLayoutChecks(bundle).shillaUseDeadlineVisible,false);
 bundle.document.blocks=structuredClone(original);bundle.document.blocks[0].text='2026년 9월 22일 조회한 세금 포함 1박 총액, 판매 옵션별 예시입니다.';assert.equal(seoulShillaLayoutChecks(bundle).shillaPricesAndBasisVisible,false);
 bundle.document.blocks=structuredClone(original);bundle.document.blocks[1].rows[0][1]='1원';assert.equal(seoulShillaLayoutChecks(bundle).shillaPricesAndBasisVisible,false);
});
test('iclub table alternatives retain hotel-column association and exact date/confirmation conditions',async t=>{
 const {job}=await iclubFixture(await directory(t));const bundle=job.publicationBundle;
 bundle.document.blocks=[{type:'paragraph',text:'2026년 9월 22일 · 11월 3일 체크인~5일 체크아웃 · 성인 5명 · 객실 1개 · 2박. 요금은 변동됩니다. 취소 조건을 확인하세요.'},
 {type:'table',columns:['항목','셩완','AMTD'],rows:[['2박 이상 혜택','레이트 체크아웃 · 시간 미표기','13시 무료 레이트 체크아웃'],['제공 조건','예약 시 요청 · 객실 상황에 따라 제공','예약 시 요청 · 객실 상황에 따라 제공'],['예약 확정','영업일 기준 4일 이내','영업일 기준 4일 이내']]}];
 const original=structuredClone(bundle.document.blocks);let c=iclubLayoutChecks(bundle);for(const k of ['iclubQuoteDatesVisible','iclubBenefitConditionsVisible','iclubBookingCaveatVisible'])assert.equal(c[k],true,k);
 bundle.document.blocks[1].rows[0][1]='시간 미확인';assert.equal(iclubLayoutChecks(bundle).iclubBenefitConditionsVisible,false);
 bundle.document.blocks=structuredClone(original);bundle.document.blocks[1].rows[2][2]='영업일 기준 5일 이내';assert.equal(iclubLayoutChecks(bundle).iclubBookingCaveatVisible,false);
 bundle.document.blocks=structuredClone(original);bundle.document.blocks[0].text=bundle.document.blocks[0].text.replace('~5일','~6일');assert.equal(iclubLayoutChecks(bundle).iclubQuoteDatesVisible,false);
});
for(const [name,fixture,check] of [['hotel',hotelPromotionFixture,hotelPromotionLayoutChecks],['iclub',iclubFixture,iclubLayoutChecks],['shilla',shillaFixture,seoulShillaLayoutChecks]])test(name+' visible qualifiers retain checks when prose becomes native tables',async t=>{
 const {job}=await fixture(await directory(t));const bundle=job.publicationBundle;const before=check(bundle);
 for(let i=0;i<bundle.document.blocks.length;i++){const b=bundle.document.blocks[i];if(b.type==='paragraph')bundle.document.blocks[i]=asTable(b);}
 const after=check(bundle);for(const [key,value] of Object.entries(before))if(/Visible|Experience/.test(key))assert.equal(after[key],value,key);
});
