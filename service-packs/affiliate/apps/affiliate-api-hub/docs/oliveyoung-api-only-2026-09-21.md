# 올리브영 쇼핑 큐레이터 API-only 링크 클라이언트

2026-09-21, 집 Windows `DESKTOP-TO2H6OD`에서 작성했습니다. 공개된 공식 링크 API 문서는 확인되지 않아 공식 사이트가 배포한 JavaScript의 요청 형식을 구현했습니다. **코드는 구현됐지만 로그인한 계정의 실제 링크 발급은 아직 검증하지 못했습니다.**

현재 근거는 공식 웹 소스, 브라우저의 익명 로그인 갱신 요청, 독립 Node HTTP의 403 응답입니다. 소스 발견·요청 캡처·인증정보 전달·실제 재실행을 별도로 기록한 [계약 목록](../references/oliveyoung-curator-contracts.json)을 참조하세요.

## 구현한 기능

| 명령 | 동작 |
| --- | --- |
| `status` | 큐레이터 가입 및 교육 이수 상태 확인 |
| `ranking` | 링크 발급 화면의 상품 랭킹 조회 |
| `search` | 키워드로 상품과 분류번호 조회 |
| `generated` | 기존 상품 및 발급 활동 ID 조회 |
| `createLink` | 기존 활동 ID 재사용 또는 신규 발급 → 공식 단축 URL 생성 → 원본 URL 일치 확인 |
| `completeLink` | 단축 단계 실패 후 기존 활동 ID로 이어서 처리 |

실행부는 `adapters/oliveyoung-curator.mjs`와 `scripts/oliveyoung.mjs`입니다. 브라우저, DOM, Playwright, CDP 의존성 없이 Node 내장 `fetch`와 `crypto`만 사용합니다. 브라우저 캡처와 세션 전달은 `tools/discovery/`에 분리했습니다.

가입, 약관·교육 동의, 정산, 외부 게시 기능은 구현하지 않았습니다. 다이소는 확인된 제휴 링크 발급 경로가 없어 이 클라이언트에 포함하지 않았습니다.

## 실행

저장소 루트에서 아래 명령을 실행할 수 있습니다. JSON은 stdin으로만 받으며 토큰을 명령줄, 파일, 환경변수, 로그에 넣지 않습니다.

```powershell
node apps/affiliate-api-hub/scripts/oliveyoung.mjs
# 또는 npm run oliveyoung -w @affiliate-content-operations/affiliate-api-hub
```

실제 호출은 세션을 이미 보유한 프로세스에서 하는 편이 안전합니다.

```js
import { runOliveyoung } from './apps/affiliate-api-hub/tools/discovery/oliveyoung-session-handoff.mjs';

// session은 아래 설명에 따라 현재 올리브영 세션에서 메모리로만 전달합니다.
const status = await runOliveyoung({ operation: 'status', session });
const products = await runOliveyoung({ operation: 'search', session,
  input: { keyword: '선크림', pageNumber: 0, pageSize: 10 } });

// 조회 응답에서 사용자가 고른 상품의 실제 번호를 사용합니다.
const result = await runOliveyoung({ operation: 'createLink', session,
  input: { goodsNumber: selected.goods.goodsNumber,
    categoryNumber: selected.goods.displayCategory.leafCategoryNumber } });
```

`goodsNumber` 대신 `productUrl`을 입력할 수도 있습니다. 모바일·PC 올리브영의 상품 상세 URL에서 `goodsNo`만 읽으며, 입력 URL로 직접 요청하지 않습니다. 분류번호는 실제 검색 응답에서 가져옵니다.

`createLink`는 기존 내역을 10개씩 최대 20페이지 확인합니다. 확인하지 못한 페이지가 남으면 `HISTORY_INCOMPLETE`로 멈추며 새 활동 ID를 만들지 않습니다. 같은 상품을 찾으면 기존 ID를 재사용합니다. 동시 실행 간 잠금이나 서버의 멱등성 보장은 확인되지 않았으므로 **한 계정에서 쓰기 명령은 순서대로 실행하세요.**

`completeLink` 입력은 `{ goodsNumber, affiliateActivityId }`입니다. 서버의 내 발급 목록에서 해당 ID를 재확인한 뒤 단축 단계만 실행합니다. 이때 제휴 활동을 새로 발급하지 않습니다.

## 세션 전달과 갱신

1. Chrome에서 올리브영 로그인과 큐레이터 이용 준비를 완료합니다. 현재 작업에서는 로그인 폼까지 열었으며 가입·동의를 대신 수행하지 않았습니다.
2. 정상 링크 발급 화면에서 지원되는 CDP `Network` 캡처로 요청의 `Authorization`, `User-Agent`, 선택적인 `X-OY-GW`를 관찰합니다. 토큰 값은 출력하지 않습니다.
3. `Network.getCookies`의 `urls`를 다음 두 경로로 제한합니다.
   - `https://m.oliveyoung.co.kr/review/api/affiliate/v1/education/status`
   - `https://m.oliveyoung.co.kr/m/login/additionalInfo.do`
4. `sessionFromCapture({ cookies, headers })`는 올리브영 도메인의 `OYSESSIONID`, `linkageString`, `__cf_bm`, `_cfuvid`만 선택합니다. 분석·광고 쿠키를 제외합니다. 새로 필요한 쿠키는 정상 요청 근거를 확인한 뒤 허용 목록을 갱신합니다.
5. `runOliveyoung`은 이를 자식 프로세스 stdin으로 전달합니다. 자식은 기본 Windows 실행 변수만 상속하며 응답에 세션 값이 섞이면 출력을 차단합니다.

`Authorization`은 웹 클라이언트가 사용하는 원래 토큰이며 `Bearer `를 임의로 붙이지 않습니다. 토큰 없이 세션 쿠키만 전달하면 관찰한 `/m/login/additionalInfo.do`를 한 번 호출하고, 공식 소스의 방식으로 `linkageString`을 메모리에서 해석합니다. 빈 값이면 `AUTH_REQUIRED`입니다. 토큰 만료나 재인증 요구가 발생하면 새로운 정상 세션을 전달해야 합니다. 무기한 자동 로그인은 구현하거나 검증하지 않았습니다.

## 실패 시 동작

| 결과 | 의미 및 후속 처리 |
| --- | --- |
| `AUTH_REQUIRED` | 로그인 또는 새 세션 필요 |
| `ACCESS_BLOCKED` | HTTP 403. 로그인 성공으로 판단하지 않으며 자동 우회하지 않음 |
| `CURATOR_ENROLLMENT_REQUIRED` / `CURATOR_EDUCATION_REQUIRED` | 사용자가 공식 화면에서 준비 필요 |
| `HTML_RESPONSE` / `REDIRECT_BLOCKED` | API JSON 대신 웹 문서·리디렉션 반환. 인증 성공으로 처리하지 않음 |
| `WRITE_OUTCOME_UNKNOWN` | 발급 요청 결과 불명. 재발급 전에 `generated`로 확인 |
| `LINK_INCOMPLETE` | 활동 ID는 확보됐으나 단축 또는 검증 실패. 반환된 활동 ID로 `completeLink` 사용 |
| `HISTORY_INCOMPLETE` / `RESPONSE_PAGINATION` | 기존 발급 내역 확인 불완전. 새 발급 중단 |

POST는 자동 재시도하지 않습니다. 공식 단축 응답을 그대로 반환하고 `/base/shorten/detail/{shortCode}`의 원본과 비교합니다. 검증을 위해 실제 제휴 URL을 방문하지 않으므로 클릭 실적을 인위적으로 만들지 않습니다. 응답 형식 변화, 타임아웃, 전송 오류는 성공으로 숨기지 않습니다.

## 검증 결과와 남은 작업

- 독립 Node 테스트 18개 통과: 세션 갱신·전달, 쿠키 범위, 로그인/교육 차단, 기존 ID 재사용, 불확실한 POST, 부분 완료 복구, 단축 주소/귀속 검증, 민감값 출력 차단.
- 필요한 기존 의존성을 설치한 뒤 API Hub 전체 테스트 75개와 저장소 비밀정보 검사, diff 형식 검사도 통과했습니다.
- 공식 공개 JavaScript 3개 HTTP 200 및 SHA-256 기록. **이는 실계정 API 성공 증거가 아닙니다.**
- 브라우저의 `/m/login/additionalInfo.do` 응답은 `linkageString`이 빈 값이었습니다. 링크 생성 화면은 로그인으로 이동했습니다.
- 익명 직접 GET 및 현재 세션 쿠키 4개를 stdin으로 전달한 독립 HTTP 실행은 403이었습니다. 실제 인증 토큰 전달·보호된 API 성공·실계정 링크 발급 성공은 각각 미검증입니다.
- 로그인 후 정상 UI의 링크 발급 요청을 캡처하고, 동일 세션을 독립 클라이언트로 전달해 검색·발급·내역·단축 원본을 확인해야 합니다. 독립 HTTP에서 계속 403이면 해당 접근 차단을 별도 문제로 처리해야 하며, 로그인만으로 해소된다고 보장하지 않습니다.

```powershell
node --test apps/affiliate-api-hub/tests/oliveyoung-curator.test.mjs
node apps/affiliate-api-hub/tools/discovery/oliveyoung-public-source.mjs
```

공개 소스 점검 명령은 관찰한 버전의 자산을 재검사합니다. 최신 배포를 자동 발견하지 않으므로 실제 사용 전에는 정상 페이지의 현재 자산과 계약을 다시 확인해야 합니다. 원격 JavaScript를 실행하지 않습니다.

공식 운영 안내: [올리브영 쇼핑 큐레이터 활동 가이드](https://m.oliveyoung.co.kr/m/mtn/affiliate/guide). 공식 안내는 발급된 링크를 임의로 수정하지 않도록 명시합니다. 이 클라이언트는 서버가 준 활동 ID만 사용하며 공식 단축 주소를 변경하지 않습니다.
