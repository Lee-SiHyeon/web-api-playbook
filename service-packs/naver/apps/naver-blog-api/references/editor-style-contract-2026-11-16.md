# SmartEditor ONE presentation fields — observed contract (2026-11-16)

Scope: the paragraph and inline style fields the blog HTTP publisher now
compiles. Everything listed as observed was read out of a captured artifact;
everything not observed is named as unverified at the end instead of filled in.

## 1. Where the observation comes from

| Source | What it establishes |
|---|---|
| `https://editor-static.pstatic.net/e/basic.desktop/1.78.1/se-app-context.js` (fetched 2026-11-16, 2,652,738 bytes), paragraph factory `Gg`, text-node factory `Wg`, node-style reset `resetStyle`, theme table `uV`, quotation layout group, table/cell/image `toPlainJSON` | the field names, their value vocabularies and their native defaults |
| `app-api-playbook`: `apps/naver-blog-ai/app/src/main/java/dev/blogai/companion/core/BridgeCompositionCompiler.java:232-266` and its tests | the same write shape on the device-verified path, including the omission of default `left` |
| `app-api-playbook`: `references/naver-blog-native-presets-e2e-2026-10-26.md` | device readback: “모델의 세 텍스트 문단에도 `paragraphStyle.align=center`가 존재한다”, and headings keep `nodeStyle.bold=true` |
| `references/editor-live-replay-2026-09-20.json`, `references/editor-api-contracts.json` | the draft/post write paths this adapter compiles into |

The bundle factories, quoted verbatim:

```js
Ug = ["lineHeight","align"],
Wg = function(e="", t={}) { return {"@ctype":"textNode",
       style: Bg({"@ctype":"nodeStyle", ai:!0}, pick(t, characterFields)), value:e}; },
Gg = function(e=[Wg()], t={}) { return {"@ctype":"paragraph",
       style: Bg({"@ctype":"paragraphStyle"}, pick(t, Ug)), nodes:e}; },
Vg = function(e=[Gg()]) { return {"@ctype":"text", value:e}; }
```

## 2. Observed fields

| Level | Field | Values (observed) |
|---|---|---|
| paragraph | `style["@ctype"]` | `paragraphStyle` |
| paragraph | `style.align` | `left` · `center` · `right` · `justify` (toolbar `align-group` / `align-drop-down`) |
| paragraph | `style.lineHeight` | number (`1.5`, `1.8` in the default theme) — not exposed by the compiler yet |
| text node | `style["@ctype"]` | `nodeStyle` |
| text node | `bold`, `italic`, `underline`, `strikeThrough` | boolean |
| text node | `fontColor` | `#rrggbb` (`#000`, `#555`, `#666666`, `#222222` observed in the theme and table cells) |
| text node | `fontSizeCode` | `fs11 fs13 fs15 fs16 fs19 fs24 fs28 fs30 fs34 fs38` on text |
| text node | `ai` | boolean, default `false` |
| quotation | `layout` | `default` · `quotation_line` · `quotation_bubble` · `quotation_underline` · `quotation_postit` · `quotation_corner` |
| table | `align`, `width`, `columnCount`, `borderStyleName`, `borderInlineStyle` | `align` from the cell-alignment group |
| table cell | `textAlign` | `left` (default) · `center` · `right` |
| image | `ai` | boolean, default `false` (the generated-image mark) |
| image | `caption` | `paragraph[]` of `textNode[]`, theme default `fs13` · `#555` · centered |

Default theme for ordinary body text: `fontSizeCode:"fs15"`, `lineHeight:1.8`,
`align:"left"`, `fontColor:"#000"`. The compiler writes none of these, so an
authored paragraph with no style keeps the native default instead of freezing
today’s theme value into the document.

## 3. What the compiler now accepts

Document block fields (`scripts/gates/editor-style-contract.mjs`):

- `paragraph` / `heading` / `quote` / caption paragraph: `runs: [{text, bold, italic, underline, strikeThrough, fontColor, fontSizeCode}]`,
  `style: {bold, italic, underline, strikeThrough, fontColor, fontSizeCode}`, `align`.
- `paragraph` / `heading` / `quote`: `paragraphs: [{text, runs?, style?, align?}]` — one
  quotation or text component with several paragraphs (a summary box). `block.text`
  must still hold the whole text; block-level `style`/`align` are the default for
  every paragraph in the box.
- `quote` and `heading` with `presentation:"quotation"`: `layout`.
- `table`: `cellAlign` (every cell), `align` (the table component).
- `image`: `ai` — accepted only when `rights.basis === "generated"`.

Rules that keep every existing gate working:

1. `runs` must reproduce `block.text` after whitespace normalization
   (`INLINE_RUNS_TEXT_MISMATCH`), and `paragraphs` must reproduce it too
   (`BLOCK_PARAGRAPHS_TEXT_MISMATCH`), so `blockTextUnits`, paragraph counts,
   markers, publication review and `documentUnits` are untouched. `documentUnits`
   yields one unit per paragraph, which is what the public readback reports.
2. `align:"left"` is accepted and **not written** — the native default, as on
   the device path.
3. A style is omitted, never written as `null`: the app-side boundary rejects
   `style: null`.
4. Unknown fields, colors that are not `#rrggbb`, and sizes outside the list
   fail closed (`INVALID_INLINE_RUNS`, `INVALID_INLINE_STYLE`,
   `INVALID_PARAGRAPH_ALIGN`, `INVALID_TABLE_ALIGN`,
   `INVALID_QUOTATION_LAYOUT`, `INVALID_BLOCK_PARAGRAPHS`).
5. The disclosure panel keeps its fixed presentation; a style on it fails
   (`NOTICE_PRESENTATION_FIXED`) rather than being silently overwritten.

Verification: `model-lint` adds `presentationApplied`, and `save-draft` /
`reconcile-draft` report `presentationVerified` plus `presentationGaps` from the
actual draft readback. Only the dimensions the author set are compared, so a
theme default cannot be mistaken for a lost style.

## 4. Not verified — do not present as verified

- Whether `/RabbitUpdate.naver` and `/RabbitTempPostUpdate.naver` keep a
  paragraph `align` other than `left`, an image `ai` flag, or a table-cell
  `textAlign` on readback. The device evidence above is a different surface;
  the HTTP draft readback reports what actually came back.
- The `naver-cafe` pack records that its own server discards
  `tableCell.textAlign` (`service-packs/naver-cafe/discovery/media-contracts-lifehackailab-2026-10-13.json`),
  so cell alignment is offered here for the blog pack only, and is reported.
- `lineHeight`, quotation `source`, sticker, divider styles, image groups and
  font family are observed in the bundle but are not exposed by this adapter.
