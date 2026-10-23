# Whisk SDK 클라이언트

youtube-shorts-pipeline의 WhiskClient.ts에서 프로젝트·참조 이미지·생성·미디어 wrapper를 가져왔습니다.
의존성은 원본 lock의 **@rohitaryal/whisk-api@4.0.0**에 고정했습니다.

루트에서 npm ci --ignore-scripts 후 node --import=tsx로 사용합니다.

~~~js
import { WhiskClient } from './service-packs/whisk/src/index.mjs';
// 신뢰하는 공급자가 허가된 현재 사용자의 세션을 메모리에서 전달합니다.
// const client = new WhiskClient(cookieHeader);
~~~

원본 fromCookieFile은 기존 선택형 helper이며 패키지가 쿠키 파일을 만들거나 복사하지 않습니다.
로그인·자동 생성 CLI를 새로 만들지 않았습니다. 원본 회귀 테스트가 없어 import와 패키징을 검증했고,
실제 계정·SDK 갱신·생성·readback은 미검증입니다.
