# 크리에이터 HTTP와 브라우저 보조 도구

shorts-anatomy의 재사용 가능한 helper입니다. 각 실행 파일의 --help는 인증값을 읽거나 요청하지 않습니다.

| 파일 | 기능 | 실행 경계 |
|---|---|---|
| tools/gemini-tts.mjs | Gemini 공식 API의 전체 대본 TTS → PCM/WAV | HTTP, gemini-api-key 보호 저장소, 모델·voice·입력·출력 파일 |
| tools/el-api.mjs | ElevenLabs REST | HTTP, elevenlabs-api-key 보호 저장소, METHOD·path·선택 body 파일 |
| tools/mrt-search.mjs | MyRealTrip 검색 문서 | 공개 HTTP, 검색어 |
| tools/mrt-product.mjs | MyRealTrip 상품 문서 | 공개 HTTP, 상품 ID |
| tools/mrt-hotel-find.mjs | 로그인된 탭의 숙소 검색 | browser_automation/CDP |
| aihost/lib/grok-quota.mjs | Grok availability | browser_automation/CDP, 정확한 사용 가능 개수를 보증하지 않음 |
| aihost/lib/grok.mjs | 사용 이력과 관측 availability gate | 로컬 ledger + 위 브라우저 읽기 |
| aihost/lib/flow-accounts.mjs | 크레딧 결과 정리·정렬 | 현재 고정 Flow에는 credits/cdp-handoff가 없어 연결 미완료 |

보호 저장소 import는 이 저장소의 lib/protected-store.mjs로 연결했습니다.
키·쿠키·계정 목록·개인 ledger는 포함하지 않습니다. 이번 이식에서 TTS나 생성 요청을 보내지 않았습니다.
음성은 대본 전체를 한 번에 생성하는 원본 규칙을 유지합니다. 이 helper들의 live replay는 미검증입니다.
