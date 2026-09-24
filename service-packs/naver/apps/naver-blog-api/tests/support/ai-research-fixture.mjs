import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {PNG} from 'pngjs';
import {publicationFixture,bind,NOW} from './publication-fixture.mjs';
import {documentFingerprint,sha256} from '../../scripts/gates/publication-document.mjs';
import {fingerprint} from '../../../../packages/contracts/src/index.mjs';
import {buildJevQualityState,JEV_QUALITY_QUESTIONS} from '../../workflows/republish/jev-quality.mjs';
import {AI_RESEARCH_SCOPE} from '../../scripts/gates/ai-research-article-contract.mjs';

export async function aiResearchFixture(directory,now=NOW) {
  const job=await publicationFixture(directory,now),bundle=job.publicationBundle,checkedAt=now.toISOString();
  job.blogId=AI_RESEARCH_SCOPE.blogId;job.target={type:'create'};job.inputProvider='headless_sdk';
  job.publishSettings={tags:['테스트','정보'],visibility:'public',timing:'current',searchAllowed:true,categoryId:AI_RESEARCH_SCOPE.categoryId,categoryName:'AI'};
  delete job.affiliate;delete job.commercialSnapshot;
  bundle.document.blogId=job.blogId;delete bundle.document.logNo;
  bundle.format='ai_research_article';bundle.products=[];bundle.comparisonCriteria=[];
  bundle.layoutReference={id:'naver-ai-research-v1'};
  bundle.collision={blogId:job.blogId,checkedAt,decision:'create'};
  const evidence={},claims=[],sources=[],claimBindings=[];
  for(let i=0;i<2;i++) {
    const id=`S${i}`,evidenceFile=`research-${i}.json`,excerpt=`Synthetic official evidence passage ${i} for a meaningful source binding.`;
    const bytes=Buffer.from(JSON.stringify({synthetic:true,passage:excerpt}));await writeFile(path.join(directory,evidenceFile),bytes);
    const source={id,url:`https://docs.typesafe.ai/${i?'confidence':'primitives'}.md`,sourceKind:'official_documentation',evidenceFile,sha256:sha256(bytes),checkedAt,status:200};
    sources.push(source);evidence[id]={url:source.url,evidenceFile,sha256:source.sha256,checkedAt};
    claims.push({claimId:`C${i}`,claimType:'technical',text:`공식자료를 근거로 설명한 서로 다른 판단 구조 ${i}`,support:'supports',publishable:true,sources:[id]});
    claimBindings.push({claimId:`C${i}`,sourceId:id,locator:'JSON $.passage',excerpt});
  }
  bundle.claimLedger={schemaVersion:1,evidence,claims};
  bundle.research={schemaVersion:1,topicKey:AI_RESEARCH_SCOPE.topicKey,checkedAt,category:{id:AI_RESEARCH_SCOPE.categoryId,name:'AI'},sources,claimBindings,
    trendAssessment:{basis:'curated_primary_sources',checkedAt,limitations:'공식 자료를 선택하여 소개하며 인기 순위나 실제 활용 규모를 조사했다는 주장은 하지 않습니다.'}};
  job.researchSnapshot=structuredClone(bundle.research);
  const images=[];
  for(const [i,role] of ['cover','workflow','decision_checklist'].entries()) {
    const png=new PNG({width:12,height:8});png.data.fill(100+i*40);
    const bytes=PNG.sync.write(png),file=`${role}.png`;await writeFile(path.join(directory,file),bytes);
    images.push({type:'image',role,file,sha256:sha256(bytes),publishedUrl:`https://blogfiles.pstatic.net/synthetic-ai/${file}`,
      purpose:`Synthetic test illustration of ${role}`,rights:{basis:'generated',source:'Synthetic regression fixture only'}});
  }
  const caption=text=>({type:'paragraph',claimClass:'guidance',text});
  const heading=text=>({type:'heading',presentation:'quotation',claimClass:'guidance',text});
  job.title=bundle.document.title='Jev의 판단을 자동화에 연결하는 기준';
  bundle.document.blocks=[
    {type:'notice',text:'2026년 9월 20일 확인한 공식 원문을 바탕으로 정리한 정보입니다.'},
    images[0],caption('AI로 제작한 Jev 판단 구조 개념 그림입니다.'),
    {type:'paragraph',claimClass:'factual',claimIds:['C0'],text:claims[0].text},
    heading('판단을 작은 단계로 나누기'),images[1],caption('AI로 생성한 예시 처리 순서입니다.'),
    {type:'paragraph',claimClass:'factual',claimIds:['C1'],text:claims[1].text},
    heading('불확실한 결과를 검토하기'),caption('예시는 독자의 이해를 돕기 위한 설명이며 실제 측정이나 제품 성능을 주장하지 않습니다.'),
    heading('도입 전에 확인할 항목'),images[2],caption('AI로 제작한 도입 검토 항목 그림입니다.'),
    caption('작은 업무부터 결과를 기록하고 해당 업무의 성공 기준을 먼저 정해 보세요.'),
    ...sources.map(s=>({type:'link',display:'label',label:`공식 자료 ${s.id} 읽기`,url:s.url})),
  ];
  for(const review of Object.values(bundle.renderReviews))review.imageCount=3;
  // Synthetic test-only provider evidence, bound to this exact fixture revision.
  bundle.jevQuality={schemaVersion:1,checkedAt,decisionId:"republish-editorial-quality",mode:"active",provider:"synthetic-test-only",model:"synthetic-test-only",providerResult:"ok",confidenceFloor:.82,
    documentFingerprint:documentFingerprint(bundle.document),claimLedgerFingerprint:fingerprint(bundle.claimLedger),
    requestFingerprint:fingerprint(buildJevQualityState(bundle.document,bundle.claimLedger,bundle.research.claimBindings,bundle.research.sources)),
    comparisons:Object.fromEntries(Object.keys(JEV_QUALITY_QUESTIONS).map(id=>[id,{eligible:true,adoptedSource:"jev_active"}])),
    adopted:{evidence_sufficient:{noul:.95},editorial_quality:{score:2},next_action:{choice:"publish"},ai_slop_free:{noul:.95},table_use:{noul:.95},core_prose:{noul:.95},unsupported_claims_absent:{noul:.95}}};
  return bind(job);
}
