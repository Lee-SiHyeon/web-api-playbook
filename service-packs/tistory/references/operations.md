# Observed operations and runtime

## Evidence baseline

The 2026-09-06 exploration recorded 55 management paths and 79 JSON/write contracts, including common platform/auth endpoints. Thirty-two management GET contracts were replayed through a separate Node process. Post creation, editing, deletion, and one menu-bar setting change/restore were independently replayed at that time. Historical test posts 212–214 were deleted; these IDs are not current write targets. This dated evidence does not establish that every listed filter, UI control, or mutation remains available.

## Known routes

All paths below use `https://i-never-stop-study.tistory.com`.

| Operation | Method and path | Inputs / notes |
|---|---|---|
| Visitor totals | GET `/manage/v2/statistics/blog/count` | `data.result.pv`, `uv`, `followerCount` |
| Dashboard trend | GET `/manage/v2/statistics/dashboard/trend` | no query observed |
| Dashboard detail | GET `/manage/statistics/dashboard/{topEntry,inflow,keyword,recentEntry}.json` | four observed routes |
| Posts | GET `/manage/posts.json` | `category`, `page`, `searchKeyword`, `searchType`, `visibility` |
| Pages, notices, templates | GET `/manage/{pages,notices,templates}.json` | `page`, `searchKeyword`, `searchType` |
| Categories | GET `/manage/category.json`, `/manage/category/simple.json` | no query observed |
| Comments | GET `/manage/comments.json`, `/manage/guestBookComments.json` | `filter`, `page`, `searchKeyword`, `searchType` |
| Trash | GET `/manage/commentTrash.json`, `/manage/guestBookCommentTrash.json` | same query names; distinct operations |
| Post creation | POST `/manage/post.json` | observed schema in `api-catalog.json`; response `entryUrl` |
| Post update | PUT `/manage/post/{id}.json` | historical sample uses 212; substitute only a verified authorized target |
| Post deletion | DELETE `/manage/post/{id}.json` | no request body observed; response contains deleted ID |
| Menu-bar setting | GET/PUT `/manage/design/setting.json` | PUT `menubarType`; `""` upper-right, `"lb"` lower-left observed |
| Blog/content/comment settings | GET `/manage/setting/{blog,contents,comments}.json` | reads observed; not all writes verified |

Search the catalog for `revenue`, `skin`, `sidebar`, `plugins`, `teamblog`, `autosave`, `referrer`, and `/m/api/` for other captured contracts. A captured schema or menu item does not prove every selector, combination, or mutation works.

## Authentication and execution

The maintained client is now included in this repository. It stores the cookie jar and bound account/blog identity in Windows DPAPI CurrentUser through `scripts/secure-credential-store.*`. `npm run login:auto` first verifies the stored session; on an observed authentication rejection it attempts HTTP renewal through Kakao's saved-account flow and re-verifies the account and blog before saving rotations. `npm run session:health` is read-only. The `TISTORY_COOKIE` environment override is supported only for compatibility and is not persisted.

Renewal works only while Kakao still accepts its saved login. Password login after that saved login expires, MFA, CAPTCHA, and consent automation are not implemented. An authorized one-time browser bootstrap can submit an encrypted, origin-scoped cookie bundle to `tools/session-handoff.mjs`; plaintext cookie exports and Chrome profile database extraction are not supported.

The scoped client restricts authenticated requests to the named blog's `/manage/` routes and known Tistory/Kakao login origins. It does not automatically retry a business write. Distinguish creation (`POST /manage/post.json`) from modification (`PUT /manage/post/{id}.json`); changing the payload `id` while calling the create route can still make another post. Retrieve the current target representation or capture the UI action before an update, preserve unrelated fields, and independently read back every mutation. If the outcome is uncertain, reconcile the same journal and owner state before considering a retry.

## Statistics and explicit requests

```powershell
npm run stats -- count
npm run stats -- trend --data
'{"url":"https://i-never-stop-study.tistory.com/manage/category/simple.json"}' | npm run request
```

Supported statistics names are `count`, `trend`, `top`, `inflow`, `keyword`, and `recent`. The default statistics output is metadata and schema; `--data` returns application data. The request runner accepts one JSON object on stdin with `url`, optional `method` (default GET), and optional `body`. It prints response data, so use it interactively and do not save private responses to Git. Validate application errors and response shape; a zero exit code or HTTP 200 alone is insufficient.

## Event discovery

Use `npm run capture -- '<authorized Chrome User Data directory>' '<task output>/cdp-events.jsonl'` only for an explicitly authorized discovery action. The event logger is a foreground process, not a session provider or background service. It retains request method, origin/path, query field names, body shape, response status, MIME, length, hash, and JSON schema; it excludes cookie and authorization headers and does not save raw request or response bodies. Keep task captures outside this repository unless reviewed and sanitized for inclusion.
