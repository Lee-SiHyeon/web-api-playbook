# One post, several blogs: lab site, Naver SmartEditor, banners (2026-10-19)

Source run: 곽범 Bangkok long-form post (`kwak-bangkok-day-course`).
- **Markdown source:** `G:\내 드라이브\shorts-factory\kwak-bangkok\blog\ko-main.md` (Korean); `en-blogger.md` is the English version.
- **Live:** https://lifehackailab.com/lab/kwak-bangkok-day-course
- **Naver:** https://blog.naver.com/aicandoanything/224446172611
- **Tistory:** https://i-never-stop-study.tistory.com/263 (HTML mode, full notebook design)
- **Blogger:** https://everyintheworld.blogspot.com/2026/10/a-korean-comedians-one-day-bangkok.html (HTML view, CodeMirror `setValue`)

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
  - **Token:** DPAPI `lab-hub-import-token` (JSON `{token}`). Read it with ProtectedStore and pass it only through the child process env.
  - **Refresh the token** (only when the import says it is invalid). Run from the linked project `C:\Users\sihyeon\dev\lifehackailab-web`:
    `npx vercel env pull <scratch>\lab.env --environment=production --yes --global-config C:\Users\sihyeon\AppData\Local\lifehack-cloud-ops\vercel`.
    Then write `HUB_IMPORT_TOKEN` to DPAPI and delete the env file.
  - Without `--global-config` the CLI is not logged in and waits for a login that never comes. On 2026-10-21 the blog agent stalled there twice.
    Check the login with `npx vercel whoami --global-config …`.
- **Re-import:** use the same `published-at` and a newer `updated-at`. The script picks `updated` from job.publishedAt, which must not be earlier than published, otherwise `LAB_REVISION_TIMESTAMP_INVALID`.
- **`LAB_PUBLIC_READBACK_UNVERIFIED` while the import itself succeeded:**
  - **Cause:** the site has the Vercel Security Checkpoint on. Every non-browser client, curl with a browser UA included, gets **429** with `<title>Vercel Security Checkpoint`.
  - **Workaround:** verify in Canary instead: title, `[data-testid=lab-body]`, images loaded after scrolling (lazy), the YouTube nocookie iframe, `data-updated-at`.
  - **Resolved 2026-10-19 (final state, firewall version 15):**
    - The cause was the managed rule `bot_protection` with action `challenge`.
    - The challenge stays on for everyone. A custom rule **"Allow lifehack operator IP"** `bypass`es only `ip_address eq 220.86.121.120`, the automation PC's public IP. The script readback, curl and Canary from this PC all get 200.
    - **If the ISP changes the IP:** check it with `curl https://api.ipify.org` and update that rule (`rules.update`, or delete and insert).
    - **API:** `PATCH /v1/security/firewall/config?projectId=…&teamId=…` with `{"action":"rules.insert","value":{name,description,active,conditionGroup:[{conditions:[{type:"ip_address",op:"eq",value:"<ip>"}]}],action:{mitigate:{action:"bypass"}}}}`. The Vercel token is the CLI one in `lifehack-cloud-opserceluth.json`; never print it.
    - **Cloud runners (GitHub Actions, Dots):** they have no fixed IP. Give them a header-secret bypass rule instead, with the secret kept in DPAPI or Actions secrets.
    - (An interim fix, `bot_protection` set to `log`, was reverted in favour of the IP rule.)

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

### After the paste: images, cover, banner links, AI label (each verified on the published post 224446172611)

- **Remote images leave the post without a cover.** Pasted `<img src="https://…">` stays hot-linked: the post shows in the list with no thumbnail and no og:image (owner noticed on mobile).
  - **Fix:** open `postwrite?logNo=<no>` and run `node scripts/naver-se-replace-images.mjs <tab> order.txt <imgDir>`.
  - Per image it selects the component, clicks 교체 ("사진 교체"), intercepts the chooser and feeds the local file. Each image becomes `blogfiles.pstatic.net`.
  - The first image becomes 대표 (`.se-set-rep-image-button.se-is-selected`), and `og:image` becomes the cover.
  - Run it from Node: a bash loop mangled a Korean path, and the resulting "파일 전송 오류" popup silently blocked every later chooser.
- **`<a href><img></a>` loses its link on paste.** Set it afterwards with `node scripts/naver-se-image-links.mjs <tab> 5=https://… 9=https://…`, using the image toolbar's link button and the `.se-custom-layer-link-input` field, then Enter.
  - In the editor the link only shows as `.se-image-link-icon`; the URL appears in the published HTML.
- **Each image has an "AI 활용 설정" toggle** (Naver asks AI-made content to be labelled).
  - On = `.se-set-ai-mark-button-toggle` has `se-is-selected`. The same class on the wrapper means nothing.
  - **교체 resets it**, so `naver-se-image-links.mjs` turns it back on for every image at the end.
- **Quotation style:** select the quotation, then click `button[data-value=quotation_line]`. The values are default, line, bubble, underline, postit and corner.
- **Font:** click a body paragraph and press Ctrl+A twice, open 서체 변경, then click `button[data-value=nanummaruburi]`. On this post that covered 17 of 26 text-bearing components.
- **Republish:** `naver-se-paste.mjs publish <blogId> --confirm` on the edit tab. Category and tags persist.
- **Categories:** Naver now has 여행·숙소 > 태국 (categoryNo 15), alongside Tistory's 여행 > 태국. The 여행·숙소 name stays because publication-channels routing uses it.
  - **Adding a country:** open admin.blog.naver.com/<id>/config/blog. Select 여행·숙소 *first*, then click 카테고리 추가; the new item is created as its child. Type the name into the frame input (`#papermain` contentDocument, value "게시판"), press Enter, then 확인.
  - **Trap:** opening `AdminCategoryView.naver` standalone (outside the admin frame) shows the same form, but 확인 does not persist.
  - **Moving a post:** publish panel, then `--category=태국`. The option renders as "ㄴ 태국"; the script normalises that.

### Pitfalls

- **Title before body:** type the title, then press Enter. Clicking the body placeholder after a long title can land in the title, and the whole body is pasted into the title.
- **File encoding:** write the title and HTML files as UTF-8 from Node or Python. Text through the Windows console (cp949) arrives as `�`.
- **Draft dialog:** "작성 중인 글이 있습니다" appears whenever an autosave exists. 취소 starts fresh; 확인 continues the draft.
- **Category:** open the dropdown and click the item's `<label>`. Clicking the visible span looked selected but did not stick.
- **Tags:** one `insertText` + Enter per tag, 30 at most.

## Tistory (Kakao login, HTML mode)

- **Login:** in Canary go to tistory.com/auth/login, choose "카카오계정으로 로그인", then run `node scripts/kakao-login-fill.mjs <tab>`.
  - It reads the identity from the playbook ProtectedStore key `tistory-kakao-login`, saved 2026-10-19 for hyeon0528@nate.com.
  - Kakao then asks for **2-step verification through KakaoTalk**, and the owner has to approve it on the phone. Tick "이 브라우저에서 2단계 인증 사용 안 함" first so this browser is not asked again.
  - After approval comes a consent page; press 계속하기.
- **Design:** `node scripts/blog-tistory-html.mjs post.md urlmap.json out.html --youtube=<id>` renders the full notebook design in inline CSS: dark heading bars with a mustard border, highlighter bold, cream list cards, rounded tables, pill CTA buttons and a responsive YouTube iframe. All of it survived publishing.
- **HTML mode:** "기본모드 → HTML" raises a **native `confirm()`** dialog that freezes CDP evaluation. Enable `Page` and answer `Page.javascriptDialogOpening` with `handleJavaScriptDialog({accept:true})`; `scripts/tistory-html-input.mjs` does this.
- **Body input:** **`CodeMirror.setValue()` published an EMPTY body.** Type the HTML instead: focus, `execCommand('selectAll')`, then `Input.insertText(html)` (22 KB went in one call).
- **Publish layer:**
  - Upload the cover through "대표이미지 추가" (intercepted chooser). og:image then becomes the kakaocdn copy.
  - Choose 공개, set 홈주제 to 해외여행, then press 공개 발행.
  - **Category: 여행 > <country>** (owner 2026-10-19: "여행카테고리 만들고 국가로 나눠"). The tree is 여행 (topic 여행·맛집) > 태국. For a new country: open manage/category, press 추가 on the 여행 row, name the country, choose 여행·맛집, press 확인, then 변경사항 저장.
  - To move a post without touching its HTML, use manage/posts: tick the post, open 변경 and pick the category there. Re-saving through the editor risks the body.
  - The editor keeps at most 10 tags.
- **Verify:** open the post in the browser, scroll it (images are lazy) and check `.contents_style` for text length, loaded images, `a[href*=myrealt]` and the iframe. Here that gave 4,053 chars, 15/15 images, 17 links, the YouTube embed and 9 heading bars.

## Blogger

- In the new-post screen open the mode menu, choose "HTML 보기", and set the body with `document.querySelector('.CodeMirror').CodeMirror.setValue(html)`. Unlike Tistory this persisted.
- Type the title into the 제목 input and the labels as a comma list, then press 게시 and confirm.
- Read back from the feed: `/feeds/posts/default?alt=json`. It shows the post URL and that a thumbnail exists.

## Affiliate banners

- MyRealTrip offers no banner or widget API (the partner endpoints are link creation, flight landing, reservations and sales). Banners are our own images wrapped in the mylink.
- **Template:** `templates/affiliate-banner/notebook-banners.example.html`. It's a detective-notebook theme: cork board, taped polaroid, lined paper card, mustard kicker, red stamp, CTA, and a "제휴 링크 · 수수료 지급 가능" note. The size is 1200×400. Asset paths are relative to the HTML file.
- **Capture:** `node scripts/html-capture.mjs banners.html outDir flight,tour,market,hotel`
- **Content rules:**
  - Keep prices off banners, since they change. Keep the disclosure on every banner.
  - Use only our own or AI images, and label AI images.
  - Keep the CTA and the disclosure from overlapping: the first version hid the disclosure behind the CTA, so the disclosure was shortened.
