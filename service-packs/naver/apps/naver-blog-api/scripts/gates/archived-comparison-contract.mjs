import {fingerprint} from '../../../../packages/contracts/src/index.mjs';
import {articleBlockText} from './article-block-text.mjs';
export const ARCHIVED_COMPARISON_SCOPE=Object.freeze({blogId:'aicandoanything',logNo:'224417664446',productId:'9572250170',itemId:'29070056027',vendorItemId:'95515780987'});
export const ARCHIVE_HASHES=Object.freeze({candidates:'0d5aad5e5a64334b4a9602ff002d1fbb5749c0fb32c46dce49ce88adf3ea206d',manifest:'c972180832b4f86157f3dd0ea73c0da5c798932ba26984eab35ac25e20af5f5d',images:'6a710785f2dfda3e1b8afa1c270b0b4f3072fd6561dce87b2b9b2e9a61ba2980'});
export const ARCHIVED_RETAINED_IMAGES=Object.freeze(["01-cover.png", "02-measurement-checklist.png", "10-load-placement.png", "05-use-cases.png", "12-room-fit-matrix.png", "11-cleaning-flow.png", "07-community-questions.png", "08-evidence-boundary.png", "13-final-checklist.png"]);
export const ARCHIVED_REJECTED_HASHES=Object.freeze(["9b275b9242e5c29cea83c0758c08040270f7b142b2c3179694460e405296d903", "baf45f1c2ebe5cea53565cf33e92a93751fbd0def6f1a7b345b9cee4923fe2ad", "90caf952a68b06fdda989e04aa28a24b2b46c1ebae87563e4640f7906624de7c", "279930c764598865c229374ca1b0c94abdf852081ade842df4cd6a52124ae4bf"]);
export const ARCHIVED_ROWS=Object.freeze([
 ['VELMENT','당시 상품명12cm·3단','현재 표는 위에서 확인'],
 ['틈새 트롤리','후보 명칭 기록만 보존','현재 옵션 확인 필요'],
 ['리빙가감법','13cm·4단','9월20일 표시가13,800원'],
 ['엔비라이프','후보 명칭 기록만 보존','현재 옵션 확인 필요'],
 ['이동식 슬림 수납장','15cm·단수 미확인','9월20일 표시가18,200원'],
]);
export const isArchivedComparison=job=>job?.publicationBundle?.archiveComparison?.kind==='velment-20260920-archive-v1';
export const archivedComparisonScope=job=>isArchivedComparison(job)&&job?.blogId===ARCHIVED_COMPARISON_SCOPE.blogId&&job?.target?.type==='update'&&job.target.logNo===ARCHIVED_COMPARISON_SCOPE.logNo&&job?.publicationBundle?.format==='comparison'&&job?.inputProvider==='independent_http'&&job?.executionMode==='independent_http'&&job.publicationBundle.document?.blogId===ARCHIVED_COMPARISON_SCOPE.blogId&&job.publicationBundle.document?.logNo===ARCHIVED_COMPARISON_SCOPE.logNo&&['productId','itemId','vendorItemId'].every(k=>job.commercialSnapshot?.[k]===ARCHIVED_COMPARISON_SCOPE[k]);
const finish=checks=>({passed:Object.values(checks).every(v=>v===true),checks,failedChecks:Object.keys(checks).filter(k=>checks[k]!==true)});
export function evaluateArchivedComparison(job){
 const b=job?.publicationBundle,a=b?.archiveComparison,blocks=b?.document?.blocks||[],images=blocks.filter(x=>x.type==='image'),body=blocks.map(articleBlockText).join('\n');
 const table=blocks.find(x=>x.archiveRole==='dated_comparison');
 return finish({
  archivedExactUpdateScope:archivedComparisonScope(job),
  archivedOnlyCurrentSelectedProduct:b?.products?.length===1&&fingerprint(b.products[0])===fingerprint(job.commercialSnapshot),
  archivedCurrentSnapshotValues:job.commercialSnapshot?.payablePriceKrw===12380&&job.commercialSnapshot?.shippingKrw===0&&job.commercialSnapshot?.priceBasis==='member'&&job.commercialSnapshot?.seller==='덕선상무 유한회사'&&job.commercialSnapshot?.stockState==='in_stock'&&job.commercialSnapshot?.evidenceSha256===a?.currentSource?.sha256,
  archivedSnapshotNotCurrent:a?.asOf==='2026-09-20'&&a?.currentComparatorTermsVerified===false&&a?.historicalRowsAreOrderable===false,
  archivedImmutableSources:Object.keys(ARCHIVE_HASHES).every(k=>a?.sources?.[k]?.sha256===ARCHIVE_HASHES[k]),
  archivedRowsBound:table?.claimClass==='factual'&&fingerprint(table.rows)===fingerprint(ARCHIVED_ROWS)&&fingerprint(a?.rows)===fingerprint(ARCHIVED_ROWS),
  archivedConflictProminent:blocks.slice(0,3).some(x=>/12cm/.test(articleBlockText(x))&&/15cm/.test(articleBlockText(x))&&/外|외경/.test(articleBlockText(x)))&&blocks.some(x=>x.type==='table'&&/12cm/.test(articleBlockText(x))&&/15cm/.test(articleBlockText(x))),
  archivedCurrentPriceScoped:/9월\s*22일/.test(body)&&/와우회원/.test(body)&&/12,380원/.test(body)&&/14,900원/.test(body),
  archivedImagePreservation:images.length===ARCHIVED_RETAINED_IMAGES.length&&new Set(images.map(x=>x.sha256)).size===ARCHIVED_RETAINED_IMAGES.length&&images.every((x,i)=>x.file==='images/'+ARCHIVED_RETAINED_IMAGES[i]&&!ARCHIVED_REJECTED_HASHES.includes(x.sha256))&&images.every(x=>x.rights?.basis==='owned'&&x.sourceRepresentation==='original_programmatic_diagram'&&/9월\s*20일/.test(x.caption||'')&&/12cm/.test(x.caption||'')&&/15cm/.test(x.caption||'')),
  archivedUnsupportedPricesAbsent:!/(?:13,500|14,200)원/.test(body),
  archivedNoDefiniteFit:!/(?:12cm\s*틈새에\s*(?:들어갑니다|딱\s*맞)|가장\s*좁고|먼저\s*비교할\s*만|조건에\s*해당합니다)/.test(body),
  archivedNoPurportedUse:!/(?:직접\s*사용해|내돈내산|써\s*보니)/.test(body),
 });
}
export async function verifyArchivedComparisonEvidence(bundle,{read}={}){
 const a=bundle?.archiveComparison,checks={};
 try{
 const original=JSON.parse((await read(a.sources.candidates.evidenceFile,ARCHIVE_HASHES.candidates)).toString('utf8').replace(/^\uFEFF/,''));
 const manifest=JSON.parse((await read(a.sources.manifest.evidenceFile,ARCHIVE_HASHES.manifest)).toString('utf8').replace(/^\uFEFF/,''));
 const mapping=JSON.parse((await read(a.sources.images.evidenceFile,ARCHIVE_HASHES.images)).toString('utf8').replace(/^\uFEFF/,''));
 const raw=JSON.stringify(original);checks.archivedPrimaryRowsVerified=original.checkedAt.startsWith('2026-09-20')&&/리빙가감법/.test(raw)&&/13,800/.test(raw)&&/15cm 틈새장/.test(raw)&&/18,200/.test(raw);
 checks.archivedNamedCandidatesVerified=manifest.comparison.length===5&&manifest.comparison[1].name==='틈새 트롤리 슬림 선반'&&manifest.comparison[3].name==='엔비라이프 틈새 트롤리';
 const images=(bundle.document.blocks||[]).filter(x=>x.type==='image');const retained=mapping.filter(x=>ARCHIVED_RETAINED_IMAGES.includes(x.asset));checks.archivedOriginalImagesBound=mapping.length===13&&images.length===retained.length&&images.length===ARCHIVED_RETAINED_IMAGES.length&&images.every((x,i)=>x.sha256===retained[i].sha256&&x.file==='images/'+retained[i].asset&&x.publishedUrl===retained[i].publishedUrl&&!ARCHIVED_REJECTED_HASHES.includes(x.sha256));
 }catch{checks.archivedOriginalSourcesVerified=false;}
 try{
 const s=a.currentSource,raw=JSON.parse((await read(s.evidenceFile,s.sha256)).toString('utf8'));
 checks.archivedCurrentExactSku=['productId','itemId','vendorItemId'].every(k=>raw[k]===ARCHIVED_COMPARISON_SCOPE[k]);
 checks.archivedCurrentConflictVerified=/12cm/.test(raw.excerpt)&&/품명 및 모델명[^\n]*15cm/.test(raw.excerpt);
 checks.archivedCurrentStockSellerVerified=raw.buyButtonEnabled===true&&/판매자: 덕선상무 유한회사/.test(raw.excerpt);
 checks.archivedCurrentCommercialVerified=/12,380원/.test(raw.excerpt)&&/14,900원/.test(raw.excerpt)&&/와우회원.*무료배송/.test(raw.excerpt);
 }catch{checks.archivedCurrentSourceVerified=false;}
 return finish(checks);
}
