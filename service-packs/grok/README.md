# Grok web HTTP client

[Lee-SiHyeon/grok-web-xhr-client](https://github.com/Lee-SiHyeon/grok-web-xhr-client/tree/546bcf0aed62d118a67ea6d4c0b969677884c8f6)의 **546bcf0aed62**에서 이식했습니다.
인증 공급자·요청 계약·저널·원본의 검증 한계는 [원본 안내](SOURCE_README.md)를 참고하세요.

저장소 루트에서 설치하고 실행합니다.

~~~sh
npm ci --ignore-scripts
npm run --silent client -- --service=grok -- help
~~~

- 실행 모드: operation_specific_http_or_websocket.
- 포함 기능: owner, conversations, workspaces, model-selection, text, attachments, media.
- Some operations need declared Python transports or captured inputs; inspect the native feature audit.
- 이번 이식에서는 현재 계정 로그인·생성·게시·업로드를 실행하지 않았습니다.
- 다른 폴더에서 실행할 때 scripts/client-packs.mjs의 절대 경로를 사용합니다. 입력·출력 상대 경로는 호출한 폴더 기준입니다.
