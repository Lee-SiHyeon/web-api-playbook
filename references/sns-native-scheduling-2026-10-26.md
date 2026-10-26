# Native SNS scheduling: preparation and submission boundaries

`scripts/sns-web-post.mjs --schedule=<time>` prepares the native X or Threads
schedule picker. Offset ISO timestamps and epoch milliseconds identify an instant.
`YYYY-MM-DD HH:MM` is Node-local wall time; the browser offset must match before
that local input can be used. Impossible dates, DST gaps/overlaps, times under ten
minutes ahead and times over sixty days ahead are rejected.

The active composer's selected date and time are checked again immediately before
the single submission click. Its button must say Schedule or 예약. Threads
currently sometimes shows only weekday/time; that form is rejected with
`date_unconfirmed` because the numeric calendar date cannot be verified. A
matching month/day/time display is required. This restriction has fixture coverage
but has not been freshly verified against a signed-in Threads account here.

```sh
node scripts/sns-web-post.mjs x message.txt --schedule=2026-11-02T15:00+09:00 --dry
```

Direct `--dry` still opens the composer, enters the supplied text, and may upload
supplied media. It stops before the final submission click. The distributor's
`--dry` only prints child commands and does not open these composers.

After a schedule submission, a separate read of the account's Scheduled list is
needed to prove persistence. That automatic reader is not implemented by this
change. Consequently the runner preserves the tab and returns
`scheduleSubmissionAttempted:true`, `scheduled:false`, `outcomeUnknown:true`, and
`needsReconciliation:true`. `scheduleRequestedFor` is the requested time, not a
receipt. It never treats modal closure as proof of a scheduled record and never
clicks Submit again after an uncertain response. Check the Scheduled list before
any explicit retry. Immediate posts use the exact own-post readback from PR #24.

Validation during review was offline: strict-date, timezone, active-dialog,
ambiguous-confirmation and one-submit regression tests. No new posts or schedules
were created. Earlier author observations of the native UI are historical
contract context, not fresh verification of this stricter implementation.

## Distributor state

`shorts-distribute.mjs` validates selected SNS slots before channel work. Invalid
slots stop the run; a future slot inside the ten-minute minimum waits for a later
run instead of publishing early. The slot is checked again before each channel.
Both X and Threads reserve an attempt before starting the non-idempotent child
command, and an unknown result remains `needs_reconciliation`. The current SNS
helper's unverified schedule attempt therefore does not become `ok:true` here.

`--retry-x` or `--retry-threads` is an explicit resend after checking the account,
not automatic recovery. Distributor `--dry` does not change the persisted state.
The slot producer in another application is outside this repository; callers must
write the intended `shorts[id].slotAt` value into the existing state file.
