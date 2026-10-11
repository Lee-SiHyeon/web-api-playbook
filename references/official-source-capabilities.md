# 공식 소스·크리에이터 도구를 계약으로 확보하기

Creator Studio 같은 계정 도구를 수집할 때 URL 목록만으로 계정 통계·글감·게시 기능을 확보했다고
보고하지 않는다. 먼저 공식 공개 소개·도움말·계정 workspace·developer API를 별도 capability로
분류하고, 기존 [recursive discovery](recursive-discovery.md)와
[source provenance](../checklists/README.md)를 사용한다. 이는 SNS별 새 로그인/게시 adapter가 아니다.

## 하나의 공식 도구에서 분리할 것

| source kind | 확보할 수 있는 사실 | 별도 검증이 필요한 것 |
|---|---|---|
| `official_product` | 실제 공식 제품명·설명·진입 URL | 현재 계정 접근·기능 entitlement |
| `official_guide` | 사용법·지원 국가/계정 조건·공개 기능 설명 | 해당 계정의 활성화·실제 수행 |
| `official_workspace` | 로그인 필요 여부·관측한 workspace 경계 | owner/channel/page/organization scope |
| `official_developer_api` | 문서화된 method/path·scope·tier | app 승인·실제 token·business replay |
| `official_notice` | 공식 출시·변경·종료 공지 | 기존 도구의 실제 redirect·신규 도구 접근 |

예를 들어 YouTube Studio와 공식 Help, Meta Business Suite와 developer 문서, TikTok Studio와
공식 Academy, 네이버의 플랫폼별 creator tool, X의 media workspace와 API entitlement는
서로 같은 소스/동일 API로 합치지 않는다. 하나의 도움말 항목을 국가·언어별로 복제해 실제
도구 개수처럼 집계하지도 않는다. platform, product, owner scope, market, interface language를
각각 저장하며 `creator`, `developer`, `advertiser` 역할을 구별한다.

## 권장 관측 record

이 record는 source inventory에 넣을 최소 항목이다. 공통 request profile이나 live receipt schema를
대체하는 새 실행 스키마가 아니며, 없는 정보는 `unknown`으로 남긴다.

```json
{
  "platform": "youtube",
  "product": "YouTube Studio",
  "sourceKind": "official_workspace",
  "sourceUrl": "https://studio.youtube.com/",
  "sourceAuthority": "first_party",
  "contractProvenance": "public_document_observed",
  "interfaceLanguage": "unknown",
  "market": "unknown",
  "accessRequirement": "account_login",
  "ownerScope": "channel",
  "accessObservation": "not_checked",
  "capabilitiesDocumented": [],
  "capabilitiesLiveVerified": [],
  "observedAt": null,
  "metricAvailability": "not_collected",
  "observedResponseHash": null
}
```

`sourceAuthority:first_party`는 HTTP 성공·owner 인증과 별개다. 실제 익명 HTTP 응답에서
소개/도움말 본문이 확인됐을 때만 `public_document_observed`와 checkedAt/hash를 기록한다.
URL 후보만 찾았거나 login redirect뿐이면 `source_candidate`로 남긴다. 인증된 workspace의
캡처에는 계정 이름·채널 ID·메일·cookie·query token을 저장하지 않고 필요한 field 이름과
owner 일치 flag만 기록한다.

## 로그인·차단·legacy를 잘못 합치지 않기

200 login HTML은 비즈니스 결과가 아니다. 정상 login redirect는 도구 URL의 발견을 무효화하지
않지만 보호 조회 성공도 아니다. 401/403/429는 각각 관측한 상태로 남기고, 원인이 명확하지 않은
403을 Google·Cloudflare·계정 문제로 단정하지 않는다. CAPTCHA/robot gate를 만난 경로는 멈추고
동일 도구의 공식 공개 guide/API 계약을 별도로 확보한다. header/cookie/UA를 바꿔 접근 차단을
회피하는 recipe로 일반화하지 않는다.

구 Creator Studio가 새 Studio/Business Suite로 바뀌었으면 기존 URL·기능을 최신 이름으로 덮어
완료 처리하지 않는다. 공식 변경 공지의 근거와 `replacedBy`/`retired`를 기록하고 새 도구의 access
검증을 따로 한다. 서비스 종료된 API, analytics export, 콘텐츠 업로드, 예약 게시, 수익화 조건은
각각 적용 범위와 현재 구현 상태를 유지한다.

## 글감·성과 정보의 근거

공식 도구 목록과 가이드 본문은 creator resource inventory다. 트래픽·검색량·조회수·CTR·수익
데이터는 별도 API/계정 export가 있어야 한다. 수집하지 못한 수치를 0, 추정 rank, 가짜 성장률로
채우지 않는다. 글감 신호에는 canonical source, 실제 원문 제목, 기간/시각, 언어, 채널과 신호의
종류를 붙이며 플랫폼 전체 트렌드와 단일 계정 성과를 구별한다.

동일 공지가 여러 feed에 나와도 canonical article/observation을 기준으로 연결하고 원 feed
coverage를 보존한다. DB 저장이 완전히 확인된 observation만 다른 feed가 공유할 수 있다.
응답 성공·일부 upsert·같은 제목만으로 모든 source의 persisted를 true로 만들지 않는다.

UI 번역·국가 선택은 원 source의 시장·가격·통화·시각을 바꾸는 근거가 아니다. 한국 대상 상품을
영문 UI로 보여줘도 KRW·KST와 실제 제한 조건을 유지한다. 번역된 공식 guide URL은 언어별
지원 여부를 직접 확인하고, 번역된 제목을 원문 사실로 덮어쓰지 않는다.

외부 게시·업로드·DM은 resource 확보와 별도 쓰기 작업이다. 구현하려면 해당 서비스의
현행 actor-bound 계약, stable journal, 원본/공개 readback과 현재 사용자 지시 범위를 먼저 확인한다.
