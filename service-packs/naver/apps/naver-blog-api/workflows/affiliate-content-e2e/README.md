# Affiliate Content E2E Workflow

트렌드 신호에서 시작해 네이버 레퍼런스, 공개 커뮤니티 이슈, 쿠팡 다제품 비교를 합쳐
검토 가능한 네이버 블로그 초안과 증거 묶음을 만드는 워크플로우다.

현재 구현은 **도킹형 보조배터리 상품군에 특화된 프로토타입**이다. 자유로운 `--seed`와 `--topic`을
받지만, 관련 상품 adapter가 없는 주제는 `PRODUCT_TOPIC_MISMATCH`로 차단한다. 의료·금융·법률·규제
상품 주제는 일반 제휴 워크플로우에서 처리하지 않는다.

이 워크플로우는 **게시하지 않는다.** 마지막 상태는 `ready_for_review`이며 실제 발행은 별도 승인과
게시 도구 단계로 분리한다.

## 실행

```powershell
cd <repo>\apps\naver-blog-api

npm run workflow:affiliate-content -- `
  --seed="도킹형 보조배터리" `
  --topic="도킹형 보조배터리 추천" `
  --jev-mode=shadow
```

최신 트렌드를 다시 읽으려면:

```powershell
npm run workflow:affiliate-content -- `
  --seed="도킹형 보조배터리" `
  --refresh-trends `
  --jev-mode=shadow
```

쿠팡 상품 검색도 갱신하려면 로그인된 쿠팡 파트너스 Chrome을 열어 둔 뒤
`--refresh-products`를 추가한다.

중단된 실행은 다음처럼 재개한다.

```powershell
npm run workflow:affiliate-content -- --resume=<run-id>
```

## 단계와 완료 계약

| 단계 | 완료 조건 | 실행 방식 |
|---|---|---|
| Policy | 일반 제휴 범위이며 고위험 주제가 아님 | 결정론적 정책 게이트 |
| Trend radar | seed 후보 존재, 일반 실행 브라우저 0 | Naver XHR/API-only + Google RSS |
| Topic selection | 허용 후보 중 하나 | 결정론적 점수 + Jev shadow/active |
| Naver reference | 공개 상위 글 5개 이상 분석 | HTTP GET |
| Community radar | 공개 카페 검색 6개 이상 성공 | Naver 검색 HTTP, 로그인 없음 |
| Product comparison | 비교 제품 4개 이상, 실행 계약 0 | 쿠팡 파트너스 증거 카탈로그 |
| Claim-evidence | Claim 출처·만료·불확실성 검증 | 결정론적 원장 게이트 |
| Format selection | 허용 포맷 3개 중 하나 | 결정론적 규칙 + Jev shadow/active |
| Draft | 1,800자 이상, 제품 4개 이상 | 결정론적 템플릿 |
| Chart | PNG 생성 확인 | Python/Matplotlib |
| Quality gate | 점수와 hard block 계산 | 결정론적 하드게이트 |
| Publish package | `publishAuthorized=false` | 검토 패키지만 생성 |

프로세스 exit code가 0인 것만으로 단계 완료로 보지 않는다. 각 단계의 receipt가 의미론적 완료 조건을
통과해야 `state.json`에서 `completed`가 된다.

각 완료 receipt는 같은 이름의 `gates/<stage>.json`과 fingerprint가 일치해야 재개 시 재사용된다.
기계적 게이트 전체 목록은 `docs/mechanical-gates-2026-09-20.md`를 참고한다.

## 산출물

```text
workflow-runs/<run-id>/
├─ state.json
├─ summary.md
├─ draft.md
├─ draft.json
├─ claim-evidence-ledger.json
├─ publish-package.json
├─ assets/
│  └─ product-price-comparison.png
├─ receipts/
│  ├─ 01-trends.json
│  ├─ ...
│  └─ 09-quality-gate.json
├─ gates/
│  ├─ 00-policy.json
│  ├─ ...
│  ├─ 09-quality-gate.json
│  ├─ publish-package.json
│  └─ run-validation.json
└─ jev/
   ├─ 01-topic-selection.json
   ├─ 02-format-selection.json
   └─ 03-editorial-assessment.json
```

## Jev 운용 모드

```text
off     Jev 호출 없음
shadow  Jev 판단을 기록하지만 제어 흐름은 항상 결정론적 fallback
active  confidence threshold를 넘은 허용 응답만 채택
```

기본값은 `shadow`다.

TypeSafe 직접 API를 쓰려면 로컬 환경에 `TYPESAFE_API_KEY`를 넣는다. 키는 로그·receipt·Git에
기록하지 않는다.

```powershell
$env:TYPESAFE_API_KEY = '<local-secret>'
$env:JEV_MODE = 'shadow'
$env:JEV_MIN_CONFIDENCE = '0.82'
```

충분한 라벨 데이터로 shadow 결과를 평가하기 전에는 `active`로 전환하지 않는다.

## Jev가 맡는 판단

1. **주제 선택 Choice**
   - 트렌드 레이더가 만든 허용 후보 안에서만 선택한다.
   - 검색 의도와 상업적 유용성을 의미적으로 판단한다.
2. **콘텐츠 포맷 Choice**
   - `multi_product_comparison`, `problem_solution`, `community_consensus` 중 선택한다.
3. **증거 충분성 Noul**
   - 직접 사용하지 않은 글이 실측인 척하지 않으면서 작성 가능한지 판단한다.
4. **편집 완성도 Score**
   - 구조와 증거가 검토 가능한 수준인지 4단계로 평가한다.
5. **다음 행동 Choice**
   - `ready_for_review`, `gather_more_evidence`, `revise_draft`, `stop` 중 조언한다.

## Jev가 맡지 않는 것

- 로그인·권한·쿠키·세션 상태
- XHR 계약 발견과 HTTP 성공 판정
- 가격 계산, 순위 계산, 날짜 비교, 제품 수 세기
- 상품 사양이 사실인지 여부
- 광고 고지, 링크 유효성, 안전 정책 hard block
- 자동 게시 권한
- 재시도가 중복 게시를 만들지 않는지 여부

이 항목들은 코드와 하드게이트가 유일한 권한이다. Jev가 반대 답을 내도 override하지 않는다.

## 활성화 전 평가

shadow receipt에서 다음을 모은다.

- 결정론적 정답과 Jev 선택의 일치율
- confidence 구간별 정확도
- `other` 또는 낮은 confidence 비율
- 잘못 채택했을 때의 비용
- 주제·포맷·다음 행동별 별도 threshold

최소한의 라벨 세트 없이 confidence가 높다는 이유만으로 active로 전환하지 않는다.

## 감사 결과

현재 성숙도와 범용화 전 남은 결함은 다음 문서에 정리돼 있다.

- `docs/affiliate-workflow-audit-2026-09-20.md`
- `docs/affiliate-workflow-audit-2026-09-20.json`
