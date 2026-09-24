# Media upload and playback

Target: `https://i-never-stop-study.tistory.com`.

## Observed upload contract

Image upload and ordinary MP4 File-menu upload use `POST /manage/post/attach.json` with `multipart/form-data` and one field named `file`. The response is JSON with `name`, `url`, `key`, `filename`, and `size`. The `url` is a signed reference under `https://blog.kakaocdn.net/dna/...` with temporary query credentials.

Run `scripts/media-cli.mjs` with an absolute local file and a new journal path. The uploader records intent before sending one POST, saves the acknowledgement in DPAPI before parsing it, and independently downloads the asset without account cookies. It verifies status, MIME, binary signature, byte length, and SHA-256. Existing journal paths block resubmission; ambiguous outcomes require reconciliation. The local upload size limit is 10 MiB and is not a claim about Tistory's service limit.

The signed acknowledgement is stored under an opaque `tistory-media-*` DPAPI credential name. `loadStoredMedia(credentialId)` returns it in memory. `nativeImageMarkup()` creates the observed Image CDM 1.3 shortcode, with native caption metadata. `nativeVideoAttachmentMarkup()` creates the observed File shortcode, which is a download card.

## Inline HTML5 playback helper

Tistory's native video-upload service ended on 2026-02-23. A normal MP4 File attachment remains available, but it does not create the retired native player. This package also exports `renderVideo()` and `videoScript` for an HTML5 player around that File shortcode:

```js
import { loadStoredMedia } from './lib/media.mjs';
import { renderVideo, videoScript } from './lib/media-content.mjs';

const attachment = loadStoredMedia(uploadReceipt.credentialId);
const playerMarkup = renderVideo({ attachment, uploadReceipt, caption: 'Short description' });
const content = playerMarkup + '\n' + videoScript;
```

`renderVideo()` accepts only a verified downloadable-video receipt whose source and CDN SHA-256 and byte counts match. It escapes the caption and includes the native file card as a download fallback. The initializer finds the URL rendered by that card when the page loads, then assigns it to the HTML5 `<video>` element only when the URL uses HTTPS and the exact `blog.kakaocdn.net` host. No signed URL is embedded in the initializer. The returned markup still contains a signed URL inside the native File shortcode: keep the complete markup in memory or protected storage, not plaintext logs, evidence, or Git.

The script's origin check is a client-side restriction, not proof that a public player works. Verify actual playback after publication in the intended browser and account for the signed URL's expiry/rotation behavior. Treat upload hash readback, markup insertion, public HTTP rendering, and playback as distinct evidence states.

Official notices: [native video service ended](https://notice.tistory.com/2696), [reiteration](https://notice.tistory.com/2697); external video URL embedding remains supported by policy ([notice](https://notice.tistory.com/2690)).
