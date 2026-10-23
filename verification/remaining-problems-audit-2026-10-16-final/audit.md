# 플레이북 전수조사

조사 시각: 2026-10-15T16:56:41.188Z

등록 기능 전체와 저장소 실행기 재고를 조사했다. 저장 영수증 통과는 기록 시점의 실증이며 현재 세션이나 원격 동작의 재확인이 아니다.

서비스 42/42, 기능 387, 필수 미충족 192.

| 상태 | 기능 수 |
|---|---:|
| blocked | 67 |
| code_inventory | 3 |
| needs_reverification | 5 |
| not_applicable | 66 |
| pending_live | 16 |
| pending_local_test | 18 |
| recorded_live | 84 |
| scope_unknown | 10 |
| source_candidate | 30 |
| unimplemented | 88 |

## 서비스별 범위

| 서비스 | 기능 | 기록 실증 | 필수 미충족 |
|---|---:|---:|---:|
| adpick | 7 | 0 | 5 |
| aliexpress-partner | 11 | 0 | 7 |
| aliexpress-portals | 5 | 0 | 2 |
| aliexpress | 12 | 0 | 8 |
| amazon-partner | 13 | 0 | 8 |
| amazon | 21 | 8 | 7 |
| awin | 8 | 0 | 3 |
| banggood | 11 | 0 | 6 |
| catalog | 5 | 0 | 5 |
| cjdropshipping | 5 | 0 | 3 |
| commerce | 7 | 2 | 5 |
| coupang-retail | 1 | 1 | 0 |
| creator-access-gaps | 4 | 1 | 1 |
| creator-google | 2 | 0 | 1 |
| creator-meta | 2 | 0 | 2 |
| creator-threads | 2 | 0 | 1 |
| creator-tiktok | 3 | 0 | 1 |
| ebay-partner | 17 | 0 | 14 |
| ebay | 17 | 1 | 13 |
| elevenlabs | 8 | 0 | 8 |
| gabia | 10 | 3 | 0 |
| iherb | 7 | 1 | 4 |
| impact | 9 | 0 | 4 |
| inpock | 27 | 5 | 17 |
| oliveyoung-global | 16 | 13 | 1 |
| oliveyoung-public | 14 | 10 | 2 |
| oliveyoung | 11 | 0 | 8 |
| ontology-modetour | 3 | 1 | 0 |
| printful | 7 | 1 | 4 |
| printify | 5 | 0 | 3 |
| rakuten-advertising | 7 | 0 | 5 |
| rakuten-ichiba | 22 | 9 | 7 |
| sephora | 13 | 8 | 2 |
| shein | 7 | 1 | 4 |
| shopee-affiliate-id | 11 | 0 | 9 |
| shopify-storefronts | 12 | 5 | 4 |
| shopify | 9 | 2 | 3 |
| temu | 6 | 0 | 4 |
| toss-sharelink | 2 | 0 | 2 |
| ulta | 11 | 7 | 1 |
| walmart | 9 | 0 | 5 |
| yahoo-shopping-jp | 8 | 5 | 3 |

## 서비스 팩과 등록 범위

| 팩 | 선언된 구현 파일 | 선언된 CLI | 발견 실행기 | 저장 catalog 항목 |
|---|---:|---:|---:|---:|
| affiliate | 1 | 0 | 22 | 0 |
| gabia | 0 | 0 | 0 | 0 |
| naver | 3 | 0 | 45 | 46 |
| ontology | 1 | 1 | 6 | 0 |
| social-x | 0 | 0 | 5 | 0 |
| threads | 3 | 0 | 1 | 0 |
| tistory | 0 | 0 | 6 | 79 |

CLI 미등록과 browser 문자열은 검토 후보다. 런타임 전체 의존성이나 미구현을 단정하는 검사가 아니다. API catalog 중복 사본은 각 파일에 남기며 건수를 고유 계약 수로 합산하지 않는다.

## 모든 기능

| 서비스 | 기능 | 코드 | 로컬 테스트 | 기록 상태 |
|---|---|---|---|---|
| adpick | auth.owner_key | missing | not_run | unimplemented |
| adpick | malls.read | present | not_run | blocked |
| adpick | products.search | present | not_run | blocked |
| adpick | products.best | present | not_run | blocked |
| adpick | affiliate.exact_link_readback | missing | not_run | unimplemented |
| adpick | data.rights_eligibility | missing | not_run | unimplemented |
| adpick | reporting.conversion | missing | not_run | unimplemented |
| aliexpress-partner | affiliate.search_products | present | not_run | blocked |
| aliexpress-partner | affiliate.product_detail | present | not_run | blocked |
| aliexpress-partner | affiliate.social_catalog_search | present | not_run | blocked |
| aliexpress-partner | affiliate.product_media_and_ratings | present | not_run | blocked |
| aliexpress-partner | affiliate.review_content | missing | not_run | not_applicable |
| aliexpress-partner | affiliate.description_options_sku_stock | missing | not_run | not_applicable |
| aliexpress-partner | dropshipping.product_detail | missing | not_run | source_candidate |
| aliexpress-partner | dropshipping.sku_price_inventory | missing | not_run | source_candidate |
| aliexpress-partner | partner.app_credentials | missing | not_run | source_candidate |
| aliexpress-partner | affiliate.user_session | missing | not_run | not_applicable |
| aliexpress-partner | partner.publication_or_orders | missing | not_run | not_applicable |
| aliexpress-portals | affiliate.link_generate | missing | not_run | unimplemented |
| aliexpress-portals | affiliate.link_types | missing | not_run | unimplemented |
| aliexpress-portals | affiliate.tracking_id_bind | missing | not_run | unimplemented |
| aliexpress-portals | storefront.mtop_sign | missing | not_run | not_applicable |
| aliexpress-portals | checkout.write | missing | not_run | not_applicable |
| aliexpress | catalog.product_seo | present | not_run | needs_reverification |
| aliexpress | catalog.product_detail | missing | not_run | source_candidate |
| aliexpress | catalog.search | missing | not_run | unimplemented |
| aliexpress | catalog.offer_price | missing | not_run | unimplemented |
| aliexpress | catalog.categories | missing | not_run | unimplemented |
| aliexpress | catalog.pagination | missing | not_run | unimplemented |
| aliexpress | catalog.reviews | missing | not_run | unimplemented |
| aliexpress | auth.login | missing | not_run | not_applicable |
| aliexpress | profile.write | missing | not_run | not_applicable |
| aliexpress | cart.checkout | missing | not_run | not_applicable |
| aliexpress | affiliate.workflow | missing | not_run | not_applicable |
| aliexpress | catalog.sitemap_products | present | not_run | blocked |
| amazon-partner | auth.creators_api_token | present | not_run | blocked |
| amazon-partner | catalog.search | present | not_run | blocked |
| amazon-partner | catalog.product_detail | present | not_run | blocked |
| amazon-partner | catalog.product_metadata | present | not_run | blocked |
| amazon-partner | catalog.product_variations | present | not_run | blocked |
| amazon-partner | catalog.price_availability | present | not_run | blocked |
| amazon-partner | catalog.pagination | present | not_run | blocked |
| amazon-partner | catalog.category_navigation | missing | not_run | unimplemented |
| amazon-partner | catalog.customer_review_content | missing | not_run | not_applicable |
| amazon-partner | catalog.seller_sku | missing | not_run | not_applicable |
| amazon-partner | catalog.exact_stock_quantity | missing | not_run | not_applicable |
| amazon-partner | affiliate.link_generation | present | not_run | blocked |
| amazon-partner | cart.orders.write | missing | not_run | not_applicable |
| amazon | catalog.navigation | present | not_run | recorded_live |
| amazon | catalog.search | present | not_run | recorded_live |
| amazon | catalog.product | present | not_run | recorded_live |
| amazon | catalog.categories | missing | not_run | unimplemented |
| amazon | catalog.pagination | present | not_run | recorded_live |
| amazon | catalog.pagination_termination | present | not_run | blocked |
| amazon | catalog.price_availability | missing | not_run | unimplemented |
| amazon | catalog.description | present | not_run | recorded_live |
| amazon | catalog.photos | missing | not_run | unimplemented |
| amazon | catalog.options | present | not_run | recorded_live |
| amazon | reviews.full_body | missing | not_run | unimplemented |
| amazon | reviews.pagination | missing | not_run | unimplemented |
| amazon | home.dynamic_cards | missing | not_run | unimplemented |
| amazon | auth.login | missing | not_run | not_applicable |
| amazon | profile.read_edit | missing | not_run | not_applicable |
| amazon | cart.write | missing | not_run | not_applicable |
| amazon | orders.write | missing | not_run | not_applicable |
| amazon | affiliate.private_api | missing | not_run | not_applicable |
| amazon | catalog.observed_images | present | not_run | recorded_live |
| amazon | catalog.displayed_offer | present | not_run | recorded_live |
| amazon | catalog.variant_offers | missing | not_run | source_candidate |
| awin | catalog.search | present | not_run | blocked |
| awin | catalog.product_detail | present | not_run | blocked |
| awin | catalog.offer_price | present | not_run | blocked |
| awin | catalog.pagination | present | not_run | blocked |
| awin | catalog.taxonomy | present | not_run | blocked |
| awin | auth.login | missing | not_run | not_applicable |
| awin | supplier.wholesale_cost | missing | not_run | not_applicable |
| awin | affiliate.link_generation | missing | not_run | not_applicable |
| banggood | catalog.product_search | present | not_run | blocked |
| banggood | catalog.product_detail | present | not_run | blocked |
| banggood | pricing.sale_window | present | not_run | blocked |
| banggood | catalog.categories | present | not_run | blocked |
| banggood | catalog.pagination | missing | not_run | unimplemented |
| banggood | catalog.warehouse_stock | missing | not_run | unimplemented |
| banggood | pricing.multicurrency | present | not_run | blocked |
| banggood | affiliate.link_generation | missing | not_run | unimplemented |
| banggood | auth.consumer_login | missing | not_run | not_applicable |
| banggood | profile.edit | missing | not_run | not_applicable |
| banggood | commerce.order_write | missing | not_run | not_applicable |
| catalog | catalog.full_detail_output | present | not_run | pending_local_test |
| catalog | reviews.content_and_images | present | not_run | pending_local_test |
| catalog | reviews.bounded_pagination | present | not_run | pending_local_test |
| catalog | reviews.csv_readback | present | not_run | pending_local_test |
| catalog | catalog.scope_excludes_affiliate_links | present | not_run | pending_local_test |
| cjdropshipping | auth.api_credentials | present | not_run | blocked |
| cjdropshipping | catalog.search | present | not_run | blocked |
| cjdropshipping | catalog.product_detail_variants | present | not_run | blocked |
| cjdropshipping | catalog.categories | present | not_run | blocked |
| cjdropshipping | cart.orders.writes | missing | not_run | not_applicable |
| commerce | collection.public_feed | present | not_run | recorded_live |
| commerce | collection.public_storefront | present | not_run | recorded_live |
| commerce | collection.pagination | present | not_run | pending_local_test |
| commerce | collection.price_semantics | present | not_run | pending_local_test |
| commerce | collection.history | present | not_run | pending_local_test |
| commerce | collection.credentials | present | not_run | pending_local_test |
| commerce | collection.private_prices | present | not_run | blocked |
| coupang-retail | catalog.search | present | not_run | recorded_live |
| creator-access-gaps | youtube.chart | missing | not_run | source_candidate |
| creator-access-gaps | naver.shopping | present | not_run | recorded_live |
| creator-access-gaps | naver.datalab | missing | not_run | source_candidate |
| creator-access-gaps | naver.advisor | missing | not_run | source_candidate |
| creator-google | rss.public | present | not_run | pending_live |
| creator-google | rss.cn | present | not_run | blocked |
| creator-meta | publication.public | missing | not_run | source_candidate |
| creator-meta | categories.public | missing | not_run | source_candidate |
| creator-threads | profile.public | present | not_run | pending_live |
| creator-threads | keyword.public | missing | not_run | source_candidate |
| creator-tiktok | video.preview | missing | not_run | source_candidate |
| creator-tiktok | hashtag.preview | missing | not_run | source_candidate |
| creator-tiktok | filter.config | missing | not_run | source_candidate |
| ebay-partner | auth.application_token | present | not_run | blocked |
| ebay-partner | catalog.search | present | not_run | blocked |
| ebay-partner | catalog.item_detail | present | not_run | pending_live |
| ebay-partner | catalog.description | present | not_run | blocked |
| ebay-partner | catalog.images | present | not_run | blocked |
| ebay-partner | catalog.product_metadata | present | not_run | blocked |
| ebay-partner | catalog.product_review_summary | present | not_run | blocked |
| ebay-partner | catalog.prices | present | not_run | pending_live |
| ebay-partner | catalog.pagination | present | not_run | pending_live |
| ebay-partner | catalog.category_hints | present | not_run | blocked |
| ebay-partner | catalog.variation_group | present | not_run | blocked |
| ebay-partner | reviews.full_text | missing | not_run | unimplemented |
| ebay-partner | reviews.photos | missing | not_run | unimplemented |
| ebay-partner | reviews.pagination | missing | not_run | unimplemented |
| ebay-partner | affiliate.tracking_url | present | not_run | scope_unknown |
| ebay-partner | auth.marketplace_user_login | missing | not_run | not_applicable |
| ebay-partner | commerce.purchase_or_order_write | missing | not_run | not_applicable |
| ebay | suggestions.read | present | not_run | recorded_live |
| ebay | search.listings | missing | not_run | unimplemented |
| ebay | item.detail | missing | not_run | unimplemented |
| ebay | item.price | missing | not_run | unimplemented |
| ebay | item.description | missing | not_run | unimplemented |
| ebay | item.images | missing | not_run | source_candidate |
| ebay | item.options | missing | not_run | unimplemented |
| ebay | reviews.identity | missing | not_run | unimplemented |
| ebay | reviews.rating | missing | not_run | unimplemented |
| ebay | reviews.list | missing | not_run | unimplemented |
| ebay | reviews.photos | missing | not_run | unimplemented |
| ebay | reviews.pagination | missing | not_run | unimplemented |
| ebay | categories.read | missing | not_run | unimplemented |
| ebay | search.pagination | missing | not_run | unimplemented |
| ebay | images.enrich | missing | not_run | scope_unknown |
| ebay | auth.login | missing | not_run | not_applicable |
| ebay | transactions.write | missing | not_run | not_applicable |
| elevenlabs | auth.session_handoff | present | not_run | pending_local_test |
| elevenlabs | auth.owner_read | missing | not_run | unimplemented |
| elevenlabs | voice.options | missing | not_run | unimplemented |
| elevenlabs | model.options | missing | not_run | unimplemented |
| elevenlabs | generation.settings | missing | not_run | unimplemented |
| elevenlabs | generation.create | missing | not_run | unimplemented |
| elevenlabs | generation.history_readback | missing | not_run | unimplemented |
| elevenlabs | generation.idempotency | missing | not_run | unimplemented |
| gabia | auth.owner | present | not_run | recorded_live |
| gabia | domains.read | present | not_run | recorded_live |
| gabia | dns.records.read | present | not_run | recorded_live |
| gabia | auth.google_login | missing | not_run | unimplemented |
| gabia | auth.session_renewal | missing | not_run | unimplemented |
| gabia | domains.pagination | missing | not_run | unimplemented |
| gabia | dns.records.write | missing | not_run | source_candidate |
| gabia | dns.public_recursive_check | present | not_run | code_inventory |
| gabia | dns.record_plan.prepare | present | not_run | code_inventory |
| gabia | web.https_reachability | present | not_run | code_inventory |
| iherb | affiliate.network_join | missing | not_run | unimplemented |
| iherb | catalog.network_product_feed | missing | not_run | unimplemented |
| iherb | affiliate.deeplink | missing | not_run | unimplemented |
| iherb | catalog.storefront_anonymous | missing | not_run | unimplemented |
| iherb | claims.health | missing | not_run | not_applicable |
| iherb | checkout.write | missing | not_run | not_applicable |
| iherb | catalog.sitemap_products | present | not_run | recorded_live |
| impact | catalog.search | present | not_run | blocked |
| impact | catalog.product_detail | present | not_run | blocked |
| impact | catalog.offer_price | present | not_run | blocked |
| impact | catalog.pagination | present | not_run | blocked |
| impact | catalog.list | present | not_run | blocked |
| impact | catalog.taxonomy | present | not_run | blocked |
| impact | auth.login | missing | not_run | not_applicable |
| impact | supplier.wholesale_cost | missing | not_run | not_applicable |
| impact | affiliate.program_write | missing | not_run | not_applicable |
| inpock | auth.login | present | not_run | needs_reverification |
| inpock | auth.owner | present | not_run | recorded_live |
| inpock | auth.reuse | present | not_run | recorded_live |
| inpock | auth.recovery | present | not_run | pending_local_test |
| inpock | auth.secret_storage | present | not_run | pending_local_test |
| inpock | profile.read | present | not_run | recorded_live |
| inpock | profile.edit | present | not_run | pending_live |
| inpock | categories.contract | missing | not_run | scope_unknown |
| inpock | collections.create | missing | not_run | source_candidate |
| inpock | collections.children | missing | not_run | source_candidate |
| inpock | collections.assign | missing | not_run | source_candidate |
| inpock | cards.read | present | not_run | recorded_live |
| inpock | cards.create | present | not_run | needs_reverification |
| inpock | cards.update | missing | not_run | source_candidate |
| inpock | cards.delete | missing | not_run | source_candidate |
| inpock | cards.visibility | missing | not_run | source_candidate |
| inpock | cards.order | missing | not_run | source_candidate |
| inpock | cards.archive | missing | not_run | source_candidate |
| inpock | cards.schedule | missing | not_run | scope_unknown |
| inpock | content.text | missing | not_run | source_candidate |
| inpock | content.image | missing | not_run | source_candidate |
| inpock | media.upload | missing | not_run | source_candidate |
| inpock | publishing.idempotency | present | not_run | needs_reverification |
| inpock | publishing.public_rendering | present | not_run | needs_reverification |
| inpock | affiliate.prepare | present | not_run | pending_local_test |
| inpock | affiliate.workflow | present | not_run | pending_live |
| inpock | stats.read | present | not_run | recorded_live |
| oliveyoung-global | catalog.product_detail | present | not_run | recorded_live |
| oliveyoung-global | catalog.product_description | present | not_run | recorded_live |
| oliveyoung-global | catalog.currency_context | present | not_run | recorded_live |
| oliveyoung-global | catalog.product_images | present | not_run | recorded_live |
| oliveyoung-global | catalog.bestsellers | present | not_run | recorded_live |
| oliveyoung-global | catalog.category_products | present | not_run | recorded_live |
| oliveyoung-global | catalog.keyword_search | missing | not_run | unimplemented |
| oliveyoung-global | search.suggestions | present | not_run | recorded_live |
| oliveyoung-global | search.popular_keywords | present | not_run | recorded_live |
| oliveyoung-global | reviews.summary | present | not_run | recorded_live |
| oliveyoung-global | reviews.body | present | not_run | recorded_live |
| oliveyoung-global | reviews.pagination | present | not_run | recorded_live |
| oliveyoung-global | reviews.images | present | not_run | recorded_live |
| oliveyoung-global | reviews.media_pagination | present | not_run | recorded_live |
| oliveyoung-global | auth.customer_login | missing | not_run | not_applicable |
| oliveyoung-global | affiliate.link_creation | missing | not_run | not_applicable |
| oliveyoung-public | catalog.search_prices | present | not_run | recorded_live |
| oliveyoung-public | catalog.product_detail | present | not_run | blocked |
| oliveyoung-public | catalog.product_description | present | not_run | recorded_live |
| oliveyoung-public | catalog.options | present | not_run | recorded_live |
| oliveyoung-public | catalog.product_images | present | not_run | recorded_live |
| oliveyoung-public | reviews.summary | present | not_run | recorded_live |
| oliveyoung-public | reviews.body | present | not_run | recorded_live |
| oliveyoung-public | reviews.images | present | not_run | recorded_live |
| oliveyoung-public | reviews.pagination | present | not_run | recorded_live |
| oliveyoung-public | auth.customer_login | missing | not_run | not_applicable |
| oliveyoung-public | affiliate.link_creation | missing | not_run | not_applicable |
| oliveyoung-public | catalog.search_pagination | present | not_run | recorded_live |
| oliveyoung-public | ranking.top_products | present | not_run | recorded_live |
| oliveyoung-public | ranking.category_filters | present | not_run | blocked |
| oliveyoung | catalog.search_prices | present | not_run | blocked |
| oliveyoung | catalog.product_detail | missing | not_run | unimplemented |
| oliveyoung | catalog.product_images | missing | not_run | unimplemented |
| oliveyoung | catalog.pagination | missing | not_run | source_candidate |
| oliveyoung | reviews.body | missing | not_run | unimplemented |
| oliveyoung | reviews.images | missing | not_run | unimplemented |
| oliveyoung | reviews.pagination | missing | not_run | unimplemented |
| oliveyoung | curator.link_creation | present | not_run | blocked |
| oliveyoung | program.commission_terms | missing | not_run | source_candidate |
| oliveyoung | auth.customer_login | missing | not_run | not_applicable |
| oliveyoung | account.profile_payout | missing | not_run | not_applicable |
| ontology-modetour | catalog.document_recommendations | present | not_run | recorded_live |
| ontology-modetour | catalog.other_sections_and_inventory | missing | not_run | unimplemented |
| ontology-modetour | auth_and_booking_writes | missing | not_run | not_applicable |
| printful | catalog.public_price_feed | present | not_run | recorded_live |
| printful | catalog.api_search | present | not_run | blocked |
| printful | catalog.api_product_variants | present | not_run | blocked |
| printful | catalog.api_production_prices | present | not_run | blocked |
| printful | catalog.api_categories | present | not_run | blocked |
| printful | auth.api_credentials | present | not_run | blocked |
| printful | account.orders.writes | missing | not_run | not_applicable |
| printify | auth.catalog_read | missing | not_run | unimplemented |
| printify | catalog.product_variants | missing | not_run | unimplemented |
| printify | catalog.supplier_base_cost | missing | not_run | unimplemented |
| printify | catalog.shipping_prices | missing | not_run | unimplemented |
| printify | account.orders.writes | missing | not_run | not_applicable |
| rakuten-advertising | publisher.access_token | missing | not_run | source_candidate |
| rakuten-advertising | catalog.product_search | present | not_run | blocked |
| rakuten-advertising | catalog.price_currency_stock | present | not_run | blocked |
| rakuten-advertising | catalog.pagination | present | not_run | pending_local_test |
| rakuten-advertising | publisher.affiliate_url | present | not_run | blocked |
| rakuten-advertising | publisher.sephora_partner_mid | present | not_run | scope_unknown |
| rakuten-advertising | publisher.commission_terms | missing | not_run | scope_unknown |
| rakuten-ichiba | auth.application_credentials | present | not_run | pending_live |
| rakuten-ichiba | catalog.search | present | not_run | pending_live |
| rakuten-ichiba | catalog.current_price_jpy | present | not_run | pending_live |
| rakuten-ichiba | catalog.item_detail | present | not_run | pending_live |
| rakuten-ichiba | catalog.category_lookup | present | not_run | pending_live |
| rakuten-ichiba | catalog.pagination | present | not_run | pending_live |
| rakuten-ichiba | affiliate.link_generation | present | not_run | pending_live |
| rakuten-ichiba | catalog.canonical_url_verification | present | not_run | pending_local_test |
| rakuten-ichiba | affiliate.item_rate_metadata | present | not_run | pending_live |
| rakuten-ichiba | catalog.public_review_target_bootstrap | present | not_run | pending_local_test |
| rakuten-ichiba | catalog.public_review_page | present | not_run | recorded_live |
| rakuten-ichiba | catalog.public_review_pagination | present | not_run | recorded_live |
| rakuten-ichiba | catalog.public_review_photos | present | not_run | recorded_live |
| rakuten-ichiba | auth.browser_login_registration | missing | not_run | not_applicable |
| rakuten-ichiba | affiliate.rakuten_advertising_global | missing | not_run | not_applicable |
| rakuten-ichiba | retail.cart_orders_write | missing | not_run | not_applicable |
| rakuten-ichiba | catalog.public_navigation | present | not_run | recorded_live |
| rakuten-ichiba | catalog.public_category | present | not_run | recorded_live |
| rakuten-ichiba | catalog.public_search | present | not_run | recorded_live |
| rakuten-ichiba | catalog.public_pagination | present | not_run | recorded_live |
| rakuten-ichiba | catalog.public_detail | present | not_run | recorded_live |
| rakuten-ichiba | catalog.public_options | present | not_run | recorded_live |
| sephora | catalog.search | present | not_run | recorded_live |
| sephora | catalog.pagination | present | not_run | recorded_live |
| sephora | catalog.product_detail | present | not_run | recorded_live |
| sephora | catalog.variants | present | not_run | recorded_live |
| sephora | catalog.sale_price | present | not_run | recorded_live |
| sephora | catalog.reviews.read | present | not_run | recorded_live |
| sephora | catalog.reviews.pagination | present | not_run | recorded_live |
| sephora | catalog.reviews.variant_filter | present | not_run | recorded_live |
| sephora | catalog.product_description | present | not_run | blocked |
| sephora | storefront.localization | missing | not_run | unimplemented |
| sephora | partner_program.commission | missing | not_run | scope_unknown |
| sephora | auth.login | missing | not_run | not_applicable |
| sephora | cart.write | missing | not_run | not_applicable |
| shein | affiliate.awin_join | missing | not_run | unimplemented |
| shein | catalog.awin_product_feed | missing | not_run | unimplemented |
| shein | affiliate.deeplink | missing | not_run | unimplemented |
| shein | catalog.storefront_anonymous | missing | not_run | unimplemented |
| shein | auth.customer_login | missing | not_run | not_applicable |
| shein | checkout.write | missing | not_run | not_applicable |
| shein | catalog.home_document | present | not_run | recorded_live |
| shopee-affiliate-id | affiliate.catalog_search | present | not_run | blocked |
| shopee-affiliate-id | affiliate.product_lookup | present | not_run | blocked |
| shopee-affiliate-id | affiliate.price_and_commission_fields | present | not_run | blocked |
| shopee-affiliate-id | auth.app_id_secret | missing | not_run | unimplemented |
| shopee-affiliate-id | auth.user_session | present | not_run | scope_unknown |
| shopee-affiliate-id | storefront.anonymous_product_detail | missing | not_run | unimplemented |
| shopee-affiliate-id | account.login_or_writes | missing | not_run | not_applicable |
| shopee-affiliate-id | storefront.product_description_and_images | missing | not_run | unimplemented |
| shopee-affiliate-id | storefront.item_options_sku_price_stock | missing | not_run | unimplemented |
| shopee-affiliate-id | storefront.review_bodies_and_pagination | missing | not_run | unimplemented |
| shopee-affiliate-id | storefront.review_photos | missing | not_run | unimplemented |
| shopify-storefronts | allbirds.catalog.product_detail | present | not_run | recorded_live |
| shopify-storefronts | allbirds.catalog.predictive_search | present | not_run | recorded_live |
| shopify-storefronts | colourpop.catalog.product_detail | present | not_run | recorded_live |
| shopify-storefronts | colourpop.catalog.predictive_search | present | not_run | recorded_live |
| shopify-storefronts | allbirds.catalog.reviews | present | not_run | blocked |
| shopify-storefronts | colourpop.catalog.reviews | present | not_run | recorded_live |
| shopify-storefronts | catalog.full_search_pagination | missing | not_run | unimplemented |
| shopify-storefronts | catalog.collections | missing | not_run | unimplemented |
| shopify-storefronts | storefront.localization | missing | not_run | unimplemented |
| shopify-storefronts | partner_program.entitlement | missing | not_run | scope_unknown |
| shopify-storefronts | auth.login | missing | not_run | not_applicable |
| shopify-storefronts | cart.order_mutation | missing | not_run | not_applicable |
| shopify | catalog.product_detail | present | not_run | recorded_live |
| shopify | catalog.predictive_search | present | not_run | recorded_live |
| shopify | catalog.full_search | missing | not_run | unimplemented |
| shopify | catalog.collections | missing | not_run | unimplemented |
| shopify | storefront.localization | missing | not_run | unimplemented |
| shopify | auth.login | missing | not_run | not_applicable |
| shopify | profile.edit | missing | not_run | not_applicable |
| shopify | cart.checkout | missing | not_run | not_applicable |
| shopify | affiliate.create | missing | not_run | not_applicable |
| temu | affiliate.dashboard_links | missing | not_run | unimplemented |
| temu | catalog.official_product_search | missing | not_run | unimplemented |
| temu | catalog.storefront_anonymous | missing | not_run | unimplemented |
| temu | pricing.ship_to_currency | missing | not_run | unimplemented |
| temu | auth.customer_login | missing | not_run | not_applicable |
| temu | checkout.write | missing | not_run | not_applicable |
| toss-sharelink | auth.owner_curation | present | not_run | pending_local_test |
| toss-sharelink | auth.login_once | present | not_run | pending_local_test |
| ulta | catalog.search | present | not_run | recorded_live |
| ulta | catalog.product_detail | present | not_run | recorded_live |
| ulta | catalog.pagination | present | not_run | recorded_live |
| ulta | catalog.sale_price | present | not_run | recorded_live |
| ulta | reviews.read | present | not_run | recorded_live |
| ulta | reviews.pagination | present | not_run | recorded_live |
| ulta | partner_program.commission | missing | not_run | scope_unknown |
| ulta | auth.login | missing | not_run | not_applicable |
| ulta | cart.write | missing | not_run | not_applicable |
| ulta | affiliate.impact_brand_catalog | present | not_run | blocked |
| ulta | catalog.common_collector | present | not_run | recorded_live |
| walmart | catalog.search | present | not_run | blocked |
| walmart | catalog.detail | missing | not_run | unimplemented |
| walmart | catalog.category | missing | not_run | unimplemented |
| walmart | catalog.pagination | missing | not_run | unimplemented |
| walmart | catalog.offer | missing | not_run | unimplemented |
| walmart | auth.login | missing | not_run | not_applicable |
| walmart | profile.edit | missing | not_run | not_applicable |
| walmart | content.crud | missing | not_run | not_applicable |
| walmart | checkout.write | missing | not_run | not_applicable |
| yahoo-shopping-jp | catalog.public_navigation | present | not_run | recorded_live |
| yahoo-shopping-jp | catalog.public_category | present | not_run | recorded_live |
| yahoo-shopping-jp | catalog.public_detail | present | not_run | recorded_live |
| yahoo-shopping-jp | catalog.public_options | present | not_run | recorded_live |
| yahoo-shopping-jp | catalog.public_review_preview | present | not_run | recorded_live |
| yahoo-shopping-jp | catalog.public_search | present | not_run | blocked |
| yahoo-shopping-jp | catalog.official_search | present | not_run | pending_live |
| yahoo-shopping-jp | affiliate.link_generation | missing | not_run | unimplemented |

## 미등록 실행기 후보

- `lib/playbook-audit.mjs`
- `scripts/agoda.mjs`
- `scripts/amazon-ontology.mjs`
- `scripts/amazon-retail-session.mjs`
- `scripts/audit-playbook.mjs`
- `scripts/brandconnect.mjs`
- `scripts/browser-evidence.mjs`
- `scripts/check-ai-providers.mjs`
- `scripts/coupang-browser-cookie-probe.mjs`
- `scripts/coupang-crawl.mjs`
- `scripts/coupang-offline-guard.mjs`
- `scripts/coupang-public.mjs`
- `scripts/coupang-regression.mjs`
- `scripts/coupang-retail-diagnostic.mjs`
- `scripts/coupang-retail-visitor-check.mjs`
- `scripts/coupang-rsc-probe.mjs`
- `scripts/discover-html.mjs`
- `scripts/doctor.mjs`
- `scripts/frontier.mjs`
- `scripts/har-to-contracts.mjs`
- `scripts/inspect-bundle.mjs`
- `scripts/install-skill.mjs`
- `scripts/myrealtrip.mjs`
- `scripts/observe-response.mjs`
- `scripts/overseas-retail-ontology.mjs`
- `scripts/protected-input.mjs`
- `scripts/request.mjs`
- `scripts/session.mjs`
- `scripts/verify-amazon-expansion.mjs`
- `scripts/verify-browser-fixture.mjs`
- `scripts/verify-coupang-public.mjs`
- `scripts/verify-japan-retail.mjs`
- `scripts/verify-overseas-retail.mjs`
- `scripts/web-auth-diagnose.mjs`
- `scripts/web-auth-import.mjs`
- `scripts/x-read.mjs`
- `service-packs/affiliate/apps/affiliate-api-hub/adapters/coupang-partners-link.mjs`
- `service-packs/affiliate/apps/affiliate-api-hub/adapters/ecb-exchange-rates.mjs`
- `service-packs/affiliate/apps/affiliate-api-hub/scripts/analyze-coupang-public-scripts.mjs`
- `service-packs/affiliate/apps/affiliate-api-hub/scripts/build-coupang-contract-catalog.mjs`
- `service-packs/affiliate/apps/affiliate-api-hub/scripts/build-coupang-request-shapes.mjs`
- `service-packs/affiliate/apps/affiliate-api-hub/scripts/compare-coupang-products.mjs`
- `service-packs/affiliate/apps/affiliate-api-hub/scripts/coupang-consumer.mjs`
- `service-packs/affiliate/apps/affiliate-api-hub/scripts/coupang-flash-sale-inventory.mjs`
- `service-packs/affiliate/apps/affiliate-api-hub/scripts/coupang-partners-check.mjs`
- `service-packs/affiliate/apps/affiliate-api-hub/scripts/coupang-read-diagnostic.mjs`
- `service-packs/affiliate/apps/affiliate-api-hub/scripts/myrealtrip.mjs`
- `service-packs/affiliate/apps/affiliate-api-hub/scripts/naver-shopping-deals.mjs`
- `service-packs/affiliate/apps/affiliate-api-hub/scripts/oliveyoung.mjs`
- `service-packs/affiliate/apps/affiliate-api-hub/scripts/partner-session-probe.mjs`
- `service-packs/affiliate/apps/affiliate-api-hub/scripts/sanitize-coupang-netlog.mjs`
- `service-packs/affiliate/apps/affiliate-api-hub/scripts/validate-domestic-travel-adapters.mjs`
- `service-packs/affiliate/apps/affiliate-api-hub/scripts/validate-travel-adapters.mjs`
- `service-packs/affiliate/apps/affiliate-api-hub/scripts/verify-coupang-goldbox.mjs`
- `service-packs/affiliate/apps/affiliate-api-hub/scripts/verify-coupang-public-prices.mjs`
- `service-packs/affiliate/apps/affiliate-api-hub/scripts/verify-coupang-wow-price.mjs`
- `service-packs/affiliate/apps/affiliate-api-hub/tools/discovery/naver-shopping-replay-probe.mjs`
- `service-packs/affiliate/apps/affiliate-api-hub/tools/research/adpick-affiliate-catalog.mjs`
- `service-packs/naver/apps/naver-blog-api/research/build-product-comparison-brief.mjs`
- `service-packs/naver/apps/naver-blog-api/research/image-prompts/build.mjs`
- `service-packs/naver/apps/naver-blog-api/research/trend-radar/build-vertical-brief.mjs`
- `service-packs/naver/apps/naver-blog-api/research/trend-radar/run-vertical.mjs`
- `service-packs/naver/apps/naver-blog-api/research/trend-radar/run.mjs`
- `service-packs/naver/apps/naver-blog-api/scripts/analyze-editor-scripts.mjs`
- `service-packs/naver/apps/naver-blog-api/scripts/api/publisher-cli.mjs`
- `service-packs/naver/apps/naver-blog-api/scripts/build-editor-contract-candidates.mjs`
- `service-packs/naver/apps/naver-blog-api/scripts/cli.mjs`
- `service-packs/naver/apps/naver-blog-api/scripts/credential-cli.mjs`
- `service-packs/naver/apps/naver-blog-api/scripts/editor-contracts-cli.mjs`
- `service-packs/naver/apps/naver-blog-api/scripts/editor-surface-discovery.mjs`
- `service-packs/naver/apps/naver-blog-api/scripts/gates/authorize-api-update.mjs`
- `service-packs/naver/apps/naver-blog-api/scripts/gates/authorize-publisher-job.mjs`
- `service-packs/naver/apps/naver-blog-api/scripts/gates/build-api-only-boundaries.mjs`
- `service-packs/naver/apps/naver-blog-api/scripts/gates/validate-api-only.mjs`
- `service-packs/naver/apps/naver-blog-api/scripts/gates/validate-claim-evidence.mjs`
- `service-packs/naver/apps/naver-blog-api/scripts/gates/validate-commercial-snapshot.mjs`
- `service-packs/naver/apps/naver-blog-api/scripts/gates/validate-publisher-job.mjs`
- `service-packs/naver/apps/naver-blog-api/scripts/gates/validate-publisher-result.mjs`
- `service-packs/naver/apps/naver-blog-api/scripts/gates/validate-workflow-run.mjs`
- `service-packs/naver/apps/naver-blog-api/scripts/hybrid/publisher-cli.mjs`
- `service-packs/naver/apps/naver-blog-api/scripts/naver-login-cli.mjs`
- `service-packs/naver/apps/naver-blog-api/scripts/naver-publisher-server.mjs`
- `service-packs/naver/apps/naver-blog-api/scripts/naver-session-health.mjs`
- `service-packs/naver/apps/naver-blog-api/scripts/publisher-direct.mjs`
- `service-packs/naver/apps/naver-blog-api/scripts/read-discovery.mjs`
- `service-packs/naver/apps/naver-blog-api/tools/discovery/compiled-create-probe-cli.mjs`
- `service-packs/naver/apps/naver-blog-api/tools/discovery/editor-worker.mjs`
- `service-packs/naver/apps/naver-blog-api/tools/discovery/frontier.mjs`
- `service-packs/naver/apps/naver-blog-api/tools/discovery/headless-create-probe-cli.mjs`
- `service-packs/naver/apps/naver-blog-api/tools/discovery/naver-encrypted-handoff.mjs`
- `service-packs/naver/apps/naver-blog-api/tools/discovery/naver-login-bootstrap.mjs`
- `service-packs/naver/apps/naver-blog-api/tools/discovery/naver-login-http-handoff.mjs`
- `service-packs/naver/apps/naver-blog-api/tools/discovery/naver-login-identity-handoff.mjs`
- `service-packs/naver/apps/naver-blog-api/tools/discovery/naver-ncaptcha-node-probe.mjs`
- `service-packs/naver/apps/naver-blog-api/tools/discovery/private-create-probe-cli.mjs`
- `service-packs/naver/apps/naver-blog-api/tools/discovery/repair-published-prefix.mjs`
- `service-packs/naver/apps/naver-blog-api/workflows/adaptive-publish/run.mjs`
- `service-packs/naver/apps/naver-blog-api/workflows/affiliate-content-e2e/run.mjs`
- `service-packs/naver/apps/naver-blog-api/workflows/model-compare/run.mjs`
- `service-packs/naver/apps/naver-blog-api/workflows/republish/adaptive-article-review.mjs`
- `service-packs/naver/apps/naver-blog-api/workflows/republish/run.mjs`
- `service-packs/naver/scripts/cli.mjs`
- `service-packs/naver/tools/discovery/frontier.mjs`
- `service-packs/ontology/scripts/verify-live.mjs`
- `service-packs/ontology/src/rental-housing/molit-notices.mjs`
- `service-packs/ontology/src/rental-housing/policy-briefing.mjs`
- `service-packs/ontology/src/rental-housing/public-notices.mjs`
- `service-packs/ontology/src/travel-price/collect-live.mjs`
- `service-packs/social-x/scripts/collect-official.mjs`
- `service-packs/social-x/scripts/collect-reddit.mjs`
- `service-packs/social-x/scripts/discover.mjs`
- `service-packs/social-x/scripts/session-run.mjs`
- `service-packs/social-x/src/cli.mjs`
- `service-packs/threads/threads-xhr.mjs`
- `service-packs/tistory/scripts/cli.mjs`
- `service-packs/tistory/scripts/client.mjs`
- `service-packs/tistory/scripts/event-logger.mjs`
- `service-packs/tistory/scripts/media-cli.mjs`
- `service-packs/tistory/scripts/request.mjs`
- `service-packs/tistory/tools/session-handoff.mjs`

## 확장 및 스크립트의 선언된 실행 참조

- `service-packs/affiliate/apps/affiliate-api-hub/scripts/coupang-page-probe.js` — powershell_relative_js_reference; declared by `service-packs/affiliate/apps/affiliate-api-hub/scripts/probe-coupang-page.ps1`; source present: true
- `service-packs/affiliate/apps/affiliate-api-hub/tools/coupang-browser-probe-extension/background.js` — browser_extension_service_worker; declared by `service-packs/affiliate/apps/affiliate-api-hub/tools/coupang-browser-probe-extension/manifest.json`; source present: true
- `service-packs/naver/apps/naver-blog-api/tools/naver-publisher-extension/background.js` — browser_extension_service_worker; declared by `service-packs/naver/apps/naver-blog-api/tools/naver-publisher-extension/manifest.json`; source present: true

## 브라우저와 UI 의존 검토 후보

문자열·정적 선언 검출이며 반복 HTTP 경로에 실제로 남아 있다는 증명은 아니다.

- `lib/playbook-audit.mjs` (cdp_reference, native_ui_reference)
- `service-packs/affiliate/apps/affiliate-api-hub/scripts/capture-coupang-search-products.ps1` (native_ui_reference)
- `service-packs/affiliate/apps/affiliate-api-hub/scripts/probe-coupang-page.ps1` (native_ui_reference)
- `service-packs/affiliate/apps/affiliate-api-hub/tools/coupang-browser-probe-extension/background.js` (chrome_extension_debugger_reference)
- `service-packs/naver/apps/naver-blog-api/run-editor-discovery.ps1` (browser_import)
- `service-packs/naver/apps/naver-blog-api/run-editor-surface-discovery.ps1` (browser_import)
- `service-packs/naver/apps/naver-blog-api/scripts/hybrid/editor-preview.mjs` (browser_import, browser_launch_reference)
- `service-packs/naver/apps/naver-blog-api/scripts/hybrid/headless-inputs.mjs` (browser_import, browser_launch_reference)
- `service-packs/naver/apps/naver-blog-api/tools/discovery/authorized-session.mjs` (browser_import, cdp_reference)
- `service-packs/naver/apps/naver-blog-api/tools/discovery/create-mp4-fixture.mjs` (browser_import, browser_launch_reference)
- `service-packs/naver/apps/naver-blog-api/tools/discovery/headless-auth.mjs` (browser_import, browser_launch_reference)
- `service-packs/naver/apps/naver-blog-api/tools/discovery/interactive-auth.mjs` (browser_import, browser_launch_reference)
- `service-packs/naver/apps/naver-blog-api/tools/discovery/video-native-contract.mjs` (browser_import, browser_launch_reference)
- `service-packs/naver/apps/naver-blog-api/tools/discovery/video-upload-capture.mjs` (browser_import, browser_launch_reference)
- `service-packs/naver/apps/naver-blog-api/tools/discovery/video-upload-completion-capture.mjs` (browser_import, browser_launch_reference)
- `service-packs/naver/apps/naver-blog-api/tools/discovery/video-upload-observe.mjs` (browser_import, browser_launch_reference)
- `service-packs/naver/apps/naver-blog-api/tools/naver-publisher-extension/background.js` (chrome_extension_debugger_reference)
- `service-packs/naver/apps/naver-blog-api/workflows/model-compare/run.mjs` (browser_launch_reference)
- `service-packs/tistory/scripts/event-logger.mjs` (cdp_reference)
- `service-packs/tistory/scripts/legacy/capture.mjs` (cdp_reference)

## 누락 참조

- `lib/inpock-card-management.mjs` (AUDIT_FILE_MISSING)
- `lib/inpock-collections.mjs` (AUDIT_FILE_MISSING)
- `lib/inpock-content.mjs` (AUDIT_FILE_MISSING)
- `lib/inpock-media.mjs` (AUDIT_FILE_MISSING)
- `lib/retail/ebay-catalog.mjs` (AUDIT_FILE_MISSING)
- `tests/inpock-card-management.test.mjs` (AUDIT_FILE_MISSING)
- `tests/inpock-collections.test.mjs` (AUDIT_FILE_MISSING)
- `tests/inpock-content.test.mjs` (AUDIT_FILE_MISSING)
- `tests/inpock-media.test.mjs` (AUDIT_FILE_MISSING)
- `tests/retail-ebay-catalog.test.mjs` (AUDIT_FILE_MISSING)
- `verification/inpock-profile-edit-live.json` (AUDIT_FILE_MISSING)

## 조사 오류
