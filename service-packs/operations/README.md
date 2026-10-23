# 추가 HTTP 클라이언트 모음

affiliate-content-operations의 추가 adapter와 소셜·공개 데이터 client를 원래 apps 구조와
필요한 로컬 의존성으로 이식했습니다. 개별 저장소를 가리키던 Playbook/X/쇼핑 import는 패키지 내부로 연결했습니다.

~~~sh
# 저장소 루트
npm ci --ignore-scripts
npm run --silent social:actions -- capabilities
npm run test:client-packs -- --service=social-actions
~~~

- apps/affiliate-api-hub/adapters: 공급자·쇼핑·판매처·리뷰·여행·장소·YouTube HTTP adapter.
- scripts/sns/readers, writers, video-upload: Instagram·Threads·X 등의 계약·저널·readback.
- apps/social-actions: Naver/Tistory/X/Threads/Instagram action, Instagram/TikTok/YouTube/Clip과 Threads/X client.
- apps/naver-blog-api/research/content-store: 추가 공개 HTTP source와 파서·규칙.
- apps/toss-sharelink: 로그인·읽기·발급과 일별 수집·archive. 보호 저장소는 요청할 때 생성.
- apps/measurement/adapters: 플랫폼 측정 client.

일반 블로그 CLI는 기존 service-packs/naver와 tistory를 사용합니다.
여기 남은 Naver/Tistory 파일은 추가 client의 고정 의존성입니다.
계정·개인 데이터·크롤링 결과 DB·봇 스케줄러·영상 렌더러는 공통 실행기에 등록하지 않습니다.

Threads configure의 HTTP 202 재전송 루프를 제거했습니다.
웹·Graph 경로가 같은 runKey의 chain 예약을 공유하여 미확정 응답·생성 checkpoint·완료 뒤 재실행을 막습니다.
첫 게시의 Graph HTTP 4xx와 숫자 오류 코드가 직접 기록된 경우만 예약을 해제하여 웹 fallback을 허용합니다.
수동 대사나 검색 결과 없음은 예약을 해제하지 않습니다. 대사는 기존 결과를 읽어서 진행하고, 새로 승인된 체인은 별도 안정적인 runKey를 사용해야 합니다.
유효하지 않은 topic/context는 업로드와 저널 접근 전에 거절합니다.

검증 목록·변경은 provenance/operations-consolidation-2026-10-23.json에 있습니다.
Windows 전용 DPAPI 캐시는 Linux에서 건너뜁니다. 모의 HTTP·과거 fixture를 현재 계정 성공으로 해석하지 않습니다.
