# Publication tags and metadata-only repair

The previous publisher copied `postFormMeta.tags` from the current editor or
private create seed. It did not accept selected tags from the job and neither
the publication gates nor the public reader checked them. A seed with `tags: ""`
could therefore produce a fully reviewed article with no registered tags.
Body `#hashtags` are text and do not repair this missing metadata.

## Observed contract

The owner inventory on 2026-09-21 found 11 public posts in `aicandoanything`:
eight had empty owner tags and three had existing comma-separated Unicode tags.
The task evidence is `naver-tags-repair/inventory.json` and `before/` beside
this checkout. This inventory excludes private posts and drafts.

The page-linked first-party script
[`PostBottomCommon-1157895654_https.js`](https://ssl.pstatic.net/t.static.blog/mylog/versioning/PostBottomCommon-1157895654_https.js)
has SHA-256
`a593021404dfc79d37a59d1027c374e7dc79bbae34f92e198a5e4819883dad20`.
Its `loadTagInfo` performs GET `BlogTagListInfo.naver` with `blogId`,
`logNoList` (IDs separated by `|`) and `logType: mylog`. Its
`check_tagsvalidate` uses `if(f>30)` and calls
`isValidateTagLength(g.value,100)`; that helper rejects an individual
`d[b].length>c`. Thus the observed limits are 30 tags and 100 JavaScript string
code units per tag. These are implementation observations, not a permanent
platform guarantee.

The actual public GET replies were HTTP 200, `text/plain;charset=UTF-8`, with
JSON `{taglist:[{msg:"",logno,tagName,encTagName}]}`. `tagName` is UTF-8 percent
encoded; `encTagName` is a separate legacy encoding and is never used for
canonical comparisons. The page's linked
[`LayoutTopCommon-865522784_https.js`](https://ssl.pstatic.net/t.static.blog/mylog/versioning/LayoutTopCommon-865522784_https.js)
defines `decodeURIComponentForJava`: replace `+` with `%20`, then decode.
Its later dollar-to-HTML-entity replacement is display escaping, not part of
the raw metadata. The reader uses JSON parsing and URI decoding, never eval.

The saved discovery record is
`naver-tags-repair/public-tag-discovery/contract-and-readback.json`; raw scripts,
responses and hashes are in the same folder. All 11 public results were checked
against owner metadata: the three existing lists had 6, 9 and 7 tags, while
the eight empty posts were absent from `taglist`. An absent row alone does not
prove that a post exists or is public. The client pairs it with the exact public
post identity and protected owner readback. Requesting a single ID also rejects
unexpected or duplicate returned rows.

## Every ordinary create and content update

Set `publishSettings.tags` to a nonempty `string[]` before authorization. The
current conservative character policy accepts NFC Unicode letters, numbers and
combining marks only; it rejects whitespace, `#`, commas, control characters,
empty entries, and case-insensitive duplicates. Counts and lengths obey the
observed 30/100 bounds. The writer does not silently normalize or rewrite a
reviewed tag. Select relevant tags instead of filling a quota.

The full job gate requires canonical tags before any publication POST. The
hybrid create runner checks that gate before launching the SDK input provider.
`publishSettings` already participates in `publisherContentFingerprint`, so a
tag change invalidates the previous content authorization. Both independent
HTTP create and normal update explicitly write the comma-joined selected values
to `populationMeta.tags`; an empty private SDK seed cannot overwrite them.

Completion requires exact owner and public tags. `readPost` obtains the public
tag list independently and stores `tags`, `tagsObserved` and `tagReadback`.
Static tag anchors are parsed only from the exact post's `tagList_<logNo>`;
navigation, another post and text hashtags never count. `evaluateExactReadback`
checks tag values for ordinary supported article formats, and create/update
reconciliation compares the owner field with the same expected values. A tag
save failure stays uncertain even if the title, body, links and images match.
All previous content, affiliate, factual, native preview and review gates remain.

## Fill missing tags without changing article content

The separate operation is `update_tags`, scoped to existing public posts owned
by `aicandoanything` with no existing tags. It is not an alternate content writer.
Jobs may contain only `jobId`, `operation`, `blogId`, `target`, `tags`,
`executionMode`, `preflight` and `authorization`; document, publication bundle,
visibility or other content/settings payloads are rejected.

```js
const job = {
  jobId: 'unique-reviewed-repair-id', operation: 'update_tags',
  blogId: 'aicandoanything', target: {type: 'update', logNo},
  tags: ['selectedRelevantTag'], executionMode: 'independent_http',
};
job.preflight = await client.prepareTags(job);
job.authorization = {
  approved: true, approvedBy: 'user', approvedAt,
  scope: 'update_tags_once',
  contentFingerprint: tagsOnlyContentFingerprint(job),
};
const result = await client.updateTags(job);
// After an uncertain attempt, use client.reconcileTags(job); never retry POST.
```

The fingerprint helper is exported by
`apps/naver-blog-api/scripts/gates/publication-tags.mjs`. CLI equivalents are
`prepare-tags`, `update-tags`, and `reconcile-tags` with the usual `--job` and
journal arguments. Credentials use the existing ephemeral session mechanism.

Preparation verifies the exact owner/public post, empty tags and matching
content, then binds five fingerprints: complete original raw editor model,
inspected title/ordered units, full owner configuration, all owner metadata except
tags, and public title/units/links. Authorization binds those fingerprints, the
target and selected tags. A changed source or already tagged post stops before
write. The caller's reviewed repair plan restricts which missing posts to repair;
the 2026-09-21 plan contains only the eight missing entries and preserves the
three existing tag lists.

The writer reuses the observed `RabbitUpdate.naver` transport and journal, sends
the complete original model without compiling/regenerating it, and changes only
the supported wire metadata's `tags`. It does not invent additional wire fields.
Readback checks the full original model, public content and links, complete
configuration, and all other owner metadata, including values not transmitted
by the known wire contract. This is a preservation check, not a new commercial
claim review, price refresh, image upload or factual certification.

Before preparation and again before submit, a compatibility guard checks every
owner field omitted by the known wire projection. Only the actually observed
neutral omissions are accepted: configuration `commercialUsesYn: null` and
`contentsModification: null`; metadata `themeSourceCode: 0` and
`bookThemeInfoPk: ""`. Unknown omitted fields or nondefault values stop before
POST instead of relying on the server to preserve them. Do not add arbitrary
fields to the wire to silence this check.

The response explicitly reports `operation: updatePostTags`, `metadataOnly:
true`, `contentQualityRevalidated: false`, nine preservation/readback checks,
and `readbackVerified`. A lost response may be verified by reads while
`accepted: false` honestly records the missing server acceptance response.
The journal remains uncertain on any mismatch. `reconcileTags` reads only and
cannot submit a second write. The `fill_missing_tags_v1` reservation is keyed by
target, not selected tags: changing job IDs, tag order, authorization or preflight
cannot create a second attempt against an unresolved target. The stored exact
content fingerprint and expected tags still bind reconciliation. This scoped
contract intentionally allows only one fill attempt per target in its journal.
Use one writer per target; no server-side
conditional-write primitive was observed, so the short read/write concurrency
window remains.

## Regression coverage

Tests cover canonical/tag-limit decoding, body-hashtag false positives, empty
tags stopping ordinary API and hybrid publishing, selected tags replacing an
empty SDK seed, authorization changes, owner/public save mismatches, and
tags-only attempts to change content/settings. They also cover concurrent edits,
preserving the exact raw model and unrelated metadata, lost responses and
read-only reconciliation. Synthetic test fixtures are not live publication proof.

Fixed private transport probes remain technical fixtures and do not claim full
article quality or tag completion. They cannot be selected as the writer for an
ordinary article or a tag repair.
