# Gabia Google login and authenticated DNS reads

## Scope and evidence

This adapter reads the current Gabia account owner, checks one exact domain in the account's internal-domain listing, and reads its DNS rows. It uses only the first-party routes observed in the authenticated Gabia UI. These are observed application routes, not a published or guaranteed-stable Gabia API.

Observed on 2026-10-08 KST with a user-authorized Google login in the existing Linux Chrome profile:

| Operation | Request | Observed response |
| --- | --- | --- |
| Protected owner | `GET https://gabia-user-api.gabia.com/v1/users/me` | HTTP 200 JSON `data` with `user_id`, `user_name`, `user_type`, `registration_site`, `registration_date` |
| Internal-domain search | `GET https://dns.gabia.com/dns/ajax/domain` | HTTP 200 JSON `list`, `last_flag`, `domain_cnt`, `request_view_cnt`, `request_view_page` |
| DNS detail | `GET https://dns.gabia.com/dns/ajax/dns` | HTTP 200 JSON with `record[]` and DNS settings metadata |

The observed domain-list query names are `_`, `domain`, `kind`, `sorting_method`, `sorting_val`, `view_cnt`, and `view_page`. The UI defaults were `kind=internal`, `sorting_method=asc`, `sorting_val=domain`, `view_cnt=10`, `view_page=1`; `_` is a changing cache key. The reader sets `domain` to the requested target and asks only for page 1. It verifies that the exact target appears in that filtered response before requesting DNS detail. Full inventory pagination is not verified.

The DNS-detail query names are `_` and `domain`. The response's observed `record[]` fields are `ttl`, `services_idx`, `seqno`, `domain`, `host`, `type`, `data`, `service`, `protocol`, `priority`, `weight`, `port`, `target`, `is_layer`, `services_name`, `addition_service_name`, and `action`. Output includes only the requested domain's A, AAAA, and CNAME rows; it omits account identifiers, internal row IDs, other domains, and TXT values.

The authenticated owner response has no email field. The adapter compares `data.user_id` with a same-session pin supplied in memory and reports only whether they match. That proves continuity with the protected owner probe; it does not establish that the Gabia profile email equals a GitHub or Google primary email. Google SSO returned through `/login/oauth2/success`; no account chooser was visible during this observation.

## Login and credential handoff

Login acquisition uses the normal visible `구글 로그인` flow in the user's existing Linux Chrome profile. CAPTCHA, OTP, account selection, or consent challenges must follow the normal UI and any required user action. This phase is `browser_automation`; it is a one-time session bootstrap, not the data reader.

After a protected `GET /v1/users/me` succeeds, an in-process helper may pass the current profile's cookies and the returned `user_id` directly to the Node reader over stdin. Read cookies only through the current browser context for the two exact origins below. Do not read browser cookie databases, put values in command arguments, environment variables, files, logs, reports, or tool output. Do not forward cookies to the Google identity provider, telemetry, static assets, or any other host. Do not persist the expected user ID.

The stdin object has this shape; all angle-bracketed values are placeholders and must stay in process memory:

```json
{
  "schema": "gabia-read-input-v1",
  "domain": "lifehackailab.com",
  "expectedUserId": "<user_id from the current protected owner probe>",
  "cookies": [
    {
      "name": "<browser cookie name>",
      "value": "<memory-only value>",
      "domain": ".gabia.com",
      "path": "/",
      "hostOnly": false,
      "secure": true,
      "httpOnly": true
    }
  ]
}
```

The script copies cookies into an origin-scoped in-memory jar, clears the parsed stdin cookie fields and owner pin, and then uses Node's HTTPS `fetch` through `ScopedSession`. It permits only `gabia-user-api.gabia.com/v1/users/me` and the two named DNS GET routes on `dns.gabia.com`. Requests are HTTPS-only, bounded to 12 seconds and 1 MiB, and redirects are blocked. There is no Playwright import or browser fallback in the business-read path.

Run the operation with:

```sh
node scripts/gabia-read.mjs status
node scripts/gabia-read.mjs read --credentials-stdin
```

The second command reads the JSON provider object from stdin and prints a sanitized read receipt. `--receipt=<new-file>` may save that sanitized receipt; it never saves the input provider. Restart or session expiry requires the normal browser login and a fresh in-memory handoff. Cookie rotation, automatic renewal, unattended access, and handoff across machine/process restarts are unverified.

## Verified Lifehack AILab result

The authenticated domain listing contained `lifehackailab.com`. The detail UI and an independent HTTP replay both returned the following records at TTL 600:

| Type | Host | Observed value | TTL |
| --- | --- | --- | ---: |
| A | `@` | `216.150.1.1` | 600 |
| A | `@` | `216.150.16.1` | 600 |
| CNAME | `www` | `f2b6c708ceb0ac50.vercel-dns-016.com` | 600 |

The authenticated reader preserved the CNAME target with its final dot; the public recursive-DNS result normalized that dot away. DNS record writes remain unsupported. The page exposes a write candidate in `dns_set.js` (`recordModifyLayer`, `addRecordEvent`, `saveRecordEvent`) and a hidden POST form at `/dns/internals/total_set` with fields `domain`, `domain_seqno`, `owner`, and `tbl`; the actual write contract has not been captured, dispatched, or read back.

Sanitized authenticated-read evidence for this observation is in [`../sanitizedverification/gabia-authenticated-read-2026-10-08.json`](../sanitizedverification/gabia-authenticated-read-2026-10-08.json). The separate UI/contract investigation is not part of runtime authentication or the stdin provider.

A separate [public domain check](../sanitizedverification/gabia-public-domain-check-2026-10-08.json) queried the Google and Cloudflare recursive resolvers. Both matched the apex A records and `www` CNAME, so its DNS result is `verified`; `authoritativeDns.status` remains `not_queried`. The same check got HTTP 429 from the apex site, reported independently from DNS. That response does not change the authenticated Gabia DNS read result.
