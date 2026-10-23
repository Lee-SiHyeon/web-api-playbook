# Flow extension bridge

[Lee-SiHyeon/google-flow-xhr-client](https://github.com/Lee-SiHyeon/google-flow-xhr-client/tree/85d0f71919db8dd12117efd1f9abb4158ab4abd1)의 **85d0f71919db**에서 이식했습니다.
인증 공급자·요청 계약·저널·원본의 검증 한계는 [원본 안내](SOURCE_README.md)를 참고하세요.

저장소 루트에서 설치하고 실행합니다.

~~~sh
npm ci --ignore-scripts
npm run --silent client -- --service=google-flow-bridge -- help
~~~

- 실행 모드: browser_automation.
- 포함 기능: project-media, generation, download, reconciliation.
- Preserved distinct XHR bridge; recurring RPCs need a signed-in Flow page and extension. No donor tests.
- 이번 이식에서는 현재 계정 로그인·생성·게시·업로드를 실행하지 않았습니다.
- 다른 폴더에서 실행할 때 scripts/client-packs.mjs의 절대 경로를 사용합니다. 입력·출력 상대 경로는 호출한 폴더 기준입니다.
