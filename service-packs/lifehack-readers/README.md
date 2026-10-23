# Lifehack HTTP reader와 요청 계약

lifehackailab-web에서 Danawa 상품/판매처·검색, 11번가/네이버 피드·RSS,
Toss 수집/배송비 규칙, Adpick 응답 정리와 Coupang 공식 Open API client를 가져왔습니다.
웹 UI·DB 작업 임대·예약 실행·운영 계정은 원본 앱의 범위입니다.

~~~sh
# 저장소 루트
npm ci --ignore-scripts
npm run --silent readers -- describe
~~~

run은 stdin JSON의 operation과 입력을 읽어 실제 HTTP 요청을 보냅니다.
지원 operation은 danawa-target(sourceOfferId), danawa-search(query), danawa-offers(pcode),
eleventh, naver-deals입니다. 기본 describe는 메타데이터만 읽습니다.

라이브러리는 원래 src/lib 배치를 유지합니다. TypeScript는 node --import=tsx로 실행합니다.
Next.js server-only 표식은 native Node 패키징에서 제거했고 node:crypto와 호출자 자격증명 주입을 유지했습니다.
Coupang 공식 API의 서명/모의 응답 검증은 실제 발급이나 계정 소유 증거가 아닙니다.
미확인 배송비·조건부 할인·서로 다른 옵션을 합쳐 최저가로 판정하지 않습니다.
