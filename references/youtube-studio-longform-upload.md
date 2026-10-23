# YouTube Studio long-form upload playbook (2026-10-19)

Browser-assisted: drives Studio's own UI in the logged-in automation Canary (CDP `9333`). Studio's create/publish
requests carry first-party attestation, so replaying them over plain HTTP is not supported
(see `affiliate-content-operations/docs/youtube-video-api-only-2026-09-28.md`). Cookies and tokens never leave the tab.
The Studio UI must be in Korean, because labels are matched as text.

Script: `scripts/youtube-studio.mjs`. Example job: `examples/youtube-studio-job.example.json`.

```
node scripts/youtube-studio.mjs upload   job.json --shots=out/shots   # file → details → A/B → disclosures → schedule
node scripts/youtube-studio.mjs captions job.json --shots=out/shots   # original SRT + per-language title/desc/SRT
```

`upload` prints the `videoId`. Put it into the job's `videoId` before running `captions`.

## Verified run

Verified on 2026-10-19: channel `@lifehack__ailab`, video `tJfj73x5Ti8` (곽범 Bangkok long-form).

| Step | How | Result |
|---|---|---|
| File | `DOM.setFileInputFiles` on the upload dialog's `input[type=file]` | upload started; ID read from the `youtu.be/` link |
| Title, description | `#textbox` [0], [1]: focus, `selectAll`, `Input.insertText` | 45 / 1221 chars |
| A/B test (title + thumbnail) | `ytcp-thumbnail-editor` "A/B 테스팅" → 제목과 썸네일 → `input#file-loader` [1..3] → title 2 → 테스트 설정 | "테스트가 준비되었으며 변경사항을 저장하면 시작됩니다" |
| Audience, disclosures | radio `name` enums: `VIDEO_MADE_FOR_KIDS_NOT_MFK`, `VIDEO_PAID_PRODUCT_PLACEMENT_NOTIFY`, `VIDEO_HAS_ALTERED_CONTENT_YES` | checked |
| Tags | `#tags-container input` + **Enter** (without Enter nothing is committed) | 12 tags |
| Language, category | `#language-input` / `ytcp-form-select#category` → `tp-yt-paper-item` text | 한국어 / 여행/이벤트 |
| Schedule | 예약 → date → time item "오후 6:00" (timezone shows GMT+0900) | "2026년 10월 19일 18:00에 공개" |
| Captions, original language | 자막 수정 → ⋮ → 파일 업로드 → 타이밍 포함 → 계속 (intercepted chooser) → 게시 | "한국어 자막이 게시되었습니다" |
| 8 localizations | 언어 추가 → language → title/desc → 수동 자막 추가 → 변경사항 저장 → 파일 업로드 → 계속 (chooser, retry) → 게시 | each row "1개 게시됨 · 게시됨" |

## Pitfalls (encoded in the script)

- **Caption file input before 계속:** setting the captions `input[type=file]` directly closes the dialog and uploads nothing. Upload through the native chooser that 계속 opens, using `Page.setInterceptFileChooserDialog` and then `DOM.setFileInputFiles({backendNodeId})`.
- **Chooser retry:** for added languages, the first intercepted chooser after 계속 regularly did nothing. Retry until the caption `textarea` rows appear. In this run the second attempt always worked.
- **Original-language "수동 업로드":** the button on the Language page did not replace the auto captions. The editor's ⋮ → 파일 업로드 did.
- **Date picker:** typing a date and pressing Enter keeps the calendar focused, so a time typed next lands in the date field. Type the date, press Escape, then pick the time from the dropdown (15-minute items).
- **Title length:** the 100-character limit also applies to localized titles. Vietnamese and Spanish needed shortening.
- **Burned-in subtitles:** if the video already has burned-in Korean subtitles, the Korean CC track duplicates them when CC is on. It is still useful for search and accessibility. Foreign tracks render above the burned-in line.

## Script coverage

- **Run as the script:** the `captions` original-language path, re-run on `tJfj73x5Ti8`.
- **Done step by step, not yet as the script:**
  - `upload` and the localization loop were done through the same CDP steps on 2026-10-19, one step at a time.
  - The script assembles those steps with text- and enum-based selectors instead of the fixed coordinates used in that run.
  - Run the first real job with `--shots` and review the screenshots.
- **Not covered:**
  - Pinned comment. A scheduled video does not accept comments until it is public, so post it after the publish time.
  - End screens, cards, playlists.
