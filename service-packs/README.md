# 서비스 구현 선택

각 pack은 실제 작업에 사용한 코드와 당시 증거의 고정 사본입니다. 새로운 서비스 전체를 자동으로 로그인/탐색하는 범용 SDK가 아닙니다. **과거 라이브 결과와 현재 계정의 유효성은 분리**해서 보세요.

| Pack | 설치 위치와 명령 | 포함 범위 | 중요한 경계 |
|---|---|---|---|
| [naver](naver/README.md) | 해당 폴더에서 `npm ci --ignore-scripts` | HTTP 로그인·보호 저장, Blog API, 통계, 게시/수정/미디어 | 현재 소유자 검증은 기존 블로그 계약. fresh 발행 SDK/최종 native preview는 엔진 필요 |
| [tistory](tistory/README.md) | 해당 폴더에서 `npm ci --ignore-scripts` | 저장 카카오 세션 갱신, 관리 API, 이미지·MP4 attachment, create/update | 신규 계정 password/MFA 자동 로그인은 완료 범위 아님. native video와 파일 첨부 구분 |
| [affiliate](affiliate/README.md) | 해당 폴더에서 `npm ci --ignore-scripts` | MyRealTrip, Adpick, Brand Connect, Coupang 분석, OliveYoung | 사이트별 로그인/가입/연동 상태가 다름. OliveYoung 보호 replay 미완료 |
| [social-x](social-x/README.md) | 해당 폴더에서 `npm ci --ignore-scripts` | X GraphQL·conversation·텍스트 게시, Reddit OAuth read | 요청별 transaction ID 공급자 및 갱신은 별도. X 보호 owner 검증 미구현 경계 유지 |
| [threads](threads/README.md) | 저장소 루트 의존성 사용 | 공개 HTML parser, 익명 HTTP bootstrap + GraphQL profile/view | 익명 CSRF가 로그인 계정 인증은 아님. doc ID와 schema는 재관측 필요 |

## 고정 버전

- Naver: `Lee-SiHyeon/naver-blog-api-only` @ `74e42fe55d236426bc9151a8b127cb2c7b7f28ee`
- Tistory: `Lee-SiHyeon/tistory-api-only` @ `420021c604614f86f0ea6ad44f447049788029bb`
- X/Reddit: `Lee-SiHyeon/sns-X` @ `9f6a26b2520e680005d2f2792704bf71d4c880eb`
- Affiliate: `affiliate-content-operations`의 `partner-xhr-api` commit `258790f697d02e6dcddcd1fc2212efc3c2387f24` 기본 + OliveYoung 미커밋 파일별 hash 스냅샷.
- Threads: 원본 monorepo 미커밋 스냅샷 + 독립 세션 helper 이식. 전체 계정 vault를 복사하지 않고 익명 Threads 캐시만 연결.

파일별 출처·변경은 [provenance](../provenance/README.md)를 확인하세요. pack 내부 과거 문서의 원래 작업 경로/지난 실행 결과는 당시 기록이며 현재 설치 경로/자동 실행을 뜻하지 않습니다.

## 함께 쓰는 순서

1. pack README에서 실제 runner와 저장소 형식을 확인합니다.
2. 기존 보호 세션이 있다면 해당 pack의 named read로 확인합니다.
3. 부족한 인증은 해당 pack의 provider/정상 로그인 경로로 준비합니다.
4. 일반 호출은 pack의 HTTP client로 실행하고, 새 계약 discovery만 별도 도구로 처리합니다.
5. 쓰기에는 pack 고유 저널·readback 절차를 사용합니다. core의 `request.mjs`를 기존 품질/인증 절차를 건너뛰는 지름길로 사용하지 않습니다.

`npm ci --ignore-scripts`는 브라우저 바이너리 설치 등 dependency postinstall을 생략합니다. 필요한 기능에 한해 pack의 명시적인 setup 명령을 따르세요. 기존 test 파일은 원본 구현과 함께 보존한 것이며 설치 중 실행하지 않습니다.
