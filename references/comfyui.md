# ComfyUI — Comfy Hub 공개 워크플로 + 내 ComfyUI 서버 (읽기 전용)

다른 사람들이 Comfy Hub에 올린 워크플로를 브라우저 없이 검색하고, 워크플로 그래프를 데이터로 받아
"우리 PC에서 공짜로 돌아가는가"를 노드 단위로 판정한다. 내 ComfyUI 서버(루프백)의 상태와 노드 목록도 읽는다.
로그인·쿠키·결제 없음. 워크플로 JSON은 신뢰하지 않는 데이터로 다루며 실행·설치하지 않는다.

## 관측한 계약 (comfy.org/hub/workflows, 2026-11-25)

- 목록: `GET https://comfy.org/models/catalogue.json?section=workflows&format=page&locale=en&audience=public-root`
  - 항목은 `models` 배열(slug, name, author, models, categories, type, href, lastModified)
  - 다음 쪽: `pages.workflows.nextCursor`를 `&cursor=`로 넘긴다(`hasNext`가 false면 끝)
  - 거르기: `q`(이름 검색), `category`(18종, `facets.workflows.categories`), `model`(예: `Wan`, `Flux`), `sort`(`popular`·`newest`·`name`)
  - `format`을 빼면 첫 24개만 담긴 배열이 오고 쪽 넘김이 안 된다. `format=shelves`는 HTML 조각이다.
- 그래프(UI 형식 워크플로 JSON):
  - ComfyUI가 만든 템플릿: `GET https://comfy.org/workflow-graphs/<slug>.json`
  - 커뮤니티 업로드: 위 주소가 404다. 상세 페이지 `/hub/workflows/<slug>/`의 Astro props `workflowFiles[].href`(= `/catalog-media/<uuid>/<uuid>`)를 받는다.
- 라이선스: 그래프 노드의 `properties.models[].url`이 Hugging Face면 `GET https://huggingface.co/api/models/<repo>`의 `cardData.license`·`license_name`. 이름이 바뀐 저장소는 huggingface.co 안에서만 리다이렉트를 따라간다.
- 내 서버: ComfyUI v0.46.3의 `GET /system_stats`, `/queue`, `/object_info`. 주소는 `http://127.0.0.1:8188` 또는 ssh -L 터널 `http://127.0.0.1:18188`만 허용한다.

## 판정 기준 (`hub-workflow`)

노드 종류를 `references/comfyui-core-nodes-v0.46.3.json`(커스텀 팩 없는 v0.46.3 서버의 `/object_info`, 1,086종 중 유료 API 364종)과 대조한다.

- `local-core-only`: 기본 노드만 쓰고 우리 GPU에서 돈다. 비용 0.
- `paid-api-nodes`: 기본 노드지만 외부 유료 모델을 부른다(Gemini·Nano Banana·GPT Image·ByteDance 등). Comfy 크레딧이 든다.
- `needs-custom-nodes`: 제3자 노드 팩이 필요하다. 팩 이름은 노드의 `cnr_id`/`aux_id`. 남의 코드가 PC에서 실행되므로 설치 전에 코드를 읽고 승인을 받는다.
- 모델 라이선스 `commercial`: `false` = 비상업 이름(FLUX dev 계열, CC-BY-NC, research), `null` = 카드에 없음 또는 `other`(사람이 원문을 읽는다). `scan`은 Hub의 모델 이름(Flux.1, Flux.2 Dev, Krea Dev, FLUX.1 Fill, LTX-2, FLUX.3 klein, Qwen-Image 2.1, Krea 2)으로도 거른다. Flux.1 schnell 워크플로도 Hub 이름이 "Flux.1"이라 함께 걸린다(보수적).

## 쓰는 법

```sh
node scripts/comfyui.mjs search --q=character                         # Hub 검색
node scripts/comfyui.mjs search --category=upscale-and-restore --sort=newest
node scripts/comfyui.mjs inspect --slug=restore-old-photos-69850664cf89  # 노드·모델·라이선스 판정
node scripts/comfyui.mjs scan --category=generate-images,edit-images --limit=15 --out=work/comfyui-scan.json
node scripts/comfyui.mjs status --base=http://127.0.0.1:18188          # 내 서버(터널) 상태·VRAM·대기열
node scripts/comfyui.mjs nodes  --base=http://127.0.0.1:18188          # 기본 목록에 없는 노드 = 설치된 커스텀 팩
node scripts/playbook.mjs run --service=comfyui --operation=hub-workflows --input=work/q.json   # {"query":{"q":"icon"}}
```

작업 4개는 모두 `semantics: read`다. 생성(POST /prompt)은 이 팩에 넣지 않았다. 생성은 소유자 쪽 도구(예: shorts-anatomy `studio/lib/genimg/comfy.py`)가 하고, 그 결과는 `/history`·`/view`로 다시 읽어 확인한다.

## 실측 (2026-11-25)

- Hub 7개 분류(sprite-sheets-and-game-assets, generate-images, animate-characters, controlnet-and-tools, upscale-and-restore, edit-images, storyboards), 분류당 최대 15개, 중복 제외 86개: 로컬 코어 31, 유료 API 25, 커스텀 노드 30, 오류 0.
- 커스텀 팩 상위: comfyui-kjnodes 11, comfyui_essentials 9. 유료 노드 상위: GeminiImage2Node 14, GeminiNanoBanana2 5, ByteDance2ReferenceNode 5.
- Hub의 "YouTube thumbnail generator"·"branded thumbnail" 워크플로 2개는 모두 GeminiNanoBanana2(유료)를 쓴다.
- 오프라인 테스트: `node --test tests/comfyui.test.mjs`(합성 응답, 네트워크 없음).

## 한계

- 카탈로그는 비공개 내부 형식이라 바뀔 수 있다. 모양이 바뀌면 `COMFYUI_CATALOGUE_SHAPE_CHANGED`/`COMFYUI_GRAPH_SHAPE_CHANGED`로 멈춘다.
- 노드 판정은 v0.46.3 기준표다. 서버를 올리면 `nodes`로 차이를 보고 기준표를 다시 뽑는다.
- VRAM·속도는 판정하지 않는다. 실제 실행으로 잰다.
