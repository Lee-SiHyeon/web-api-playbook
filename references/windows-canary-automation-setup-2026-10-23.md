# How this playbook drives logged-in sites: a Windows PC, a dedicated Chrome Canary profile, CDP, and a Windows MCP (2026-10-23)

This is the setup behind every browser-assisted script in `scripts/` (YouTube Studio, Facebook, Naver blog and Clip, Instagram,
TikTok Studio, X, Threads, Blogger, Tistory, Google Flow). It runs unattended on one Windows PC. No cookie or token is copied out
of the browser: the scripts drive the sites' own web UI in a browser that is already logged in.

## The three parts

| Part | What it is | Why |
|---|---|---|
| **Chrome Canary, non-default profile** | Canary started with its own `--user-data-dir` (not the everyday Chrome, not Canary's default profile) and `--remote-debugging-port=9333` | One long-lived profile that holds every channel login. Sites see an ordinary, warm desktop browser with history, so logins survive and checks stay mild (Facebook's reCAPTCHA checkbox passed with one click). Your own Chrome stays untouched. |
| **CDP (Chrome DevTools Protocol)** | Scripts call `http://127.0.0.1:9333/json/new?<url>`, attach a WebSocket, and drive that tab with `Runtime.evaluate`, `Input.*`, `DOM.*`, `Page.*` | Plain Node, no Playwright/Puppeteer install. Each script opens **its own tab and closes only that tab**. |
| **Windows MCP** ([Windows-MCP](https://github.com/CursorTouch/Windows-MCP), shared over HTTP and registered as `windows-http`; see below) | Real OS mouse/keyboard, full-desktop screenshots, native dialogs, other apps | For what CDP cannot reach. X ignored every synthetic Post click (CDP mouse events, `element.click()`, Ctrl+Enter); one real OS click through the MCP posted. It also clears OS pop-ups that steal focus from the browser (a firewall prompt, a Drive welcome window). |

## The desktop MCP: Windows-MCP over HTTP

The server is [Windows-MCP](https://github.com/CursorTouch/Windows-MCP) (CursorTouch, MIT, Python, version 0.8.8 here).
Its tools include Screenshot, Snapshot, Click, Type, Scroll, Move, Shortcut, Wait, App, Clipboard, PowerShell, Process,
FileSystem, Registry and Notification. Here it runs as **one HTTP server** that every agent shares (Claude Code, Codex and so on),
not as a stdio server that each client starts.

| Choice | Why |
|---|---|
| `streamable-http` on `127.0.0.1:8765` | Several agents use one desktop, so one server owns the mouse and keyboard. With a stdio server per client, two servers fight over the same cursor. |
| Started by a **logon scheduled task** in the signed-in session (`pythonw`, interactive token, no time limit, restart on failure 3x every 1 min, runs on battery) | Desktop control needs the interactive session. A Windows service runs in session 0 and cannot see the desktop. `pythonw` keeps a console window from popping up. |
| Pinned version in its own venv (`uv`) | An upstream update can rename tools. Upgrade on purpose, then run the check below. |
| Bound to localhost only | Anyone who reaches the port controls the PC. For remote use, add `windows-mcp auth` (key and TLS) first. |

### Setup

```powershell
# 1) Install the pinned version in its own environment
uv tool install windows-mcp==0.8.8

# 2) Register a logon task that runs the HTTP server in your session
windows-mcp install --transport streamable-http --host 127.0.0.1 --port 8765
#    (stop and remove: windows-mcp uninstall)

# 3) Point each agent at it
claude mcp add --transport http --scope user windows-http http://127.0.0.1:8765/mcp
#    Codex and other clients: add the same URL as a streamable-HTTP MCP server
```

The setup here wraps the same `serve` command in a small launcher (`launch.py`, a `server.toml` with
`transport = "streamable-http"`, `host`, `port`) so it can rotate its log and set
`ANONYMIZED_TELEMETRY=false`. The scheduled task then adds the restart-on-failure settings.

### Health check

- A connected transport does not prove that desktop control works. Call the `ControlStatus` tool and look at the result.
- Then take one Screenshot. Run the check from **two clients at once** to confirm that the server is shared rather than started
  twice.
- If it stops answering, restart the scheduled task (end the old listener on 8765 first) and read the server log.
- `ControlStatus` reports `USER_CONTROL` for outside input, and also after an internal fault. Rule 11 below covers how to tell them apart.

## Launching the automation Canary

```bat
"%LOCALAPPDATA%\Google\Chrome SxS\Application\chrome.exe" ^
  --user-data-dir="%USERPROFILE%\.config\<your-project>\browser\automation-canary" ^
  --remote-debugging-port=9333 --no-first-run --no-default-browser-check --restore-last-session
```

- Log in to each site **once, by hand**, in that window. Every script after that reuses the session.
- Since Chrome 136 the debugging port is ignored for the **default** user-data-dir. That is one more reason to use a separate one.
- Keep this window open. Never close it from a script, and never `taskkill` all Chrome. Close only the tabs you opened.
- Bind the port to localhost only (the default). Anyone who can reach 9333 controls every logged-in account.

## Rules learned the hard way (each one cost a failed run)

1. **Bring the tab to the front** (`Page.bringToFront`) before clicking. Facebook and Blogger silently ignored clicks in a
   background tab: the composer never opened, and the 게시 button did nothing.
2. **Real input events, not `element.click()`**, for app UIs. Use `Input.dispatchMouseEvent` at the element's center, with a
   `mouseMoved` first.
3. **File uploads, three ways.** Pick by how the page asks for the file:
   - The page has an `<input type=file>`: `DOM.setFileInputFiles` on it (X, Threads).
   - The page opens a native chooser: `Page.setInterceptFileChooserDialog` + `Page.fileChooserOpened` → `DOM.setFileInputFiles`
     with its `backendNodeId` (YouTube Studio, Facebook, Naver).
   - The picker is a **cross-origin iframe** (Blogger's "이미지 추가"): its chooser never reaches your page session. Drop the file
     on it instead with `Input.dispatchDragEvent` (`dragEnter`/`dragOver`/`drop`, `data.files: [path]`).
4. **Newlines in composers.** Use Shift+Enter (`Input.dispatchKeyEvent`, `modifiers: 8`). `execCommand('insertLineBreak')`
   replaced the selection in Facebook's editor, so only the last line survived. Plain Enter submits on some sites.
5. **Success means read back, not a toast.** A post counts only when the composer closed *and* the item shows up in the list,
   feed or API readback. One X run reported success while the video was still uploading. YouTube silently dropped a comment
   with 41 links: no error, and nothing waiting in review. Split long link lists into replies and verify each one.
6. **Wait for media processing.** Watch the site's progress indicator before pressing Post (X shows a ring; Facebook shows
   "n% 업로드 중"). Keep the tab open until the upload finishes, because closing it kills the upload.
7. **Per-account checks before posting.** One browser can hold several accounts on a site (here, a personal Threads account and
   the channel's account). Read the active account name from the composer and stop if it is not the channel.
8. **Feeds virtualise.** To count posts, scroll and accumulate what you saw at each step. Counting `innerText` once at the end
   misses the posts that were scrolled away.
9. **Rate limits are behavioural, and a burst can cost a new account its reach.** Instagram publishes no daily cap, but a new account got throttled when posts came in a burst. On TikTok a new account posted 6 Shorts in 5 minutes (2026-10-22): those got 100-245 views each, and every later post got 0. shorts-distribute keeps one TikTok ledger for all series (`~/.config/web-api-playbook/tiktok-ledger.json`: `pausedUntil`, `perDay` 2, `minGapHours` 4) and skips TikTok when it says so. Make caps settings, not constants.
10. **Check the profile, then the post URL, before you retry.** X's own profile timeline lagged by minutes. A "failed" first run
    had in fact posted, so the retry made a duplicate (which was then deleted). With a video, X's composer can take 20-60 s to close
    after Post; that looked like an ignored click. sns-web-post waits 90 s and only then presses Post once with a real OS click. Before re-posting, look the item up by URL or oEmbed
    (`publish.twitter.com/oembed?url=…` → 200/404), or poll the list for a while.
11. **`USER_CONTROL` on an unattended PC can be a false alarm.** Windows-MCP 0.8.8 reports it for real physical input (hooked
    mouse/keyboard events without the injected flag, raw input from a real device). It also reports it after **recovering from
    its own internal fault**: watchdog heartbeat over 1 s under load, a busy lock, a failed indicator or hook check.
    `_recover_after_rehook()` always switches to "user" with a 10 s wait. On 2026-10-23 a logger (low-level hooks + raw input)
    recorded no physical input at all while the MCP kept reporting `USER_CONTROL`, and a server that had run for five days also
    failed region screenshots. What to do:
    - Restart the server (`manage.ps1 restart`) when it has run for days, or after capture errors.
    - Patch `_recover_after_rehook()` to choose "user" only when physical input was seen in the last 10 s, else "ready". A
      reinstall overwrites the patch. uv hard-links site-packages to its cache, so break the link before editing the file.
    - If someone may really be at the PC, stop and ask rather than retrying.
12. **On an unattended PC, OS pop-ups pile up** (a firewall prompt for an unknown publisher, an app's first-run guide). Clear them
    the safe way: Cancel a permission prompt rather than granting it, and Skip a guide. Then retry the click.

## Credentials

- Identities (email/password) live in Windows DPAPI (`lib/protected-store.mjs`, `ProtectedStore.read/write`). Scripts read them
  in memory and type them into the login form. Never put them in arguments, environment dumps, logs or this repository.
- Tokens for HTTP APIs are passed only to the child process environment, and outputs are scrubbed before printing.

## Scripts that follow this pattern

`youtube-studio.mjs` (upload, A/B, captions with resume), `youtube-pin-comment.mjs`, `youtube-reply-comment.mjs`,
`shorts-distribute.mjs`, `facebook-web.mjs` (login with checkpoint, page post/reel with AI label), `facebook-captions.mjs` (SRT tracks per language on a published Reel; the panel opens from the CC icon's tooltip), `google-photos-web.mjs` (list/search/info/download originals, read-only), `sns-web-post.mjs`
(Threads / X), `blogger-post.mjs`, `naver-se-paste.mjs`, `naver-clip-upload.mjs`, `instagram-web-post.mjs`,
`tiktok-studio-upload.mjs`, `blog-md.mjs` (`tables` renders tables as images for mobile blogs).
