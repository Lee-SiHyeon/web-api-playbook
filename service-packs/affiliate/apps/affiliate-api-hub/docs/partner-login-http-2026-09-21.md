# 마이리얼트립 · 브랜드커넥트 로그인과 HTTP 연결

**두 사이트 모두 현재 계정을 독립 Node HTTP 실행기에서 검증했다.** 초기 인증은 기존 Chrome Canary 프로필을 사용했고, 계정 조회는 브라우저 밖에서 실행했다. 비밀번호·쿠키·토큰과 원본 계정 응답은 저장하지 않았다.

| 서비스 | 독립 HTTP 검증 | 확인 범위 |
|---|---|---|
| 마이리얼트립 | `GET /partner/v1/partners`, HTTP 200, `result.status=200` | 의도한 파트너 ID와 이메일 일치 |
| 브랜드커넥트 | `GET /brand-connect/query/me`, HTTP 200 | 의도한 네이버 로그인 ID 일치, `creator=true`, `partner=false`, 계정 할당 확인 |

검증 시각과 개인정보를 제외한 결과는 [실호출 기록](../references/partner-account-replay-2026-09-21.json), 계약과 범위는 [계정 조회 계약](../references/partner-account-contracts.json)에 있다. 마이리얼트립은 브라우저 요청·응답에서, 브랜드커넥트는 공개 클라이언트 소스와 익명 응답에서 경로를 확인한 뒤 인증된 HTTP 응답을 검증했다.

## 재현 경로

1. 실행 호스트와 현재 브라우저 목록을 확인한다. 일반 Chrome과 Canary는 도구에 모두 `Chrome`으로 표시될 수 있다. 이름이나 과거 PID 대신 실제 확장 인스턴스를 선택한다. 일반 Chrome 재시작은 별도 Canary 프로필의 복구가 아니다.
2. 선택한 브라우저에 해당 사이트의 정상 HTTPS 페이지를 연다. 빈 탭에서 CDP 연결을 시작하지 않는다. 필요한 경우 공식 ID·비밀번호 로그인을 사용한다.
3. 지원되는 현재 사이트 CDP 기능으로 관측된 마이리얼트립 요청 헤더 또는 브랜드커넥트 현재 출처의 쿠키만 메모리에서 취득한다. 자격증명 저장소·프로필 DB를 읽지 않는다.
4. `tools/discovery/partner-session-handoff.mjs`의 `runPartnerProbe`로 아래 실행기에 JSON을 stdin 전달한다. CUA에서는 명시적 Node 실행 파일과 최소 환경을 제공했다. `shell:false`, `windowsHide:true`, 시간·출력 제한과 인증값 출력 차단을 적용한다.
5. 각 사이트의 계정 일치를 검증한 결과만 반환하고, 전달한 값의 참조를 해제한다. 초기 전달 이후 계정 HTTP 코드는 브라우저를 가져오거나 조작하지 않는다.

```text
node apps/affiliate-api-hub/scripts/partner-session-probe.mjs
```

stdin 입력은 `schemaVersion: 1`, 세션 취득 시각 `acquiredAt`, `services`를 가진 JSON이다. `services.myrealtrip`은 `token`, `expectedPartnerId`, `expectedEmail`을, `services.brandconnect`는 현재 관측한 쿠키 객체 배열 `cookies`와 `expectedLoginId`를 받는다. 비밀값을 명령 인수·로그·파일로 넘기지 않는다. 두 서비스는 독립적으로 실행·판정한다. 5분의 전달 유효시간은 클라이언트 제한이며 서버 세션 수명이 아니다.

`adapters/partner-account-probes.mjs`는 두 개의 고정 GET만 구현한다. 리다이렉트, 로그인 HTML, 과대 응답, 서비스 오류와 다른 계정을 거부한다. Naver 인증은 목적지 도메인·경로·만료를 검사하고 필수 `NID_AUT`, `NID_SES`와 선택적 `NID_JKL`만 사용한다. HTTP 200이어도 `loginId=null`이면 익명으로 판정한다.

## 검증과 남은 범위

실제 stdin 자식의 입력 검사와 별도로, 모의 검증은 계정 불일치, 무인증 HTTP 200, 쿠키 범위·만료·중복, 헤더 삽입, 리다이렉트·HTML·응답 크기, 원문 오류 비노출, 서비스별 독립 결과, 자식 환경의 비밀값 격리와 출력 차단을 확인한다. 모의 결과와 위 두 실제 인증 조회를 구분한다.

계정 조회의 `client_exists`, `credential_propagated`, `live_replay`는 참이다. `remnant_free`는 HTTP 조회 단계에 한정된다. 초기 인증 취득에는 브라우저가 필요했고 자동 로그인 갱신·장기 무인 운영은 검증하지 않았다.

후속 작업에서 마이리얼트립 링크 생성·검색·예약·수익 조회 10개 API를 구현하고 독립 HTTP로 검증했다. [업무 클라이언트와 범위](myrealtrip-api-only-2026-09-21.md)에 별도로 기록한다. 앞서 자동 발생한 `POST /partner/v1/marketing/announcements`는 업무 실행기에 포함하지 않았다. 계좌·신분증·설정 변경도 수행하지 않았다.
