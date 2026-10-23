# Adpick authenticated HTTP and serverless handlers

[Lee-SiHyeon/adpick-api](https://github.com/Lee-SiHyeon/adpick-api/tree/4f9a9f7f713c3c051ef4bac5d1d4e08e20742054)의 **4f9a9f7f713c**에서 이식했습니다.
인증 공급자·요청 계약·저널·원본의 검증 한계는 [원본 안내](SOURCE_README.md)를 참고하세요.

저장소 루트에서 설치하고 실행합니다.

~~~sh
npm ci --ignore-scripts
node scripts/client-packs.mjs describe --service=adpick
~~~

- 실행 모드: pure_http.
- 포함 기능: login, search, campaigns, malls, links, sdk, banners, reports.
- Library and api/ handlers; native write guards are preserved. No generic writer is added.
- 이번 이식에서는 현재 계정 로그인·생성·게시·업로드를 실행하지 않았습니다.
- 다른 폴더에서 실행할 때 scripts/client-packs.mjs의 절대 경로를 사용합니다. 입력·출력 상대 경로는 호출한 폴더 기준입니다.
