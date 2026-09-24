# 네이버 블로그 편집기 API 재작업 — 2026-09-19

## 완료된 기반

- 계정 `4053103`의 관리자 문서를 임시 브라우저 로그인 뒤 독립 Node HTTP 세션으로 인계했다.
- 독립 관리자 GET은 HTTP 200, 계정 경로와 관리자 셸 일치, 브라우저 비사용 조건을 통과했다.
- 관리자 HTML 1개와 공개 JavaScript 11개를 읽기 전용으로 수집한 실행이 완료됐다.
- 관리자 프런티어의 공개 JavaScript 19개를 인증정보 없이 정적 분석했다.
- 모든 증거에는 비밀번호, 쿠키 값, 응답 원문, 쿼리 값, 폼 값이 없다.

## 현재 파이프라인

1. `run-editor-surface-discovery.ps1`
   - 임시 브라우저에서 사용자가 네이버에 직접 로그인한다.
   - 로그인 제출이 끝난 뒤에만 네트워크 관측을 시작한다.
   - `PostWriteForm.naver?blogId=4053103`으로 GET 이동한다.
   - GET/HEAD/OPTIONS만 허용하고 POST/PUT/PATCH/DELETE는 전송 전에 차단한다.
   - 요청 URL의 origin/path, query 필드 이름, 리소스 종류, 응답 상태만 기록한다.
   - DOM에서는 폼 action/method와 필드 이름, script/iframe URL 메타데이터만 기록한다.
   - 같은 세션을 독립 Node HTTP 클라이언트로 넘긴 뒤 편집기 HTML과 공개 스크립트를 GET으로 재검증한다.

2. `analyze-editor-scripts.mjs`
   - 앞선 성공 증거의 `ssl.pstatic.net` JavaScript만 인증정보 없이 다시 읽는다.
   - 편집기·게시·수정·삭제·업로드·임시저장·스티커·서식 관련 식별자와 문자열 경로만 추출한다.
   - 상대 경로의 origin을 추측하지 않는다.

3. `build-editor-contract-candidates.mjs`
   - HTML/DOM/JavaScript 후보를 공통 형식으로 정규화한다.
   - capability를 `publish`, `update`, `delete`, `media_upload`, `draft_or_autosave`,
     `sticker`, `template_or_document`, `editor_surface` 등으로 구분한다.
   - 모든 후보는 `executable: false`, `valuesObserved: false`로 고정한다.

4. `editor-contracts-cli.mjs`
   - 후보 카탈로그 조회만 제공한다.
   - 네트워크 실행 함수는 `NOT_IMPLEMENTED`로 실패 폐쇄한다.

## 현재 정적 분석 결과

- 공개 관리자 스크립트 시도: 19개
- 성공: 19개
- 실패: 0개
- 정규화 후보: 4개
- mutation 후보: 1개
- 실행 가능 후보: 0개
- 실제 mutation 요청: 0개

현재 mutation 후보는 튜토리얼 프로필 이미지 업로드 문자열이며, 글 작성 이미지 API 계약으로
검증된 것이 아니다. `PostWrite`, `PostUpdate`, `PostDelete`의 실제 메서드·필드·응답은 편집기 표면
수집 결과가 생기기 전에는 구현하지 않는다.

## 안전 경계

- 로그인 전후의 비밀번호나 로그인 POST는 기록하지 않는다.
- 편집기 관측 단계의 비-GET 요청은 브라우저 route에서 abort한다.
- 정적 문자열 후보를 실행 URL로 자동 승격하지 않는다.
- origin이 동적으로 조립되는 상대 경로는 `origin: null`로 유지한다.
- 실제 게시·수정·삭제·업로드 구현은 별도 관측 계약, 사용자 대상 콘텐츠, 검증용 절차가 확정된 뒤에만 추가한다.
