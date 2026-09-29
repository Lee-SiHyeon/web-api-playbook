# Browser dependency audit

Audit date: 2026-09-29

## Scope and method

Read-only inspection of maintained code, manifests, skills, sanitized configuration keys, and existing verification receipts under:

- C:\Users\User\Documents\GitHub
- C:\Users\User\Documents\Codex dated workspaces (maintained projects and identified tool checkouts)
- C:\Users\User\.codex\skills and C:\Users\User\Skills
- Selected user-local tool and MCP directories, including tools, apps, chat-home-windows-core, notion-upload, context7-mcp, notion-mcp, .n8n, .webmcp, and .openclaw

No application code or credentials were changed, no workflow was run, and no tests were run. Browser profiles, cookies, credential stores, raw network captures, .env contents, node_modules, and generated/output folders were not opened.

## Classification

- **Browser runtime required:** the normal operation launches or controls Chrome, Chromium, Firefox, or an embedded Chromium/CDP runtime.
- **Browser bootstrap required:** browser is used to establish or restore a session; recurring requests then use HTTP.
- **Hybrid input provider:** browser produces an operation-specific SDK/token/input, followed by a separate HTTP request.
- **Optional discovery or review:** browser is used for inspection, contract capture, visual preview, or local rendering, not every data request.
- **Direct HTTP:** no browser in the recurring operation, with live proof where stated.
- **Unknown:** the relevant implementation or workflow configuration was unavailable or not inspected.

An HTTP request after a browser-generated input is still a hybrid workflow. A browser-rendered 200 is not proof of a direct HTTP replay.

## Confirmed browser dependencies

| Tool or operation | Classification | Findings and evidence |
|---|---|---|
| Naver Blog publishing in the integrated affiliate-content-operations checkout | Browser runtime / hybrid | The SmartEditor publisher extension attaches to Chrome CDP and drives create/update/publish. See [extension manifest](C:/Users/User/Documents/GitHub/affiliate-content-operations/apps/naver-blog-api/tools/naver-publisher-extension/manifest.json:1) and [background publisher flow](C:/Users/User/Documents/GitHub/affiliate-content-operations/apps/naver-blog-api/tools/naver-publisher-extension/background.js:904). |
| Naver Blog publishing in separate API-only and partner-xhr checkouts | Hybrid input provider | New-post input requires a Playwright/Chromium nCaptcha/document SDK envelope; the HTTP writer runs after that browser phase. The implementation reports browserEngineFree=false, and one experiment is private-create-only. See [headless inputs](C:/Users/User/Documents/Codex/2026-09-20/partner-xhr-api/apps/naver-blog-api/tools/discovery/headless-create-probe.mjs:48), [API boundary gate](C:/Users/User/Documents/Codex/2026-09-20/partner-xhr-api/apps/naver-blog-api/scripts/gates/build-api-only-boundaries.mjs:74), and [user-maintained publishing skill](C:/Users/User/Skills/naver-blog-publishing/SKILL.md:43). Saved-session reads and some publisher operations are HTTP, but that does not remove the fresh-input or native-preview browser gates. The separate checkouts differ; treat them as distinct implementations. |
| Naver HTTP crawler and XHR observer in the 2026-09-13 workspace | Browser bootstrap/discovery | [HTTP crawler](C:/Users/User/Documents/Codex/2026-09-13/new-chat/work/naver-http-session.mjs:17) imports cookies through Chrome CDP, then uses Node fetch for reads; the cookie jar is process-only and browserless renewal was not found. [XHR worker](C:/Users/User/Documents/Codex/2026-09-13/new-chat/work/naver-session-worker.mjs:29) needs Chrome CDP to observe network events and cookies, then launches a separate HTTP replay process. |
| Naver Clip upload | Browser runtime required | Upload/token/session/chunk/draft/publish flow remains UI/browser-operated. Profile, list, and progress reads have direct HTTP evidence. See [Clip API-only status](C:/Users/User/Documents/GitHub/affiliate-content-operations/docs/naver-clip-api-only-2026-09-28.md:36). |
| Google Flow video generation | Hybrid input provider | Project/media listing and downloads use direct HTTP. Generate requires a fresh reCAPTCHA Enterprise input from the Flow page; the Node client fails closed before the generation POST when it is missing. See [client guard](C:/Users/User/Documents/GitHub/google-flow-xhr-client/src/client.mjs:48) and [replay receipt](C:/Users/User/Documents/GitHub/google-flow-xhr-client/discovery/api-only-replay-2026-09-27.json:6). |
| YouTube video upload and profile update | Hybrid input provider | Upload bytes/native proof generation require browser-produced inputs; later create/publish/readback steps use HTTP. See [video upload findings](C:/Users/User/Documents/GitHub/affiliate-content-operations/docs/youtube-video-api-only-2026-09-28.md:28) and [profile update findings](C:/Users/User/Documents/GitHub/affiliate-content-operations/docs/youtube-profile-api-only-2026-09-28.md:22). |
| TikTok private video publishing | Hybrid input provider | The web page supplies a short-lived signed request and media upload inputs; Node sends them after the browser tab closes. See [TikTok API-only findings](C:/Users/User/Documents/GitHub/affiliate-content-operations/docs/tiktok-api-only-2026-09-28.md:20). |
| Coupang consumer product search in the 2026-09-20 partner-xhr checkout | Browser-dependent capture path | The dated boundary gate calls for portal capture; its PowerShell capture drives an open Chrome window. See [boundary gate](C:/Users/User/Documents/Codex/2026-09-20/partner-xhr-api/apps/naver-blog-api/scripts/gates/build-api-only-boundaries.mjs:66) and [capture script](C:/Users/User/Documents/Codex/2026-09-20/partner-xhr-api/apps/affiliate-api-hub/scripts/capture-coupang-search-products.ps1:29). |
| Coupang consumer search in other checkouts | Not proven browserless | Direct consumer search replay was recorded as HTTP 403 in the shopping collector; the current integrated code has Node HTTP paths, but code presence is not a successful replay. Do not conflate this with Coupang Partners catalog, which has separate HTTP 200 evidence. See [collector status](C:/Users/User/Documents/GitHub/affiliate-content-operations/docs/shopping-collector-status-2026-09-27.md:57) and [Partners receipt](C:/Users/User/Documents/GitHub/affiliate-content-operations/apps/affiliate-api-hub/evidence/coupang-partners-live-replay-2026-09-28.json:3). |
| Coupang Partners dashboard/session | Browser bootstrap, then HTTP | Initial portal cookies are imported from a logged-in browser. Dashboard/search and observed prelogin renewal use HTTP; fully expired recovery is not implemented. See [Coupang session client](C:/Users/User/Documents/GitHub/web-api-playbook/lib/web-auth/coupang.mjs:33). The optional Chrome probe is separate from recurring data access. |
| Codex Remote Launcher | Browser runtime required | The tool attaches to Codex Desktop's embedded Chromium/Electron CDP runtime and evaluates code through it; this is not a normal Chrome-profile dependency. See [CDP client](C:/Users/User/Documents/Codex/2026-09-06/x20/work/codex-remote-launcher/runtime/src/runtime/lib/cdp.js:56) and [launcher](C:/Users/User/Documents/Codex/2026-09-06/x20/work/codex-remote-launcher/src/launcher/CodexLauncher.cs:16). |
| OpenClaw Browsh skill | Browser runtime required | The skill uses Firefox as Browsh's backend. OpenClaw web-search instead uses curl and does not need a browser. See [Browsh skill](C:/Users/User/.openclaw/workspace/skills/browsh/SKILL.md:11) and [search skill](C:/Users/User/.openclaw/workspace/skills/search/SKILL.md:7). |
| CoS browser connection | Browser extension/runtime required | The Windows CoS integration has browser-specific settings and requires its companion extension. See [setup guide](C:/Users/User/Documents/Codex/2026-09-13/windows-windows-mylocalpc-10-159-125/work/cos-setup.md:10) and [browser config](C:/Users/User/Documents/Codex/2026-09-13/windows-windows-mylocalpc-10-159-125/work/cos-config.ts:287). |
| Video, chart, and visual-preview renderers | Local browser runtime, not site access | Playwright/Chromium is used for chart frames, social cards/shorts, native editor previews, and wedding-site QA. Examples: [shorts chart renderer](C:/Users/User/Documents/Codex/2026-09-27/video-strategy/shorts.mjs:160), [social renderer](C:/Users/User/Documents/GitHub/affiliate-content-operations/apps/affiliate-api-hub/scripts/sns/render.mjs:60), [wedding QA](C:/Users/User/Documents/Codex/2026-09-13/wedding-developer/tests/verify.mjs:4). |

## Browser bootstrap followed by direct HTTP

| Tool or operation | Browser phase | Browser-free recurring work |
|---|---|---|
| Naver Cafe reader | Chrome used for target identification/discovery or a first session handoff; one worker gets an initial slot from an existing Naver session | Per-cafe DPAPI sessions and observed read/manage requests use HTTP. Renewal boundaries differ by checkout; see [Cafe client README](C:/Users/User/Documents/GitHub/affiliate-content-operations/apps/naver-cafe-api/README.md:11). |
| Tistory API and republisher | Browser/CDP only for initial session handoff when saved Kakao state is absent/rejected; CDP logger is discovery-only | Reads, publishing, media upload, and saved-account session renewal use HTTP. See [auth guide](C:/Users/User/Documents/GitHub/tistory-api-only/references/authentication.md:12) and [republisher](C:/Users/User/Documents/Codex/2026-09-24/tistory-republish/tistory-direct.mjs:10). |
| X and XChat | Initial X session handoff uses browser capture; one X public-write path also needs observed transaction inputs | X reads and XChat DM reads/sends were independently replayed via HTTP. Session auto-renewal is not established. See [X client](C:/Users/User/Documents/GitHub/sns-X/README.md:7) and [DM receipt](C:/Users/User/Documents/GitHub/sns-X/docs/xchat-send-live-20260927.json:116). |
| MyRealTrip, LinkPrice, BrandConnect | Browser used for some initial OTP/session acquisition paths | Routine API requests use HTTP; MyRealTrip HTTP login/refresh is verified, BrandConnect has a verified Naver Blog HTTP session refresh path, and LinkPrice server-expiry recovery remains unverified. See [web login evidence](C:/Users/User/Documents/GitHub/web-api-playbook/verification/web-login-2026-09-24.json:7) and [BrandConnect flow](C:/Users/User/Documents/GitHub/web-api-playbook/references/naver-connect.md:33). |
| Toss Sharelink | Fresh browser session required after rejection; no unattended renewal | Existing authenticated reads use Node fetch. See [client](C:/Users/User/Documents/Codex/2026-09-27/toss-sharelink/client.mjs:65) and [login flow](C:/Users/User/Documents/Codex/2026-09-27/toss-sharelink/login-flow.md:3). |
| Instagram session reuse | Browser/normal login handoff needed after rejected saved session | Saved-session reads can use HTTP; password login and expiry renewal are not implemented in the reviewed artifacts. |
| CodexArsenal OAuth | Opens the default browser for initial OAuth PKCE login | Refresh-token renewal is direct HTTP. See [OAuth login](C:/Users/User/Documents/Codex/2026-09-06/x20/work/CodexArsenal/scripts/Invoke-CodexLogin.ps1:4) and [token refresh](C:/Users/User/Documents/Codex/2026-09-06/x20/work/CodexArsenal/scripts/Get-CodexTokens.ps1:55). |

## Direct HTTP or no browser dependency found

- XHR API-only core transport supports stored/stdin sessions and named HTTP requests without a browser; browser/CDP is limited to optional discovery or session bootstrap. Service packs can add their own browser input requirements. See [request runner](C:/Users/User/Documents/GitHub/xhr-to-api-only/scripts/request.mjs:17) and [skill phases](C:/Users/User/Documents/GitHub/xhr-to-api-only/SKILL.md:25).
- Tistory routine read/write and verified saved-account renewal are direct HTTP.
- SSG and 11st shopping search were replayed via direct HTTP; Naver and Coupang consumer search remain excluded/blocked, and separate marketplace or partner APIs must not be conflated.
- Notion uploader scripts use the Notion SDK, with no browser library found. Chat Home Windows Core is a Streamable HTTP file/shell bridge; its setup page is a convenience UI, not a browser engine in the recurring server. Realesrgan is a local image binary.
- The KakaoTalk MCP reference uses Win32 automation against the native desktop app; it is a GUI dependency, not a browser dependency. See [reference README](C:/Users/User/Documents/Codex/2026-08-24/kaka/work/kakao_MCP_reference/README.md:3) and [sender](C:/Users/User/Documents/Codex/2026-08-24/kaka/work/kakao_MCP_reference/core/sender.py:3).
- The active n8n workflow database was opened read-only and inspected only for node/type/name/parameter text markers. No active workflow had an explicit Playwright, Puppeteer, Chrome, Chromium, Firefox, CDP, WebDriver, or Browsh marker. Credential records were not queried.

## Installed capability and unknowns

- The Playwright skill is an actual browser automation tool. The Chrome-session skill is operating guidance, not an installed browser server. XHR API-only separates discovery from its HTTP runtime. See [Playwright skill](C:/Users/User/.codex/skills/playwright/SKILL.md:9), [Chrome skill](C:/Users/User/.codex/skills/chrome-session-operations/SKILL.md:8), and [XHR skill](C:/Users/User/.codex/skills/xhr-to-api-only/SKILL.md:30).
- Codex config enables browser/computer-use plugin entries; that is an available capability and does not mean every workflow depends on a browser.
- Shell inventory found node and npx but no global playwright, playwright-cli, chrome, chromium, msedge, or bash command. Some checkouts declare Playwright without an installed package, so browser runnability is not proven by a browser-cache folder alone.
- context7-mcp and notion-mcp have manifests but no local implementation source; .webmcp has no source in the inspected directory and its .env was not opened. Browser dependence is unknown there.
- Active n8n workflows were checked for explicit browser markers only; dynamic commands or indirect sub-workflows were not proven absent.
- Browser profile directories, 2026-09-06 Tistory profile data, upstream vendor trees and plugin clones, historical conversation dumps, generated auto-briefs, raw captures, and one-off evidence-only folders were not inspected as maintained tools. Evidence-only folders do not prove a working browserless client.

## Separate credential risk found during inspection

The read-only scan found 11 hard-coded Notion authentication literals in C:\Users\User\notion-upload scripts. Values are deliberately omitted. Treat the affected credentials as exposed and rotate/revoke them through the Notion account. The affected source lines are:

- clear_notion.js:3
- fix_tables.js:3; fix_tables_v2.js:3
- init_root_dashboard.js:3; init_root_dashboard_v2.js:3
- organize_hierarchy.js:3; organize_hierarchy_v2.js:3
- update_notion_charts.js:3
- upload.js:5; upload_toggles.js:4
- verify_notion_upload.js:3

No credential was changed or revoked during this audit.
