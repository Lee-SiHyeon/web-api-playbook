# Vercel 배포와 계정 설정

`vercel whoami`와 기존 `adpick-api` 프로젝트 조회를 먼저 확인합니다.
Git 연동 배포는 커밋 작성자에게 프로젝트 배포 권한이 있어야 합니다. 워커 공용 Git 작성자
설정과 실제 Vercel 사용자가 다르면 `BLOCKED`가 될 수 있습니다. 작업 커밋에 현재 계정과
일치하는 검증된 GitHub 이메일을 사용하고, 공용 Git 설정은 그대로 둡니다.

프로덕션에는 `ADPICK_SERVICE_TOKEN`이 필요합니다. Lifehack 웹에도 같은 값을 등록합니다.
`ADPICK_AFFID`, `ADPICK_API_KEY`, `ADPICK_COOKIE`는 `.env.example`의 이름으로 애드픽
프로젝트에만 등록합니다. 가입 계정 값은 Git에 넣지 않습니다.

배포 `READY`, 실제 `adpick-api.vercel.app` 별칭, 비인증 호출 401, 웹 서버의 인증된
`/api/capabilities` 재조회를 별도로 확인합니다. 계정 설정이 없다면 링크 발급 성공을 보고하지 않습니다.
