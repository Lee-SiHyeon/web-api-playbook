# Long-form → Shorts / Clips (research + pipeline, 2026-10-19)

## Open-source references

Researched 2026-10-19; star counts as seen then.

| repo | ★ | licence | highlight pick | reframing | offline |
|---|---|---|---|---|---|
| [mutonby/openshorts](https://github.com/mutonby/openshorts) | 6.8k | MIT (except cloud/) | faster-whisper + Gemini or an OpenAI-compatible LLM | TRACK (MediaPipe+YOLOv8) / GENERAL (blur) / SPLIT | partly (`LLM_BASE_URL` can point at a local LLM) |
| [Anil-matcha/AI-Youtube-Shorts-Generator](https://github.com/Anil-matcha/AI-Youtube-Shorts-Generator) | 5.5k | MIT | faster-whisper + LLM | OpenCV face tracking | needs an OpenAI/Gemini key |
| [zhouxiaoka/autoclip](https://github.com/zhouxiaoka/autoclip) | 9.5k | MIT | uses creator subtitles if present; Ollama/local LLM | — | can run locally; fits SRT input |
| [jipraks/yt-short-clipper](https://github.com/jipraks/yt-short-clipper) | 1.0k | MIT | subtitle track, word-level captions | MediaPipe or blur/letterbox | LLM key; Windows beta |
| [mutonby/shortcast](https://github.com/mutonby/shortcast) | 390 | Apache-2.0 | on-device LLM (Gemma) reads the whole transcript | face crop | fully offline, macOS |

Commercial tools for comparison:
- **OpusClip:** virality score and good reframing, but sometimes cuts mid-sentence.
- **Vizard:** bulk output, multilingual captions.
- **Klap:** the simplest of the three.

**Naver Clip "클립 AI 하이라이트"** (clipcreators.naver.com/web/ai-clip) does this for free inside Naver. The page says: "3분이 넘는 가로형 영상을 업로드하면 여러 개의 세로형 동영상으로 나눌 수 있어요". It has not been tried end to end yet: a plain upload created an ordinary clip draft (draft/1221503), and no project-start control has been found yet.

## Our pipeline (`scripts/longform-to-shorts.mjs`)

We already have a sentence-timed transcript (`timed.ko.json`), so highlight detection is unnecessary.
- **Spans:** pick self-contained sentence spans of 25–55 s, cut on sentence boundaries, and avoid spans that start with "앞서/아까" style back-references.
- **Layout:** for map and motion-graphics footage, face tracking and centre crops lose the content (a centre crop keeps about 20 % of a 16:9 frame). Use a **stacked** layout:
  - hook band at the top (kicker + 2 lines in BHS 128 px, last line mustard)
  - the 16:9 video in the middle, with its burned subtitle band cropped off (`cropSubtitleBand` [0, 880] of 1080)
  - large captions re-timed from the transcript below it, one sentence at a time, wrapped at 13 characters
  - brand line at the bottom
  - an end card over the last 2.5 s ("전체 코스는 / 롱폼 영상에서 / lifehackailab.com")
- **Fonts:** Black Han Sans has no ▶ glyph, so keep symbols out of drawtext.
- **Commands:**
  - `plan` shows spans and sentence counts.
  - `still <id> <sec>` renders 1.2 s and keeps the last frame. A single-frame grab can come before the first video frame and shows a black middle.
  - `render` produces the MP4s. Run it in the cloud (Dots / longform-render): the owner's rule is no rendering on this PC.
- **ffmpeg path:** a relative `ffmpeg` path in spec.json resolves against the spec file. An unresolved path had made spawnSync fail silently, so `r.error` is now checked.

First use: the kwak-bangkok kit is on the longform-render v3 branch, commit 3882cf9 (`shorts/`).
- A "이 야시장 이사했다", 24.5 s
- B "30초 총정리", 33.8 s
- C "이싼 식당 일요일 주의", 29.7 s

## Platform notes

- **YouTube Shorts length:** up to 3 minutes, and vertical. Link a Short to the long video through Studio's **related video** field (desktop). Links in Shorts descriptions and comments are not clickable.
- **Reused-content policy:** clips need commentary or transformation. Templated mass production risks the "inauthentic content" policy.
- **Naver Clip upload:** clipcreators.naver.com, then 업로드 → 동영상 업로드 → 파일 선택 (native chooser; intercept it). The upload goes through a resumable step (0 %→100 %, about 3 min for 290 MB), then the draft opens.
  - Description: 300 characters max, required.
  - Cover: one of 6 auto frames, or upload your own.
  - 1st/2nd-level category: required.
  - AI 활용 toggle and 광고·협찬 toggle.
  - 정보 태그: place, shopping, …, up to 5.
  - **콘텐츠 링크:** a 블로그 / 네이버TV / 뉴스 link attaches the Naver post.
  - 재생목록; visibility 전체 공개 / 예약 / 비공개 예약; country; comments.
  - 임시저장 / 등록.
  - Leaving the draft page raises a beforeunload confirm that blocks CDP evaluation until it is answered.
