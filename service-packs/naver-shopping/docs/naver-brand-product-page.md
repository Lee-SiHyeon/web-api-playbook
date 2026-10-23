# 브랜드 상품 페이지의 독립 HTTP 조회

`product-page`는 `brand.naver.com` 상품 문서의 구조화된 상태를 읽어 상품명·표시 가격·배송 조건·평점·리뷰 수를 반환합니다. 브라우저, 브라우저 쿠키, SDK 발급 과정 없이 실행합니다. 데이터 원천은 **SSR 문서**이며 결과에 `sourceProtocol: SSR_DOCUMENT`, `xhrApiRead: false`를 명시합니다.

상품 JSON XHR과 전체 리뷰 본문 API는 별도입니다. 해당 API들의429가 해결됐다는 의미는 아닙니다.

## 설치와 실행

Linux 워커에서 Node.js24+, Python3.10+를 사용합니다. HTTP 전송 의존성은 저장소의 무시되는 런타임 디렉터리에 설치합니다.

```bash
python3 -m pip install --target .runtime/http-python -r requirements-http.txt
npm run --silent naver:shopping -- product-page \
  --product-url https://brand.naver.com/hera/products/9215718713
```

Node24 실행 경로가 따로 필요하면 다음과 같이 실행합니다.

```bash
npm exec --yes --package=node@24 -- node scripts/naver-shopping.mjs product-page \
  --product-url https://brand.naver.com/hera/products/9215718713
```

JavaScript에서는 `getBrandProductDocument({ productUrl })`를 `adapters/naver-brand-document.mjs`에서 가져옵니다. Python 실행 파일은 필요하면 `NAVER_SHOPPING_PYTHON`으로 지정할 수 있습니다.

## 데이터와 제한

- 원천: `__PRELOADED_STATE__.simpleProductForDetailPage`.
- 상품 ID·채널 일치를 확인하고 기존 정규화 함수로 정상가와 표시가를 구분합니다.
- 원상품 번호와 채널 상품 번호를 구분합니다. 리뷰 수·평점은 집계이며 리뷰 본문은 반환하지 않습니다.
- 최종 옵션·쿠폰·멤버십·배송비를 포함한 결제 가격은 확인하지 않습니다.
- `curl_cffi==0.16.3`의 `chrome150` HTTP 호환 프로필을 사용합니다. TLS/HTTP2 프로필 모사를 사용한다는 사실을 receipt에 기록합니다. 실행 중 브라우저를 시작하지 않습니다.
- 요청은 고정 브랜드 상품 문서 GET으로 제한합니다. 8 MiB·15초 상한, 수동 리다이렉트 처리, 자동 재시도 없음입니다. 쿠키·인증 헤더를 입력받지 않습니다.
- 원문은 HTTP 워커와 파서 사이의 전용 메모리 파이프로만 전달합니다. CLI에는 정규화한 상품과 응답 영수증만 나옵니다.

## 실제 조회 결과

2026-09-30, **4개 브랜드9개 상품 모두 독립 HTTP200·표시 가격 반환**을 확인했습니다. 브라우저나 브라우저에서 발급받은 상태를 사용하지 않았습니다.

| 브랜드 | 확인 상품 수 | 표시 가격 예시 |
|---|---:|---:|
| 헤라 | 3 | 파운데이션64,800원, 쿠션54,000원 |
| 다이슨 | 2 | 에어스트레이트499,000원 |
| 농심 | 2 | 웰치 세트16,390원 |
| 이니스프리 | 2 | 폼클렌징18,720원 |

가격은 해당 조회 시점의 값입니다. 전체 브랜드나 장기 가용성을 보장하는 결과는 아닙니다.

[실행한 코드 해시·상품별 응답 기록](../references/naver-product-page-live-20260930.json)

## 추가 원인 대조

캡처한 LCT가 같은 값으로 브라우저에서 재사용되는지 먼저 확인했습니다. 재사용 전후 모두200이었지만, 같은 쿠키로 호출한 Java 표준 HTTP/1.1·HTTP/2는429였습니다. `curl_cffi`로는 문서200이 가능했으나 상품 JSON은 같은 연결 재사용, 같은 목적지, 같은 헤더 값 전달을 확인한 조건에서도429였습니다. 따라서 응답 버퍼 크기나 Node에만 있는 문제로 설명되지 않습니다.

추가로 브라우저가 아직 보내지 않은 새 SDK 요청을 `curl_cffi`에서 먼저 호출했지만429였습니다. 이후 원래 브라우저 요청을 수정 없이 진행하자 **동일한 SDK 값·쿠키로200**이 나왔습니다. 해당 네이티브 실패를 오래됐거나 이미 소비된 SDK 값만의 문제로 설명할 수 없습니다. 정확한 서버 측 보호 규칙은 아직 확인하지 못했습니다.

상품 JSON의 `productUrl`·`mobileProductUrl`에 나온 스마트스토어 `/main/products/...` 주소는 Node에서 로그인 페이지로307 이동했습니다. 브랜드의 정규 상품 주소와 이 별칭을 구분해야 합니다.

헤라·다이슨에서 문서의 `channel.payReferenceKey`가 상품 API의 `channel.naverPaySellerNo`와 일치하는 것도 확인했습니다. 이 연결과 원상품 번호를 사용한 독립 리뷰 POST는 여전히429였습니다.

[추가 대조 기록](../references/naver-brand-transport-followup-20260930.json) · [전송 라이브러리의 공식 프로필 설명](https://curl-cffi.readthedocs.io/en/latest/impersonate/targets.html)
