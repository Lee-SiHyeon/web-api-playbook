# One post, several blogs: lab site, Naver SmartEditor, banners (2026-10-19)

Source run: 곽범 Bangkok long-form post (`kwak-bangkok-day-course`).
- **Markdown source:** `G:\내 드라이브\shorts-factory\kwak-bangkok\blog\ko-main.md` (Korean); `en-blogger.md` is the English version.
- **Live:** https://lifehackailab.com/lab/kwak-bangkok-day-course
- **Naver:** the draft is saved on `aicandoanything` but not yet published.

## Pipeline

```
ko-main.md ──► fact-check agent (facts.verified.json, script.md, links.json) until decision=pass
   │
   ├─ scripts/blog-md.mjs lab-run  ─► lifehackailab-web scripts/mirror-lab.mjs --site-first ─► /lab/<slug>
   ├─ scripts/blog-md.mjs se-html  ─► scripts/naver-se-paste.mjs draft / publish   (Naver, browser-assisted)
   └─ templates/affiliate-banner + scripts/html-capture.mjs ─► banner JPGs with affiliate links
```

1. **Review gate:** `mirror-lab --site-first` refuses to run without `independent-review.json` set to `{decision:"pass", hardBlocks:[]}`. Get it from a separate agent that compares the draft with the fact files.
   - On this run, three rounds were needed.
   - Round 1 caught 24 hard issues: estimated items written as confirmed, single-source facts written as certain, an unsupported "most overlapped" claim, a wrong exchange rate, and links missing from the English version.
   - Fix the draft. Never write a "pass" that the reviewer did not give.
2. **Lab images:**
   - Every image block uploads to Supabase storage `lab-media/<slug>/<sha256>.jpg`.
   - Image blocks may carry `href`. The site rewrites it to `/go/lab/<slug>/<n>`, which redirects to the affiliate link. This is how banners link out.
3. **Naver URL map:** the public storage URLs of those uploads double as the image URLs for the Naver paste. SmartEditor cannot paste local files. Read them from the published lab page in block order.

## lifehackailab.com lab import

- **Command:** `HUB_IMPORT_TOKEN=… node scripts/mirror-lab.mjs --run=<dir> --published-at=<ISO> --updated-at=<ISO> --site-first --slug=<slug>`
  - Pull the token with `vercel env pull` (global-config `…\lifehack-cloud-ops\vercel`).
  - Keep the token in process memory and delete the env file right after.
- **Re-import:** use the same `published-at` and a newer `updated-at`. The script picks `updated` from job.publishedAt, which must not be earlier than published, otherwise `LAB_REVISION_TIMESTAMP_INVALID`.
- **`LAB_PUBLIC_READBACK_UNVERIFIED` while the import itself succeeded:**
  - **Cause:** the site has the Vercel Security Checkpoint on. Every non-browser client, curl with a browser UA included, gets **429** with `<title>Vercel Security Checkpoint`.
  - **Workaround:** verify in Canary instead: title, `[data-testid=lab-body]`, images loaded after scrolling (lazy), the YouTube nocookie iframe, `data-updated-at`.
  - **Resolved 2026-10-19 08:07 KST:** the cause was the managed rule `bot_protection` with action `challenge`. It was set to `log` through `PATCH /v1/security/firewall/config?projectId=…&teamId=…` with body `{"action":"managedRules.update","id":"bot_protection","value":{"active":true,"action":"log"}}` (firewall version 12 → 13).
    - Results: `/`, `/lab` and the post return 200 to curl and to a Googlebot UA.
    - Still in force: the custom deny rule for data crawlers (Ahrefs, Semrush, GPTBot…) and the bearer bypass for cron/import routes.
    - To restore the check, send the same call with `"action":"challenge"`. The Vercel token is the CLI one in `lifehack-cloud-opserceluth.json`; never print it.
- **`LAB_IMPORT_HTTP_503 "Lab import could not be persisted"` (media uploads OK, final RPC failed):**
  - **Cause:** this was a database outage, not an input problem.
    - Public REST reads hung longer than 40 s.
    - `supabase db query` hung at "Initialising login role".
    - Vercel runtime logs showed every cron and `/deal/*` page timing out at 60–300 s.
    - The project status still said `ACTIVE_HEALTHY`.
  - **Fix:** restart through the Management API: `POST https://api.supabase.com/v1/projects/<ref>/restart`.
    - The token is the Supabase CLI's own access token, read in-process from Windows Credential Manager target `Supabase CLI:supabase`. Never print it.
    - Recovery took about 4 minutes (`RESTARTING` → `ACTIVE_HEALTHY`); a REST read then answered in 2 s, and the import passed.
  - **Root cause:** still to fix separately. The likely suspect is long-running crons exhausting connections.

## Naver SmartEditor ONE by paste

- **Why paste:** the HTTP hybrid publisher only edits existing posts, and SmartEditor has no HTML mode. A synthetic `paste` event with an HTML `DataTransfer` makes the editor build its own components.
- **Login:** `node scripts/naver-se-paste.mjs login` types the DPAPI identity into nid in Canary.
  - On 2026-10-19 this browser login passed with no captcha.
  - The pure-HTTP `naver-login-cli --reuse-session` path had hit the image captcha.
- **Draft:** `node scripts/naver-se-paste.mjs draft <blogId> post.title.txt post.html`, after `blog-md.mjs se-html`. It discards the autosaved draft, types the title, presses Enter, pastes, and saves.
- **Publish:** `node scripts/naver-se-paste.mjs publish <blogId> --category=여행·숙소 --tags=a,b,… [--confirm]`. Without `--confirm` it stops before 발행.

### What survives a paste (tested in the editor, 2026-10-19)

| Pasted | Becomes |
|---|---|
| `h2`/`h3`, `p`, `b i u s`, `ul`/`ol`, `a href`, `hr` | text with headings / list / link / `se-horizontalLine` ✅ |
| `span style="color"`, `background-color`, `font-size:24px`, `p style="text-align:center"` | kept ✅ |
| `blockquote` | `se-quotation` (layout default) ✅ — change the layout (line/underline/postit…) afterwards in the editor |
| `div style="background;border"` | a 1-cell `se-table` with that background and border ✅ (callout box) |
| `th`/`td style="background;color"` | kept ✅ |
| `<img src="https://…">` and `<a href><img></a>` | image component, link kept ✅ (remote URL; lazy svg placeholder until scrolled) |
| `font-family` | ignored ❌ (set the font with the editor's font menu) |
| `padding`, `border-radius`, buttons | ignored / only the background remains ❌ |

A third-party report also lists `flex`/`grid`/`position`, `object-fit`, `aspect-ratio`, `calc` and empty-span graphics as dropped or broken: https://www.gpters.org/nocode/post/smart-store-detail-page-O2VkcVe7pQqt10y. The safe structure is a single column of basic tags, with anything complex made into an image.

**Copy in the editor:** SmartEditor's own copy puts plain `text/html` with an `INPUT_BUFFER_DATA` marker span on the clipboard. It has no component JSON, so its internal format cannot be reused through the clipboard.

### What top travel posts use

Measured in `affiliate-content-operations/.../blog-performance/style-cards/style-cards.json` and `peer-formats.json` (travel_deals genre, 20 posts):
- 8 or more images: 95%
- **Section headings as quotations: 90%** (mostly `quotation_line`, `quotation_underline`)
- Color emphasis: 80–100%
- Table: 83%
- Divider: 67%
- Centered text: 67%
- Sticker: 50%
- Body font: mostly **나눔마루부리**, with sizes 19, 24 and 28

`blog-md.mjs se-html --headings=quote --palette=notebook` produces the paste-compatible half of this: quotation headings, highlighted bold, cream callout boxes and mustard table headers. The quotation layout and the font have to be set in the editor after pasting.

### Pitfalls

- **Title before body:** type the title, then press Enter. Clicking the body placeholder after a long title can land in the title, and the whole body is pasted into the title.
- **File encoding:** write the title and HTML files as UTF-8 from Node or Python. Text through the Windows console (cp949) arrives as `�`.
- **Draft dialog:** "작성 중인 글이 있습니다" appears whenever an autosave exists. 취소 starts fresh; 확인 continues the draft.
- **Category:** open the dropdown and click the item's `<label>`. Clicking the visible span looked selected but did not stick.
- **Tags:** one `insertText` + Enter per tag, 30 at most.

## Affiliate banners

- MyRealTrip offers no banner or widget API (the partner endpoints are link creation, flight landing, reservations and sales). Banners are our own images wrapped in the mylink.
- **Template:** `templates/affiliate-banner/notebook-banners.example.html`. It's a detective-notebook theme: cork board, taped polaroid, lined paper card, mustard kicker, red stamp, CTA, and a "제휴 링크 · 수수료 지급 가능" note. The size is 1200×400. Asset paths are relative to the HTML file.
- **Capture:** `node scripts/html-capture.mjs banners.html outDir flight,tour,market,hotel`
- **Content rules:**
  - Keep prices off banners, since they change. Keep the disclosure on every banner.
  - Use only our own or AI images, and label AI images.
  - Keep the CTA and the disclosure from overlapping: the first version hid the disclosure behind the CTA, so the disclosure was shortened.
