# 쿠팡 파트너스 API 탐색 결과 — 2026-09-19

## 세션과 안전 경계

- 기존 Stable Chrome의 로그인된 쿠팡 파트너스 탭을 제자리에서 재사용했다.
- 쿠키·세션 토큰·인증 헤더 값은 추출하거나 파일에 저장하지 않았다.
- 브라우저 캡처 중 GET/HEAD/OPTIONS만 허용했고 POST/PUT/PATCH/DELETE는 전송 전에 차단했다.
- 응답 본문과 요청 값은 저장하지 않았고, 경로·메서드·필드 이름·상태 코드만 기록했다.

## 수집량

- 로그인 세션에서 실제 HTTP 200으로 관측한 GET API: 9개
- 공개 JS 번들 분석: 6개
- 원시 문자열 후보: 149개
- 정규화 계약: 154개
- 1차 구현 후보(P0/P1): 71개

## P0 구현 후보

- `POST /api/v1/search` — `catalog_search` — 필드: alt, border, category, children, className, datasetId, deliveryTypes, description, filter, group, height, href
- `POST /api/v1/search/best` — `catalog_search` — 필드: __html, actionType, category, categoryId, children, content, dangerouslySetInnerHTML, data, limit, overflow, page, pageNumber
- `POST /api/v1/url/any` — `link_generation` — 필드: coupangUrl, coupangUrl, datasetId, group, height, instanceId, options, product, size, width
- `POST /api/v1/url/instant/${e}` — `link_generation` — 필드: coupangUrl, dataType, datasetId, height, instanceId, size, width
- `POST /api/v1/url/instant/all` — `link_generation` — 필드: coupangUrl, datasetId, group, height, instanceId, options, product, size, width
- `GET /api/v1/open-api` — `open_api_access` — 필드: action, daily, dailyFetched, dateRange, hmacKeys, hmacStatus, id, intl, loading, m7, monthly, monthlyFetched
- `GET /api/v1/open-api/apply` — `open_api_access` — 필드: action, daily, dailyFetched, dateRange, g, hmacKeys, hmacStatus, id, intl, loading, m7, message
- `POST /api/v1/discovery/fashion` — `product_discovery` — 필드: limit, category, categoryId, limit, page, pageNumber, size
- `POST /api/v1/discovery/goldbox` — `product_discovery` — 필드: limit, category, categoryId, limit, page, pageNumber, size
- `GET /api/v1/discovery/high-commission` — `product_discovery` — 필드: limit, categoryId, limit
- `GET /api/v1/discovery/most-conversion` — `product_discovery` — 필드: limit, categoryId, limit
- `GET /api/v1/discovery/most-discounted` — `product_discovery` — 필드: limit, categoryId, limit
- `POST /api/v1/discovery/most-sold` — `product_discovery` — 필드: limit, category, categoryId, limit, page, pageNumber, size
- `POST /api/v1/discovery/retail-clearance` — `product_discovery` — 필드: limit, category, categoryId, limit, page, pageNumber, size
- `POST /api/v1/discovery/rocket-fresh` — `product_discovery` — 필드: limit, category, categoryId, limit, page, pageNumber, size
- `GET /api/v1/discovery/top-commission` — `product_discovery` — 필드: limit, categoryId, limit
- `POST /api/v1/earning/summary` — `reporting_earnings` — 필드: filters, pageNumber, size, value
- `POST /api/v1/earning/summary/v2` — `reporting_earnings` — 필드: filters, month, pageNumber, size, trackingCode
- `POST /api/v1/performance/summary` — `reporting_earnings` — 필드: filters, month, trackingCode
- `POST /api/v1/report/daily` — `reporting_earnings` — 필드: childTrackingCodes, column, currentSubId, currentSubIds, endDate, filters, operator, pageNumber, size, startDate, value
- `POST /api/v1/report/monthly` — `reporting_earnings` — 필드: column, des, filters, operator, pageNumber, size, value
- `POST /api/v1/report/payout/details/download` — `reporting_earnings` — 필드: month, filters, month, trackingCode
- `POST /api/v1/report/payouts` — `reporting_earnings` — 필드: filters, month, pageNumber, size, trackingCode
- `POST /api/v1/report/payouts/details` — `reporting_earnings` — 필드: filters, month, pageNumber, size, trackingCode
- `POST /api/v1/report/settlement` — `reporting_earnings` — 필드: column, filters, operator, pageNumber, size, value
- `POST /api/v1/report/settlements` — `reporting_earnings` — 필드: filters, month, pageNumber, size, trackingCode
- `POST /api/v1/report/settlements/details` — `reporting_earnings` — 필드: filters, month, pageNumber, size, trackingCode
- `POST /api/v1/report/settlements/details/download` — `reporting_earnings` — 필드: month, trackingCode, filters, month, trackingCode
- `POST /api/v1/subId` — `sub_id` — 필드: otherReasonText, payout, reason, subId
- `POST /api/v1/subId/all` — `sub_id` — 필드: subId
- `POST /api/v1/subId/delete/${e}` — `sub_id` — 필드: otherReasonText, payout, reason, subId
- `GET /api/v1/subId/internal` — `sub_id` — 필드: -
- `POST /api/v1/subId/internal` — `sub_id` — 필드: A, otherReasonText, payout, reason, subId

## P1 구현 후보

- `GET /api/v1/dashboard` — `configuration_dashboard` — 필드: -
- `POST /api/v1/dashboard` — `configuration_dashboard` — 필드: __html, actionType, categoryId, children, className, content, dangerouslySetInnerHTML, data, overflow, page
- `POST /api/v1/banner/gen` — `creative_widget` — 필드: border, coupangUrl, datasetId, group, height, options, product, size, width
- `POST /api/v1/banner/iframe/url` — `creative_widget` — 필드: border, children, className, datasetId, group, height, href, options, product, size
- `POST /api/v1/widgets/banners` — `creative_widget` — 필드: coupangUrl, datasetId, group, height, instanceId, options, product, size, width
- `POST /api/v1/widgets/datasets` — `creative_widget` — 필드: dataType, dataType, enabled, instanceId
- `POST /api/v1/widgets/datasets` — `creative_widget` — 필드: category, enabled, limit, page, pageNumber, responseType, size
- `POST /api/v1/widgets/datasets/${e}` — `creative_widget` — 필드: category, limit, page, pageNumber, responseType, size
- `POST /api/v1/widgets/datasets/${e}/delete` — `creative_widget` — 필드: category, limit, page, pageNumber, responseType, size
- `POST /api/v1/widgets/datasets/types` — `creative_widget` — 필드: coupangUrl, dataType, enabled, instanceId
- `POST /api/v1/widgets/instances` — `creative_widget` — 필드: dataType, enabled, instanceId, responseType
- `POST /api/v1/widgets/instances/${e}` — `creative_widget` — 필드: dataType, enabled, instanceId, responseType
- `POST /api/v1/widgets/instances/${e}/delete` — `creative_widget` — 필드: dataType, enabled, responseType
- `POST /api/v1/widgets/instances/${e}/passback` — `creative_widget` — 필드: dataType, enabled, responseType
- `POST /api/v1/widgets/instances/search` — `creative_widget` — 필드: coupangUrl, dataType, datasetId, height, instanceId, width
- `POST /api/v1/widgets/videoBanners` — `creative_widget` — 필드: category, enabled, limit, page, pageNumber, responseType, size
- `POST /api/v1/widgets/videoBanners/${e}` — `creative_widget` — 필드: category, enabled, limit, page, pageNumber, responseType, size
- `GET /api/v1/configuration/content/${e}` — `notifications_content` — 필드: __html, autoHeight, autoHeightMax, autoHeightMin, autoHide, autoLoad, children, className, consent, dangerouslySetInnerHTML
- `GET /api/v1/configuration/content/${p}` — `notifications_content` — 필드: A, agreementKey, autoLoad, children, className, doFetch, id, link, message, onClick
- `GET /api/v1/configuration/content/LANDING_BANNER` — `notifications_content` — 필드: active, alt, children, className, data, onMouseEnter, onMouseLeave, src
- `GET /api/v1/configuration/content/MARKETING_EMAIL` — `notifications_content` — 필드: autoLoad, doFetch, marketingEmail, marketingPiCollection, marketingSms, res
- `GET /api/v1/configuration/content/MARKETING_PI_COLLECTION` — `notifications_content` — 필드: autoLoad, doFetch, marketingEmail, marketingPiCollection, marketingSms, res
- `GET /api/v1/configuration/content/popup_notification` — `notifications_content` — 필드: -
- `POST /api/v1/configuration/content/popup_notification` — `notifications_content` — 필드: actionType, categoryId, data, page, pageNumber, size, targetId
- `GET /api/v1/home-banners` — `notifications_content` — 필드: active, alt, children, className, data, onMouseEnter, onMouseLeave, src
- `POST /api/v1/notification/all` — `notifications_content` — 필드: A, subId
- `GET /api/v1/notification/kakao/${t}` — `notifications_content` — 필드: feature, level, search, tags
- `POST /api/v1/notification/markAllAsRead` — `notifications_content` — 필드: A, consent, modifiedTime, newMarketingConsent, onClose, resultMode, subId, visible
- `POST /api/v1/notification/markAsRead/${e}` — `notifications_content` — 필드: A, consent, modifiedTime, onClose, subId, visible
- `GET /api/v1/notification/top` — `notifications_content` — 필드: -
- `POST /api/v1/notification/top` — `notifications_content` — 필드: A, subId
- `POST /api/v1/downloads/async/reports/${e}/create` — `reporting_earnings` — 필드: subId, traceId
- `POST /api/v1/downloads/async/reports/${e}/delete` — `reporting_earnings` — 필드: $J, EZ, Hv, Q9, ce, fd, j, jy, subId, traceId
- `POST /api/v1/downloads/async/reports/${e}/download` — `reporting_earnings` — 필드: $J, EZ, Hv, Q9, ce, dataSource, fd, j, jy, onMetricClick
- `POST /api/v1/downloads/async/reports/${e}/regen` — `reporting_earnings` — 필드: $J, EZ, Hv, Q9, ce, fd, j, jy, subId, traceId
- `POST /api/v1/downloads/async/reports/list` — `reporting_earnings` — 필드: $J, EZ, ce, fd, j, jy, subId, traceId, ud, vW
- `GET /api/v1/earning/notification` — `reporting_earnings` — 필드: -
- `POST /api/v1/earning/notification` — `reporting_earnings` — 필드: actionType, categoryId, data, page, pageNumber, size, targetId

## 아직 실행하지 않은 것

- 상품 검색 POST, 링크 생성 POST, 리포트 POST 등 쓰기 메서드 힌트가 있는 내부 요청은 실제로 보내지 않았다.
- Open API 키 발급·갱신·폐기, 정산 정보 변경, 계정 정보 변경은 실행하지 않았다.
- 공개 번들의 메서드 힌트는 후보이며, 실제 계약은 각 화면에서 값 없는 테스트 또는 공식 Open API 문서와 대조해야 한다.
