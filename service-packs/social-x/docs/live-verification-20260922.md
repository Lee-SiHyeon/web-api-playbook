# Live verification — 2026-09-22 KST

Local Windows, authorized X account `shyeon0528`.

| Operation | Evidence |
|---|---|
| UserByScreenName | Node HTTP 200 JSON, expected handle and ID |
| UserOriginalsTimeline | Node HTTP 200 JSON, 21 decoded author posts; latest five selected by date |
| CreateTweet | Browser request captured and cancelled before send (`net::ERR_ABORTED`, canceled=true); independent Node POST 200 |
| TweetDetail | Independent Node readback matched created ID, author and complete normalized text |

Published: https://x.com/shyeon0528/status/2102165417796202582

Source post IDs in descending creation time:

- 2102102621037236699
- 2102084081475350829
- 2102083930107101382
- 2102082011233931762
- 2102071804495872374

Profile response: 2748 bytes. Timeline response: 202250 bytes. Create response: 11072 bytes.
No authentication values or raw captures are committed.

States: captured=true; client_exists=true; credential_propagated=true for this run; live_replay=true for the operations above. remnant_free=true only for the HTTP transport, false for end-to-end input preparation. Browser bootstrap/capture is still required with this provider. Server-directed token renewal, unattended restarts and independently generated transaction IDs remain unverified. The source summary attributes performance rankings to Musk rather than asserting independent benchmark verification.
