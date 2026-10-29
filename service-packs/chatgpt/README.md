# ChatGPT web contract client

[Lee-SiHyeon/chatgpt-web-xhr-client](https://github.com/Lee-SiHyeon/chatgpt-web-xhr-client/tree/9c0b60ce60e39c329df8623389b220a89fb9c6ad)의 **9c0b60ce60e3**에서 이식했습니다.
인증 공급자·요청 계약·저널·원본의 검증 한계는 [원본 안내](SOURCE_README.md)를 참고하세요.

저장소 루트에서 설치하고 실행합니다.

~~~sh
npm ci --ignore-scripts
npm run --silent client -- --service=chatgpt -- help
~~~

- 실행 모드: pure_http_contract_gated.
- 포함 기능: contracts, session, read, stream, send, media, reconciliation.
- Uncaptured contracts remain blocked; a packaged scaffold is not live success.
- 이번 이식에서는 현재 계정 로그인·생성·게시·업로드를 실행하지 않았습니다.
- 다른 폴더에서 실행할 때 scripts/client-packs.mjs의 절대 경로를 사용합니다. 입력·출력 상대 경로는 호출한 폴더 기준입니다.

## 이미지 생성 (UI 자동화, 2026-10-29)

- 이미지 생성은 XHR 계약 클라이언트가 아니라 브라우저 UI 자동화로 처리합니다. 자세한 관찰 내용은 [참고 문서](../../references/chatgpt-web-image-2026-10-29.md)를 보세요.
- 실행 스크립트: [`scripts/chatgpt-image.mjs`](../../scripts/chatgpt-image.mjs). 기본은 폰 Chrome(adb 포워딩 9471)이고, `--target=pc`로 PC Canary(9333)를 사용합니다.
- XHR 계약 중 읽기 3개(대화 조회, 파일 다운로드 메타, conversation/init)는 `contracts/registry.json`에 캡처되어 있습니다. 캡처 원본은 `discovery/xhr-capture-2026-10-29.json`입니다.
- 전송 계약(`POST /backend-api/f/conversation`)은 등록하지 않습니다. sentinel 작업 증명과 Turnstile 토큰을 요구하므로 전송은 UI에서만 수행합니다 (`text.send`는 여전히 `CONTRACT_NOT_CAPTURED`).
