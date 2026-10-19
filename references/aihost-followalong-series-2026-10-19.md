# AI-host "유튜버 코스 따라가기" long-form series (2026-10-19)

First episode: 곽범 「연차없이 어떡행2」 파리 EP.5–6. Project: `G:\내 드라이브\shorts-factory\kwak-paris\`. A fictional AI host ("리아") walks the creator's route; the creator's footage appears only as stills with source + timecode; the creator's own evaluations are quoted on screen.

## Layout of one episode
- `places.md`: places, timecodes, confirmed/estimated, addresses, prices, sources (research agent)
- `source/`: info.json, auto-subs `.ko*.txt` (timecoded), comments, storyboards. No video download.
- `episodes.json`: `{"EP.5": "<videoId>", …}` so the quote gate reads the right transcript
- `series.json` (series root) or `longform/series.json`: overrides for the gates (creator, minutes, budget …)
- `longform/scenes.json`: title, host, refs (face/body Flow mediaIds), style, outfits, scenes[{id, part, outfit, shot, place, action, kwak, narration, quote{text,tc}, estimated?, hedge?}]
- `longform/kwak-quotes.json|md`: per-place evaluations extracted from the transcript (verdict, rank, confidence, quotes with tc)
- `longform/kf/`: keyframes `sNN.jpg`, `sNN.prompt.txt`, `media-ids.json`, `review.json`
- `longform/map/`: `phone-map.html` (own map UI on OpenFreeMap positron tiles, OSM attribution), `*route.json` (OSRM legs), `shot.mjs`, `serve.mjs`

## Model (host) lock
- Face ref + body ref are both passed as `--reference-media face,body` on every image. Full-body shots drift toward a rounder face; close-ups hold it.
- Flow Nano Banana slims body volume and refuses bikinis; plunging one-piece swimsuits, tube tops, corset tops, cut-outs pass. Exposure ceiling for the series = swimsuit/crop level (age-restriction and recommendation limits on YouTube/Instagram/Naver).
- Prompts always contain "Fictional original person" and "not resembling any celebrity"; age ≥ 20.

## Phone-map transition (owner idea 2026-10-19)
1. Keyframe: over-the-shoulder, she holds a phone showing a map.
2. Capture our map frame `phone-map.html?leg=N&t=0` (1920×1080) → `upload-image` → end media.
3. `generate --start-media <phone> --end-media <map> --duration 4 --resolution 720p` (≈7 credits): camera pushes into the screen and lands on our exact map frame.
4. Cut to the HTML map animation (t: 0→1): route draws, blue dot moves, camera eases out.
- Info goes ON the route (owner: "카드로 하지말고 길 라인에다가"): rotated ETA pill on the longest drawn segment, destination pin with name + creator rank badge + one-line fact. No bottom card. No Google branding/tiles.

## Gates — `shorts-anatomy/tools/aihost-lint.mjs <gate|all> <longformDir>`
| gate | when | checks |
|---|---|---|
| spec | before keyframes | fields, refs, outfit ids, creator name in title and s01, est. minutes within [min,max] |
| facts | before keyframes | every number in narration appears in places.md / kwak-quotes.json / facts.json; estimated places say 추정; price/hours hedge |
| quotes | before keyframes | on-screen quote ≥70 % trigram match with the transcript within ±45 s of tc; no profanity on screen |
| host | before keyframes | exposure/age word lists, required prompt phrases, AI disclosure |
| assets | before video gen | keyframe file + mediaId per scene, review.json |
| map | before render | OSM attribution, no Google brand, route source + complete legs |
| budget | before video gen | scenes × clips × 12 + transitions × 7 ≤ budgetCredits |
| tts | before the single TTS call | spoken form has no digits/latin, quote marks warning, duplicate-generation journal |

`keyframes.mjs` runs spec,facts,quotes,host first and refuses to generate on errors.

First run on Paris found two real issues: a paraphrased quote (s09) and a 2-character quote the trigram check could not score (fixed: short quotes use substring match).

## Compute placement (owner 2026-10-19)
Whisper/alignment, ASR and rendering run in the cloud (GitHub release kit + Dots / Grok bot), never on the 16 GB PC.
TTS with timestamps (ElevenLabs with-timestamps) avoids alignment entirely. Subagent execution: `worker` (haiku).

## Grok Bot as a second cloud worker (checked 2026-10-20 via scripts/grokbot.mjs)
Agent "Grok Bot" (4e7942a3-…): GitHub clone/release download+upload (`gh` logged in as Lee-SiHyeon), Node 20.19, ffmpeg 7.1.5,
headless google-chrome + npm hyperframes, 8 CPU / 15 GB RAM (≈4 GB free) / 107 GB disk, no GPU; foreground commands ≤13 min,
background jobs unlimited. It can run Grok Imagine image→video itself and return the mp4.
Use: `grokbot.mjs send <id> "<task>"` then `wait`. Split work: Dots = long-form render, Grok Bot = shorts / Imagine fallback for
Flow-filtered clips (the grok.com chat route returns slideshows or refusals — do not use it).

## Stage gates (added 2026-10-20 after the owner's review: "게이트 좀 잘 구성해라 — 계속 누락 생기잖아")
Root cause of the omissions: owner decisions lived in chat and each subagent got a partial brief. Fix: every episode has
`longform/requirements.json` (R01…, plan limits, clipAnchors) and `aihost-lint.mjs` now has three stage gates that read it
(`tools/aihost-gates-stage.mjs`):
- `plan`   — before render: no overlay/quote/map over an AI clip, word-synced evidence cues kept (never dropped, on static cuts, not under maps),
  clip starts on its anchor sentence, host never speaks on camera (prompt check) and the intro lines are speech bubbles with the action on the word,
  recap present (length, ≥15 cards, cost card), one card per zone, base-layer coverage, clip block = clip length.
- `output` — on the mp4: 1080p, duration = plan, -14 LUFS, true peak ≤ -1 dBTP, BGM-only tail not louder than programme, no black/frozen frames.
- `release`— before upload: title, descriptions, SRTs (ko + 8), chapters, tags, pinned comment, thumbnails A/B, AI + affiliate disclosure, source link, publish.json aiDisclosure.
Audit of paris-v1 (first render): 49 plan errors (9 quote bubbles and 5 evidence cards over clips, 13 cues dropped under maps, 12 clips off their
sentence, intro stretch 4 s before "끄응", 3 prompts with on-camera speech, no recap), true peak -0.3 dBTP, BGM-only tail 3.5 LU louder than programme.
Run order: pre-gen gates → plan (0 errors) → render → output → release.
