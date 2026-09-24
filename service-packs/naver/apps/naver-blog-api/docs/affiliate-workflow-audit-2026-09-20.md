# 제휴 콘텐츠 E2E 워크플로우 감사 — 2026-09-20

## 결론

현재 시스템은 **도킹형 보조배터리 한 분야에서 검토 가능한 초안을 만드는 강한 프로토타입**이다.
하지만 임의의 주제와 상품군을 안정적으로 처리하는 범용 자율 운영 시스템은 아니다.

평가:

| 관점 | 점수 | 판단 |
|---|---:|---|
| 한정된 도메인 프로토타입 | 6.5 / 10 | 실제 데이터 수집·비교·초안·검토 패키지까지 연결됨 |
| 범용 제휴 콘텐츠 엔진 | 3 / 10 | 배터리 데이터·템플릿·품질 게이트에 강하게 고정됨 |
| 무인 자동 운영 준비도 | 2.5 / 10 | 성과 피드백, 경합 제어, 전체 계보, 정책 버전 관리가 부족함 |

가장 중요한 판단은 다음과 같다.

> `ready_for_review`는 잘 동작하지만, 현재의 `100점`은 콘텐츠의 진실성과 시장 성과를 증명하는 점수가 아니라 정해진 템플릿 조건을 모두 통과했다는 점수다.

## 확인한 실제 강점

### 1. 수집 경계가 비교적 명확하다

- 트렌드는 네이버 XHR/API-only와 Google RSS를 사용한다.
- 정상 트렌드 실행에서 브라우저를 쓰지 않는다.
- 네이버 레퍼런스와 커뮤니티는 공개 HTTP 자료를 이용한다.
- 쿠팡 인증값과 쿠키를 산출물에 저장하지 않는다.
- 자동 발행 권한은 별도로 남겨 둔다.

### 2. 결정론적 하드게이트와 Jev의 권한이 분리돼 있다

Jev는 후보 선택과 편집 조언에만 참여하며 다음을 소유하지 않는다.

- 로그인과 권한
- XHR 계약 성공 판정
- 가격 계산
- 광고 고지
- 게시 권한

이 권한 분리는 유지해야 한다.

### 3. 증거 산출물과 재개 지점이 존재한다

성공 실행에는 다음이 남는다.

- `state.json`
- 단계별 `receipts/`
- Jev shadow 기록
- 초안
- 비교 이미지
- 게시 검토 패키지

실패 단계도 상태에 남으므로 단순한 단일 스크립트보다는 운영하기 쉽다.

### 4. 실제 도킹형 보조배터리 실행은 한 번 끝까지 통과했다

성공 실행:

`workflow-runs/20260919T095453046Z-도킹형-보조배터리`

확인된 결과:

- 비교 제품 5개
- 공개 커뮤니티 문서 23개
- 네이버 레퍼런스 5개
- 4,130자 초안
- 비교 이미지
- 결정론적 품질 게이트 통과
- 자동 게시 미수행

## 사용자가 생각하지 못했을 가능성이 큰 핵심 결함

## P0 — 범용화를 막는 결함

### 1. 범용 인터페이스처럼 보이지만 실제로는 배터리 전용이다

기존 구현은 주제 인자를 자유롭게 받지만 다음이 모두 도킹형 보조배터리에 고정돼 있었다.

- 쿠팡 상품 비교 JSON
- 스피디 선택 제품
- 제휴 링크
- 초안 문구
- 품질 게이트의 정규식
- 차트 입력

그 결과 `행거 추천`을 요청해도 배터리 비교 데이터를 사용하려 했다.

이번 감사에서 **주제-상품 데이터 관련성 게이트**를 추가했고 실제 실행으로 다음 차단을 확인했다.

```text
PRODUCT_TOPIC_MISMATCH: topic=행거 추천 productQuery=도킹형 보조배터리
```

근본 해결은 상품군별 adapter다.

```text
TopicPlan
→ MerchantSearchAdapter
→ ProductNormalizer
→ ComparisonAxisRegistry
→ FormatSpecificDraftGenerator
→ DomainSpecificQualityGate
```

### 2. 의료·금융·법률 주제가 일반 제휴 글 흐름으로 들어갈 수 있었다

감기·몸살처럼 의료 성격이 있는 주제도 일반 상품 비교로 진행될 위험이 있었다.

이번 감사에서 정책 전처리를 추가했고 다음을 실제 확인했다.

```text
RISK_POLICY_BLOCK: medical_or_health
```

의료·금융·법률·규제 상품은 범용 워크플로우가 아니라 별도 출처 정책과 검토 절차가 있는 전용 흐름으로 보내야 한다.

### 3. 트렌드 캐시가 요청한 seed와 무관해도 재사용됐다

이전 `감기몸살` 실행은 배터리·신혼여행·행거 등이 들어 있는 오래된 `latest.json`을 그대로 사용했다.

이번에 다음을 추가했다.

- 최대 24시간 TTL
- 요청 seed 포함 여부 확인
- 조건 미충족 시 강제 갱신
- 그래도 seed가 없으면 실패
- 거대한 전체 캐시 대신 관련 seed만 receipt에 복사
- 원본 파일 SHA-256 기록

자동완성은 수요량이 아니며 쇼핑인사이트 순위도 절대 검색량이 아니다. 이 두 신호를 검색량처럼 표현해서는 안 된다.

### 4. 명시적 주제가 하나뿐이면 Jev Choice 검증이 실패했다

실제 실패:

```text
Choice topic must define at least two options
```

명시적 주제 하나는 선택 문제가 아니므로 이제 provider를 호출하지 않고 `deterministic_only`로 처리한다.

### 5. 상품 가격과 비교 자료에 강제 신선도 검사가 없었다

상품 가격·옵션·재고는 빠르게 바뀐다. 이제 상품 비교 데이터는 24시간 이내여야 하며, 넘으면 다음으로 차단된다.

```text
PRODUCT_DATA_STALE
```

남은 과제는 전체 파일 TTL이 아니라 **필드 단위 TTL**이다.

예:

| 필드 | 권장 TTL |
|---|---:|
| 가격·쿠폰·배송 | 발행 직전 또는 1시간 |
| 재고·옵션 | 발행 직전 |
| 공식 사양 | 30일 또는 모델 변경 시 |
| 커뮤니티 불만 | 30~90일 |
| 정책·제휴 고지 | 정책 버전 변경 시 |

## P0 — 사실성과 증거 문제

### 6. 커뮤니티 검색 결과는 합의가 아니다

현재 커뮤니티 레이더는 공개 검색 스니펫과 글 단위 신호를 이용한다. 다음 편향이 남는다.

- 같은 원문이 여러 검색어에 중복 노출
- 커뮤니티별 사용자 성향 차이
- 부정적인 제목이 검색에서 더 잘 보이는 편향
- 댓글 맥락과 반론 누락
- 오래된 모델과 현재 모델 혼재
- 광고성·체험단 게시물 혼입

따라서 `23개 문서`를 `23명의 독립된 구매자 의견` 또는 `커뮤니티 합의`로 표현하면 안 된다.

필요한 추가 필드:

```text
canonical_thread_id
platform
author_hash
published_at
product_model
purchase_verified
ad_or_sponsorship_signal
claim
counterclaim
context
independent_source_cluster
```

### 7. 상품명에 적힌 표현과 검증된 사양이 섞일 수 있다

현재는 상품명에서 `20W`, `10,000mAh`, `고속충전`을 추출한다. 이는 유용한 후보 신호지만 검증된 사실은 아니다.

각 주장에는 다음 상태가 필요하다.

```text
listing_claim
manufacturer_verified
official_certification_verified
independently_measured
community_reported
unknown
```

본문 문장마다 어떤 증거 상태인지 추적하는 `claim_evidence_ledger`가 필요하다.

### 8. 제휴 링크가 문법적으로 맞는 것과 수익 추적이 맞는 것은 다르다

현재 게이트는 링크 형식과 도메인을 확인한다. 하지만 다음은 별도 검증이 필요하다.

- 실제로 HTTP 리디렉션이 성공하는가
- 선택한 상품 또는 올바른 상품군으로 연결되는가
- 옵션·판매자가 비교표와 일치하는가
- 사용자 계정의 제휴 태그가 포함됐는가
- 모바일과 PC에서 같은 대상인가
- 품절 시 대체 페이지가 오해를 만들지 않는가

게시 직전에 `link_verification_receipt`를 새로 만들어야 한다.

### 9. 가격 비교가 동일 조건 비교인지 보장되지 않는다

표시 가격에는 다음이 섞일 수 있다.

- 1개와 1+1
- 옵션별 최저가
- 와우회원 가격
- 쿠폰 적용 가격
- 판매자별 가격
- 배송비 별도
- 색상·단자 옵션 차이

정규화 스키마에 최소한 다음이 필요하다.

```text
quantity
variant
seller
membership_required
coupon_required
shipping_krw
unit_price_krw
price_basis
checked_at
```

## P0 — 품질 게이트의 착시

### 10. 현재 100점은 쉽게 게임할 수 있다

품질 게이트는 다음과 같은 문자열·길이·개수 조건에 크게 의존한다.

- 특정 제목 표현
- 소제목 개수
- 표 존재 여부
- 특정 단어 존재
- 링크가 글 후반에 있는지

따라서 사실이 약한 글도 템플릿을 맞추면 100점을 받을 수 있다.

품질 게이트를 세 층으로 분리해야 한다.

```text
Layer 1: 형식·광고 고지·정책 하드게이트
Layer 2: 주장-출처 연결과 수치 검증
Layer 3: 독자 가치·문장 품질·차별성 평가
```

Jev나 LLM 평가는 3층에만 보조적으로 사용하고, 1·2층을 대신하면 안 된다.

## P1 — 운영과 재현성

### 11. resume은 완료 필드만 보고 입력과 코드가 같은지 확인하지 않는다

기존 resume은 receipt가 있고 간단한 validate 함수가 통과하면 재사용한다.

아직 필요한 것:

- workflow 코드 버전 hash
- 입력 seed·topic hash
- source artifact hash
- 상품 데이터 버전
- rubric 버전
- Jev 질문 계약 버전
- 템플릿 버전

하나라도 달라지면 해당 단계와 이후 단계를 무효화해야 한다.

이번 감사에서는 resume 시 seed/topic/Jev mode가 기존 요청과 충돌하면 차단하도록 우선 보강했다.

### 12. 공유 `latest.json`은 동시 실행에서 경합한다

두 실행이 동시에 돌면 다음이 서로 덮일 수 있다.

- 트렌드 `latest.json`
- 커뮤니티 `latest.json`
- 쿠팡 comparison reference
- topic brief

각 수집기는 처음부터 `runDirectory` 안의 출력 경로를 받아야 하며, `latest`는 편의를 위한 포인터만 돼야 한다.

### 13. 전체 네트워크·비용·시간 예산이 없다

개별 프로세스 timeout은 있지만 전체 run budget이 없다.

필요한 예산:

```text
max_http_requests
max_external_bytes
max_elapsed_seconds
max_provider_cost
max_jev_calls
max_browser_sessions
```

### 14. Git 상태가 지나치게 더럽고 롤백 기준선이 없다

현재 저장소에는 대량의 수정·미추적 파일이 있고, 최신 워크플로우를 대표하는 깨끗한 commit/tag가 없다.

필요한 기준선:

```text
affiliate-content-e2e-v0.1
├─ commit SHA
├─ package-lock hash
├─ rubric version
├─ source contracts version
└─ test receipt
```

## P1 — 사업 운영에서 빠진 것

### 15. 글을 잘 쓰는 루프는 있지만 돈을 버는 학습 루프가 없다

현재는 `트렌드 → 글`까지만 강하다. 다음 데이터를 회수해야 실제 사업 시스템이 된다.

```text
impressions
search_rank
clicks
affiliate_clicks
orders
commission_krw
epc
conversion_rate
revenue_per_post
revenue_per_1000_impressions
time_to_first_click
content_decay
```

상품 선택 점수는 예상 커미션율이 아니라 실제 EPC와 전환 데이터를 학습해야 한다.

### 16. 콘텐츠 중복과 검색어 잠식 검사가 없다

다음 글을 계속 만들면 서로 같은 검색어를 경쟁할 수 있다.

- 도킹형 보조배터리 추천
- 미니 보조배터리 추천
- 5,000mAh 보조배터리 추천
- 스피디 보조배터리 후기

발행 전 다음을 계산해야 한다.

```text
existing_post_similarity
primary_keyword_collision
search_intent_overlap
recommended_action = create | update | merge | skip
```

### 17. 업데이트·삭제 전략이 없다

가격과 재고가 바뀌는 제휴 글은 한 번 발행하고 끝낼 수 없다.

필요한 운영 상태:

```text
fresh
price_stale
inventory_stale
policy_stale
traffic_declining
link_broken
update_due
retire_candidate
```

## P1 — 시각 자료와 권리

### 18. 차트 하나는 이미지 전략이 아니다

실제 네이버 상위글은 이미지 리듬이 강하다. 그러나 판매자 이미지를 무단 복제하면 권리 문제가 생긴다.

이미지 소스별 정책이 필요하다.

```text
user_owned_photo
generated_infographic
official_media_with_permission
affiliate_feed_asset
quotation_thumbnail_with_policy
disallowed_unknown_source
```

각 이미지에는 다음을 남긴다.

```text
source
license_or_permission
generated_prompt_or_original_file
alt_text
caption
product_variant
```

## Jev 평가

## Jev가 잘 맞는 지점

1. **커뮤니티 관련성 Noul**
   - 제품을 언급만 한 글인지, 실제 구매 판단 이슈인지 분류
2. **주장-근거 일치 Choice**
   - supports / contradicts / not_addressed
3. **검색 의도와 포맷 Choice**
   - 비교형 / 문제 해결형 / 의견 분석형
4. **기존 글 중복 Noul**
   - 별도 글이 필요한지 기존 글을 업데이트해야 하는지
5. **편집 우선순위 Score**
   - 초안에서 사람이 먼저 고칠 구간 순위화

## Jev가 맡으면 안 되는 지점

- 사실 여부
- 가격 계산
- HTTP 성공
- 규제 주제 허용
- 링크 대상 검증
- 광고 고지
- 게시 권한
- 재시도와 멱등성

## Jev 활성화 전 필요한 평가

현재 실제 provider 키가 없어 성공 실행에서도 `provider_unavailable`이며 결정론적 fallback이 사용됐다.

active 전 최소 요건:

- 질문 유형별 100개 이상의 라벨 예제
- confidence 구간별 정확도
- fallback 대비 개선율
- 오류 비용이 높은 클래스의 false positive 측정
- 모델·질문 계약 버전 고정
- provider timeout·429·schema drift 테스트
- prompt injection이 포함된 커뮤니티 텍스트 adversarial test

## 스킬 탐색 결과

## 바로 적용할 기존 스킬

### 1. `evidence-learning`

가장 우선순위가 높다.

적용 위치:

- 단계별 artifact를 Experience 후보로 정규화
- 주장·결정·결과·거절 사유를 구조화
- 발행 후 성과를 같은 experience에 연결
- 반복적으로 성과가 난 패턴만 승인된 팀 지식으로 승격
- 실패와 인간 수정도 학습 신호로 저장

추천 Experience 구조:

```text
topic
search_intent
evidence_artifacts
claims
decisions
human_edits
publication
traffic_outcomes
affiliate_outcomes
failure_labels
confidence
```

### 2. `xhr-to-api-only`

현재 트렌드·쿠팡 탐색 방식에 계속 사용한다.

모든 소스는 다음 승격 상태를 가져야 한다.

```text
captured
client_exists
remnant_free
credential_propagated
live_replay
```

### 3. `jev-decision-supervisor`

Jev의 shadow/active 경계와 영수증 계약을 유지한다. 단, active 전 라벨 평가를 필수화한다.

### 4. `baoyu-infographic` / `baoyu-article-illustrator`

판매자 이미지를 무단 재사용하지 않고 다음을 만드는 데 사용한다.

- 비교표 인포그래픽
- 선택 트리
- 가격·용량·출력 비교 카드
- 구매 전 체크리스트
- 사용 상황 다이어그램

### 5. `tistory-api-only`

네이버 흐름이 안정된 뒤 동일한 content object를 티스토리 draft로 변환하는 멀티채널 adapter로 사용한다.

## 검토 후 도입할 외부 스킬 후보

`npx skills find`와 로컬 skill catalog에서 다음 후보를 찾았다. 외부 스킬은 감사되지 않았으므로 설치 전에 소스와 권한을 검토하고 commit을 고정해야 한다.

| 목적 | 후보 | 활용 지점 |
|---|---|---|
| 콘텐츠 전략 | `kostja94/marketing-skills@content-strategy` | topic cluster, persona, funnel mapping |
| SEO 감사 | `kostja94/marketing-skills@seo-audit` | 발행 전 검색 의도·구조·중복 검사 |
| 콘텐츠 공백 | `rampstackco/claude-skills@seo-content-gap-audit` | 경쟁글이 답하지 않는 질문 추출 |
| 주장 조사 | `jwynia/agent-skills@claim-investigation` | claim-evidence ledger와 반증 탐색 |
| 팩트체크 | `elvisun/newsjack@fact-check` | 변동·기술 주장 검증 절차 |
| 실험 분석 | `rampstackco/claude-skills@experimentation-analytics` | 제목·CTA·포맷 실험과 성과 판정 |
| 실험 설계 | `k-dense-ai/scientific-agent-skills@experimental-design` | A/B 테스트와 중단 기준 |
| 위협 모델 | `google/mantis@mantis-threat-model` | 쿠키·브라우저·게시 권한·공급망 분석 |

설치 순서는 다음이 적절하다.

1. claim investigation
2. SEO/content gap
3. experimentation analytics
4. threat model

콘텐츠 전략은 현재 자체 구현과 겹치는 부분이 많으므로 먼저 gap review만 한다.

## 이번 감사에서 즉시 보강한 것

- 의료·금융·법률·규제 상품 위험 주제 차단
- 요청 seed 없는 오래된 트렌드 캐시 재사용 차단
- 트렌드와 상품 데이터 24시간 TTL
- 트렌드 원본 SHA-256 기록
- run receipt의 트렌드 데이터 축소
- 주제와 쿠팡 상품군 불일치 차단
- 단일 Choice를 provider 없이 결정론적으로 처리
- resume seed/topic/Jev mode 충돌 차단
- 제휴 링크를 하드코딩하지 않고 선택 상품 증거에서 읽음
- 상품 비교·브리프·선택 파일 digest 기록
- 관련 회귀 테스트 추가

실제 검증:

```text
Node 테스트: 100개 통과 / 실패 0
문법 검사: 통과
Git whitespace 검사: 통과
의료 주제 실제 차단: 통과
행거 주제와 배터리 상품 불일치 실제 차단: 통과
```

비밀번호 문자열도 프로젝트·Affiliate Hub·COS 데이터 폴더에서 검색했으며 저장된 사본은 발견되지 않았다.
다만 비밀번호가 채팅에 노출됐으므로 계정 비밀번호 자체는 교체해야 한다.

## 다음 구현 순서

### P0

1. `ProductProviderRegistry`와 상품군별 adapter
2. `claim_evidence_ledger`
3. 발행 직전 가격·옵션·링크 재검증
4. 필드 단위 freshness와 source provenance
5. run별 출력 경로와 동시 실행 lock
6. 코드·입력·rubric·template fingerprint 기반 resume 무효화

### P1

7. 커뮤니티 중복 제거·플랫폼 다양성·광고성 탐지
8. 기존 게시물 중복·잠식 검사
9. 이미지 권리·alt text·mobile preview gate
10. 클릭·주문·커미션 측정과 Experience 학습 루프

### P2

11. Tistory 등 멀티채널 adapter
12. 제목·CTA 실험
13. Jev shadow 라벨 평가 후 일부 active 전환
14. 자동 업데이트·링크 오류·콘텐츠 폐기 감시

## 다음 E2E 완료 정의

범용 워크플로우라고 부르려면 최소 세 개의 서로 다른 상품군에서 다음을 통과해야 한다.

```text
도킹형 보조배터리
행거·수납
여행용 멀티어댑터
```

각 상품군마다:

- 현재 트렌드 seed 일치
- 해당 상품군의 라이브 상품 4개 이상
- 공식 사양 출처
- 커뮤니티 독립 source cluster 3개 이상
- claim-source 연결률 100%
- 가격·링크 발행 직전 검증
- 모바일 렌더 검수
- 인간 승인
- 발행 후 클릭·전환 회수

를 만족해야 한다.
