# Frontier model evidence collection

Six families: Grok, GPT, Claude, Gemini, Qwen and DeepSeek. Configured sources include announcements, exact model specifications, API rates, consumer plans and Arena leaderboards/methodology. Public research collection needs no login.

```powershell
node scripts/collect-official.mjs config/frontier-sources.json runtime/NEW_RUN
python -X utf8 scripts/parse-arena.py runtime/NEW_RUN
```

Use a new output directory. The collector preserves raw response bytes and a SHA256/status/date manifest. Redirects are recorded, never followed. A 200 response means retrievable, not fact-checked: client-rendered shells and stale prices still need review. Failures stay failures. No model API calls, account creation, cookie persistence or publishing occurs.

Arena parsing uses only JSON decoding of observed server-rendered Flight chunks, never JavaScript execution. It verifies each raw hash and byte-span binding, and preserves exact model names, dataset filters, cutoff timestamps, score, confidence bounds, rank spread, votes and preliminary release labels. Do not replace missing model versions with earlier ones. Default Text preference is not factual accuracy, and WebDev is not a general coding pass rate.

Live run on 2026-09-22: 37 sources fetched, 28 HTTP 200; 9 unavailable responses retained. Four Arena tables parsed: 402 Text English, 402 Text overall, 129 WebDev, 34 Search entries. They are separate datasets, not 967 unique models. Grok 4.7 was absent from all four snapshots. These are dated snapshots, not an unattended scheduler.

Elon Musk and SpaceX use the existing X client. SpaceX profile and timeline each returned HTTP 200 on 2026-09-22. Browser session/transaction bootstrap remains required for authenticated X requests; this is not a claim of browser-free renewal. Keep envelopes in memory.

Storage destination: the owner's existing Google Drive “글감 수집 저장소”. Only public evidence/configuration and reviewed comparison artifacts belong there, never credentials. The adjacent affiliate-content-operations content-store contains `frontier-sources.json` and a routing note to this client.
