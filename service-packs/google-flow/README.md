# Flow direct HTTP and optional UI backend

[Lee-SiHyeon/affiliate-content-operations](https://github.com/Lee-SiHyeon/affiliate-content-operations/tree/92d854e808768d57c4765c060e204c26b449097d)의 **92d854e80876**에서 이식했습니다.
인증 공급자·요청 계약·저널·원본의 검증 한계는 [원본 안내](SOURCE_README.md)를 참고하세요.

저장소 루트에서 설치하고 실행합니다.

~~~sh
npm ci --ignore-scripts
npm run --silent client -- --service=google-flow -- help
~~~

- 실행 모드: phase_specific_http_with_optional_profile_or_gflow.
- 포함 기능: project-media, generation, download, session, profile-sync.
- Session/bootstrap and optional gflow backend have separate browser requirements; see the native README.
- 이번 이식에서는 현재 계정 로그인·생성·게시·업로드를 실행하지 않았습니다.
- 다른 폴더에서 실행할 때 scripts/client-packs.mjs의 절대 경로를 사용합니다. 입력·출력 상대 경로는 호출한 폴더 기준입니다.
