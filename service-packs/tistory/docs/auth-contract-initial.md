> 초기 조사 기록입니다. 이후 브라우저 재로그인은 성공했으나 독립 HTTP 로그인은 미완료입니다. 최신 범위는 README 및 references/operations.md를 참조하세요.

# 티스토리 로그인 계약 — 관측 중

대상: https://i-never-stop-study.tistory.com/

## 현재 증거

2026-09-06 Chrome UI에서 블로그 관리메뉴 → 로그인 → 카카오계정으로 로그인을 실행했다. 카카오 계정/비밀번호 입력 화면에 도달했다. 아직 로그인 완료나 인증된 HTTP 재현은 확인하지 않았다.

| 단계 | 관측 | 검증 수준 |
|---|---|---|
| 티스토리 로그인 진입 | `https://www.tistory.com/authentication/login`, query 이름 `redirectUrl`, `isPopup` | 브라우저 이동 URL 확인; HTTP method/status 미캡처 |
| 카카오 인증 연결 | 화면의 링크에 `https://kauth.kakao.com/oauth/authorize`가 continue 대상으로 포함됨 | DOM 링크 관측; 실제 네트워크 요청 미캡처 |
| 인증 요청 필드 | `client_id`, `state`, `redirect_uri`, `response_type`, `auth_tran_id`, `ka`, `is_popup`, `through_account` | 링크 query 이름만 관측; 값 저장 안 함 |
| 티스토리 반환 대상 | `https://www.tistory.com/auth/kakao/redirect` | redirect_uri에 포함된 대상; 실제 콜백 미관측 |
| 카카오 로그인 제출 | 계정/비밀번호 입력, QR코드 로그인 UI 존재 | 제출 endpoint/method/schema 미관측 |
| 추가 인증 / 동의 | 미관측 | 필요 여부 미확인 |
| 세션 발급 / 로그인 상태 확인 | 미관측 | 쿠키 이름·속성 및 상태 확인 endpoint 미확인 |

## 다음 캡처

현재 브라우저 도구는 DOM/화면 조작을 지원하지만 네트워크 요청·응답 캡처 기능을 노출하지 않는다. URL 관측을 XHR 캡처로 간주하지 않는다.

Chrome 로그인 탭에서 DevTools → Network → Preserve log를 켜고 로그인 흐름을 기록한다. 문서 이동과 리다이렉트도 필요하므로 Fetch/XHR에만 한정하지 않는다. 로그인 완료 뒤 요청별 method, host/path, query/body 필드 이름, status, MIME, 응답 키/타입, 리다이렉트 관계를 추출한다. 인증정보·쿠키·토큰·일회용 코드·CSRF 값·원문 요청/응답 본문은 보고서에 기록하지 않는다. 민감정보를 포함한 원본 HAR을 채팅에 공유하지 않는다.

관측된 요청만 구현한다. 사용자 인증이 필요한 단계와 독립 HTTP 실행으로 재현 가능한 단계를 따로 표시한다. 세션 재사용 성공과 로그인 전체의 API-only 재현 성공은 별도로 검증한다.

## 검증 상태

- captured: partial — UI 이동과 링크 query 이름만 관측
- client_exists: false
- remnant_free: not_verified
- credential_propagated: not_verified
- live_replay: false
