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

## Runbook (v2, Tokyo 2026-10-22) — use this, not a one-off builder

The owner asked for it to be a playbook ("플레이북으로 안해놨나 매번 이래야해 ?"). Per episode you write two JSON files and run:

1. **Spec** `data/<ep>-shorts/shorts.spec.json`: `plan` (aihost plan.json), local `video`, `fontFile`, `label`, `pictureCrop`,
   render repo/releases, and `shorts[]` = `{ id, scenes[], out?, title:[line1 with creator name, line2], patches?, blur? }`.
   Pick whole plan scenes (a scene = Ria's dialogue shot + its narration), 30–55 s each.
2. `node scripts/longform-to-shorts.mjs plan <spec>` → `build <spec>` (fails on any glyph missing from the font) →
   `still <spec> <id> 0.6,<mid>` and look at the frames (title band, captions inside the safe zone, cards not cut).
3. `node scripts/longform-to-shorts.mjs kit <spec> <branch>` pushes the kit and prints the job text →
   `node scripts/dots.mjs send <dots.roomId> "<job>"` (Dots ran the ffmpeg-only job in ~6 min; Grok Bot as fallback).
4. Download the release, check every file: ffprobe (1080x1920, 30 fps, dur ±0.1 s, 48 kHz 2 ch), the **last 12 frames**
   (title present, no next-scene caption), and every map pill / card in the cuts (Tokyo shipped `undefined 11분` on a kart leg).
5. **Manifest** `data/<ep>-shorts/distribute.json` (titles, desc, question, hashtags, links per short; longform URL + related
   title; Naver blog title; schedule) → `node scripts/shorts-distribute.mjs <manifest>`:
   YouTube upload (s1 public, rest one per day 오후 6:00) + thumbnail + related long video, Naver Clip ×all, TikTok ×all,
   Instagram 1/day. State goes to `distribute.state.json`; **the daily follow-up is the same command** (pins each Short once it
   is public, posts the next Reel).

**The long video goes to Naver Clip too** (2026-10-22): a 10:01 horizontal 16:9 MP4 of 492 MB was accepted as an ordinary clip
(no length/ratio warning; covers are offered as vertical crops). Same command: `naver-clip-upload.mjs final.mp4 desc.txt --blog=… --ai`.

**Instagram takes the long video as a Reel too** (2026-10-22): `instagram-web-post.mjs caption.txt final.mp4 --ratio=원본 --ai`
(10:01, 492 MB, "공유 중" for ~4 min, then "릴스가 공유되었습니다"; the script now waits by file size).

Helper scripts it calls: `youtube-studio.mjs upload`, `youtube-studio-edit.mjs` (thumb/desc/related, readback),
`youtube-pin-comment.mjs`, `naver-clip-upload.mjs`, `tiktok-studio-upload.mjs`, `instagram-web-post.mjs`; `cdp-steps.mjs` for
one-off manual steps in a tab.

Tokyo pitfalls (all handled by the scripts now): Black Han Sans lacks 「」·… (system Noto Sans shadowed Noto Sans KR on the
cloud box); the longform crossfade shows the next scene in the last 0.3 s (hold the last frame); the file is one frame longer
than the cut (persistent ASS lines run past the end); a next-scene caption overlapping < 0.3 s flashed; Studio's schedule check
read only innerText (time is an input value) and left two videos as drafts; Shorts thumbnails are set on the edit page after
upload; the 관련 동영상 picker sometimes renders late (retry); TikTok Shift+Enter submits a comment, its web comment menu has no
pin, and 게시 asks "계속 게시할까요?" while checks run.

## Our pipeline v1 (`scripts/longform-to-shorts.mjs`, Bangkok 2026-10-19; superseded by the runbook above)

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

## Publishing rules learned 2026-10-19 (owner)

- **Lead with the source creator's name.** Put it in the hook band, the Shorts or clip title and the first line of the description: "곽범이 간 …", "곽범 방콕 하루 …". A generic hook ("이 야시장 이사했다") misses the search and click value of the creator's name; v1 was redone as v2 for this reason.
- **Fonts:** Black Han Sans has no 「」 or ▶ glyphs, so keep those out of drawtext. Captions wrap to 3 lines and long sentences get cut off; split long sentences or shorten them.
- **Naver Clip:** `scripts/naver-clip-upload.mjs <mp4> <desc.txt> --ai --blog=<title part> [--draft]`.
  - The AI switch is `button[class*=Toggle_toggle]` inside the "AI 활용 설정" module item. When on, its class contains `toggleOn`. The hidden checkbox inputs belong to other controls; clicking them ticked "등록 예약".
  - Delete a clip from the row's ⋮ menu → 삭제 → confirm.
- **YouTube Shorts:** `youtube-studio.mjs upload` with `"visibility":"PUBLIC"`.
  - The upload dialog links `youtube.com/shorts/<id>`, not youtu.be.
  - The final dialog for a public video is "동영상 처리 중" (public once SD is ready).
  - Link the long video afterwards in the edit page: 관련 동영상 → pick by title → 저장.
- **Threads:** video posting is not supported by Grok Bot's web writer (upload only). Use images on Threads.

## Instagram (new account @lifehack_ailab, 2026-10-19)

- **Old account:** @lifehack__ailab on Instagram is deactivated. The new account is @lifehack_ailab, linked in the same Meta Accounts Center as the owner's personal account.
- **Login:** log in as the personal account first. Then 전환 → lifehack_ailab, enter the password (DPAPI `instagram-login`), then the email code from Gmail ("Verify your profile"; use the newest code), then 정보 저장.
  - A brand-new account first shows a consent sheet with 4 [필수] toggles; switch them on and press 동의함.
- **Session:** `node scripts/meta-session-from-canary.mjs` stores it in DPAPI `instagram-auth-session`, verified with the owner read `/api/v1/accounts/edit/web_form_data/`.
  - This is an optional external integration, not a bundled session adapter. Set `ACO_ROOT` to an `affiliate-content-operations` checkout, or keep that checkout beside this repository. Missing helper dependencies are reported before browser or credential operations; see [portability](portability.md#선택형-외부-연동).
  - In ACO `meta-auth-session.mjs`, the Instagram `expectedOwner` is now `META_INSTAGRAM_OWNER || 'lifehack_ailab'`. Threads stays `lifehack__ailab`.
- **Posting:** `node scripts/instagram-web-post.mjs caption.txt <files…> [--ratio=4:5] [--ai]`.
  - Several images make a carousel; a single MP4 makes a Reel (9:16 crop).
  - The first Reel shows a "이제 동영상 게시물이 릴스로 공유됩니다" sheet; press 확인.
  - Success text: "게시물이 공유되었습니다" or "릴스가 공유되었습니다".
  - Closing the dialog before sharing triggers "게시물을 삭제하시겠어요?".
- **Carousel cards:** 1080×1350 on a dark background, with a title strip (Black Han Sans; no ①–⑥ or ·) and an "n/10" page marker.
- **Bio:** accounts/edit, `textarea#pepBio`, then 제출. Web links in the bio are plain text, not clickable.
