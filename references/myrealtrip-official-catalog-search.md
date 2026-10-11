# MyRealTrip 공식 투어·티켓 검색 API

공식 [API 가이드](https://docs.myrealtrip.com/)의 투어·티켓 검색을 재사용하는 읽기 recipe다.
2026-10-11 현재 문서 root가 로드한
[공식 JS 계약](https://docs.myrealtrip.com/assets/index-kQYN436v.js)을 확인했으며,
해당 asset SHA-256은 `e3419316dbeefcea348956dd7eef9048a8d6391ae2954130a4160bafa73e9bdd`다.
현재 계약과 인증된 실제 조회 근거는 [provenance](../provenance/myrealtrip-official-search-2026-10-11.json)에 있다.

## 요청과 실행 경계

`POST https://partner-ext-api.myrealtrip.com/v1/products/tna/search`는 **읽기 전용 상품 검색**이다.
공식 파트너 Bearer API key를 해당 HTTPS origin에만 보내며 웹 파트너의
`partner-access-token`·로그인 cookie와 혼용하지 않는다. root `scripts/myrealtrip.mjs`는
웹 파트너 명령이므로 이 operation을 받는 CLI라고 가정하지 않는다.

실제로 통과한 입력은 다음과 같다.

```json
{"keyword":"제주","sort":"selling_count_desc","page":1,"size":2}
```

| JSON 필드 | 공식 계약 |
|---|---|
| `keyword` | 필수 문자열 |
| `category` | 선택. 같은 도시의 `/v1/products/tna/categories` 결과 `value`를 사용; 도시별 값을 하드코딩하지 않음 |
| `minPrice`, `maxPrice` | 선택. 0 이상의 정수, 원 단위 |
| `sort` | 선택. `price_asc`, `price_desc`, `review_score_desc`, `selling_count_desc` |
| `page` | 선택. 1부터 시작, 기본 1 |
| `size` | 선택. 1~100, 기본 20 |

문서의 요청 상한은 **분당 최대 200건**이다. 이는 부하 목표가 아니다. 원 공식 client는
보수적으로 1,100 ms 간격을 사용했으며 이 간격을 서버 필수값으로 주장하지 않는다.
같은 key를 사용하는 worker의 총량을 고려하고, 제한된 page/size로 조회한다. 429를 만나면
중단하고 명시적인 재개 시점을 남긴다. 인증 실패·스키마 오류를 새 로그인·다른 key·UA 변경으로
자동 우회하지 않는다.

통합 중인 운영 wrapper의 검증 기준은 `redirect:manual`, cookie 없음, 정확 origin/path,
**8초 timeout·1 MiB streaming body 상한**이다. 이 두 숫자는 client의 운영 한도이며 API가 문서화한 서버 한도가 아니다.
redirect 응답·다른 최종 URL을 거절해 Bearer를 전달하지 않고, HTTP/MIME/application/schema
오류를 구분한다. key는 기존 provider에서 process memory로 받아 원문 로그·Git·출력 파일에 남기지 않는다.

## 성공 응답과 상품 사실

성공은 HTTP 200, JSON MIME, `result.status === 200`, `result.code === "success"`와
실제 `data.items` 배열을 함께 확인한다. 누락된 envelope나 `items:null`을 빈 성공으로 대체하지 않는다.

- 필수 상품 필드는 문자열 `gid`, 비어 있지 않은 `itemName`, 정수 `salePrice`, `productUrl`이다.
  관측한 상품 URL은 HTTPS `experiences.myrealtrip.com/products/<gid>`이며 ID와 경로를 대조한다.
- `salePrice`는 **KRW 시작가**다. 확정 날짜·옵션의 결제 총액, 세금 포함 여부, 재고, 쿠폰 적용가,
  커미션이나 실제 예약 가능 여부를 추정하지 않는다. `priceDisplay`는 표시 문자열이고 숫자 계약을 대체하지 않는다.
- `imageUrl`·`description`·category·review·tags·deepLink는 선택 정보다. 누락을 가짜 값으로 채우지 않는다.
  image가 있으면 안전한 HTTPS 원문을 유지하고 실제 로딩 성공은 별도로 확인한다. `mrt://` deepLink를 HTTPS
  상품 URL 대신 credentialed HTTP에 전달하지 않는다.
- pagination은 `data.page`, `data.perPage`, `data.totalCount`, `data.hasNextPage`다.
  요청의 `size`를 응답 field 이름으로 쓰거나 다른 숙소/항공 API의 0-based page와 혼동하지 않는다.

page 1의 두 상품이 통과해도 전체 catalog 수집 완료가 아니다. 실제 page를 이어 읽었다면
마지막 `hasNextPage:false` 또는 확인한 종료 조건과 중복 없는 저장 readback을 기록한다.
실패한 행은 검증 실패 건수와 부분 완료로 남기고 source 전체의 persisted 성공을 꾸미지 않는다.

## 확인된 실행 범위

2026-10-11 **19:52:50 UTC**, 이미 허가된 공식 API key로 위 입력을 한 번 조회했다.
HTTP/application 200, JSON 1,063 bytes, 검증된 공개 상품 2개, page 1/perPage 2/totalCount 700/
hasNextPage true를 확인했다. cookie·redirect follow·외부 쓰기·DB 저장·Cron 호출은 없었다.
총 700은 해당 시각·키워드의 응답이며 고정된 catalog 크기가 아니다. 응답에 currency field가 없어도
공식 `salePrice: 시작가 (원)` 계약을 근거로 KRW를 사용하고 다른 통화를 추정하지 않는다.

웹 wrapper의 보완은 이 recipe 작성 시점에 root가 통합·검증 중이다. 운영 배포 완료는 main SHA,
READY deployment SHA와 실제 수집·저장 readback을 확인한 뒤 보고한다. 이 playbook에 별도 generic
API adapter나 인증 producer를 중복 추가하지 않았다.

검색 POST와 제휴 링크 발급 `POST /v1/mylink`는 별도 operation이다. 검색 결과의 `productUrl`이
제휴 URL은 아니며, 발급은 [링크 대사](myrealtrip-link-reconciliation.md)의 의도 저널·201 응답·
정확 목적지/ID 검증을 따른다. 불명확한 발급을 검색처럼 다시 보내지 않는다. 공개 `/health` 200은
이 인증된 검색 성공을 대신하는 key 유효성 증거가 아니다.
