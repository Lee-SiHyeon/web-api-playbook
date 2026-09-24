# 마이리얼트립 어필리에이트 HTTP 클라이언트

2026-09-21 집 Windows에서 **10개 업무 API를 독립 Node HTTP 실행으로 검증했다.** 일반 상품 링크와 왕복 항공 링크를 생성하고, 단축 주소의 목적지 및 `mylink_id`가 생성 응답과 일치하는지 확인했다. 브라우저는 초기 인증과 계약 관측에 사용했으며, 정상 업무 요청은 브라우저를 호출하지 않는다.

| 기능 | 명령 | 검증 범위 |
|---|---|---|
| 일반 상품 링크 | `createLink` | `www.myrealtrip.com/offers/<숫자>` → 단축 링크, 목적지·링크 ID 일치 |
| 항공 링크 | `createFlightLink` | 항공 검색 주소 생성 → 단축 링크, 여정·인원·항공사·링크 ID 일치 |
| 공항 검색 | `searchAirports` | 도쿄 검색, 3개 공항·도시 결과 |
| 항공사 검색 | `searchAirlines` | 대한 검색, 대한항공 결과 |
| 일반 예약 | `reservations` | 여행 종료일 기준, 전체 상태, 페이지당 15건; 현재 기간 0건 |
| 항공 예약 | `flightReservations` | 기간 조회, 현재 0건 |
| 일반 수익 | `sales`, `salesSummary` | 일별 목록 건수와 6개 숫자 집계; 현재 0건·0원 |
| 항공 수익 | `flightSales`, `flightSalesSummary` | 일별 목록 건수와 6개 숫자 집계; 현재 0건·0원 |

`createFlightLink`는 `createFlightLanding`과 `createLink` 두 API를 조합한다. 10개는 고유 API 수이며, 실제 생성 과정에서 단축 링크 API를 일반·항공에 각각 사용했다. 계정 조회와 단축 링크 리다이렉트 검증은 이 수에 포함하지 않았다.

## 실행

- 클라이언트: [myrealtrip-marketing.mjs](../adapters/myrealtrip-marketing.mjs)
- stdin 실행기: [myrealtrip.mjs](../scripts/myrealtrip.mjs)
- 메모리 전달: [partner-session-handoff.mjs](../tools/discovery/partner-session-handoff.mjs)의 `runMyrealtrip`
- [관측 계약](../references/myrealtrip-marketing-contracts.json), [인증된 HTTP 실호출 기록](../references/myrealtrip-marketing-replay-2026-09-21.json)

```text
node apps/affiliate-api-hub/scripts/myrealtrip.mjs
```

stdin은 다음 구조다. 아래 인증값은 형식 설명용 placeholder다. 실제 값은 지원되는 현재 출처 세션 제공자가 메모리에서 전달하며 파일·명령 인수·로그에 저장하지 않는다.

```json
{
  "schemaVersion": 1,
  "acquiredAt": "<provider handoff ISO timestamp>",
  "session": {
    "token": "<in-memory token>",
    "expectedPartnerId": 123,
    "expectedEmail": "fixture@example.com"
  },
  "operation": "createLink",
  "input": { "targetUrl": "https://www.myrealtrip.com/offers/174730" }
}
```

5분은 전달 시각에 대한 로컬 제한이며 서버의 토큰 수명이 아니다. 매 실행은 고정된 계정 조회에서 파트너 ID·이메일 일치를 확인한 뒤 업무 API를 호출한다. HTTP 클라이언트를 직접 사용하는 프로세스는 `createMyrealtripClient(session)`으로 계정을 검증한 후 같은 메모리 세션에서 `execute(operation, input)`을 호출하고 마지막에 `close()`한다.

항공 링크 입력 예시는 다음과 같다. 실제 예약을 만들거나 결제하지 않으며, 지정한 조건의 검색·홍보 주소를 생성한다.

```json
{
  "depAirportCd": "SEL",
  "arrAirportCd": "NRT",
  "airline": "KE",
  "depDate": "2026-10-16",
  "arrDate": "2026-10-19",
  "tripTypeCd": "RT",
  "adult": 1,
  "child": 0,
  "infant": 0,
  "cabinClass": "ECONOMY"
}
```

검색 입력은 `{ "keyword": "도쿄" }` 또는 `{ "keyword": "대한" }`이다. 예약 조회는 `startDate`, `endDate`와 일반 예약의 선택적 `page`를, 수익 조회는 `fromDate`, `toDate`를 받는다. 날짜는 실제 달력 날짜여야 하며 최대 366일 범위를 허용한다. 이 범위는 클라이언트 정책이다.

결과의 `ok`는 업무 API 응답의 성공 여부다. 링크의 `verification.verified`는 별도 목적지 검증 결과이므로 함께 확인해야 한다. 링크 생성 성공 후 목적지 확인이 실패해도 생성된 링크를 보존하고 재생성하지 않는다. 목적지 확인에는 파트너 인증을 보내지 않고, 관측된 `www.myrealtrip.com/main/bridge/marketing`의 `return_url`까지만 검사한다.

## 오류와 재개

- `REAUTH_REQUIRED`: 인증을 갱신한 뒤 계정부터 검증한다. 자동 로그인이나 숨겨진 브라우저 대체 경로는 없다.
- `FORBIDDEN`, `THROTTLED`, `SERVICE_STATUS`: 서버의 명시적 거부·오류로 분류한다.
- `WRITE_OUTCOME_UNKNOWN`: POST 전송 뒤 응답 유실·형식 불일치 또는 자식 실행기 단절로 성공 여부를 확정하지 못했다. 자동 재시도하지 않는다.
- 항공 주소 생성이 완료되고 단축 단계가 실패하면 `completedStep`과 `resumeTargetUrl`을 반환한다. 전체 항공 생성 절차를 다시 실행하지 않는다. 단축 요청 자체의 결과가 불명확하면 먼저 검토한다.
- `SESSION_CLOSED`, 잘못된 날짜·호스트·필드·미관측 명령은 로컬에서 거부한다.

실호출 중 만료된 토큰은 계정 조회에서 거부됐다. 공식 화면의 자동 갱신 후 새로 전달해 성공했다. 브라우저 갱신 요청의 존재와 독립 HTTP 자동 갱신 구현은 구분한다. 첫 항공 시도는 숫자형 `gid`에 과도한 양수 제약을 둔 검증기가 거부했다. 그 요청은 재시도하지 않고 관측된 숫자형 계약으로 수정한 다음, 다른 일정으로 전체 과정을 검증했다. 실패 기록도 실호출 기록에 남겼다.

## 남은 범위

예약·일별 수익의 실제 목록은 현재 비어 있으므로 개별 행 스키마를 검증하지 못했다. 클라이언트는 건수·페이지 정보와 숫자 집계를 반환하며 미확인 행 원문은 내보내지 않는다. 일반 상품은 위 상품 URL 유형, 항공은 실제 관측한 왕복·일반석만 지원한다. 다른 상품 호스트·경로, 편도·다구간·좌석 등급은 추가 관측이 필요하다.

수익금 지급 내역은 공식 UI가 신분증·은행정보 입력을 먼저 요구했다. 계좌·신분증 제출, 지급·세금 조회, 내보내기, API 키 발급은 구현하지 않았다. 자동 HTTP 토큰 갱신과 장기 무인 실행도 검증하지 않았다.

`captured`, `client_exists`, `credential_propagated`, `live_replay`는 10개 API별로 기록했다. `remnant_free`는 정상 HTTP 업무 실행에 한정되며 초기 인증 취득까지 브라우저 없이 된다는 뜻이 아니다. 관련 회귀 검증은 실제 네트워크 증거와 별도로 계정 불일치, 요청 범위, 응답 크기·형식, 개인정보 비노출, 불확실한 POST와 단계별 재개, 단축 링크 목적지·ID 불일치를 검사한다.
