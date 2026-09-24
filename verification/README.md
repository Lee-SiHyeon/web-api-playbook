# 패키징 확인 범위

이 폴더는 새 저장소의 설치/정적 확인과 이후 추가된 실행기의 증거를 기록합니다.
초기 패키징 결과는 아래 내용과 `packaging.json`, 2026-09-24 웹 인증 구현·라이브 결과는
[web-login-2026-09-24.json](web-login-2026-09-24.json)을 따릅니다.

## 초기 패키징 확인

현재 Windows host에서 확인하는 항목:

- Node 24.10.0에서 root `npm ci --ignore-scripts` 및 `doctor`.
- 포함 JavaScript의 `node --check`와 정적 상대 import 경로 존재 여부.
- 실제 계정 없이 합성 HAR/HTML을 변환하고 frontier를 생성·조회하는 문서 명령.
- 별도의 새 폴더에 스킬을 복사한 뒤 dependency 설치 및 doctor/합성 예제 실행.
- 배포 파일의 높은 신뢰도 비밀 패턴 검사와 출처 hash 확인.

최종 수치와 결과는 [packaging.json](packaging.json)에 남깁니다. 예제 결과는 `work/`에 저장하며 Git에 포함하지 않습니다. 인벤토리 검사는 private key/GitHub/API key/JWT/일부 signed query/cookie/temporary tunnel 패턴을 찾아 **파일명·줄·종류만** 보고합니다. 모든 종류의 비밀 부재를 수학적으로 증명하는 검사는 아닙니다.

이 작업에서는 **unit/integration test suite를 추가하거나 실행하지 않았고**, 실제 계정 로그인·게시·업로드도 실행하지 않았습니다. 새 generic transport/store/journal은 코드와 정적 검토까지이며, 서비스 전체 end-to-end 완료로 확대하지 않습니다. macOS/Linux 실행은 이 Windows 패키징 확인에 포함되지 않습니다.
