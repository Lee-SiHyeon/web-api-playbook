# Grok Imagine web (grok.com/imagine) - observed 2026-10-20

Script: `scripts/grok-imagine.mjs` (UI automation over CDP 9333). This note records what was observed so the
script and any future direct-HTTP client can be checked against it. Cookie and token values are deliberately not recorded.

## UI contract (Korean UI, aria-labels)

| Control | Selector used | Notes |
|---|---|---|
| Mode | `[role=radio][aria-label="비디오"]` / `"이미지"` | `aria-checked` |
| Attach | toolbar `button[aria-label="업로드"]` opens a picker; picker button with text `업로드` (not `role=tab`) | Uses `Page.setInterceptFileChooserDialog` + `DOM.setFileInputFiles`. Picker stays open after upload: press Escape. |
| Resolution | `button[aria-label="비디오 해상도"]` (Radix menu, opens on mouse press) | items `[role=menuitemradio]`: 480p / 720p / 1080p |
| Duration | `button[aria-label="동영상 길이"]` | items: 6s / 10s / 15s |
| Aspect ratio | `button[aria-label="종횡비"]` | present in text-only mode only (2:3 default). **Absent once an image is attached** (image-to-video). |
| Audio | `button[aria-label="비디오 오디오"]` | toggle; `aria-pressed="true"` by default; toggling flips it |
| Prompt | `[role=textbox]` / contenteditable in the composer | `Input.insertText` |
| Submit | `button[aria-label="제출"]` | |

## Video flow (image -> video)

1. Attach the image through the picker (`s09.jpg`, 1376x768 landscape, uploaded as asset `0a687288-ef04-4c55-a745-5cf0b0f02dc4`).
2. Set resolution / duration / audio. Ratio cannot be set in this mode.
3. Submit. The URL changes to `/imagine/post/<id>`, but **the id is provisional**: in every run the final id
   differed from the first id shown, so the script re-reads the URL on each poll.
4. Progress overlay `생성 중 N%` (2 -> 5 -> 8 -> ... -> 99), then the `<video>` with
   `.../generated/<id>/generated_video.mp4?cache=1` is present and the overlay is gone.
5. Download with the tab's cookies (`Network.getCookies` for the asset URL). Served as `video/mp4`, with `206` range support.

Timing: submit -> media ready 27-32 s (4 runs); whole script run 43-45 s.

## Image flow (text or text + reference)

- Results stay on `/imagine` (no post navigation). Grid images come from `https://imagine-public.x.ai/imagine-public/images/<uuid>.jpg`
  (768x1152 for the default 2:3). Output with `--ref` came back 1888x1056.
- Script detects the first `img` that was not in the page before submit. Submit -> image ready: about 10 s.

## HTTP endpoints seen in the same tab (names, bodies, responses)

- `POST https://grok.com/rest/media/imagine/quota_info` body `{}` -> `{"image":{"available":true,"windowSizeSeconds":64800},"imagePro":{...},"imageEdit":{...},"video":{...},"video720p":{...}}`.
  Availability only, no counts. The UI showed no remaining-credit or usage number anywhere.
- `POST https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig` (grpc-web, empty frame). Not decoded.
- `POST https://grok.com/rest/media/collection/list` body `{"limit":100}` -> `{"collections":[]}`.
- `GET https://grok.com/rest/assets?pageSize=30&mimeTypes=...&fileSources=IMAGINE_SELF_UPLOAD_FILE_SOURCE&fileSources=SELF_UPLOAD_FILE_SOURCE` -> recent uploads.
- `POST https://grok.com/http/upload-file-v2/direct` (picker upload) -> 200 JSON. Request body was not captured by the recorder.
- `GET https://grok.com/rest/assets/<assetId>` -> asset metadata (`mimeType`, `name`, `key`, `fileSource`, ...).
- **Generation:** `POST https://grok.com/rest/app-chat/conversations/new` (Content-Type JSON). Body observed:
  ```json
  {"modelName":"imagine-video-gen",
   "message":"<prompt> --mode=custom",
   "enableImageStreaming":true,"enableSideBySide":true,"sendFinalMetadata":true,
   "responseMetadata":{"experiments":[],"modelConfigOverride":{"modelMap":{}}},
   "mediaGenInput":{"imageToVideo":{"prompt":"<prompt>","inputAssets":["<assetId>"],
                    "aspectRatio":"2:3","duration":6,"resolutionName":"720p","mode":"custom"}},
   "kind":"CONVERSATION_KIND_IMAGINE"}
  ```
  Response is NDJSON, about 12 KB. The first line carries `result.conversation` (`conversationId`, `kind`). The response line echoes
  `metadata.modelConfigOverride.modelMap.videoGenModelConfig` (`aspectRatio`, `resolutionName`, `imageReferences`,
  `isRootUserUploaded`) and then the generated asset. The stream ends after generation (about 30 s).
- `wss://grok.com/ws/imagine/listen` is opened on the Imagine page. Frames were not captured.
- `POST https://grok.com/_data/v1/a/t/`, `/ht/v1/identify`, `/ht/v1/page`, `/api/log_metric`, `/monitoring`: analytics only.

## Observed facts that matter for the script

- **aspectRatio is ignored for image-to-video.** The payload says `"aspectRatio":"2:3"`, but the 1376x768 input produced
  1280x704 h264 (24 fps, 6.04 s, AAC stereo). The output follows the input image, so `--ratio=16:9` is reported as a
  warning and not applied. The UI also hides the 종횡비 control in this mode.
- Audio is on by default (`aria-pressed=true`). The output contains an AAC stereo track.
- Result URLs: `https://assets.grok.com/users/<uid>/generated/<postId>/generated_video.mp4?cache=1`.
  The `<uid>` is the account's user id; it is not recorded here.

## Direct HTTP replay (one attempt, 2026-10-20)

- Replayed `POST /rest/app-chat/conversations/new` with the same body, from Node, using the tab's cookies (in memory only) and
  headers `content-type`, `origin`, `referer`, `user-agent`. No other headers were added.
- Result: HTTP 200, NDJSON, 24 s. It generated `e70016e4-3f88-495b-ba8b-ed9115e293bd`.
  `GET .../generated/e70016e4.../generated_video.mp4?cache=1` with the same cookies returned 200, `video/mp4`, 10,051,998 bytes (`ftyp` box present).
- So the generation call works as a plain HTTP request with cookies. The script still drives the UI, because the
  request contract (asset upload body, progress stream, anti-abuse headers) was only partly captured. One replay costs one generation.

## Verified runs (2026-10-20)

| Run | Mode | Result |
|---|---|---|
| UI, manual | video | 1280x704, 6.04 s, h264 + aac, 11,303,854 bytes |
| script run 1 (post-fix) | video | 1280x704, 6.04 s, 11,159,794 bytes |
| script final | video | 1280x704, 6.04 s, h264 24 fps + aac 2ch, 11,469,407 bytes, elapsed 28 s, total 45 s |
| script | image (text) | 768x1152 jpg, 284,692 bytes, 10 s |
| script | image (--ref s09.jpg) | 1888x1056 jpg, 820,464 bytes, 11 s |
