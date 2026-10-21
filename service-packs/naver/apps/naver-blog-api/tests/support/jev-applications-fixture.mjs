import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {aiResearchFixture} from './ai-research-fixture.mjs';
import {NOW,bind} from './publication-fixture.mjs';
import {documentFingerprint,sha256} from '../../scripts/gates/publication-document.mjs';
import {fingerprint} from '../../../../packages/contracts/src/index.mjs';
import {buildJevQualityState} from '../../workflows/republish/jev-quality.mjs';
import {JEV_APPLICATIONS_SCOPE,JEV_APPLICATION_SOURCES} from '../../scripts/gates/jev-applications-contract.mjs';

export async function jevApplicationsFixture(directory,now=NOW) {
  const job=await aiResearchFixture(directory,now),bundle=job.publicationBundle,research=bundle.research,ledger=bundle.claimLedger;
  research.topicKey=JEV_APPLICATIONS_SCOPE.topicKey;
  const originalSources=[['T_REPO','https://raw.githubusercontent.com/jarrodwatts/jev-trader/main/README.md'],
    ['T_CONFIG','https://raw.githubusercontent.com/jarrodwatts/jev-trader/main/src/config.ts'],
    ['B_REPO','https://raw.githubusercontent.com/browser-use/jev-ultrafast/main/README.md']];
  for(const [id,url] of originalSources) {
    const known=JEV_APPLICATION_SOURCES.find(s=>s.url===url),evidenceFile=`case-${id}.json`;
    const excerpt=`Synthetic ${id} project source excerpt documents a demonstration and its unverified limits.`;
    const bytes=Buffer.from(JSON.stringify({synthetic:true,excerpt}));await writeFile(path.join(directory,evidenceFile),bytes);
    const source={...known,id,evidenceFile,sha256:sha256(bytes),checkedAt:now.toISOString(),status:200};
    research.sources.push(source);ledger.evidence[id]={url,evidenceFile,sha256:source.sha256,checkedAt:source.checkedAt};
  }
  const cases=[
    {id:'trader',title:'Jev Trader 공개 구현',projectId:'jev-trader',domain:'trading',observationLevel:'repository_example',
      sourceIds:['T_REPO','T_CONFIG'],claimIds:['trader_observation'],limitations:'공개 저장소와 기본 설정을 읽었으며 실제 주문이나 수익 성과를 실행하여 검증하지 않았습니다.',
      financialResults:'not_independently_verified',tradingMode:'demo_only',limitClaimIds:['financial_uncertainty']},
    {id:'browser',title:'브라우저 자동화 공개 예시',projectId:'jev-ultrafast',domain:'browser_automation',observationLevel:'repository_example',
      sourceIds:['B_REPO'],claimIds:['browser_observation'],limitations:'공개 README 설명을 확인한 범위이며 실제 브라우저 실행 성능을 자체 측정하지 않았습니다.'},
  ];
  research.applications=cases;
  research.applicationBoundaries={publicationPurpose:'informational_case_studies',authorExecutedProjects:false,transactionExecution:'not_performed',financialPerformanceVerified:false};
  const claims=[
    ...cases.map(app=>({claimId:app.claimIds[0],claimType:'application_observation',applicationId:app.id,evidenceLevel:app.observationLevel,
      text:`${app.title}의 저장소에 게시된 구현 방식과 설명을 확인했습니다.`,support:'supports',publishable:true,sources:app.sourceIds})),
    {claimId:'financial_uncertainty',claimType:'uncertainty',text:'트레이딩 예시는 기본 설정과 작성자 설명을 확인했으며 실제 수익과 주문 결과를 독립적으로 검증하지 않았습니다.',support:'supports',publishable:true,sources:['T_CONFIG']},
  ];
  ledger.claims.push(...claims);
  for(const claim of claims)for(const sourceId of claim.sources)research.claimBindings.push({claimId:claim.claimId,sourceId,locator:'JSON $.excerpt',
    excerpt:`Synthetic ${sourceId} project source excerpt documents a demonstration and its unverified limits.`});
  bundle.document.blocks.push(...claims.map(c=>({type:'paragraph',claimClass:'factual',claimIds:[c.claimId],text:c.text})),
    ...research.sources.filter(s=>['T_REPO','B_REPO'].includes(s.id)).map(s=>({type:'link',display:'label',label:`프로젝트 ${s.projectId} 원문`,url:s.publicUrl})));
  job.researchSnapshot=structuredClone(research);
  // Synthetic test-only review covers the final applications fixture, not the
  // introduction revision inherited before adding project sources and claims.
  bundle.jevQuality.documentFingerprint=documentFingerprint(bundle.document);
  bundle.jevQuality.claimLedgerFingerprint=fingerprint(ledger);
  bundle.jevQuality.requestFingerprint=fingerprint(buildJevQualityState(bundle.document,ledger,research.claimBindings,research.sources));
  return bind(job);
}
