# 패키징 확인 범위

2026-10-23 저장소 통합의 새 Linux 체크아웃 검증은
[저장소 통합 기록](repository-consolidation-2026-10-23.json)에 있습니다.
Node 24에서 루트 1,281개·클라이언트 2,845개·MyRealTrip 호환 14개 테스트가 통과했고,
native-store 관련 2개는 건너뛰었습니다. 14개 원본 저장소의 이관 파일 1,853개도 해시로 확인했습니다.
실제 계정 로그인·생성·게시 검증은 이 코드 이관에 포함되지 않습니다.

2026-10-23 파일 정리에서는 테스트가 생성한 쿠팡 임시 결과 8개,
참조가 없는 파생 감사 출력 4개와 테스트 텍스트 로그 4개를 제거했습니다.
16개 파일, 743,954바이트이며 원본은 정리 전 커밋 `07f8481c`의 Git 이력에서 확인할 수 있습니다.
테스트는 전용 임시 폴더를 사용하고, `affiliate-content-operations/` 실행 결과 폴더는
Git과 스킬 설치본에서 제외합니다. 실행·검증이 참조하는 탐색 목록, 계약과 증거는 유지합니다.

이 폴더는 새 저장소의 설치/정적 확인과 이후 추가된 실행기의 증거를 기록합니다.
초기 패키징 결과는 아래 내용과 `packaging.json`, 2026-09-24 웹 인증 구현·라이브 결과는
[web-login-2026-09-24.json](web-login-2026-09-24.json)을 따릅니다.
후속 LinkPrice 작업은 [linkprice-login-2026-09-24.json](linkprice-login-2026-09-24.json)에 별도로 기록했습니다.

## 초기 패키징 확인

현재 Windows host에서 확인하는 항목:

- Node 24.10.0에서 root `npm ci --ignore-scripts` 및 `doctor`.
- 포함 JavaScript의 `node --check`와 정적 상대 import 경로 존재 여부.
- 실제 계정 없이 합성 HAR/HTML을 변환하고 frontier를 생성·조회하는 문서 명령.
- 별도의 새 폴더에 스킬을 복사한 뒤 dependency 설치 및 doctor/합성 예제 실행.
- 배포 파일의 높은 신뢰도 비밀 패턴 검사와 출처 hash 확인.

최종 수치와 결과는 [packaging.json](packaging.json)에 남깁니다. 예제 결과는 `work/`에 저장하며 Git에 포함하지 않습니다. 인벤토리 검사는 private key/GitHub/API key/JWT/일부 signed query/cookie/temporary tunnel 패턴을 찾아 **파일명·줄·종류만** 보고합니다. 모든 종류의 비밀 부재를 수학적으로 증명하는 검사는 아닙니다.

이 작업에서는 **unit/integration test suite를 추가하거나 실행하지 않았고**, 실제 계정 로그인·게시·업로드도 실행하지 않았습니다. 새 generic transport/store/journal은 코드와 정적 검토까지이며, 서비스 전체 end-to-end 완료로 확대하지 않습니다. macOS/Linux 실행은 이 Windows 패키징 확인에 포함되지 않습니다.

## 2026-10-11 보강

[보강 기록](playbook-strengthening-2026-10-11.json)은 Linux·Node 24의 설치·doctor,
root 560개 회귀, MyRealTrip/Toss focused 38개, 새 설치 사본의 9개 검사를 별도로 기록합니다.
Toss legacy client의 import 시 native store를 생성하던 결함은 lazy loading으로 수정했으며
실제 저장 요청의 provider 요구는 유지합니다. [MyRealTrip 읽기 영수증](myrealtrip-link-readback-2026-10-11.json)은
기존 canary의 익명 no-follow 301 재검증 하나이며 신규 로그인·링크 발급 증거가 아닙니다.
offline GitHub CI는 main push 뒤 실제 결과와 SHA를 확인해야 합니다. 새 workflow를 추가한 것만으로
cloud CI 통과라고 기록하지 않습니다.

[크리에이터 공개 데이터 기록](creator-public-data-2026-10-11.json)은 기존 Google RSS native client의 KR 1회 재생, 기존 Threads native client의 공개 5개 재생, 외부 웹 collector와 US/TW/CN 관측을 원문 없이 기록합니다. 자동 체크리스트의 typed live receipt와 다른 documentary 기록이며 owner 로그인·전체 플랫폼·production persistence 증거가 아닙니다. TikTok의 이전 SHA와 이후 3일 staleness guard SHA를 별도로 보존합니다. [후속 웹 fresh replay](creator-public-data-web-fresh-2026-10-11.json)는 최종 웹 SHA의 Google 8개 시장·TikTok·Meta·Threads 314개 후보와 16개 실제 HTTP 요청을 따로 기록합니다. native Playbook 재생·cloud 배포·DB 저장에 합산하지 않습니다. 범위와 current gaps는 [공개 데이터 recipe](../references/creator-public-data.md)를 따릅니다.
